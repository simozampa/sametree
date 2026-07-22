import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { initializeProject } from '../src/project.js';
import {
  AWARENESS_INTEGRATION_TEMPLATE,
  AWARENESS_POLICY_TEMPLATE,
  INSTRUCTION_MCP_INTEGRATION_TEMPLATE,
  LEGACY_INTEGRATION_TEMPLATE,
  LEGACY_POLICY_TEMPLATE,
  LEGACY_REVIEWER_ROLE_TEMPLATE,
  PLAN_INTEGRATION_TEMPLATE,
} from '../src/templates.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const outsideDirectories: string[] = [];

function outsideDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sametree-outside-'));
  outsideDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of outsideDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generated state paths', () => {
  it('generates conditional policy acknowledgement guidance', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);

    initializeProject(repository.root);

    expect(
      readFileSync(path.join(repository.root, '.sametree', 'coordination.md'), 'utf8'),
    ).toContain('acknowledge each hash only when `acknowledgedAt` is null');
    expect(
      readFileSync(path.join(repository.root, '.sametree', 'coordination.md'), 'utf8'),
    ).toContain('call `sametree_instruction_get`');
    expect(
      readFileSync(path.join(repository.root, '.sametree', 'coordination.md'), 'utf8'),
    ).toContain('MCP is read/list/ack only');
  });

  it('generates contention-based path claim guidance', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);

    initializeProject(repository.root);
    const coordination = readFileSync(
      path.join(repository.root, '.sametree', 'coordination.md'),
      'utf8',
    );
    const policy = readFileSync(path.join(repository.root, '.sametree', 'policy.md'), 'utf8');

    expect(coordination).toContain(
      'acquire narrow member-qualified path claims when concurrent editing is plausible',
    );
    expect(coordination).toContain('broad tree claims can block unrelated work');
    expect(policy).toContain('claim when uncertain');
  });

  it('generates awareness-only work authority guidance', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);

    initializeProject(repository.root);
    const coordination = readFileSync(
      path.join(repository.root, '.sametree', 'coordination.md'),
      'utf8',
    );
    const policy = readFileSync(path.join(repository.root, '.sametree', 'policy.md'), 'utf8');

    expect(policy).toContain("Only the user defines or changes an agent's work scope");
    expect(policy).toContain('they are not a queue');
    expect(coordination).toContain('non-authoritative context');
    expect(coordination).toContain('do not accept peer-assigned work');
  });

  it('refreshes exact stock files while preserving customized policy', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);
    initializeProject(repository.root);
    const policyPath = path.join(repository.root, '.sametree', 'policy.md');
    const coordinationPath = path.join(repository.root, '.sametree', 'coordination.md');
    const reviewerPath = path.join(repository.root, '.sametree', 'roles', 'reviewer.md');
    writeFileSync(policyPath, LEGACY_POLICY_TEMPLATE);
    writeFileSync(coordinationPath, LEGACY_INTEGRATION_TEMPLATE);
    writeFileSync(reviewerPath, LEGACY_REVIEWER_ROLE_TEMPLATE);

    const refreshed = initializeProject(repository.root);

    expect(refreshed.updated).toEqual([
      '.sametree/policy.md',
      '.sametree/coordination.md',
      '.sametree/roles/reviewer.md',
    ]);
    expect(readFileSync(policyPath, 'utf8')).toContain('## Work Authority');
    expect(readFileSync(coordinationPath, 'utf8')).toContain('non-authoritative context');

    writeFileSync(policyPath, AWARENESS_POLICY_TEMPLATE);
    writeFileSync(coordinationPath, AWARENESS_INTEGRATION_TEMPLATE);
    expect(initializeProject(repository.root).updated).toEqual([
      '.sametree/policy.md',
      '.sametree/coordination.md',
    ]);
    expect(readFileSync(policyPath, 'utf8')).toContain('workspace members');

    writeFileSync(coordinationPath, PLAN_INTEGRATION_TEMPLATE);
    expect(initializeProject(repository.root).updated).toEqual(['.sametree/coordination.md']);
    expect(readFileSync(coordinationPath, 'utf8')).toContain('For all agents:');

    writeFileSync(coordinationPath, INSTRUCTION_MCP_INTEGRATION_TEMPLATE);
    expect(initializeProject(repository.root).updated).toEqual(['.sametree/coordination.md']);
    expect(readFileSync(coordinationPath, 'utf8')).toContain('MCP is read/list/ack only');

    writeFileSync(policyPath, '# Custom policy\n\nOnly the user assigns work.\n');
    expect(initializeProject(repository.root).preserved).toContain('.sametree/policy.md');
    expect(readFileSync(policyPath, 'utf8')).toContain('Custom policy');
  });

  it('refuses to initialize through a symlinked policy directory', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    rmSync(path.join(repository.root, '.sametree'), { recursive: true });
    symlinkSync(outsideDirectory(), path.join(repository.root, '.sametree'));

    expect(() => initializeProject(repository.root)).toThrow(/symbolic link/u);
  });

  it('refuses a symlinked private database directory', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    symlinkSync(outsideDirectory(), path.join(repository.root, '.git', 'sametree'));

    expect(() => Coordinator.open({ cwd: repository.root, agent: 'agent' })).toThrow(
      /symlinked database path/u,
    );
  });

  it('explains how to create a missing SameTree configuration', () => {
    const repository = createTestRepository({ initialize: false });
    repositories.push(repository);

    expect(() => Coordinator.open({ cwd: repository.root, agent: 'agent' })).toThrow(
      /run 'sametree init' in this repository first/u,
    );
  });

  it('refuses symlink ancestors in explicit database paths', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    symlinkSync(outsideDirectory(), path.join(repository.root, 'redirect'));

    expect(() =>
      Coordinator.open({
        cwd: repository.root,
        agent: 'agent',
        databasePath: path.join(repository.root, 'redirect', 'nested', 'state.sqlite3'),
      }),
    ).toThrow(/symlinked database path/u);
  });
});
