import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyEdits,
  type Node as JsonNode,
  modify,
  type ParseError,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

import { OPENCODE_TUI_PLUGIN } from './adapters.js';
import { SameTreeError } from './errors.js';
import { writeTextFileAtomic } from './files.js';
import { resolveRepository } from './git.js';
import { assertSafeWritePath } from './paths.js';
import {
  type InitializationResult,
  initializeProjectTracked,
  PROJECT_FILE_TEMPLATES,
} from './project.js';

const OPENCODE_SERVER = {
  type: 'local',
  command: ['sametree-mcp'],
  environment: { SAMETREE_HARNESS: 'opencode' },
  enabled: true,
} as const;

const AGENT_INSTRUCTIONS = `<!-- sametree:coordination -->
## SameTree Coordination

Read and follow \`.sametree/coordination.md\`, \`.sametree/policy.md\`, and the role matching your task under \`.sametree/roles/\`.

Use SameTree before editing: check status, inbox, policy state, and active claims; acknowledge the policy only when \`acknowledgedAt\` is null, claim the task, use narrow path claims when concurrent editing is plausible or uncertain, and release or hand off ownership when finished.
`;

const INITIALIZATION_FILES = PROJECT_FILE_TEMPLATES.map((file) => file.relativePath);
const SETUP_DIRECTORIES = ['.sametree', '.sametree/roles'];
const OPENCODE_PLUGIN_DIRECTORIES = ['.opencode'];
const OPENCODE_PLUGIN_PATH = '.opencode/sametree-tui.ts';
const RESERVED_MCP_ENVIRONMENT = [
  'SAMETREE_AGENT',
  'SAMETREE_ROLE',
  'SAMETREE_CWD',
  'CLAUDE_PROJECT_DIR',
];

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ClaudeCommandRunner = (args: string[], cwd: string) => CommandResult;

export interface SetupResult {
  repositoryRoot: string;
  initialization: InitializationResult;
  claude?: {
    mcp: 'added' | 'existing';
    instructions: 'added' | 'existing';
    plugin: 'added' | 'existing';
  };
  opencode?: {
    configFile: string;
    tuiConfigFile: string;
    mcp: 'added' | 'existing';
    instructions: 'added' | 'existing';
    plugin: 'added' | 'existing' | 'updated';
  };
  restartCommands: string[];
}

interface FilePlan {
  relativePath: string;
  status: 'added' | 'existing';
  content: string | null;
  originalContent: string | null;
}

interface FileSnapshot {
  relativePath: string;
  content: string | null;
  mode: number;
}

interface ClaudePlan {
  addMcp: boolean;
  instructions: FilePlan;
  marketplaceExists: boolean;
  pluginEnabled: boolean;
  pluginExists: boolean;
}

interface OpenCodePlan {
  config: FilePlan;
  instructions: FilePlan;
  plugin: Omit<FilePlan, 'status'> & { status: 'added' | 'existing' | 'updated' };
  tuiConfig: FilePlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTextFile(target: string): string | null {
  try {
    return readFileSync(target, 'utf8');
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
}

function markdownOutsideFences(content: string): string {
  let fence: '`' | '~' | null = null;
  return content
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) {
        const character = marker[0] as '`' | '~';
        if (fence === null) fence = character;
        else if (fence === character) fence = null;
        return '';
      }
      return fence === null ? line : '';
    })
    .join('\n');
}

