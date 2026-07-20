import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/database.js';
import { resolveRepository } from '../src/git.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('database workspace migration', () => {
  it('bounds implicit names for valid repositories with long basenames', () => {
    const parent = createTestRepository({ initialize: false });
    repositories.push(parent);
    const root = path.join(parent.root, 'r'.repeat(120));
    mkdirSync(root);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });

    const database = openDatabase(resolveRepository(root));
    expect(database.prepare('SELECT name FROM workspace_metadata').get()).toEqual({
      name: 'r'.repeat(100),
    });
    expect(database.prepare('SELECT name FROM worktrees').get()).toEqual({
      name: 'r'.repeat(100),
    });
    database.close();
  });

  it('creates an implicit one-member workspace at the standalone database path', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const context = resolveRepository(repository.root);
    const database = openDatabase(context, { now: 100 });

    expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      { version: 4 },
    );
    expect(database.prepare('SELECT name, implicit FROM workspace_metadata').get()).toEqual({
      name: path.basename(repository.root),
      implicit: 1,
    });
    expect(database.prepare('SELECT common_git_directory FROM repositories').get()).toEqual({
      common_git_directory: context.commonGitDirectory,
    });
    expect(
      database
        .prepare('SELECT root, private_git_directory, head_descriptor, available FROM worktrees')
        .get(),
    ).toEqual({
      root: context.root,
      private_git_directory: context.privateGitDirectory,
      head_descriptor: context.head.descriptor,
      available: 1,
    });

    const worktree = database.prepare('SELECT id, repository_id FROM worktrees').get() as {
      id: string;
      repository_id: string;
    };
    database
      .prepare(
        `INSERT INTO agents (name, harness, role, created_at, last_seen_at)
         VALUES ('agent', 'other', 'implementer', 1, 1)`,
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO sessions
            (id, agent_name, process_id, started_at, last_heartbeat_at, expires_at, status)
           VALUES ('missing-home', 'agent', 1, 1, 1, 2, 'active')`,
        )
        .run(),
    ).toThrow(/sessions require a home worktree/u);
    database
      .prepare(
        `INSERT INTO worktrees
          (id, repository_id, name, root, private_git_directory, head_descriptor,
           available, created_at, updated_at)
         VALUES ('worktree_other', ?, 'other', '/other', '/git/other',
                 'ref: refs/heads/main', 1, 1, 1)`,
      )
      .run(worktree.repository_id);
    database
      .prepare(
        `INSERT INTO sessions
          (id, agent_name, home_worktree_id, process_id, started_at,
           last_heartbeat_at, expires_at, status)
         VALUES ('session', 'agent', ?, 1, 1, 1, 2, 'active')`,
      )
      .run(worktree.id);
    database
      .prepare(
        `INSERT INTO path_claims
          (id, path, comparison_path, kind, agent_name, session_id,
           expires_at, created_at, worktree_id)
         VALUES ('claim', 'src', 'src', 'tree', 'agent', 'session', 2, 1, 'worktree_other')`,
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO path_claims
            (id, path, comparison_path, kind, agent_name, session_id,
             expires_at, created_at, worktree_id)
           VALUES ('claim_null', 'test', 'test', 'tree', 'agent', 'session', 2, 1, NULL)`,
        )
        .run(),
    ).toThrow(/claims require a target worktree/u);
    database.close();

    expect(context.databasePath).toBe(
      path.join(context.privateGitDirectory, 'sametree', 'state.sqlite3'),
    );
  });

  it('backfills version 3 entities to the implicit member without changing their IDs', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const context = resolveRepository(repository.root);
    mkdirSync(path.dirname(context.databasePath), { recursive: true });
    const legacy = new Database(context.databasePath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (1, 1), (2, 2), (3, 3);

      CREATE TABLE agents (
        name TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO agents VALUES ('legacy-agent', 'other', 'implementer', 1, 1);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL REFERENCES agents(name),
        process_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL
      ) STRICT;
      INSERT INTO sessions VALUES ('session_legacy', 'legacy-agent', 1, 1, 1, 2, 'closed');

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT REFERENCES agents(name),
        claimed_by_session TEXT REFERENCES sessions(id),
        lease_expires_at INTEGER,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO tasks VALUES
        ('task_legacy', 'Legacy task', '', 'ready', 'normal', 'legacy-agent', NULL, NULL, 1, 1, 1);

      CREATE TABLE path_claims (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        comparison_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent_name TEXT NOT NULL REFERENCES agents(name),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO path_claims VALUES
        ('claim_legacy', 'src', 'src', 'tree', 'legacy-agent', 'session_legacy', 2, 1);

      CREATE TABLE policy_acks (
        policy_hash TEXT NOT NULL,
        agent_name TEXT NOT NULL REFERENCES agents(name),
        acknowledged_at INTEGER NOT NULL,
        PRIMARY KEY (policy_hash, agent_name)
      ) STRICT;
      INSERT INTO policy_acks VALUES ('hash', 'legacy-agent', 1);

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO events
        (id, kind, actor, entity_type, entity_id, payload_json, created_at)
      VALUES ('event_legacy', 'task.created', 'legacy-agent', 'task', 'task_legacy', '{}', 1);
    `);
    legacy.close();

    const migrated = openDatabase(context, { now: 100 });
    const worktree = migrated.prepare('SELECT id FROM worktrees').get() as { id: string };
    expect(migrated.prepare('SELECT id, home_worktree_id FROM sessions').get()).toEqual({
      id: 'session_legacy',
      home_worktree_id: worktree.id,
    });
    expect(migrated.prepare('SELECT id, worktree_id FROM path_claims').get()).toEqual({
      id: 'claim_legacy',
      worktree_id: worktree.id,
    });
    expect(migrated.prepare('SELECT policy_hash, worktree_id FROM policy_acks').get()).toEqual({
      policy_hash: 'hash',
      worktree_id: worktree.id,
    });
    expect(migrated.prepare('SELECT task_id, worktree_id FROM task_worktrees').get()).toEqual({
      task_id: 'task_legacy',
      worktree_id: worktree.id,
    });
    expect(migrated.prepare('SELECT id, worktree_id FROM events').get()).toEqual({
      id: 'event_legacy',
      worktree_id: worktree.id,
    });
    expect(migrated.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    migrated.close();
  });

  it('initializes an explicitly identified workspace member', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const context = resolveRepository(repository.root);
    const databasePath = path.join(context.privateGitDirectory, 'sametree', 'explicit.sqlite3');
    const database = openDatabase(context, {
      databasePath,
      now: 100,
      member: {
        workspaceId: 'workspace_test',
        workspaceName: 'Test workspace',
        workspaceImplicit: false,
        repositoryId: 'repository_test',
        repositoryName: 'Studio',
        worktreeId: 'worktree_test',
        worktreeName: 'studio',
      },
    });

    expect(database.prepare('SELECT id, name, implicit FROM workspace_metadata').get()).toEqual({
      id: 'workspace_test',
      name: 'Test workspace',
      implicit: 0,
    });
    expect(database.prepare('SELECT id, name FROM repositories').get()).toEqual({
      id: 'repository_test',
      name: 'Studio',
    });
    expect(database.prepare('SELECT id, name FROM worktrees').get()).toEqual({
      id: 'worktree_test',
      name: 'studio',
    });
    database.close();
  });

  it('rejects member ID collisions atomically inside database initialization', () => {
    const first = createTestRepository();
    const second = createTestRepository();
    repositories.push(first, second);
    const firstContext = resolveRepository(first.root);
    const secondContext = resolveRepository(second.root);
    const databasePath = path.join(firstContext.privateGitDirectory, 'sametree', 'shared.sqlite3');
    const member = {
      workspaceId: 'workspace_test',
      workspaceName: 'Test workspace',
      workspaceImplicit: false,
      repositoryId: 'repository_test',
      repositoryName: 'Studio',
      worktreeId: 'worktree_test',
      worktreeName: 'studio',
    } as const;
    openDatabase(firstContext, { databasePath, member }).close();

    expect(() => openDatabase(secondContext, { databasePath, member })).toThrow(
      /Repository identity collision/u,
    );
    const verification = new Database(databasePath, { readonly: true });
    expect(verification.prepare('SELECT common_git_directory FROM repositories').get()).toEqual({
      common_git_directory: firstContext.commonGitDirectory,
    });
    expect(verification.prepare('SELECT private_git_directory FROM worktrees').get()).toEqual({
      private_git_directory: firstContext.privateGitDirectory,
    });
    verification.close();
  });
});
