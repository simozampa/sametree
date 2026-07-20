import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { SameTreeError } from './errors.js';
import type { RepositoryContext } from './git.js';

const REGISTRY_SCHEMA_VERSION = 1;
const BINDING_SCHEMA_VERSION = 1;
const WORKSPACE_METADATA_FILE = 'workspace.json';
const REPOSITORY_BINDING_FILE = 'repository.json';
const WORKTREE_BINDING_FILE = 'worktree.json';

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

const workspaceRegistrationSchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    id: identifierSchema,
    name: z.string().trim().min(1).max(100),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const repositoryBindingSchema = z
  .object({
    schemaVersion: z.literal(BINDING_SCHEMA_VERSION),
    workspaceId: identifierSchema,
    repositoryId: identifierSchema,
  })
  .strict();

const worktreeBindingSchema = repositoryBindingSchema
  .extend({ worktreeId: identifierSchema })
  .strict();

export type WorkspaceRegistration = z.infer<typeof workspaceRegistrationSchema>;
export type RepositoryWorkspaceBinding = z.infer<typeof repositoryBindingSchema>;
export type WorktreeWorkspaceBinding = z.infer<typeof worktreeBindingSchema>;

export interface RegisteredWorkspace extends WorkspaceRegistration {
  directory: string;
  databasePath: string;
}

export interface WorkspaceContext {
  workspace: RegisteredWorkspace;
  repositoryId: string;
  worktreeId: string;
}

export interface WorkspaceRegistryOptions {
  registryRoot?: string;
}

export interface BindWorktreeInput {
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (Reflect.get(error, 'code') as string | undefined) : undefined;
}

function parseValue<T>(value: unknown, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new SameTreeError('WORKSPACE_ERROR', `Invalid ${label}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseFile<T>(filePath: string, schema: z.ZodType<T>, label: string): T {
  try {
    return parseValue(
      JSON.parse(readFileSync(filePath, 'utf8')),
      schema,
      `${label} at ${filePath}`,
    );
  } catch (error) {
    if (error instanceof SameTreeError) throw error;
    throw new SameTreeError('WORKSPACE_ERROR', `Invalid ${label} at ${filePath}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function readOptionalFile<T>(filePath: string, schema: z.ZodType<T>, label: string): T | null {
  try {
    return parseFile(filePath, schema, label);
  } catch (error) {
    if (error instanceof SameTreeError && String(error.details.cause).includes('ENOENT'))
      return null;
    throw error;
  }
}

function assertMatchingIdentity<T>(
  filePath: string,
  existing: T,
  requested: T,
  label: string,
): void {
  if (JSON.stringify(existing) !== JSON.stringify(requested)) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      `${label} at ${filePath} already has another identity.`,
      {
        existing,
        requested,
      },
    );
  }
}

