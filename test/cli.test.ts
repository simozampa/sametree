import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { resolveRepository } from '../src/git.js';
import { VERSION } from '../src/version.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const cliPath = path.resolve('dist/cli.js');

interface ProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runCli(
  root: string,
  agent: string | undefined,
  args: string[],
  input = '',
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, '--cwd', root, ...(agent ? ['--agent', agent] : []), ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('CLI', () => {
  it('reports the package version', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    expect(await runCli(repository.root, undefined, ['--version'])).toMatchObject({
      code: 0,
      stderr: '',
      stdout: `${VERSION}\n`,
    });
  });

  it('returns machine-readable status', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-agent', ['status']);
    const output = JSON.parse(result.stdout) as {
      agent: { name: string };
      claims: unknown[];
      git: { branch: string | null; commit: string | null; root: string };
    };

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(output.agent.name).toBe('cli-agent');
    expect(output.claims).toEqual([]);
    expect(output.git).toMatchObject({ branch: 'main', commit: null, root: repository.root });
  });

  it('runs doctor without an agent or session registration', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, undefined, ['doctor']);
    const output = JSON.parse(result.stdout) as { ok: boolean; repositoryRoot: string };
    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    const agents = database.prepare('SELECT COUNT(*) AS count FROM agents').get();
    const sessions = database.prepare('SELECT COUNT(*) AS count FROM sessions').get();
    database.close();

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(output).toMatchObject({ ok: true, repositoryRoot: repository.root });
    expect(agents).toEqual({ count: 0 });
    expect(sessions).toEqual({ count: 0 });
  });

  it('creates and reports an explicitly fresh workspace', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const registry = path.join(repository.root, '.workspace-registry');

    const created = await runCli(repository.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'create',
      'Product',
      '--member',
      'frontend',
      '--fresh',
    ]);
    const result = JSON.parse(created.stdout) as {
      workspace: { id: string };
      member: { name: string };
    };
    const status = await runCli(repository.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'status',
    ]);
    const doctor = await runCli(repository.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'doctor',
    ]);
    const repositoryDoctor = await runCli(repository.root, undefined, [
      '--workspace-registry',
      registry,
      'doctor',
    ]);

    expect(created).toMatchObject({ code: 0, stderr: '' });
    expect(result.member.name).toBe('frontend');
    expect(JSON.parse(status.stdout)).toMatchObject({
      bound: true,
      workspace: { id: result.workspace.id, name: 'Product' },
      member: { name: 'frontend' },
    });
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, warnings: [] });
    expect(JSON.parse(repositoryDoctor.stdout)).toMatchObject({
      ok: true,
      databasePath: expect.stringContaining(result.workspace.id),
    });
  });

  it('initializes members, resolves workspace names, and explains path-like references', async () => {
    const frontend = createTestRepository({ initialize: false });
    const server = createTestRepository({ initialize: false });
    const invalid = createTestRepository({ initialize: false });
    const invalidName = createTestRepository({ initialize: false });
    repositories.push(frontend, server, invalid, invalidName);
    const registry = path.join(frontend.root, '.workspace-registry');

    const created = await runCli(frontend.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'create',
      'Product',
      '--member',
      'frontend',
      '--fresh',
    ]);
    const added = await runCli(server.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'add',
      'Product',
      '--member',
      'backend',
      '--fresh',
    ]);
    const pathLike = await runCli(invalid.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'add',
      '../backend',
      '--member',
      'invalid',
      '--fresh',
    ]);
    const pathLikeName = await runCli(invalidName.root, undefined, [
      '--workspace-registry',
      registry,
      'workspace',
      'create',
      '.Product',
      '--member',
      'invalid-name',
      '--fresh',
    ]);

    expect(created).toMatchObject({ code: 0, stderr: '' });
    expect(added).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(added.stdout)).toMatchObject({
      workspace: { name: 'Product' },
      member: { name: 'backend' },
      initialization: { created: expect.arrayContaining(['.sametree/config.json']) },
    });
    expect(existsSync(path.join(frontend.root, '.sametree', 'config.json'))).toBe(true);
    expect(existsSync(path.join(server.root, '.sametree', 'config.json'))).toBe(true);
    expect(pathLike.code).toBe(1);
    expect(JSON.parse(pathLike.stderr)).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('looks like a path'),
      },
    });
    expect(existsSync(path.join(invalid.root, '.sametree', 'config.json'))).toBe(false);
    expect(pathLikeName.code).toBe(1);
    expect(JSON.parse(pathLikeName.stderr)).toMatchObject({
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('cannot start') },
    });
    expect(existsSync(path.join(invalidName.root, '.sametree', 'config.json'))).toBe(false);

    const coordinator = Coordinator.open({
      cwd: server.root,
      agent: 'server-agent',
      workspaceRegistryRoot: registry,
    });
    expect(coordinator.acquireClaims([{ member: 'frontend', path: 'src/shared.ts' }])).toHaveLength(
      1,
    );
    coordinator.close();
  });

  it('requires an explicit workspace state mode', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, undefined, [
      '--workspace-registry',
      path.join(repository.root, '.workspace-registry'),
      'workspace',
      'create',
      'Product',
      '--member',
      'frontend',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('exactly one') },
      ok: false,
    });
  });

  it('omits lifecycle events for one-shot commands but keeps their session rows', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'quiet-cli', [
      'task',
      'create',
      '--title',
      'Quiet command',
    ]);
    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    const events = database
      .prepare('SELECT kind FROM events WHERE actor = ? ORDER BY sequence')
      .all('quiet-cli') as Array<{ kind: string }>;
    const sessions = database
      .prepare('SELECT status FROM sessions WHERE agent_name = ?')
      .all('quiet-cli');
    database.close();

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(events).toEqual([{ kind: 'task.created' }]);
    expect(sessions).toEqual([{ status: 'closed' }]);
  });

  it('rejects peer task assignment', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const peer = Coordinator.open({ cwd: repository.root, agent: 'peer' });
    peer.close();

    const result = await runCli(repository.root, 'author', [
      'task',
      'create',
      '--title',
      'Assign a peer',
      '--assignee',
      'peer',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('USER_AUTHORIZATION_REQUIRED');
  });

  it('grants exactly one of two competing process claims', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const results = await Promise.all([
      runCli(repository.root, 'agent-a', ['claim', 'acquire', 'shared.ts']),
      runCli(repository.root, 'agent-b', ['claim', 'acquire', 'shared.ts']),
    ]);

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    const failure = results.find((result) => result.code !== 0);
    expect(failure?.stderr).toContain('CLAIM_CONFLICT');
  });

  it('opens a fresh database concurrently without leaking lock errors', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        runCli(repository.root, `starter-${index}`, [
          'claim',
          'acquire',
          `src/startup-${index}.ts`,
        ]),
      ),
    );

    for (const result of results) expect(result).toMatchObject({ code: 0, stderr: '' });
    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    database.close();
  });

  it('returns a compact claim acquisition receipt', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const member = path.basename(repository.root);
    const result = await runCli(repository.root, 'claimant', [
      'claim',
      'acquire',
      '--at',
      `${member}:src/api.ts`,
    ]);
    const output = JSON.parse(result.stdout) as Array<Record<string, unknown>>;

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(Object.keys(output[0] ?? {}).sort()).toEqual([
      'expiresAt',
      'id',
      'kind',
      'member',
      'path',
      'warnings',
    ]);
    expect(output[0]?.member).toBe(member);
  });

  it('forcibly takes over active work with explicit user authorization', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const owner = Coordinator.open({ cwd: repository.root, agent: 'owner' });
    const active = owner.claimTask(owner.createTask({ title: 'CLI takeover' }).id);
    const [claim] = owner.acquireClaims([{ path: 'src/cli-takeover.ts' }]);
    owner.close();
    if (!claim) throw new Error('Expected an active claim.');

    const result = await runCli(repository.root, 'replacement', [
      'task',
      'force-takeover',
      active.id,
      '--revision',
      String(active.revision),
      '--reason',
      'The user reassigned this task.',
      '--user-authorized',
      '--claim',
      claim.id,
    ]);
    const output = JSON.parse(result.stdout) as {
      claims: Array<{ agentName: string; id: string }>;
      task: { assignee: string };
    };

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(output.task.assignee).toBe('replacement');
    expect(output.claims).toEqual([
      expect.objectContaining({ id: claim.id, agentName: 'replacement' }),
    ]);
  });

  it('grants exactly one of two competing forced takeovers', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const owner = Coordinator.open({ cwd: repository.root, agent: 'owner' });
    const active = owner.claimTask(owner.createTask({ title: 'Contended CLI takeover' }).id);
    owner.close();
    const args = [
      'task',
      'force-takeover',
      active.id,
      '--revision',
      String(active.revision),
      '--reason',
      'The user requested one replacement.',
      '--user-authorized',
    ];

    const results = await Promise.all([
      runCli(repository.root, 'replacement-a', args),
      runCli(repository.root, 'replacement-b', args),
    ]);

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    const failure = results.find((result) => result.code !== 0);
    expect(failure?.stderr).toContain('TASK_UNAVAILABLE');
  });

  it('returns one structured error for invalid commands', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-agent', ['--unknown']);
    const error = JSON.parse(result.stderr) as { error: { code: string } };

    expect(result.code).not.toBe(0);
    expect(error.error.code).toBe('INTERNAL_ERROR');
  });

  it('keeps streaming session rows without lifecycle events', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-observer', ['watch', '--once', '--json']);
    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    const events = database
      .prepare('SELECT kind FROM events WHERE actor = ? ORDER BY sequence')
      .all('cli-observer');
    const sessions = database
      .prepare('SELECT status FROM sessions WHERE agent_name = ?')
      .all('cli-observer');
    database.close();

    expect(result).toMatchObject({ code: 0, stderr: '', stdout: '' });
    expect(events).toEqual([]);
    expect(sessions).toEqual([{ status: 'closed' }]);
  });

  it('rejects conflicting watch cursors', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-observer', [
      'watch',
      '--once',
      '--tail',
      '--after',
      '1',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Watch options '--after' and '--tail' cannot be used together.",
    );
  });

  it('follows unread messages once as JSON Lines', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const recipient = Coordinator.open({ cwd: repository.root, agent: 'cli-recipient' });
    recipient.close();
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender' });
    const message = sender.sendMessage({
      to: 'cli-recipient',
      subject: 'CLI delivery',
      body: 'Deliver across the process boundary.',
    });
    sender.close();

    const result = await runCli(
      repository.root,
      'cli-recipient',
      ['message', 'follow', '--once', '--json', '--ack-stdin'],
      `${message.id}\n`,
    );

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: message.id, readAt: null });
    expect(
      await runCli(repository.root, 'cli-recipient', ['message', 'follow', '--once', '--json']),
    ).toMatchObject({ code: 0, stderr: '', stdout: '' });
  });
});
