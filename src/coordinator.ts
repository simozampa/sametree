import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Database as DatabaseType } from 'better-sqlite3';

import { loadConfig, POLICY_FILE, type SameTreeConfig } from './config.js';
import { databaseWorktreeId, immediateTransaction, openDatabase } from './database.js';
import { inspectDatabase } from './doctor.js';
import { SameTreeError } from './errors.js';
import {
  type RepositoryContext,
  readGitHeadContext,
  readGitWorktreeContext,
  resolveRepository,
} from './git.js';
import { claimsOverlap, normalizeClaim } from './paths.js';
import type {
  Agent,
  ClaimKind,
  CoordinationEvent,
  CoordinationMember,
  CoordinationSnapshot,
  CoordinationWarning,
  CoordinationWorkspace,
  DoctorReport,
  Handoff,
  Harness,
  Message,
  PathClaim,
  PolicyAcknowledgement,
  PolicyDocument,
  Session,
  Task,
  TaskPriority,
  TaskStatus,
} from './types.js';
import {
  acquireWorkspaceOperationLock,
  resolveWorkspaceBinding,
  type WorkspaceContext,
} from './workspace.js';
import { assertWorkspaceBindingReady } from './workspace-service.js';

type Row = Record<string, unknown>;
const MAX_HANDOFF_CONTEXT_BYTES = 100_000;

export interface CoordinatorOptions {
  agent: string;
  cwd?: string;
  harness?: Harness;
  role?: string;
  databasePath?: string;
  workspaceRegistryRoot?: string;
  clock?: () => number;
  recordSessionLifecycleEvents?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: string;
  dependencies?: string[];
  members?: string[];
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  description?: string;
  priority?: TaskPriority;
  expectedRevision?: number;
  members?: string[];
}

export interface ForceTakeoverTaskInput {
  claimIds?: string[];
  expectedRevision: number;
  reason: string;
  userAuthorized: boolean;
}

export interface UserAuthorizedTaskInput {
  expectedRevision?: number;
  reason?: string;
  userAuthorized?: boolean;
}

export interface UserAuthorizedHandoffInput {
  reason?: string;
  userAuthorized?: boolean;
}

export interface ListTasksOptions {
  after?: string;
  includeTerminal?: boolean;
  limit?: number;
  member?: string;
  status?: TaskStatus;
}

export interface SnapshotOptions {
  includeInactiveAgents?: boolean;
  includeTerminalTasks?: boolean;
}

export interface AcquireClaimInput {
  path: string;
  kind?: ClaimKind;
  member?: string;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function requireText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

function validateAgentName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(name)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Agent names must start with a letter or number and use only letters, numbers, ., _, or -.',
      { agent: name },
    );
  }
  return name;
}

function numberValue(row: Row, key: string): number {
  return Number(row[key]);
}

function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : Number(row[key]);
}

function stringValue(row: Row, key: string): string {
  return String(row[key]);
}

