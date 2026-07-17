import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { initializeProject } from '../src/project.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const outsideDirectories: string[] = [];

function outsideDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sametree-outside-'));
  outsideDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of outsideDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generated state paths', () => {
  it('refuses to initialize through a symlinked policy directory', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    rmSync(path.join(repository.root, '.sametree'), { recursive: true });
    symlinkSync(outsideDirectory(), path.join(repository.root, '.sametree'));

    expect(() => initializeProject(repository.root)).toThrow(/symbolic link/u);
  });

  it('refuses a symlinked private database directory', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    symlinkSync(outsideDirectory(), path.join(repository.root, '.git', 'sametree'));

    expect(() => Coordinator.open({ cwd: repository.root, agent: 'agent' })).toThrow(
      /symlinked database path/u,
    );
  });

  it('refuses symlink ancestors in explicit database paths', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    symlinkSync(outsideDirectory(), path.join(repository.root, 'redirect'));

    expect(() =>
      Coordinator.open({
        cwd: repository.root,
        agent: 'agent',
        databasePath: path.join(repository.root, 'redirect', 'nested', 'state.sqlite3'),
      }),
    ).toThrow(/symlinked database path/u);
  });
});
