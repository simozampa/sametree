import { afterEach, describe, expect, it, vi } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import type { CoordinationEvent, Message } from '../src/types.js';
import { followMessages, formatEvent, formatMessage, watchEvents } from '../src/watch.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

function event(sequence: number, overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    kind: 'task.created',
    actor: 'watch-test',
    entityType: 'task',
    entityId: `task-${sequence}`,
    payload: { priority: 'normal' },
    createdAt: Date.UTC(2026, 0, 1, 14, 2, 3),
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    threadId: 'message-1',
    sender: 'sender',
    recipient: 'recipient',
    taskId: null,
    subject: 'Test message',
    body: 'Please review this.',
    instruction: null,
    createdAt: Date.UTC(2026, 0, 1, 14, 2, 3),
    readAt: null,
    ...overrides,
  };
}

function coordinatorWithEvents(
  events: CoordinationEvent[],
  heartbeat = vi.fn(),
  sessionTtlSeconds = 30,
): Coordinator {
  return {
    config: { sessionTtlSeconds },
    snapshot: () => ({ lastEventSequence: events.at(-1)?.sequence ?? 0 }),
    events: ({ after, limit }: { after?: number; limit?: number }) =>
      events.filter((entry) => entry.sequence > (after ?? 0)).slice(0, limit),
    heartbeat,
  } as unknown as Coordinator;
}

