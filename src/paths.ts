import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { SameTreeError } from './errors.js';
import type { ClaimKind } from './types.js';

export interface NormalizedClaim {
  path: string;
  comparisonPath: string;
  kind: ClaimKind;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

/**
 * Resolve through the deepest existing ancestor. This catches a claim for a
 * not-yet-created file below a symlink that escapes the repository.
 */
function resolveSafely(repositoryRoot: string, input: string): string {
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, input);
  if (!isInside(root, absolute)) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path cannot leave the repository.', {
      path: input,
    });
  }

  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, absolute));
  if (!isInside(root, resolved)) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path resolves outside the repository.', {
      path: input,
    });
  }
  return resolved;
}

export function normalizeClaim(
  repositoryRoot: string,
  input: string,
  kind: ClaimKind,
  ignoreCase: boolean,
): NormalizedClaim {
  if (!input.trim() || input.includes('\0')) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path must be a non-empty path.');
  }

  const resolved = resolveSafely(repositoryRoot, input.normalize('NFC'));
  const relative = path.relative(realpathSync(repositoryRoot), resolved);
  const normalized = (relative || '.').split(path.sep).join('/').normalize('NFC');

  if (kind === 'exact' && normalized === '.') {
    throw new SameTreeError('INVALID_INPUT', 'The repository root can only be claimed as a tree.');
  }

  return {
    path: normalized,
    comparisonPath: ignoreCase ? normalized.toLocaleLowerCase('en-US') : normalized,
    kind,
  };
}

function treeContains(tree: string, candidate: string): boolean {
  return tree === '.' || tree === candidate || candidate.startsWith(`${tree}/`);
}

export function claimsOverlap(
  left: Pick<NormalizedClaim, 'comparisonPath' | 'kind'>,
  right: Pick<NormalizedClaim, 'comparisonPath' | 'kind'>,
): boolean {
  if (left.kind === 'exact' && right.kind === 'exact') {
    return left.comparisonPath === right.comparisonPath;
  }
  if (left.kind === 'tree') return treeContains(left.comparisonPath, right.comparisonPath);
  return treeContains(right.comparisonPath, left.comparisonPath);
}
