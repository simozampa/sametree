import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initializeProject } from '../src/project.js';

export interface TestRepository {
  root: string;
  cleanup: () => void;
}

export function createTestRepository(options: { initialize?: boolean } = {}): TestRepository {
  const root = mkdtempSync(path.join(tmpdir(), 'sametree-test-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  if (options.initialize ?? true) initializeProject(root);

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
