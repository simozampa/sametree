import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { openDatabase } from '../src/database.js';
import { resolveRepository } from '../src/git.js';
import {
  acquireWorkspaceOperationLock,
  bindWorktree,
  clearRepositoryWorkspaceBinding,
  listRegisteredWorkspaces,
  readPendingWorkspaceJoin,
  registerWorkspace,
  removeRegisteredWorkspace,
  resolveRepositoryWorkspaceBinding,
  resolveWorkspaceBinding,
  writePendingWorkspaceJoin,
} from '../src/workspace.js';
import {
  addWorkspaceMember,
  cancelWorkspaceCreation,
  createWorkspace,
  diagnoseWorkspace,
  leaveWorkspace,
  pruneWorkspace,
  relinkWorkspace,
  workspaceMembers,
  workspaceStatus,
} from '../src/workspace-service.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];
const temporaryDirectories: string[] = [];

function repository(): TestRepository {
  const created = createTestRepository();
  repositories.push(created);
  return created;
}

function registryRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sametree-workspace-service-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'workspaces');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function open(root: string, agent: string, workspaceRegistryRoot?: string): Coordinator {
  const coordinator = Coordinator.open({
    cwd: root,
    agent,
    ...(workspaceRegistryRoot ? { workspaceRegistryRoot } : {}),
  });
  coordinators.push(coordinator);
  return coordinator;
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('workspace operations', () => {
  it('creates a fresh workspace while preserving standalone state', () => {
    const source = repository();
    const registry = registryRoot();
    const standalone = open(source.root, 'standalone');
    const task = standalone.createTask({ title: 'Preserved only as backup' });
    standalone.close();

    const joined = createWorkspace(
      source.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry, now: 1_000 },
    );
    expect(joined).toMatchObject({ mode: 'fresh', imported: false });
    expect(joined.sourceDatabasePath).toBe(resolveRepository(source.root).databasePath);
    expect(workspaceStatus(source.root, { registryRoot: registry })).toMatchObject({
      bound: true,
      member: { name: 'studio', available: true },
      members: [{ name: 'studio' }],
    });

    const workspaceCoordinator = open(source.root, 'workspace-agent', registry);
    expect(workspaceCoordinator.listTasks({ includeTerminal: true })).toEqual([]);
    const backup = new Database(joined.sourceDatabasePath, { readonly: true });
    expect(backup.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)).toEqual({
      id: task.id,
    });
    backup.close();
  });

  it('imports standalone IDs and records original event sequences idempotently', () => {
    const source = repository();
    const registry = registryRoot();
    const standalone = open(source.root, 'author');
    const task = standalone.createTask({ title: 'Import me' });
    const taggedTask = standalone.createTask({
      title: 'Import my member tag',
      members: [path.basename(source.root)],
    });
    standalone.close();
    const sourceDatabasePath = resolveRepository(source.root).databasePath;
    const sourceDatabase = new Database(sourceDatabasePath, { readonly: true });
    const sourceEvent = sourceDatabase
      .prepare("SELECT id, sequence FROM events WHERE entity_id = ? AND kind = 'task.created'")
      .get(task.id) as { id: string; sequence: number };
    sourceDatabase.close();

    const joined = createWorkspace(
      source.root,
      { name: 'Product', memberName: 'studio', mode: 'import-current' },
      { registryRoot: registry, now: 1_000 },
    );
    expect(joined.imported).toBe(true);

    const workspaceCoordinator = open(source.root, 'observer', registry);
    expect(workspaceCoordinator.listTasks()).toContainEqual(
      expect.objectContaining({ id: task.id, members: [] }),
    );
    expect(workspaceCoordinator.listTasks()).toContainEqual(
      expect.objectContaining({ id: taggedTask.id, members: ['studio'] }),
    );
    const workspaceDatabase = new Database(joined.workspace.databasePath, { readonly: true });
    expect(
      workspaceDatabase
        .prepare(
          `SELECT source_sequence FROM event_import_sources
           WHERE event_id = ?`,
        )
        .get(sourceEvent.id),
    ).toEqual({ source_sequence: sourceEvent.sequence });
    workspaceDatabase.close();

    expect(
      addWorkspaceMember(
        source.root,
        {
          workspaceId: joined.workspace.id,
          memberName: 'studio',
          mode: 'import-current',
        },
        { registryRoot: registry, now: 2_000 },
      ),
    ).toMatchObject({ imported: false, member: { id: joined.member.id } });
  });

  it('recovers a member inserted before its source transition was recorded', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    const serverContext = resolveRepository(server.root);
    writePendingWorkspaceJoin(serverContext, {
      workspaceId: workspace.workspace.id,
      memberName: 'holo-server',
      mode: 'fresh',
    });
    const target = openDatabase(serverContext, {
      databasePath: workspace.workspace.databasePath,
      member: {
        workspaceId: workspace.workspace.id,
        workspaceName: workspace.workspace.name,
        workspaceImplicit: false,
        repositoryId: 'repository_interrupted',
        repositoryName: 'holo-server',
        worktreeId: 'worktree_interrupted',
        worktreeName: 'holo-server',
      },
    });
    target.close();
    expect(() =>
      relinkWorkspace(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'holo-server' },
        { registryRoot: registry },
      ),
    ).toThrow(/was not found/u);

    const inaccessibleDatabase = `${workspace.workspace.databasePath}.inaccessible`;
    renameSync(workspace.workspace.databasePath, inaccessibleDatabase);
    symlinkSync(inaccessibleDatabase, workspace.workspace.databasePath);
    expect(() =>
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/symlinked database path/u);
    unlinkSync(workspace.workspace.databasePath);
    renameSync(inaccessibleDatabase, workspace.workspace.databasePath);

    const blocker = new Database(workspace.workspace.databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expect(() =>
        addWorkspaceMember(
          server.root,
          { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
          { registryRoot: registry },
        ),
      ).toThrow(/locked/u);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    expect(readPendingWorkspaceJoin(serverContext)).toMatchObject({ mode: 'fresh' });

    expect(() =>
      addWorkspaceMember(
        server.root,
        {
          workspaceId: workspace.workspace.id,
          memberName: 'holo-server',
          mode: 'import-current',
        },
        { registryRoot: registry },
      ),
    ).toThrow(/different workspace join is pending/u);
    expect(existsSync(serverContext.databasePath)).toBe(false);
    expect(
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toMatchObject({
      member: { id: 'worktree_interrupted', name: 'holo-server' },
      imported: false,
    });
    expect(readPendingWorkspaceJoin(serverContext)).toBeNull();
    writePendingWorkspaceJoin(serverContext, {
      workspaceId: workspace.workspace.id,
      memberName: 'holo-server',
      mode: 'fresh',
    });
    open(server.root, 'recovered-agent', registry);
    expect(readPendingWorkspaceJoin(serverContext)).toBeNull();
  }, 10_000);

  it('recovers an inserted linked-worktree member after its root moves', () => {
    const main = repository();
    const registry = registryRoot();
    git(main.root, ['add', '.']);
    git(main.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initialize repository',
    ]);
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const linkedRoot = `${main.root}-interrupted-linked`;
    const movedRoot = `${main.root}-interrupted-moved`;
    try {
      git(main.root, ['worktree', 'add', '-b', 'interrupted-feature', linkedRoot]);
      const linked = resolveRepository(linkedRoot);
      writePendingWorkspaceJoin(linked, {
        workspaceId: workspace.workspace.id,
        memberName: 'feature',
        mode: 'fresh',
      });
      const target = openDatabase(linked, {
        databasePath: workspace.workspace.databasePath,
        member: {
          workspaceId: workspace.workspace.id,
          workspaceName: workspace.workspace.name,
          workspaceImplicit: false,
          repositoryId: workspace.member.repositoryId,
          repositoryName: workspace.member.repositoryName,
          worktreeId: 'worktree_interrupted_feature',
          worktreeName: 'feature',
        },
      });
      target.close();
      git(main.root, ['worktree', 'move', linkedRoot, movedRoot]);

      expect(
        addWorkspaceMember(
          movedRoot,
          { workspaceId: workspace.workspace.id, memberName: 'feature', mode: 'fresh' },
          { registryRoot: registry },
        ),
      ).toMatchObject({
        member: {
          id: 'worktree_interrupted_feature',
          name: 'feature',
          root: movedRoot,
        },
      });
    } finally {
      git(main.root, ['worktree', 'remove', '--force', movedRoot]);
    }
  });

  it('shares tasks and messages across sibling repository members', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
      { registryRoot: registry },
    );

    const studioAgent = open(studio.root, 'studio-agent', registry);
    const serverAgent = open(server.root, 'server-agent', registry);
    const task = studioAgent.createTask({
      title: 'Cross-repository task',
      members: ['studio', 'holo-server'],
    });
    const globalTask = studioAgent.createTask({ title: 'Workspace-global task' });
    studioAgent.updateTask(globalTask.id, { members: ['holo-server'] });
    studioAgent.sendMessage({
      to: 'server-agent',
      subject: 'Workspace message',
      body: 'Visible across members.',
    });

    expect(serverAgent.listTasks().map((item) => item.id)).toContain(task.id);
    expect(serverAgent.listTasks({ member: 'studio' })).toEqual([
      expect.objectContaining({ id: task.id, members: ['holo-server', 'studio'] }),
    ]);
    expect(serverAgent.listTasks({ member: 'holo-server' }).map((item) => item.id)).toEqual(
      expect.arrayContaining([task.id, globalTask.id]),
    );
    expect(serverAgent.inbox().map((message) => message.subject)).toContain('Workspace message');
    studioAgent.claimTask(task.id);
    const handoff = studioAgent.offerHandoff({
      taskId: task.id,
      to: 'server-agent',
      summary: 'Continue this workspace-global task.',
    });
    expect(serverAgent.listHandoffs().map((item) => item.id)).toContain(handoff.id);
    const status = serverAgent.snapshot();
    expect(status.workspace).toMatchObject({
      id: workspace.workspace.id,
      name: 'Product',
      currentMember: 'holo-server',
      implicit: false,
    });
    expect(status.session.homeMember).toBe('holo-server');
    expect(status.agent.activeMembers).toEqual(['holo-server']);
    expect(status.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'studio-agent', activeMembers: ['studio'] }),
        expect.objectContaining({ name: 'server-agent', activeMembers: ['holo-server'] }),
      ]),
    );
    expect(
      serverAgent
        .events({ limit: 100 })
        .find((event) => event.kind === 'task.created' && event.entityId === task.id),
    ).toMatchObject({ member: 'studio', worktreeId: workspace.member.id });
    expect(
      workspaceMembers(studio.root, { registryRoot: registry }).map((item) => item.name),
    ).toEqual(['holo-server', 'studio']);
  });

  it('qualifies claims by member and renews cross-member batches', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    const serverMember = addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
      { registryRoot: registry },
    );
    let now = 1_000;
    const studioAgent = Coordinator.open({
      cwd: studio.root,
      agent: 'studio-agent',
      clock: () => now,
      workspaceRegistryRoot: registry,
    });
    const serverAgent = Coordinator.open({
      cwd: server.root,
      agent: 'server-agent',
      clock: () => now,
      workspaceRegistryRoot: registry,
    });
    coordinators.push(studioAgent, serverAgent);
    execFileSync('git', ['config', 'core.ignorecase', 'true'], { cwd: server.root });

    const metadata = new Database(workspace.workspace.databasePath);
    metadata
      .prepare('UPDATE repositories SET ignore_case = 0 WHERE id = ?')
      .run(serverMember.member.repositoryId);
    metadata.close();

    const studioPath = studioAgent.acquireClaims([{ member: 'studio', path: 'src/shared.ts' }])[0];
    const serverPath = serverAgent.acquireClaims([
      { member: 'holo-server', path: 'src/shared.ts' },
    ])[0];
    expect(studioPath?.worktreeId).not.toBe(serverPath?.worktreeId);
    serverAgent.acquireClaims([{ member: 'holo-server', path: 'src/Case.ts' }]);
    expect(() =>
      studioAgent.acquireClaims([{ member: 'holo-server', path: 'src/case.ts' }]),
    ).toThrow(/overlaps/u);

    const crossMember = studioAgent.acquireClaims(
      [
        { member: 'studio', path: 'src/studio.ts' },
        { member: 'holo-server', path: 'src/server.ts' },
      ],
      30,
    );
    expect(crossMember.map((claim) => claim.member)).toEqual(['studio', 'holo-server']);
    expect(() =>
      serverAgent.acquireClaims([
        { member: 'holo-server', path: 'src/server.ts' },
        { member: 'studio', path: 'src/atomic-free.ts' },
      ]),
    ).toThrow(/holo-server:src\/server.ts overlaps/u);
    expect(
      studioAgent
        .listClaims()
        .some((claim) => claim.path === 'src/atomic-free.ts' && claim.agentName === 'server-agent'),
    ).toBe(false);

    now = 2_000;
    studioAgent.heartbeat();
    expect(
      studioAgent
        .listClaims()
        .filter((claim) => claim.agentName === 'studio-agent')
        .map((claim) => claim.expiresAt),
    ).toEqual([902_000, 902_000, 902_000]);
  });

  it('warns instead of blocking matching claims in linked worktrees', () => {
    const main = repository();
    const registry = registryRoot();
    git(main.root, ['add', '.']);
    git(main.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initialize repository',
    ]);
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const linkedRoot = `${main.root}-linked`;
    let mainAgent: Coordinator | undefined;
    let linkedAgent: Coordinator | undefined;
    try {
      git(main.root, ['worktree', 'add', '-b', 'feature', linkedRoot]);
      const linked = addWorkspaceMember(
        linkedRoot,
        { workspaceId: workspace.workspace.id, memberName: 'feature', mode: 'fresh' },
        { registryRoot: registry },
      );
      expect(linked.member.repositoryId).toBe(workspace.member.repositoryId);
      mainAgent = open(main.root, 'main-agent', registry);
      linkedAgent = open(linkedRoot, 'feature-agent', registry);

      git(linkedRoot, ['checkout', '-b', 'feature-2']);
      const remoteBranch = mainAgent.snapshot();
      expect(remoteBranch.sessions).toContainEqual(
        expect.objectContaining({
          agentName: 'feature-agent',
          startedBranch: 'feature',
          currentBranch: 'feature-2',
          branchChanged: true,
        }),
      );
      expect(remoteBranch.warnings).toContainEqual(
        expect.objectContaining({ code: 'BRANCH_CHANGED', member: 'feature' }),
      );

      mainAgent.acquireClaims([{ member: 'main', path: 'src/shared.ts' }]);
      const linkedClaim = linkedAgent.acquireClaims([
        { member: 'feature', path: 'src/shared.ts' },
      ])[0];
      expect(linkedClaim?.warnings).toContainEqual(
        expect.objectContaining({
          code: 'LINKED_WORKTREE_OVERLAP',
          member: 'feature',
          conflictingMember: 'main',
        }),
      );
      expect(linkedAgent.snapshot().warnings).toContainEqual(
        expect.objectContaining({ code: 'LINKED_WORKTREE_OVERLAP' }),
      );
      const batch = mainAgent.acquireClaims([
        { member: 'main', path: 'src/batch.ts' },
        { member: 'feature', path: 'src/batch.ts' },
      ]);
      expect(batch).toHaveLength(2);
      for (const claim of batch) {
        expect(claim.warnings).toContainEqual(
          expect.objectContaining({ code: 'LINKED_WORKTREE_OVERLAP' }),
        );
      }
    } finally {
      linkedAgent?.close();
      mainAgent?.close();
      git(main.root, ['worktree', 'remove', '--force', linkedRoot]);
    }
  });

  it('scopes policy reads, acknowledgements, and events to a target member', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    const serverMember = addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
      { registryRoot: registry },
    );
    writeFileSync(
      path.join(server.root, '.sametree', 'policy.md'),
      '# Holo server policy\n',
      'utf8',
    );
    const agent = open(studio.root, 'policy-agent', registry);

    const local = agent.getPolicy();
    const remote = agent.getPolicy('holo-server');
    expect(remote).toMatchObject({
      member: 'holo-server',
      worktreeId: serverMember.member.id,
      path: path.join(server.root, '.sametree', 'policy.md'),
      acknowledgedAt: null,
    });
    expect(remote.hash).not.toBe(local.hash);
    expect(agent.acknowledgePolicy(remote.hash, 'holo-server')).toMatchObject({
      member: 'holo-server',
      worktreeId: serverMember.member.id,
      newlyAcknowledged: true,
    });
    expect(agent.getPolicy('holo-server').acknowledgedAt).not.toBeNull();
    expect(agent.getPolicy().acknowledgedAt).toBeNull();
    expect(
      agent.events({ limit: 100 }).find((event) => event.kind === 'policy.acknowledged'),
    ).toMatchObject({
      member: 'holo-server',
      worktreeId: serverMember.member.id,
    });
  });

  it('refuses active imports and identity collisions without binding the source', () => {
    const studio = repository();
    const server = repository();
    const active = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    const existing = open(studio.root, 'same-agent', registry);
    existing.close();

    const source = open(server.root, 'same-agent');
    source.createTask({ title: 'Conflicting state' });
    source.close();
    expect(() =>
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'server', mode: 'import-current' },
        { registryRoot: registry },
      ),
    ).toThrow(/identity 'same-agent' already exists/u);
    expect(
      resolveWorkspaceBinding(resolveRepository(server.root), { registryRoot: registry }),
    ).toBeNull();
    expect(workspaceMembers(studio.root, { registryRoot: registry })).toHaveLength(1);

    const activeAgent = open(active.root, 'active-agent');
    expect(() =>
      addWorkspaceMember(
        active.root,
        { workspaceId: workspace.workspace.id, memberName: 'active', mode: 'import-current' },
        { registryRoot: registry },
      ),
    ).toThrow(/Stop active standalone sessions/u);
    expect(
      resolveWorkspaceBinding(resolveRepository(active.root), { registryRoot: registry }),
    ).toBeNull();
    activeAgent.close();
  });

  it('preflights member ID collisions without mutating the existing member', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );

    const serverContext = resolveRepository(server.root);
    openDatabase(serverContext).close();
    const source = new Database(serverContext.databasePath);
    source.pragma('foreign_keys = OFF');
    source.prepare('UPDATE repositories SET id = ?').run(workspace.member.repositoryId);
    source
      .prepare('UPDATE worktrees SET id = ?, repository_id = ?')
      .run(workspace.member.id, workspace.member.repositoryId);
    source.close();

    expect(() =>
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'server', mode: 'import-current' },
        { registryRoot: registry },
      ),
    ).toThrow(/Repository identity .* already exists/u);
    expect(workspaceMembers(studio.root, { registryRoot: registry })).toEqual([
      expect.objectContaining({ id: workspace.member.id, name: 'studio' }),
    ]);
    expect(resolveWorkspaceBinding(serverContext, { registryRoot: registry })).toBeNull();
    const unlocked = new Database(serverContext.databasePath);
    expect(() => unlocked.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
    unlocked.close();
  });

  it('rejects unverified bindings, alternate databases, and session starts during joins', () => {
    const orphan = repository();
    const registry = registryRoot();
    const context = resolveRepository(orphan.root);
    const registered = registerWorkspace(
      { id: 'workspace_orphan', name: 'Orphan', createdAt: 1 },
      { registryRoot: registry },
    );
    bindWorktree(
      context,
      {
        workspaceId: registered.id,
        repositoryId: 'repository_orphan',
        repositoryName: 'Orphan',
        worktreeId: 'worktree_orphan',
        worktreeName: 'orphan',
      },
      { registryRoot: registry },
    );
    expect(() => open(orphan.root, 'orphan-agent', registry)).toThrow(
      /Bound workspace database is missing/u,
    );

    const joinedRepository = repository();
    const joined = createWorkspace(
      joinedRepository.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    expect(() =>
      Coordinator.open({
        cwd: joinedRepository.root,
        agent: 'alternate-database',
        databasePath: ':memory:',
        workspaceRegistryRoot: registry,
      }),
    ).toThrow(/cannot override its workspace database/u);

    const locked = repository();
    const lockedContext = resolveRepository(locked.root);
    const release = acquireWorkspaceOperationLock(lockedContext);
    try {
      expect(() => open(locked.root, 'racing-agent')).toThrow(
        /session startup or workspace operation is active/u,
      );
    } finally {
      release();
    }
    const recoveredRelease = acquireWorkspaceOperationLock(lockedContext);
    recoveredRelease();
    expect(joined.workspace.databasePath).not.toBe(':memory:');
  });

  it('retries workspace creation with the same registered identity', () => {
    const source = repository();
    const registry = registryRoot();
    const active = open(source.root, 'active-agent');
    const create = () =>
      createWorkspace(
        source.root,
        { name: 'Product', memberName: 'studio', mode: 'fresh' },
        { registryRoot: registry },
      );

    expect(create).toThrow(/Stop active standalone sessions/u);
    const [pending] = listRegisteredWorkspaces({ registryRoot: registry });
    expect(pending).toBeDefined();
    expect(create).toThrow(/Stop active standalone sessions/u);
    expect(listRegisteredWorkspaces({ registryRoot: registry })).toHaveLength(1);

    active.close();
    expect(create()).toMatchObject({ workspace: { id: pending?.id }, member: { name: 'studio' } });
    expect(listRegisteredWorkspaces({ registryRoot: registry })).toHaveLength(1);
  });

  it('cancels a pending creation before any member was recorded', () => {
    const source = repository();
    const joining = repository();
    const registry = registryRoot();
    const active = open(source.root, 'active-agent');
    expect(() =>
      createWorkspace(
        source.root,
        { name: 'Product', memberName: 'studio', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/Stop active standalone sessions/u);
    const [pending] = listRegisteredWorkspaces({ registryRoot: registry });
    if (!pending) throw new Error('Expected a pending workspace registration.');
    writePendingWorkspaceJoin(resolveRepository(joining.root), {
      workspaceId: pending.id,
      memberName: 'joining',
      mode: 'fresh',
    });

    expect(cancelWorkspaceCreation(source.root, { registryRoot: registry })).toEqual({
      cancelled: true,
      workspaceId: pending.id,
    });
    expect(listRegisteredWorkspaces({ registryRoot: registry })).toEqual([]);
    active.close();
    expect(
      createWorkspace(
        joining.root,
        { name: 'Renamed', memberName: 'renamed', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toMatchObject({ workspace: { name: 'Renamed' }, member: { name: 'renamed' } });
  });

  it('does not replace an interrupted add with a new workspace creation', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    const serverContext = resolveRepository(server.root);
    writePendingWorkspaceJoin(serverContext, {
      workspaceId: workspace.workspace.id,
      memberName: 'holo-server',
      mode: 'fresh',
    });
    const target = openDatabase(serverContext, {
      databasePath: workspace.workspace.databasePath,
      member: {
        workspaceId: workspace.workspace.id,
        workspaceName: workspace.workspace.name,
        workspaceImplicit: false,
        repositoryId: 'repository_interrupted_add',
        repositoryName: 'holo-server',
        worktreeId: 'worktree_interrupted_add',
        worktreeName: 'holo-server',
      },
    });
    target.close();

    expect(() =>
      createWorkspace(
        server.root,
        { name: 'Replacement', memberName: 'replacement', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/Complete the pending workspace join/u);
    expect(listRegisteredWorkspaces({ registryRoot: registry })).toHaveLength(1);
    expect(() => cancelWorkspaceCreation(server.root, { registryRoot: registry })).toThrow(
      /no pending workspace creation/u,
    );
    expect(
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toMatchObject({ member: { id: 'worktree_interrupted_add' } });
  });

  it('clears a join intent after a recoverable preflight collision', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );

    expect(() =>
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'studio', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/Worktree name/u);
    expect(
      addWorkspaceMember(
        server.root,
        { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toMatchObject({ member: { name: 'holo-server' } });
  });

  it('cancels a pending creation whose registration was never persisted', () => {
    const source = repository();
    const registry = registryRoot();
    const active = open(source.root, 'active-agent');
    expect(() =>
      createWorkspace(
        source.root,
        { name: 'Product', memberName: 'studio', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/Stop active standalone sessions/u);
    const [pending] = listRegisteredWorkspaces({ registryRoot: registry });
    if (!pending) throw new Error('Expected a pending workspace registration.');
    removeRegisteredWorkspace(pending.id, { registryRoot: registry });

    expect(cancelWorkspaceCreation(source.root, { registryRoot: registry })).toEqual({
      cancelled: true,
      workspaceId: pending.id,
    });
    active.close();
    expect(() => cancelWorkspaceCreation(source.root, { registryRoot: registry })).toThrow(
      /no pending workspace creation/u,
    );
  });

  it('prunes missing members while preserving their task and claim history', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
      { registryRoot: registry },
    );
    const serverAgent = open(server.root, 'server-agent', registry);
    const task = serverAgent.claimTask(
      serverAgent.createTask({
        title: 'Preserve after prune',
        members: ['holo-server'],
      }).id,
    );
    const claim = serverAgent.acquireClaims([
      { member: 'holo-server', path: 'src/preserved.ts' },
    ])[0];
    serverAgent.close();
    server.cleanup();

    expect(pruneWorkspace(studio.root, { registryRoot: registry }).pruned).toEqual([
      expect.objectContaining({ name: 'holo-server', available: false }),
    ]);
    const observer = open(studio.root, 'observer', registry);
    expect(observer.listTasks({ member: 'holo-server' })).toContainEqual(
      expect.objectContaining({ id: task.id }),
    );
    expect(observer.listClaims({ includeExpired: true })).toContainEqual(
      expect.objectContaining({ id: claim?.id, member: 'holo-server' }),
    );
    expect(() => observer.acquireClaims([{ member: 'holo-server', path: 'src/new.ts' }])).toThrow(
      /is unavailable/u,
    );
    expect(() =>
      observer.forceTakeoverTask(task.id, {
        claimIds: claim ? [claim.id] : [],
        expectedRevision: task.revision,
        reason: 'The user explicitly requested a takeover test.',
        userAuthorized: true,
      }),
    ).toThrow(/no longer transferable/u);
    expect(diagnoseWorkspace(studio.root, { registryRoot: registry })).toMatchObject({
      ok: false,
      foreignKeyViolations: 0,
      warnings: [expect.stringContaining('holo-server is unavailable')],
    });
  });

  it('leaves without deleting workspace history', () => {
    const studio = repository();
    const server = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      studio.root,
      { name: 'Product', memberName: 'studio', mode: 'fresh' },
      { registryRoot: registry },
    );
    addWorkspaceMember(
      server.root,
      { workspaceId: workspace.workspace.id, memberName: 'holo-server', mode: 'fresh' },
      { registryRoot: registry },
    );
    const studioAgent = open(studio.root, 'studio-agent', registry);
    const serverAgent = open(server.root, 'server-agent', registry);
    const task = serverAgent.createTask({ title: 'Leave history', members: ['holo-server'] });
    const handoffTask = studioAgent.claimTask(
      studioAgent.createTask({ title: 'Reject retired recipient' }).id,
    );
    const handoff = studioAgent.offerHandoff({
      taskId: handoffTask.id,
      to: 'server-agent',
      summary: 'Verify that a retired recipient cannot accept this work.',
    });
    serverAgent.acquireClaims([{ member: 'studio', path: 'src/shared.ts' }]);
    expect(() => leaveWorkspace(server.root, { registryRoot: registry })).toThrow(
      /Stop active sessions/u,
    );

    expect(
      leaveWorkspace(server.root, { registryRoot: registry, now: Date.now() + 1_000_000 }),
    ).toMatchObject({
      name: 'holo-server',
      available: false,
    });
    expect(() => serverAgent.acquireClaims([{ member: 'studio', path: 'src/shared.ts' }])).toThrow(
      /session expired/u,
    );
    expect(() => serverAgent.updateTask(task.id, { status: 'in_progress' })).toThrow(
      /session expired/u,
    );
    expect(() =>
      serverAgent.forceTakeoverTask(handoffTask.id, {
        expectedRevision: handoffTask.revision,
        reason: 'The user explicitly requested a retired-session takeover test.',
        userAuthorized: true,
      }),
    ).toThrow(/session expired/u);
    expect(() =>
      serverAgent.respondToHandoff(handoff.id, true, {
        reason: 'The user explicitly requested a retired-session handoff test.',
        userAuthorized: true,
      }),
    ).toThrow(/session expired/u);
    expect(
      resolveWorkspaceBinding(resolveRepository(server.root), { registryRoot: registry }),
    ).toBeNull();
    const observer = open(studio.root, 'observer', registry);
    expect(observer.listTasks({ member: 'holo-server' })).toContainEqual(
      expect.objectContaining({ id: task.id }),
    );
  });

  it('relinks a moved worktree only when its private Git identity matches', () => {
    const main = repository();
    const registry = registryRoot();
    git(main.root, ['add', '.']);
    git(main.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initialize repository',
    ]);
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const linkedRoot = `${main.root}-linked`;
    const movedRoot = `${main.root}-moved`;
    try {
      git(main.root, ['worktree', 'add', '-b', 'feature', linkedRoot]);
      addWorkspaceMember(
        linkedRoot,
        { workspaceId: workspace.workspace.id, memberName: 'feature', mode: 'fresh' },
        { registryRoot: registry },
      );
      git(main.root, ['worktree', 'move', linkedRoot, movedRoot]);

      const releaseStartupLock = acquireWorkspaceOperationLock(resolveRepository(movedRoot));
      try {
        expect(() => pruneWorkspace(main.root, { registryRoot: registry })).toThrow(
          /Another session startup or workspace operation/u,
        );
      } finally {
        releaseStartupLock();
      }

      expect(pruneWorkspace(main.root, { registryRoot: registry }).pruned).toEqual([
        expect.objectContaining({ name: 'feature', available: false }),
      ]);
      expect(() =>
        Coordinator.open({
          cwd: movedRoot,
          agent: 'must-relink',
          workspaceRegistryRoot: registry,
        }),
      ).toThrow(/does not match its registered database member/u);

      expect(
        relinkWorkspace(
          movedRoot,
          { workspaceId: workspace.workspace.id, memberName: 'feature' },
          { registryRoot: registry },
        ),
      ).toMatchObject({ name: 'feature', root: movedRoot, available: true });
      expect(diagnoseWorkspace(main.root, { registryRoot: registry })).toMatchObject({
        ok: true,
        warnings: [],
      });
    } finally {
      git(main.root, ['worktree', 'remove', '--force', movedRoot]);
    }
  }, 10_000);

  it('recovers a sole moved member after prune removes its repository binding', () => {
    const main = repository();
    const registry = registryRoot();
    git(main.root, ['add', '.']);
    git(main.root, [
      '-c',
      'user.name=SameTree Test',
      '-c',
      'user.email=sametree@example.com',
      'commit',
      '-m',
      'test: initialize repository',
    ]);
    const linkedRoot = `${main.root}-only-linked`;
    const movedRoot = `${main.root}-only-moved`;
    try {
      git(main.root, ['worktree', 'add', '-b', 'only-feature', linkedRoot]);
      const workspace = createWorkspace(
        linkedRoot,
        { name: 'Product', memberName: 'feature', mode: 'fresh' },
        { registryRoot: registry },
      );
      git(main.root, ['worktree', 'move', linkedRoot, movedRoot]);

      expect(pruneWorkspace(movedRoot, { registryRoot: registry }).pruned).toEqual([
        expect.objectContaining({ name: 'feature', available: false }),
      ]);
      expect(resolveRepositoryWorkspaceBinding(resolveRepository(movedRoot))).toBeNull();
      expect(
        relinkWorkspace(
          movedRoot,
          { workspaceId: workspace.workspace.id, memberName: 'feature' },
          { registryRoot: registry },
        ),
      ).toMatchObject({ name: 'feature', root: movedRoot, available: true });
    } finally {
      git(main.root, ['worktree', 'remove', '--force', movedRoot]);
    }
  });

  it('repairs interrupted retirement cleanup without repeating the transition', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const repositoryContext = resolveRepository(main.root);
    const database = new Database(workspace.workspace.databasePath);
    database.prepare('UPDATE worktrees SET available = 0 WHERE id = ?').run(workspace.member.id);
    database.close();
    clearRepositoryWorkspaceBinding(repositoryContext, {
      workspaceId: workspace.workspace.id,
      repositoryId: workspace.member.repositoryId,
    });

    expect(leaveWorkspace(main.root, { registryRoot: registry })).toMatchObject({
      name: 'main',
      available: false,
    });
    expect(resolveWorkspaceBinding(repositoryContext, { registryRoot: registry })).toBeNull();
    const verified = new Database(workspace.workspace.databasePath, { readonly: true });
    expect(
      verified.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'worktree.left'").get(),
    ).toEqual({ count: 0 });
    verified.close();
  });

  it('does not report an unavailable member with stale bindings as joined', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const database = new Database(workspace.workspace.databasePath);
    database.prepare('UPDATE worktrees SET available = 0 WHERE id = ?').run(workspace.member.id);
    database.close();

    expect(() =>
      addWorkspaceMember(
        main.root,
        { workspaceId: workspace.workspace.id, memberName: 'main', mode: 'fresh' },
        { registryRoot: registry },
      ),
    ).toThrow(/does not match its registered database member/u);
  });

  it('cleans a stale repository binding when prune retries after retirement', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const database = new Database(workspace.workspace.databasePath);
    database.prepare('UPDATE worktrees SET available = 0 WHERE id = ?').run(workspace.member.id);
    database.close();

    expect(pruneWorkspace(main.root, { registryRoot: registry })).toEqual({ pruned: [] });
    expect(resolveRepositoryWorkspaceBinding(resolveRepository(main.root))).toBeNull();
  });

  it('reports source paths that would make coordinator startup fail', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const database = new Database(workspace.workspace.databasePath);
    database
      .prepare('UPDATE workspace_sources SET source_database_path = ? WHERE worktree_id = ?')
      .run('/incorrect/state.sqlite3', workspace.member.id);
    database.close();

    expect(diagnoseWorkspace(main.root, { registryRoot: registry })).toMatchObject({
      ok: false,
      warnings: [expect.stringContaining('incorrect source database path')],
    });
    expect(() =>
      Coordinator.open({
        cwd: main.root,
        agent: 'invalid-source',
        workspaceRegistryRoot: registry,
      }),
    ).toThrow(/does not match its registered database member/u);
  });

  it('reports workspace metadata that would make startup and relink fail', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const database = new Database(workspace.workspace.databasePath);
    database.prepare('UPDATE workspace_metadata SET name = ?').run('Incorrect');
    database.close();

    expect(diagnoseWorkspace(main.root, { registryRoot: registry })).toMatchObject({
      ok: false,
      warnings: [expect.stringContaining('registry and database identities disagree')],
    });
    expect(() =>
      relinkWorkspace(
        main.root,
        { workspaceId: workspace.workspace.id, memberName: 'main' },
        { registryRoot: registry },
      ),
    ).toThrow(/registry and database disagree/u);
  });

  it('refuses lifecycle writes through a symlinked workspace database', () => {
    const main = repository();
    const registry = registryRoot();
    const workspace = createWorkspace(
      main.root,
      { name: 'Product', memberName: 'main', mode: 'fresh' },
      { registryRoot: registry },
    );
    const realDatabase = `${workspace.workspace.databasePath}.real`;
    renameSync(workspace.workspace.databasePath, realDatabase);
    symlinkSync(realDatabase, workspace.workspace.databasePath);

    expect(() => leaveWorkspace(main.root, { registryRoot: registry })).toThrow(
      /symlinked database path/u,
    );
  });
});
