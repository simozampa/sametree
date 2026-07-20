export {
  type AcquireClaimInput,
  Coordinator,
  type CoordinatorOptions,
  type CreateTaskInput,
  type ForceTakeoverTaskInput,
  type ListTasksOptions,
  type SnapshotOptions,
  type UpdateTaskInput,
  type UserAuthorizedHandoffInput,
  type UserAuthorizedTaskInput,
} from './coordinator.js';
export { diagnoseRepository } from './doctor.js';
export { type ErrorCode, errorResult, isSameTreeError, SameTreeError } from './errors.js';
export {
  type GitHeadContext,
  type RepositoryContext,
  readGitHeadContext,
  readGitWorktreeContext,
  resolveRepository,
} from './git.js';
export { checkCommitMessage, checkPreCommit, installHooks } from './hooks.js';
export { type InitializationResult, initializeProject } from './project.js';
export {
  type ClaudeCommandRunner,
  type CommandResult,
  type SetupResult,
  setupProject,
} from './setup.js';
export type {
  Agent,
  ClaimKind,
  CoordinationEvent,
  CoordinationMember,
  CoordinationSnapshot,
  CoordinationWarning,
  CoordinationWorkspace,
  DoctorReport,
  GitWorktreeContext,
  Handoff,
  HandoffStatus,
  Harness,
  Message,
  PathClaim,
  PolicyAcknowledgement,
  PolicyDocument,
  Session,
  Task,
  TaskPriority,
  TaskStatus,
} from './types.js';
export { VERSION } from './version.js';
export { followMessages, formatEvent, formatMessage, watchEvents } from './watch.js';
export {
  listRegisteredWorkspaces,
  type RegisteredWorkspace,
  type RepositoryWorkspaceBinding,
  readRegisteredWorkspace,
  registerWorkspace,
  resolveRepositoryWorkspaceBinding,
  resolveWorkspaceBinding,
  type WorkspaceContext,
  type WorkspaceRegistration,
  type WorkspaceRegistryOptions,
  type WorktreeWorkspaceBinding,
} from './workspace.js';
export {
  type AddWorkspaceMemberInput,
  addWorkspaceMember,
  type CreateWorkspaceInput,
  cancelWorkspaceCreation,
  createWorkspace,
  diagnoseWorkspace,
  leaveWorkspace,
  pruneWorkspace,
  relinkWorkspace,
  type WorkspaceCreationCancellation,
  type WorkspaceDoctorReport,
  type WorkspaceJoinMode,
  type WorkspaceJoinResult,
  type WorkspaceMember,
  type WorkspacePruneResult,
  type WorkspaceServiceOptions,
  type WorkspaceStatus,
  workspaceMembers,
  workspaceStatus,
} from './workspace-service.js';
