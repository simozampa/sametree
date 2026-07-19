import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const clients: Client[] = [];
const mcpPath = path.resolve('dist/mcp.js');

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('MCP server', () => {
  it('negotiates tools and returns structured coordination state over stdio', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repository.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'mcp-agent',
        SAMETREE_HARNESS: 'opencode',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const tools = await client.listTools();
    const response = await client.callTool({ name: 'sametree_status', arguments: {} });

    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['sametree_claim_acquire', 'sametree_task_force_takeover']),
    );
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { agent: { name: 'mcp-agent', harness: 'opencode' } },
    });
    const content = response.content as Array<{ text?: string; type: string }>;
    const text = content.find((item) => item.type === 'text')?.text;
    expect(text).not.toContain('\n');
  });

  it('assigns distinct identities when clients do not provide agent names', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const environment: Record<string, string> = {
      ...getDefaultEnvironment(),
      SAMETREE_HARNESS: 'opencode',
    };
    delete environment.SAMETREE_AGENT;
    delete environment.OPENCODE_PID;

    const connect = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpPath],
        cwd: repository.root,
        env: environment,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'sametree-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(transport);
      return client;
    };

    const first = await connect();
    const second = await connect();
    const firstStatus = (
      await first.callTool({
        name: 'sametree_status',
        arguments: {},
      })
    ).structuredContent as { result: { agent: { name: string } } };
    const secondStatus = (
      await second.callTool({
        name: 'sametree_status',
        arguments: {},
      })
    ).structuredContent as { result: { agent: { name: string } } };

    expect(firstStatus.result.agent.name).toMatch(/^opencode-\d+$/u);
    expect(secondStatus.result.agent.name).toMatch(/^opencode-\d+$/u);
    expect(secondStatus.result.agent.name).not.toBe(firstStatus.result.agent.name);
  });

  it('does not let one MCP agent assign work to another', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const peer = Coordinator.open({ cwd: repository.root, agent: 'peer' });
    peer.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repository.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'author',
        SAMETREE_HARNESS: 'opencode',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const response = await client.callTool({
      name: 'sametree_task_create',
      arguments: { title: 'Assign a peer', assignee: 'peer' },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { error: { code: 'USER_AUTHORIZATION_REQUIRED' }, ok: false },
    });
  });

  it('forcibly takes over active work through an explicit MCP call', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const owner = Coordinator.open({ cwd: repository.root, agent: 'owner' });
    const active = owner.claimTask(owner.createTask({ title: 'MCP takeover' }).id);
    const [claim] = owner.acquireClaims([{ path: 'src/mcp-takeover.ts' }]);
    owner.close();
    if (!claim) throw new Error('Expected an active claim.');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repository.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'replacement',
        SAMETREE_HARNESS: 'opencode',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const response = await client.callTool({
      name: 'sametree_task_force_takeover',
      arguments: {
        taskId: active.id,
        expectedRevision: active.revision,
        reason: 'The user reassigned this task.',
        userAuthorized: true,
        claimIds: [claim.id],
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        task: { assignee: 'replacement' },
        claims: [{ id: claim.id, agentName: 'replacement' }],
      },
    });
  });
});
