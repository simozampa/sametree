import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

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

    expect(tools.tools.map((tool) => tool.name)).toContain('sametree_claim_acquire');
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { agent: { name: 'mcp-agent', harness: 'opencode' } },
    });
  });
});
