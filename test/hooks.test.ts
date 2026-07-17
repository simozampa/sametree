import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
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
});
