import { afterEach, describe, expect, it } from 'vitest';

import { OPENCODE_TUI_PLUGIN } from '../src/adapters.js';

const originalBun = Reflect.get(globalThis, 'Bun');
const originalWorkspaceRegistry = process.env.SAMETREE_WORKSPACE_REGISTRY;

afterEach(() => {
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, 'Bun');
  else Reflect.set(globalThis, 'Bun', originalBun);
  if (originalWorkspaceRegistry === undefined) delete process.env.SAMETREE_WORKSPACE_REGISTRY;
  else process.env.SAMETREE_WORKSPACE_REGISTRY = originalWorkspaceRegistry;
});

describe('harness adapters', () => {
  it('injects and confirms a message in the selected OpenCode TUI root session', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_TUI_PLUGIN).toString('base64')}`
    )) as { default: { tui: (api: Record<string, unknown>) => Promise<void> } };
    const message = {
      id: 'message-1',
      threadId: 'thread-1',
      sender: 'claude-code-peer',
      recipient: 'opencode-123',
      taskId: 'task-1',
      subject: 'Review this',
      body: 'Inspect the delivery path.',
      createdAt: Date.now(),
      readAt: null,
    };
    const controller = new AbortController();
    const values = new Map<string, unknown>();
    const identity =
      process.env.SAMETREE_AGENT ?? `opencode-${process.env.OPENCODE_PID ?? process.pid}`;
    const attempt = {
      sessionID: 'session-root',
      messageID: 'msg_019d00000001RetryMessage01',
      partID: 'prt_019d00000002RetryPart0001',
    };
    values.set(`sametree.delivery.message-1:${identity}`, attempt);
    const acknowledgements: string[] = [];
    const prompts: Array<Record<string, unknown>> = [];
    const spawnArguments: string[][] = [];
    let spawnEnvironment: Record<string, string | undefined> | undefined;
    let messagePersisted = true;
    let partPersisted = false;
    let postPromptChecks = 0;
    let promptedPartId = '';
    let resolveAcknowledged: () => void = () => undefined;
    const acknowledged = new Promise<void>((resolve) => {
      resolveAcknowledged = resolve;
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
        stream.close();
      },
    });

    Reflect.set(globalThis, 'Bun', {
      spawn: (args: string[], options: { env?: Record<string, string | undefined> }) => {
        spawnArguments.push(args);
        spawnEnvironment = options.env;
        return {
          stdout,
          stdin: {
            write: (value: string) => acknowledgements.push(value),
            flush: async () => {
              controller.abort();
              resolveAcknowledged();
            },
          },
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
    });

    process.env.SAMETREE_WORKSPACE_REGISTRY = '/workspace-registry';
    await module.default.tui({
      lifecycle: { signal: controller.signal, onDispose: () => undefined },
      state: {
        ready: true,
        path: { directory: '/workspace' },
        session: {
          get: (id: string) =>
            id === 'session-root' ? { id, directory: '/workspace' } : undefined,
        },
      },
      route: {
        current: { name: 'session', params: { sessionID: 'session-root' } },
        navigate: () => undefined,
      },
      kv: {
        ready: true,
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
      client: {
        session: {
          list: async () => ({
            error: undefined,
            data: [{ id: 'session-root', directory: '/workspace' }],
          }),
          messages: async () => ({
            error: undefined,
            data: [
              {
                parts: [
                  {
                    type: 'text',
                    metadata: { sametreeDeliveryKey: 'message-1:opencode-other' },
                  },
                ],
              },
            ],
          }),
          message: async ({ messageID }: { messageID: string }) => {
            if (prompts.length > 0) {
              postPromptChecks += 1;
              if (postPromptChecks >= 2) partPersisted = true;
            }
            return {
              response: { status: messagePersisted ? 200 : 404 },
              data: messagePersisted
                ? {
                    info: { id: messageID },
                    parts: partPersisted ? [{ id: promptedPartId, type: 'text' }] : [],
                  }
                : undefined,
            };
          },
          promptAsync: async (prompt: Record<string, unknown>) => {
            prompts.push(prompt);
            promptedPartId = String((prompt.parts as Array<{ id: string }>)[0]?.id ?? '');
            messagePersisted = true;
            return { error: undefined };
          },
          create: async () => ({ error: new Error('not expected') }),
        },
      },
      ui: { toast: () => undefined },
    });

    await acknowledged;
    expect(spawnArguments[0]).toEqual(
      expect.arrayContaining(['--agent', identity, '--harness', 'opencode', '--ack-stdin']),
    );
    expect(spawnEnvironment?.SAMETREE_WORKSPACE_REGISTRY).toBe('/workspace-registry');
    expect(prompts).toHaveLength(1);
    expect(postPromptChecks).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toMatchObject({
      sessionID: 'session-root',
      messageID: attempt.messageID,
      parts: [
        expect.objectContaining({
          id: attempt.partID,
          text: expect.stringContaining('[SameTree message received]'),
          metadata: {
            sametreeDeliveryKey: expect.stringMatching(/^message-1:opencode-/u),
            sametreeMessageID: 'message-1',
          },
        }),
      ],
    });
    const deliveredText = String(
      (prompts[0]?.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? '',
    );
    expect(deliveredText).toContain('non-authoritative peer context');
    expect(deliveredText).not.toContain('Act on this peer message now');
    expect(acknowledgements).toEqual(['message-1\n']);
    expect([...values.keys()]).toEqual([`sametree.delivery.message-1:${identity}`]);
  });
});
