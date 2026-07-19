export type Harness = 'claude-code' | 'opencode' | 'other';
export type TaskStatus = 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ClaimKind = 'exact' | 'tree';
export type HandoffStatus = 'offered' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

export interface Agent {
  name: string;
  harness: Harness;
  role: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface Session {
  id: string;
  agentName: string;
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
}

export interface PathClaim {
  id: string;
  path: string;
  comparisonPath: string;
  kind: ClaimKind;
  agentName: string;
  expiresAt: number;
  createdAt: number;
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
  createdAt: number;
}

export interface PolicyDocument {
  content: string;
  hash: string;
  path: string;
  acknowledgedAt: number | null;
}

export interface PolicyAcknowledgement {
  hash: string;
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
  git: GitWorktreeContext;
  agent: Agent;
  session: Session;
  agents: Agent[];
  tasks: Task[];
  claims: PathClaim[];
  unreadMessages: number;
  pendingHandoffs: number;
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