function planInstructions(
  repositoryRoot: string,
  relativePath: string,
  content: string,
  position: 'prepend' | 'append',
  configured: (existing: string) => boolean,
): FilePlan {
  const target = assertSafeWritePath(repositoryRoot, relativePath);
  const originalContent = readTextFile(target);
  const existing = originalContent ?? '';
  if (configured(existing)) {
    return { relativePath, status: 'existing', content: null, originalContent };
  }

  const updated =
    position === 'prepend'
      ? `${content.trim()}\n\n${existing}`
      : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${content.trim()}\n`;
  return { relativePath, status: 'added', content: updated, originalContent };
}

function defaultClaudeRunner(args: string[], cwd: string): CommandResult {
  const result = spawnSync('claude', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function validClaudeServer(output: string): boolean {
  const reservedEnvironment = new RegExp(
    `^\\s*(?:${RESERVED_MCP_ENVIRONMENT.join('|')})\\s*=`,
    'imu',
  );
  return (
    /^\s*Scope:\s+Local config\b/imu.test(output) &&
    /^\s*Type:\s+stdio\s*$/imu.test(output) &&
    /^\s*Command:\s+sametree-mcp\s*$/imu.test(output) &&
    /^\s*Args:\s*$/imu.test(output) &&
    /^\s*SAMETREE_HARNESS=claude-code\s*$/imu.test(output) &&
    !reservedEnvironment.test(output)
  );
}

function claudeServerMissing(result: CommandResult): boolean {
  return /No MCP server named ["']?sametree["']?/iu.test(`${result.stdout}\n${result.stderr}`);
}

function commandJsonArray(result: CommandResult, description: string): Record<string, unknown>[] {
  if (result.status !== 0) {
    throw new SameTreeError('INVALID_INPUT', `Could not inspect ${description}.`, {
      stderr: result.stderr.trim(),
      ...(result.error ? { cause: result.error } : {}),
    });
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('Expected an array.');
    return value;
  } catch (error) {
    throw new SameTreeError('INVALID_INPUT', `Could not parse ${description}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function preflightClaude(repositoryRoot: string, runner: ClaudeCommandRunner): ClaudePlan {
  const existing = runner(['mcp', 'get', 'sametree'], repositoryRoot);
  if (existing.status === 0 && !validClaudeServer(existing.stdout)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Claude Code has a conflicting MCP server named sametree.',
      { configuration: existing.stdout.trim() },
    );
  }
  if (existing.status !== 0) {
    if (!claudeServerMissing(existing)) {
      throw new SameTreeError('INVALID_INPUT', 'Could not inspect Claude Code MCP configuration.', {
        stdout: existing.stdout.trim(),
        stderr: existing.stderr.trim(),
        ...(existing.error ? { cause: existing.error } : {}),
      });
    }
    const available = runner(['--version'], repositoryRoot);
    if (available.status !== 0) {
      throw new SameTreeError('INVALID_INPUT', 'Claude Code is not available for MCP setup.', {
        stderr: available.stderr.trim(),
        ...(available.error ? { cause: available.error } : {}),
      });
    }
  }

  const marketplaces = commandJsonArray(
    runner(['plugin', 'marketplace', 'list', '--json'], repositoryRoot),
    'Claude Code marketplaces',
  );
  const plugins = commandJsonArray(
    runner(['plugin', 'list', '--json'], repositoryRoot),
    'Claude Code plugins',
  );
  const plugin = plugins.find(
    (entry) => entry.id === 'sametree@sametree' && entry.scope === 'user',
  );
  const marketplace = marketplaces.find((entry) => entry.name === 'sametree');
  if (
    marketplace &&
    !(
      marketplace.source === 'directory' &&
      typeof marketplace.path === 'string' &&
      path.resolve(marketplace.path) === packageRoot()
    )
  ) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Claude Code already has an unrelated marketplace named sametree.',
    );
  }

  return {
    addMcp: existing.status !== 0,
    marketplaceExists: marketplace !== undefined,
    pluginExists: plugin !== undefined,
    pluginEnabled: plugin?.enabled === true,
    instructions: planInstructions(
      repositoryRoot,
      'CLAUDE.md',
      '@.sametree/coordination.md',
      'prepend',
      (content) =>
        markdownOutsideFences(content)
          .split('\n')
          .some((line) => line.trim() === '@.sametree/coordination.md'),
    ),
  };
}

function assertUniqueObjectKeys(node: JsonNode, configFile: string, trail: string[] = []): void {
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      const key = String(keyNode?.value ?? '');
      if (seen.has(key)) {
        const duplicateKey = [...trail, key].join('.');
        throw new SameTreeError(
          'INVALID_INPUT',
          `Cannot safely update ${configFile}: duplicate key ${duplicateKey}.`,
          { duplicateKey },
        );
      }
      seen.add(key);
      if (valueNode) assertUniqueObjectKeys(valueNode, configFile, [...trail, key]);
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) assertUniqueObjectKeys(child, configFile, trail);
  }
}

function parseJsonc(content: string, configFile: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !tree) {
    throw new SameTreeError('INVALID_INPUT', `Cannot safely update ${configFile}.`, {
      errors: errors.map((error) => printParseErrorCode(error.error)),
    });
  }
  assertUniqueObjectKeys(tree, configFile);

  const parsed: unknown = parse(content, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!isRecord(parsed)) {
    throw new SameTreeError('INVALID_INPUT', `${configFile} must contain a JSON object.`);
  }
  return parsed;
}

