import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { type ClaudeCommandRunner, setupProject } from '../src/setup.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const VALID_CLAUDE_SERVER = `sametree:
  Scope: Local config (private to you in this project)
  Status: ✓ Connected
  Type: stdio
  Command: sametree-mcp
  Args:
  Environment:
    SAMETREE_HARNESS=claude-code
`;
const MISSING_CLAUDE_SERVER = 'No MCP server named "sametree".';

const repositories: TestRepository[] = [];

function setup(): TestRepository {
  const repository = createTestRepository({ initialize: false });
  repositories.push(repository);
  return repository;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('project setup', () => {
  it('creates an idempotent OpenCode integration', () => {
    const repository = setup();
    const first = setupProject(repository.root, { opencode: true });
    const configPath = path.join(repository.root, 'opencode.json');
    const firstConfig = readFileSync(configPath, 'utf8');
    const config = JSON.parse(firstConfig) as {
      mcp: { sametree: { command: string[]; environment: Record<string, string> } };
    };

    expect(first.initialization.created).toContain('.sametree/config.json');
    expect(first.opencode).toMatchObject({
      configFile: 'opencode.json',
      mcp: 'added',
      instructions: 'added',
    });
    expect(first.restartCommands).toEqual(['opencode']);
    expect(config.mcp.sametree).toMatchObject({
      command: ['sametree-mcp'],
      environment: { SAMETREE_HARNESS: 'opencode' },
    });

    expect(setupProject(repository.root, { opencode: true }).opencode).toMatchObject({
      mcp: 'existing',
      instructions: 'existing',
    });
    expect(readFileSync(configPath, 'utf8')).toBe(firstConfig);
  });

  it('preserves JSONC comments and existing MCP servers', () => {
    const repository = setup();
    const configPath = path.join(repository.root, 'opencode.jsonc');
    writeFileSync(
      configPath,
      `{
  // Keep this server.
  "mcp": {
    "docs": { "type": "local", "command": ["docs-mcp"] },
  },
}\n`,
    );

    setupProject(repository.root, { opencode: true });

    const updated = readFileSync(configPath, 'utf8');
    const config = parse(updated) as { mcp: Record<string, unknown> };
    expect(updated).toContain('// Keep this server.');
    expect(config.mcp).toHaveProperty('docs');
    expect(config.mcp).toHaveProperty('sametree');
  });

  it.each([
    ['duplicate keys', '{"mcp":{},"mcp":{"docs":{}}}\n', /duplicate/u],
    ['non-object mcp', '{"mcp":[]}\n', /mcp as an object/u],
    [
      'invalid existing server',
      '{"mcp":{"sametree":{"type":"local","command":["sametree-mcp"],"environment":{"SAMETREE_HARNESS":"opencode"},"enabled":"false"}}}\n',
      /conflicting/u,
    ],
    [
      'fixed agent identity',
      '{"mcp":{"sametree":{"type":"local","command":["sametree-mcp"],"environment":{"SAMETREE_HARNESS":"opencode","SAMETREE_AGENT":"shared"}}}}\n',
      /conflicting/u,
    ],
    [
      'repository override',
      '{"mcp":{"sametree":{"type":"local","command":["sametree-mcp"],"environment":{"SAMETREE_HARNESS":"opencode","SAMETREE_CWD":"/tmp/other"}}}}\n',
      /conflicting/u,
    ],
    [
      'fractional timeout',
      '{"mcp":{"sametree":{"type":"local","command":["sametree-mcp"],"environment":{"SAMETREE_HARNESS":"opencode"},"timeout":1.5}}}\n',
      /conflicting/u,
    ],
  ])('refuses unsafe OpenCode configuration: %s', (_name, content, message) => {
    const repository = setup();
    const configPath = path.join(repository.root, 'opencode.json');
    writeFileSync(configPath, content);

    expect(() => setupProject(repository.root, { opencode: true })).toThrow(message);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
    expect(existsSync(path.join(repository.root, '.sametree', 'config.json'))).toBe(false);
  });

  it('refuses ambiguous OpenCode configuration files', () => {
    const repository = setup();
    writeFileSync(path.join(repository.root, 'opencode.json'), '{}\n');
    writeFileSync(path.join(repository.root, 'opencode.jsonc'), '{}\n');

    expect(() => setupProject(repository.root, { opencode: true })).toThrow(/Both opencode/u);
  });

  it('registers Claude Code locally with exact arguments and cwd', () => {
    const repository = setup();
    const calls: Array<{ args: string[]; cwd: string }> = [];
    let registered = false;
    const runner: ClaudeCommandRunner = (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'mcp' && args[1] === 'get') {
        return registered
          ? { status: 0, stdout: VALID_CLAUDE_SERVER, stderr: '' }
          : { status: 1, stdout: '', stderr: MISSING_CLAUDE_SERVER };
      }
      if (args[0] === 'mcp' && args[1] === 'add') registered = true;
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    const result = setupProject(repository.root, { claude: true, claudeRunner: runner });
    const add = calls.find((call) => call.args[0] === 'mcp' && call.args[1] === 'add');

    expect(result.claude).toEqual({ mcp: 'added', instructions: 'added' });
    expect(result.restartCommands).toEqual(['claude']);
    expect(add).toEqual({
      cwd: repository.root,
      args: [
        'mcp',
        'add',
        '--scope',
        'local',
        '--transport',
        'stdio',
        'sametree',
        '--env',
        'SAMETREE_HARNESS=claude-code',
        '--',
        'sametree-mcp',
      ],
    });
    expect(readFileSync(path.join(repository.root, 'CLAUDE.md'), 'utf8')).toMatch(
      /^@\.sametree\/coordination\.md/u,
    );
  });

  it('validates an existing Claude server instead of trusting its name', () => {
    const repository = setup();
    const validRunner: ClaudeCommandRunner = () => ({
      status: 0,
      stdout: VALID_CLAUDE_SERVER,
      stderr: '',
    });
    expect(
      setupProject(repository.root, { claude: true, claudeRunner: validRunner }).claude,
    ).toEqual({ mcp: 'existing', instructions: 'added' });

    const conflicting = setup();
    const invalidRunner: ClaudeCommandRunner = () => ({
      status: 0,
      stdout: VALID_CLAUDE_SERVER.replace('Command: sametree-mcp', 'Command: other-server'),
      stderr: '',
    });
    expect(() =>
      setupProject(conflicting.root, { claude: true, claudeRunner: invalidRunner }),
    ).toThrow(/conflicting MCP server/u);
    expect(existsSync(path.join(conflicting.root, '.sametree', 'config.json'))).toBe(false);

    const fixedIdentity = setup();
    const fixedIdentityRunner: ClaudeCommandRunner = () => ({
      status: 0,
      stdout: `${VALID_CLAUDE_SERVER}    SAMETREE_AGENT=shared\n`,
      stderr: '',
    });
    expect(() =>
      setupProject(fixedIdentity.root, { claude: true, claudeRunner: fixedIdentityRunner }),
    ).toThrow(/conflicting MCP server/u);
  });

  it('rolls back tracked files when Claude registration fails', () => {
    const repository = setup();
    const runner: ClaudeCommandRunner = (args) => {
      if (args[0] === '--version') return { status: 0, stdout: '2.1.0', stderr: '' };
      if (args[0] === 'mcp' && args[1] === 'get') {
        return { status: 1, stdout: '', stderr: MISSING_CLAUDE_SERVER };
      }
      return { status: 1, stdout: '', stderr: 'failed' };
    };

    expect(() =>
      setupProject(repository.root, { claude: true, opencode: true, claudeRunner: runner }),
    ).toThrow(/registration failed/u);
    expect(existsSync(path.join(repository.root, '.sametree', 'config.json'))).toBe(false);
    expect(existsSync(path.join(repository.root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(path.join(repository.root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(repository.root, 'opencode.json'))).toBe(false);
    expect(existsSync(path.join(repository.root, '.sametree'))).toBe(false);
  });

  it('removes a Claude server that fails post-registration validation', () => {
    const repository = setup();
    let getCalls = 0;
    let removed = false;
    const calls: string[][] = [];
    const runner: ClaudeCommandRunner = (args) => {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: '2.1.0', stderr: '' };
      if (args[0] === 'mcp' && args[1] === 'get') {
        getCalls += 1;
        return getCalls === 1 || removed
          ? { status: 1, stdout: '', stderr: MISSING_CLAUDE_SERVER }
          : {
              status: 0,
              stdout: VALID_CLAUDE_SERVER.replace('Command: sametree-mcp', 'Command: other'),
              stderr: '',
            };
      }
      if (args[0] === 'mcp' && args[1] === 'remove') removed = true;
      if (args[0] === 'mcp' && args[1] === 'add') {
        return { status: 1, stdout: '', stderr: 'partial failure' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    expect(() => setupProject(repository.root, { claude: true, claudeRunner: runner })).toThrow(
      /registration failed/u,
    );
    expect(calls).toContainEqual(['mcp', 'remove', '--scope', 'local', 'sametree']);
    expect(existsSync(path.join(repository.root, '.sametree'))).toBe(false);
  });

  it('preserves a file changed concurrently instead of rolling it back', () => {
    const repository = setup();
    const agentsPath = path.join(repository.root, 'AGENTS.md');
    const runner: ClaudeCommandRunner = (args) => {
      if (args[0] === '--version') return { status: 0, stdout: '2.1.0', stderr: '' };
      if (args[0] === 'mcp' && args[1] === 'get') {
        return { status: 1, stdout: '', stderr: MISSING_CLAUDE_SERVER };
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        writeFileSync(agentsPath, 'concurrent user edit\n');
      }
      return { status: 1, stdout: '', stderr: 'failed' };
    };

    expect(() =>
      setupProject(repository.root, { claude: true, opencode: true, claudeRunner: runner }),
    ).toThrow(/rollback preserved/u);
    expect(readFileSync(agentsPath, 'utf8')).toBe('concurrent user edit\n');
    expect(existsSync(path.join(repository.root, 'opencode.json'))).toBe(false);
  });

  it('does not follow a parent symlink swapped in before rollback', () => {
    const repository = setup();
    const outside = path.join(repository.root, 'outside');
    const sentinel = path.join(outside, 'reviewer.md');
    mkdirSync(outside);
    writeFileSync(sentinel, 'do not replace\n');
    const runner: ClaudeCommandRunner = (args) => {
      if (args[0] === '--version') return { status: 0, stdout: '2.1.0', stderr: '' };
      if (args[0] === 'mcp' && args[1] === 'get') {
        return { status: 1, stdout: '', stderr: MISSING_CLAUDE_SERVER };
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        const roles = path.join(repository.root, '.sametree', 'roles');
        rmSync(roles, { recursive: true });
        symlinkSync('../outside', roles);
      }
      return { status: 1, stdout: '', stderr: 'failed' };
    };

    expect(() => setupProject(repository.root, { claude: true, claudeRunner: runner })).toThrow(
      /rollback preserved/u,
    );
    expect(readFileSync(sentinel, 'utf8')).toBe('do not replace\n');
  });

  it('does not mistake prose or backup paths for active instructions', () => {
    const repository = setup();
    writeFileSync(
      path.join(repository.root, 'CLAUDE.md'),
      'See `.sametree/coordination.md.bak` for an old example.\n\n```markdown\n@.sametree/coordination.md\n```\n',
    );
    const runner: ClaudeCommandRunner = () => ({
      status: 0,
      stdout: VALID_CLAUDE_SERVER,
      stderr: '',
    });

    setupProject(repository.root, { claude: true, claudeRunner: runner });

    expect(readFileSync(path.join(repository.root, 'CLAUDE.md'), 'utf8')).toMatch(
      /^@\.sametree\/coordination\.md/u,
    );

    writeFileSync(
      path.join(repository.root, 'AGENTS.md'),
      '## SameTree Coordination\n\nAn old example mentions `.sametree/coordination.md`.\n',
    );
    setupProject(repository.root, { opencode: true });
    expect(readFileSync(path.join(repository.root, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- sametree:coordination -->',
    );
  });

  it('preserves permissions when updating an existing file', () => {
    const repository = setup();
    const configPath = path.join(repository.root, 'opencode.json');
    writeFileSync(configPath, '{}\n');
    chmodSync(configPath, 0o666);

    setupProject(repository.root, { opencode: true });

    expect(statSync(configPath).mode & 0o777).toBe(0o666);
  });

  it('requires an explicit harness selection', () => {
    const repository = setup();
    expect(() => setupProject(repository.root)).toThrow(/at least one harness/u);
  });
});
