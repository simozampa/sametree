import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { resolveRepository, stagedChangedLines, stagedFiles } from '../src/git.js';
import { checkCommitMessage, checkPreCommit, installHooks } from '../src/hooks.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

function setup() {
  const repository = createTestRepository();
  repositories.push(repository);
  const owner = Coordinator.open({ cwd: repository.root, agent: 'owner' });
  const committer = Coordinator.open({ cwd: repository.root, agent: 'committer' });
  coordinators.push(owner, committer);
  return { repository, owner, committer };
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('Git hooks', () => {
  it('rejects staged files claimed by another agent', () => {
    const { repository, owner, committer } = setup();
    writeFileSync(path.join(repository.root, 'shared.ts'), 'export {};\n');
    execFileSync('git', ['add', 'shared.ts'], { cwd: repository.root });
    owner.acquireClaims([{ path: 'shared.ts' }]);

    expect(() =>
      checkPreCommit(committer.listClaims(), committer.agentName, repository.root),
    ).toThrowError(expect.objectContaining({ code: 'HOOK_REFUSED' }));
  });

  it('enforces conventional subjects and forbids co-author trailers', () => {
    const { repository } = setup();
    const messagePath = path.join(repository.root, 'COMMIT_EDITMSG');

    writeFileSync(messagePath, 'feat: add coordination\n');
    expect(checkCommitMessage(messagePath, repository.root)).toEqual({ valid: true });

    writeFileSync(messagePath, 'add coordination\n');
    expect(() => checkCommitMessage(messagePath, repository.root)).toThrow(/Conventional Commit/u);

    writeFileSync(
      messagePath,
      'feat: add coordination\n\nCo-authored-by: Agent <agent@example.com>\n',
    );
    expect(() => checkCommitMessage(messagePath, repository.root)).toThrow(/Co-authored-by/u);
  });

  it('does not overwrite an existing user hook', () => {
    const { repository } = setup();
    const hooksDirectory = path.join(repository.root, '.git', 'hooks');
    mkdirSync(hooksDirectory, { recursive: true });
    const existing = path.join(hooksDirectory, 'pre-commit');
    writeFileSync(existing, '#!/bin/sh\nexit 0\n');

    const result = installHooks(repository.root);

    expect(result.preserved).toContain(existing);
    expect(readFileSync(existing, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(result.installed.some((hook) => hook.endsWith('commit-msg'))).toBe(true);
  });

  it('checks deleted paths and both sides of a rename', () => {
    const { repository, owner, committer } = setup();
    const original = path.join(repository.root, 'original.ts');
    writeFileSync(original, 'export const value = 1;\n');
    execFileSync('git', ['add', 'original.ts'], { cwd: repository.root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'test: baseline',
      ],
      { cwd: repository.root, stdio: 'ignore' },
    );
    owner.acquireClaims([{ path: 'original.ts' }]);
    renameSync(original, path.join(repository.root, 'renamed.ts'));
    execFileSync('git', ['add', '--all'], { cwd: repository.root });

    expect(stagedFiles(repository.root)).toEqual(
      expect.arrayContaining(['original.ts', 'renamed.ts']),
    );
    expect(Number.isFinite(stagedChangedLines(repository.root))).toBe(true);
    expect(() =>
      checkPreCommit(committer.listClaims(), committer.agentName, repository.root),
    ).toThrowError(expect.objectContaining({ code: 'HOOK_REFUSED' }));
  });

  it('uses lexical symlink paths in pre-commit checks', () => {
    const { repository, owner, committer } = setup();
    writeFileSync(path.join(repository.root, 'target-a'), 'a');
    writeFileSync(path.join(repository.root, 'target-b'), 'b');
    symlinkSync('target-a', path.join(repository.root, 'current'));
    execFileSync('git', ['add', '.'], { cwd: repository.root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'test: baseline',
      ],
      { cwd: repository.root, stdio: 'ignore' },
    );
    owner.acquireClaims([{ path: 'current' }]);
    execFileSync('ln', ['-sfn', 'target-b', 'current'], { cwd: repository.root });
    execFileSync('git', ['add', 'current'], { cwd: repository.root });

    expect(() =>
      checkPreCommit(committer.listClaims(), committer.agentName, repository.root),
    ).toThrowError(expect.objectContaining({ code: 'HOOK_REFUSED' }));
  });

  it('uses Git path and Boolean configuration parsing', () => {
    const { repository } = setup();
    execFileSync('git', ['config', 'core.ignorecase', 'TRUE'], { cwd: repository.root });
    execFileSync('git', ['config', 'core.hooksPath', '~/central-hooks'], {
      cwd: repository.root,
    });

    const context = resolveRepository(repository.root);

    expect(context.ignoreCase).toBe(true);
    expect(context.hooksPath).toBe(path.join(process.env.HOME ?? '', 'central-hooks'));
  });

  it('refuses symlink hook targets', () => {
    const { repository } = setup();
    const outside = path.join(repository.root, 'outside-hook');
    writeFileSync(outside, `${'# managed-by-sametree'}\n`);
    symlinkSync(outside, path.join(repository.root, '.git', 'hooks', 'pre-commit'));

    expect(installHooks(repository.root).preserved).toContain(
      path.join(repository.root, '.git', 'hooks', 'pre-commit'),
    );
  });
});
