import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

import Database, { type Database as DatabaseType } from 'better-sqlite3';

import {
  assertDatabasePathSafe,
  type DatabaseMemberContext,
  immediateTransaction,
  openDatabase,
} from './database.js';
import { SameTreeError } from './errors.js';
import { type RepositoryContext, resolveRepository } from './git.js';
import {
  acquireRegisteredWorkspaceOperationLock,
  acquireRepositoryOperationLock,
  acquireRepositoryOperationLockAt,
  acquireWorkspaceOperationLock,
  acquireWorkspaceOperationLockAt,
  bindWorktree,
  clearMatchingPendingWorkspaceJoin,
  clearPendingWorkspaceCreation,
  clearPendingWorkspaceJoin,
  clearRepositoryWorkspaceBinding,
  clearRepositoryWorkspaceBindingAt,
  clearWorktreeWorkspaceBinding,
  findRegisteredWorkspace,
  type RegisteredWorkspace,
  readPendingWorkspaceCreation,
  readPendingWorkspaceJoin,
  readRegisteredWorkspace,
  registerWorkspace,
  removeRegisteredWorkspace,
  resolveRepositoryWorkspaceBinding,
  resolveWorkspaceBinding,
  validateWorkspaceName,
  type WorkspaceContext,
  type WorkspaceRegistryOptions,
  writePendingWorkspaceCreation,
  writePendingWorkspaceJoin,
} from './workspace.js';

type Row = Record<string, unknown>;

const WORKSPACE_SOURCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_sources (
    worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
    source_database_path TEXT NOT NULL UNIQUE,
    source_workspace_id TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('fresh', 'import-current')),
    recorded_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS event_import_sources (
    event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    source_workspace_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL
  ) STRICT;
`;

export type WorkspaceJoinMode = 'fresh' | 'import-current';

export interface WorkspaceServiceOptions extends WorkspaceRegistryOptions {
  now?: number;
}

export interface CreateWorkspaceInput {
  name: string;
  memberName: string;
  mode: WorkspaceJoinMode;
}

export interface AddWorkspaceMemberInput {
  workspaceId: string;
  memberName: string;
  mode: WorkspaceJoinMode;
}

export interface WorkspaceMember {
  id: string;
  name: string;
  repositoryId: string;
  repositoryName: string;
  commonGitDirectory: string;
  root: string;
  privateGitDirectory: string;
  headDescriptor: string;
  available: boolean;
}

export interface WorkspaceJoinResult {
  workspace: RegisteredWorkspace;
  member: WorkspaceMember;
  mode: WorkspaceJoinMode;
  imported: boolean;
  sourceDatabasePath: string;
}

export interface WorkspaceStatus {
  bound: boolean;
  standaloneDatabasePath: string;
  workspace: RegisteredWorkspace | null;
  member: WorkspaceMember | null;
  members: WorkspaceMember[];
}

export interface WorkspacePruneResult {
  pruned: WorkspaceMember[];
}

export interface WorkspaceCreationCancellation {
  cancelled: boolean;
  workspaceId: string;
}

export interface WorkspaceDoctorReport {
  ok: boolean;
  workspace: RegisteredWorkspace;
  databasePath: string;
  integrity: string;
  foreignKeyViolations: number;
  members: WorkspaceMember[];
  warnings: string[];
}

interface SourceIdentity {
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
}

interface RecordedMember {
  member: DatabaseMemberContext;
  sourceRecorded: boolean;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function assertJoinMode(mode: unknown): asserts mode is WorkspaceJoinMode {
  if (mode !== 'fresh' && mode !== 'import-current') {
    throw new SameTreeError('INVALID_INPUT', "Workspace mode must be 'fresh' or 'import-current'.");
  }
}

function tableExists(database: DatabaseType, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
  );
}

function openExistingDatabase(
  databasePath: string,
  options: { fileMustExist?: boolean; readonly?: boolean } = {},
): DatabaseType {
  assertDatabasePathSafe(databasePath);
  return new Database(databasePath, options);
}

function rows(database: DatabaseType, table: string): Row[] {
  return database.prepare(`SELECT * FROM ${table}`).all() as Row[];
}

function insertRows(database: DatabaseType, table: string, columns: string[], values: Row[]): void {
  if (values.length === 0) return;
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  for (const row of values) statement.run(...columns.map((column) => row[column] ?? null));
}

function readMember(database: DatabaseType, worktreeId: string): WorkspaceMember {
  const row = database
    .prepare(
      `SELECT worktree.id, worktree.name, worktree.root, worktree.private_git_directory,
              worktree.head_descriptor, worktree.available,
              repository.id AS repository_id, repository.name AS repository_name,
              repository.common_git_directory
       FROM worktrees worktree
       JOIN repositories repository ON repository.id = worktree.repository_id
       WHERE worktree.id = ?`,
    )
    .get(worktreeId) as
    | {
        available: number;
        common_git_directory: string;
        head_descriptor: string;
        id: string;
        name: string;
        private_git_directory: string;
        repository_id: string;
        repository_name: string;
        root: string;
      }
    | undefined;
  if (!row)
    throw new SameTreeError('WORKSPACE_ERROR', `Workspace member '${worktreeId}' was not found.`);
  return {
    id: row.id,
    name: row.name,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    commonGitDirectory: row.common_git_directory,
    root: row.root,
    privateGitDirectory: row.private_git_directory,
    headDescriptor: row.head_descriptor,
    available: row.available === 1,
  };
}

function listMembers(database: DatabaseType): WorkspaceMember[] {
  return (
    database.prepare('SELECT id FROM worktrees ORDER BY name, id').all() as { id: string }[]
  ).map((row) => readMember(database, row.id));
}

function recordWorkspaceEvent(
  database: DatabaseType,
  kind: string,
  worktreeId: string,
  payload: Record<string, unknown>,
  now: number,
): void {
  database
    .prepare(
      `INSERT INTO events
        (id, kind, actor, entity_type, entity_id, payload_json, created_at, worktree_id)
       VALUES (?, ?, 'workspace', 'worktree', ?, ?, ?, ?)`,
    )
    .run(createId('event'), kind, worktreeId, JSON.stringify(payload), now, worktreeId);
}

function retireMember(
  database: DatabaseType,
  member: WorkspaceMember,
  kind: 'worktree.left' | 'worktree.pruned',
  now: number,
): void {
  database
    .prepare('UPDATE worktrees SET available = 0, updated_at = ? WHERE id = ?')
    .run(now, member.id);
  database
    .prepare(
      `UPDATE sessions SET status = 'closed', expires_at = ?
       WHERE home_worktree_id = ? AND status = 'active'`,
    )
    .run(now, member.id);
  recordWorkspaceEvent(database, kind, member.id, { member: member.name }, now);
}

function pathIsDefinitelyMissing(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw error;
  }
}

function memberIsDefinitelyStale(member: WorkspaceMember): boolean {
  try {
    if (
      pathIsDefinitelyMissing(member.root) ||
      pathIsDefinitelyMissing(member.privateGitDirectory)
    ) {
      return true;
    }
    const resolved = resolveRepository(member.root);
    return (
      resolved.privateGitDirectory !== member.privateGitDirectory ||
      resolved.commonGitDirectory !== member.commonGitDirectory
    );
  } catch (error) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      `Could not safely inspect workspace member '${member.name}'.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export function assertWorkspaceBindingReady(
  repository: RepositoryContext,
  binding: WorkspaceContext,
): void {
  if (!binding.repositoryBindingPresent) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Worktree binding has no repository binding.');
  }
  if (!existsSync(binding.workspace.databasePath)) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Bound workspace database is missing.', {
      databasePath: binding.workspace.databasePath,
    });
  }
  const database = openExistingDatabase(binding.workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (!tableExists(database, 'workspace_sources')) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Workspace binding has no recorded state transition.',
      );
    }
    const metadata = database.prepare('SELECT id FROM workspace_metadata').get() as
      | { id: string }
      | undefined;
    const member = database
      .prepare(
        `SELECT worktree.name, repository.name AS repository_name
         FROM worktrees worktree
         JOIN repositories repository ON repository.id = worktree.repository_id
         JOIN workspace_sources source ON source.worktree_id = worktree.id
         WHERE worktree.id = ? AND worktree.repository_id = ?
           AND worktree.available = 1
           AND worktree.private_git_directory = ?
           AND source.source_database_path = ?`,
      )
      .get(
        binding.worktreeId,
        binding.repositoryId,
        repository.privateGitDirectory,
        repository.databasePath,
      ) as { name: string; repository_name: string } | undefined;
    if (
      metadata?.id !== binding.workspace.id ||
      !member ||
      member.name !== binding.worktreeName ||
      member.repository_name !== binding.repositoryName
    ) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Workspace binding does not match its registered database member.',
      );
    }
  } finally {
    database.close();
  }
}

