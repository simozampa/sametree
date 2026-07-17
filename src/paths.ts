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

function existingMetadata(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

/** Preserve the display path while resolving parent aliases for conflict comparison. */
function resolveSafely(
  repositoryRoot: string,
  input: string,
  kind: ClaimKind,
): { comparison: string; lexical: string } {
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, input);
  if (!isInside(root, absolute)) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path cannot leave the repository.', {
      path: input,
    });
  }

  const comparisonTarget = kind === 'tree' ? absolute : path.dirname(absolute);
  let existingAncestor = comparisonTarget;
  let metadata = existingMetadata(existingAncestor);
  while (!metadata && existingAncestor !== root) {
    existingAncestor = path.dirname(existingAncestor);
    metadata = existingMetadata(existingAncestor);
  }

  let resolvedAncestor: string;
  try {
    resolvedAncestor = realpathSync(existingAncestor);
  } catch {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path has a dangling symbolic link.', {
      path: input,
    });
  }
  if (existingAncestor !== comparisonTarget && !existingMetadata(resolvedAncestor)?.isDirectory()) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path has a non-directory parent.', {
      path: input,
    });
  }
  const resolvedTarget = path.resolve(
    resolvedAncestor,
    path.relative(existingAncestor, comparisonTarget),
  );
  if (!isInside(root, resolvedTarget)) {
    throw new SameTreeError('INVALID_INPUT', 'A claimed path resolves outside the repository.', {
      path: input,
    });
  }
  if (kind === 'tree') {
    const targetMetadata = existingMetadata(resolvedTarget);
    if (targetMetadata && !targetMetadata.isDirectory()) {
      throw new SameTreeError('INVALID_INPUT', 'A tree claim must refer to a directory path.', {
        path: input,
      });
    }
  }

  return {
    lexical: absolute,
    comparison:
      kind === 'tree' ? resolvedTarget : path.join(resolvedTarget, path.basename(absolute)),
  };
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

  const root = realpathSync(repositoryRoot);
  const resolved = resolveSafely(repositoryRoot, input.normalize('NFC'), kind);
  const relative = path.relative(root, resolved.lexical);
  const comparisonRelative = path.relative(root, resolved.comparison);
  const normalized = (relative || '.').split(path.sep).join('/').normalize('NFC');
  const comparison = (comparisonRelative || '.').split(path.sep).join('/').normalize('NFC');

  if (kind === 'exact' && normalized === '.') {
    throw new SameTreeError('INVALID_INPUT', 'The repository root can only be claimed as a tree.');
  }

  return {
    path: normalized,
    comparisonPath: ignoreCase ? comparison.toLocaleLowerCase('en-US') : comparison,
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
