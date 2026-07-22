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
  Plan,
  PlanSummary,
  PolicyAcknowledgement,
  PolicyDocument,
  Session,
  SharedInstruction,
  SharedInstructionAcknowledgement,
  SharedInstructionAction,
  SharedInstructionNotice,
  SharedInstructionStatus,
  SharedInstructionSummary,
  Task,
  TaskPriority,
  TaskStatus,
} from './types.js';
import {
  acquireWorkspaceOperationLock,
  clearMatchingPendingWorkspaceJoin,
  resolveWorkspaceBinding,
  type WorkspaceContext,
} from './workspace.js';
import { assertWorkspaceBindingReady } from './workspace-service.js';

type Row = Record<string, unknown>;
const MAX_HANDOFF_CONTEXT_BYTES = 100_000;
const MAX_PLAN_BODY_CHARACTERS = 48_000;
const MAX_INSTRUCTION_BODY_CHARACTERS = 48_000;
const MESSAGE_INSTRUCTION_COLUMNS = `,
  notice.instruction_id,
  notice.revision AS instruction_revision,
  instruction.current_revision AS instruction_current_revision,
  instruction.status AS instruction_status,
  instruction.task_id AS instruction_task_id,
  instruction.created_by AS instruction_created_by,
  instruction_revision.action AS instruction_action,
  instruction_revision.body AS instruction_body,
  instruction_revision.recorded_by AS instruction_recorded_by`;
const MESSAGE_INSTRUCTION_JOINS = `
  LEFT JOIN shared_instruction_notifications notice ON notice.message_id = message.id
  LEFT JOIN shared_instructions instruction ON instruction.id = notice.instruction_id
  LEFT JOIN shared_instruction_revisions instruction_revision
    ON instruction_revision.instruction_id = notice.instruction_id
   AND instruction_revision.revision = notice.revision`;

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
  includeRevokedInstructions?: boolean;
  includeTerminalTasks?: boolean;
}

export interface AcquireClaimInput {
  path: string;
  kind?: ClaimKind;
  member?: string;
}

export interface PublishPlanInput {
  body: string;
  sourceSessionId: string;
  sourceEventId: string;
  title?: string;
  taskId?: string;
}

export interface ListPlansOptions {
  after?: string;
  author?: string;
  limit?: number;
  taskId?: string;
}

export interface RecordSharedInstructionInput {
  body: string;
  reason: string;
  userAuthorized: boolean;
  taskId?: string;
  sourceSessionId?: string;
  sourceEventId?: string;
}

export interface ReviseSharedInstructionInput {
  body: string;
  expectedRevision: number;
  reason: string;
  userAuthorized: boolean;
}

export interface RevokeSharedInstructionInput {
  expectedRevision: number;
  reason: string;
  userAuthorized: boolean;
}

export interface ListSharedInstructionsOptions {
  after?: string;
  includeRevoked?: boolean;
  limit?: number;
  taskId?: string;
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

function requireExactInstructionText(value: string): string {
  let scalarCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new SameTreeError('INVALID_INPUT', 'Shared instruction contains malformed Unicode.');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SameTreeError('INVALID_INPUT', 'Shared instruction contains malformed Unicode.');
    }
    scalarCount += 1;
  }
  if (!/\S/u.test(value) || scalarCount > MAX_INSTRUCTION_BODY_CHARACTERS) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `Shared instruction must contain between 1 and ${MAX_INSTRUCTION_BODY_CHARACTERS} characters.`,
    );
  }
  return value;
}

function assertUserAuthorized(userAuthorized: boolean, operation: string): void {
  if (!userAuthorized) {
    throw new SameTreeError(
      'USER_AUTHORIZATION_REQUIRED',
      `${operation} requires direct user authorization.`,
    );
  }
}

function planTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine?.replace(/^#{1,6}\s+/u, '') || 'Proposed plan').slice(0, 200);
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
  const instructionId = nullableString(row, 'instruction_id');
  const instruction: SharedInstructionNotice | null = instructionId
    ? {
        id: instructionId,
        revision: numberValue(row, 'instruction_revision'),
        currentRevision: numberValue(row, 'instruction_current_revision'),
        status: stringValue(row, 'instruction_status') as SharedInstructionStatus,
        action: stringValue(row, 'instruction_action') as SharedInstructionAction,
        taskId: nullableString(row, 'instruction_task_id'),
        createdBy: stringValue(row, 'instruction_created_by'),
        recordedBy: stringValue(row, 'instruction_recorded_by'),
        body: nullableString(row, 'instruction_body'),
        isCurrent:
          numberValue(row, 'instruction_revision') ===
          numberValue(row, 'instruction_current_revision'),
      }
    : null;
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
    instruction,
  };
}