function writeExclusiveOrMatch<T>(
  filePath: string,
  value: T,
  schema: z.ZodType<T>,
  label: string,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw new SameTreeError('WORKSPACE_ERROR', `Could not write ${label} at ${filePath}.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const existing = parseFile(filePath, schema, label);
  assertMatchingIdentity(filePath, existing, value, label);
}

function registryRoot(options: WorkspaceRegistryOptions): string {
  if (options.registryRoot) return path.resolve(options.registryRoot);
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return path.resolve(dataHome, 'sametree', 'workspaces');
}

function workspaceDirectory(workspaceId: string, options: WorkspaceRegistryOptions): string {
  const id = parseValue(workspaceId, identifierSchema, 'workspace ID');
  return path.join(registryRoot(options), id);
}

function repositoryBindingPath(repository: RepositoryContext): string {
  return path.join(repository.commonGitDirectory, 'sametree', REPOSITORY_BINDING_FILE);
}

function worktreeBindingPath(repository: RepositoryContext): string {
  return path.join(repository.privateGitDirectory, 'sametree', WORKTREE_BINDING_FILE);
}

export function registerWorkspace(
  input: Omit<WorkspaceRegistration, 'schemaVersion'>,
  options: WorkspaceRegistryOptions = {},
): RegisteredWorkspace {
  const registration = parseValue(
    { schemaVersion: REGISTRY_SCHEMA_VERSION, ...input },
    workspaceRegistrationSchema,
    'workspace registration',
  );
  const directory = workspaceDirectory(registration.id, options);
  writeExclusiveOrMatch(
    path.join(directory, WORKSPACE_METADATA_FILE),
    registration,
    workspaceRegistrationSchema,
    'workspace registration',
  );
  return {
    ...registration,
    directory,
    databasePath: path.join(directory, 'state.sqlite3'),
  };
}

export function readRegisteredWorkspace(
  workspaceId: string,
  options: WorkspaceRegistryOptions = {},
): RegisteredWorkspace {
  const directory = workspaceDirectory(workspaceId, options);
  const registration = parseFile(
    path.join(directory, WORKSPACE_METADATA_FILE),
    workspaceRegistrationSchema,
    'workspace registration',
  );
  if (registration.id !== workspaceId) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'Workspace registration identity does not match its directory.',
      {
        directory,
        registeredId: registration.id,
        requestedId: workspaceId,
      },
    );
  }
  return {
    ...registration,
    directory,
    databasePath: path.join(directory, 'state.sqlite3'),
  };
}

export function bindWorktree(
  repository: RepositoryContext,
  input: BindWorktreeInput,
  options: WorkspaceRegistryOptions = {},
): WorkspaceContext {
  const repositoryBinding = parseValue(
    {
      schemaVersion: BINDING_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
    },
    repositoryBindingSchema,
    'repository workspace binding',
  );
  const worktreeBinding = parseValue(
    { ...repositoryBinding, worktreeId: input.worktreeId },
    worktreeBindingSchema,
    'worktree workspace binding',
  );

  readRegisteredWorkspace(input.workspaceId, options);
  const repositoryPath = repositoryBindingPath(repository);
  const worktreePath = worktreeBindingPath(repository);
  const existingRepository = readOptionalFile(
    repositoryPath,
    repositoryBindingSchema,
    'repository workspace binding',
  );
  const existingWorktree = readOptionalFile(
    worktreePath,
    worktreeBindingSchema,
    'worktree workspace binding',
  );
  if (existingRepository) {
    assertMatchingIdentity(
      repositoryPath,
      existingRepository,
      repositoryBinding,
      'repository workspace binding',
    );
  }
  if (existingWorktree) {
    assertMatchingIdentity(
      worktreePath,
      existingWorktree,
      worktreeBinding,
      'worktree workspace binding',
    );
  }
  writeExclusiveOrMatch(
    repositoryPath,
    repositoryBinding,
    repositoryBindingSchema,
    'repository workspace binding',
  );
  writeExclusiveOrMatch(
    worktreePath,
    worktreeBinding,
    worktreeBindingSchema,
    'worktree workspace binding',
  );

  const context = resolveWorkspaceBinding(repository, options);
  if (!context) throw new SameTreeError('WORKSPACE_ERROR', 'Worktree binding was not persisted.');
  return context;
}

export function resolveWorkspaceBinding(
  repository: RepositoryContext,
  options: WorkspaceRegistryOptions = {},
): WorkspaceContext | null {
  const worktree = readOptionalFile(
    worktreeBindingPath(repository),
    worktreeBindingSchema,
    'worktree workspace binding',
  );
  if (!worktree) return null;

  const repositoryBinding = readOptionalFile(
    repositoryBindingPath(repository),
    repositoryBindingSchema,
    'repository workspace binding',
  );
  if (!repositoryBinding) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Worktree binding has no repository binding.', {
      worktreeId: worktree.worktreeId,
    });
  }
  if (
    repositoryBinding.workspaceId !== worktree.workspaceId ||
    repositoryBinding.repositoryId !== worktree.repositoryId
  ) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Repository and worktree bindings disagree.', {
      repository: repositoryBinding,
      worktree,
    });
  }

  return {
    workspace: readRegisteredWorkspace(worktree.workspaceId, options),
    repositoryId: worktree.repositoryId,
    worktreeId: worktree.worktreeId,
  };
}
