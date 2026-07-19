import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { SameTreeError } from './errors.js';
import type { GitWorktreeContext } from './types.js';

export interface RepositoryContext {
  root: string;
  databasePath: string;
  hooksPath: string;
  ignoreCase: boolean;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new SameTreeError('NOT_GIT_REPOSITORY', 'SameTree must run inside a Git working tree.', {
      cwd,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveRepository(cwd = process.cwd()): RepositoryContext {
  if (git(cwd, ['rev-parse', '--is-bare-repository']) === 'true') {
    throw new SameTreeError(
      'NOT_GIT_REPOSITORY',
      'Bare repositories do not have a shared working tree.',
    );
  }

  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const privateGitDirectory = path.resolve(git(root, ['rev-parse', '--absolute-git-dir']));
  const databasePath = path.join(privateGitDirectory, 'sametree', 'state.sqlite3');
  const configuredHooksPath = gitConfig(root, 'core.hooksPath', 'path');
  const hooksPath = configuredHooksPath
    ? path.resolve(root, configuredHooksPath)
    : path.resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']));

  return {
    root,
    databasePath,
    hooksPath,
    ignoreCase: gitConfig(root, 'core.ignorecase', 'bool') === 'true',
  };
}

export function gitConfig(cwd: string, key: string, type?: 'bool' | 'path'): string | null {
  try {
    const value = execFileSync('git', ['config', ...(type ? [`--${type}`] : []), '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function readGitWorktreeContext(repositoryRoot: string): GitWorktreeContext {
  const lines = git(repositoryRoot, [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
    '--no-ahead-behind',
    '--untracked-files=normal',
  ]).split('\n');
  const oidPrefix = '# branch.oid ';
  const headPrefix = '# branch.head ';
  const oid = lines.find((line) => line.startsWith(oidPrefix))?.slice(oidPrefix.length);
  const head = lines.find((line) => line.startsWith(headPrefix))?.slice(headPrefix.length);
  if (!oid || !head) {
    throw new SameTreeError('NOT_GIT_REPOSITORY', 'Git did not report worktree HEAD state.');
  }
  const detached = head === '(detached)';
  return {
    root: realpathSync(repositoryRoot),
    branch: detached ? null : head,
    commit: oid === '(initial)' ? null : oid,
    detached,
    dirty: lines.some((line) => line.length > 0 && !line.startsWith('# ')),
  };
}

export function stagedFiles(repositoryRoot: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-status', '-z', '--diff-filter=ACDMRTUXB'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const tokens = output.split('\0');
  const files: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index++];
    if (!token) continue;

    const tab = token.indexOf('\t');
    const status = tab === -1 ? token : token.slice(0, tab);
    const firstPath = tab === -1 ? tokens[index++] : token.slice(tab + 1);
    if (firstPath) files.push(firstPath);

    if (status.startsWith('R') || status.startsWith('C')) {
      const secondPath = tokens[index++];
      if (secondPath) files.push(secondPath);
    }
  }
  return [...new Set(files)];
}

export function stagedChangedLines(repositoryRoot: string): number {
  const output = execFileSync('git', ['diff', '--cached', '--numstat', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let total = 0;
  const tokens = output.split('\0');
  for (let index = 0; index < tokens.length; ) {
    const entry = tokens[index++];
    if (!entry) continue;
    const [added, removed, file] = entry.split('\t');
    const additions = added === '-' ? 0 : Number(added);
    const deletions = removed === '-' ? 0 : Number(removed);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      throw new SameTreeError('HOOK_REFUSED', 'Git returned an invalid staged diff summary.');
    }
    total += additions + deletions;

    // With -z, renamed files use an empty path followed by old and new path fields.
    if (file === '') index += 2;
  }
  return total;
}
