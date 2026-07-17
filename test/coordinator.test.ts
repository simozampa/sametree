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
