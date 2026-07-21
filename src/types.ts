export type Harness = 'claude-code' | 'opencode' | 'other';
export type TaskStatus = 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ClaimKind = 'exact' | 'tree';
export type HandoffStatus = 'offered' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

export interface Agent {
  name: string;
  harness: Harness;
  role: string;
  activeMembers: string[];
  createdAt: number;
  lastSeenAt: number;
}

export interface Session {
  id: string;
  agentName: string;
  homeWorktreeId: string;
  homeMember: string;
  startedHeadDescriptor: string;
  startedBranch: string | null;
  currentBranch: string | null;
  branchChanged: boolean;
  processId: number;
  startedAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  status: 'active' | 'closed';
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  leaseExpiresAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  dependencies: string[];
  members: string[];
}

export interface PathClaim {
  id: string;
  worktreeId: string;
  member: string;
  path: string;
  comparisonPath: string;
  kind: ClaimKind;
  agentName: string;
  expiresAt: number;
  createdAt: number;
  warnings: CoordinationWarning[];
}

export interface CoordinationWarning {
  code: 'BRANCH_CHANGED' | 'LINKED_WORKTREE_OVERLAP';
  message: string;
  member: string;
  worktreeId: string;
  sessionId?: string;
  conflictingClaimId?: string;
  conflictingMember?: string;
}

export interface Message {
  id: string;
  sender: string;
  recipient: string | null;
  subject: string;
  body: string;
  threadId: string;
  taskId: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface Plan {
  id: string;
  author: string;
  taskId: string | null;
  sourceHarness: Harness;
  sourceSessionId: string;
  revision: number;
  title: string;
  body: string;
  contentHash: string;
  sourceEventId: string;
  createdAt: number;
  updatedAt: number;
  revisionCreatedAt: number;
}

export interface PlanSummary {
  id: string;
  author: string;
  taskId: string | null;
  sourceHarness: Harness;
  sourceSessionId: string;
  revision: number;
  title: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface Handoff {
  id: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  summary: string;
  context: Record<string, unknown>;
  status: HandoffStatus;
  createdAt: number;
  expiresAt: number;
  respondedAt: number | null;
}

export interface CoordinationEvent {
  sequence: number;
  id: string;
  kind: string;
  actor: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  worktreeId?: string | null;
  member?: string | null;
  createdAt: number;
}

export interface CoordinationMember {
  id: string;
  name: string;
  repositoryId: string;
  repositoryName: string;
  root: string;
  available: boolean;
}

export interface CoordinationWorkspace {
  id: string;
  name: string;
  implicit: boolean;
  currentMemberId: string;
  currentMember: string;
}

export interface PolicyDocument {
  content: string;
  hash: string;
  path: string;
  worktreeId: string;
  member: string;
  acknowledgedAt: number | null;
}

export interface PolicyAcknowledgement {
  hash: string;
  worktreeId: string;
  member: string;
  acknowledgedAt: number;
  newlyAcknowledged: boolean;
}

export interface GitWorktreeContext {
  root: string;
  branch: string | null;
  commit: string | null;
  detached: boolean;
  dirty: boolean;
}

export interface CoordinationSnapshot {
  workspace: CoordinationWorkspace;
  members: CoordinationMember[];
  git: GitWorktreeContext;
  agent: Agent;
  session: Session;
  sessions: Session[];
  agents: Agent[];
  tasks: Task[];
  plans: PlanSummary[];
  claims: PathClaim[];
  unreadMessages: number;
  pendingHandoffs: number;
  warnings: CoordinationWarning[];
  lastEventSequence: number;
}

export interface DoctorReport {
  ok: boolean;
  repositoryRoot: string;
  databasePath: string;
  sqliteVersion: string;
  journalMode: string;
  integrity: string;
  foreignKeyViolations: number;
  policyPresent: boolean;
  warnings: string[];
}
