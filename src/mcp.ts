#!/usr/bin/env node

import { writeSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Coordinator } from './coordinator.js';
import { errorResult } from './errors.js';
import type { Harness, PathClaim, TaskPriority, TaskStatus } from './types.js';
import { VERSION } from './version.js';

const harness = (process.env.SAMETREE_HARNESS ?? 'other') as Harness;
const nativeSession =
  harness === 'claude-code'
    ? process.env.CLAUDE_CODE_SESSION_ID
    : harness === 'opencode'
      ? process.env.OPENCODE_PID
      : undefined;
const automaticSuffix =
  nativeSession?.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '') || String(process.pid);
const agent = process.env.SAMETREE_AGENT || `${harness}-${automaticSuffix}`.slice(0, 80);
function openCoordinator(): Coordinator {
  try {
    return Coordinator.open({
      agent,
      harness,
      role: process.env.SAMETREE_ROLE ?? 'implementer',
      cwd: process.env.SAMETREE_CWD ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      ...(process.env.SAMETREE_WORKSPACE_REGISTRY
        ? { workspaceRegistryRoot: process.env.SAMETREE_WORKSPACE_REGISTRY }
        : {}),
      recordSessionLifecycleEvents: false,
    });
  } catch (error) {
    writeSync(process.stderr.fd, `${JSON.stringify(errorResult(error))}\n`);
    process.exit(1);
  }
}

const coordinator = openCoordinator();

const server = new McpServer({ name: 'sametree', version: VERSION });
const outputSchema = { result: z.unknown() };

