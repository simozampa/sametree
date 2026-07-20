import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import Database, { type Database as DatabaseType } from 'better-sqlite3';

import { type DatabaseMemberContext, immediateTransaction, openDatabase } from './database.js';
import { SameTreeError } from './errors.js';
import { type RepositoryContext, resolveRepository } from './git.js';
import {
  acquireWorkspaceOperationLock,
  bindWorktree,
  clearPendingWorkspaceCreation,
  type RegisteredWorkspace,
  readPendingWorkspaceCreation,
  readRegisteredWorkspace,
  registerWorkspace,
  resolveRepositoryWorkspaceBinding,
  resolveWorkspaceBinding,
  type WorkspaceContext,
  type WorkspaceRegistryOptions,
  writePendingWorkspaceCreation,
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

interface SourceIdentity {
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
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
              repository.id AS repository_id, repository.name AS repository_name
       FROM worktrees worktree
       JOIN repositories repository ON repository.id = worktree.repository_id
       WHERE worktree.id = ?`,
    )
    .get(worktreeId) as
    | {
        available: number;
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

export function assertWorkspaceBindingReady(
  repository: RepositoryContext,
  binding: WorkspaceContext,
): void {
  if (!existsSync(binding.workspace.databasePath)) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Bound workspace database is missing.', {
      databasePath: binding.workspace.databasePath,
    });
  }
  const database = new Database(binding.workspace.databasePath, {
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
        `SELECT 1 FROM worktrees worktree
         JOIN workspace_sources source ON source.worktree_id = worktree.id
         WHERE worktree.id = ? AND worktree.repository_id = ?
           AND worktree.private_git_directory = ?
           AND source.source_database_path = ?`,
      )
      .get(
        binding.worktreeId,
        binding.repositoryId,
        repository.privateGitDirectory,
        repository.databasePath,
      );
    if (metadata?.id !== binding.workspace.id || !member) {
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
  const database = new Database(repository.databasePath, { readonly: true, fileMustExist: true });
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

  assertNoEntityCollisions(source, target);
  immediateTransaction(target, () => {
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
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceImplicit: false,
    repositoryId:
      repositoryBinding?.repositoryId ??
      (mode === 'import-current' && source ? source.repositoryId : createId('repository')),
    repositoryName: repositoryBinding?.repositoryName ?? memberName,
    worktreeId: mode === 'import-current' && source ? source.worktreeId : createId('worktree'),
    worktreeName: memberName,
  };
}

function recordedMember(
  workspace: RegisteredWorkspace,
  sourceDatabasePath: string,
  mode: WorkspaceJoinMode,
): DatabaseMemberContext | null {
  if (!existsSync(workspace.databasePath)) return null;
  const database = new Database(workspace.databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, 'workspace_sources')) return null;
    const source = database
      .prepare(
        `SELECT worktree_id FROM workspace_sources
         WHERE source_database_path = ? AND mode = ?`,
      )
      .get(sourceDatabasePath, mode) as { worktree_id: string } | undefined;
    if (!source) return null;
    const member = readMember(database, source.worktree_id);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceImplicit: false,
      repositoryId: member.repositoryId,
      repositoryName: member.repositoryName,
      worktreeId: member.id,
      worktreeName: member.name,
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
  const database = new Database(workspace.databasePath, { readonly: true, fileMustExist: true });
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
  const database = new Database(workspace.databasePath, { readonly: true, fileMustExist: true });
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
): WorkspaceJoinResult {
  assertJoinMode(mode);
  const joined = existingJoin(repository, workspace, memberName, mode, options);
  if (joined) return joined;
  const releaseOperationLock = acquireWorkspaceOperationLock(repository);
  try {
    const joinedAfterLock = existingJoin(repository, workspace, memberName, mode, options);
    if (joinedAfterLock) return joinedAfterLock;
    const now = options.now ?? Date.now();
    inspectStandaloneSessions(repository, now);

    let source: DatabaseType | null = null;
    let identity: SourceIdentity | null = null;
    try {
      if (mode === 'import-current') {
        source = openDatabase(repository, { now });
        source.exec('BEGIN IMMEDIATE');
        assertNoActiveSessions(source, now, repository.databasePath);
        identity = sourceIdentity(source, repository);
      }

      const recoveredMember = recordedMember(workspace, repository.databasePath, mode);
      const member =
        recoveredMember ?? databaseMember(workspace, repository, memberName, mode, identity);
      if (!recoveredMember) assertMemberAvailable(workspace, repository, member);
      let target: DatabaseType | null = null;
      let sourceRecorded = recoveredMember !== null;
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
    } finally {
      if (source?.inTransaction) source.exec('ROLLBACK');
      source?.close();
    }
  } finally {
    releaseOperationLock();
  }
}

export function createWorkspace(
  cwd: string,
  input: CreateWorkspaceInput,
  options: WorkspaceServiceOptions = {},
): WorkspaceJoinResult {
  assertJoinMode(input.mode);
  const repository = resolveRepository(cwd);
  const existing = resolveRepositoryWorkspaceBinding(repository);
  if (existing) {
    const workspace = readRegisteredWorkspace(existing.workspaceId, options);
    if (workspace.name !== input.name) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Repository is already assigned to another workspace.',
        {
          assignedWorkspaceId: existing.workspaceId,
        },
      );
    }
    const result = joinWorkspace(repository, workspace, input.memberName, input.mode, options);
    clearPendingWorkspaceCreation(repository);
    return result;
  }
  const pending =
    readPendingWorkspaceCreation(repository) ??
    writePendingWorkspaceCreation(repository, {
      workspaceId: createId('workspace'),
      workspaceName: input.name,
      memberName: input.memberName,
      mode: input.mode,
      createdAt: options.now ?? Date.now(),
    });
  if (
    pending.workspaceName !== input.name ||
    pending.memberName !== input.memberName ||
    pending.mode !== input.mode
  ) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'A different workspace creation is already pending for this worktree.',
      { pending },
    );
  }
  const workspace = registerWorkspace(
    { id: pending.workspaceId, name: pending.workspaceName, createdAt: pending.createdAt },
    options,
  );
  const result = joinWorkspace(repository, workspace, input.memberName, input.mode, options);
  clearPendingWorkspaceCreation(repository);
  return result;
}

export function addWorkspaceMember(
  cwd: string,
  input: AddWorkspaceMemberInput,
  options: WorkspaceServiceOptions = {},
): WorkspaceJoinResult {
  assertJoinMode(input.mode);
  return joinWorkspace(
    resolveRepository(cwd),
    readRegisteredWorkspace(input.workspaceId, options),
    input.memberName,
    input.mode,
    options,
  );
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
  const database = new Database(binding.workspace.databasePath, {
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
