import { lstatSync, realpathSync } from 'node:fs';
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

/** Check existing parent components without replacing the repository path's identity. */
function resolveSafely(repositoryRoot: string, input: string): string {
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, input);
  if (!isInside(root, absolute)) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path cannot leave the repository.', {
      path: input,
    });
  }

  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT') break;
      throw new SameTreeError('INVALID_INPUT', 'A claimed path has an invalid parent.', {
        path: input,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (metadata.isSymbolicLink()) {
      try {
        const resolved = realpathSync(current);
        if (!isInside(root, resolved)) {
          throw new SameTreeError(
            'INVALID_INPUT',
            'A claimed path resolves outside the repository.',
            { path: input },
          );
        }
      } catch (error) {
        if (error instanceof SameTreeError) throw error;
        throw new SameTreeError('INVALID_INPUT', 'A claimed path has a dangling symbolic link.', {
          path: input,
        });
      }
    }
  }
  return absolute;
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

/** Refuse writes through symlinks, even when the resolved target remains inside the repository. */
export function assertSafeWritePath(repositoryRoot: string, target: string): string {
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, target);
  if (!isInside(root, absolute)) {
    throw new SameTreeError('INVALID_INPUT', 'A generated path cannot leave the repository.', {
      path: target,
    });
  }

  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SameTreeError('INVALID_INPUT', 'Refusing to write through a symbolic link.', {
          path: current,
        });
      }
    } catch (error) {
      if (error instanceof SameTreeError) throw error;
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT') break;
      throw error;
    }
  }
  return absolute;
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
