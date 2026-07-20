import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Database as DatabaseType } from 'better-sqlite3';

import { loadConfig, POLICY_FILE } from './config.js';
import { openDatabase } from './database.js';
import { type RepositoryContext, resolveRepository } from './git.js';
import type { DoctorReport } from './types.js';
import { resolveWorkspaceBinding, type WorkspaceRegistryOptions } from './workspace.js';
import { assertWorkspaceBindingReady } from './workspace-service.js';

type Row = Record<string, unknown>;

export function inspectDatabase(
  database: DatabaseType,
  repository: RepositoryContext,
  databasePath = repository.databasePath,
): DoctorReport {
  const sqlite = database.prepare('SELECT sqlite_version() AS version').get() as Row;
  const integrity = database.pragma('integrity_check', { simple: true }) as string;
  const foreignKeys = database.pragma('foreign_key_check') as Row[];
  const journalMode = database.pragma('journal_mode', { simple: true }) as string;
  const policyPresent = existsSync(path.join(repository.root, POLICY_FILE));
  const warnings: string[] = [];
  if (journalMode.toLowerCase() !== 'wal') warnings.push('SQLite journal mode is not WAL.');
  if (!policyPresent) warnings.push(`Missing ${POLICY_FILE}; run 'sametree init'.`);

  return {
    ok: integrity === 'ok' && foreignKeys.length === 0 && warnings.length === 0,
    repositoryRoot: repository.root,
    databasePath,
    sqliteVersion: String(sqlite.version),
    journalMode,
    integrity,
    foreignKeyViolations: foreignKeys.length,
    policyPresent,
    warnings,
  };
}

export function diagnoseRepository(
  cwd = process.cwd(),
  options: WorkspaceRegistryOptions = {},
): DoctorReport {
  const repository = resolveRepository(cwd);
  loadConfig(repository.root);
  const workspace = resolveWorkspaceBinding(repository, options);
  if (workspace) assertWorkspaceBindingReady(repository, workspace);
  const databasePath = workspace?.workspace.databasePath ?? repository.databasePath;
  const database = openDatabase(repository, {
    databasePath,
    ...(workspace
      ? {
          member: {
            workspaceId: workspace.workspace.id,
            workspaceName: workspace.workspace.name,
            workspaceImplicit: false,
            repositoryId: workspace.repositoryId,
            repositoryName: workspace.repositoryName,
            worktreeId: workspace.worktreeId,
            worktreeName: workspace.worktreeName,
          },
        }
      : {}),
  });
  try {
    return inspectDatabase(database, repository, databasePath);
  } finally {
    database.close();
  }
}