describe('event watch', () => {
  it('formats a compact human-readable event', () => {
    const event: CoordinationEvent = {
      sequence: 7,
      id: 'event-7',
      kind: 'handoff.offered',
      actor: 'opencode-worker',
      entityType: 'handoff',
      entityId: 'handoff-1',
      payload: { taskId: 'task-1', to: 'claude-reviewer' },
      createdAt: Date.UTC(2026, 0, 1, 14, 2, 3),
    };

    expect(formatEvent(event)).toBe(
      '14:02:03  opencode-worker -> claude-reviewer: offered a handoff for task-1',
    );
  });

  it('formats proposed plan revisions without printing their bodies', () => {
    const formatted = formatEvent(
      event(8, {
        kind: 'plan.revised',
        entityType: 'plan',
        entityId: 'plan-1',
        payload: { revision: 2, title: 'Validation plan' },
      }),
    );

    expect(formatted).toBe('14:02:03  watch-test: revised plan "Validation plan" (revision 2)');
  });

  it('formats shared instruction events without printing instruction text', () => {
    const formatted = formatEvent(
      event(9, {
        kind: 'instruction.revised',
        entityType: 'instruction',
        entityId: 'instruction-1',
        payload: { revision: 2 },
      }),
    );

    expect(formatted).toBe(
      '14:02:03  watch-test: revised shared user instruction instruction-1 (revision 2)',
    );
  });

  it('formats current and historical claim payloads without object coercion', () => {
    const current = formatEvent(
      event(9, {
        kind: 'claim.acquired',
        entityType: 'claim',
        entityId: 'claim-1,claim-2',
        payload: {
          paths: [
            { member: 'frontend', path: 'src/api.ts' },
            { member: 'backend', path: 'src/server.ts' },
          ],
        },
      }),
    );
    const historical = formatEvent(
      event(10, {
        kind: 'claim.acquired',
        entityType: 'claim',
        entityId: 'claim-3',
        payload: { paths: ['src/legacy.ts'] },
      }),
    );

    expect(current).toBe(
      '14:02:03  watch-test: claimed frontend:src/api.ts, backend:src/server.ts',
    );
    expect(historical).toBe('14:02:03  watch-test: claimed src/legacy.ts');
    expect(current).not.toContain('[object Object]');
  });

  it('retains member context for claims in one working tree', () => {
    expect(
      formatEvent(
        event(11, {
          kind: 'claim.acquired',
          entityType: 'claim',
          entityId: 'claim-1,claim-2',
          payload: {
            paths: [
              { member: 'frontend', path: 'src/api.ts' },
              { member: 'frontend', path: 'test/api.test.ts' },
            ],
          },
        }),
      ),
    ).toBe('14:02:03  watch-test: claimed frontend:src/api.ts, frontend:test/api.test.ts');
  });

  it('formats message routes without exposing addressed message bodies', () => {
    expect(
      formatEvent(
        event(12, {
          actor: 'reviewer',
          kind: 'message.sent',
          entityType: 'message',
          entityId: 'message-1',
          payload: { recipient: 'implementer' },
        }),
      ),
    ).toBe('14:02:03  reviewer -> implementer: sent a message');
  });

  it('renders structurally marked shared instruction notices distinctly', () => {
    const formatted = formatMessage(
      message({
        instruction: {
          id: 'instruction-1',
          revision: 2,
          currentRevision: 2,
          status: 'active',
          action: 'revised',
          taskId: null,
          createdBy: 'instructor',
          recordedBy: 'instructor',
          body: 'For all agents: Preserve exact text.',
          isCurrent: true,
        },
      }),
    );

    expect(formatted).toContain('SHARED USER INSTRUCTION revised');
    expect(formatted).toContain('[instruction-1; revision 2]');
    expect(formatted).toContain('  For all agents: Preserve exact text.');
    expect(formatted).not.toContain('sender -> recipient');
  });

  it('neutralizes terminal control characters in human-readable output', () => {
    const formatted = formatEvent(
      event(1, {
        actor: 'worker\u001b[31m',
        entityId: 'task\nforged',
        payload: { priority: '\u202ereversed' },
      }),
    );

    expect(
      Array.from(formatted).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return !(
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e)
        );
      }),
    ).toBe(true);
    expect(formatted).toContain('worker?[31m');
    expect(formatted).toContain('task?forged');
  });

  it('can drain the audit stream as JSON Lines', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const coordinator = Coordinator.open({ cwd: repository.root, agent: 'watch-test' });
    coordinators.push(coordinator);
    coordinator.createTask({ title: 'Watch this task' });
    const lines: string[] = [];

    const cursor = await watchEvents(coordinator, {
      json: true,
      once: true,
      write: (line) => {
        lines.push(line);
      },
    });

    expect(cursor).toBeGreaterThan(0);
    const events = lines.map(
      (line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> },
    );
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'task.created' })]),
    );
    expect(events.find((event) => event.kind === 'task.created')?.payload).toMatchObject({
      title: 'Watch this task',
    });
  });

  it('renders workspace-visible task titles in the human stream', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent: 'implementer',
      recordSessionLifecycleEvents: false,
    });
    coordinators.push(coordinator);
    coordinator.createTask({ title: 'Add request validation', priority: 'high' });
    const lines: string[] = [];

    await watchEvents(coordinator, {
      once: true,
      write: (line) => {
        lines.push(line);
      },
    });

    expect(lines).toEqual([
      expect.stringMatching(
        /^\d{2}:\d{2}:\d{2} {2}implementer: created task "Add request validation" \(high priority\)$/u,
      ),
    ]);
  });

  it('drains every page before --once returns', async () => {
    const events = Array.from({ length: 1_005 }, (_, index) => event(index + 1));
    const lines: string[] = [];

    const cursor = await watchEvents(coordinatorWithEvents(events), {
      json: true,
      once: true,
      write: (line) => {
        lines.push(line);
      },
    });

    expect(cursor).toBe(1_005);
    expect(lines).toHaveLength(1_005);
  });

  it('bounds --once to the event cursor captured at startup', async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1));
    let fetched = false;
    const coordinator = {
      config: { sessionTtlSeconds: 30 },
      snapshot: () => ({ lastEventSequence: 1_000 }),
      events: ({ after, limit }: { after?: number; limit?: number }) => {
        const page = events.filter((entry) => entry.sequence > (after ?? 0)).slice(0, limit);
        if (!fetched) {
          fetched = true;
          events.push(event(1_001));
        }
        return page;
      },
      heartbeat: vi.fn(),
    } as unknown as Coordinator;
    const lines: string[] = [];

    const cursor = await watchEvents(coordinator, {
      once: true,
      write: (line) => {
        lines.push(line);
      },
    });

    expect(cursor).toBe(1_000);
    expect(lines).toHaveLength(1_000);
  });

  it('heartbeats before a long polling interval can expire the session', async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn(() => controller.abort());

    await watchEvents(coordinatorWithEvents([], heartbeat, 0.003), {
      intervalMs: 60_000,
      signal: controller.signal,
    });

    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('waits for asynchronous output before writing the next event', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    const watching = watchEvents(coordinatorWithEvents([event(1), event(2)]), {
      once: true,
      write: (line) => {
        writes.push(line);
        return writes.length === 1 ? firstWrite : undefined;
      },
    });

    await Promise.resolve();
    expect(writes).toHaveLength(1);
    releaseFirst?.();
    await watching;
    expect(writes).toHaveLength(2);
  });

  it('continues heartbeating and responds to abort while output is blocked', async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn(() => controller.abort());

    const cursor = await watchEvents(coordinatorWithEvents([event(1)], heartbeat, 0.003), {
      once: true,
      signal: controller.signal,
      write: () => new Promise<void>(() => undefined),
    });

    expect(heartbeat).toHaveBeenCalledOnce();
    expect(cursor).toBe(0);
  });

  it('escapes terminal controls in JSON Lines without changing parsed data', async () => {
    const lines: string[] = [];
    const actor = 'worker\u009b31m\u202e';

    await watchEvents(coordinatorWithEvents([event(1, { actor })]), {
      json: true,
      once: true,
      write: (line) => {
        lines.push(line);
      },
    });

    expect(lines[0]).toContain('\\u009b');
    expect(lines[0]).toContain('\\u202e');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ actor });
  });

  it('exits cleanly when the output pipe closes', async () => {
    const pipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

    await expect(
      watchEvents(coordinatorWithEvents([event(1)]), {
        once: true,
        write: () => {
          throw pipeError;
        },
      }),
    ).resolves.toBe(0);
  });
});

