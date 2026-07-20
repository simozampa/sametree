import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { SameTreeError } from './errors.js';
import type { RepositoryContext } from './git.js';

const REGISTRY_SCHEMA_VERSION = 1;
const BINDING_SCHEMA_VERSION = 2;
const WORKSPACE_METADATA_FILE = 'workspace.json';
const REPOSITORY_BINDING_FILE = 'repository.json';
const WORKTREE_BINDING_FILE = 'worktree.json';
const WORKSPACE_OPERATION_LOCK_FILE = 'workspace-operation.sqlite3';
const PENDING_WORKSPACE_FILE = 'pending-workspace.json';
const PENDING_JOIN_FILE = 'pending-join.json';

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
    repositoryName: z.string().trim().min(1).max(100),
  })
  .strict();

const worktreeBindingSchema = repositoryBindingSchema
  .extend({
    worktreeId: identifierSchema,
    worktreeName: z.string().trim().min(1).max(100),
  })
  .strict();

const pendingWorkspaceCreationSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: identifierSchema,
    workspaceName: z.string().trim().min(1).max(100),
    memberName: z.string().trim().min(1).max(100),
    mode: z.enum(['fresh', 'import-current']),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const pendingWorkspaceJoinSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: identifierSchema,
    memberName: z.string().trim().min(1).max(100),
    mode: z.enum(['fresh', 'import-current']),
  })
  .strict();

export type WorkspaceRegistration = z.infer<typeof workspaceRegistrationSchema>;
export type RepositoryWorkspaceBinding = z.infer<typeof repositoryBindingSchema>;
export type WorktreeWorkspaceBinding = z.infer<typeof worktreeBindingSchema>;
export type PendingWorkspaceCreation = z.infer<typeof pendingWorkspaceCreationSchema>;
export type PendingWorkspaceJoin = z.infer<typeof pendingWorkspaceJoinSchema>;

export interface RegisteredWorkspace extends WorkspaceRegistration {
  directory: string;
  databasePath: string;
}

export interface WorkspaceContext {
  workspace: RegisteredWorkspace;
  repositoryId: string;
  repositoryName: string;
  worktreeId: string;
  worktreeName: string;
  repositoryBindingPresent: boolean;
}

export interface WorkspaceRegistryOptions {
  registryRoot?: string;
}

