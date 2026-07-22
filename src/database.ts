import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database, { type Database as DatabaseType } from 'better-sqlite3';

import { SameTreeError } from './errors.js';
import type { RepositoryContext } from './git.js';

const MINIMUM_SQLITE_VERSION = '3.51.3';
const WAL_RETRY_ATTEMPTS = 20;
const WAL_RETRY_DELAY_MS = 25;

export interface DatabaseMemberContext {
  workspaceId: string;
  workspaceName: string;
  workspaceImplicit: boolean;
  repositoryId: string;
  repositoryName: string;
  worktreeId: string;
  worktreeName: string;
}

export interface OpenDatabaseOptions {
  databasePath?: string;
  member?: DatabaseMemberContext;
  now?: number;
}

function sqliteBindingError(error: unknown): SameTreeError | null {
  const cause = error instanceof Error ? error.message : String(error);
  if (!/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better_sqlite3\.node/iu.test(cause)) return null;
  return new SameTreeError(
    'DATABASE_ERROR',
    `SameTree's SQLite binding is incompatible with ${process.version} (ABI ${process.versions.modules ?? 'unknown'}). Reinstall it with the active Node runtime, then run sametree directly instead of bunx: npm install --global sametree@latest --force`,
    { cause },
  );
}

export function assertDatabaseRuntimeCompatible(): void {
  let database: DatabaseType | undefined;
  try {
    database = new Database(':memory:');
  } catch (error) {
    throw (
      sqliteBindingError(error) ??
      new SameTreeError('DATABASE_ERROR', 'SameTree could not load its SQLite binding.', {
        cause: error instanceof Error ? error.message : String(error),
      })
    );
  } finally {
    database?.close();
  }
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = path.resolve(target);
  const { root } = path.parse(absolute);
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SameTreeError('DATABASE_ERROR', 'Refusing a symlinked database path.', {
          path: current,
        });
      }
    } catch (error) {
      if (error instanceof SameTreeError) throw error;
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT') break;
      throw error;
    }
  }
}

export function assertDatabasePathSafe(databasePath: string): void {
  assertNoSymlinkComponents(path.dirname(databasePath));
  assertNoSymlinkComponents(databasePath);
}

const BROADCAST_RECIPIENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS broadcast_recipients (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    PRIMARY KEY (message_id, agent_name)
  ) STRICT;
`;

const MESSAGE_DELIVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    reserved_by_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    reserved_at INTEGER NOT NULL,
    delivered_at INTEGER,
    PRIMARY KEY (message_id, agent_name),
    CHECK(delivered_at IS NULL OR delivered_at >= reserved_at)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS message_deliveries_pending_session_idx
    ON message_deliveries(reserved_by_session)
    WHERE delivered_at IS NULL;
`;

const WORKSPACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_metadata (
    id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton = 1),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
    implicit INTEGER NOT NULL CHECK(implicit IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
    common_git_directory TEXT NOT NULL UNIQUE,
    ignore_case INTEGER NOT NULL DEFAULT 0 CHECK(ignore_case IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
    name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 100),
    root TEXT NOT NULL UNIQUE,
    private_git_directory TEXT NOT NULL UNIQUE,
    head_descriptor TEXT NOT NULL,
    branch TEXT,
    available INTEGER NOT NULL CHECK(available IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

const TASK_WORKTREE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_worktrees (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE RESTRICT,
    PRIMARY KEY (task_id, worktree_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_worktrees_worktree_idx
    ON task_worktrees(worktree_id, task_id);
`;

const PLAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    source_harness TEXT NOT NULL CHECK(source_harness IN ('claude-code', 'opencode', 'other')),
    source_session_id TEXT NOT NULL CHECK(length(source_session_id) BETWEEN 1 AND 200),
    current_revision INTEGER NOT NULL CHECK(current_revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_harness, source_session_id),
    FOREIGN KEY (id, current_revision)
      REFERENCES plan_revisions(plan_id, revision) DEFERRABLE INITIALLY DEFERRED,
    CHECK(updated_at >= created_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS plan_revisions (
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 48000),
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    source_event_id TEXT NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 200),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, revision),
    UNIQUE (plan_id, source_event_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS plans_created_idx ON plans(created_at, id);
  CREATE INDEX IF NOT EXISTS plans_author_idx ON plans(author, created_at, id);
  CREATE INDEX IF NOT EXISTS plans_task_idx ON plans(task_id, created_at, id);
`;

const SHARED_INSTRUCTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS shared_instructions (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES agents(name) ON DELETE RESTRICT,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    source_harness TEXT NOT NULL CHECK(source_harness IN ('claude-code', 'opencode', 'other')),
    source_session_id TEXT NOT NULL CHECK(length(source_session_id) BETWEEN 1 AND 200),
    source_event_id TEXT NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 200),
    current_revision INTEGER NOT NULL CHECK(current_revision > 0),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_harness, source_session_id, source_event_id),
    FOREIGN KEY (id, current_revision)
      REFERENCES shared_instruction_revisions(instruction_id, revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK(updated_at >= created_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS shared_instruction_revisions (
    instruction_id TEXT NOT NULL REFERENCES shared_instructions(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    action TEXT NOT NULL CHECK(action IN ('recorded', 'revised', 'revoked')),
    body TEXT,
    content_hash TEXT,
    recorded_by TEXT NOT NULL REFERENCES agents(name) ON DELETE RESTRICT,
    authorization_reason TEXT NOT NULL CHECK(length(authorization_reason) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (instruction_id, revision),
    CHECK(
      (revision = 1 AND action = 'recorded') OR
      (revision > 1 AND action IN ('revised', 'revoked'))
    ),
    CHECK(
      (action IN ('recorded', 'revised') AND body IS NOT NULL AND
       length(body) BETWEEN 1 AND 48000 AND length(content_hash) = 64) OR
      (action = 'revoked' AND body IS NULL AND content_hash IS NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS shared_instruction_acks (
    instruction_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY (instruction_id, revision, agent_name),
    FOREIGN KEY (instruction_id, revision)
      REFERENCES shared_instruction_revisions(instruction_id, revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS shared_instruction_notifications (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    instruction_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    FOREIGN KEY (instruction_id, revision)
      REFERENCES shared_instruction_revisions(instruction_id, revision) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS shared_instructions_created_idx
    ON shared_instructions(created_at, id);
  CREATE INDEX IF NOT EXISTS shared_instructions_task_idx
    ON shared_instructions(task_id, created_at, id);
  CREATE INDEX IF NOT EXISTS shared_instruction_acks_agent_idx
    ON shared_instruction_acks(agent_name, instruction_id, revision);
  CREATE INDEX IF NOT EXISTS shared_instruction_notifications_revision_idx
    ON shared_instruction_notifications(instruction_id, revision);
`;

const INITIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE agents (
    name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 80),
    harness TEXT NOT NULL CHECK(harness IN ('claude-code', 'opencode', 'other')),
    role TEXT NOT NULL CHECK(length(role) BETWEEN 1 AND 80),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    process_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'closed'))
  ) STRICT;

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK(length(description) <= 20000),
    status TEXT NOT NULL CHECK(status IN ('ready', 'in_progress', 'blocked', 'done', 'cancelled')),
    priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
    assignee TEXT REFERENCES agents(name) ON DELETE SET NULL,
    claimed_by_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    lease_expires_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    PRIMARY KEY (task_id, depends_on),
    CHECK(task_id <> depends_on)
  ) STRICT;

  CREATE TABLE path_claims (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    comparison_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('exact', 'tree')),
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    recipient TEXT REFERENCES agents(name) ON DELETE CASCADE,
    subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 50000),
    thread_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE message_receipts (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, agent_name)
  ) STRICT;

  ${BROADCAST_RECIPIENT_SCHEMA}

  ${MESSAGE_DELIVERY_SCHEMA}

  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    to_agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 20000),
    context_json TEXT NOT NULL CHECK(json_valid(context_json)),
    task_revision INTEGER NOT NULL CHECK(task_revision > 0),
    status TEXT NOT NULL CHECK(status IN ('offered', 'accepted', 'rejected', 'cancelled', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    responded_at INTEGER,
    CHECK(from_agent <> to_agent)
  ) STRICT;

  CREATE TABLE policy_acks (
    policy_hash TEXT NOT NULL,
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY (policy_hash, agent_name)
  ) STRICT;

  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX sessions_active_idx ON sessions(status, expires_at);
  CREATE INDEX tasks_status_idx ON tasks(status, priority, created_at);
  CREATE INDEX claims_active_idx ON path_claims(expires_at, comparison_path);
  CREATE INDEX messages_recipient_idx ON messages(recipient, created_at);
  CREATE INDEX handoffs_recipient_idx ON handoffs(to_agent, status, expires_at);
  CREATE INDEX events_sequence_idx ON events(sequence);
`;

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isBusy(error: unknown): boolean {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function enableWal(database: DatabaseType): void {
  for (let attempt = 1; attempt <= WAL_RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (database.pragma('journal_mode', { simple: true }) === 'wal') return;
      if (database.pragma('journal_mode = WAL', { simple: true }) === 'wal') return;
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (attempt === WAL_RETRY_ATTEMPTS) {
        throw new SameTreeError(
          'DATABASE_ERROR',
          'Could not enable SQLite WAL mode because the database remained locked.',
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    sleep(WAL_RETRY_DELAY_MS);
  }
  throw new SameTreeError('DATABASE_ERROR', 'SQLite did not enter WAL mode.');
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function tableExists(database: DatabaseType, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableHasColumn(database: DatabaseType, table: string, column: string): boolean {
  return (database.pragma(`table_info(${table})`) as { name: string }[]).some(
    (entry) => entry.name === column,
  );
}

function implicitMember(repository: RepositoryContext): DatabaseMemberContext {
  const name = [...path.basename(repository.root)].slice(0, 100).join('');
  return {
    workspaceId: createId('workspace'),
    workspaceName: name,
    workspaceImplicit: true,
    repositoryId: createId('repository'),
    repositoryName: name,
    worktreeId: createId('worktree'),
    worktreeName: name,
  };
}

function insertMember(
  database: DatabaseType,
  repository: RepositoryContext,
  member: DatabaseMemberContext,
  now: number,
): void {
  const storedRepository = database
    .prepare('SELECT name, common_git_directory FROM repositories WHERE id = ?')
    .get(member.repositoryId) as { common_git_directory: string; name: string } | undefined;
  if (storedRepository) {
    if (
      storedRepository.name !== member.repositoryName ||
      storedRepository.common_git_directory !== repository.commonGitDirectory
    ) {
      throw new SameTreeError('DATABASE_ERROR', 'Repository identity collision.', {
        repositoryId: member.repositoryId,
        stored: storedRepository,
        requested: {
          name: member.repositoryName,
          commonGitDirectory: repository.commonGitDirectory,
        },
      });
    }
    database
      .prepare('UPDATE repositories SET ignore_case = ?, updated_at = ? WHERE id = ?')
      .run(repository.ignoreCase ? 1 : 0, now, member.repositoryId);
  } else {
    database
      .prepare(
        `INSERT INTO repositories
          (id, name, common_git_directory, ignore_case, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        member.repositoryId,
        member.repositoryName,
        repository.commonGitDirectory,
        repository.ignoreCase ? 1 : 0,
        now,
        now,
      );
  }

  const storedWorktree = database
    .prepare(
      `SELECT repository_id, name, private_git_directory, available
       FROM worktrees WHERE id = ?`,
    )
    .get(member.worktreeId) as
    | { available: number; name: string; private_git_directory: string; repository_id: string }
    | undefined;
  if (storedWorktree) {
    if (storedWorktree.available !== 1) {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Workspace member is unavailable; relink it before starting a session.',
        { worktreeId: member.worktreeId },
      );
    }
    if (
      storedWorktree.repository_id !== member.repositoryId ||
      storedWorktree.name !== member.worktreeName ||
      storedWorktree.private_git_directory !== repository.privateGitDirectory
    ) {
      throw new SameTreeError('DATABASE_ERROR', 'Worktree identity collision.', {
        worktreeId: member.worktreeId,
        stored: storedWorktree,
        requested: {
          repositoryId: member.repositoryId,
          name: member.worktreeName,
          privateGitDirectory: repository.privateGitDirectory,
        },
      });
    }
    database
      .prepare(
        `UPDATE worktrees SET
           root = ?, available = 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(repository.root, now, member.worktreeId);
  } else {
    database
      .prepare(
        `INSERT INTO worktrees
          (id, repository_id, name, root, private_git_directory, head_descriptor, branch,
           available, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        member.worktreeId,
        member.repositoryId,
        member.worktreeName,
        repository.root,
        repository.privateGitDirectory,
        repository.head.descriptor,
        repository.head.branch,
        now,
        now,
      );
  }
}

function migrateWorkspaceSchema(
  database: DatabaseType,
  repository: RepositoryContext,
  requestedMember: DatabaseMemberContext | undefined,
  now: number,
): void {
  const hadTaskWorktrees = tableExists(database, 'task_worktrees');
  database.exec(WORKSPACE_SCHEMA);
  if (!tableHasColumn(database, 'repositories', 'ignore_case')) {
    database.exec(
      'ALTER TABLE repositories ADD COLUMN ignore_case INTEGER NOT NULL DEFAULT 0 CHECK(ignore_case IN (0, 1))',
    );
  }
  if (!tableHasColumn(database, 'worktrees', 'branch')) {
    database.exec('ALTER TABLE worktrees ADD COLUMN branch TEXT');
    database.exec(
      `UPDATE worktrees SET branch =
         CASE
           WHEN head_descriptor LIKE 'ref: refs/heads/%'
           THEN substr(head_descriptor, length('ref: refs/heads/') + 1)
           ELSE NULL
         END`,
    );
  }

  const metadata = database.prepare('SELECT * FROM workspace_metadata LIMIT 1').get() as
    | { id: string; implicit: number; name: string }
    | undefined;
  let member = requestedMember;
  if (!metadata) {
    member ??= implicitMember(repository);
    database
      .prepare(
        `INSERT INTO workspace_metadata (id, name, implicit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(member.workspaceId, member.workspaceName, member.workspaceImplicit ? 1 : 0, now, now);
    insertMember(database, repository, member, now);
  } else if (member) {
    if (
      metadata.id !== member.workspaceId ||
      metadata.name !== member.workspaceName ||
      metadata.implicit !== (member.workspaceImplicit ? 1 : 0)
    ) {
      throw new SameTreeError('DATABASE_ERROR', 'Database workspace identity does not match.', {
        databaseWorkspace: metadata,
        requestedWorkspace: {
          id: member.workspaceId,
          name: member.workspaceName,
          implicit: member.workspaceImplicit,
        },
      });
    }
    insertMember(database, repository, member, now);
  } else {
    const stored = database
      .prepare(
        `SELECT repository.id AS repository_id, repository.name AS repository_name,
                worktree.id AS worktree_id, worktree.name AS worktree_name
         FROM worktrees worktree
         JOIN repositories repository ON repository.id = worktree.repository_id
         ORDER BY worktree.created_at, worktree.id
         LIMIT 1`,
      )
      .get() as
      | {
          repository_id: string;
          repository_name: string;
          worktree_id: string;
          worktree_name: string;
        }
      | undefined;
    if (!stored || metadata.implicit !== 1) {
      throw new SameTreeError(
        'DATABASE_ERROR',
        'Explicit workspace databases require a member binding.',
      );
    }
    member = {
      workspaceId: metadata.id,
      workspaceName: metadata.name,
      workspaceImplicit: true,
      repositoryId: stored.repository_id,
      repositoryName: stored.repository_name,
      worktreeId: stored.worktree_id,
      worktreeName: stored.worktree_name,
    };
    insertMember(database, repository, member, now);
  }

  if (!member) throw new SameTreeError('DATABASE_ERROR', 'Database member migration failed.');

  if (!tableHasColumn(database, 'sessions', 'home_worktree_id')) {
    database.exec(
      'ALTER TABLE sessions ADD COLUMN home_worktree_id TEXT REFERENCES worktrees(id) ON DELETE RESTRICT',
    );
    database.prepare('UPDATE sessions SET home_worktree_id = ?').run(member.worktreeId);
  }
  if (!tableHasColumn(database, 'sessions', 'started_head_descriptor')) {
    database.exec('ALTER TABLE sessions ADD COLUMN started_head_descriptor TEXT');
    database.exec(
      `UPDATE sessions SET started_head_descriptor = (
         SELECT head_descriptor FROM worktrees WHERE id = sessions.home_worktree_id
       )`,
    );
  }
  if (!tableHasColumn(database, 'sessions', 'started_branch')) {
    database.exec('ALTER TABLE sessions ADD COLUMN started_branch TEXT');
    database.exec(
      `UPDATE sessions SET started_branch = (
         SELECT branch FROM worktrees WHERE id = sessions.home_worktree_id
       )`,
    );
  }
  if (!tableHasColumn(database, 'path_claims', 'worktree_id')) {
    database.exec(
      'ALTER TABLE path_claims ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE RESTRICT',
    );
    database.prepare('UPDATE path_claims SET worktree_id = ?').run(member.worktreeId);
  }
  if (!tableHasColumn(database, 'policy_acks', 'worktree_id')) {
    database.exec(`
      ALTER TABLE policy_acks RENAME TO policy_acks_v3;
      CREATE TABLE policy_acks (
        policy_hash TEXT NOT NULL,
        agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
        worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
        acknowledged_at INTEGER NOT NULL,
        PRIMARY KEY (policy_hash, agent_name, worktree_id)
      ) STRICT;
    `);
    database
      .prepare(
        `INSERT INTO policy_acks (policy_hash, agent_name, worktree_id, acknowledged_at)
         SELECT policy_hash, agent_name, ?, acknowledged_at FROM policy_acks_v3`,
      )
      .run(member.worktreeId);
    database.exec('DROP TABLE policy_acks_v3');
  }
  if (!tableHasColumn(database, 'events', 'worktree_id')) {
    database.exec(
      'ALTER TABLE events ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL',
    );
    database.prepare('UPDATE events SET worktree_id = ?').run(member.worktreeId);
  }

  database.exec(TASK_WORKTREE_SCHEMA);
  if (!hadTaskWorktrees) {
    database
      .prepare('INSERT INTO task_worktrees (task_id, worktree_id) SELECT id, ? FROM tasks')
      .run(member.worktreeId);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS sessions_home_worktree_idx
      ON sessions(home_worktree_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS claims_worktree_active_idx
      ON path_claims(worktree_id, expires_at, comparison_path);
    CREATE INDEX IF NOT EXISTS events_worktree_sequence_idx
      ON events(worktree_id, sequence);

    CREATE TRIGGER IF NOT EXISTS sessions_require_home_worktree_insert
    BEFORE INSERT ON sessions
    WHEN NEW.home_worktree_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'sessions require a home worktree');
    END;

    CREATE TRIGGER IF NOT EXISTS sessions_require_home_worktree_update
    BEFORE UPDATE ON sessions
    WHEN NEW.home_worktree_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'sessions require a home worktree');
    END;

    DROP TRIGGER IF EXISTS claims_require_session_worktree_insert;
    DROP TRIGGER IF EXISTS claims_require_session_worktree_update;

    CREATE TRIGGER claims_require_session_worktree_insert
    BEFORE INSERT ON path_claims
    WHEN NEW.worktree_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'claims require a target worktree');
    END;

    CREATE TRIGGER claims_require_session_worktree_update
    BEFORE UPDATE ON path_claims
    WHEN NEW.worktree_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'claims require a target worktree');
    END;
  `);
}

function migrate(
  database: DatabaseType,
  repository: RepositoryContext,
  now: number,
  member?: DatabaseMemberContext,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT',
    );
    const current = database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };

    if (current.version > 6) {
      throw new SameTreeError(
        'DATABASE_ERROR',
        `This database uses unsupported schema version ${current.version}.`,
      );
    }
    if (current.version === 0) {
      database.exec(INITIAL_SCHEMA);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)')
        .run(now);
    }
    if (current.version < 2) {
      database.exec(BROADCAST_RECIPIENT_SCHEMA);
      database.exec(
        `INSERT OR IGNORE INTO broadcast_recipients (message_id, agent_name)
         SELECT message.id, agent.name
         FROM messages message
         JOIN agents agent ON agent.name <> message.sender
         WHERE message.recipient IS NULL AND agent.created_at <= message.created_at`,
      );
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)')
        .run(now);
    }
    if (current.version < 3) {
      database.exec(MESSAGE_DELIVERY_SCHEMA);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)')
        .run(now);
    }
    if (current.version < 4) {
      migrateWorkspaceSchema(database, repository, member, now);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)')
        .run(now);
    } else {
      migrateWorkspaceSchema(database, repository, member, now);
    }
    if (current.version < 5) {
      database.exec(PLAN_SCHEMA);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)')
        .run(now);
    } else {
      database.exec(PLAN_SCHEMA);
    }
    if (current.version < 6) {
      database.exec(SHARED_INSTRUCTION_SCHEMA);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
        .run(now);
    } else {
      database.exec(SHARED_INSTRUCTION_SCHEMA);
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(
  repository: RepositoryContext,
  options: OpenDatabaseOptions = {},
): DatabaseType {
  const databasePath = options.databasePath ?? repository.databasePath;
  const stateDirectory = path.dirname(databasePath);
  assertNoSymlinkComponents(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  assertDatabasePathSafe(databasePath);

  let database: DatabaseType;
  try {
    database = new Database(databasePath, { timeout: 2_500 });
  } catch (error) {
    throw sqliteBindingError(error) ?? error;
  }
  try {
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);

    const persistentDatabase = databasePath !== ':memory:';
    database.pragma('busy_timeout = 100');
    database.pragma('foreign_keys = ON');
    if (persistentDatabase) enableWal(database);
    database.pragma('busy_timeout = 2500');
    database.pragma('synchronous = FULL');
    database.pragma('trusted_schema = OFF');
    database.pragma('cell_size_check = ON');
    database.pragma('wal_autocheckpoint = 1000');

    const { version } = database.prepare('SELECT sqlite_version() AS version').get() as {
      version: string;
    };
    if (compareVersions(version, MINIMUM_SQLITE_VERSION) < 0) {
      throw new SameTreeError(
        'DATABASE_ERROR',
        `SQLite ${MINIMUM_SQLITE_VERSION} or newer is required; found ${version}.`,
      );
    }

    migrate(database, repository, options.now ?? Date.now(), options.member);
    if (persistentDatabase && database.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new SameTreeError('DATABASE_ERROR', 'SQLite left WAL mode during initialization.');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function databaseWorktreeId(database: DatabaseType, repository: RepositoryContext): string {
  const worktree = database
    .prepare('SELECT id FROM worktrees WHERE private_git_directory = ?')
    .get(repository.privateGitDirectory) as { id: string } | undefined;
  if (!worktree) {
    throw new SameTreeError(
      'DATABASE_ERROR',
      'Current worktree is not registered in the database.',
      {
        privateGitDirectory: repository.privateGitDirectory,
      },
    );
  }
  return worktree.id;
}

export function immediateTransaction<T>(database: DatabaseType, operation: () => T): T {
  return database.transaction(operation).immediate();
}
