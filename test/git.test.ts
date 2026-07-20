import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { readGitHeadContext, readGitWorktreeContext, resolveRepository } from '../src/git.js';
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
  it('discovers stable repository and private worktree directories', () => {
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

    const main = resolveRepository(repository.root);
    expect(main).toMatchObject({
      root: repository.root,
      commonGitDirectory: path.join(repository.root, '.git'),
      privateGitDirectory: path.join(repository.root, '.git'),
      linkedWorktree: false,
      head: {
        descriptor: 'ref: refs/heads/main',
        reference: 'refs/heads/main',
        branch: 'main',
        detached: false,
      },
    });

    const linkedRoot = `${repository.root}-linked`;
    const movedRoot = `${repository.root}-moved`;
    try {
      git(repository.root, ['worktree', 'add', '-b', 'feature', linkedRoot]);
      const linked = resolveRepository(linkedRoot);
      expect(linked).toMatchObject({
        root: linkedRoot,
        commonGitDirectory: main.commonGitDirectory,
        linkedWorktree: true,
        head: {
          descriptor: 'ref: refs/heads/feature',
          reference: 'refs/heads/feature',
          branch: 'feature',
          detached: false,
        },
      });
      expect(linked.privateGitDirectory).not.toBe(main.privateGitDirectory);
      expect(linked.databasePath).not.toBe(main.databasePath);

      git(repository.root, ['worktree', 'move', linkedRoot, movedRoot]);
      const moved = resolveRepository(movedRoot);
      expect(moved.root).toBe(movedRoot);
      expect(moved.privateGitDirectory).toBe(linked.privateGitDirectory);
      expect(moved.head.descriptor).toBe(linked.head.descriptor);
    } finally {
      try {
        git(repository.root, ['worktree', 'remove', '--force', movedRoot]);
      } catch {
        git(repository.root, ['worktree', 'remove', '--force', linkedRoot]);
      }
    }
  });

  it('reads branch changes from the private HEAD descriptor without tracking commits', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);
    const context = resolveRepository(repository.root);

    expect(readGitHeadContext(context.privateGitDirectory)).toEqual({
      descriptor: 'ref: refs/heads/main',
      reference: 'refs/heads/main',
      branch: 'main',
      detached: false,
    });

    writeFileSync(`${repository.root}/tracked.txt`, 'content\n');
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
    expect(readGitHeadContext(context.privateGitDirectory).descriptor).toBe('ref: refs/heads/main');

    git(repository.root, ['checkout', '-b', 'feature']);
    expect(readGitHeadContext(context.privateGitDirectory)).toMatchObject({
      descriptor: 'ref: refs/heads/feature',
      branch: 'feature',
    });

    git(repository.root, ['checkout', '--detach']);
    expect(readGitHeadContext(context.privateGitDirectory)).toEqual({
      descriptor: git(repository.root, ['rev-parse', 'HEAD']),
      reference: null,
      branch: null,
      detached: true,
    });
  });

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

    git(repository.root, ['checkout', '-b', '(detached)']);
    expect(readGitWorktreeContext(repository.root)).toMatchObject({
      branch: '(detached)',
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
