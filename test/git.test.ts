import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { readGitWorktreeContext } from '../src/git.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('Git worktree context', () => {
  it('reports unborn, dirty, committed, and detached states', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);

    expect(readGitWorktreeContext(repository.root)).toEqual({
      root: repository.root,
      branch: 'main',
      commit: null,
      detached: false,
      dirty: false,
    });

    writeFileSync(`${repository.root}/tracked.txt`, 'content\n');
    expect(readGitWorktreeContext(repository.root).dirty).toBe(true);
    git(repository.root, ['add', 'tracked.txt']);
    git(repository.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initial commit',
    ]);
    const commit = git(repository.root, ['rev-parse', 'HEAD']);
    expect(readGitWorktreeContext(repository.root)).toMatchObject({
      branch: 'main',
      commit,
      detached: false,
      dirty: false,
    });

    git(repository.root, ['checkout', '--detach']);
    expect(readGitWorktreeContext(repository.root)).toMatchObject({
      branch: null,
      commit,
      detached: true,
      dirty: false,
    });
  });

  it('refreshes Git state for every coordination snapshot', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    git(repository.root, ['add', '.']);
    git(repository.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initialize repository',
    ]);
    const coordinator = Coordinator.open({ cwd: repository.root, agent: 'observer' });
    coordinators.push(coordinator);

    expect(coordinator.snapshot().git).toMatchObject({ branch: 'main', dirty: false });
    writeFileSync(`${repository.root}/untracked.txt`, 'change\n');
    expect(coordinator.snapshot().git).toMatchObject({ branch: 'main', dirty: true });
  });
});
