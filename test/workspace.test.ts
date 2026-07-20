import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRepository } from '../src/git.js';
import {
  bindWorktree,
  readRegisteredWorkspace,
  registerWorkspace,
  resolveRegisteredWorkspace,
  resolveWorkspaceBinding,
} from '../src/workspace.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commit(repository: TestRepository): void {
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
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('workspace registry', () => {
  it('resolves IDs and unique names without treating paths as workspace references', () => {
    const registryRoot = path.join(temporaryDirectory('sametree-registry-parent-'), 'workspaces');
    const first = registerWorkspace(
      { id: 'workspace_first', name: 'Product', createdAt: 1 },
      { registryRoot },
    );
    const second = registerWorkspace(
      { id: 'workspace_second', name: 'Product', createdAt: 2 },
      { registryRoot },
    );

    expect(resolveRegisteredWorkspace(first.id, { registryRoot })).toEqual(first);
    expect(() => resolveRegisteredWorkspace('Product', { registryRoot })).toThrow(/ambiguous/u);
    expect(() => resolveRegisteredWorkspace('../product', { registryRoot })).toThrow(
      /looks like a path/u,
    );
    writeFileSync(path.join(second.directory, 'workspace.json'), '{ invalid');
    expect(resolveRegisteredWorkspace(first.id, { registryRoot })).toEqual(first);
  });

  it('does not create registry state for an unbound legacy repository', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const registryRoot = path.join(temporaryDirectory('sametree-registry-parent-'), 'workspaces');

    expect(
      resolveWorkspaceBinding(resolveRepository(repository.root), { registryRoot }),
    ).toBeNull();
    expect(existsSync(registryRoot)).toBe(false);
  });

  it('registers workspaces and resolves a private worktree binding', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const registryRoot = path.join(temporaryDirectory('sametree-registry-parent-'), 'workspaces');
    const workspace = registerWorkspace(
      { id: 'workspace_test', name: 'Test workspace', createdAt: 123 },
      { registryRoot },
    );

    expect(workspace.databasePath).toBe(path.join(registryRoot, 'workspace_test', 'state.sqlite3'));
    expect(readRegisteredWorkspace('workspace_test', { registryRoot })).toEqual(workspace);

    const context = bindWorktree(
      resolveRepository(repository.root),
      {
        workspaceId: workspace.id,
        repositoryId: 'repository_main',
        repositoryName: 'Main',
        worktreeId: 'worktree_main',
        worktreeName: 'main',
      },
      { registryRoot },
    );
    expect(context).toEqual({
      workspace,
      repositoryId: 'repository_main',
      repositoryName: 'Main',
      repositoryBindingPresent: true,
      worktreeId: 'worktree_main',
      worktreeName: 'main',
    });
    expect(resolveWorkspaceBinding(resolveRepository(repository.root), { registryRoot })).toEqual(
      context,
    );
  });

  it('groups linked worktrees by repository while retaining identity after a move', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    commit(repository);
    const registryRoot = path.join(temporaryDirectory('sametree-registry-parent-'), 'workspaces');
    registerWorkspace(
      { id: 'workspace_test', name: 'Test workspace', createdAt: 123 },
      { registryRoot },
    );
    bindWorktree(
      resolveRepository(repository.root),
      {
        workspaceId: 'workspace_test',
        repositoryId: 'repository_shared',
        repositoryName: 'Shared',
        worktreeId: 'worktree_main',
        worktreeName: 'main',
      },
      { registryRoot },
    );

    const linkedRoot = `${repository.root}-linked`;
    const movedRoot = `${repository.root}-moved`;
    try {
      git(repository.root, ['worktree', 'add', '-b', 'feature', linkedRoot]);
      const linked = bindWorktree(
        resolveRepository(linkedRoot),
        {
          workspaceId: 'workspace_test',
          repositoryId: 'repository_shared',
          repositoryName: 'Shared',
          worktreeId: 'worktree_feature',
          worktreeName: 'feature',
        },
        { registryRoot },
      );
      expect(linked.repositoryId).toBe('repository_shared');
      expect(linked.worktreeId).toBe('worktree_feature');

      git(repository.root, ['worktree', 'move', linkedRoot, movedRoot]);
      expect(resolveWorkspaceBinding(resolveRepository(movedRoot), { registryRoot })).toEqual(
        linked,
      );
    } finally {
      try {
        git(repository.root, ['worktree', 'remove', '--force', movedRoot]);
      } catch {
        git(repository.root, ['worktree', 'remove', '--force', linkedRoot]);
      }
    }
  });

  it('refuses to replace repository or worktree identities', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const registryRoot = path.join(temporaryDirectory('sametree-registry-parent-'), 'workspaces');
    registerWorkspace(
      { id: 'workspace_test', name: 'Test workspace', createdAt: 123 },
      { registryRoot },
    );
    const resolved = resolveRepository(repository.root);
    bindWorktree(
      resolved,
      {
        workspaceId: 'workspace_test',
        repositoryId: 'repository_main',
        repositoryName: 'Main',
        worktreeId: 'worktree_main',
        worktreeName: 'main',
      },
      { registryRoot },
    );

    expect(() =>
      bindWorktree(
        resolved,
        {
          workspaceId: 'workspace_test',
          repositoryId: 'repository_other',
          repositoryName: 'Other',
          worktreeId: 'worktree_main',
          worktreeName: 'main',
        },
        { registryRoot },
      ),
    ).toThrow(/already has another identity/u);
    expect(() =>
      bindWorktree(
        resolved,
        {
          workspaceId: 'workspace_test',
          repositoryId: 'repository_main',
          repositoryName: 'Main',
          worktreeId: 'worktree_other',
          worktreeName: 'other',
        },
        { registryRoot },
      ),
    ).toThrow(/already has another identity/u);
  });
});