function configuredOpenCodeServer(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'local') return false;
  const allowed = new Set(['type', 'command', 'cwd', 'environment', 'enabled', 'timeout']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.enabled !== undefined && value.enabled !== true) return false;
  if (value.cwd !== undefined) return false;
  if (
    value.timeout !== undefined &&
    (typeof value.timeout !== 'number' ||
      !Number.isSafeInteger(value.timeout) ||
      value.timeout <= 0)
  ) {
    return false;
  }
  if (!Array.isArray(value.command) || value.command.length !== 1) return false;
  if (value.command[0] !== 'sametree-mcp' || !isRecord(value.environment)) return false;
  const environment = value.environment;
  if (Object.values(environment).some((entry) => typeof entry !== 'string')) return false;
  if (RESERVED_MCP_ENVIRONMENT.some((key) => environment[key] !== undefined)) return false;
  return environment.SAMETREE_HARNESS === 'opencode';
}

function preflightOpenCodeTui(repositoryRoot: string): FilePlan {
  const jsonPath = path.join(repositoryRoot, '.opencode', 'tui.json');
  const jsoncPath = path.join(repositoryRoot, '.opencode', 'tui.jsonc');
  if (existsSync(jsonPath) && existsSync(jsoncPath)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Both .opencode/tui.json and .opencode/tui.jsonc exist; remove the unused configuration first.',
    );
  }

  const configFile = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const relativePath = path.relative(repositoryRoot, configFile);
  const target = assertSafeWritePath(repositoryRoot, relativePath);
  const initial = `{
  "$schema": "https://opencode.ai/tui.json"
}\n`;
  const originalContent = readTextFile(target);
  const content = originalContent ?? initial;
  const config = parseJsonc(content, relativePath);
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new SameTreeError('INVALID_INPUT', `${relativePath} must define plugin as an array.`);
  }
  if (
    config.plugin_enabled !== undefined &&
    (!isRecord(config.plugin_enabled) ||
      Object.values(config.plugin_enabled).some((value) => typeof value !== 'boolean'))
  ) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `${relativePath} must define plugin_enabled as an object of booleans.`,
    );
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const configured = plugins.some(
    (entry) =>
      entry === './sametree-tui.ts' ||
      (Array.isArray(entry) && entry.length > 0 && entry[0] === './sametree-tui.ts'),
  );
  const explicitlyDisabled =
    isRecord(config.plugin_enabled) && config.plugin_enabled['sametree-tui'] === false;
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' };
  let updated = content;
  if (!configured) {
    updated = applyEdits(
      updated,
      modify(
        updated,
        config.plugin === undefined ? ['plugin'] : ['plugin', -1],
        config.plugin === undefined ? ['./sametree-tui.ts'] : './sametree-tui.ts',
        { formattingOptions },
      ),
    );
  }
  if (explicitlyDisabled) {
    updated = applyEdits(
      updated,
      modify(updated, ['plugin_enabled', 'sametree-tui'], true, { formattingOptions }),
    );
  }

  return {
    relativePath,
    status: configured ? 'existing' : 'added',
    content: configured && !explicitlyDisabled ? null : updated,
    originalContent,
  };
}

