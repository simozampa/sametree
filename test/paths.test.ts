import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { claimsOverlap, normalizeClaim } from '../src/paths.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('path claims', () => {
  it('normalizes repository-relative paths', () => {
    const root = temporaryDirectory('sametree-path-');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'index.ts'), '');

    expect(normalizeClaim(root, './src/../src/index.ts', 'exact', false)).toEqual({
      path: 'src/index.ts',
      comparisonPath: 'src/index.ts',
      kind: 'exact',
    });
  });

  it('rejects traversal and symlink escapes', () => {
    const root = temporaryDirectory('sametree-root-');
    const outside = temporaryDirectory('sametree-outside-');
    symlinkSync(outside, path.join(root, 'escaped'));

    expect(() => normalizeClaim(root, '../outside.ts', 'exact', false)).toThrow(/cannot leave/u);
    expect(() => normalizeClaim(root, 'escaped/new.ts', 'exact', false)).toThrow(
      /outside the repository/u,
    );
  });

  it('compares exact and recursive claims at component boundaries', () => {
    const exact = { comparisonPath: 'src/api.ts', kind: 'exact' as const };
    const tree = { comparisonPath: 'src', kind: 'tree' as const };
    const sibling = { comparisonPath: 'src-old/api.ts', kind: 'exact' as const };

    expect(claimsOverlap(exact, tree)).toBe(true);
    expect(claimsOverlap(tree, sibling)).toBe(false);
    expect(
      claimsOverlap(
        { comparisonPath: '.', kind: 'tree' },
        { comparisonPath: 'README.md', kind: 'exact' },
      ),
    ).toBe(true);
  });

  it('supports case-insensitive repository comparison keys', () => {
    const root = temporaryDirectory('sametree-case-');
    writeFileSync(path.join(root, 'README.md'), '');

    expect(normalizeClaim(root, 'README.md', 'exact', true).comparisonPath).toBe('readme.md');
  });
});