function mapSharedInstruction(row: Row): SharedInstruction {
  return {
    id: stringValue(row, 'id'),
    createdBy: stringValue(row, 'created_by'),
    taskId: nullableString(row, 'task_id'),
    sourceHarness: stringValue(row, 'source_harness') as Harness,
    sourceSessionId: stringValue(row, 'source_session_id'),
    sourceEventId: stringValue(row, 'source_event_id'),
    revision: numberValue(row, 'revision'),
    status: stringValue(row, 'status') as SharedInstructionStatus,
    action: stringValue(row, 'action') as SharedInstructionAction,
    body: nullableString(row, 'body'),
    contentHash: nullableString(row, 'content_hash'),
    recordedBy: stringValue(row, 'recorded_by'),
    authorizationReason: stringValue(row, 'authorization_reason'),
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at'),
    revisionCreatedAt: numberValue(row, 'revision_created_at'),
    acknowledgedAt: nullableNumber(row, 'acknowledged_at'),
  };
}

function sharedInstructionSummary(instruction: SharedInstruction): SharedInstructionSummary {
  const {
    authorizationReason: _authorizationReason,
    body: _body,
    contentHash: _contentHash,
    sourceEventId: _sourceEventId,
    ...summary
  } = instruction;
  return summary;
}

function mapPlan(row: Row): Plan {
  return {
    id: stringValue(row, 'id'),
    author: stringValue(row, 'author'),
    taskId: nullableString(row, 'task_id'),
    sourceHarness: stringValue(row, 'source_harness') as Harness,
    sourceSessionId: stringValue(row, 'source_session_id'),
    revision: numberValue(row, 'revision'),
    title: stringValue(row, 'title'),
    body: stringValue(row, 'body'),
    contentHash: stringValue(row, 'content_hash'),
    sourceEventId: stringValue(row, 'source_event_id'),
    createdAt: numberValue(row, 'created_at'),
    updatedAt: numberValue(row, 'updated_at'),
    revisionCreatedAt: numberValue(row, 'revision_created_at'),
  };
}

