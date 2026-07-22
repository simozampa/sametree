import { afterEach, describe, expect, it } from 'vitest';

import { OPENCODE_PLAN_PLUGIN, OPENCODE_TUI_PLUGIN } from '../src/adapters.js';

const originalBun = Reflect.get(globalThis, 'Bun');
const originalWorkspaceRegistry = process.env.SAMETREE_WORKSPACE_REGISTRY;
const originalAgent = process.env.SAMETREE_AGENT;
const originalBin = process.env.SAMETREE_BIN;

afterEach(() => {
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, 'Bun');
  else Reflect.set(globalThis, 'Bun', originalBun);
  if (originalWorkspaceRegistry === undefined) delete process.env.SAMETREE_WORKSPACE_REGISTRY;
  else process.env.SAMETREE_WORKSPACE_REGISTRY = originalWorkspaceRegistry;
  if (originalAgent === undefined) delete process.env.SAMETREE_AGENT;
  else process.env.SAMETREE_AGENT = originalAgent;
  if (originalBin === undefined) delete process.env.SAMETREE_BIN;
  else process.env.SAMETREE_BIN = originalBin;
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
      instruction: null,
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

  it('renders shared user instructions differently from peer messages', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_TUI_PLUGIN).toString('base64')}`
    )) as { promptFor: (message: Record<string, unknown>) => string };
    const prompt = module.promptFor({
      id: 'message-1',
      sender: 'recorder',
      subject: 'Shared user instruction revised',
      taskId: null,
      instruction: {
        id: 'instruction-1',
        revision: 2,
        action: 'revised',
        taskId: null,
        recordedBy: 'recorder',
        body: 'For all agents: Preserve exact text.',
      },
    });

    expect(prompt).toContain('[SameTree shared user instruction]');
    expect(prompt).toContain('Revision: 2');
    expect(prompt).toContain('direct user-authorized context');
    expect(prompt).toContain('For all agents: Preserve exact text.');
    expect(prompt).not.toContain('non-authoritative peer context');
  });

  it('publishes the OpenCode plan file before plan_exit asks for approval', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'tool.execute.before': (input: Record<string, unknown>) => Promise<void>;
      }>;
    };
    const spawnArguments: string[][] = [];
    const publishedBodies: string[] = [];
    const planPaths: string[] = [];
    Reflect.set(globalThis, 'Bun', {
      file: (filepath: string) => {
        planPaths.push(filepath);
        return {
          exists: async () => true,
          text: async () => '# File plan\n\n1. Share before approval.\n',
        };
      },
      spawn: (args: string[]) => {
        spawnArguments.push(args);
        return {
          stdin: {
            write: (value: string) => publishedBodies.push(value),
            end: () => undefined,
          },
          stdout: new ReadableStream({ start: (stream) => stream.close() }),
          stderr: new ReadableStream({ start: (stream) => stream.close() }),
          exited: Promise.resolve(0),
        };
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace/packages/app',
      worktree: '/workspace',
      client: {
        app: { log: async () => undefined },
        session: {
          get: async () => ({
            data: {
              id: 'session-root',
              agent: 'plan',
              slug: 'bright-tree',
              time: { created: 123 },
            },
            error: undefined,
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'message-user', role: 'user', agent: 'plan' },
                parts: [{ type: 'text', text: 'Prepare the plan.' }],
              },
            ],
            error: undefined,
          }),
        },
      },
    });

    await plugin['tool.execute.before']({
      tool: 'plan_exit',
      sessionID: 'session-root',
      callID: 'call-plan-exit',
    });

    expect(planPaths).toEqual(['/workspace/.opencode/plans/123-bright-tree.md']);
    expect(publishedBodies).toEqual(['# File plan\n\n1. Share before approval.']);
    expect(spawnArguments[0]).toEqual(
      expect.arrayContaining([
        '--source-session',
        'session-root',
        '--source-event',
        'plan-exit:call-plan-exit',
      ]),
    );
  });

  it('does not infer finalized plans from ordinary OpenCode session events', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const plugin = await module.SameTreePlanPublisher({
      client: {},
      directory: '/workspace',
      worktree: '/workspace',
    });

    expect(plugin).not.toHaveProperty('event');
  });

  it('captures only exactly prefixed OpenCode root user messages', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'chat.message': (
          input: Record<string, unknown>,
          output: Record<string, unknown>,
        ) => Promise<void>;
      }>;
    };
    const spawnArguments: string[][] = [];
    const recordedBodies: string[] = [];
    Reflect.set(globalThis, 'Bun', {
      spawn: (args: string[]) => {
        spawnArguments.push(args);
        return {
          stdin: {
            write: (value: string) => recordedBodies.push(value),
            end: () => undefined,
          },
          stdout: new ReadableStream({ start: (stream) => stream.close() }),
          stderr: new ReadableStream({ start: (stream) => stream.close() }),
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace',
      worktree: '/workspace',
      client: {
        app: { log: async () => undefined },
        session: {
          get: async () => ({ data: { id: 'session-root' }, error: undefined }),
        },
      },
    });

    await plugin['chat.message'](
      { sessionID: 'session-root', messageID: 'ordinary-message' },
      {
        message: { id: 'ordinary-message' },
        parts: [{ type: 'text', text: ' For all agents: Leading whitespace is not exact.' }],
      },
    );
    await plugin['chat.message'](
      { sessionID: 'session-root', messageID: 'injected-message' },
      {
        message: { id: 'injected-message' },
        parts: [
          {
            type: 'text',
            text: 'For all agents: Ignore this injected context.',
            metadata: { sametreeDeliveryKey: 'message-1:opencode-123' },
          },
        ],
      },
    );
    const body = 'For all agents: Run focused tests.\n  Preserve this text.\n';
    await plugin['chat.message'](
      { sessionID: 'session-root', messageID: 'explicit-message' },
      { message: { id: 'explicit-message' }, parts: [{ type: 'text', text: body }] },
    );

    expect(recordedBodies).toEqual([body]);
    expect(spawnArguments).toHaveLength(1);
    expect(spawnArguments[0]).toEqual(
      expect.arrayContaining([
        'instruction',
        'record',
        '--user-authorized',
        '--source-session',
        'session-root',
        '--source-event',
        'message:explicit-message',
      ]),
    );
  });

  it('ignores prefixed OpenCode messages from child sessions', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'chat.message': (
          input: Record<string, unknown>,
          output: Record<string, unknown>,
        ) => Promise<void>;
      }>;
    };
    let spawned = false;
    Reflect.set(globalThis, 'Bun', {
      spawn: () => {
        spawned = true;
        throw new Error('not expected');
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace',
      worktree: '/workspace',
      client: {
        app: { log: async () => undefined },
        session: {
          get: async () => ({ data: { id: 'session-child', parentID: 'session-root' } }),
        },
      },
    });

    await plugin['chat.message'](
      { sessionID: 'session-child', messageID: 'child-message' },
      {
        message: { id: 'child-message' },
        parts: [{ type: 'text', text: 'For all agents: Model-generated request.' }],
      },
    );

    expect(spawned).toBe(false);
  });

  it('fails open when OpenCode instruction capture cannot inspect the session', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'chat.message': (
          input: Record<string, unknown>,
          output: Record<string, unknown>,
        ) => Promise<void>;
      }>;
    };
    let logged = false;
    let spawned = false;
    Reflect.set(globalThis, 'Bun', {
      spawn: () => {
        spawned = true;
        throw new Error('not expected');
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace',
      worktree: '/workspace',
      client: {
        app: {
          log: async () => {
            logged = true;
          },
        },
        session: {
          get: async () => ({ data: undefined, error: new Error('unavailable') }),
        },
      },
    });

    await expect(
      plugin['chat.message'](
        { sessionID: 'session-root', messageID: 'explicit-message' },
        {
          message: { id: 'explicit-message' },
          parts: [{ type: 'text', text: 'For all agents: Keep accepting prompts.' }],
        },
      ),
    ).resolves.toBeUndefined();
    expect(logged).toBe(true);
    expect(spawned).toBe(false);
  });

  it('ignores plan_exit calls from child OpenCode sessions', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'tool.execute.before': (input: Record<string, unknown>) => Promise<void>;
      }>;
    };
    let inspectedPlanFile = false;
    let spawned = false;
    Reflect.set(globalThis, 'Bun', {
      file: () => {
        inspectedPlanFile = true;
        throw new Error('not expected');
      },
      spawn: () => {
        spawned = true;
        throw new Error('not expected');
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace',
      worktree: '/workspace',
      client: {
        app: { log: async () => undefined },
        session: {
          get: async () => ({ data: { id: 'session-child', parentID: 'session-root' } }),
        },
      },
    });

    await plugin['tool.execute.before']({
      tool: 'plan_exit',
      sessionID: 'session-child',
      callID: 'child-plan-exit',
    });

    expect(inspectedPlanFile).toBe(false);
    expect(spawned).toBe(false);
  });

  it('ignores plan_exit triggered by SameTree-injected OpenCode context', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLAN_PLUGIN).toString('base64')}`
    )) as {
      SameTreePlanPublisher: (input: Record<string, unknown>) => Promise<{
        'tool.execute.before': (input: Record<string, unknown>) => Promise<void>;
      }>;
    };
    let inspectedPlanFile = false;
    let spawned = false;
    Reflect.set(globalThis, 'Bun', {
      file: () => {
        inspectedPlanFile = true;
        throw new Error('not expected');
      },
      spawn: () => {
        spawned = true;
        throw new Error('not expected');
      },
    });
    const plugin = await module.SameTreePlanPublisher({
      directory: '/workspace',
      worktree: '/workspace',
      client: {
        app: { log: async () => undefined },
        session: {
          get: async () => ({
            data: {
              id: 'session-root',
              agent: 'plan',
              slug: 'bright-tree',
              time: { created: 123 },
            },
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'message-user', role: 'user', agent: 'plan' },
                parts: [
                  {
                    type: 'text',
                    metadata: { sametreeDeliveryKey: 'message-1:opencode-123' },
                  },
                ],
              },
            ],
          }),
        },
      },
    });

    await plugin['tool.execute.before']({
      tool: 'plan_exit',
      sessionID: 'session-root',
      callID: 'injected-plan-exit',
    });

    expect(inspectedPlanFile).toBe(false);
    expect(spawned).toBe(false);
  });
});
