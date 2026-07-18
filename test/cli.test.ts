import { spawn } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const cliPath = path.resolve('dist/cli.js');

interface ProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runCli(root: string, agent: string, args: string[], input = ''): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--cwd', root, '--agent', agent, ...args], {
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
    child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('CLI', () => {
  it('returns machine-readable status', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-agent', ['status']);
    const output = JSON.parse(result.stdout) as { agent: { name: string }; claims: unknown[] };

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(output.agent.name).toBe('cli-agent');
    expect(output.claims).toEqual([]);
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

  it('returns one structured error for invalid commands', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-agent', ['--unknown']);
    const error = JSON.parse(result.stderr) as { error: { code: string } };

    expect(result.code).not.toBe(0);
    expect(error.error.code).toBe('INTERNAL_ERROR');
  });

  it('emits watch events as JSON Lines', async () => {
    const repository = createTestRepository();
    repositories.push(repository);

    const result = await runCli(repository.root, 'cli-observer', ['watch', '--once', '--json']);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'session.started' })]),
    );
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