function planSummary(plan: Plan): PlanSummary {
  const {
    body: _body,
    revisionCreatedAt: _revisionCreatedAt,
    sourceEventId: _sourceEventId,
    ...summary
  } = plan;
  return summary;
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
  readonly harness: Harness;
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
    this.harness = options.harness ?? 'other';
    this.#clock = options.clock ?? Date.now;
    this.#recordSessionLifecycleEvents = options.recordSessionLifecycleEvents ?? true;
    const releaseWorkspaceLock = acquireWorkspaceOperationLock(this.repository, 2_500);
    try {
      this.workspace = resolveWorkspaceBinding(this.repository, {
        ...(options.workspaceRegistryRoot ? { registryRoot: options.workspaceRegistryRoot } : {}),
      });
      if (this.workspace) {
        assertWorkspaceBindingReady(this.repository, this.workspace);
        clearMatchingPendingWorkspaceJoin(this.repository, {
          workspaceId: this.workspace.workspace.id,
          memberName: this.workspace.worktreeName,
        });
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
            .run(this.agentName, this.harness, options.role ?? 'implementer', now, now);
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
              harness: this.harness,
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

  #plan(planId: string, revision?: number): Plan {
    const row = this.#database
      .prepare(
        `SELECT plan.*, revision.revision, revision.title, revision.body,
                revision.content_hash, revision.source_event_id,
                revision.created_at AS revision_created_at
         FROM plans plan
         JOIN plan_revisions revision
           ON revision.plan_id = plan.id
          AND revision.revision = COALESCE(?, plan.current_revision)
         WHERE plan.id = ?`,
      )
      .get(revision ?? null, planId) as Row | undefined;
    if (!row) {
      throw new SameTreeError(
        'NOT_FOUND',
        revision === undefined
          ? `Plan '${planId}' does not exist.`
          : `Plan '${planId}' has no revision ${revision}.`,
      );
    }
    return mapPlan(row);
  }

  #sharedInstruction(instructionId: string, revision?: number): SharedInstruction {
    const row = this.#database
      .prepare(
        `SELECT instruction.*, revision.revision, revision.action, revision.body,
                revision.content_hash, revision.recorded_by, revision.authorization_reason,
                revision.created_at AS revision_created_at, acknowledgement.acknowledged_at
         FROM shared_instructions instruction
         JOIN shared_instruction_revisions revision
           ON revision.instruction_id = instruction.id
          AND revision.revision = COALESCE(?, instruction.current_revision)
         LEFT JOIN shared_instruction_acks acknowledgement
           ON acknowledgement.instruction_id = revision.instruction_id
          AND acknowledgement.revision = revision.revision
          AND acknowledgement.agent_name = ?
         WHERE instruction.id = ?`,
      )
      .get(revision ?? null, this.agentName, instructionId) as Row | undefined;
    if (!row) {
      throw new SameTreeError(
        'NOT_FOUND',
        revision === undefined
          ? `Shared instruction '${instructionId}' does not exist.`
          : `Shared instruction '${instructionId}' has no revision ${revision}.`,
      );
    }
    return mapSharedInstruction(row);
  }

  #sharedInstructionRows(includeRevoked: boolean): Row[] {
    return this.#database
      .prepare(
        `SELECT instruction.*, revision.revision, revision.action, revision.body,
                revision.content_hash, revision.recorded_by, revision.authorization_reason,
                revision.created_at AS revision_created_at, acknowledgement.acknowledged_at
         FROM shared_instructions instruction
         JOIN shared_instruction_revisions revision
           ON revision.instruction_id = instruction.id
          AND revision.revision = instruction.current_revision
         LEFT JOIN shared_instruction_acks acknowledgement
           ON acknowledgement.instruction_id = instruction.id
          AND acknowledgement.revision = instruction.current_revision
          AND acknowledgement.agent_name = ?
         ${includeRevoked ? '' : "WHERE instruction.status = 'active'"}
         ORDER BY instruction.created_at DESC, instruction.id DESC`,
      )
      .all(this.agentName) as Row[];
  }

  #notifySharedInstruction(
    instructionId: string,
    revision: number,
    action: SharedInstructionAction,
    body: string | null,
    taskId: string | null,
    now: number,
  ): string[] {
    const recipients = this.#database
      .prepare('SELECT name FROM agents WHERE name <> ? ORDER BY name')
      .all(this.agentName) as Row[];
    const subject = `Shared user instruction ${action}: ${instructionId}`.slice(0, 200);
    const scope = taskId ? `Task scope: ${taskId}\n` : 'Scope: workspace\n';
    const notice = `[SameTree shared user instruction]\nInstruction: ${instructionId}\nRevision: ${revision}\nAction: ${action}\n${scope}Recorded by: ${this.agentName}\n\n${body ?? 'This instruction was revoked.'}\n\nThe recording agent asserts direct user authorization. This instruction does not create work or expand your assigned scope.`;
    for (const recipientRow of recipients) {
      const recipient = stringValue(recipientRow, 'name');
      const messageId = createId('message');
      this.#database
        .prepare(
          `INSERT INTO messages
            (id, sender, recipient, subject, body, thread_id, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          this.agentName,
          recipient,
          subject,
          notice,
          `instruction:${instructionId}`,
          taskId,
          now,
        );
      this.#database
        .prepare(
          `INSERT INTO shared_instruction_notifications
            (message_id, instruction_id, revision) VALUES (?, ?, ?)`,
        )
        .run(messageId, instructionId, revision);
      this.#recordEvent('message.sent', 'message', messageId, {
        instructionId,
        instructionRevision: revision,
        recipient,
        taskId,
      });
    }
    return recipients.map((row) => stringValue(row, 'name'));
  }

  #acknowledgeSharedInstructionForActor(
    instructionId: string,
    revision: number,
    now: number,
  ): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO shared_instruction_acks
          (instruction_id, revision, agent_name, acknowledged_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(instructionId, revision, this.agentName, now);
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

  #assertActiveSession(now: number): void {
    const active = this.#database
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND status = 'active' AND expires_at > ?")
      .get(this.sessionId, now);
    if (!active) {
      throw new SameTreeError('TASK_UNAVAILABLE', 'This session expired and cannot acquire work.');
    }
  }

  #transferClaims(
    claimIds: string[],
    fromAgent: string,
    now: number,
    conflictCode: 'HANDOFF_CONFLICT' | 'TASK_UNAVAILABLE' = 'HANDOFF_CONFLICT',
  ): PathClaim[] {
    this.#assertActiveSession(now);
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
           WHERE claim.id = ? AND claim.agent_name = ? AND claim.expires_at > ?
             AND worktree.available = 1`,
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
        `SELECT message.*, receipt.read_at ${MESSAGE_INSTRUCTION_COLUMNS}
         FROM messages message
         ${MESSAGE_INSTRUCTION_JOINS}
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
           AND (notice.message_id IS NULL OR notice.revision = instruction.current_revision)
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
        .prepare(
          `UPDATE path_claims SET expires_at = ?
           WHERE session_id = ? AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM worktrees
               WHERE worktrees.id = path_claims.worktree_id AND worktrees.available = 1
             )`,
        )
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
        title,
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

  publishPlan(input: PublishPlanInput): Plan {
    const body = requireText(input.body, 'Plan body', MAX_PLAN_BODY_CHARACTERS);
    const title = input.title ? requireText(input.title, 'Plan title', 200) : planTitle(body);
    const sourceSessionId = requireText(input.sourceSessionId, 'Source session ID', 200);
    const sourceEventId = requireText(input.sourceEventId, 'Source event ID', 200);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
      if (input.taskId) this.#task(input.taskId);
      const stored = this.#database
        .prepare(
          `SELECT * FROM plans
           WHERE source_harness = ? AND source_session_id = ?`,
        )
        .get(this.harness, sourceSessionId) as Row | undefined;
      const planId = stored ? stringValue(stored, 'id') : createId('plan');
      if (stored && input.taskId && nullableString(stored, 'task_id') !== input.taskId) {
        throw new SameTreeError(
          'PLAN_CONFLICT',
          `Plan '${planId}' is already associated with another task.`,
          { taskId: nullableString(stored, 'task_id') },
        );
      }

      if (stored) {
        const existing = this.#database
          .prepare(
            `SELECT revision, title, body, content_hash FROM plan_revisions
             WHERE plan_id = ? AND source_event_id = ?`,
          )
          .get(planId, sourceEventId) as Row | undefined;
        if (existing) {
          if (
            stringValue(existing, 'title') !== title ||
            stringValue(existing, 'body') !== body ||
            stringValue(existing, 'content_hash') !== contentHash
          ) {
            throw new SameTreeError(
              'PLAN_CONFLICT',
              `Source event '${sourceEventId}' was already published with different content.`,
              { planId, revision: numberValue(existing, 'revision') },
            );
          }
          return this.#plan(planId, numberValue(existing, 'revision'));
        }
      }

      const revision = stored ? numberValue(stored, 'current_revision') + 1 : 1;
      if (!stored) {
        this.#database
          .prepare(
            `INSERT INTO plans
              (id, author, task_id, source_harness, source_session_id,
               current_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            planId,
            this.agentName,
            input.taskId ?? null,
            this.harness,
            sourceSessionId,
            revision,
            now,
            now,
          );
      }
      this.#database
        .prepare(
          `INSERT INTO plan_revisions
            (plan_id, revision, title, body, content_hash, source_event_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(planId, revision, title, body, contentHash, sourceEventId, now);
      if (stored) {
        this.#database
          .prepare('UPDATE plans SET author = ?, current_revision = ?, updated_at = ? WHERE id = ?')
          .run(this.agentName, revision, now, planId);
      }

      const peers = this.#database
        .prepare(
          `SELECT DISTINCT agent_name FROM sessions
           WHERE agent_name <> ? AND status = 'active' AND expires_at > ?
           ORDER BY agent_name`,
        )
        .all(this.agentName, now) as Row[];
      const threadId = `plan:${planId}`;
      const subject = `Plan from ${this.agentName}: ${title}`.slice(0, 200);
      const notificationBody = `${this.agentName} published proposed plan ${planId} revision ${revision}. This is shared context, not authorization to change scope.\n\n${body}`;
      for (const peer of peers) {
        const recipient = stringValue(peer, 'agent_name');
        const messageId = createId('message');
        this.#database
          .prepare(
            `INSERT INTO messages
              (id, sender, recipient, subject, body, thread_id, task_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            messageId,
            this.agentName,
            recipient,
            subject,
            notificationBody,
            threadId,
            input.taskId ?? nullableString(stored ?? {}, 'task_id'),
            now,
          );
        this.#recordEvent('message.sent', 'message', messageId, {
          planId,
          planRevision: revision,
          recipient,
          taskId: input.taskId ?? nullableString(stored ?? {}, 'task_id'),
        });
      }
      this.#recordEvent(stored ? 'plan.revised' : 'plan.published', 'plan', planId, {
        contentHash,
        notifiedAgents: peers.map((peer) => stringValue(peer, 'agent_name')),
        revision,
        taskId: input.taskId ?? nullableString(stored ?? {}, 'task_id'),
        title,
      });
      return this.#plan(planId, revision);
    });
  }

  getPlan(planId: string, revision?: number): Plan {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new SameTreeError('INVALID_INPUT', 'Plan revision must be a positive integer.');
    }
    return this.#plan(planId, revision);
  }

  listPlans(options: ListPlansOptions = {}): PlanSummary[] {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Plan list limit must be between 1 and 100.');
    }
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    if (options.author) {
      conditions.push('plan.author = ?');
      parameters.push(validateAgentName(options.author));
    }
    if (options.taskId) {
      conditions.push('plan.task_id = ?');
      parameters.push(options.taskId);
    }
    if (options.after) {
      const cursor = this.#database
        .prepare('SELECT created_at, id FROM plans WHERE id = ?')
        .get(options.after) as Row | undefined;
      if (!cursor) {
        throw new SameTreeError('NOT_FOUND', `Plan cursor '${options.after}' does not exist.`);
      }
      conditions.push('(plan.created_at < ? OR (plan.created_at = ? AND plan.id < ?))');
      parameters.push(
        numberValue(cursor, 'created_at'),
        numberValue(cursor, 'created_at'),
        stringValue(cursor, 'id'),
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    parameters.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT plan.*, revision.revision, revision.title, revision.body,
                revision.content_hash, revision.source_event_id,
                revision.created_at AS revision_created_at
         FROM plans plan
         JOIN plan_revisions revision
           ON revision.plan_id = plan.id AND revision.revision = plan.current_revision
         ${where}
          ORDER BY plan.created_at DESC, plan.id DESC
         LIMIT ?`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) => planSummary(mapPlan(row)));
  }

  recordSharedInstruction(input: RecordSharedInstructionInput): SharedInstruction {
    assertUserAuthorized(input.userAuthorized, 'Recording a shared instruction');
    const body = requireExactInstructionText(input.body);
    const reason = requireText(input.reason, 'Authorization reason', 2_000);
    if ((input.sourceSessionId === undefined) !== (input.sourceEventId === undefined)) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Provide both sourceSessionId and sourceEventId, or neither.',
      );
    }
    const sourceSessionId = input.sourceSessionId
      ? requireText(input.sourceSessionId, 'Source session ID', 200)
      : this.sessionId;
    const sourceEventId = input.sourceEventId
      ? requireText(input.sourceEventId, 'Source event ID', 200)
      : createId('instruction-event');
    const contentHash = createHash('sha256').update(body).digest('hex');
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
      if (input.taskId) this.#task(input.taskId);
      const stored = this.#database
        .prepare(
          `SELECT * FROM shared_instructions
           WHERE source_harness = ? AND source_session_id = ? AND source_event_id = ?`,
        )
        .get(this.harness, sourceSessionId, sourceEventId) as Row | undefined;
      if (stored) {
        const original = this.#database
          .prepare(
            `SELECT body, content_hash FROM shared_instruction_revisions
             WHERE instruction_id = ? AND revision = 1`,
          )
          .get(stringValue(stored, 'id')) as Row;
        if (
          stringValue(original, 'body') !== body ||
          stringValue(original, 'content_hash') !== contentHash ||
          nullableString(stored, 'task_id') !== (input.taskId ?? null)
        ) {
          throw new SameTreeError(
            'INSTRUCTION_CONFLICT',
            `Source event '${sourceEventId}' was already recorded differently.`,
            { instructionId: stringValue(stored, 'id') },
          );
        }
        return this.#sharedInstruction(stringValue(stored, 'id'));
      }

      const instructionId = createId('instruction');
      this.#database
        .prepare(
          `INSERT INTO shared_instructions
            (id, created_by, task_id, source_harness, source_session_id, source_event_id,
             current_revision, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
        )
        .run(
          instructionId,
          this.agentName,
          input.taskId ?? null,
          this.harness,
          sourceSessionId,
          sourceEventId,
          now,
          now,
        );
      this.#database
        .prepare(
          `INSERT INTO shared_instruction_revisions
            (instruction_id, revision, action, body, content_hash, recorded_by,
             authorization_reason, created_at)
           VALUES (?, 1, 'recorded', ?, ?, ?, ?, ?)`,
        )
        .run(instructionId, body, contentHash, this.agentName, reason, now);
      this.#acknowledgeSharedInstructionForActor(instructionId, 1, now);
      const notifiedAgents = this.#notifySharedInstruction(
        instructionId,
        1,
        'recorded',
        body,
        input.taskId ?? null,
        now,
      );
      this.#recordEvent('instruction.recorded', 'instruction', instructionId, {
        contentHash,
        notifiedAgents,
        revision: 1,
        taskId: input.taskId ?? null,
        userAuthorized: true,
      });
      return this.#sharedInstruction(instructionId);
    });
  }

  reviseSharedInstruction(
    instructionId: string,
    input: ReviseSharedInstructionInput,
  ): SharedInstruction {
    assertUserAuthorized(input.userAuthorized, 'Revising a shared instruction');
    const body = requireExactInstructionText(input.body);
    const reason = requireText(input.reason, 'Authorization reason', 2_000);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new SameTreeError('INVALID_INPUT', 'Expected revision must be a positive integer.');
    }
    const contentHash = createHash('sha256').update(body).digest('hex');
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
      const current = this.#sharedInstruction(instructionId);
      if (current.status === 'revoked') {
        throw new SameTreeError(
          'INSTRUCTION_CONFLICT',
          `Shared instruction '${instructionId}' is revoked.`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new SameTreeError(
          'INSTRUCTION_CONFLICT',
          `Shared instruction '${instructionId}' changed from revision ${input.expectedRevision} to ${current.revision}.`,
          { currentRevision: current.revision },
        );
      }
      const revision = current.revision + 1;
      this.#database
        .prepare(
          `INSERT INTO shared_instruction_revisions
            (instruction_id, revision, action, body, content_hash, recorded_by,
             authorization_reason, created_at)
           VALUES (?, ?, 'revised', ?, ?, ?, ?, ?)`,
        )
        .run(instructionId, revision, body, contentHash, this.agentName, reason, now);
      this.#database
        .prepare(
          `UPDATE shared_instructions
           SET current_revision = ?, updated_at = ? WHERE id = ?`,
        )
        .run(revision, now, instructionId);
      this.#acknowledgeSharedInstructionForActor(instructionId, revision, now);
      const notifiedAgents = this.#notifySharedInstruction(
        instructionId,
        revision,
        'revised',
        body,
        current.taskId,
        now,
      );
      this.#recordEvent('instruction.revised', 'instruction', instructionId, {
        contentHash,
        notifiedAgents,
        previousRevision: current.revision,
        revision,
        taskId: current.taskId,
        userAuthorized: true,
      });
      return this.#sharedInstruction(instructionId);
    });
  }

  revokeSharedInstruction(
    instructionId: string,
    input: RevokeSharedInstructionInput,
  ): SharedInstruction {
    assertUserAuthorized(input.userAuthorized, 'Revoking a shared instruction');
    const reason = requireText(input.reason, 'Authorization reason', 2_000);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new SameTreeError('INVALID_INPUT', 'Expected revision must be a positive integer.');
    }
    const now = this.#clock();

    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
      const current = this.#sharedInstruction(instructionId);
      if (current.status === 'revoked') {
        throw new SameTreeError(
          'INSTRUCTION_CONFLICT',
          `Shared instruction '${instructionId}' is already revoked.`,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new SameTreeError(
          'INSTRUCTION_CONFLICT',
          `Shared instruction '${instructionId}' changed from revision ${input.expectedRevision} to ${current.revision}.`,
          { currentRevision: current.revision },
        );
      }
      const revision = current.revision + 1;
      this.#database
        .prepare(
          `INSERT INTO shared_instruction_revisions
            (instruction_id, revision, action, body, content_hash, recorded_by,
             authorization_reason, created_at)
           VALUES (?, ?, 'revoked', NULL, NULL, ?, ?, ?)`,
        )
        .run(instructionId, revision, this.agentName, reason, now);
      this.#database
        .prepare(
          `UPDATE shared_instructions
           SET current_revision = ?, status = 'revoked', updated_at = ? WHERE id = ?`,
        )
        .run(revision, now, instructionId);
      this.#acknowledgeSharedInstructionForActor(instructionId, revision, now);
      const notifiedAgents = this.#notifySharedInstruction(
        instructionId,
        revision,
        'revoked',
        null,
        current.taskId,
        now,
      );
      this.#recordEvent('instruction.revoked', 'instruction', instructionId, {
        notifiedAgents,
        previousRevision: current.revision,
        revision,
        taskId: current.taskId,
        userAuthorized: true,
      });
      return this.#sharedInstruction(instructionId);
    });
  }

  getSharedInstruction(instructionId: string, revision?: number): SharedInstruction {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new SameTreeError('INVALID_INPUT', 'Instruction revision must be a positive integer.');
    }
    return this.#sharedInstruction(instructionId, revision);
  }

  listSharedInstructions(options: ListSharedInstructionsOptions = {}): SharedInstructionSummary[] {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SameTreeError('INVALID_INPUT', 'Instruction list limit must be between 1 and 100.');
    }
    const conditions = options.includeRevoked ? [] : ["instruction.status = 'active'"];
    const parameters: Array<number | string> = [this.agentName];
    if (options.taskId) {
      conditions.push('instruction.task_id = ?');
      parameters.push(options.taskId);
    }
    if (options.after) {
      const cursor = this.#database
        .prepare('SELECT created_at, id FROM shared_instructions WHERE id = ?')
        .get(options.after) as Row | undefined;
      if (!cursor) {
        throw new SameTreeError(
          'NOT_FOUND',
          `Shared instruction cursor '${options.after}' does not exist.`,
        );
      }
      conditions.push(
        '(instruction.created_at < ? OR (instruction.created_at = ? AND instruction.id < ?))',
      );
      parameters.push(
        numberValue(cursor, 'created_at'),
        numberValue(cursor, 'created_at'),
        stringValue(cursor, 'id'),
      );
    }
    parameters.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#database
      .prepare(
        `SELECT instruction.*, revision.revision, revision.action, revision.body,
                revision.content_hash, revision.recorded_by, revision.authorization_reason,
                revision.created_at AS revision_created_at, acknowledgement.acknowledged_at
         FROM shared_instructions instruction
         JOIN shared_instruction_revisions revision
           ON revision.instruction_id = instruction.id
          AND revision.revision = instruction.current_revision
         LEFT JOIN shared_instruction_acks acknowledgement
           ON acknowledgement.instruction_id = instruction.id
          AND acknowledgement.revision = instruction.current_revision
          AND acknowledgement.agent_name = ?
         ${where}
         ORDER BY instruction.created_at DESC, instruction.id DESC
         LIMIT ?`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) => sharedInstructionSummary(mapSharedInstruction(row)));
  }

  acknowledgeSharedInstruction(
    instructionId: string,
    revision: number,
  ): SharedInstructionAcknowledgement {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new SameTreeError('INVALID_INPUT', 'Instruction revision must be a positive integer.');
    }
    return immediateTransaction(this.#database, () => {
      const current = this.#sharedInstruction(instructionId);
      if (current.revision !== revision) {
        throw new SameTreeError(
          'INSTRUCTION_CONFLICT',
          `Shared instruction '${instructionId}' is now revision ${current.revision}.`,
          { currentRevision: current.revision },
        );
      }
      const acknowledgedAt = this.#clock();
      const newlyAcknowledged =
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO shared_instruction_acks
              (instruction_id, revision, agent_name, acknowledged_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(instructionId, revision, this.agentName, acknowledgedAt).changes === 1;
      this.#database
        .prepare(
          `INSERT INTO message_receipts (message_id, agent_name, read_at)
           SELECT notice.message_id, ?, ?
           FROM shared_instruction_notifications notice
           JOIN messages message ON message.id = notice.message_id
           WHERE notice.instruction_id = ? AND notice.revision = ? AND message.recipient = ?
           ON CONFLICT(message_id, agent_name) DO UPDATE SET read_at = excluded.read_at`,
        )
        .run(this.agentName, acknowledgedAt, instructionId, revision, this.agentName);
      if (newlyAcknowledged) {
        this.#recordEvent('instruction.acknowledged', 'instruction', instructionId, {
          action: current.action,
          revision,
        });
      }
      const stored = this.#database
        .prepare(
          `SELECT acknowledged_at FROM shared_instruction_acks
           WHERE instruction_id = ? AND revision = ? AND agent_name = ?`,
        )
        .get(instructionId, revision, this.agentName) as Row;
      return {
        instructionId,
        revision,
        acknowledgedAt: numberValue(stored, 'acknowledged_at'),
        newlyAcknowledged,
      };
    });
  }

  claimTask(taskId: string, authorization: UserAuthorizedTaskInput = {}): Task {
    const now = this.#clock();
    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
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
        title: task.title,
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
      this.#assertActiveSession(now);
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
        title: task.title,
        userAuthorized: true,
      });
      return { task: this.#task(taskId), claims };
    });
  }

  updateTask(taskId: string, input: UpdateTaskInput): Task {
    const now = this.#clock();
    return immediateTransaction(this.#database, () => {
      this.#assertActiveSession(now);
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
          active ? now + this.config.taskLeaseSeconds * 1_000 : null,
          now,
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
        title: task.title,
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
      this.#assertActiveSession(now);
      const availableWorktree = this.#database.prepare(
        'SELECT 1 FROM worktrees WHERE id = ? AND available = 1',
      );
      for (const claim of unique) {
        if (!availableWorktree.get(claim.worktreeId)) {
          throw new SameTreeError(
            'WORKSPACE_ERROR',
            `Workspace member '${claim.member}' is unavailable.`,
          );
        }
      }
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
        instruction: null,
      };
    });
  }

  inbox(options: { unreadOnly?: boolean; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const unread = options.unreadOnly
      ? 'AND receipt.read_at IS NULL AND (notice.message_id IS NULL OR notice.revision = instruction.current_revision)'
      : '';
    return (
      this.#database
        .prepare(
          `SELECT message.*, receipt.read_at ${MESSAGE_INSTRUCTION_COLUMNS}
           FROM messages message
           ${MESSAGE_INSTRUCTION_JOINS}
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
          `SELECT message.*, receipt.read_at ${MESSAGE_INSTRUCTION_COLUMNS}
           FROM messages message
           ${MESSAGE_INSTRUCTION_JOINS}
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
        this.#assertActiveSession(now);
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
           ${MESSAGE_INSTRUCTION_JOINS}
           LEFT JOIN message_receipts receipt
             ON receipt.message_id = message.id AND receipt.agent_name = ?
           WHERE (message.recipient = ? OR EXISTS (
             SELECT 1 FROM broadcast_recipients recipient
             WHERE recipient.message_id = message.id AND recipient.agent_name = ?
            )) AND receipt.read_at IS NULL
              AND (notice.message_id IS NULL OR notice.revision = instruction.current_revision)`,
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
      const instructions = this.#sharedInstructionRows(
        options.includeRevokedInstructions ?? false,
      ).map((row) => sharedInstructionSummary(mapSharedInstruction(row)));

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
        plans: this.listPlans(),
        instructions,
        claims,
        unreadMessages: numberValue(unread, 'count'),
        unacknowledgedInstructions: instructions.filter(
          (instruction) => instruction.acknowledgedAt === null,
        ).length,
        pendingHandoffs: numberValue(handoffs, 'count'),
        warnings: [...branchWarnings, ...claimWarnings],
        lastEventSequence: nullableNumber(lastEvent, 'sequence') ?? 0,
      };
    })();
  }

  doctor(): DoctorReport {
    return inspectDatabase(
      this.#database,
      this.repository,
      this.workspace?.workspace.databasePath ?? this.repository.databasePath,
    );
  }
}
