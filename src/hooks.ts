import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { SameTreeError } from './errors.js';
import { resolveRepository, stagedChangedLines, stagedFiles } from './git.js';
import { claimsOverlap, normalizeClaim } from './paths.js';
import type { PathClaim } from './types.js';

const HOOK_MARKER = '# managed-by-sametree';

const PRE_COMMIT_HOOK = `#!/bin/sh
${HOOK_MARKER}
command -v sametree >/dev/null 2>&1 || {
  echo "SameTree: 'sametree' is not on PATH; refusing to skip coordination checks." >&2
  exit 1
}
exec sametree hook pre-commit
`;

const COMMIT_MESSAGE_HOOK = `#!/bin/sh
${HOOK_MARKER}
command -v sametree >/dev/null 2>&1 || {
  echo "SameTree: 'sametree' is not on PATH; refusing to skip policy checks." >&2
  exit 1
}
exec sametree hook commit-msg "$1"
`;

export interface HookInstallationResult {
  installed: string[];
  preserved: string[];
}

/** Install only into empty or already-managed hook slots; never overwrite user hooks. */
export function installHooks(cwd = process.cwd()): HookInstallationResult {
  const repository = resolveRepository(cwd);
  mkdirSync(repository.hooksPath, { recursive: true, mode: 0o755 });
  const result: HookInstallationResult = { installed: [], preserved: [] };

  for (const [name, content] of [
    ['pre-commit', PRE_COMMIT_HOOK],
    ['commit-msg', COMMIT_MESSAGE_HOOK],
  ] as const) {
    const target = path.join(repository.hooksPath, name);
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(HOOK_MARKER)) {
      result.preserved.push(target);
      continue;
    }
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o755 });
    chmodSync(target, 0o755);
    result.installed.push(target);
  }

  return result;
}

export function checkPreCommit(
  claims: PathClaim[],
  agentName: string,
  cwd = process.cwd(),
): { changedLines: number; stagedFiles: string[] } {
  if (!agentName) {
    throw new SameTreeError(
      'AGENT_REQUIRED',
      'Set SAMETREE_AGENT to your registered agent name before committing.',
    );
  }

  const repository = resolveRepository(cwd);
  const config = loadConfig(repository.root);
  const files = stagedFiles(repository.root);
  const changedLines = stagedChangedLines(repository.root);

  if (changedLines > config.maxStagedLines) {
    throw new SameTreeError(
      'HOOK_REFUSED',
      `The staged diff has ${changedLines} changed lines; policy allows ${config.maxStagedLines}.`,
      { changedLines, maxStagedLines: config.maxStagedLines },
    );
  }

  for (const file of files) {
    const staged = normalizeClaim(repository.root, file, 'exact', repository.ignoreCase);
    const conflicting = claims.find(
      (claim) =>
        claim.agentName !== agentName &&
        claimsOverlap(staged, {
          comparisonPath: repository.ignoreCase
            ? claim.path.toLocaleLowerCase('en-US')
            : claim.path,
          kind: claim.kind,
        }),
    );
    if (conflicting) {
      throw new SameTreeError(
        'HOOK_REFUSED',
        `${file} overlaps ${conflicting.agentName}'s active ${conflicting.kind} claim on ${conflicting.path}.`,
        { file, conflictingClaim: conflicting },
      );
    }
  }

  return { changedLines, stagedFiles: files };
}

export function checkCommitMessage(messagePath: string, cwd = process.cwd()): { valid: true } {
  const repository = resolveRepository(cwd);
  const config = loadConfig(repository.root);
  const message = readFileSync(messagePath, 'utf8');
  const subject = message.split('\n', 1)[0]?.trim() ?? '';

  if (config.forbidCoAuthoredBy && /^co-authored-by:/imu.test(message)) {
    throw new SameTreeError('HOOK_REFUSED', 'Co-authored-by trailers are forbidden by policy.');
  }

  const conventional =
    /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: .+/u;
  if (config.requireConventionalCommits && !conventional.test(subject)) {
    throw new SameTreeError(
      'HOOK_REFUSED',
      'Use a Conventional Commit subject, for example: feat: add inbox polling',
      { subject },
    );
  }
  return { valid: true };
}
