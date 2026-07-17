import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { SameTreeError } from '../src/errors.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

function setup() {
  const repository = createTestRepository();
  repositories.push(repository);
  const open = (agent: string) => {
    const coordinator = Coordinator.open({ cwd: repository.root, agent });
    coordinators.push(coordinator);
    return coordinator;
  };
  return { repository, open };
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('Coordinator', () => {
  it('enforces task dependencies and active leases', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const prerequisite = author.createTask({ title: 'Define contract' });
    const implementation = author.createTask({
      title: 'Implement contract',
      dependencies: [prerequisite.id],
    });

    expect(() => reviewer.claimTask(implementation.id)).toThrowError(
      expect.objectContaining({ code: 'TASK_BLOCKED' }),
    );

    author.claimTask(prerequisite.id);
    author.updateTask(prerequisite.id, { status: 'done' });
    const claimed = author.claimTask(implementation.id);

    expect(claimed.assignee).toBe('author');
    expect(() => reviewer.claimTask(implementation.id)).toThrowError(
      expect.objectContaining({ code: 'TASK_UNAVAILABLE' }),
    );
  });

  it('preserves ready assignments and requires a claim before updates', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const assigned = author.createTask({ title: 'Assigned work', assignee: 'author' });
    const unassigned = author.createTask({ title: 'Unassigned work' });

    expect(() => reviewer.claimTask(assigned.id)).toThrowError(
      expect.objectContaining({ code: 'TASK_UNAVAILABLE' }),
    );
    expect(() =>
      reviewer.updateTask(unassigned.id, { description: 'Taken without a claim' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_ASSIGNED' }));
  });

  it('checks dependencies on every transition into progress', () => {
    const { open } = setup();
    const author = open('author');
    const prerequisite = author.createTask({ title: 'Prerequisite' });
    const assigned = author.createTask({
      title: 'Assigned dependent work',
      assignee: 'author',
      dependencies: [prerequisite.id],
    });

    expect(() => author.updateTask(assigned.id, { status: 'in_progress' })).toThrowError(
      expect.objectContaining({ code: 'TASK_BLOCKED' }),
    );
  });

  it('acquires claim batches atomically', () => {
    const { open } = setup();
    const first = open('first');
    const second = open('second');
    first.acquireClaims([{ path: 'src', kind: 'tree' }]);

    expect(() =>
      second.acquireClaims([
        { path: 'docs', kind: 'tree' },
        { path: 'src/api.ts', kind: 'exact' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CLAIM_CONFLICT' }));
    expect(second.listClaims().some((claim) => claim.path === 'docs')).toBe(false);
  });

  it('prevents claims through different aliases of the same directory', () => {
    const { repository, open } = setup();
    mkdirSync(path.join(repository.root, 'real'));
    symlinkSync('real', path.join(repository.root, 'alias'));
    const first = open('first');
    const second = open('second');
    first.acquireClaims([{ path: 'alias/shared.ts' }]);

    expect(() => second.acquireClaims([{ path: 'real/shared.ts' }])).toThrowError(
      expect.objectContaining({ code: 'CLAIM_CONFLICT' }),
    );
  });

  it('delivers and acknowledges direct and broadcast messages', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const direct = reviewer.sendMessage({
      to: 'author',
      subject: 'Review finding',
      body: 'Handle the empty state.',
    });
    reviewer.sendMessage({ subject: 'Heads up', body: 'The schema changed.' });

    expect(author.inbox({ unreadOnly: true })).toHaveLength(2);
    expect(author.acknowledgeMessage(direct.id).readAt).not.toBeNull();
    expect(author.inbox({ unreadOnly: true })).toHaveLength(1);
  });

  it('transfers task ownership and selected claims through a handoff', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.claimTask(task.id);
    const [claim] = author.acquireClaims([{ path: 'src/parser.ts' }]);
    if (!claim) throw new Error('Expected an acquired claim.');

    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Parser is ready for edge-case fixes.',
      context: { commit: 'abc123' },
      claimIds: [claim.id],
    });
    reviewer.respondToHandoff(offer.id, true);

    expect(reviewer.listTasks().find((item) => item.id === task.id)?.assignee).toBe('reviewer');
    expect(reviewer.listClaims().find((item) => item.id === claim.id)?.agentName).toBe('reviewer');
  });

  it('rejects partial transfers that would create cross-agent claim overlap', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.claimTask(task.id);
    author.acquireClaims([{ path: 'src', kind: 'tree' }]);
    const [exact] = author.acquireClaims([{ path: 'src/parser.ts' }]);
    if (!exact) throw new Error('Expected an exact claim.');
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Transfer only one overlapping claim.',
      claimIds: [exact.id],
    });

    expect(() => reviewer.respondToHandoff(offer.id, true)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_CONFLICT' }),
    );
    expect(author.listTasks().find((item) => item.id === task.id)?.assignee).toBe('author');
  });

  it('keeps pending handoffs valid when the source session closes', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.claimTask(task.id);
    const [claim] = author.acquireClaims([{ path: 'src/parser.ts' }]);
    if (!claim) throw new Error('Expected an acquired claim.');
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Continue after I exit.',
      claimIds: [claim.id],
    });

    author.close();

    expect(reviewer.respondToHandoff(offer.id, true).status).toBe('accepted');
  });

  it('rejects a handoff when its task revision becomes stale', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.claimTask(task.id);
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Continue implementation.',
    });
    author.updateTask(task.id, { description: 'The contract changed.' });

    expect(() => reviewer.respondToHandoff(offer.id, true)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_CONFLICT' }),
    );
  });

  it('does not offer terminal tasks for handoff', () => {
    const { open } = setup();
    const author = open('author');
    open('reviewer');
    const task = author.createTask({ title: 'Completed work' });
    author.claimTask(task.id);
    author.updateTask(task.id, { status: 'done' });

    expect(() =>
      author.offerHandoff({ taskId: task.id, to: 'reviewer', summary: 'Resurrect this task.' }),
    ).toThrowError(expect.objectContaining({ code: 'TASK_UNAVAILABLE' }));
  });

  it('does not renew an expired session or its task lease', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    let now = 1_000_000;
    const author = Coordinator.open({ cwd: repository.root, agent: 'author', clock: () => now });
    coordinators.push(author);
    const task = author.createTask({ title: 'Expiring work' });
    const originalLease = author.claimTask(task.id).leaseExpiresAt;
    now += 91_000;

    expect(() => author.heartbeat()).toThrowError(
      expect.objectContaining({ code: 'TASK_UNAVAILABLE' }),
    );
    expect(author.listTasks().find((item) => item.id === task.id)?.leaseExpiresAt).toBe(
      originalLease,
    );
  });

  it('does not deliver historical broadcasts to future agents', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const author = Coordinator.open({ cwd: repository.root, agent: 'author', clock: () => 1_000 });
    coordinators.push(author);
    author.sendMessage({ subject: 'Before registration', body: 'Historical announcement.' });
    const future = Coordinator.open({ cwd: repository.root, agent: 'future', clock: () => 1_000 });
    coordinators.push(future);

    expect(future.inbox()).toEqual([]);
  });

  it('bounds serialized handoff context', () => {
    const { open } = setup();
    const author = open('author');
    open('reviewer');
    const task = author.createTask({ title: 'Bounded handoff' });
    author.claimTask(task.id);

    expect(() =>
      author.offerHandoff({
        taskId: task.id,
        to: 'reviewer',
        summary: 'Oversized context.',
        context: { payload: 'x'.repeat(100_000) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('ties policy acknowledgements to exact content hashes', () => {
    const { open } = setup();
    const author = open('author');
    const policy = author.getPolicy();

    expect(policy.acknowledgedAt).toBeNull();
    expect(author.acknowledgePolicy(policy.hash).acknowledgedAt).not.toBeNull();
    expect(() => author.acknowledgePolicy('0'.repeat(64))).toThrow(SameTreeError);
  });

  it('reports healthy SQLite state', () => {
    const { open } = setup();
    const report = open('doctor').doctor();

    expect(report).toMatchObject({
      ok: true,
      integrity: 'ok',
      journalMode: 'wal',
      foreignKeyViolations: 0,
      policyPresent: true,
    });
  });
});