describe('message follow', () => {
  it('formats message metadata and neutralizes terminal controls', () => {
    const formatted = formatMessage(
      message({ subject: 'Review\u001b[31m', body: 'First line\nforged\u202e' }),
    );

    expect(formatted).toContain('sender -> recipient');
    expect(formatted).toContain('message-1; thread message-1');
    expect(formatted).toContain('Review?[31m');
    expect(formatted).toContain('forged?');
  });

  it('drains unread messages once as JSON without acknowledging them', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender' });
    const recipient = Coordinator.open({ cwd: repository.root, agent: 'recipient' });
    coordinators.push(sender, recipient);
    const sent = sender.sendMessage({
      to: 'recipient',
      subject: 'Follow this',
      body: 'This should be emitted once.',
    });
    const lines: string[] = [];

    expect(
      await followMessages(recipient, {
        json: true,
        once: true,
        prefix: 'SameTree message: ',
        write: (line) => {
          lines.push(line);
        },
      }),
    ).toBe(1);
    expect(JSON.parse((lines[0] ?? '').replace('SameTree message: ', ''))).toMatchObject({
      id: sent.id,
      readAt: null,
    });
    expect(await followMessages(recipient, { once: true })).toBe(0);
    expect(recipient.inbox({ unreadOnly: true }).map((item) => item.id)).toContain(sent.id);
  });

  it('releases a message for retry when output fails', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender' });
    const first = Coordinator.open({ cwd: repository.root, agent: 'recipient' });
    const second = Coordinator.open({ cwd: repository.root, agent: 'recipient' });
    coordinators.push(sender, first, second);
    const sent = sender.sendMessage({
      to: 'recipient',
      subject: 'Retry this',
      body: 'The first output fails.',
    });

    await expect(
      followMessages(first, {
        once: true,
        write: () => {
          throw new Error('output failed');
        },
      }),
    ).rejects.toThrow('output failed');

    expect(second.reserveNextMessageDelivery()?.id).toBe(sent.id);
  });

  it('records delivery only after downstream confirmation', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender' });
    const first = Coordinator.open({ cwd: repository.root, agent: 'recipient' });
    const second = Coordinator.open({ cwd: repository.root, agent: 'recipient' });
    coordinators.push(sender, first, second);
    const sent = sender.sendMessage({
      to: 'recipient',
      subject: 'Confirm this',
      body: 'The adapter must accept the prompt first.',
    });
    let confirm: ((accepted: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    const following = followMessages(first, {
      once: true,
      write: () => undefined,
      confirm: () => confirmation,
    });

    await Promise.resolve();
    expect(second.reserveNextMessageDelivery()).toBeNull();
    confirm?.(true);
    expect(await following).toBe(1);
    expect(second.reserveNextMessageDelivery()).toBeNull();
    expect(first.inbox({ unreadOnly: true }).map((item) => item.id)).toContain(sent.id);
  });
});
