import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { addWorkspaceMember, createWorkspace } from '../src/workspace-service.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const clients: Client[] = [];
const temporaryDirectories: string[] = [];
const mcpPath = path.resolve('dist/mcp.js');

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MCP server', () => {
  it('reports startup failures as complete structured errors', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sametree-mcp-error-'));
    temporaryDirectories.push(directory);
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [mcpPath], {
        cwd: directory,
        env: { ...getDefaultEnvironment(), SAMETREE_AGENT: 'invalid-root' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stderr }));
    });

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'NOT_GIT_REPOSITORY' },
      ok: false,
    });
  });

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
      expect.arrayContaining([
        'sametree_claim_acquire',
        'sametree_instruction_record',
        'sametree_plan_publish',
        'sametree_task_force_takeover',
      ]),
    );
    expect(
      tools.tools.find((tool) => tool.name === 'sametree_instruction_record')?.inputSchema,
    ).toMatchObject({
      properties: {
        source: {
          properties: { eventId: expect.any(Object), sessionId: expect.any(Object) },
          required: expect.arrayContaining(['eventId', 'sessionId']),
        },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        agent: { name: 'mcp-agent', harness: 'opencode' },
        git: { branch: 'main', commit: null, root: repository.root },
      },
    });
    const content = response.content as Array<{ text?: string; type: string }>;
    const text = content.find((item) => item.type === 'text')?.text;
    expect(text).not.toContain('\n');
  });

  it('publishes and reads proposed plans over MCP', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repository.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'mcp-planner',
        SAMETREE_HARNESS: 'claude-code',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const published = await client.callTool({
      name: 'sametree_plan_publish',
      arguments: {
        body: '# MCP plan\n\nReview this proposal.',
        sourceSessionId: 'claude-session',
        sourceEventId: 'tool-use',
      },
    });
    const plan = published.structuredContent as { result: { id: string } };
    const listed = await client.callTool({ name: 'sametree_plan_list', arguments: {} });
    const shown = await client.callTool({
      name: 'sametree_plan_get',
      arguments: { planId: plan.result.id },
    });

    expect(published.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      result: [expect.objectContaining({ id: plan.result.id, title: 'MCP plan' })],
    });
    expect(shown.structuredContent).toMatchObject({
      result: { id: plan.result.id, body: expect.stringContaining('Review this proposal.') },
    });
  });

  it('manages explicit shared user instructions over MCP', async () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: repository.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'mcp-instructor',
        SAMETREE_HARNESS: 'opencode',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const recorded = await client.callTool({
      name: 'sametree_instruction_record',
      arguments: {
        body: 'For all agents: Keep changes narrowly scoped.',
        reason: 'The user explicitly shared this instruction.',
        userAuthorized: true,
        source: { sessionId: 'native-session', eventId: 'native-event' },
      },
    });
    const instruction = recorded.structuredContent as { result: { id: string } };
    const shown = await client.callTool({
      name: 'sametree_instruction_get',
      arguments: { instructionId: instruction.result.id },
    });
    const listed = await client.callTool({
      name: 'sametree_instruction_list',
      arguments: {},
    });
    const acknowledged = await client.callTool({
      name: 'sametree_instruction_ack',
      arguments: { instructionId: instruction.result.id, revision: 1 },
    });
    const incompleteSourceIdentity = await client.callTool({
      name: 'sametree_instruction_record',
      arguments: {
        body: 'Do not record an incomplete source identity.',
        reason: 'Testing source validation.',
        userAuthorized: true,
        source: { sessionId: 'native-session-only' },
      },
    });
    const unicodeBoundary = await client.callTool({
      name: 'sametree_instruction_record',
      arguments: {
        body: '😀'.repeat(24_001),
        reason: 'Testing Unicode scalar validation.',
        userAuthorized: true,
      },
    });

    expect(recorded.isError).not.toBe(true);
    expect(shown.structuredContent).toMatchObject({
      result: {
        id: instruction.result.id,
        body: 'For all agents: Keep changes narrowly scoped.',
      },
    });
    expect(listed.structuredContent).toMatchObject({
      result: [expect.objectContaining({ id: instruction.result.id, revision: 1 })],
    });
    expect(acknowledged.structuredContent).toMatchObject({
      result: { instructionId: instruction.result.id, revision: 1 },
    });
    expect(incompleteSourceIdentity.isError).toBe(true);
    expect(incompleteSourceIdentity.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('eventId') }),
    ]);
    expect(unicodeBoundary.isError).not.toBe(true);
  });

  it('resolves a shared workspace and home member with a custom registry', async () => {
    const frontend = createTestRepository();
    const server = createTestRepository();
    repositories.push(frontend, server);
    const registryParent = mkdtempSync(path.join(tmpdir(), 'sametree-mcp-workspace-'));
    temporaryDirectories.push(registryParent);
    const registryRoot = path.join(registryParent, 'workspaces');
    const workspace = createWorkspace(
      frontend.root,
      { name: 'Product', memberName: 'frontend', mode: 'fresh' },
      { registryRoot },
    );
    addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'backend', mode: 'fresh' },
      { registryRoot },
    );
    const serverAgent = Coordinator.open({
      cwd: server.root,
      agent: 'server-agent',
      workspaceRegistryRoot: registryRoot,
    });
    const task = serverAgent.createTask({
      title: 'Visible through frontend MCP',
      members: ['backend'],
    });
    serverAgent.close();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: frontend.root,
      env: {
        ...getDefaultEnvironment(),
        SAMETREE_AGENT: 'mcp-frontend',
        SAMETREE_HARNESS: 'opencode',
        SAMETREE_WORKSPACE_REGISTRY: registryRoot,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sametree-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);

    const status = await client.callTool({ name: 'sametree_status', arguments: {} });
    const tasks = await client.callTool({
      name: 'sametree_task_list',
      arguments: { member: 'backend' },
    });
    const policy = await client.callTool({
      name: 'sametree_policy_get',
      arguments: { member: 'backend' },
    });

    expect(status.structuredContent).toMatchObject({
      result: {
        workspace: { id: workspace.workspace.id, currentMember: 'frontend' },
        session: { homeMember: 'frontend' },
      },
    });
    expect(tasks.structuredContent).toMatchObject({
      result: [expect.objectContaining({ id: task.id, members: ['backend'] })],
    });
    expect(policy.structuredContent).toMatchObject({
      result: { member: 'backend', path: path.join(server.root, '.sametree', 'policy.md') },
    });
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