function nullableString(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function mapAgent(row: Row, activeMembers: string[] = []): Agent {
  return {
    name: stringValue(row, 'name'),
    harness: stringValue(row, 'harness') as Harness,
    role: stringValue(row, 'role'),
    activeMembers,
    createdAt: numberValue(row, 'created_at'),
    lastSeenAt: numberValue(row, 'last_seen_at'),
  };
}

function mapSession(row: Row): Session {
  return {
    id: stringValue(row, 'id'),
    agentName: stringValue(row, 'agent_name'),
    homeWorktreeId: stringValue(row, 'home_worktree_id'),
    homeMember: stringValue(row, 'worktree_name'),
    startedHeadDescriptor: stringValue(row, 'started_head_descriptor'),
    startedBranch: nullableString(row, 'started_branch'),
    currentBranch: nullableString(row, 'current_branch'),
    branchChanged: nullableString(row, 'started_branch') !== nullableString(row, 'current_branch'),
    processId: numberValue(row, 'process_id'),
    startedAt: numberValue(row, 'started_at'),
    lastHeartbeatAt: numberValue(row, 'last_heartbeat_at'),
    expiresAt: numberValue(row, 'expires_at'),
    status: stringValue(row, 'status') as Session['status'],
  };
}

function mapTask(row: Row, dependencies: string[], members: string[]): Task {
  return {
    id: stringValue(row, 'id'),
    title: stringValue(row, 'title'),
    description: stringValue(row, 'description'),
    status: stringValue(row, 'status') as TaskStatus,
    priority: stringValue(row, 'priority') as TaskPriority,
    assignee: nullableString(row, 'assignee'),
    leaseExpiresAt: nullableNumber(row, 'lease_expires_at'),
    revision: numberValue(row, 'revision'),
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at'),
    dependencies,
    members,
  };
}

function mapClaim(row: Row, warnings: CoordinationWarning[] = []): PathClaim {
  return {
    id: stringValue(row, 'id'),
    worktreeId: stringValue(row, 'worktree_id'),
    member: stringValue(row, 'worktree_name'),
    path: stringValue(row, 'path'),
    comparisonPath: stringValue(row, 'comparison_path'),
    kind: stringValue(row, 'kind') as ClaimKind,
    agentName: stringValue(row, 'agent_name'),
    expiresAt: numberValue(row, 'expires_at'),
    createdAt: numberValue(row, 'created_at'),
    warnings,
  };
}

function mapMessage(row: Row): Message {
  return {
    id: stringValue(row, 'id'),
    sender: stringValue(row, 'sender'),
    recipient: nullableString(row, 'recipient'),
    subject: stringValue(row, 'subject'),
    body: stringValue(row, 'body'),
    threadId: stringValue(row, 'thread_id'),
    taskId: nullableString(row, 'task_id'),
    createdAt: numberValue(row, 'created_at'),
    readAt: nullableNumber(row, 'read_at'),
  };
}

function mapHandoff(row: Row, now: number): Handoff {
  const storedStatus = stringValue(row, 'status') as Handoff['status'];
  return {
    id: stringValue(row, 'id'),
    taskId: stringValue(row, 'task_id'),
    fromAgent: stringValue(row, 'from_agent'),
    toAgent: stringValue(row, 'to_agent'),
    summary: stringValue(row, 'summary'),
    context: parseObject(row.context_json),
    status:
      storedStatus === 'offered' && numberValue(row, 'expires_at') <= now
        ? 'expired'
        : storedStatus,
    createdAt: numberValue(row, 'created_at'),
    expiresAt: numberValue(row, 'expires_at'),
    respondedAt: nullableNumber(row, 'responded_at'),
  };
}

/** Shared domain API used by both the CLI and MCP adapters. */
export class Coordinator {
  readonly repository: RepositoryContext;
  readonly config: SameTreeConfig;
  readonly agentName: string;
  readonly sessionId: string;
  readonly workspace: WorkspaceContext | null;
  readonly worktreeId: string;

  readonly #database: DatabaseType;
  readonly #clock: () => number;
  readonly #recordSessionLifecycleEvents: boolean;
  #closed = false;

  private constructor(options: CoordinatorOptions) {
    this.repository = resolveRepository(options.cwd);
    this.config = loadConfig(this.repository.root);
    this.agentName = validateAgentName(options.agent);
    this.#clock = options.clock ?? Date.now;
    this.#recordSessionLifecycleEvents = options.recordSessionLifecycleEvents ?? true;
    const releaseWorkspaceLock = acquireWorkspaceOperationLock(this.repository, 2_500);
    try {
      this.workspace = resolveWorkspaceBinding(this.repository, {
        ...(options.workspaceRegistryRoot ? { registryRoot: options.workspaceRegistryRoot } : {}),
      });
      if (this.workspace) {
        assertWorkspaceBindingReady(this.repository, this.workspace);
        if (
          options.databasePath !== undefined &&
          options.databasePath !== this.workspace.workspace.databasePath
        ) {
          throw new SameTreeError(
            'WORKSPACE_ERROR',
            'A bound worktree cannot override its workspace database path.',
          );
        }
      }
      this.#database = openDatabase(this.repository, {
        ...(options.databasePath
          ? { databasePath: options.databasePath }
          : this.workspace
            ? { databasePath: this.workspace.workspace.databasePath }
            : {}),
        ...(this.workspace
          ? {
              member: {
                workspaceId: this.workspace.workspace.id,
                workspaceName: this.workspace.workspace.name,
                workspaceImplicit: false,
                repositoryId: this.workspace.repositoryId,
                repositoryName: this.workspace.repositoryName,
                worktreeId: this.workspace.worktreeId,
                worktreeName: this.workspace.worktreeName,
              },
            }
          : {}),
        now: this.#clock(),
      });
      this.worktreeId = databaseWorktreeId(this.#database, this.repository);
      this.sessionId = createId('session');

      const now = this.#clock();
      try {
        immediateTransaction(this.#database, () => {
          this.#database
            .prepare(
              `INSERT INTO agents (name, harness, role, created_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
                 harness = excluded.harness,
                 role = excluded.role,
                 last_seen_at = excluded.last_seen_at`,
            )
            .run(
              this.agentName,
              options.harness ?? 'other',
              options.role ?? 'implementer',
              now,
              now,
            );
          this.#database
            .prepare(
              `INSERT INTO sessions
                (id, agent_name, home_worktree_id, started_head_descriptor, started_branch,
                 process_id, started_at, last_heartbeat_at, expires_at, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            )
            .run(
              this.sessionId,
              this.agentName,
              this.worktreeId,
              this.repository.head.descriptor,
              this.repository.head.branch,
              process.pid,
              now,
              now,
              now + this.config.sessionTtlSeconds * 1_000,
            );
          this.#refreshWorktreeHead(now);
          if (this.#recordSessionLifecycleEvents) {
            this.#recordEvent('session.started', 'session', this.sessionId, {
              harness: options.harness ?? 'other',
              role: options.role ?? 'implementer',
            });
          }
        });
      } catch (error) {
        this.#database.close();
        this.#closed = true;
        throw error;
      }
    } finally {
      releaseWorkspaceLock();
    }
  }

  static open(options: CoordinatorOptions): Coordinator {
    if (!options.agent) {
      throw new SameTreeError(
        'AGENT_REQUIRED',
        'Provide a unique agent name with --agent or SAMETREE_AGENT.',
      );
    }
    return new Coordinator(options);
  }

  #recordEvent(
    kind: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown> = {},
    worktreeId = this.worktreeId,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO events
          (id, kind, actor, entity_type, entity_id, payload_json, created_at, worktree_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId('event'),
        kind,
        this.agentName,
        entityType,
        entityId,
        JSON.stringify(payload),
        this.#clock(),
        worktreeId,
      );
  }

  #refreshWorktreeHead(
    now = this.#clock(),
    worktreeId = this.worktreeId,
    privateGitDirectory = this.repository.privateGitDirectory,
  ): void {
    const head = readGitHeadContext(privateGitDirectory);
    const stored = this.#database
      .prepare('SELECT name, head_descriptor, branch FROM worktrees WHERE id = ?')
      .get(worktreeId) as Row;
    const previousDescriptor = stringValue(stored, 'head_descriptor');
    const previousBranch = nullableString(stored, 'branch');
    if (previousDescriptor === head.descriptor && previousBranch === head.branch) return;

    this.#database
      .prepare(
        `UPDATE worktrees SET head_descriptor = ?, branch = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(head.descriptor, head.branch, now, worktreeId);
    if (previousBranch !== head.branch) {
      this.#recordEvent(
        'worktree.branch_changed',
        'worktree',
        worktreeId,
        {
          member: stringValue(stored, 'name'),
          previousBranch,
          branch: head.branch,
          previousHeadDescriptor: previousDescriptor,
          headDescriptor: head.descriptor,
        },
        worktreeId,
      );
    }
  }

  #refreshWorkspaceHeads(now = this.#clock()): void {
    const worktrees = this.#database
      .prepare(
        `SELECT id, private_git_directory FROM worktrees
         WHERE available = 1 ORDER BY id`,
      )
      .all() as Row[];
    for (const worktree of worktrees) {
      try {
        this.#refreshWorktreeHead(
          now,
          stringValue(worktree, 'id'),
          stringValue(worktree, 'private_git_directory'),
        );
      } catch (error) {
        if (!(error instanceof SameTreeError) || error.code !== 'GIT_STATUS_ERROR') throw error;
      }
    }
  }

  #requireAgent(name: string): void {
    const found = this.#database.prepare('SELECT 1 FROM agents WHERE name = ?').get(name);
    if (!found) throw new SameTreeError('NOT_FOUND', `Agent '${name}' is not registered.`);
  }

  #claimWorktree(member?: string): {
    id: string;
    ignoreCase: boolean;
    name: string;
    repositoryId: string;
    root: string;
  } {
    const requestedMember = member === undefined ? undefined : requireText(member, 'Member', 100);
    const row = requestedMember
      ? (this.#database
          .prepare(
            `SELECT worktree.id, worktree.name, worktree.root, worktree.available,
                    worktree.private_git_directory, worktree.repository_id
             FROM worktrees worktree
             WHERE worktree.name = ?`,
          )
          .get(requestedMember) as Row | undefined)
      : (this.#database
          .prepare(
            `SELECT worktree.id, worktree.name, worktree.root, worktree.available,
                    worktree.private_git_directory, worktree.repository_id
             FROM worktrees worktree
             WHERE worktree.id = ?`,
          )
          .get(this.worktreeId) as Row | undefined);
    if (!row) {
      throw new SameTreeError(
        'NOT_FOUND',
        `Workspace member '${requestedMember ?? this.worktreeId}' was not found.`,
      );
    }
    if (numberValue(row, 'available') !== 1) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        `Workspace member '${stringValue(row, 'name')}' is unavailable.`,
      );
    }
    const id = stringValue(row, 'id');
    const root = stringValue(row, 'root');
    const targetRepository = resolveRepository(root);
    if (targetRepository.privateGitDirectory !== stringValue(row, 'private_git_directory')) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        `Workspace member '${stringValue(row, 'name')}' moved and must be relinked.`,
      );
    }
    return {
      id,
      name: stringValue(row, 'name'),
      repositoryId: stringValue(row, 'repository_id'),
      root,
      ignoreCase: targetRepository.ignoreCase,
    };
  }

  #linkedClaimWarnings(
    claim: {
      comparisonPath: string;
      kind: ClaimKind;
      member: string;
      repositoryId: string;
      worktreeId: string;
    },
    active: Row[],
  ): CoordinationWarning[] {
    return active
      .filter(
        (row) =>
          stringValue(row, 'repository_id') === claim.repositoryId &&
          stringValue(row, 'worktree_id') !== claim.worktreeId &&
          claimsOverlap(claim, {
            comparisonPath: stringValue(row, 'comparison_path'),
            kind: stringValue(row, 'kind') as ClaimKind,
          }),
      )
      .map((row) => ({
        code: 'LINKED_WORKTREE_OVERLAP' as const,
        message: `${claim.member}:${claim.comparisonPath} may conflict when integrated with ${stringValue(row, 'worktree_name')}:${stringValue(row, 'path')}.`,
        member: claim.member,
        worktreeId: claim.worktreeId,
        conflictingClaimId: stringValue(row, 'id'),
        conflictingMember: stringValue(row, 'worktree_name'),
      }));
  }

  #dependencies(taskId: string): string[] {
    return (
      this.#database
        .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on')
        .all(taskId) as Row[]
    ).map((row) => stringValue(row, 'depends_on'));
  }

  #taskMembers(taskId: string): string[] {
    return (
      this.#database
        .prepare(
          `SELECT worktree.name
           FROM task_worktrees task_worktree
           JOIN worktrees worktree ON worktree.id = task_worktree.worktree_id
           WHERE task_worktree.task_id = ?
           ORDER BY worktree.name`,
        )
        .all(taskId) as Row[]
    ).map((row) => stringValue(row, 'name'));
  }

  #resolveTaskMembers(
    members: string[],
    options: { requireAvailable?: boolean } = {},
  ): Array<{ id: string; name: string }> {
    const names = [...new Set(members.map((member) => requireText(member, 'Member', 100)))];
    if (names.length > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Associate at most 100 members with a task.');
    }
    return names.map((name) => {
      const row = this.#database
        .prepare('SELECT id, available FROM worktrees WHERE name = ?')
        .get(name) as Row | undefined;
      if (!row) throw new SameTreeError('NOT_FOUND', `Workspace member '${name}' was not found.`);
      if ((options.requireAvailable ?? true) && numberValue(row, 'available') !== 1) {
        throw new SameTreeError('WORKSPACE_ERROR', `Workspace member '${name}' is unavailable.`);
      }
      return { id: stringValue(row, 'id'), name };
    });
  }

  #activeMembers(agentName: string, now: number): string[] {
    return (
      this.#database
        .prepare(
          `SELECT DISTINCT worktree.name
           FROM sessions session
           JOIN worktrees worktree ON worktree.id = session.home_worktree_id
           WHERE session.agent_name = ? AND session.status = 'active' AND session.expires_at > ?
           ORDER BY worktree.name`,
        )
        .all(agentName, now) as Row[]
    ).map((row) => stringValue(row, 'name'));
  }

  #workspaceStatus(): { members: CoordinationMember[]; workspace: CoordinationWorkspace } {
    const metadata = this.#database.prepare('SELECT * FROM workspace_metadata').get() as Row;
    const members = (
      this.#database
        .prepare(
          `SELECT worktree.*, repository.name AS repository_name
           FROM worktrees worktree
           JOIN repositories repository ON repository.id = worktree.repository_id
           ORDER BY worktree.name, worktree.id`,
        )
        .all() as Row[]
    ).map((row) => ({
      id: stringValue(row, 'id'),
      name: stringValue(row, 'name'),
      repositoryId: stringValue(row, 'repository_id'),
      repositoryName: stringValue(row, 'repository_name'),
      root: stringValue(row, 'root'),
      available: numberValue(row, 'available') === 1,
    }));
    const current = members.find((member) => member.id === this.worktreeId);
    if (!current)
      throw new SameTreeError('WORKSPACE_ERROR', 'Current workspace member is missing.');
    return {
      workspace: {
        id: stringValue(metadata, 'id'),
        name: stringValue(metadata, 'name'),
        implicit: numberValue(metadata, 'implicit') === 1,
        currentMemberId: current.id,
        currentMember: current.name,
      },
      members,
    };
  }

  #task(taskId: string): Task {
    const row = this.#database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | Row
      | undefined;
    if (!row) throw new SameTreeError('NOT_FOUND', `Task '${taskId}' does not exist.`);
    return mapTask(row, this.#dependencies(taskId), this.#taskMembers(taskId));
  }

  #unfinishedDependencies(taskId: string): string[] {
    return (
      this.#database
        .prepare(
          `SELECT dependency.id
           FROM task_dependencies edge
           JOIN tasks dependency ON dependency.id = edge.depends_on
           WHERE edge.task_id = ? AND dependency.status <> 'done'`,
        )
        .all(taskId) as Row[]
    ).map((row) => stringValue(row, 'id'));
  }

  #transferClaims(
    claimIds: string[],
    fromAgent: string,
    now: number,
    conflictCode: 'HANDOFF_CONFLICT' | 'TASK_UNAVAILABLE' = 'HANDOFF_CONFLICT',
  ): PathClaim[] {
    const selectedIds = [...new Set(claimIds)];
    if (selectedIds.length > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Transfer at most 100 claims at once.');
    }
    const selectedClaims = selectedIds.map((claimId) => {
      const claim = this.#database
        .prepare(
          `SELECT claim.*, worktree.name AS worktree_name
           FROM path_claims claim
           JOIN worktrees worktree ON worktree.id = claim.worktree_id
           WHERE claim.id = ? AND claim.agent_name = ? AND claim.expires_at > ?`,
        )
        .get(claimId, fromAgent, now) as Row | undefined;
      if (!claim) {
        throw new SameTreeError(
          conflictCode,
          `Claim '${claimId}' is no longer transferable from ${fromAgent}.`,
        );
      }
      return claim;
    });
    const sourceClaims = this.#database
      .prepare(
        `SELECT claim.*, worktree.name AS worktree_name
         FROM path_claims claim
         JOIN worktrees worktree ON worktree.id = claim.worktree_id
         WHERE claim.agent_name = ? AND claim.expires_at > ?`,
      )
      .all(fromAgent, now) as Row[];
    for (const selected of selectedClaims) {
      const overlap = sourceClaims.find(
        (candidate) =>
          !selectedIds.includes(stringValue(candidate, 'id')) &&
          stringValue(candidate, 'worktree_id') === stringValue(selected, 'worktree_id') &&
          claimsOverlap(
            {
              comparisonPath: stringValue(selected, 'comparison_path'),
              kind: stringValue(selected, 'kind') as ClaimKind,
            },
            {
              comparisonPath: stringValue(candidate, 'comparison_path'),
              kind: stringValue(candidate, 'kind') as ClaimKind,
            },
          ),
      );
      if (overlap) {
        throw new SameTreeError(
          conflictCode,
          `Claim '${stringValue(selected, 'id')}' overlaps an unselected source claim.`,
          { overlappingClaim: mapClaim(overlap) },
        );
      }
    }

    const expiresAt = now + this.config.claimTtlSeconds * 1_000;
    const transfer = this.#database.prepare(
      `UPDATE path_claims SET agent_name = ?, session_id = ?, expires_at = ?
       WHERE id = ? AND agent_name = ? AND expires_at > ?`,
    );
    for (const claimId of selectedIds) {
      transfer.run(this.agentName, this.sessionId, expiresAt, claimId, fromAgent, now);
    }
    return selectedClaims.map((claim) => ({
      ...mapClaim(claim),
      agentName: this.agentName,
      expiresAt,
    }));
  }

  #nextDeliverableMessage(now: number): Row | undefined {
    return this.#database
      .prepare(
        `SELECT message.*, receipt.read_at
         FROM messages message
         LEFT JOIN message_receipts receipt
           ON receipt.message_id = message.id AND receipt.agent_name = ?
         LEFT JOIN message_deliveries delivery
           ON delivery.message_id = message.id AND delivery.agent_name = ?
         LEFT JOIN sessions reservation ON reservation.id = delivery.reserved_by_session
         WHERE (message.recipient = ? OR EXISTS (
           SELECT 1 FROM broadcast_recipients recipient
           WHERE recipient.message_id = message.id AND recipient.agent_name = ?
         ))
           AND receipt.read_at IS NULL
           AND (
             delivery.message_id IS NULL OR (
               delivery.delivered_at IS NULL AND (
                 reservation.id IS NULL OR reservation.status <> 'active' OR reservation.expires_at <= ?
               )
             )
           )
         ORDER BY message.created_at ASC, message.id ASC
         LIMIT 1`,
      )
      .get(this.agentName, this.agentName, this.agentName, this.agentName, now) as Row | undefined;
  }

  heartbeat(): Session {
    const now = this.#clock();
    const sessionExpiry = now + this.config.sessionTtlSeconds * 1_000;
    const claimExpiry = now + this.config.claimTtlSeconds * 1_000;
    const taskExpiry = now + this.config.taskLeaseSeconds * 1_000;

    return immediateTransaction(this.#database, () => {
      const renewed = this.#database
        .prepare(
          `UPDATE sessions
           SET last_heartbeat_at = ?, expires_at = ?
           WHERE id = ? AND status = 'active' AND expires_at > ?`,
        )
        .run(now, sessionExpiry, this.sessionId, now).changes;
      if (renewed === 0) {
        throw new SameTreeError('TASK_UNAVAILABLE', 'This session expired and cannot be renewed.');
      }
      this.#refreshWorktreeHead(now);
      this.#database
        .prepare('UPDATE agents SET last_seen_at = ? WHERE name = ?')
        .run(now, this.agentName);
      this.#database
        .prepare('UPDATE path_claims SET expires_at = ? WHERE session_id = ? AND expires_at > ?')
        .run(claimExpiry, this.sessionId, now);
      this.#database
        .prepare(
          `UPDATE tasks SET lease_expires_at = ?
           WHERE claimed_by_session = ? AND status = 'in_progress' AND lease_expires_at > ?`,
        )
        .run(taskExpiry, this.sessionId, now);

      const row = this.#database
        .prepare(
          `SELECT session.*, worktree.name AS worktree_name, worktree.branch AS current_branch
           FROM sessions session
           JOIN worktrees worktree ON worktree.id = session.home_worktree_id
           WHERE session.id = ?`,
        )
        .get(this.sessionId);
      return mapSession(row as Row);
    });
  }

  close(options: { releaseClaims?: boolean } = {}): void {
    if (this.#closed) return;
    try {
      immediateTransaction(this.#database, () => {
        this.#database
          .prepare(
            'DELETE FROM message_deliveries WHERE reserved_by_session = ? AND delivered_at IS NULL',
          )
          .run(this.sessionId);
        if (options.releaseClaims) {
          this.#database
            .prepare('DELETE FROM path_claims WHERE session_id = ?')
            .run(this.sessionId);
          this.#database
            .prepare(
              `UPDATE tasks SET claimed_by_session = NULL, lease_expires_at = NULL
               WHERE claimed_by_session = ? AND status = 'in_progress'`,
            )
            .run(this.sessionId);
        }
        this.#database
          .prepare("UPDATE sessions SET status = 'closed', expires_at = ? WHERE id = ?")
          .run(this.#clock(), this.sessionId);
        if (this.#recordSessionLifecycleEvents) {
          this.#recordEvent('session.closed', 'session', this.sessionId, {
            releasedClaims: options.releaseClaims ?? false,
          });
        }
      });
    } finally {
      this.#database.close();
      this.#closed = true;
    }
  }

  listAgents(options: { activeOnly?: boolean } = {}): Agent[] {
    const now = this.#clock();
    const rows = options.activeOnly
      ? (this.#database
          .prepare(
            `SELECT DISTINCT agent.*
             FROM agents agent
             JOIN sessions session ON session.agent_name = agent.name
             WHERE session.status = 'active' AND session.expires_at > ?
             ORDER BY agent.last_seen_at DESC, agent.name`,
          )
          .all(now) as Row[])
      : (this.#database
          .prepare('SELECT * FROM agents ORDER BY last_seen_at DESC, name')
          .all() as Row[]);
    return rows.map((row) => {
      const name = stringValue(row, 'name');
      return mapAgent(row, this.#activeMembers(name, now));
    });
  }

  createTask(input: CreateTaskInput): Task {
    const id = createId('task');
    const title = requireText(input.title, 'Task title', 200);
    const description = input.description?.trim() ?? '';
    if (description.length > 20_000) {
      throw new SameTreeError('INVALID_INPUT', 'Task descriptions cannot exceed 20000 characters.');
    }
    const priority = input.priority ?? 'normal';
    const assignee = input.assignee ?? this.agentName;
    if (assignee !== this.agentName) {
      throw new SameTreeError(
        'USER_AUTHORIZATION_REQUIRED',
        'Agents may create task records only for their own user-defined scope. Ask the user to instruct the target agent directly.',
        { requestedAssignee: assignee },
      );
    }
    const dependencies = [...new Set(input.dependencies ?? [])];
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      for (const dependency of dependencies) this.#task(dependency);
      const members = this.#resolveTaskMembers(input.members ?? []);

      this.#database
        .prepare(
          `INSERT INTO tasks
            (id, title, description, status, priority, assignee, created_at, updated_at)
           VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)`,
        )
        .run(id, title, description, priority, assignee, now, now);
      const addDependency = this.#database.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      );
      for (const dependency of dependencies) addDependency.run(id, dependency);
      const addMember = this.#database.prepare(
        'INSERT INTO task_worktrees (task_id, worktree_id) VALUES (?, ?)',
      );
      for (const member of members) addMember.run(id, member.id);
      this.#recordEvent('task.created', 'task', id, {
        assignee,
        dependencies,
        members: members.map((member) => member.name),
        priority,
      });
      return this.#task(id);
    });
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Task list limit must be between 1 and 100.');
    }
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    if (options.status) {
      conditions.push('status = ?');
      parameters.push(options.status);
    } else if (!options.includeTerminal) {
      conditions.push("status NOT IN ('done', 'cancelled')");
    }
    if (options.member !== undefined) {
      const member = this.#resolveTaskMembers([options.member], { requireAvailable: false })[0];
      if (!member) throw new SameTreeError('NOT_FOUND', 'Workspace member was not found.');
      conditions.push(
        'EXISTS (SELECT 1 FROM task_worktrees WHERE task_id = tasks.id AND worktree_id = ?)',
      );
      parameters.push(member.id);
    }
    if (options.after) {
      const cursor = this.#database
        .prepare('SELECT created_at, id FROM tasks WHERE id = ?')
        .get(options.after) as Row | undefined;
      if (!cursor) {
        throw new SameTreeError('NOT_FOUND', `Task cursor '${options.after}' does not exist.`);
      }
      conditions.push('(created_at > ? OR (created_at = ? AND id > ?))');
      parameters.push(
        numberValue(cursor, 'created_at'),
        numberValue(cursor, 'created_at'),
        stringValue(cursor, 'id'),
      );
    }
    parameters.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#database
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...parameters) as Row[];
    return rows.map((row) => {
      const id = stringValue(row, 'id');
      return mapTask(row, this.#dependencies(id), this.#taskMembers(id));
    });
  }

  claimTask(taskId: string, authorization: UserAuthorizedTaskInput = {}): Task {
    const now = this.#clock();
    return immediateTransaction(this.#database, () => {
      const task = this.#task(taskId);
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'blocked') {
        throw new SameTreeError('TASK_UNAVAILABLE', `Task '${taskId}' is ${task.status}.`);
      }

      const blockers = this.#unfinishedDependencies(taskId);
      if (blockers.length > 0) {
        throw new SameTreeError('TASK_BLOCKED', `Task '${taskId}' has unfinished dependencies.`, {
          dependencies: blockers,
        });
      }

      if (task.assignee && task.assignee !== this.agentName) {
        throw new SameTreeError(
          'USER_AUTHORIZATION_REQUIRED',
          `Task '${taskId}' is assigned to ${task.assignee}; only an explicitly user-authorized takeover may reassign it.`,
          { assignee: task.assignee, currentRevision: task.revision },
        );
      }

      let adoptionReason: string | undefined;
      if (!task.assignee) {
        if (!authorization.userAuthorized) {
          throw new SameTreeError(
            'USER_AUTHORIZATION_REQUIRED',
            `Task '${taskId}' is an unassigned legacy record. Adopt it only after the user explicitly adds it to your scope.`,
            { currentRevision: task.revision },
          );
        }
        if (authorization.expectedRevision !== task.revision) {
          throw new SameTreeError(
            'TASK_UNAVAILABLE',
            `Task '${taskId}' changed from revision ${authorization.expectedRevision ?? 'unknown'} to ${task.revision}.`,
            { currentRevision: task.revision },
          );
        }
        adoptionReason = requireText(authorization.reason ?? '', 'Adoption reason', 2_000);
      }

      this.#database
        .prepare(
          `UPDATE tasks SET
             status = 'in_progress', assignee = ?, claimed_by_session = ?, lease_expires_at = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          this.agentName,
          this.sessionId,
          now + this.config.taskLeaseSeconds * 1_000,
          now,
          taskId,
        );
      this.#recordEvent(task.assignee ? 'task.claimed' : 'task.adopted', 'task', taskId, {
        previousAssignee: task.assignee,
        ...(adoptionReason
          ? { previousRevision: task.revision, reason: adoptionReason, userAuthorized: true }
          : {}),
      });
      return this.#task(taskId);
    });
  }

  forceTakeoverTask(
    taskId: string,
    input: ForceTakeoverTaskInput,
  ): { claims: PathClaim[]; task: Task } {
    if (!input.userAuthorized) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Forced takeover requires explicit user authorization.',
      );
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Expected task revision must be a positive integer.',
      );
    }
    const reason = requireText(input.reason, 'Takeover reason', 2_000);
    const claimIds = [...new Set(input.claimIds ?? [])];
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      const task = this.#task(taskId);
      if (task.revision !== input.expectedRevision) {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Task '${taskId}' changed from revision ${input.expectedRevision} to ${task.revision}.`,
          { currentRevision: task.revision },
        );
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Task '${taskId}' is ${task.status} and cannot be reassigned.`,
        );
      }
      if (!task.assignee) {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Task '${taskId}' is unassigned; use user-authorized task claiming to adopt it.`,
          { currentRevision: task.revision },
        );
      }
      if (task.assignee === this.agentName) {
        throw new SameTreeError('INVALID_INPUT', `Task '${taskId}' is already assigned to you.`);
      }
      const blockers = this.#unfinishedDependencies(taskId);
      const startExecution = task.status !== 'blocked' && blockers.length === 0;

      const previousAssignee = task.assignee;
      const claims = this.#transferClaims(claimIds, previousAssignee, now, 'TASK_UNAVAILABLE');
      this.#database
        .prepare(
          `UPDATE tasks SET assignee = ?, claimed_by_session = ?, lease_expires_at = ?,
             status = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          this.agentName,
          startExecution ? this.sessionId : null,
          startExecution ? now + this.config.taskLeaseSeconds * 1_000 : null,
          startExecution ? 'in_progress' : task.status,
          now,
          taskId,
        );
      this.#recordEvent('task.force_taken_over', 'task', taskId, {
        newAssignee: this.agentName,
        previousAssignee,
        previousLeaseExpiresAt: task.leaseExpiresAt,
        previousRevision: task.revision,
        claimIds,
        blockers,
        newStatus: startExecution ? 'in_progress' : task.status,
        reason,
        userAuthorized: true,
      });
      return { task: this.#task(taskId), claims };
    });
  }

  updateTask(taskId: string, input: UpdateTaskInput): Task {
    return immediateTransaction(this.#database, () => {
      const task = this.#task(taskId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Task '${taskId}' changed from revision ${input.expectedRevision} to ${task.revision}.`,
          { currentRevision: task.revision },
        );
      }
      if (task.assignee !== this.agentName) {
        throw new SameTreeError(
          'NOT_ASSIGNED',
          task.assignee
            ? `Task '${taskId}' is assigned to ${task.assignee}.`
            : `Claim task '${taskId}' before updating it.`,
        );
      }

      const status = input.status ?? task.status;
      const transitions: Record<TaskStatus, TaskStatus[]> = {
        ready: ['ready', 'in_progress', 'blocked', 'cancelled'],
        in_progress: ['ready', 'in_progress', 'blocked', 'done', 'cancelled'],
        blocked: ['ready', 'blocked', 'cancelled'],
        done: ['done'],
        cancelled: ['cancelled'],
      };
      if (!transitions[task.status].includes(status)) {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Task '${taskId}' cannot transition from ${task.status} to ${status}.`,
        );
      }
      if (status === 'in_progress') {
        const blockers = this.#unfinishedDependencies(taskId);
        if (blockers.length > 0) {
          throw new SameTreeError('TASK_BLOCKED', `Task '${taskId}' has unfinished dependencies.`, {
            dependencies: blockers,
          });
        }
      }
      const description = input.description?.trim() ?? task.description;
      if (description.length > 20_000) {
        throw new SameTreeError(
          'INVALID_INPUT',
          'Task descriptions cannot exceed 20000 characters.',
        );
      }
      const active = status === 'in_progress';
      const members =
        input.members === undefined ? undefined : this.#resolveTaskMembers(input.members);
      this.#database
        .prepare(
          `UPDATE tasks SET
             status = ?, description = ?, priority = ?,
             claimed_by_session = ?, lease_expires_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          description,
          input.priority ?? task.priority,
          active ? this.sessionId : null,
          active ? this.#clock() + this.config.taskLeaseSeconds * 1_000 : null,
          this.#clock(),
          taskId,
        );
      if (members) {
        this.#database.prepare('DELETE FROM task_worktrees WHERE task_id = ?').run(taskId);
        const addMember = this.#database.prepare(
          'INSERT INTO task_worktrees (task_id, worktree_id) VALUES (?, ?)',
        );
        for (const member of members) addMember.run(taskId, member.id);
      }
      this.#recordEvent('task.updated', 'task', taskId, {
        fromStatus: task.status,
        toStatus: status,
        ...(members ? { members: members.map((member) => member.name) } : {}),
      });
      return this.#task(taskId);
    });
  }

  acquireClaims(inputs: AcquireClaimInput[], ttlSeconds?: number): PathClaim[] {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Acquire between 1 and 100 paths at once.');
    }
    const ttl = ttlSeconds ?? this.config.claimTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) {
      throw new SameTreeError('INVALID_INPUT', 'Claim TTL must be between 30 and 86400 seconds.');
    }

    const requested = inputs.map((input) => {
      const worktree = this.#claimWorktree(input.member);
      return {
        ...normalizeClaim(
          worktree.root,
          input.path,
          input.kind ?? (input.path.endsWith('/') ? 'tree' : 'exact'),
          worktree.ignoreCase,
        ),
        worktreeId: worktree.id,
        member: worktree.name,
        repositoryId: worktree.repositoryId,
      };
    });
    const unique = requested.filter(
      (claim, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.comparisonPath === claim.comparisonPath &&
            candidate.kind === claim.kind &&
            candidate.worktreeId === claim.worktreeId,
        ) === index,
    );
    const now = this.#clock();
    const expiresAt = now + ttl * 1_000;

    return immediateTransaction(this.#database, () => {
      this.#database.prepare('DELETE FROM path_claims WHERE expires_at <= ?').run(now);
      const active = this.#database
        .prepare(
          `SELECT claim.*, worktree.name AS worktree_name, worktree.repository_id
           FROM path_claims claim
           JOIN worktrees worktree ON worktree.id = claim.worktree_id
           WHERE claim.expires_at > ?`,
        )
        .all(now) as Row[];

      // One agent may intentionally hold a broad claim plus narrower claims for handoff.
      for (const claim of unique) {
        const conflict = active.find(
          (row) =>
            stringValue(row, 'agent_name') !== this.agentName &&
            stringValue(row, 'worktree_id') === claim.worktreeId &&
            claimsOverlap(claim, {
              comparisonPath: stringValue(row, 'comparison_path'),
              kind: stringValue(row, 'kind') as ClaimKind,
            }),
        );
        if (conflict) {
          throw new SameTreeError(
            'CLAIM_CONFLICT',
            `${claim.member}:${claim.path} overlaps ${stringValue(conflict, 'agent_name')}'s active claim.`,
            { conflictingClaim: mapClaim(conflict) },
          );
        }
      }

      const results: PathClaim[] = [];
      for (const claim of unique) {
        const own = active.find(
          (row) =>
            stringValue(row, 'agent_name') === this.agentName &&
            stringValue(row, 'worktree_id') === claim.worktreeId &&
            stringValue(row, 'comparison_path') === claim.comparisonPath &&
            stringValue(row, 'kind') === claim.kind,
        );
        if (own) {
          this.#database
            .prepare('UPDATE path_claims SET session_id = ?, expires_at = ? WHERE id = ?')
            .run(this.sessionId, expiresAt, stringValue(own, 'id'));
          results.push({
            ...mapClaim(
              own,
              this.#linkedClaimWarnings(
                {
                  comparisonPath: claim.comparisonPath,
                  kind: claim.kind,
                  member: claim.member,
                  repositoryId: claim.repositoryId,
                  worktreeId: claim.worktreeId,
                },
                active,
              ),
            ),
            expiresAt,
          });
          continue;
        }

        const id = createId('claim');
        this.#database
          .prepare(
            `INSERT INTO path_claims
              (id, path, comparison_path, kind, agent_name, session_id,
               expires_at, created_at, worktree_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            claim.path,
            claim.comparisonPath,
            claim.kind,
            this.agentName,
            this.sessionId,
            expiresAt,
            now,
            claim.worktreeId,
          );
        results.push({
          id,
          worktreeId: claim.worktreeId,
          member: claim.member,
          path: claim.path,
          comparisonPath: claim.comparisonPath,
          kind: claim.kind,
          agentName: this.agentName,
          expiresAt,
          createdAt: now,
          warnings: this.#linkedClaimWarnings(claim, active),
        });
        active.push({
          id,
          path: claim.path,
          comparison_path: claim.comparisonPath,
          kind: claim.kind,
          agent_name: this.agentName,
          session_id: this.sessionId,
          expires_at: expiresAt,
          created_at: now,
          worktree_id: claim.worktreeId,
          worktree_name: claim.member,
          repository_id: claim.repositoryId,
        });
      }
      for (const result of results) {
        const claim = unique.find(
          (candidate) =>
            candidate.worktreeId === result.worktreeId &&
            candidate.comparisonPath === result.comparisonPath &&
            candidate.kind === result.kind,
        );
        if (claim) result.warnings = this.#linkedClaimWarnings(claim, active);
      }
      this.#recordEvent('claim.acquired', 'claim', results.map((claim) => claim.id).join(','), {
        paths: results.map((claim) => ({ member: claim.member, path: claim.path })),
        expiresAt,
        warnings: results.flatMap((claim) => claim.warnings),
      });
      return results;
    });
  }

  listClaims(options: { includeExpired?: boolean } = {}): PathClaim[] {
    const rows = options.includeExpired
      ? (this.#database
          .prepare(
            `SELECT claim.*, worktree.name AS worktree_name, worktree.repository_id
             FROM path_claims claim
             JOIN worktrees worktree ON worktree.id = claim.worktree_id
             ORDER BY worktree.name, claim.path, claim.created_at`,
          )
          .all() as Row[])
      : (this.#database
          .prepare(
            `SELECT claim.*, worktree.name AS worktree_name, worktree.repository_id
             FROM path_claims claim
             JOIN worktrees worktree ON worktree.id = claim.worktree_id
             WHERE claim.expires_at > ?
             ORDER BY worktree.name, claim.path, claim.created_at`,
          )
          .all(this.#clock()) as Row[]);
    return rows.map((row) =>
      mapClaim(
        row,
        this.#linkedClaimWarnings(
          {
            comparisonPath: stringValue(row, 'comparison_path'),
            kind: stringValue(row, 'kind') as ClaimKind,
            member: stringValue(row, 'worktree_name'),
            repositoryId: stringValue(row, 'repository_id'),
            worktreeId: stringValue(row, 'worktree_id'),
          },
          rows,
        ),
      ),
    );
  }

  releaseClaims(input: { ids?: string[]; all?: boolean } = {}): { released: number } {
    const ids = [...new Set(input.ids ?? [])];
    if (!input.all && ids.length === 0) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Provide claim IDs or request release of all claims.',
      );
    }

    return immediateTransaction(this.#database, () => {
      let released = 0;
      if (input.all) {
        released = this.#database
          .prepare('DELETE FROM path_claims WHERE agent_name = ?')
          .run(this.agentName).changes;
      } else {
        const remove = this.#database.prepare(
          'DELETE FROM path_claims WHERE id = ? AND agent_name = ?',
        );
        for (const id of ids) released += remove.run(id, this.agentName).changes;
      }
      this.#recordEvent('claim.released', 'claim', ids.join(',') || '*', { released });
      return { released };
    });
  }

  sendMessage(input: {
    to?: string;
    subject: string;
    body: string;
    threadId?: string;
    taskId?: string;
  }): Message {
    const id = createId('message');
    const subject = requireText(input.subject, 'Message subject', 200);
    const body = requireText(input.body, 'Message body', 50_000);
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      if (input.to) this.#requireAgent(input.to);
      if (input.taskId) this.#task(input.taskId);
      this.#database
        .prepare(
          `INSERT INTO messages
            (id, sender, recipient, subject, body, thread_id, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.agentName,
          input.to ?? null,
          subject,
          body,
          input.threadId ?? id,
          input.taskId ?? null,
          now,
        );
      if (!input.to) {
        this.#database
          .prepare(
            `INSERT INTO broadcast_recipients (message_id, agent_name)
             SELECT ?, name FROM agents WHERE name <> ?`,
          )
          .run(id, this.agentName);
      }
      this.#recordEvent('message.sent', 'message', id, {
        recipient: input.to ?? null,
        taskId: input.taskId ?? null,
      });
      return {
        id,
        sender: this.agentName,
        recipient: input.to ?? null,
        subject,
        body,
        threadId: input.threadId ?? id,
        taskId: input.taskId ?? null,
        createdAt: now,
        readAt: null,
      };
    });
  }

  inbox(options: { unreadOnly?: boolean; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const unread = options.unreadOnly ? 'AND receipt.read_at IS NULL' : '';
    return (
      this.#database
        .prepare(
          `SELECT message.*, receipt.read_at
           FROM messages message
           LEFT JOIN message_receipts receipt
             ON receipt.message_id = message.id AND receipt.agent_name = ?
           WHERE (message.recipient = ? OR EXISTS (
             SELECT 1 FROM broadcast_recipients recipient
             WHERE recipient.message_id = message.id AND recipient.agent_name = ?
           ))
             ${unread}
           ORDER BY message.created_at DESC
           LIMIT ?`,
        )
        .all(this.agentName, this.agentName, this.agentName, limit) as Row[]
    ).map(mapMessage);
  }

  reserveNextMessageDelivery(): Message | null {
    const now = this.#clock();
    if (!this.#nextDeliverableMessage(now)) return null;

    return immediateTransaction(this.#database, () => {
      const candidate = this.#nextDeliverableMessage(now);
      if (!candidate) return null;
      const active = this.#database
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND status = 'active' AND expires_at > ?")
        .get(this.sessionId, now);
      if (!active) {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          'This session expired and cannot deliver messages.',
        );
      }

      const messageId = stringValue(candidate, 'id');
      const reserved = this.#database
        .prepare(
          `INSERT INTO message_deliveries
             (message_id, agent_name, reserved_by_session, reserved_at, delivered_at)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(message_id, agent_name) DO UPDATE SET
             reserved_by_session = excluded.reserved_by_session,
             reserved_at = excluded.reserved_at,
             delivered_at = NULL
           WHERE message_deliveries.delivered_at IS NULL`,
        )
        .run(messageId, this.agentName, this.sessionId, now).changes;
      return reserved === 1 ? mapMessage(candidate) : null;
    });
  }

  completeMessageDelivery(messageId: string): void {
    const completed = this.#database
      .prepare(
        `UPDATE message_deliveries SET delivered_at = ?
         WHERE message_id = ? AND agent_name = ? AND reserved_by_session = ?
           AND delivered_at IS NULL`,
      )
      .run(this.#clock(), messageId, this.agentName, this.sessionId).changes;
    if (completed !== 1) {
      throw new SameTreeError(
        'NOT_ASSIGNED',
        `Message '${messageId}' is not reserved by this session.`,
      );
    }
  }

  releaseMessageDelivery(messageId: string): void {
    this.#database
      .prepare(
        `DELETE FROM message_deliveries
         WHERE message_id = ? AND agent_name = ? AND reserved_by_session = ?
           AND delivered_at IS NULL`,
      )
      .run(messageId, this.agentName, this.sessionId);
  }

  acknowledgeMessage(messageId: string): Message {
    return immediateTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          `SELECT message.*, receipt.read_at
           FROM messages message
           LEFT JOIN message_receipts receipt
             ON receipt.message_id = message.id AND receipt.agent_name = ?
           WHERE message.id = ?`,
        )
        .get(this.agentName, messageId) as Row | undefined;
      if (!row) throw new SameTreeError('NOT_FOUND', `Message '${messageId}' does not exist.`);
      const recipient = nullableString(row, 'recipient');
      if (recipient !== null && recipient !== this.agentName) {
        throw new SameTreeError(
          'NOT_ASSIGNED',
          `Message '${messageId}' is addressed to ${recipient}.`,
        );
      }
      if (
        recipient === null &&
        !this.#database
          .prepare('SELECT 1 FROM broadcast_recipients WHERE message_id = ? AND agent_name = ?')
          .get(messageId, this.agentName)
      ) {
        throw new SameTreeError('NOT_ASSIGNED', `Broadcast '${messageId}' was not sent to you.`);
      }

      const readAt = this.#clock();
      this.#database
        .prepare(
          `INSERT INTO message_receipts (message_id, agent_name, read_at)
           VALUES (?, ?, ?)
           ON CONFLICT(message_id, agent_name) DO UPDATE SET read_at = excluded.read_at`,
        )
        .run(messageId, this.agentName, readAt);
      this.#recordEvent('message.acknowledged', 'message', messageId);
      return { ...mapMessage(row), readAt };
    });
  }

  offerHandoff(input: {
    taskId: string;
    to: string;
    summary: string;
    context?: Record<string, unknown>;
    claimIds?: string[];
  }): Handoff {
    const id = createId('handoff');
    const summary = requireText(input.summary, 'Handoff summary', 20_000);
    const claimIds = [...new Set(input.claimIds ?? [])];
    if (claimIds.length > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Transfer at most 100 claims in one handoff.');
    }
    const now = this.#clock();
    const expiresAt = now + this.config.handoffTtlSeconds * 1_000;
    let contextJson: string;
    try {
      contextJson = JSON.stringify({ ...(input.context ?? {}), claimIds });
    } catch {
      throw new SameTreeError('INVALID_INPUT', 'Handoff context must be JSON serializable.');
    }
    if (Buffer.byteLength(contextJson, 'utf8') > MAX_HANDOFF_CONTEXT_BYTES) {
      throw new SameTreeError(
        'INVALID_INPUT',
        `Handoff context cannot exceed ${MAX_HANDOFF_CONTEXT_BYTES} bytes.`,
      );
    }

    return immediateTransaction(this.#database, () => {
      this.#requireAgent(input.to);
      if (input.to === this.agentName) {
        throw new SameTreeError('INVALID_INPUT', 'A handoff recipient must be another agent.');
      }
      const task = this.#task(input.taskId);
      if (task.assignee !== this.agentName) {
        throw new SameTreeError('NOT_ASSIGNED', `Task '${input.taskId}' is not assigned to you.`);
      }
      if (task.status !== 'in_progress') {
        throw new SameTreeError(
          'TASK_UNAVAILABLE',
          `Only in-progress work can be handed off; task '${input.taskId}' is ${task.status}.`,
        );
      }
      for (const claimId of claimIds) {
        const owned = this.#database
          .prepare('SELECT 1 FROM path_claims WHERE id = ? AND agent_name = ? AND expires_at > ?')
          .get(claimId, this.agentName, now);
        if (!owned) {
          throw new SameTreeError(
            'NOT_ASSIGNED',
            `Claim '${claimId}' is not active and owned by you.`,
          );
        }
      }

      this.#database
        .prepare(
          `INSERT INTO handoffs
            (id, task_id, from_agent, to_agent, summary, context_json, task_revision,
             status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          this.agentName,
          input.to,
          summary,
          contextJson,
          task.revision,
          now,
          expiresAt,
        );
      this.#recordEvent('handoff.offered', 'handoff', id, {
        taskId: input.taskId,
        to: input.to,
      });
      const row = this.#database.prepare('SELECT * FROM handoffs WHERE id = ?').get(id);
      return mapHandoff(row as Row, now);
    });
  }

  listHandoffs(options: { pendingOnly?: boolean } = {}): Handoff[] {
    const now = this.#clock();
    const rows = options.pendingOnly
      ? (this.#database
          .prepare(
            `SELECT handoff.* FROM handoffs handoff
             JOIN tasks task ON task.id = handoff.task_id
             WHERE handoff.to_agent = ? AND handoff.status = 'offered'
               AND handoff.expires_at > ? AND task.revision = handoff.task_revision
               AND task.assignee = handoff.from_agent AND task.status = 'in_progress'
             ORDER BY handoff.created_at DESC`,
          )
          .all(this.agentName, now) as Row[])
      : (this.#database
          .prepare(
            `SELECT * FROM handoffs
             WHERE to_agent = ? OR from_agent = ?
             ORDER BY created_at DESC`,
          )
          .all(this.agentName, this.agentName) as Row[]);
    return rows.map((row) => mapHandoff(row, now));
  }

  respondToHandoff(
    handoffId: string,
    accept: boolean,
    authorization: UserAuthorizedHandoffInput = {},
  ): Handoff {
    if (accept && !authorization.userAuthorized) {
      throw new SameTreeError(
        'USER_AUTHORIZATION_REQUIRED',
        'Accepting a handoff changes agent scope and requires explicit user authorization.',
      );
    }
    const reason = accept
      ? requireText(authorization.reason ?? '', 'Handoff authorization reason', 2_000)
      : undefined;
    const now = this.#clock();
    return immediateTransaction(this.#database, () => {
      const row = this.#database.prepare('SELECT * FROM handoffs WHERE id = ?').get(handoffId) as
        | Row
        | undefined;
      if (!row) throw new SameTreeError('NOT_FOUND', `Handoff '${handoffId}' does not exist.`);
      if (stringValue(row, 'to_agent') !== this.agentName) {
        throw new SameTreeError(
          'NOT_ASSIGNED',
          `Handoff '${handoffId}' is addressed to another agent.`,
        );
      }
      if (stringValue(row, 'status') !== 'offered' || numberValue(row, 'expires_at') <= now) {
        throw new SameTreeError('HANDOFF_CONFLICT', `Handoff '${handoffId}' is no longer active.`);
      }

      const task = this.#task(stringValue(row, 'task_id'));
      if (accept && task.revision !== numberValue(row, 'task_revision')) {
        throw new SameTreeError(
          'HANDOFF_CONFLICT',
          `Task '${task.id}' changed after this handoff was offered.`,
          { currentRevision: task.revision, offeredRevision: numberValue(row, 'task_revision') },
        );
      }
      if (accept && task.status !== 'in_progress') {
        throw new SameTreeError(
          'HANDOFF_CONFLICT',
          `Task '${task.id}' is ${task.status} and cannot be resumed by this handoff.`,
        );
      }
      if (accept) {
        const blockers = this.#unfinishedDependencies(task.id);
        if (blockers.length > 0) {
          throw new SameTreeError(
            'TASK_BLOCKED',
            `Task '${task.id}' has unfinished dependencies.`,
            {
              dependencies: blockers,
            },
          );
        }
      }

      const status = accept ? 'accepted' : 'rejected';
      this.#database
        .prepare('UPDATE handoffs SET status = ?, responded_at = ? WHERE id = ?')
        .run(status, now, handoffId);

      if (accept) {
        this.#database
          .prepare(
            `UPDATE tasks SET assignee = ?, claimed_by_session = ?, lease_expires_at = ?,
               status = 'in_progress', revision = revision + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            this.agentName,
            this.sessionId,
            now + this.config.taskLeaseSeconds * 1_000,
            now,
            task.id,
          );

        const context = parseObject(row.context_json);
        const claimIds = Array.isArray(context.claimIds)
          ? context.claimIds.filter((value): value is string => typeof value === 'string')
          : [];
        this.#transferClaims(claimIds, stringValue(row, 'from_agent'), now);
      }

      this.#recordEvent(`handoff.${status}`, 'handoff', handoffId, {
        taskId: task.id,
        ...(accept ? { reason, userAuthorized: true } : {}),
      });
      return mapHandoff({ ...row, status, responded_at: now }, now);
    });
  }

  getPolicy(member?: string): PolicyDocument {
    const worktree = this.#claimWorktree(member);
    const policyPath = path.join(worktree.root, POLICY_FILE);
    if (!existsSync(policyPath)) {
      throw new SameTreeError(
        'POLICY_NOT_FOUND',
        `No policy exists at ${policyPath}; run 'sametree init'.`,
      );
    }
    const policyBytes = readFileSync(policyPath);
    const content = policyBytes.toString('utf8');
    const hash = createHash('sha256').update(policyBytes).digest('hex');
    const ack = this.#database
      .prepare(
        `SELECT acknowledged_at FROM policy_acks
         WHERE policy_hash = ? AND agent_name = ? AND worktree_id = ?`,
      )
      .get(hash, this.agentName, worktree.id) as Row | undefined;
    return {
      content,
      hash,
      path: policyPath,
      worktreeId: worktree.id,
      member: worktree.name,
      acknowledgedAt: ack ? numberValue(ack, 'acknowledged_at') : null,
    };
  }

  acknowledgePolicy(hash: string, member?: string): PolicyAcknowledgement {
    const policy = this.getPolicy(member);
    if (policy.hash !== hash) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'The policy changed; read and acknowledge the new hash.',
        {
          currentHash: policy.hash,
        },
      );
    }
    return immediateTransaction(this.#database, () => {
      const acknowledgedAt = this.#clock();
      const inserted = this.#database
        .prepare(
          `INSERT INTO policy_acks (policy_hash, agent_name, worktree_id, acknowledged_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(policy_hash, agent_name, worktree_id) DO NOTHING`,
        )
        .run(hash, this.agentName, policy.worktreeId, acknowledgedAt).changes;
      if (inserted === 1) {
        this.#recordEvent(
          'policy.acknowledged',
          'policy',
          hash,
          { member: policy.member },
          policy.worktreeId,
        );
      }
      const acknowledgement = this.#database
        .prepare(
          `SELECT acknowledged_at FROM policy_acks
           WHERE policy_hash = ? AND agent_name = ? AND worktree_id = ?`,
        )
        .get(hash, this.agentName, policy.worktreeId) as Row;
      return {
        hash,
        worktreeId: policy.worktreeId,
        member: policy.member,
        acknowledgedAt: numberValue(acknowledgement, 'acknowledged_at'),
        newlyAcknowledged: inserted === 1,
      };
    });
  }

  events(options: { after?: number; limit?: number } = {}): CoordinationEvent[] {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new SameTreeError('INVALID_INPUT', 'Event limit must be between 1 and 1000.');
    }
    return (
      this.#database
        .prepare(
          `SELECT event.*, worktree.name AS worktree_name
           FROM events event
           LEFT JOIN worktrees worktree ON worktree.id = event.worktree_id
           WHERE event.sequence > ? ORDER BY event.sequence LIMIT ?`,
        )
        .all(options.after ?? 0, limit) as Row[]
    ).map((row) => ({
      sequence: numberValue(row, 'sequence'),
      id: stringValue(row, 'id'),
      kind: stringValue(row, 'kind'),
      actor: stringValue(row, 'actor'),
      entityType: stringValue(row, 'entity_type'),
      entityId: stringValue(row, 'entity_id'),
      payload: parseObject(row.payload_json),
      worktreeId: nullableString(row, 'worktree_id'),
      member: nullableString(row, 'worktree_name'),
      createdAt: numberValue(row, 'created_at'),
    }));
  }

  snapshot(options: SnapshotOptions = {}): CoordinationSnapshot {
    immediateTransaction(this.#database, () => this.#refreshWorkspaceHeads());
    const git = readGitWorktreeContext(this.repository.root, this.repository.privateGitDirectory);
    return this.#database.transaction(() => {
      const workspaceStatus = this.#workspaceStatus();
      const taskRows = options.includeTerminalTasks
        ? (this.#database.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as Row[])
        : (this.#database
            .prepare(
              `SELECT * FROM tasks
               WHERE status NOT IN ('done', 'cancelled')
               ORDER BY created_at, id`,
            )
            .all() as Row[]);
      const agentRow = this.#database
        .prepare('SELECT * FROM agents WHERE name = ?')
        .get(this.agentName);
      const sessionRow = this.#database
        .prepare(
          `SELECT session.*, worktree.name AS worktree_name, worktree.branch AS current_branch
           FROM sessions session
           JOIN worktrees worktree ON worktree.id = session.home_worktree_id
           WHERE session.id = ?`,
        )
        .get(this.sessionId);
      const sessionRows = this.#database
        .prepare(
          `SELECT session.*, worktree.name AS worktree_name, worktree.branch AS current_branch
           FROM sessions session
           JOIN worktrees worktree ON worktree.id = session.home_worktree_id
           WHERE session.status = 'active' AND session.expires_at > ?
           ORDER BY session.started_at, session.id`,
        )
        .all(this.#clock()) as Row[];
      const sessions = sessionRows.map(mapSession);
      const branchWarnings: CoordinationWarning[] = sessions
        .filter((session) => session.branchChanged)
        .map((session) => ({
          code: 'BRANCH_CHANGED',
          message: `${session.agentName} started on ${session.startedBranch ?? 'detached HEAD'} while ${session.homeMember} is now on ${session.currentBranch ?? 'detached HEAD'}.`,
          member: session.homeMember,
          worktreeId: session.homeWorktreeId,
          sessionId: session.id,
        }));
      const unread = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages message
           LEFT JOIN message_receipts receipt
             ON receipt.message_id = message.id AND receipt.agent_name = ?
           WHERE (message.recipient = ? OR EXISTS (
             SELECT 1 FROM broadcast_recipients recipient
             WHERE recipient.message_id = message.id AND recipient.agent_name = ?
           )) AND receipt.read_at IS NULL`,
        )
        .get(this.agentName, this.agentName, this.agentName) as Row;
      const handoffs = this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM handoffs handoff
           JOIN tasks task ON task.id = handoff.task_id
           WHERE handoff.to_agent = ? AND handoff.status = 'offered'
             AND handoff.expires_at > ? AND task.revision = handoff.task_revision
             AND task.assignee = handoff.from_agent AND task.status = 'in_progress'`,
        )
        .get(this.agentName, this.#clock()) as Row;
      const lastEvent = this.#database
        .prepare('SELECT MAX(sequence) AS sequence FROM events')
        .get() as Row;
      const claims = this.listClaims();
      const claimWarnings = claims.flatMap((claim) => claim.warnings);

      return {
        ...workspaceStatus,
        git,
        agent: mapAgent(agentRow as Row, this.#activeMembers(this.agentName, this.#clock())),
        session: mapSession(sessionRow as Row),
        sessions,
        agents: this.listAgents({ activeOnly: !options.includeInactiveAgents }),
        tasks: taskRows.map((row) => {
          const id = stringValue(row, 'id');
          return mapTask(row, this.#dependencies(id), this.#taskMembers(id));
        }),
        claims,
        unreadMessages: numberValue(unread, 'count'),
        pendingHandoffs: numberValue(handoffs, 'count'),
        warnings: [...branchWarnings, ...claimWarnings],
        lastEventSequence: nullableNumber(lastEvent, 'sequence') ?? 0,
      };
    })();
  }

  doctor(): DoctorReport {
    return inspectDatabase(this.#database, this.repository);
  }
}
