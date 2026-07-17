import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database, { type Database as DatabaseType } from 'better-sqlite3';

import { SameTreeError } from './errors.js';
import type { RepositoryContext } from './git.js';

const MINIMUM_SQLITE_VERSION = '3.51.3';

function isSymbolicLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    if (code === 'ENOENT') return false;
    throw error;
  }
}

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

function migrate(database: DatabaseType, now: number): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT',
    );
    const current = database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };

    if (current.version > 1) {
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
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(
  repository: RepositoryContext,
  options: { databasePath?: string; now?: number } = {},
): DatabaseType {
  const databasePath = options.databasePath ?? repository.databasePath;
  const stateDirectory = path.dirname(databasePath);
  if (isSymbolicLink(stateDirectory)) {
    throw new SameTreeError(
      'DATABASE_ERROR',
      'Refusing to use a symlinked SameTree state directory.',
      {
        stateDirectory,
      },
    );
  }
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  if (isSymbolicLink(databasePath)) {
    throw new SameTreeError('DATABASE_ERROR', 'Refusing to open a symlinked SameTree database.', {
      databasePath,
    });
  }

  const database = new Database(databasePath, { timeout: 2_500 });
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);

  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('busy_timeout = 2500');
  database.pragma('trusted_schema = OFF');
  database.pragma('cell_size_check = ON');
  database.pragma('wal_autocheckpoint = 1000');

  const { version } = database.prepare('SELECT sqlite_version() AS version').get() as {
    version: string;
  };
  if (compareVersions(version, MINIMUM_SQLITE_VERSION) < 0) {
    database.close();
    throw new SameTreeError(
      'DATABASE_ERROR',
      `SQLite ${MINIMUM_SQLITE_VERSION} or newer is required; found ${version}.`,
    );
  }

  migrate(database, options.now ?? Date.now());
  return database;
}

export function immediateTransaction<T>(database: DatabaseType, operation: () => T): T {
  return database.transaction(operation).immediate();
}