function assertNoActiveSessions(database: DatabaseType, now: number, sourcePath: string): void {
  if (!tableExists(database, 'sessions')) return;
  const active = database
    .prepare(
      `SELECT COUNT(*) AS count FROM sessions
       WHERE status = 'active' AND expires_at > ?`,
    )
    .get(now) as { count: number };
  if (active.count > 0) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'Stop active standalone sessions before joining a workspace.',
      { activeSessions: active.count, sourceDatabasePath: sourcePath },
    );
  }
}

function inspectStandaloneSessions(repository: RepositoryContext, now: number): void {
  if (!existsSync(repository.databasePath)) return;
  const database = openExistingDatabase(repository.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assertNoActiveSessions(database, now, repository.databasePath);
  } finally {
    database.close();
  }
}

function sourceIdentity(database: DatabaseType, repository: RepositoryContext): SourceIdentity {
  const metadata = database.prepare('SELECT id FROM workspace_metadata').get() as
    | { id: string }
    | undefined;
  const member = database
    .prepare(
      `SELECT worktree.id AS worktree_id, repository.id AS repository_id
       FROM worktrees worktree
       JOIN repositories repository ON repository.id = worktree.repository_id
       WHERE worktree.private_git_directory = ?`,
    )
    .get(repository.privateGitDirectory) as
    | { repository_id: string; worktree_id: string }
    | undefined;
  if (!metadata || !member) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Standalone workspace identity is incomplete.');
  }
  return {
    workspaceId: metadata.id,
    repositoryId: member.repository_id,
    worktreeId: member.worktree_id,
  };
}

