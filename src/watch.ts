import { setTimeout as delay } from 'node:timers/promises';

import type { Coordinator } from './coordinator.js';
import type { CoordinationEvent, Message } from './types.js';

const PAGE_SIZE = 1_000;
const MAX_HEARTBEAT_INTERVAL_MS = 20_000;
const ABORTED = Symbol('aborted');

function unsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function terminalSafe(line: string): string {
  return Array.from(line, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return unsafeTerminalCodePoint(codePoint) ? '?' : character;
  }).join('');
}

function formatJson(value: unknown): string {
  return Array.from(JSON.stringify(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return unsafeTerminalCodePoint(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : character;
  }).join('');
}

function liveness(coordinator: Coordinator, signal?: AbortSignal) {
  const heartbeatIntervalMs = Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.floor((coordinator.config.sessionTtlSeconds * 1_000) / 3),
  );
  let rejectHeartbeat: (error: unknown) => void = () => undefined;
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject;
  });
  void heartbeatFailure.catch(() => undefined);
  const heartbeat = setInterval(() => {
    try {
      coordinator.heartbeat();
    } catch (error) {
      clearInterval(heartbeat);
      rejectHeartbeat(error);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  let removeAbortListener: () => void = () => undefined;
  const aborted = signal
    ? new Promise<typeof ABORTED>((resolve) => {
        const abort = () => resolve(ABORTED);
        if (signal.aborted) abort();
        else {
          signal.addEventListener('abort', abort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', abort);
        }
      })
    : new Promise<never>(() => undefined);

  return {
    aborted,
    heartbeatFailure,
    close: () => {
      clearInterval(heartbeat);
      removeAbortListener();
    },
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function taskName(event: CoordinationEvent): string {
  const title = text(event.payload.title);
  return title ? `"${title}"` : event.entityId;
}

function claimPaths(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const paths = value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ member: '', path: entry }];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const member = text(Reflect.get(entry, 'member'));
    const path = text(Reflect.get(entry, 'path'));
    return path ? [{ member, path }] : [];
  });
  return paths
    .map((entry) => (entry.member ? `${entry.member}:${entry.path}` : entry.path))
    .join(', ');
}

function eventDescription(event: CoordinationEvent): string {
  const payload = event.payload;
  switch (event.kind) {
    case 'claim.acquired': {
      const paths = claimPaths(payload.paths);
      return `${event.actor}: claimed ${paths || event.entityId}`;
    }
    case 'claim.released': {
      const released = count(payload.released);
      return `${event.actor}: released ${released} ${released === 1 ? 'claim' : 'claims'}`;
    }
    case 'handoff.offered':
      return `${event.actor} -> ${text(payload.to) || 'unknown'}: offered a handoff for ${text(payload.taskId) || event.entityId}`;
    case 'handoff.accepted':
    case 'handoff.rejected':
      return `${event.actor}: ${event.kind === 'handoff.accepted' ? 'accepted' : 'rejected'} the handoff for ${text(payload.taskId) || event.entityId}`;
    case 'message.sent': {
      const recipient = text(payload.recipient) || 'broadcast';
      return `${event.actor} -> ${recipient}: sent a message`;
    }
    case 'message.acknowledged':
      return `${event.actor}: acknowledged a message`;
    case 'plan.published':
      return `${event.actor}: published plan "${text(payload.title) || event.entityId}" (revision ${String(payload.revision ?? '')})`;
    case 'plan.revised':
      return `${event.actor}: revised plan "${text(payload.title) || event.entityId}" (revision ${String(payload.revision ?? '')})`;
    case 'instruction.recorded':
      return `${event.actor}: recorded shared user instruction ${event.entityId} (revision ${String(payload.revision ?? '')})`;
    case 'instruction.revised':
      return `${event.actor}: revised shared user instruction ${event.entityId} (revision ${String(payload.revision ?? '')})`;
    case 'instruction.revoked':
      return `${event.actor}: revoked shared user instruction ${event.entityId} (revision ${String(payload.revision ?? '')})`;
    case 'instruction.acknowledged':
      return `${event.actor}: acknowledged shared user instruction ${event.entityId} (revision ${String(payload.revision ?? '')})`;
    case 'task.created': {
      const priority = text(payload.priority);
      return `${event.actor}: created task ${taskName(event)}${priority ? ` (${priority} priority)` : ''}`;
    }
    case 'task.updated': {
      const from = text(payload.fromStatus);
      const to = text(payload.toStatus);
      if (to === 'done') return `${event.actor}: completed task ${taskName(event)}`;
      if (from && to && from !== to) {
        return `${event.actor}: moved task ${taskName(event)} from ${from} to ${to}`;
      }
      return `${event.actor}: updated task ${taskName(event)}`;
    }
    case 'task.claimed':
      return `${event.actor}: started task ${taskName(event)}`;
    case 'task.adopted':
      return `${event.actor}: adopted task ${taskName(event)}`;
    case 'task.taken_over':
    case 'task.force_taken_over':
      return `${event.actor}: took over task ${taskName(event)}${payload.previousAssignee ? ` from ${String(payload.previousAssignee)}` : ''}`;
    default:
      return `${event.actor}: ${event.kind} ${event.entityType}:${event.entityId}`;
  }
}

export function formatEvent(event: CoordinationEvent): string {
  const time = new Date(event.createdAt).toISOString().slice(11, 19);
  return terminalSafe(`${time}  ${eventDescription(event)}`);
}

export function formatMessage(message: Message): string {
  const time = new Date(message.createdAt).toISOString();
  const recipient = message.recipient ?? 'broadcast';
  const task = message.taskId ? `; task ${message.taskId}` : '';
  if (message.instruction) {
    const instruction = message.instruction;
    const header = `${time}  SHARED USER INSTRUCTION ${instruction.action}  [${instruction.id}; revision ${instruction.revision}${task}]`;
    const text = instruction.body ?? 'This shared user instruction was revoked.';
    const body = text
      .split('\n')
      .map((line) => `  ${terminalSafe(line)}`)
      .join('\n');
    const warning = terminalSafe(
      '  Before applying this notice, retrieve the current revision through SameTree and ignore this text if the revision is no longer current.',
    );
    return `${terminalSafe(header)}\n${body}\n${warning}`;
  }
  const header = `${time}  ${message.sender} -> ${recipient}  ${message.subject}  [${message.id}; thread ${message.threadId}${task}]`;
  const body = message.body
    .split('\n')
    .map((line) => `  ${terminalSafe(line)}`)
    .join('\n');
  return `${terminalSafe(header)}\n${body}`;
}

function stdoutLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) {
        // Keep the one-shot listener until Writable emits the matching error.
        reject(error);
      } else {
        process.stdout.removeListener('error', finish);
        resolve();
      }
    };

    process.stdout.once('error', finish);
    try {
      process.stdout.write(`${line}\n`, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function brokenPipe(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'EPIPE';
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await delay(milliseconds, undefined, { signal });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return false;
    throw error;
  }
}

export async function watchEvents(
  coordinator: Coordinator,
  options: {
    after?: number;
    intervalMs?: number;
    json?: boolean;
    once?: boolean;
    signal?: AbortSignal;
    write?: (line: string) => void | Promise<void>;
  } = {},
): Promise<number> {
  let cursor = options.after ?? 0;
  const onceThrough = options.once ? coordinator.snapshot().lastEventSequence : null;
  if (onceThrough !== null && cursor >= onceThrough) return cursor;

  const intervalMs = options.intervalMs ?? 1_000;
  const write = options.write ?? stdoutLine;
  const live = liveness(coordinator, options.signal);

  try {
    while (!options.signal?.aborted) {
      const fetched = coordinator.events({ after: cursor, limit: PAGE_SIZE });
      const events =
        onceThrough === null ? fetched : fetched.filter((event) => event.sequence <= onceThrough);
      for (const event of events) {
        try {
          const result = await Promise.race([
            Promise.resolve()
              .then(() => write(options.json ? formatJson(event) : formatEvent(event)))
              .then(() => true),
            live.aborted,
            live.heartbeatFailure,
          ]);
          if (result === ABORTED) return cursor;
        } catch (error) {
          if (brokenPipe(error)) return cursor;
          throw error;
        }
        cursor = event.sequence;
      }

      if (onceThrough !== null && cursor >= onceThrough) return cursor;
      if (fetched.length === PAGE_SIZE) {
        if (!(await Promise.race([wait(0, options.signal), live.heartbeatFailure]))) return cursor;
        continue;
      }
      if (options.once) return cursor;

      if (!(await Promise.race([wait(intervalMs, options.signal), live.heartbeatFailure])))
        return cursor;
    }
    return cursor;
  } finally {
    live.close();
  }
}

export async function followMessages(
  coordinator: Coordinator,
  options: {
    intervalMs?: number;
    json?: boolean;
    once?: boolean;
    prefix?: string;
    signal?: AbortSignal;
    write?: (line: string) => void | Promise<void>;
    confirm?: (message: Message) => boolean | Promise<boolean>;
  } = {},
): Promise<number> {
  const intervalMs = options.intervalMs ?? 1_000;
  const write = options.write ?? stdoutLine;
  const live = liveness(coordinator, options.signal);
  let delivered = 0;
  let reserved: Message | null = null;

  try {
    while (!options.signal?.aborted) {
      reserved = coordinator.reserveNextMessageDelivery();
      if (reserved) {
        const message = reserved;
        if (!coordinator.isMessageDeliveryCurrent(message.id)) {
          coordinator.releaseMessageDelivery(message.id);
          reserved = null;
          continue;
        }
        try {
          const result = await Promise.race([
            Promise.resolve()
              .then(() => {
                const output = options.json ? formatJson(message) : formatMessage(message);
                return write(`${terminalSafe(options.prefix ?? '')}${output}`);
              })
              .then(() => true),
            live.aborted,
            live.heartbeatFailure,
          ]);
          if (result === ABORTED) return delivered;
        } catch (error) {
          if (brokenPipe(error)) return delivered;
          throw error;
        }
        if (options.confirm && !(await options.confirm(message))) return delivered;
        coordinator.completeMessageDelivery(message.id);
        delivered += 1;
        reserved = null;
        continue;
      }

      if (options.once) return delivered;
      if (!(await Promise.race([wait(intervalMs, options.signal), live.heartbeatFailure]))) {
        return delivered;
      }
    }
    return delivered;
  } finally {
    if (reserved) coordinator.releaseMessageDelivery(reserved.id);
    live.close();
  }
}