export interface BindWorktreeInput {
  workspaceId: string;
  repositoryId: string;
  repositoryName: string;
  worktreeId: string;
  worktreeName: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (Reflect.get(error, 'code') as string | undefined) : undefined;
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = path.resolve(target);
  const { root } = path.parse(absolute);
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SameTreeError(
          'WORKSPACE_ERROR',
          'Refusing a symlinked database path or workspace metadata path.',
          { path: current },
        );
      }
    } catch (error) {
      if (error instanceof SameTreeError) throw error;
      if (errorCode(error) === 'ENOENT') break;
      throw error;
    }
  }
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
    assertNoSymlinkComponents(filePath);
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
  assertNoSymlinkComponents(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(filePath);
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

function pendingWorkspacePath(repository: RepositoryContext): string {
  return path.join(repository.privateGitDirectory, 'sametree', PENDING_WORKSPACE_FILE);
}

function pendingWorkspaceJoinPath(repository: RepositoryContext): string {
  return path.join(repository.privateGitDirectory, 'sametree', PENDING_JOIN_FILE);
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
  const registered = findRegisteredWorkspace(workspaceId, options);
  if (!registered) {
    throw new SameTreeError('WORKSPACE_ERROR', `Workspace '${workspaceId}' is not registered.`);
  }
  return registered;
}

export function findRegisteredWorkspace(
  workspaceId: string,
  options: WorkspaceRegistryOptions = {},
): RegisteredWorkspace | null {
  const directory = workspaceDirectory(workspaceId, options);
  const registration = readOptionalFile(
    path.join(directory, WORKSPACE_METADATA_FILE),
    workspaceRegistrationSchema,
    'workspace registration',
  );
  if (!registration) return null;
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

export function removeRegisteredWorkspace(
  workspaceId: string,
  options: WorkspaceRegistryOptions = {},
): void {
  const directory = workspaceDirectory(workspaceId, options);
  assertNoSymlinkComponents(directory);
  const registration = readOptionalFile(
    path.join(directory, WORKSPACE_METADATA_FILE),
    workspaceRegistrationSchema,
    'workspace registration',
  );
  if (registration && registration.id !== workspaceId) {
    throw new SameTreeError(
      'WORKSPACE_ERROR',
      'Refusing to remove a workspace registration with another identity.',
    );
  }
  rmSync(directory, { recursive: true, force: true });
}

export function listRegisteredWorkspaces(
  options: WorkspaceRegistryOptions = {},
): RegisteredWorkspace[] {
  const root = registryRoot(options);
  assertNoSymlinkComponents(root);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new SameTreeError('WORKSPACE_ERROR', `Could not read workspace registry at ${root}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== '.locks')
    .map((entry) => readRegisteredWorkspace(entry.name, options))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function resolveRegisteredWorkspace(
  reference: string,
  options: WorkspaceRegistryOptions = {},
): RegisteredWorkspace {
  const value = reference.trim();
  if (!value) throw new SameTreeError('INVALID_INPUT', 'Workspace ID or name is required.');
  if (identifierSchema.safeParse(value).success) {
    const byId = findRegisteredWorkspace(value, options);
    if (byId) return byId;
  }
  if (value.startsWith('.') || /[\\/]/u.test(value)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      "That looks like a path; pass the workspace ID or name. Run 'sametree workspace status' in a bound repository to find it.",
      { reference },
    );
  }
  const workspaces = listRegisteredWorkspaces(options);
  const byName = workspaces.filter((workspace) => workspace.name === value);
  if (byName.length === 1) return byName[0] as RegisteredWorkspace;
  if (byName.length > 1) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `Workspace name '${value}' is ambiguous; pass a workspace ID instead.`,
      { workspaceIds: byName.map((workspace) => workspace.id) },
    );
  }
  throw new SameTreeError('NOT_FOUND', `Workspace '${value}' is not registered.`);
}

export function validateWorkspaceName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 100) {
    throw new SameTreeError('INVALID_INPUT', 'Workspace name must contain 1 to 100 characters.');
  }
  if (value.startsWith('.') || /[\\/]/u.test(value)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      "Workspace names cannot start with '.' or contain path separators.",
      { name },
    );
  }
  return value;
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
      repositoryName: input.repositoryName,
    },
    repositoryBindingSchema,
    'repository workspace binding',
  );
  const worktreeBinding = parseValue(
    {
      ...repositoryBinding,
      worktreeId: input.worktreeId,
      worktreeName: input.worktreeName,
    },
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
  if (
    repositoryBinding &&
    (repositoryBinding.workspaceId !== worktree.workspaceId ||
      repositoryBinding.repositoryId !== worktree.repositoryId)
  ) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Repository and worktree bindings disagree.', {
      repository: repositoryBinding,
      worktree,
    });
  }

  return {
    workspace: readRegisteredWorkspace(worktree.workspaceId, options),
    repositoryId: worktree.repositoryId,
    repositoryName: worktree.repositoryName,
    worktreeId: worktree.worktreeId,
    worktreeName: worktree.worktreeName,
    repositoryBindingPresent: repositoryBinding !== null,
  };
}

export function resolveRepositoryWorkspaceBinding(
  repository: RepositoryContext,
): RepositoryWorkspaceBinding | null {
  return readOptionalFile(
    repositoryBindingPath(repository),
    repositoryBindingSchema,
    'repository workspace binding',
  );
}

export function readPendingWorkspaceCreation(
  repository: RepositoryContext,
): PendingWorkspaceCreation | null {
  return readOptionalFile(
    pendingWorkspacePath(repository),
    pendingWorkspaceCreationSchema,
    'pending workspace creation',
  );
}

export function writePendingWorkspaceCreation(
  repository: RepositoryContext,
  input: Omit<PendingWorkspaceCreation, 'schemaVersion'>,
): PendingWorkspaceCreation {
  const pending = parseValue(
    { schemaVersion: 1, ...input },
    pendingWorkspaceCreationSchema,
    'pending workspace creation',
  );
  writeExclusiveOrMatch(
    pendingWorkspacePath(repository),
    pending,
    pendingWorkspaceCreationSchema,
    'pending workspace creation',
  );
  return pending;
}

export function clearPendingWorkspaceCreation(repository: RepositoryContext): void {
  const pendingPath = pendingWorkspacePath(repository);
  assertNoSymlinkComponents(pendingPath);
  try {
    unlinkSync(pendingPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function readPendingWorkspaceJoin(
  repository: RepositoryContext,
): PendingWorkspaceJoin | null {
  return readOptionalFile(
    pendingWorkspaceJoinPath(repository),
    pendingWorkspaceJoinSchema,
    'pending workspace join',
  );
}

export function writePendingWorkspaceJoin(
  repository: RepositoryContext,
  input: Omit<PendingWorkspaceJoin, 'schemaVersion'>,
): PendingWorkspaceJoin {
  const pending = parseValue(
    { schemaVersion: 1, ...input },
    pendingWorkspaceJoinSchema,
    'pending workspace join',
  );
  writeExclusiveOrMatch(
    pendingWorkspaceJoinPath(repository),
    pending,
    pendingWorkspaceJoinSchema,
    'pending workspace join',
  );
  return pending;
}

export function clearPendingWorkspaceJoin(repository: RepositoryContext): void {
  const pendingPath = pendingWorkspaceJoinPath(repository);
  assertNoSymlinkComponents(pendingPath);
  try {
    unlinkSync(pendingPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function clearMatchingPendingWorkspaceJoin(
  repository: RepositoryContext,
  expected: { memberName: string; workspaceId: string },
): void {
  const pending = readPendingWorkspaceJoin(repository);
  if (pending?.workspaceId === expected.workspaceId && pending.memberName === expected.memberName) {
    clearPendingWorkspaceJoin(repository);
  }
}

export function clearWorktreeWorkspaceBinding(
  repository: RepositoryContext,
  expected: { workspaceId: string; worktreeId: string },
): void {
  const bindingPath = worktreeBindingPath(repository);
  const binding = readOptionalFile(
    bindingPath,
    worktreeBindingSchema,
    'worktree workspace binding',
  );
  if (!binding) return;
  if (binding.workspaceId !== expected.workspaceId || binding.worktreeId !== expected.worktreeId) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Refusing to remove another worktree binding.', {
      binding,
      expected,
    });
  }
  unlinkSync(bindingPath);
}

export function clearRepositoryWorkspaceBinding(
  repository: RepositoryContext,
  expected: { workspaceId: string; repositoryId: string },
): void {
  clearRepositoryWorkspaceBindingAt(repository.commonGitDirectory, expected);
}

export function clearRepositoryWorkspaceBindingAt(
  commonGitDirectory: string,
  expected: { workspaceId: string; repositoryId: string },
): void {
  const bindingPath = path.join(commonGitDirectory, 'sametree', REPOSITORY_BINDING_FILE);
  const binding = readOptionalFile(
    bindingPath,
    repositoryBindingSchema,
    'repository workspace binding',
  );
  if (!binding) return;
  if (
    binding.workspaceId !== expected.workspaceId ||
    binding.repositoryId !== expected.repositoryId
  ) {
    throw new SameTreeError('WORKSPACE_ERROR', 'Refusing to remove another repository binding.', {
      binding,
      expected,
    });
  }
  unlinkSync(bindingPath);
}

function workspaceOperationLockPath(repository: RepositoryContext): string {
  return path.join(repository.privateGitDirectory, 'sametree', WORKSPACE_OPERATION_LOCK_FILE);
}

export function workspaceOperationActive(repository: RepositoryContext): boolean {
  const lockPath = workspaceOperationLockPath(repository);
  assertNoSymlinkComponents(lockPath);
  try {
    if (!lstatSync(lockPath).isFile()) return false;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  const database = new Database(lockPath, { timeout: 1 });
  try {
    database.pragma('busy_timeout = 1');
    database.exec('BEGIN IMMEDIATE; ROLLBACK;');
    return false;
  } catch (error) {
    if (errorCode(error) === 'SQLITE_BUSY' || errorCode(error) === 'SQLITE_LOCKED') return true;
    throw error;
  } finally {
    database.close();
  }
}

export function acquireWorkspaceOperationLock(
  repository: RepositoryContext,
  waitMilliseconds = 0,
): () => void {
  return acquireWorkspaceOperationLockAt(repository.privateGitDirectory, waitMilliseconds);
}

export function acquireWorkspaceOperationLockAt(
  privateGitDirectory: string,
  waitMilliseconds = 0,
): () => void {
  return acquireSqliteLock(
    path.join(privateGitDirectory, 'sametree', WORKSPACE_OPERATION_LOCK_FILE),
    waitMilliseconds,
  );
}

export function acquireRepositoryOperationLock(
  repository: RepositoryContext,
  waitMilliseconds = 0,
): () => void {
  return acquireRepositoryOperationLockAt(repository.commonGitDirectory, waitMilliseconds);
}

export function acquireRepositoryOperationLockAt(
  commonGitDirectory: string,
  waitMilliseconds = 0,
): () => void {
  return acquireSqliteLock(
    path.join(commonGitDirectory, 'sametree', 'repository-operation.sqlite3'),
    waitMilliseconds,
  );
}

export function acquireRegisteredWorkspaceOperationLock(
  workspaceId: string,
  options: WorkspaceRegistryOptions = {},
  waitMilliseconds = 0,
): () => void {
  const id = parseValue(workspaceId, identifierSchema, 'workspace ID');
  return acquireSqliteLock(
    path.join(registryRoot(options), '.locks', `${id}.sqlite3`),
    waitMilliseconds,
  );
}

function acquireSqliteLock(lockPath: string, waitMilliseconds: number): () => void {
  assertNoSymlinkComponents(lockPath);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(lockPath);
  const timeout = Math.max(waitMilliseconds, 1);
  const database = new Database(lockPath, { timeout });
  try {
    database.pragma(`busy_timeout = ${timeout}`);
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database.close();
    if (errorCode(error) === 'SQLITE_BUSY' || errorCode(error) === 'SQLITE_LOCKED') {
      throw new SameTreeError(
        'WORKSPACE_ERROR',
        'Another session startup or workspace operation is active for this worktree.',
        { lockPath },
      );
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
  };
}
