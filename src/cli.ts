#!/usr/bin/env node

import { Command, Option } from 'commander';

import { Coordinator } from './coordinator.js';
import { errorResult } from './errors.js';
import { checkCommitMessage, checkPreCommit, installHooks } from './hooks.js';
import { initializeProject } from './project.js';
import { setupProject } from './setup.js';
import type { Harness, TaskPriority, TaskStatus } from './types.js';
import { watchEvents } from './watch.js';

interface GlobalOptions {
  agent?: string;
  cwd: string;
  harness: Harness;
  role: string;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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

function openCoordinator(command: Command): Coordinator {
  const options = command.optsWithGlobals<GlobalOptions>();
  return Coordinator.open({
    agent: options.agent ?? process.env.SAMETREE_AGENT ?? '',
    cwd: options.cwd,
    harness: options.harness,
    role: options.role,
  });
}

function runWithCoordinator<T>(command: Command, operation: (coordinator: Coordinator) => T): void {
  const coordinator = openCoordinator(command);
  try {
    print(operation(coordinator));
  } finally {
    coordinator.close();
  }
}

const program = new Command()
  .name('sametree')
  .configureOutput({ writeErr: () => undefined })
  .description('Coordinate coding agents that share a Git working tree.')
  .version('0.1.0')
  .option('--agent <name>', 'unique agent name', process.env.SAMETREE_AGENT)
  .option('--cwd <path>', 'working tree directory', process.env.SAMETREE_CWD ?? process.cwd())
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
  .description('Show agents, work, claims, and unread coordination state.')
  .action((_options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.snapshot());
  });

program
  .command('doctor')
  .description('Check Git, SQLite, policy, and state integrity.')
  .action((_options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.doctor());
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
  .action(
    (
      options: {
        title: string;
        description: string;
        priority: TaskPriority;
        assignee?: string;
        dependsOn: string[];
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
  .action((options: { status?: TaskStatus }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.listTasks(options.status ? { status: options.status } : {}),
    );
  });

task
  .command('claim <task-id>')
  .description('Claim ready work or explicitly take over an expired lease.')
  .action((taskId: string, _options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.claimTask(taskId));
  });

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
  .option('--revision <number>', 'expected current revision', integer)
  .action(
    (
      taskId: string,
      options: {
        status?: TaskStatus;
        priority?: TaskPriority;
        description?: string;
        revision?: number;
      },
      command: Command,
    ) => {
      runWithCoordinator(command, (coordinator) =>
        coordinator.updateTask(taskId, {
          ...(options.status ? { status: options.status } : {}),
          ...(options.priority ? { priority: options.priority } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.revision !== undefined ? { expectedRevision: options.revision } : {}),
        }),
      );
    },
  );

const claim = program.command('claim').description('Coordinate cooperative path leases.');

claim
  .command('acquire <paths...>')
  .option('--tree', 'claim every path recursively')
  .option('--ttl <seconds>', 'lease duration', integer)
  .action((paths: string[], options: { tree?: boolean; ttl?: number }, command: Command) => {
    runWithCoordinator(command, (coordinator) =>
      coordinator.acquireClaims(
        paths.map((claimedPath) => ({
          path: claimedPath,
          ...(options.tree ? { kind: 'tree' as const } : {}),
        })),
        options.ttl,
      ),
    );
  });

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
  .action((handoffId: string, _options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.respondToHandoff(handoffId, true));
  });

handoff
  .command('reject <handoff-id>')
  .action((handoffId: string, _options: unknown, command: Command) => {
    runWithCoordinator(command, (coordinator) => coordinator.respondToHandoff(handoffId, false));
  });

const policy = program.command('policy').description('Read and acknowledge shared instructions.');

policy.command('show').action((_options: unknown, command: Command) => {
  runWithCoordinator(command, (coordinator) => coordinator.getPolicy());
});

policy.command('ack <hash>').action((hash: string, _options: unknown, command: Command) => {
  runWithCoordinator(command, (coordinator) => coordinator.acknowledgePolicy(hash));
});

program
  .command('events')
  .option('--after <sequence>', 'event cursor', integer, 0)
  .option('--limit <number>', 'maximum events', integer, 100)
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
      const coordinator = openCoordinator(command);
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
        if (!process.stdout.destroyed) process.stdout.destroy();
      };
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try {
        await watchEvents(coordinator, {
          after: options.tail ? coordinator.snapshot().lastEventSequence : options.after,
          intervalMs: options.interval,
          json: options.json ?? false,
          once: options.once ?? false,
          signal: controller.signal,
        });
      } finally {
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        coordinator.close();
      }
    },
  );

const hooks = program.command('hooks').description('Install optional Git safety rails.');
hooks.command('install').action((_options: unknown, command: Command) => {
  const globals = command.optsWithGlobals<GlobalOptions>();
  print(installHooks(globals.cwd));
});

const hook = program.command('hook', { hidden: true });
hook.command('pre-commit').action((_options: unknown, command: Command) => {
  const coordinator = openCoordinator(command);
  try {
    print(
      checkPreCommit(coordinator.listClaims(), coordinator.agentName, coordinator.repository.root),
    );
  } finally {
    coordinator.close();
  }
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
