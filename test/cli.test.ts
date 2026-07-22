import { spawn } from 'node:child_process';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { resolveRepository } from '../src/git.js';
import { VERSION } from '../src/version.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const cliPath = path.resolve('dist/cli.js');
const claudePlanHookPath = path.resolve('plugins/sametree/hooks/publish-plan.mjs');
const claudeInstructionHookPath = path.resolve(
  'plugins/sametree/hooks/capture-shared-instruction.mjs',
);

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

function runClaudePlanHook(
  root: string,
  sametreeBin: string,
  input: Record<string, unknown>,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [claudePlanHookPath], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        SAMETREE_AGENT: '',
        SAMETREE_BIN: sametreeBin,
        SAMETREE_ROLE: 'implementer',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(input));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runClaudeInstructionHook(
  root: string,
  sametreeBin: string,
  input: Record<string, unknown>,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [claudeInstructionHookPath], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        SAMETREE_AGENT: '',
        SAMETREE_BIN: sametreeBin,
        SAMETREE_ROLE: 'implementer',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(input));
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

  it('publishes plan Markdown from stdin and exposes current summaries', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const body = '# CLI plan\n\n1. Inspect the contract.\n2. Add coverage.\n';
    const published = await runCli(
      repository.root,
      'planner',
      [
        '--harness',
        'opencode',
        'plan',
        'publish',
        '--source-session',
        'session-one',
        '--source-event',
        'message-one',
        '--body-stdin',
      ],
      body,
    );
    const plan = JSON.parse(published.stdout) as { id: string; revision: number };
    const listed = await runCli(repository.root, 'observer', ['plan', 'list']);
    const shown = await runCli(repository.root, 'observer', ['plan', 'show', plan.id]);

    expect(published).toMatchObject({ code: 0, stderr: '' });
    expect(plan.revision).toBe(1);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id: plan.id, revision: 1, title: 'CLI plan' }),
    ]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: plan.id, body: body.trim() });
  });

  it('records, acknowledges, revises, and revokes shared user instructions', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const body = 'For all agents: Preserve exact whitespace.\n  Including indentation.\n';
    const recorded = await runCli(
      repository.root,
      'instructor',
      [
        '--harness',
        'opencode',
        'instruction',
        'record',
        '--reason',
        'The user used the explicit shared-instruction prefix.',
        '--user-authorized',
        '--source-session',
        'session-one',
        '--source-event',
        'message-one',
        '--body-stdin',
      ],
      body,
    );
    const instruction = JSON.parse(recorded.stdout) as { id: string; revision: number };
    const listed = await runCli(repository.root, 'observer', ['instruction', 'list']);
    const shown = await runCli(repository.root, 'observer', [
      'instruction',
      'show',
      instruction.id,
    ]);
    const acknowledged = await runCli(repository.root, 'observer', [
      'instruction',
      'ack',
      instruction.id,
      '--revision',
      '1',
    ]);
    const revised = await runCli(repository.root, 'instructor', [
      'instruction',
      'revise',
      instruction.id,
      '--revision',
      '1',
      '--reason',
      'The user replaced the instruction.',
      '--user-authorized',
      '--body',
      'For all agents: Preserve behavior.',
    ]);
    const revoked = await runCli(repository.root, 'instructor', [
      'instruction',
      'revoke',
      instruction.id,
      '--revision',
      '2',
      '--reason',
      'The user revoked the instruction.',
      '--user-authorized',
    ]);

    expect(recorded).toMatchObject({ code: 0, stderr: '' });
    expect(instruction.revision).toBe(1);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id: instruction.id, acknowledgedAt: null, revision: 1 }),
    ]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: instruction.id, body });
    expect(JSON.parse(acknowledged.stdout)).toMatchObject({ newlyAcknowledged: true, revision: 1 });
    expect(JSON.parse(revised.stdout)).toMatchObject({ revision: 2, status: 'active' });
    expect(JSON.parse(revoked.stdout)).toMatchObject({ revision: 3, status: 'revoked' });
  });

  it('requires the explicit authorization flag to record an instruction', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const result = await runCli(repository.root, 'instructor', [
      'instruction',
      'record',
      '--reason',
      'Missing confirmation.',
      '--body',
      'For all agents: Do not record this.',
    ]);

    expect(result.code).not.toBe(0);
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    expect(observer.listSharedInstructions()).toEqual([]);
    observer.close();
  });

  it('captures only exactly prefixed Claude user prompts and preserves their text', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const ordinary = await runCli(
      repository.root,
      undefined,
      ['hook', 'claude-instruction'],
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-claude',
        prompt: 'for all agents: This lowercase prefix must not be captured.',
      }),
    );
    const body = 'For all agents: Run focused tests.\n  Keep this indentation.\n';
    const explicit = await runCli(
      repository.root,
      undefined,
      ['hook', 'claude-instruction'],
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-claude',
        prompt: body,
      }),
    );
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    const instructions = observer.listSharedInstructions();
    const summary = instructions[0];
    if (!summary) throw new Error('Expected the Claude hook to record an instruction.');
    const instruction = observer.getSharedInstruction(summary.id);
    observer.close();

    expect(ordinary).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(explicit).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(instructions).toHaveLength(1);
    expect(instruction).toMatchObject({
      body,
      createdBy: 'claude-code-session-claude',
      sourceHarness: 'claude-code',
      sourceSessionId: 'session-claude',
    });
  });

  it('captures an explicit prompt through the fail-open Claude instruction hook', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const result = await runClaudeInstructionHook(repository.root, cliPath, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-wrapper',
      prompt: 'For all agents: Keep public APIs stable.',
    });
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    const instructions = observer.listSharedInstructions();
    observer.close();

    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(instructions).toEqual([
      expect.objectContaining({
        createdBy: 'claude-code-session-wrapper',
        sourceSessionId: 'session-wrapper',
      }),
    ]);
  });

  it('fails open for instruction capture when the SameTree binary is missing', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    expect(
      await runClaudeInstructionHook(repository.root, '/missing/sametree', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-missing',
        prompt: 'For all agents: Keep going.',
      }),
    ).toEqual({ code: 0, stderr: '', stdout: '' });
  });

  it('publishes an ExitPlanMode payload without writing hook output', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const result = await runCli(
      repository.root,
      undefined,
      ['hook', 'claude-plan'],
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'session-claude',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'tool-plan-one',
        tool_input: { plan: '# Claude plan\n\n1. Implement it.' },
      }),
    );
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    const plans = observer.listPlans();
    const summary = plans[0];
    if (!summary) throw new Error('Expected the Claude hook to publish a plan.');
    const plan = observer.getPlan(summary.id);
    observer.close();

    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(plan).toMatchObject({
      author: 'claude-code-session-claude',
      body: '# Claude plan\n\n1. Implement it.',
      sourceHarness: 'claude-code',
      sourceEventId: 'tool-plan-one',
      sourceSessionId: 'session-claude',
    });
  });

  it('publishes an ExitPlanMode payload through the fail-open Claude hook', async () => {
    const original = createTestRepository();
    const root = `${original.root} with spaces & symbols`;
    renameSync(original.root, root);
    const repository = {
      root,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    repositories.push(repository);
    const result = await runClaudePlanHook(repository.root, cliPath, {
      hook_event_name: 'PreToolUse',
      session_id: 'session-wrapper',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'tool-wrapper',
      tool_input: { plan: '# Wrapper plan\n\n1. Publish without controlling Claude.' },
    });
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    const plans = observer.listPlans();
    observer.close();

    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(plans).toEqual([
      expect.objectContaining({
        author: 'claude-code-session-wrapper',
        sourceSessionId: 'session-wrapper',
        title: 'Wrapper plan',
      }),
    ]);
  });

  it('fails open when the SameTree binary is missing', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    expect(
      await runClaudePlanHook(repository.root, '/missing/sametree', {
        hook_event_name: 'PreToolUse',
        session_id: 'session-missing',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'tool-missing',
        tool_input: { plan: '# Missing binary' },
      }),
    ).toEqual({ code: 0, stderr: '', stdout: '' });
  });

  it('fails open when the SameTree database is locked', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const initialized = Coordinator.open({ cwd: repository.root, agent: 'initializer' });
    initialized.close();
    const database = new Database(resolveRepository(repository.root).databasePath);
    database.exec('BEGIN IMMEDIATE');
    let result: ProcessResult;
    try {
      result = await runClaudePlanHook(repository.root, cliPath, {
        hook_event_name: 'PreToolUse',
        session_id: 'session-locked',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'tool-locked',
        tool_input: { plan: '# Locked database' },
      });
    } finally {
      database.exec('ROLLBACK');
      database.close();
    }
    const observer = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    const plans = observer.listPlans();
    observer.close();

    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(plans).toEqual([]);
  });

  it('fails open within a bounded interval when SameTree hangs', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const hangingBin = path.join(repository.root, 'hanging-sametree.mjs');
    writeFileSync(hangingBin, 'setInterval(() => undefined, 1_000);\n');
    const startedAt = Date.now();

    const result = await runClaudePlanHook(repository.root, hangingBin, {
      hook_event_name: 'PreToolUse',
      session_id: 'session-hanging',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'tool-hanging',
      tool_input: { plan: '# Hanging binary' },
    });

    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
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
