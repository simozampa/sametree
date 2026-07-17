import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { SameTreeError } from './errors.js';

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
  const databasePath = path.resolve(
    git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'sametree/state.sqlite3']),
  );
  const configuredHooksPath = gitConfig(root, 'core.hooksPath');
  const hooksPath = configuredHooksPath
    ? path.resolve(root, configuredHooksPath)
    : path.resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']));

  return {
    root,
    databasePath,
    hooksPath,
    ignoreCase: gitConfig(root, 'core.ignorecase') === 'true',
  };
}

export function gitConfig(cwd: string, key: string): string | null {
  try {
    const value = execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function stagedFiles(repositoryRoot: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return output.split('\0').filter(Boolean);
}

export function stagedChangedLines(repositoryRoot: string): number {
  const output = execFileSync('git', ['diff', '--cached', '--numstat', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let total = 0;
  for (const entry of output.split('\0').filter(Boolean)) {
    const [added, removed] = entry.split('\t');
    total += added === '-' ? 0 : Number(added ?? 0);
    total += removed === '-' ? 0 : Number(removed ?? 0);
  }
  return total;
}
