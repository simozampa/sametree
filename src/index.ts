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
  CoordinationSnapshot,
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