function result(value: unknown) {
  const structuredContent = { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

function claimReceipts(claims: PathClaim[]) {
  return claims.map(({ id, member, path, kind, expiresAt, warnings }) => ({
    id,
    member,
    path,
    kind,
    expiresAt,
    warnings,
  }));
}

function execute(operation: () => unknown) {
  try {
    return result(operation());
  } catch (error) {
    const value = errorResult(error);
    return { ...result(value), isError: true };
  }
}

server.registerTool(
  'sametree_status',
  {
    title: 'SameTree status',
    description:
      'Read live Git worktree state, active agents, nonterminal tasks, claims, unread messages, handoffs, and the event cursor. Historical rows are opt-in.',
    inputSchema: {
      includeInactiveAgents: z.boolean().optional(),
      includeTerminalTasks: z.boolean().optional(),
    },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ includeInactiveAgents, includeTerminalTasks }) =>
    execute(() =>
      coordinator.snapshot({
        ...(includeInactiveAgents !== undefined ? { includeInactiveAgents } : {}),
        ...(includeTerminalTasks !== undefined ? { includeTerminalTasks } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_heartbeat',
  {
    title: 'Renew SameTree leases',
    description: 'Renew this session and every task or path lease held by it.',
    outputSchema,
    annotations: { idempotentHint: true },
  },
  () => execute(() => coordinator.heartbeat()),
);

server.registerTool(
  'sametree_task_create',
  {
    title: 'Create a task',
    description:
      'Record the current agent’s user-defined work. An assignee, when provided for compatibility, must be this agent.',
    inputSchema: {
      title: z.string().min(1).max(200),
      description: z.string().max(20_000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assignee: z.string().optional(),
      dependencies: z.array(z.string()).max(100).optional(),
      members: z.array(z.string().min(1)).max(100).optional(),
    },
    outputSchema,
  },
  ({ title, description, priority, assignee, dependencies, members }) =>
    execute(() =>
      coordinator.createTask({
        title,
        ...(description !== undefined ? { description } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(members !== undefined ? { members } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_task_list',
  {
    title: 'List tasks',
    description:
      'List a page of nonterminal tasks by default. Opt into terminal history or select one state.',
    inputSchema: {
      status: z.enum(['ready', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
      after: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeTerminal: z.boolean().optional(),
      member: z.string().min(1).optional(),
    },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ status, after, limit, includeTerminal, member }) =>
    execute(() =>
      coordinator.listTasks({
        ...(status !== undefined ? { status } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(includeTerminal !== undefined ? { includeTerminal } : {}),
        ...(member !== undefined ? { member } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_task_claim',
  {
    title: 'Start or renew assigned work',
    description:
      'Start or renew this agent’s assigned task. Adopting a legacy unassigned task requires direct user authorization.',
    inputSchema: {
      taskId: z.string(),
      expectedRevision: z.number().int().positive().optional(),
      reason: z.string().min(1).max(2_000).optional(),
      userAuthorized: z.literal(true).optional(),
    },
    outputSchema,
  },
  ({ taskId, expectedRevision, reason, userAuthorized }) =>
    execute(() =>
      coordinator.claimTask(taskId, {
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(userAuthorized !== undefined ? { userAuthorized } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_task_force_takeover',
  {
    title: 'Reassign work with user authorization',
    description:
      'Reassign another agent’s task and selected claims only after the user explicitly authorizes the scope change.',
    inputSchema: {
      taskId: z.string(),
      expectedRevision: z.number().int().positive(),
      reason: z.string().min(1).max(2_000),
      userAuthorized: z.literal(true),
      claimIds: z.array(z.string()).max(100).optional(),
    },
    outputSchema,
    annotations: { destructiveHint: true },
  },
  ({ taskId, expectedRevision, reason, userAuthorized, claimIds }) =>
    execute(() =>
      coordinator.forceTakeoverTask(taskId, {
        expectedRevision,
        reason,
        userAuthorized,
        ...(claimIds !== undefined ? { claimIds } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_task_update',
  {
    title: 'Update a task',
    description: 'Update assigned work, optionally checking its current revision.',
    inputSchema: {
      taskId: z.string(),
      status: z.enum(['ready', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
      description: z.string().max(20_000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      expectedRevision: z.number().int().positive().optional(),
      members: z.array(z.string().min(1)).max(100).optional(),
    },
    outputSchema,
  },
  ({ taskId, status, description, priority, expectedRevision, members }) =>
    execute(() =>
      coordinator.updateTask(taskId, {
        ...(status ? { status: status as TaskStatus } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(priority ? { priority: priority as TaskPriority } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(members !== undefined ? { members } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_claim_acquire',
  {
    title: 'Claim paths',
    description: 'Atomically acquire exact-file or recursive-directory cooperative leases.',
    inputSchema: {
      paths: z
        .array(
          z.object({
            path: z.string(),
            kind: z.enum(['exact', 'tree']).optional(),
            member: z.string().min(1).optional(),
          }),
        )
        .min(1)
        .max(100),
      ttlSeconds: z.number().int().min(30).max(86_400).optional(),
    },
    outputSchema,
  },
  ({ paths, ttlSeconds }) =>
    execute(() =>
      claimReceipts(
        coordinator.acquireClaims(
          paths.map(({ path, kind, member }) => ({
            path,
            ...(kind !== undefined ? { kind } : {}),
            ...(member !== undefined ? { member } : {}),
          })),
          ttlSeconds,
        ),
      ),
    ),
);

server.registerTool(
  'sametree_claim_list',
  {
    title: 'List path claims',
    description: 'List active cooperative file and directory leases.',
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  () => execute(() => coordinator.listClaims()),
);

server.registerTool(
  'sametree_claim_release',
  {
    title: 'Release path claims',
    description: 'Release selected claims or every claim owned by this agent.',
    inputSchema: {
      ids: z.array(z.string()).optional(),
      all: z.boolean().optional(),
    },
    outputSchema,
  },
  ({ ids, all }) =>
    execute(() =>
      coordinator.releaseClaims({
        ...(ids !== undefined ? { ids } : {}),
        ...(all !== undefined ? { all } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_message_send',
  {
    title: 'Send a message',
    description: 'Send a durable direct message or omit the recipient to broadcast.',
    inputSchema: {
      to: z.string().optional(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(50_000),
      threadId: z.string().optional(),
      taskId: z.string().optional(),
    },
    outputSchema,
  },
  ({ to, subject, body, threadId, taskId }) =>
    execute(() =>
      coordinator.sendMessage({
        subject,
        body,
        ...(to !== undefined ? { to } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_inbox',
  {
    title: 'Read inbox',
    description: 'Read direct and broadcast messages addressed to this agent.',
    inputSchema: {
      unreadOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ unreadOnly, limit }) =>
    execute(() =>
      coordinator.inbox({
        ...(unreadOnly !== undefined ? { unreadOnly } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_message_ack',
  {
    title: 'Acknowledge a message',
    description: 'Mark a direct or broadcast message as read by this agent.',
    inputSchema: { messageId: z.string() },
    outputSchema,
    annotations: { idempotentHint: true },
  },
  ({ messageId }) => execute(() => coordinator.acknowledgeMessage(messageId)),
);

server.registerTool(
  'sametree_handoff_offer',
  {
    title: 'Offer a handoff',
    description:
      'Offer non-authoritative context and selected claims to another agent. The offer does not change their scope.',
    inputSchema: {
      taskId: z.string(),
      to: z.string(),
      summary: z.string().min(1).max(20_000),
      context: z.record(z.string(), z.unknown()).optional(),
      claimIds: z.array(z.string()).max(100).optional(),
    },
    outputSchema,
  },
  ({ taskId, to, summary, context, claimIds }) =>
    execute(() =>
      coordinator.offerHandoff({
        taskId,
        to,
        summary,
        ...(context !== undefined ? { context } : {}),
        ...(claimIds !== undefined ? { claimIds } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_handoff_list',
  {
    title: 'List handoffs',
    description: 'List incoming and outgoing handoffs, or only pending incoming offers.',
    inputSchema: { pendingOnly: z.boolean().optional() },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ pendingOnly }) =>
    execute(() =>
      coordinator.listHandoffs({
        ...(pendingOnly !== undefined ? { pendingOnly } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_handoff_respond',
  {
    title: 'Respond to a handoff',
    description:
      'Reject a peer handoff, or accept it only after the user explicitly authorizes the scope transfer.',
    inputSchema: {
      handoffId: z.string(),
      accept: z.boolean(),
      reason: z.string().min(1).max(2_000).optional(),
      userAuthorized: z.literal(true).optional(),
    },
    outputSchema,
  },
  ({ handoffId, accept, reason, userAuthorized }) =>
    execute(() =>
      coordinator.respondToHandoff(handoffId, accept, {
        ...(reason !== undefined ? { reason } : {}),
        ...(userAuthorized !== undefined ? { userAuthorized } : {}),
      }),
    ),
);

server.registerTool(
  'sametree_policy_get',
  {
    title: 'Read shared policy',
    description: 'Read the current versioned policy and this agent’s acknowledgement state.',
    inputSchema: { member: z.string().min(1).optional() },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ member }) => execute(() => coordinator.getPolicy(member)),
);

server.registerTool(
  'sametree_policy_ack',
  {
    title: 'Acknowledge shared policy',
    description:
      'Record that this agent read the exact policy content when sametree_policy_get reports acknowledgedAt as null.',
    inputSchema: { hash: z.string().length(64), member: z.string().min(1).optional() },
    outputSchema,
    annotations: { idempotentHint: true },
  },
  ({ hash, member }) => execute(() => coordinator.acknowledgePolicy(hash, member)),
);

server.registerTool(
  'sametree_events',
  {
    title: 'Poll coordination events',
    description: 'Read the append-only audit stream after a sequence cursor.',
    inputSchema: {
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
    },
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  ({ after, limit }) =>
    execute(() =>
      coordinator.events({
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    ),
);

server.registerResource(
  'sametree-snapshot',
  'sametree://snapshot',
  { title: 'SameTree coordination snapshot', mimeType: 'application/json' },
  (uri) => ({
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(coordinator.snapshot()) },
    ],
  }),
);

server.registerResource(
  'sametree-policy',
  'sametree://policy/current',
  { title: 'Current SameTree policy', mimeType: 'text/markdown' },
  (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: coordinator.getPolicy().content }],
  }),
);

const heartbeat = setInterval(() => {
  try {
    coordinator.heartbeat();
  } catch (error) {
    process.stderr.write(`SameTree heartbeat failed: ${String(error)}\n`);
  }
}, 20_000);
heartbeat.unref();

let closing = false;
function closeCoordinator(): void {
  try {
    coordinator.close();
  } catch (error) {
    // Leases expire naturally if contention prevents recording a clean shutdown.
    process.stderr.write(`SameTree session close failed: ${String(error)}\n`);
  }
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  closeCoordinator();
  try {
    await server.close();
  } catch (error) {
    process.stderr.write(`SameTree transport close failed: ${String(error)}\n`);
  }
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('beforeExit', closeCoordinator);

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  closeCoordinator();
  process.stderr.write(`${JSON.stringify(errorResult(error), null, 2)}\n`);
  process.exitCode = 1;
}
