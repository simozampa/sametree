import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_DIRECTORY, CONFIG_FILE, DEFAULT_CONFIG, POLICY_FILE } from './config.js';
import { resolveRepository } from './git.js';
import {
  configTemplate,
  IMPLEMENTER_ROLE_TEMPLATE,
  INTEGRATION_TEMPLATE,
  POLICY_TEMPLATE,
  REVIEWER_ROLE_TEMPLATE,
} from './templates.js';

export interface InitializationResult {
  repositoryRoot: string;
  created: string[];
  preserved: string[];
}

function writeProjectFile(
  repositoryRoot: string,
  relativePath: string,
  content: string,
  force: boolean,
  result: InitializationResult,
): void {
  const target = path.join(repositoryRoot, relativePath);
  try {
    if (!force) {
      readFileSync(target);
      result.preserved.push(relativePath);
      return;
    }
  } catch {
    // A missing file is the expected path on first initialization.
  }

  writeFileSync(target, content, { encoding: 'utf8', mode: 0o644 });
  result.created.push(relativePath);
}

/** Create versioned policy files without touching existing agent instructions. */
export function initializeProject(
  cwd = process.cwd(),
  options: { force?: boolean } = {},
): InitializationResult {
  const repository = resolveRepository(cwd);
  const force = options.force ?? false;
  const result: InitializationResult = {
    repositoryRoot: repository.root,
    created: [],
    preserved: [],
  };

  mkdirSync(path.join(repository.root, CONFIG_DIRECTORY, 'roles'), {
    recursive: true,
    mode: 0o755,
  });
  writeProjectFile(repository.root, CONFIG_FILE, configTemplate(DEFAULT_CONFIG), force, result);
  writeProjectFile(repository.root, POLICY_FILE, POLICY_TEMPLATE, force, result);
  writeProjectFile(
    repository.root,
    path.join(CONFIG_DIRECTORY, 'coordination.md'),
    INTEGRATION_TEMPLATE,
    force,
    result,
  );
  writeProjectFile(
    repository.root,
    path.join(CONFIG_DIRECTORY, 'roles', 'implementer.md'),
    IMPLEMENTER_ROLE_TEMPLATE,
    force,
    result,
  );
  writeProjectFile(
    repository.root,
    path.join(CONFIG_DIRECTORY, 'roles', 'reviewer.md'),
    REVIEWER_ROLE_TEMPLATE,
    force,
    result,
  );
  return result;
}
