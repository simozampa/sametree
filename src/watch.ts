import { setTimeout as delay } from 'node:timers/promises';

import type { Coordinator } from './coordinator.js';
import type { CoordinationEvent } from './types.js';

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

function formatJsonEvent(event: CoordinationEvent): string {
  return Array.from(JSON.stringify(event), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return unsafeTerminalCodePoint(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : character;
  }).join('');
}

function payloadSummary(event: CoordinationEvent): string {
  const payload = event.payload;
  switch (event.kind) {
    case 'claim.acquired':
      return Array.isArray(payload.paths) ? payload.paths.join(', ') : '';
    case 'claim.released':
      return `${String(payload.released ?? 0)} released`;
    case 'handoff.offered':
      return `${String(payload.taskId ?? '')} -> ${String(payload.to ?? '')}`;
    case 'handoff.accepted':
    case 'handoff.rejected':
      return String(payload.taskId ?? '');
    case 'message.sent':
      return payload.recipient ? `-> ${String(payload.recipient)}` : '-> broadcast';
    case 'task.created':
      return String(payload.priority ?? '');
    case 'task.updated':
      return `${String(payload.fromStatus ?? '')} -> ${String(payload.toStatus ?? '')}`;
    case 'task.claimed':
    case 'task.taken_over':
      return payload.previousAssignee ? `from ${String(payload.previousAssignee)}` : '';
    default:
      return '';
  }
}

export function formatEvent(event: CoordinationEvent): string {
  const time = new Date(event.createdAt).toISOString().slice(11, 19);
  const subject = `${event.entityType}:${event.entityId}`;
  const summary = payloadSummary(event);
  const line = `${time}  ${event.actor.padEnd(20)} ${event.kind.padEnd(21)} ${subject}${summary ? `  ${summary}` : ''}`;
  return terminalSafe(line);
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
  const heartbeatIntervalMs = Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.floor((coordinator.config.sessionTtlSeconds * 1_000) / 3),
  );
  const write = options.write ?? stdoutLine;
  let rejectHeartbeat: (error: unknown) => void = () => undefined;
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject;
  });
  // A race attaches a rejection handler during each wait; this also covers synchronous work gaps.
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
  const aborted = options.signal
    ? new Promise<typeof ABORTED>((resolve) => {
        const abort = () => resolve(ABORTED);
        if (options.signal?.aborted) abort();
        else {
          options.signal?.addEventListener('abort', abort, { once: true });
          removeAbortListener = () => {
            options.signal?.removeEventListener('abort', abort);
          };
        }
      })
    : new Promise<never>(() => undefined);

  try {
    while (!options.signal?.aborted) {
      const fetched = coordinator.events({ after: cursor, limit: PAGE_SIZE });
      const events =
        onceThrough === null ? fetched : fetched.filter((event) => event.sequence <= onceThrough);
      for (const event of events) {
        try {
          const result = await Promise.race([
            Promise.resolve()
              .then(() => write(options.json ? formatJsonEvent(event) : formatEvent(event)))
              .then(() => true),
            aborted,
            heartbeatFailure,
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
        if (!(await Promise.race([wait(0, options.signal), heartbeatFailure]))) return cursor;
        continue;
      }
      if (options.once) return cursor;

      if (!(await Promise.race([wait(intervalMs, options.signal), heartbeatFailure])))
        return cursor;
    }
    return cursor;
  } finally {
    clearInterval(heartbeat);
    removeAbortListener();
  }
}