function assertNoEntityCollisions(source: DatabaseType, target: DatabaseType): void {
  const identities: [string, string][] = [
    ['agents', 'name'],
    ['sessions', 'id'],
    ['tasks', 'id'],
    ['plans', 'id'],
    ['path_claims', 'id'],
    ['messages', 'id'],
    ['handoffs', 'id'],
    ['events', 'id'],
  ];
  for (const [table, key] of identities) {
    const lookup = target.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`);
    for (const row of rows(source, table)) {
      if (lookup.get(row[key])) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          `Cannot import ${table}: identity '${String(row[key])}' already exists.`,
          { identity: row[key], table },
        );
      }
    }
  }
  const planLookup = target.prepare(
    `SELECT id FROM plans
     WHERE source_harness = ? AND source_session_id = ?`,
  );
  for (const plan of rows(source, 'plans')) {
    const sourceHarness = String(plan.source_harness);
    const sourceSessionId = String(plan.source_session_id);
    const collision = planLookup.get(sourceHarness, sourceSessionId) as { id: string } | undefined;
    if (collision) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        `Cannot import plans: source identity '${sourceHarness}:${sourceSessionId}' already exists.`,
        {
          existingPlanId: collision.id,
          sourceHarness,
          sourceSessionId,
        },
      );
    }
  }
}

function copyStandaloneState(
  source: DatabaseType,
  target: DatabaseType,
  identity: SourceIdentity,
  member: DatabaseMemberContext,
  now: number,
): boolean {
  target.exec(WORKSPACE_SOURCE_SCHEMA);
  const recorded = target
    .prepare(
      `SELECT worktree_id, mode FROM workspace_sources
       WHERE source_database_path = ? OR source_workspace_id = ?`,
    )
    .get(source.name, identity.workspaceId) as { mode: string; worktree_id: string } | undefined;
  if (recorded) {
    if (recorded.worktree_id !== member.worktreeId || recorded.mode !== 'import-current') {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Standalone state was already joined differently.',
        {
          recorded,
        },
      );
    }
    return false;
  }

  immediateTransaction(target, () => {
    assertNoEntityCollisions(source, target);
    insertRows(
      target,
      'agents',
      ['name', 'harness', 'role', 'created_at', 'last_seen_at'],
      rows(source, 'agents'),
    );
    insertRows(
      target,
      'sessions',
      [
        'id',
        'agent_name',
        'home_worktree_id',
        'started_head_descriptor',
        'started_branch',
        'process_id',
        'started_at',
        'last_heartbeat_at',
        'expires_at',
        'status',
      ],
      rows(source, 'sessions').map((row) => ({ ...row, home_worktree_id: member.worktreeId })),
    );
    insertRows(
      target,
      'tasks',
      [
        'id',
        'title',
        'description',
        'status',
        'priority',
        'assignee',
        'claimed_by_session',
        'lease_expires_at',
        'revision',
        'created_at',
        'updated_at',
      ],
      rows(source, 'tasks'),
    );
    insertRows(
      target,
      'task_dependencies',
      ['task_id', 'depends_on'],
      rows(source, 'task_dependencies'),
    );
    insertRows(
      target,
      'plans',
      [
        'id',
        'author',
        'task_id',
        'source_harness',
        'source_session_id',
        'current_revision',
        'created_at',
        'updated_at',
      ],
      rows(source, 'plans'),
    );
    insertRows(
      target,
      'plan_revisions',
      ['plan_id', 'revision', 'title', 'body', 'content_hash', 'source_event_id', 'created_at'],
      rows(source, 'plan_revisions'),
    );
    insertRows(
      target,
      'path_claims',
      [
        'id',
        'path',
        'comparison_path',
        'kind',
        'agent_name',
        'session_id',
        'expires_at',
        'created_at',
        'worktree_id',
      ],
      rows(source, 'path_claims').map((row) => ({ ...row, worktree_id: member.worktreeId })),
    );
    insertRows(
      target,
      'messages',
      ['id', 'sender', 'recipient', 'subject', 'body', 'thread_id', 'task_id', 'created_at'],
      rows(source, 'messages'),
    );
    insertRows(
      target,
      'message_receipts',
      ['message_id', 'agent_name', 'read_at'],
      rows(source, 'message_receipts'),
    );
    insertRows(
      target,
      'broadcast_recipients',
      ['message_id', 'agent_name'],
      rows(source, 'broadcast_recipients'),
    );
    insertRows(
      target,
      'message_deliveries',
      ['message_id', 'agent_name', 'reserved_by_session', 'reserved_at', 'delivered_at'],
      rows(source, 'message_deliveries'),
    );
    insertRows(
      target,
      'handoffs',
      [
        'id',
        'task_id',
        'from_agent',
        'to_agent',
        'summary',
        'context_json',
        'task_revision',
        'status',
        'created_at',
        'expires_at',
        'responded_at',
      ],
      rows(source, 'handoffs'),
    );
    insertRows(
      target,
      'policy_acks',
      ['policy_hash', 'agent_name', 'worktree_id', 'acknowledged_at'],
      rows(source, 'policy_acks').map((row) => ({ ...row, worktree_id: member.worktreeId })),
    );

    const sourceEvents = rows(source, 'events');
    insertRows(
      target,
      'events',
      [
        'id',
        'kind',
        'actor',
        'entity_type',
        'entity_id',
        'payload_json',
        'created_at',
        'worktree_id',
      ],
      sourceEvents.map((row) => ({ ...row, worktree_id: member.worktreeId })),
    );
    insertRows(
      target,
      'event_import_sources',
      ['event_id', 'source_workspace_id', 'source_sequence'],
      sourceEvents.map((row) => ({
        event_id: row.id,
        source_workspace_id: identity.workspaceId,
        source_sequence: row.sequence,
      })),
    );
    insertRows(
      target,
      'task_worktrees',
      ['task_id', 'worktree_id'],
      rows(source, 'task_worktrees').map((row) => ({
        task_id: row.task_id,
        worktree_id: member.worktreeId,
      })),
    );
    target
      .prepare(
        `INSERT INTO workspace_sources
          (worktree_id, source_database_path, source_workspace_id, mode, recorded_at)
         VALUES (?, ?, ?, 'import-current', ?)`,
      )
      .run(member.worktreeId, source.name, identity.workspaceId, now);
  });
  return true;
}

function recordFreshSource(
  target: DatabaseType,
  member: DatabaseMemberContext,
  sourceDatabasePath: string,
  now: number,
): void {
  target.exec(WORKSPACE_SOURCE_SCHEMA);
  target
    .prepare(
      `INSERT INTO workspace_sources
        (worktree_id, source_database_path, source_workspace_id, mode, recorded_at)
       VALUES (?, ?, NULL, 'fresh', ?)
       ON CONFLICT(worktree_id) DO NOTHING`,
    )
    .run(member.worktreeId, sourceDatabasePath, now);
}

function databaseMember(
  workspace: RegisteredWorkspace,
  repository: RepositoryContext,
  memberName: string,
  mode: WorkspaceJoinMode,
  source: SourceIdentity | null,
): DatabaseMemberContext {
  const repositoryBinding = resolveRepositoryWorkspaceBinding(repository);
  if (repositoryBinding && repositoryBinding.workspaceId !== workspace.id) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'Repository is already assigned to another workspace.',
      {
        assignedWorkspaceId: repositoryBinding.workspaceId,
      },
    );
  }
  let registeredRepository: { id: string; name: string } | undefined;
  if (!repositoryBinding && existsSync(workspace.databasePath)) {
    const database = openExistingDatabase(workspace.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      registeredRepository = database
        .prepare('SELECT id, name FROM repositories WHERE common_git_directory = ?')
        .get(repository.commonGitDirectory) as { id: string; name: string } | undefined;
    } finally {
      database.close();
    }
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceImplicit: false,
    repositoryId:
      repositoryBinding?.repositoryId ??
      registeredRepository?.id ??
      (mode === 'import-current' && source ? source.repositoryId : createId('repository')),
    repositoryName: repositoryBinding?.repositoryName ?? registeredRepository?.name ?? memberName,
    worktreeId: mode === 'import-current' && source ? source.worktreeId : createId('worktree'),
    worktreeName: memberName,
  };
}

function recordedMember(
  workspace: RegisteredWorkspace,
  repository: RepositoryContext,
  memberName: string,
  sourceDatabasePath: string,
  mode: WorkspaceJoinMode,
): RecordedMember | null {
  if (!existsSync(workspace.databasePath)) return null;
  const database = openExistingDatabase(workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const hasSources = tableExists(database, 'workspace_sources');
    const source = hasSources
      ? (database
          .prepare(
            `SELECT worktree_id FROM workspace_sources
             WHERE source_database_path = ? AND mode = ?`,
          )
          .get(sourceDatabasePath, mode) as { worktree_id: string } | undefined)
      : undefined;
    const worktreeId =
      source?.worktree_id ??
      (
        database
          .prepare(
            `SELECT worktree.id FROM worktrees worktree
           JOIN repositories repository ON repository.id = worktree.repository_id
            WHERE worktree.name = ? AND worktree.private_git_directory = ?
              AND repository.common_git_directory = ?
             ${hasSources ? 'AND NOT EXISTS (SELECT 1 FROM workspace_sources source WHERE source.worktree_id = worktree.id)' : ''}`,
          )
          .get(memberName, repository.privateGitDirectory, repository.commonGitDirectory) as
          | { id: string }
          | undefined
      )?.id;
    if (!worktreeId) return null;
    const stored = readMember(database, worktreeId);
    return {
      member: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceImplicit: false,
        repositoryId: stored.repositoryId,
        repositoryName: stored.repositoryName,
        worktreeId: stored.id,
        worktreeName: stored.name,
      },
      sourceRecorded: source !== undefined,
    };
  } finally {
    database.close();
  }
}

function assertMemberAvailable(
  workspace: RegisteredWorkspace,
  repository: RepositoryContext,
  member: DatabaseMemberContext,
): void {
  if (!existsSync(workspace.databasePath)) return;
  const database = openExistingDatabase(workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const metadata = database.prepare('SELECT id FROM workspace_metadata').get() as
      | { id: string }
      | undefined;
    if (metadata?.id !== workspace.id) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Registered database has another workspace identity.',
      );
    }
    const storedRepository = database
      .prepare('SELECT common_git_directory FROM repositories WHERE id = ?')
      .get(member.repositoryId) as { common_git_directory: string } | undefined;
    if (
      storedRepository &&
      storedRepository.common_git_directory !== repository.commonGitDirectory
    ) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        `Repository identity '${member.repositoryId}' already exists.`,
      );
    }
    const repositoryPathOwner = database
      .prepare('SELECT id FROM repositories WHERE common_git_directory = ?')
      .get(repository.commonGitDirectory) as { id: string } | undefined;
    if (repositoryPathOwner && repositoryPathOwner.id !== member.repositoryId) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Repository path already has another identity.');
    }
    for (const [column, value] of [
      ['id', member.worktreeId],
      ['name', member.worktreeName],
      ['root', repository.root],
      ['private_git_directory', repository.privateGitDirectory],
    ] as const) {
      const collision = database
        .prepare(`SELECT id FROM worktrees WHERE ${column} = ?`)
        .get(value) as { id: string } | undefined;
      if (collision) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          `Worktree ${column} '${value}' already belongs to '${collision.id}'.`,
        );
      }
    }
  } finally {
    database.close();
  }
}

function existingJoin(
  repository: RepositoryContext,
  workspace: RegisteredWorkspace,
  memberName: string,
  mode: WorkspaceJoinMode,
  options: WorkspaceServiceOptions,
): WorkspaceJoinResult | null {
  const binding = resolveWorkspaceBinding(repository, options);
  if (!binding) return null;
  if (binding.workspace.id !== workspace.id) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'This worktree already belongs to another workspace.',
      {
        assignedWorkspaceId: binding.workspace.id,
      },
    );
  }
  assertWorkspaceBindingReady(repository, binding);
  const database = openExistingDatabase(workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const source = database
      .prepare('SELECT mode FROM workspace_sources WHERE worktree_id = ?')
      .get(binding.worktreeId) as { mode: WorkspaceJoinMode } | undefined;
    if (!source || source.mode !== mode) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Workspace member was joined with another mode.', {
        existingMode: source?.mode,
        requestedMode: mode,
      });
    }
    if (binding.worktreeName !== memberName) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Workspace member name does not match.', {
        existingName: binding.worktreeName,
        requestedName: memberName,
      });
    }
    return {
      workspace,
      member: readMember(database, binding.worktreeId),
      mode,
      imported: false,
      sourceDatabasePath: repository.databasePath,
    };
  } finally {
    database.close();
  }
}

function joinWorkspace(
  repository: RepositoryContext,
  workspace: RegisteredWorkspace,
  memberName: string,
  mode: WorkspaceJoinMode,
  options: WorkspaceServiceOptions,
  heldLocks: { registry?: boolean; worktree?: boolean } = {},
): WorkspaceJoinResult {
  assertJoinMode(mode);
  const releaseOperationLock = heldLocks.worktree
    ? undefined
    : acquireWorkspaceOperationLock(repository);
  let releaseRegistryLock: (() => void) | undefined;
  let releaseRepositoryLock: (() => void) | undefined;
  try {
    if (!heldLocks.registry) {
      releaseRegistryLock = acquireRegisteredWorkspaceOperationLock(workspace.id, options);
    }
    const currentWorkspace = readRegisteredWorkspace(workspace.id, options);
    if (
      currentWorkspace.name !== workspace.name ||
      currentWorkspace.createdAt !== workspace.createdAt
    ) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Workspace registration changed during join.');
    }
    releaseRepositoryLock = acquireRepositoryOperationLock(repository);
    const joinedAfterLock = existingJoin(repository, workspace, memberName, mode, options);
    if (joinedAfterLock) {
      clearPendingWorkspaceJoin(repository);
      return joinedAfterLock;
    }
    let pendingJoin = readPendingWorkspaceJoin(repository);
    if (pendingJoin && pendingJoin.workspaceId !== workspace.id) {
      const intendedWorkspace = findRegisteredWorkspace(pendingJoin.workspaceId, options);
      if (!intendedWorkspace) {
        clearPendingWorkspaceJoin(repository);
        pendingJoin = null;
      }
    }
    if (
      pendingJoin &&
      (pendingJoin.workspaceId !== workspace.id ||
        pendingJoin.memberName !== memberName ||
        pendingJoin.mode !== mode)
    ) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'A different workspace join is pending for this worktree.',
        { pending: pendingJoin },
      );
    }
    const inheritedJoinIntent = pendingJoin !== null;
    const now = options.now ?? Date.now();
    inspectStandaloneSessions(repository, now);
    if (!pendingJoin) {
      pendingJoin = writePendingWorkspaceJoin(repository, {
        workspaceId: workspace.id,
        memberName,
        mode,
      });
    }

    let source: DatabaseType | null = null;
    let identity: SourceIdentity | null = null;
    let preserveJoinIntent = inheritedJoinIntent;
    try {
      if (mode === 'import-current') {
        source = openDatabase(repository, { now });
        source.exec('BEGIN IMMEDIATE');
        assertNoActiveSessions(source, now, repository.databasePath);
        identity = sourceIdentity(source, repository);
      }

      const recovered = recordedMember(
        workspace,
        repository,
        memberName,
        repository.databasePath,
        mode,
      );
      const member =
        recovered?.member ?? databaseMember(workspace, repository, memberName, mode, identity);
      if (recovered && recovered.member.worktreeName !== memberName) {
        throw new SameTreeError('WORKSPACE_ERROR', 'Workspace member name does not match.', {
          existingName: recovered.member.worktreeName,
          requestedName: memberName,
        });
      }
      if (recovered && !recovered.sourceRecorded && !inheritedJoinIntent) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          'An unrecorded workspace member has no recoverable join intent.',
        );
      }
      if (!recovered) assertMemberAvailable(workspace, repository, member);
      let target: DatabaseType | null = null;
      let sourceRecorded = recovered?.sourceRecorded ?? false;
      preserveJoinIntent = preserveJoinIntent || sourceRecorded;
      try {
        target = openDatabase(repository, {
          databasePath: workspace.databasePath,
          member,
          now,
        });
        const imported = source
          ? copyStandaloneState(source, target, identity as SourceIdentity, member, now)
          : false;
        if (!source) recordFreshSource(target, member, repository.databasePath, now);
        sourceRecorded = true;
        preserveJoinIntent = true;
        const result = readMember(target, member.worktreeId);
        bindWorktree(
          repository,
          {
            workspaceId: workspace.id,
            repositoryId: member.repositoryId,
            repositoryName: member.repositoryName,
            worktreeId: member.worktreeId,
            worktreeName: member.worktreeName,
          },
          options,
        );
        clearPendingWorkspaceJoin(repository);
        return {
          workspace,
          member: result,
          mode,
          imported,
          sourceDatabasePath: repository.databasePath,
        };
      } catch (error) {
        if (target && !sourceRecorded) {
          immediateTransaction(target, () => {
            target?.prepare('DELETE FROM worktrees WHERE id = ?').run(member.worktreeId);
            target
              ?.prepare(
                `DELETE FROM repositories
                 WHERE id = ? AND NOT EXISTS (
                   SELECT 1 FROM worktrees WHERE repository_id = repositories.id
                 )`,
              )
              .run(member.repositoryId);
          });
        }
        throw error;
      } finally {
        target?.close();
      }
    } catch (error) {
      if (!preserveJoinIntent) clearPendingWorkspaceJoin(repository);
      throw error;
    } finally {
      if (source?.inTransaction) source.exec('ROLLBACK');
      source?.close();
    }
  } finally {
    releaseRepositoryLock?.();
    releaseRegistryLock?.();
    releaseOperationLock?.();
  }
}

export function createWorkspace(
  cwd: string,
  input: CreateWorkspaceInput,
  options: WorkspaceServiceOptions = {},
): WorkspaceJoinResult {
  assertJoinMode(input.mode);
  const workspaceName = validateWorkspaceName(input.name);
  const repository = resolveRepository(cwd);
  const releaseWorktreeLock = acquireWorkspaceOperationLock(repository, 2_500);
  let releaseRegistryLock: (() => void) | undefined;
  try {
    const pendingCreation = readPendingWorkspaceCreation(repository);
    const pendingJoin = readPendingWorkspaceJoin(repository);
    if (pendingJoin && pendingJoin.workspaceId !== pendingCreation?.workspaceId) {
      const intendedWorkspace = findRegisteredWorkspace(pendingJoin.workspaceId, options);
      if (intendedWorkspace) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          'Complete the pending workspace join before creating another workspace.',
          { pending: pendingJoin },
        );
      }
      clearPendingWorkspaceJoin(repository);
    }
    const existing = resolveRepositoryWorkspaceBinding(repository);
    if (existing) {
      releaseRegistryLock = acquireRegisteredWorkspaceOperationLock(
        existing.workspaceId,
        options,
        2_500,
      );
      const workspace = readRegisteredWorkspace(existing.workspaceId, options);
      if (workspace.name !== workspaceName) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          'Repository is already assigned to another workspace.',
          {
            assignedWorkspaceId: existing.workspaceId,
          },
        );
      }
      const result = joinWorkspace(repository, workspace, input.memberName, input.mode, options, {
        registry: true,
        worktree: true,
      });
      clearPendingWorkspaceCreation(repository);
      return result;
    }
    const pending =
      pendingCreation ??
      writePendingWorkspaceCreation(repository, {
        workspaceId: createId('workspace'),
        workspaceName,
        memberName: input.memberName,
        mode: input.mode,
        createdAt: options.now ?? Date.now(),
      });
    if (
      pending.workspaceName !== workspaceName ||
      pending.memberName !== input.memberName ||
      pending.mode !== input.mode
    ) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'A different workspace creation is already pending for this worktree.',
        { pending },
      );
    }
    releaseRegistryLock = acquireRegisteredWorkspaceOperationLock(
      pending.workspaceId,
      options,
      2_500,
    );
    const workspace = registerWorkspace(
      { id: pending.workspaceId, name: pending.workspaceName, createdAt: pending.createdAt },
      options,
    );
    const result = joinWorkspace(repository, workspace, input.memberName, input.mode, options, {
      registry: true,
      worktree: true,
    });
    clearPendingWorkspaceCreation(repository);
    return result;
  } finally {
    releaseRegistryLock?.();
    releaseWorktreeLock();
  }
}

export function cancelWorkspaceCreation(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspaceCreationCancellation {
  const repository = resolveRepository(cwd);
  const releaseLock = acquireWorkspaceOperationLock(repository, 2_500);
  let releaseRegistryLock: (() => void) | undefined;
  try {
    const pending = readPendingWorkspaceCreation(repository);
    if (!pending) {
      throw new SameTreeError('NOT_FOUND', 'This worktree has no pending workspace creation.');
    }
    releaseRegistryLock = acquireRegisteredWorkspaceOperationLock(
      pending.workspaceId,
      options,
      2_500,
    );
    const workspace = findRegisteredWorkspace(pending.workspaceId, options);
    const pendingJoin = readPendingWorkspaceJoin(repository);
    if (!workspace) {
      if (pendingJoin?.workspaceId === pending.workspaceId) clearPendingWorkspaceJoin(repository);
      clearPendingWorkspaceCreation(repository);
      return { cancelled: true, workspaceId: pending.workspaceId };
    }
    if (existsSync(workspace.databasePath)) {
      const database = openExistingDatabase(workspace.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const members = tableExists(database, 'worktrees')
          ? (database.prepare('SELECT COUNT(*) AS count FROM worktrees').get() as { count: number })
              .count
          : 0;
        if (members > 0) {
          throw new SameTreeError(
            'WORKSPACE_ERROR',
            'Pending workspace already contains a member; retry creation before leaving it.',
            { workspaceId: workspace.id },
          );
        }
      } finally {
        database.close();
      }
    }
    removeRegisteredWorkspace(workspace.id, options);
    if (pendingJoin?.workspaceId === workspace.id) clearPendingWorkspaceJoin(repository);
    clearPendingWorkspaceCreation(repository);
    return { cancelled: true, workspaceId: workspace.id };
  } finally {
    releaseRegistryLock?.();
    releaseLock();
  }
}

export function addWorkspaceMember(
  cwd: string,
  input: AddWorkspaceMemberInput,
  options: WorkspaceServiceOptions = {},
): WorkspaceJoinResult {
  assertJoinMode(input.mode);
  const repository = resolveRepository(cwd);
  const workspace = findRegisteredWorkspace(input.workspaceId, options);
  if (!workspace) {
    const releaseLock = acquireWorkspaceOperationLock(repository, 2_500);
    try {
      const pendingJoin = readPendingWorkspaceJoin(repository);
      if (pendingJoin?.workspaceId === input.workspaceId) clearPendingWorkspaceJoin(repository);
    } finally {
      releaseLock();
    }
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      `Workspace '${input.workspaceId}' is not registered.`,
    );
  }
  return joinWorkspace(repository, workspace, input.memberName, input.mode, options);
}

export function workspaceStatus(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspaceStatus {
  const repository = resolveRepository(cwd);
  const binding = resolveWorkspaceBinding(repository, options);
  if (!binding) {
    return {
      bound: false,
      standaloneDatabasePath: repository.databasePath,
      workspace: null,
      member: null,
      members: [],
    };
  }
  const database = openExistingDatabase(binding.workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      bound: true,
      standaloneDatabasePath: repository.databasePath,
      workspace: binding.workspace,
      member: readMember(database, binding.worktreeId),
      members: listMembers(database),
    };
  } finally {
    database.close();
  }
}

export function workspaceMembers(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspaceMember[] {
  const status = workspaceStatus(cwd, options);
  if (!status.bound)
    throw new SameTreeError('WORKSPACE_ERROR', 'This worktree is not in a workspace.');
  return status.members;
}

export function leaveWorkspace(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspaceMember {
  const repository = resolveRepository(cwd);
  const binding = resolveWorkspaceBinding(repository, options);
  if (!binding) throw new SameTreeError('WORKSPACE_ERROR', 'This worktree is not in a workspace.');
  const releaseLock = acquireWorkspaceOperationLock(repository, 2_500);
  let releaseRepositoryLock: (() => void) | undefined;
  let member: WorkspaceMember;
  let removeRepositoryBinding = false;
  const now = options.now ?? Date.now();
  try {
    releaseRepositoryLock = acquireRepositoryOperationLock(repository, 2_500);
    const database = openExistingDatabase(binding.workspace.databasePath);
    try {
      member = readMember(database, binding.worktreeId);
      immediateTransaction(database, () => {
        const active = database
          .prepare(
            `SELECT COUNT(*) AS count FROM sessions
             WHERE home_worktree_id = ? AND status = 'active' AND expires_at > ?`,
          )
          .get(member.id, now) as { count: number };
        if (active.count > 0) {
          throw new SameTreeError(
            'WORKSPACE_ERROR',
            'Stop active sessions in this worktree before leaving the workspace.',
            { activeSessions: active.count },
          );
        }
        if (member.available) retireMember(database, member, 'worktree.left', now);
        const remaining = database
          .prepare(
            `SELECT COUNT(*) AS count FROM worktrees
             WHERE repository_id = ? AND available = 1`,
          )
          .get(member.repositoryId) as { count: number };
        removeRepositoryBinding = remaining.count === 0;
      });
    } finally {
      database.close();
    }
    if (removeRepositoryBinding) {
      clearRepositoryWorkspaceBinding(repository, {
        workspaceId: binding.workspace.id,
        repositoryId: binding.repositoryId,
      });
    }
    clearWorktreeWorkspaceBinding(repository, {
      workspaceId: binding.workspace.id,
      worktreeId: binding.worktreeId,
    });
    clearMatchingPendingWorkspaceJoin(repository, {
      workspaceId: binding.workspace.id,
      memberName: binding.worktreeName,
    });
    return { ...member, available: false };
  } finally {
    releaseRepositoryLock?.();
    releaseLock();
  }
}

export function pruneWorkspace(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspacePruneResult {
  const repository = resolveRepository(cwd);
  const binding = resolveWorkspaceBinding(repository, options);
  if (!binding) throw new SameTreeError('WORKSPACE_ERROR', 'This worktree is not in a workspace.');
  const database = openExistingDatabase(binding.workspace.databasePath);
  const now = options.now ?? Date.now();
  try {
    const pruned: WorkspaceMember[] = [];
    for (const candidate of listMembers(database)) {
      if (!candidate.available || !memberIsDefinitelyStale(candidate)) continue;
      const releaseWorktreeLock = !pathIsDefinitelyMissing(candidate.privateGitDirectory)
        ? acquireWorkspaceOperationLockAt(candidate.privateGitDirectory, 2_500)
        : undefined;
      let releaseRepositoryLock: (() => void) | undefined;
      try {
        releaseRepositoryLock = !pathIsDefinitelyMissing(candidate.commonGitDirectory)
          ? acquireRepositoryOperationLockAt(candidate.commonGitDirectory, 2_500)
          : undefined;
        let removeRepositoryBinding = false;
        immediateTransaction(database, () => {
          const current = readMember(database, candidate.id);
          if (!current.available || !memberIsDefinitelyStale(current)) return;
          retireMember(database, current, 'worktree.pruned', now);
          const remaining = database
            .prepare(
              `SELECT COUNT(*) AS count FROM worktrees
               WHERE repository_id = ? AND available = 1`,
            )
            .get(current.repositoryId) as { count: number };
          removeRepositoryBinding = remaining.count === 0;
          pruned.push({ ...current, available: false });
        });
        if (removeRepositoryBinding && !pathIsDefinitelyMissing(candidate.commonGitDirectory)) {
          clearRepositoryWorkspaceBindingAt(candidate.commonGitDirectory, {
            workspaceId: binding.workspace.id,
            repositoryId: candidate.repositoryId,
          });
        }
      } finally {
        releaseRepositoryLock?.();
        releaseWorktreeLock?.();
      }
    }
    const inspectedRepositories = new Set<string>();
    for (const candidate of listMembers(database)) {
      if (
        inspectedRepositories.has(candidate.repositoryId) ||
        pathIsDefinitelyMissing(candidate.commonGitDirectory)
      ) {
        continue;
      }
      inspectedRepositories.add(candidate.repositoryId);
      const releaseRepositoryLock = acquireRepositoryOperationLockAt(
        candidate.commonGitDirectory,
        2_500,
      );
      try {
        const available = database
          .prepare(
            `SELECT COUNT(*) AS count FROM worktrees
             WHERE repository_id = ? AND available = 1`,
          )
          .get(candidate.repositoryId) as { count: number };
        if (available.count === 0) {
          clearRepositoryWorkspaceBindingAt(candidate.commonGitDirectory, {
            workspaceId: binding.workspace.id,
            repositoryId: candidate.repositoryId,
          });
        }
      } finally {
        releaseRepositoryLock();
      }
    }
    return { pruned };
  } finally {
    database.close();
  }
}

export function relinkWorkspace(
  cwd: string,
  input: { workspaceId: string; memberName: string },
  options: WorkspaceServiceOptions = {},
): WorkspaceMember {
  const repository = resolveRepository(cwd);
  const workspace = readRegisteredWorkspace(input.workspaceId, options);
  const releaseLock = acquireWorkspaceOperationLock(repository, 2_500);
  let releaseRepositoryLock: (() => void) | undefined;
  const now = options.now ?? Date.now();
  try {
    releaseRepositoryLock = acquireRepositoryOperationLock(repository, 2_500);
    const existingWorktreeBinding = resolveWorkspaceBinding(repository, options);
    if (
      existingWorktreeBinding &&
      (existingWorktreeBinding.workspace.id !== workspace.id ||
        existingWorktreeBinding.worktreeName !== input.memberName)
    ) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Worktree is bound to another workspace member.');
    }
    const existingRepositoryBinding = resolveRepositoryWorkspaceBinding(repository);
    if (existingRepositoryBinding && existingRepositoryBinding.workspaceId !== workspace.id) {
      throw new SameTreeError('WORKSPACE_ERROR', 'Repository is bound to another workspace.');
    }
    const database = openExistingDatabase(workspace.databasePath);
    try {
      const metadata = database
        .prepare('SELECT id, name, implicit FROM workspace_metadata')
        .get() as { id: string; implicit: number; name: string } | undefined;
      if (
        metadata?.id !== workspace.id ||
        metadata.name !== workspace.name ||
        metadata.implicit !== 0
      ) {
        throw new SameTreeError('WORKSPACE_ERROR', 'Workspace registry and database disagree.');
      }
      const row = database
        .prepare(
          `SELECT worktree.id, worktree.repository_id, worktree.name,
                  worktree.private_git_directory, repository.name AS repository_name,
                  repository.common_git_directory
           FROM worktrees worktree
           JOIN repositories repository ON repository.id = worktree.repository_id
           JOIN workspace_sources source ON source.worktree_id = worktree.id
           WHERE worktree.name = ? AND worktree.available = 0`,
        )
        .get(input.memberName) as
        | {
            common_git_directory: string;
            id: string;
            name: string;
            private_git_directory: string;
            repository_id: string;
            repository_name: string;
          }
        | undefined;
      if (!row) {
        throw new SameTreeError(
          'NOT_FOUND',
          `Workspace member '${input.memberName}' was not found.`,
        );
      }
      if (
        row.private_git_directory !== repository.privateGitDirectory ||
        row.common_git_directory !== repository.commonGitDirectory
      ) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          'Relink requires the member’s original private and common Git directories.',
        );
      }
      bindWorktree(
        repository,
        {
          workspaceId: workspace.id,
          repositoryId: row.repository_id,
          repositoryName: row.repository_name,
          worktreeId: row.id,
          worktreeName: row.name,
        },
        options,
      );
      immediateTransaction(database, () => {
        const active = database
          .prepare(
            `SELECT COUNT(*) AS count FROM sessions
             WHERE home_worktree_id = ? AND status = 'active' AND expires_at > ?`,
          )
          .get(row.id, now) as { count: number };
        if (active.count > 0) {
          throw new SameTreeError(
            'WORKSPACE_ERROR',
            'Stop active member sessions before relinking the worktree.',
            { activeSessions: active.count },
          );
        }
        database
          .prepare(
            `UPDATE worktrees SET
               root = ?, head_descriptor = ?, branch = ?, available = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(repository.root, repository.head.descriptor, repository.head.branch, now, row.id);
        recordWorkspaceEvent(
          database,
          'worktree.relinked',
          row.id,
          { member: row.name, root: repository.root },
          now,
        );
      });
      const member = readMember(database, row.id);
      clearMatchingPendingWorkspaceJoin(repository, {
        workspaceId: workspace.id,
        memberName: row.name,
      });
      return member;
    } finally {
      database.close();
    }
  } finally {
    releaseRepositoryLock?.();
    releaseLock();
  }
}

