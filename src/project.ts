import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_DIRECTORY, CONFIG_FILE, DEFAULT_CONFIG, POLICY_FILE } from './config.js';
import { writeTextFileAtomic } from './files.js';
import { resolveRepository } from './git.js';
import { assertSafeWritePath } from './paths.js';
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

export const PROJECT_FILE_TEMPLATES: ReadonlyArray<{
  relativePath: string;
  content: string;
}> = [
  { relativePath: CONFIG_FILE, content: configTemplate(DEFAULT_CONFIG) },
  { relativePath: POLICY_FILE, content: POLICY_TEMPLATE },
  { relativePath: path.join(CONFIG_DIRECTORY, 'coordination.md'), content: INTEGRATION_TEMPLATE },
  {
    relativePath: path.join(CONFIG_DIRECTORY, 'roles', 'implementer.md'),
    content: IMPLEMENTER_ROLE_TEMPLATE,
  },
  {
    relativePath: path.join(CONFIG_DIRECTORY, 'roles', 'reviewer.md'),
    content: REVIEWER_ROLE_TEMPLATE,
  },
];

function writeProjectFile(
  repositoryRoot: string,
  relativePath: string,
  content: string,
  force: boolean,
  result: InitializationResult,
  onFileWritten?: (relativePath: string, content: string) => void,
): void {
  const target = assertSafeWritePath(repositoryRoot, relativePath);
  if (!force) {
    try {
      writeFileSync(target, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      result.created.push(relativePath);
      onFileWritten?.(relativePath, content);
      return;
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EEXIST') throw error;
      // Confirm the existing path is a readable file rather than hiding an invalid target.
      readFileSync(target);
      result.preserved.push(relativePath);
      return;
    }
  }

  writeTextFileAtomic(target, content);
  result.created.push(relativePath);
  onFileWritten?.(relativePath, content);
}

function initializeProjectFiles(
  cwd: string,
  force: boolean,
  onFileWritten?: (relativePath: string, content: string) => void,
): InitializationResult {
  const repository = resolveRepository(cwd);
  const result: InitializationResult = {
    repositoryRoot: repository.root,
    created: [],
    preserved: [],
  };

  assertSafeWritePath(repository.root, CONFIG_DIRECTORY);
  mkdirSync(path.join(repository.root, CONFIG_DIRECTORY, 'roles'), {
    recursive: true,
    mode: 0o755,
  });
  for (const file of PROJECT_FILE_TEMPLATES) {
    writeProjectFile(
      repository.root,
      file.relativePath,
      file.content,
      force,
      result,
      onFileWritten,
    );
  }
  return result;
}

/** Create versioned policy files without touching existing agent instructions. */
export function initializeProject(
  cwd = process.cwd(),
  options: { force?: boolean } = {},
): InitializationResult {
  return initializeProjectFiles(cwd, options.force ?? false);
}

/** Track exact writes so setup can safely roll back only its own changes. */
export function initializeProjectTracked(
  cwd: string,
  onFileWritten: (relativePath: string, content: string) => void,
): InitializationResult {
  return initializeProjectFiles(cwd, false, onFileWritten);
}
