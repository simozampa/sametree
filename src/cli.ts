#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { Command, Option } from 'commander';

import { Coordinator } from './coordinator.js';
import { diagnoseRepository } from './doctor.js';
import { errorResult, SameTreeError } from './errors.js';
import { checkCommitMessage, checkPreCommit, installHooks } from './hooks.js';
import { initializeProject } from './project.js';
import { setupProject } from './setup.js';
import type { Harness, PathClaim, TaskPriority, TaskStatus } from './types.js';
import { VERSION } from './version.js';
import { followMessages, watchEvents } from './watch.js';
import {
  addWorkspaceMember,
  createWorkspace,
  type WorkspaceJoinMode,
  workspaceMembers,
  workspaceStatus,
} from './workspace-service.js';

interface GlobalOptions {
  agent?: string;
  cwd: string;
  harness: Harness;
  role: string;
  workspaceRegistry?: string;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectOptional(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

function qualifiedClaim(value: string): { member: string; path: string } {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) {
    throw new SameTreeError('INVALID_INPUT', "Use --at with '<member>:<path>'.");
  }
  return { member: value.slice(0, separator), path: value.slice(separator + 1) };
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, received '${value}'.`);
  return parsed;
}

function objectJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Context must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function workspaceJoinMode(options: {
  fresh?: boolean;
  importCurrent?: boolean;
}): WorkspaceJoinMode {
  if (options.fresh === options.importCurrent) {
    throw new SameTreeError('INVALID_INPUT', 'Choose exactly one of --fresh or --import-current.');
  }
  return options.importCurrent ? 'import-current' : 'fresh';
}

function claimReceipts(claims: PathClaim[]) {
  return claims.map(({ id, member, path, kind, expiresAt }) => ({
    id,
    member,
    path,
    kind,
    expiresAt,
  }));
}

function openCoordinator(
  command: Command,
  coordinatorOptions: { recordSessionLifecycleEvents?: boolean } = {},
): Coordinator {
  const options = command.optsWithGlobals<GlobalOptions>();
  return Coordinator.open({
    agent: options.agent ?? process.env.SAMETREE_AGENT ?? '',
    cwd: options.cwd,
    harness: options.harness,
    role: options.role,
    ...(options.workspaceRegistry ? { workspaceRegistryRoot: options.workspaceRegistry } : {}),
    ...coordinatorOptions,
  });
}

function runWithCoordinator<T>(command: Command, operation: (coordinator: Coordinator) => T): void {
  const coordinator = openCoordinator(command, { recordSessionLifecycleEvents: false });
  let operationFailed = false;
  let operationError: unknown;
  try {
    print(operation(coordinator));
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeError: unknown;
  try {
    coordinator.close();
  } catch (error) {
    closeError = error;
  }
  if (operationFailed) throw operationError;
  if (closeError !== undefined) throw closeError;
}

async function runStreaming(
  command: Command,
  operation: (coordinator: Coordinator, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const coordinator = openCoordinator(command, { recordSessionLifecycleEvents: false });
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    if (!process.stdout.destroyed) process.stdout.destroy();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let operationFailed = false;
  let operationError: unknown;
  try {
    await operation(coordinator, controller.signal);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  let closeError: unknown;
  try {
    coordinator.close();
  } catch (error) {
    closeError = error;
  }
  if (operationFailed) throw operationError;
  if (closeError !== undefined) throw closeError;
}

function stdinConfirmations(signal: AbortSignal) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  const close = () => lines.close();
  signal.addEventListener('abort', close, { once: true });
  return {
    confirm: async (messageId: string) => {
      const result = await iterator.next();
      return !result.done && result.value === messageId;
    },
    close: () => {
      signal.removeEventListener('abort', close);
      lines.close();
    },
  };
}

const program = new Command()
  .name('sametree')
  .configureOutput({ writeErr: () => undefined })
  .description('Coordinate coding agents that share a Git working tree.')
  .version(VERSION)
  .option('--agent <name>', 'unique agent name', process.env.SAMETREE_AGENT)
  .option('--cwd <path>', 'working tree directory', process.env.SAMETREE_CWD ?? process.cwd())
  .option(
    '--workspace-registry <path>',
    'workspace registry directory',
    process.env.SAMETREE_WORKSPACE_REGISTRY,
  )
  .addOption(
    new Option('--harness <name>', 'agent harness')
      .choices(['claude-code', 'opencode', 'other'])
      .default(process.env.SAMETREE_HARNESS ?? 'other'),
  )
  .option('--role <name>', 'agent role', process.env.SAMETREE_ROLE ?? 'implementer');

program
  .command('init')
  .description('Create versioned SameTree policy and role files.')
  .option('--force', 'replace existing SameTree files')
  .option('--hooks', 'also install Git safety hooks')
  .action((options: { force?: boolean; hooks?: boolean }, command: Command) => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    const initialization = initializeProject(globals.cwd, { force: options.force ?? false });
    print({
      initialization,
      ...(options.hooks ? { hooks: installHooks(globals.cwd) } : {}),
    });
  });

program
  .command('setup')
  .description('Initialize SameTree and configure project-local harness integrations.')
  .option('--claude', 'configure Claude Code MCP and CLAUDE.md')
  .option('--opencode', 'configure OpenCode MCP and AGENTS.md')
  .action((options: { claude?: boolean; opencode?: boolean }, command: Command) => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    print(
      setupProject(globals.cwd, {
        claude: options.claude ?? false,
        opencode: options.opencode ?? false,
      }),
    );
  });

program
  .command('status')
  .description('Show live Git state, active agents, current work, claims, and unread state.')
  .option('--all-agents', 'include inactive registered agents')
  .option('--all-tasks', 'include done and cancelled tasks')
  .action((options: { allAgents?: boolean; allTasks?: boolean }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.snapshot({
        includeInactiveAgents: options.allAgents ?? false,
        includeTerminalTasks: options.allTasks ?? false,
      }),
    );
  });

program
  .command('doctor')
  .description('Check Git, SQLite, policy, and state integrity.')
  .action((_options: unknown, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions>();
    print(diagnoseRepository(options.cwd));
  });

const workspace = program.command('workspace').description('Manage multi-repository workspaces.');

workspace
  .command('create <name>')
  .description('Create a workspace and join this worktree.')
  .requiredOption('--member <name>', 'workspace member name')
  .option('--fresh', 'start with empty workspace coordination state')
  .option('--import-current', 'import current standalone coordination state')
  .action(
    (
      name: string,
      options: { fresh?: boolean; importCurrent?: boolean; member: string },
      command: Command,
    ) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      print(
        createWorkspace(
          globals.cwd,
          { name, memberName: options.member, mode: workspaceJoinMode(options) },
          {
            ...(globals.workspaceRegistry ? { registryRoot: globals.workspaceRegistry } : {}),
          },
        ),
      );
    },
  );

workspace
  .command('add <workspace-id>')
  .description('Add this worktree to an existing local workspace.')
  .requiredOption('--member <name>', 'workspace member name')
  .option('--fresh', 'leave standalone state as a recoverable backup')
  .option('--import-current', 'import current standalone coordination state')
  .action(
    (
      workspaceId: string,
      options: { fresh?: boolean; importCurrent?: boolean; member: string },
      command: Command,
    ) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      print(
        addWorkspaceMember(
          globals.cwd,
          {
            workspaceId,
            memberName: options.member,
            mode: workspaceJoinMode(options),
          },
          {
            ...(globals.workspaceRegistry ? { registryRoot: globals.workspaceRegistry } : {}),
          },
        ),
      );
    },
  );

workspace.command('status').action((_options: unknown, command: Command) => {
  const globals = command.optsWithGlobals<GlobalOptions>();
  print(
    workspaceStatus(globals.cwd, {
      ...(globals.workspaceRegistry ? { registryRoot: globals.workspaceRegistry } : {}),
    }),
  );
});

workspace.command('members').action((_options: unknown, command: Command) => {
  const globals = command.optsWithGlobals<GlobalOptions>();
  print(
    workspaceMembers(globals.cwd, {
      ...(globals.workspaceRegistry ? { registryRoot: globals.workspaceRegistry } : {}),
    }),
  );
});

const task = program.command('task').description('Create and coordinate durable tasks.');

task
  .command('create')
  .requiredOption('--title <text>', 'short task title')
  .option('--description <text>', 'implementation context', '')
  .addOption(
    new Option('--priority <level>').choices(['low', 'normal', 'high', 'urgent']).default('normal'),
  )
  .option('--assignee <agent>', 'initial assignee')
  .option('--depends-on <task-id>', 'dependency task ID', collect, [])
  .option('--member <name>', 'affected workspace member', collectOptional)
  .action(
    (
      options: {
        title: string;
        description: string;
        priority: TaskPriority;
        assignee?: string;
        dependsOn: string[];
        member?: string[];
      },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.createTask({
          title: options.title,
          description: options.description,
          priority: options.priority,
          ...(options.assignee ? { assignee: options.assignee } : {}),
          dependencies: options.dependsOn,
          members: options.member ?? [],
        }),
      );
    },
  );

task
  .command('list')
  .addOption(
    new Option('--status <status>').choices([
      'ready',
      'in_progress',
      'blocked',
      'done',
      'cancelled',
    ]),
  )
  .option('--all', 'include done and cancelled tasks')
  .option('--member <name>', 'filter by affected workspace member')
  .option('--after <task-id>', 'continue after this task cursor')
  .option('--limit <number>', 'maximum tasks', integer, 25)
  .action(
    (
      options: {
        after?: string;
        all?: boolean;
        limit: number;
        member?: string;
        status?: TaskStatus;
      },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.listTasks({
          ...(options.status ? { status: options.status } : {}),
          ...(options.after ? { after: options.after } : {}),
          ...(options.member ? { member: options.member } : {}),
          includeTerminal: options.all ?? false,
          limit: options.limit,
        }),
      );
    },
  );

task
  .command('claim <task-id>')
  .description('Start or renew assigned work; never take over a peer task implicitly.')
  .option('--revision <number>', 'expected revision for a legacy unassigned task', integer)
  .option('--reason <text>', 'audit reason for adopting a legacy unassigned task')
  .option('--user-authorized', 'confirm that the user explicitly added this task to your scope')
  .action(
    (
      taskId: string,
      options: { reason?: string; revision?: number; userAuthorized?: true },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.claimTask(taskId, {
          ...(options.revision !== undefined ? { expectedRevision: options.revision } : {}),
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
          ...(options.userAuthorized !== undefined
            ? { userAuthorized: options.userAuthorized }
            : {}),
        }),
      );
    },
  );

task
  .command('force-takeover <task-id>')
  .description('Reassign another agent’s work after the user explicitly authorizes it.')
  .requiredOption('--revision <number>', 'expected current task revision', integer)
  .requiredOption('--reason <text>', 'audit reason for bypassing the active lease')
  .requiredOption('--user-authorized', 'confirm that the user explicitly authorized this takeover')
  .option('--claim <claim-id>', 'active claim to transfer from the current owner', collect, [])
  .action(
    (
      taskId: string,
      options: { claim: string[]; reason: string; revision: number; userAuthorized: true },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.forceTakeoverTask(taskId, {
          claimIds: options.claim,
          expectedRevision: options.revision,
          reason: options.reason,
          userAuthorized: options.userAuthorized,
        }),
      );
    },
  );

task
  .command('update <task-id>')
  .addOption(
    new Option('--status <status>').choices([
      'ready',
      'in_progress',
      'blocked',
      'done',
      'cancelled',
    ]),
  )
  .addOption(new Option('--priority <level>').choices(['low', 'normal', 'high', 'urgent']))
  .option('--description <text>')
  .option('--member <name>', 'replace affected workspace members', collectOptional)
  .option('--clear-members', 'remove every affected workspace member')
  .option('--revision <number>', 'expected current revision', integer)
  .action(
    (
      taskId: string,
      options: {
        status?: TaskStatus;
        priority?: TaskPriority;
        description?: string;
        revision?: number;
        member?: string[];
        clearMembers?: boolean;
      },
      command: Command,
    ) => {
      if (options.clearMembers && options.member !== undefined) {
        throw new SameTreeError('INVALID_INPUT', 'Use --member or --clear-members, not both.');
      }
      runWithCoordinator(command, (coordinator) =>
        coordinator.updateTask(taskId, {
          ...(options.status ? { status: options.status } : {}),
          ...(options.priority ? { priority: options.priority } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.revision !== undefined ? { expectedRevision: options.revision } : {}),
          ...(options.clearMembers
            ? { members: [] }
            : options.member !== undefined
              ? { members: options.member }
              : {}),
        }),
      );
    },
  );

const claim = program.command('claim').description('Coordinate cooperative path leases.');

claim
  .command('acquire [paths...]')
  .option('--tree', 'claim every path recursively')
  .option('--member <name>', 'target workspace member')
  .option('--at <member:path>', 'claim a member-qualified path', collect, [])
  .option('--ttl <seconds>', 'lease duration', integer)
  .action(
    (
      paths: string[],
      options: { at: string[]; member?: string; tree?: boolean; ttl?: number },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        claimReceipts(
          coordinator.acquireClaims(
            [
              ...paths.map((claimedPath) => ({
                path: claimedPath,
                ...(options.tree ? { kind: 'tree' as const } : {}),
                ...(options.member !== undefined ? { member: options.member } : {}),
              })),
              ...options.at.map((value) => ({
                ...qualifiedClaim(value),
                ...(options.tree ? { kind: 'tree' as const } : {}),
              })),
            ],
            options.ttl,
          ),
        ),
      );
    },
  );

claim
  .command('list')
  .option('--all', 'include expired claims')
  .action((options: { all?: boolean }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.listClaims({ includeExpired: options.all ?? false }),
    );
  });

claim
  .command('release [claim-ids...]')
  .option('--all', 'release every claim owned by this agent')
  .action((claimIds: string[], options: { all?: boolean }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.releaseClaims({ ids: claimIds, all: options.all ?? false }),
    );
  });

const message = program.command('message').description('Exchange durable agent messages.');

message
  .command('send')
  .requiredOption('--subject <text>')
  .requiredOption('--body <text>')
  .option('--to <agent>', 'recipient; omit to broadcast')
  .option('--thread <id>', 'existing thread ID')
  .option('--task <id>', 'related task ID')
  .action(
    (
      options: { subject: string; body: string; to?: string; thread?: string; task?: string },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.sendMessage({
          subject: options.subject,
          body: options.body,
          ...(options.to ? { to: options.to } : {}),
          ...(options.thread ? { threadId: options.thread } : {}),
          ...(options.task ? { taskId: options.task } : {}),
        }),
      );
    },
  );

message
  .command('inbox')
  .option('--unread', 'return unread messages only')
  .option('--limit <number>', 'maximum messages', integer, 50)
  .action((options: { unread?: boolean; limit: number }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.inbox({ unreadOnly: options.unread ?? false, limit: options.limit }),
    );
  });

message
  .command('ack <message-id>')
  .action((messageId: string, _options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.acknowledgeMessage(messageId));
  });

message
  .command('follow')
  .description('Follow unread messages addressed to this agent.')
  .option('--interval <milliseconds>', 'poll interval', integer, 1_000)
  .option('--json', 'emit one JSON message per line')
  .option('--once', 'deliver available messages and exit')
  .option('--ack-stdin', 'wait for each message ID on stdin before recording delivery')
  .option('--prefix <text>', 'prefix each emitted message')
  .action(
    async (
      options: {
        interval: number;
        json?: boolean;
        once?: boolean;
        ackStdin?: boolean;
        prefix?: string;
      },
      command: Command,
    ) => {
      if (options.interval < 100 || options.interval > 60_000) {
        throw new Error('Message follow interval must be between 100 and 60000 milliseconds.');
      }
      await runStreaming(command, async (coordinator, signal) => {
        const confirmations = options.ackStdin ? stdinConfirmations(signal) : undefined;
        try {
          return await followMessages(coordinator, {
            intervalMs: options.interval,
            json: options.json ?? false,
            once: options.once ?? false,
            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
            signal,
            ...(confirmations ? { confirm: (message) => confirmations.confirm(message.id) } : {}),
          });
        } finally {
          confirmations?.close();
        }
      });
    },
  );

const handoff = program.command('handoff').description('Transfer work with structured context.');

handoff
  .command('offer <task-id>')
  .requiredOption('--to <agent>')
  .requiredOption('--summary <text>')
  .option('--context <json>', 'structured context object', objectJson, {})
  .option('--claim <claim-id>', 'claim to transfer on acceptance', collect, [])
  .action(
    (
      taskId: string,
      options: {
        to: string;
        summary: string;
        context: Record<string, unknown>;
        claim: string[];
      },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.offerHandoff({
          taskId,
          to: options.to,
          summary: options.summary,
          context: options.context,
          claimIds: options.claim,
        }),
      );
    },
  );

handoff
  .command('list')
  .option('--pending', 'only active offers addressed to this agent')
  .action((options: { pending?: boolean }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.listHandoffs({ pendingOnly: options.pending ?? false }),
    );
  });

handoff
  .command('accept <handoff-id>')
  .requiredOption('--reason <text>', 'audit reason for the user-authorized scope transfer')
  .requiredOption('--user-authorized', 'confirm that the user explicitly authorized this handoff')
  .action(
    (handoffId: string, options: { reason: string; userAuthorized: true }, command: Command) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.respondToHandoff(handoffId, true, {
          reason: options.reason,
          userAuthorized: options.userAuthorized,
        }),
      );
    },
  );

handoff
  .command('reject <handoff-id>')
  .action((handoffId: string, _options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.respondToHandoff(handoffId, false));
  });

const policy = program.command('policy').description('Read and acknowledge shared instructions.');

policy
  .command('show')
  .option('--member <name>', 'target workspace member')
  .action((options: { member?: string }, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.getPolicy(options.member));
  });

policy
  .command('ack <hash>')
  .option('--member <name>', 'target workspace member')
  .action((hash: string, options: { member?: string }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.acknowledgePolicy(hash, options.member),
    );
  });

program
  .command('events')
  .option('--after <sequence>', 'event cursor', integer, 0)
  .option('--limit <number>', 'maximum events', integer, 25)
  .action((options: { after: number; limit: number }, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.events(options));
  });

program
  .command('watch')
  .description('Follow the coordination event stream.')
  .addOption(new Option('--after <sequence>', 'event cursor').argParser(integer).default(0))
  .option('--interval <milliseconds>', 'poll interval', integer, 1_000)
  .option('--json', 'emit one JSON event per line')
  .option('--once', 'print available events and exit')
  .option('--tail', 'start after the current event instead of replaying history')
  .action(
    async (
      options: {
        after: number;
        interval: number;
        json?: boolean;
        once?: boolean;
        tail?: boolean;
      },
      command: Command,
    ) => {
      if (options.tail && command.getOptionValueSource('after') === 'cli') {
        throw new Error("Watch options '--after' and '--tail' cannot be used together.");
      }
      if (options.interval < 100 || options.interval > 60_000) {
        throw new Error('Watch interval must be between 100 and 60000 milliseconds.');
      }
      await runStreaming(command, (coordinator, signal) =>
        watchEvents(coordinator, {
          after: options.tail ? coordinator.snapshot().lastEventSequence : options.after,
          intervalMs: options.interval,
          json: options.json ?? false,
          once: options.once ?? false,
          signal,
        }),
      );
    },
  );

const hooks = program.command('hooks').description('Install optional Git safety rails.');
hooks.command('install').action((_options: unknown, command: Command) => {
  const globals = command.optsWithGlobals<GlobalOptions>();
  print(installHooks(globals.cwd));
});

const hook = program.command('hook', { hidden: true });
hook.command('pre-commit').action((_options: unknown, command: Command) => {
  runWithCoordinator(command, (coordinator) =>
    checkPreCommit(coordinator.listClaims(), coordinator.agentName, coordinator.repository.root),
  );
});
hook
  .command('commit-msg <message-path>')
  .action((messagePath: string, _options: unknown, command: Command) => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    print(checkCommitMessage(messagePath, globals.cwd));
  });

program.exitOverride();

try {
  await program.parseAsync();
} catch (error) {
  // Commander uses exceptions for --help and --version when exitOverride is enabled.
  if (error instanceof Error && error.name === 'CommanderError') {
    const code = Reflect.get(error, 'code');
    if (code === 'commander.helpDisplayed' || code === 'commander.version') process.exit(0);
  }
  process.stderr.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
  process.exitCode = 1;
}