function preflightOpenCode(repositoryRoot: string): OpenCodePlan {
  const jsonPath = path.join(repositoryRoot, 'opencode.json');
  const jsoncPath = path.join(repositoryRoot, 'opencode.jsonc');
  if (existsSync(jsonPath) && existsSync(jsoncPath)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Both opencode.json and opencode.jsonc exist; remove the unused configuration first.',
    );
  }

  const configFile = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const relativePath = path.relative(repositoryRoot, configFile);
  const target = assertSafeWritePath(repositoryRoot, relativePath);
  const initial = `{
  "$schema": "https://opencode.ai/config.json"
}\n`;
  const originalContent = readTextFile(target);
  const content = originalContent ?? initial;
  const config = parseJsonc(content, relativePath);
  if (config.mcp !== undefined && !isRecord(config.mcp)) {
    throw new SameTreeError('INVALID_INPUT', `${relativePath} must define mcp as an object.`);
  }
  const current = isRecord(config.mcp) ? config.mcp.sametree : undefined;
  if (current !== undefined && !configuredOpenCodeServer(current)) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `${relativePath} already contains a conflicting mcp.sametree entry.`,
    );
  }

  const updated =
    current === undefined
      ? applyEdits(
          content,
          modify(content, ['mcp', 'sametree'], OPENCODE_SERVER, {
            formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
          }),
        )
      : null;
  const pluginTarget = assertSafeWritePath(repositoryRoot, OPENCODE_PLUGIN_PATH);
  const pluginOriginal = readTextFile(pluginTarget);
  if (pluginOriginal !== null && !pluginOriginal.startsWith('// Generated by SameTree.')) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `${OPENCODE_PLUGIN_PATH} exists and is not managed by SameTree.`,
    );
  }

  return {
    config: {
      relativePath,
      status: current === undefined ? 'added' : 'existing',
      content: updated,
      originalContent,
    },
    instructions: planInstructions(
      repositoryRoot,
      'AGENTS.md',
      AGENT_INSTRUCTIONS,
      'append',
      (text) => markdownOutsideFences(text).includes('<!-- sametree:coordination -->'),
    ),
    plugin: {
      relativePath: OPENCODE_PLUGIN_PATH,
      status:
        pluginOriginal === null
          ? 'added'
          : pluginOriginal === OPENCODE_TUI_PLUGIN
            ? 'existing'
            : 'updated',
      content: pluginOriginal === OPENCODE_TUI_PLUGIN ? null : OPENCODE_TUI_PLUGIN,
      originalContent: pluginOriginal,
    },
    tuiConfig: preflightOpenCodeTui(repositoryRoot),
  };
}

function snapshotFiles(repositoryRoot: string, relativePaths: string[]): FileSnapshot[] {
  return [...new Set(relativePaths)].map((relativePath) => {
    const target = assertSafeWritePath(repositoryRoot, relativePath);
    const content = readTextFile(target);
    return {
      relativePath,
      content,
      mode: content === null ? 0o644 : statSync(target).mode & 0o777,
    };
  });
}

function restoreFiles(
  repositoryRoot: string,
  snapshots: FileSnapshot[],
  expectedWrites: Map<string, string>,
): string[] {
  const skipped: string[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      const target = assertSafeWritePath(repositoryRoot, snapshot.relativePath);
      const current = readTextFile(target);
      if (current === snapshot.content) continue;
      if (current !== expectedWrites.get(snapshot.relativePath)) {
        skipped.push(snapshot.relativePath);
        continue;
      }
      if (snapshot.content === null) rmSync(target, { force: true });
      else writeTextFileAtomic(target, snapshot.content, snapshot.mode);
    } catch {
      skipped.push(snapshot.relativePath);
    }
  }
  return skipped;
}

function removeCreatedDirectories(repositoryRoot: string, relativePaths: string[]): string[] {
  const skipped: string[] = [];
  for (const relativePath of relativePaths) {
    try {
      rmdirSync(assertSafeWritePath(repositoryRoot, relativePath));
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code !== 'ENOENT') skipped.push(relativePath);
    }
  }
  return skipped;
}

function createSetupDirectories(
  repositoryRoot: string,
  directories: string[],
  created: string[],
): void {
  for (const relativePath of directories) {
    const target = assertSafeWritePath(repositoryRoot, relativePath);
    try {
      mkdirSync(target, { mode: 0o755 });
      created.unshift(relativePath);
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EEXIST') throw error;
    }
  }
}

function applyFilePlan(
  repositoryRoot: string,
  plan: Pick<FilePlan, 'content' | 'originalContent' | 'relativePath'>,
  expectedWrites: Map<string, string>,
): void {
  if (plan.content === null) return;
  const target = assertSafeWritePath(repositoryRoot, plan.relativePath);
  if (readTextFile(target) !== plan.originalContent) {
    throw new SameTreeError(
      'INVALID_INPUT',
      `${plan.relativePath} changed while setup was running; no update was applied.`,
    );
  }
  writeTextFileAtomic(target, plan.content);
  expectedWrites.set(plan.relativePath, plan.content);
}