export function diagnoseWorkspace(
  cwd: string,
  options: WorkspaceServiceOptions = {},
): WorkspaceDoctorReport {
  const repository = resolveRepository(cwd);
  const binding = resolveWorkspaceBinding(repository, options);
  if (!binding) throw new SameTreeError('WORKSPACE_ERROR', 'This worktree is not in a workspace.');
  const database = openExistingDatabase(binding.workspace.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma('foreign_keys = ON');
    const integrity = String(database.pragma('integrity_check', { simple: true }));
    const foreignKeyViolations = (database.pragma('foreign_key_check') as unknown[]).length;
    const members = listMembers(database);
    const warnings: string[] = [];
    const metadata = database.prepare('SELECT id, name, implicit FROM workspace_metadata').get() as
      | { id: string; implicit: number; name: string }
      | undefined;
    if (
      metadata?.id !== binding.workspace.id ||
      metadata.name !== binding.workspace.name ||
      metadata.implicit !== 0
    ) {
      warnings.push('Workspace registry and database identities disagree.');
    }
    const hasSources = tableExists(database, 'workspace_sources');
    for (const member of members) {
      if (!hasSources) {
        warnings.push(`${member.name} has no recorded standalone-state transition.`);
      } else {
        const source = database
          .prepare(
            `SELECT source_database_path FROM workspace_sources
             WHERE worktree_id = ?`,
          )
          .get(member.id) as { source_database_path: string } | undefined;
        if (!source) {
          warnings.push(`${member.name} has no recorded source database.`);
        } else if (
          source.source_database_path !==
          path.join(member.privateGitDirectory, 'sametree', 'state.sqlite3')
        ) {
          warnings.push(`${member.name} has an incorrect source database path.`);
        }
      }
      if (!member.available) {
        warnings.push(`${member.name} is unavailable.`);
        continue;
      }
      let resolved: RepositoryContext;
      try {
        resolved = resolveRepository(member.root);
      } catch {
        warnings.push(`${member.name} is missing and should be pruned or relinked.`);
        continue;
      }
      if (
        resolved.privateGitDirectory !== member.privateGitDirectory ||
        resolved.commonGitDirectory !== member.commonGitDirectory
      ) {
        warnings.push(`${member.name} no longer matches its Git directories.`);
        continue;
      }
      try {
        const memberBinding = resolveWorkspaceBinding(resolved, options);
        if (
          memberBinding?.workspace.id !== binding.workspace.id ||
          memberBinding.worktreeId !== member.id ||
          memberBinding.repositoryId !== member.repositoryId ||
          memberBinding.worktreeName !== member.name ||
          memberBinding.repositoryName !== member.repositoryName ||
          !memberBinding.repositoryBindingPresent
        ) {
          warnings.push(`${member.name} has a missing or conflicting workspace binding.`);
        }
      } catch (error) {
        warnings.push(
          `${member.name} binding could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      ok: integrity === 'ok' && foreignKeyViolations === 0 && warnings.length === 0,
      workspace: binding.workspace,
      databasePath: binding.workspace.databasePath,
      integrity,
      foreignKeyViolations,
      members,
      warnings,
    };
  } finally {
    database.close();
  }
}
