import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertSafeWritePath, claimsOverlap, normalizeClaim } from '../src/paths.js';

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

  it('keeps final symlinks lexical and rejects dangling symlink parents', () => {
    const root = temporaryDirectory('sametree-symlink-');
    const target = path.join(root, 'target.ts');
    writeFileSync(target, '');
    symlinkSync('target.ts', path.join(root, 'link.ts'));
    symlinkSync('missing', path.join(root, 'dangling'));

    expect(normalizeClaim(root, 'link.ts', 'exact', false).path).toBe('link.ts');
    expect(() => normalizeClaim(root, 'dangling/new.ts', 'exact', false)).toThrow(/dangling/u);
    expect(() => assertSafeWritePath(root, 'link.ts')).toThrow(/symbolic link/u);
  });

  it('canonicalizes parent aliases and rejects external tree symlinks', () => {
    const root = temporaryDirectory('sametree-alias-');
    const outside = temporaryDirectory('sametree-external-');
    mkdirSync(path.join(root, 'real'));
    symlinkSync('real', path.join(root, 'alias'));
    symlinkSync(outside, path.join(root, 'external'));

    expect(normalizeClaim(root, 'alias/shared.ts', 'exact', false).comparisonPath).toBe(
      'real/shared.ts',
    );
    expect(() => normalizeClaim(root, 'alias', 'tree', false)).toThrow(/symbolic link/u);
    expect(() => normalizeClaim(root, 'external', 'tree', false)).toThrow(/symbolic link/u);
  });

  it('compares every claim combination symmetrically at component boundaries', () => {
    const exact = (comparisonPath: string) => ({ comparisonPath, kind: 'exact' as const });
    const tree = (comparisonPath: string) => ({ comparisonPath, kind: 'tree' as const });
    const cases = [
      [exact('src/api.ts'), exact('src/api.ts'), true],
      [exact('src/api.ts'), exact('src/other.ts'), false],
      [tree('src'), exact('src/api.ts'), true],
      [tree('src'), tree('src/api'), true],
      [tree('src/api'), tree('src'), true],
      [tree('src'), tree('test'), false],
      [tree('src'), exact('src-old/api.ts'), false],
      [tree('.'), exact('README.md'), true],
    ] as const;

    for (const [left, right, expected] of cases) {
      expect(claimsOverlap(left, right)).toBe(expected);
      expect(claimsOverlap(right, left)).toBe(expected);
    }
  });

  it('supports case-insensitive repository comparison keys', () => {
    const root = temporaryDirectory('sametree-case-');
    writeFileSync(path.join(root, 'README.md'), '');

    expect(normalizeClaim(root, 'README.md', 'exact', true).comparisonPath).toBe('readme.md');
  });
});