function addClaudeServer(repositoryRoot: string, runner: ClaudeCommandRunner): void {
  const added = runner(
    [
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
    repositoryRoot,
  );
  const configured = runner(['mcp', 'get', 'sametree'], repositoryRoot);
  if (configured.status === 0 && validClaudeServer(configured.stdout)) return;

  let cleanup: CommandResult | undefined;
  let cleanupVerification: CommandResult | undefined;
  if (!claudeServerMissing(configured)) {
    cleanup = runner(['mcp', 'remove', '--scope', 'local', 'sametree'], repositoryRoot);
    if (cleanup.status === 0) {
      cleanupVerification = runner(['mcp', 'get', 'sametree'], repositoryRoot);
    }
  }
  throw new SameTreeError('INVALID_INPUT', 'Claude Code MCP registration failed.', {
    stdout: added.stdout.trim(),
    stderr: added.stderr.trim(),
    ...(added.error ? { cause: added.error } : {}),
    verification: configured.stdout.trim() || configured.stderr.trim(),
    ...(cleanup
      ? {
          cleanupStatus: cleanup.status,
          cleanupError: cleanup.stderr.trim() || cleanup.error,
          cleanupVerified:
            cleanup.status === 0 &&
            cleanupVerification !== undefined &&
            claudeServerMissing(cleanupVerification),
        }
      : { cleanupVerified: claudeServerMissing(configured) }),
  });
}

function commandSucceeded(result: CommandResult, description: string): void {
  if (result.status === 0) return;
  throw new SameTreeError('INVALID_INPUT', description, {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    ...(result.error ? { cause: result.error } : {}),
  });
}

function configureClaudePlugin(
  repositoryRoot: string,
  plan: ClaudePlan,
  runner: ClaudeCommandRunner,
): void {
  let enableAttempted = false;
  try {
    if (!plan.marketplaceExists) {
      commandSucceeded(
        runner(['plugin', 'marketplace', 'add', '--scope', 'user', packageRoot()], repositoryRoot),
        'Could not add the SameTree Claude Code marketplace.',
      );
    }

    if (plan.pluginExists) {
      if (!plan.pluginEnabled) {
        enableAttempted = true;
        commandSucceeded(
          runner(['plugin', 'enable', '--scope', 'user', 'sametree@sametree'], repositoryRoot),
          'Could not enable the SameTree Claude Code plugin.',
        );
      }
    } else {
      commandSucceeded(
        runner(['plugin', 'install', '--scope', 'user', 'sametree@sametree'], repositoryRoot),
        'Could not install the SameTree Claude Code plugin.',
      );
    }

    const plugins = commandJsonArray(
      runner(['plugin', 'list', '--json'], repositoryRoot),
      'Claude Code plugins after setup',
    );
    if (
      !plugins.some(
        (entry) =>
          entry.id === 'sametree@sametree' && entry.scope === 'user' && entry.enabled === true,
      )
    ) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'The SameTree Claude Code plugin was not enabled after setup.',
      );
    }
  } catch (error) {
    const cleanupIssues: string[] = [];
    if (enableAttempted) {
      const disabled = runner(
        ['plugin', 'disable', '--scope', 'user', 'sametree@sametree'],
        repositoryRoot,
      );
      const listed = runner(['plugin', 'list', '--json'], repositoryRoot);
      let stillEnabled = true;
      try {
        const value: unknown = JSON.parse(listed.stdout);
        const plugin = Array.isArray(value)
          ? value.find(
              (entry) =>
                isRecord(entry) && entry.id === 'sametree@sametree' && entry.scope === 'user',
            )
          : undefined;
        stillEnabled = !isRecord(plugin) || plugin.enabled !== false;
      } catch {
        stillEnabled = true;
      }
      if (disabled.status !== 0 || stillEnabled) {
        cleanupIssues.push('Claude Code plugin enablement');
      }
    }
    if (!plan.pluginExists) {
      runner(['plugin', 'uninstall', '--scope', 'user', 'sametree@sametree'], repositoryRoot);
      const listed = runner(['plugin', 'list', '--json'], repositoryRoot);
      let stillInstalled = true;
      try {
        const value: unknown = JSON.parse(listed.stdout);
        stillInstalled =
          !Array.isArray(value) ||
          value.some(
            (entry) =>
              isRecord(entry) && entry.id === 'sametree@sametree' && entry.scope === 'user',
          );
      } catch {
        stillInstalled = true;
      }
      if (stillInstalled) {
        cleanupIssues.push('Claude Code plugin installation');
      }
    }
    if (!plan.marketplaceExists) {
      runner(['plugin', 'marketplace', 'remove', 'sametree'], repositoryRoot);
      const listed = runner(['plugin', 'marketplace', 'list', '--json'], repositoryRoot);
      let stillRegistered = true;
      try {
        const value: unknown = JSON.parse(listed.stdout);
        stillRegistered =
          !Array.isArray(value) ||
          value.some((entry) => isRecord(entry) && entry.name === 'sametree');
      } catch {
        stillRegistered = true;
      }
      if (stillRegistered) {
        cleanupIssues.push('Claude Code marketplace registration');
      }
    }
    if (cleanupIssues.length > 0) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Claude Code plugin setup failed and cleanup was incomplete.',
        {
          state: cleanupIssues,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    throw error;
  }
}

/** Configure project files and harness registration without storing an agent identity. */
export function setupProject(
  cwd = process.cwd(),
  options: {
    claude?: boolean;
    opencode?: boolean;
    claudeRunner?: ClaudeCommandRunner;
  } = {},
): SetupResult {
  if (!options.claude && !options.opencode) {
    throw new SameTreeError(
      'INVALID_INPUT',
      'Select at least one harness: --claude or --opencode.',
    );
  }

  const repository = resolveRepository(cwd);
  const runner = options.claudeRunner ?? defaultClaudeRunner;
  const claudePlan = options.claude ? preflightClaude(repository.root, runner) : null;
  const openCodePlan = options.opencode ? preflightOpenCode(repository.root) : null;
  const touched = [
    ...INITIALIZATION_FILES,
    ...(claudePlan ? [claudePlan.instructions.relativePath] : []),
    ...(openCodePlan
      ? [
          openCodePlan.config.relativePath,
          openCodePlan.instructions.relativePath,
          openCodePlan.plugin.relativePath,
          openCodePlan.tuiConfig.relativePath,
        ]
      : []),
  ];
  const snapshots = snapshotFiles(repository.root, touched);
  const expectedWrites = new Map<string, string>();
  const createdDirectories: string[] = [];
  let claudeServerAdded = false;

  try {
    createSetupDirectories(
      repository.root,
      [...SETUP_DIRECTORIES, ...(openCodePlan ? OPENCODE_PLUGIN_DIRECTORIES : [])],
      createdDirectories,
    );
    const initialization = initializeProjectTracked(repository.root, (relativePath, content) =>
      expectedWrites.set(relativePath, content),
    );
    if (openCodePlan) {
      applyFilePlan(repository.root, openCodePlan.config, expectedWrites);
      applyFilePlan(repository.root, openCodePlan.instructions, expectedWrites);
      applyFilePlan(repository.root, openCodePlan.plugin, expectedWrites);
      applyFilePlan(repository.root, openCodePlan.tuiConfig, expectedWrites);
    }
    if (claudePlan) applyFilePlan(repository.root, claudePlan.instructions, expectedWrites);
    if (claudePlan?.addMcp) {
      addClaudeServer(repository.root, runner);
      claudeServerAdded = true;
    }
    if (claudePlan) configureClaudePlugin(repository.root, claudePlan, runner);

    return {
      repositoryRoot: repository.root,
      initialization,
      ...(claudePlan
        ? {
            claude: {
              mcp: claudePlan.addMcp ? ('added' as const) : ('existing' as const),
              instructions: claudePlan.instructions.status,
              plugin: claudePlan.pluginExists ? ('existing' as const) : ('added' as const),
            },
          }
        : {}),
      ...(openCodePlan
        ? {
            opencode: {
              configFile: openCodePlan.config.relativePath,
              tuiConfigFile: openCodePlan.tuiConfig.relativePath,
              mcp: openCodePlan.config.status,
              instructions: openCodePlan.instructions.status,
              plugin: openCodePlan.plugin.status,
            },
          }
        : {}),
      restartCommands: [...(claudePlan ? ['claude'] : []), ...(openCodePlan ? ['opencode'] : [])],
    };
  } catch (error) {
    const claudeCleanup = claudeServerAdded
      ? runner(['mcp', 'remove', '--scope', 'local', 'sametree'], repository.root)
      : undefined;
    const rollbackIssues = [
      ...(claudeCleanup && claudeCleanup.status !== 0 ? ['Claude MCP registration'] : []),
      ...restoreFiles(repository.root, snapshots, expectedWrites),
      ...removeCreatedDirectories(repository.root, createdDirectories),
    ];
    if (rollbackIssues.length > 0) {
      throw new SameTreeError(
        'INVALID_INPUT',
        'Setup failed and rollback preserved files that changed or became unsafe.',
        {
          paths: rollbackIssues,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    throw error;
  }
}
