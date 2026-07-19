import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { SameTreeError } from '../src/errors.js';
import { resolveRepository } from '../src/git.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

function setup(clock?: () => number) {
  const repository = createTestRepository();
  repositories.push(repository);
  const open = (agent: string) => {
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent,
      ...(clock ? { clock } : {}),
    });
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
  it('can omit lifecycle events while retaining a durable closed session', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent: 'quiet-session',
      recordSessionLifecycleEvents: false,
    });
    coordinators.push(coordinator);
    const sessionId = coordinator.sessionId;

    expect(coordinator.events({ after: 0 })).toEqual([]);
    coordinator.close();

    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(database.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId)).toEqual({
      status: 'closed',
    });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM events WHERE entity_id = ?').get(sessionId),
    ).toEqual({
      count: 0,
    });
    database.close();
  });

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
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
  });

  it('creates self-owned task records and rejects peer assignment', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const assigned = author.createTask({ title: 'Assigned work', assignee: 'author' });
    const implicit = author.createTask({ title: 'Implicit self-assignment' });

    expect(implicit.assignee).toBe('author');
    expect(() =>
      author.createTask({ title: 'Peer assignment', assignee: 'reviewer' }),
    ).toThrowError(expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }));

    expect(() => reviewer.claimTask(assigned.id)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(() =>
      reviewer.updateTask(implicit.id, { description: 'Taken without a claim' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_ASSIGNED' }));
  });

  it('requires direct user authorization to adopt a legacy unassigned task', () => {
    const { repository, open } = setup();
    const author = open('author');
    const database = new Database(resolveRepository(repository.root).databasePath);
    database
      .prepare(
        `INSERT INTO tasks
          (id, title, description, status, priority, assignee, revision, created_at, updated_at)
         VALUES ('task_legacy', 'Legacy task', '', 'ready', 'normal', NULL, 1, 1, 1)`,
      )
      .run();
    database.close();

    expect(() => author.claimTask('task_legacy')).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(
      author.claimTask('task_legacy', {
        expectedRevision: 1,
        reason: 'The user explicitly assigned this legacy task.',
        userAuthorized: true,
      }),
    ).toMatchObject({ assignee: 'author', status: 'in_progress' });
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

  it('forcibly transfers active work and selected claims with user authorization', () => {
    const { open } = setup();
    const owner = open('owner');
    const replacement = open('replacement');
    const task = owner.createTask({ title: 'Transfer active work' });
    const active = owner.claimTask(task.id);
    const [claim] = owner.acquireClaims([{ path: 'src/active.ts' }]);
    if (!claim) throw new Error('Expected an active claim.');

    const takeover = replacement.forceTakeoverTask(task.id, {
      claimIds: [claim.id],
      expectedRevision: active.revision,
      reason: 'The user reassigned this work while the first agent handles another task.',
      userAuthorized: true,
    });

    expect(takeover.task).toMatchObject({ assignee: 'replacement', status: 'in_progress' });
    expect(takeover.claims).toEqual([
      expect.objectContaining({ id: claim.id, agentName: 'replacement' }),
    ]);
    expect(() => owner.updateTask(task.id, { description: 'Old owner update.' })).toThrowError(
      expect.objectContaining({ code: 'NOT_ASSIGNED' }),
    );
    expect(
      replacement.events({ after: 0 }).find((event) => event.kind === 'task.force_taken_over'),
    ).toMatchObject({
      actor: 'replacement',
      payload: {
        newAssignee: 'replacement',
        previousAssignee: 'owner',
        claimIds: [claim.id],
        reason: 'The user reassigned this work while the first agent handles another task.',
        userAuthorized: true,
      },
    });
  });

  it('requires authorization and a current revision for forced takeover', () => {
    const { open } = setup();
    const owner = open('owner');
    const first = open('first-replacement');
    const second = open('second-replacement');
    const active = owner.claimTask(owner.createTask({ title: 'Contended takeover' }).id);

    expect(() =>
      first.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'No user authorization was supplied.',
        userAuthorized: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));

    first.forceTakeoverTask(active.id, {
      expectedRevision: active.revision,
      reason: 'The user selected the first replacement.',
      userAuthorized: true,
    });
    expect(() =>
      second.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'This instruction used a stale task view.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TASK_UNAVAILABLE' }));
  });

  it('requires user-authorized takeover after lease expiry', () => {
    let now = Date.now();
    const { open } = setup(() => now);
    const owner = open('owner');
    const replacement = open('replacement');
    const active = owner.claimTask(owner.createTask({ title: 'Expired takeover' }).id);
    now += 901_000;

    expect(() => replacement.claimTask(active.id)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(
      replacement.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'The user reassigned this expired work.',
        userAuthorized: true,
      }).task.assignee,
    ).toBe('replacement');
  });

  it('rejects a forced partial claim transfer that creates overlap', () => {
    const { open } = setup();
    const owner = open('owner');
    const replacement = open('replacement');
    const active = owner.claimTask(owner.createTask({ title: 'Overlapping takeover' }).id);
    owner.acquireClaims([{ path: 'src', kind: 'tree' }]);
    const [nested] = owner.acquireClaims([{ path: 'src/api', kind: 'tree' }]);
    if (!nested) throw new Error('Expected a nested claim.');

    expect(() =>
      replacement.forceTakeoverTask(active.id, {
        claimIds: [nested.id],
        expectedRevision: active.revision,
        reason: 'The user selected only the nested path.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TASK_UNAVAILABLE' }));
    expect(owner.listTasks().find((task) => task.id === active.id)?.assignee).toBe('owner');
    expect(owner.listClaims().find((claim) => claim.id === nested.id)?.agentName).toBe('owner');
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

  it('rejects nested recursive claims in both acquisition orders', () => {
    const { open } = setup();
    const first = open('first');
    const second = open('second');
    first.acquireClaims([{ path: 'src', kind: 'tree' }]);

    expect(() => second.acquireClaims([{ path: 'src/api', kind: 'tree' }])).toThrowError(
      expect.objectContaining({ code: 'CLAIM_CONFLICT' }),
    );

    first.releaseClaims({ all: true });
    second.acquireClaims([{ path: 'src/api', kind: 'tree' }]);
    expect(() => first.acquireClaims([{ path: 'src', kind: 'tree' }])).toThrowError(
      expect.objectContaining({ code: 'CLAIM_CONFLICT' }),
    );
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

  it('reserves each unread message for only one live follower without acknowledging it', () => {
    const { open } = setup();
    const sender = open('sender');
    const first = open('recipient');
    const second = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Reserved work',
      body: 'Only one follower should inject this.',
    });

    expect(first.reserveNextMessageDelivery()?.id).toBe(message.id);
    expect(second.reserveNextMessageDelivery()).toBeNull();
    first.completeMessageDelivery(message.id);

    expect(second.reserveNextMessageDelivery()).toBeNull();
    expect(first.inbox({ unreadOnly: true }).map((item) => item.id)).toContain(message.id);
  });

  it('releases pending message reservations when a follower closes', () => {
    const { open } = setup();
    const sender = open('sender');
    const first = open('recipient');
    const second = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Retry delivery',
      body: 'Another follower can continue after shutdown.',
    });

    const original = first.reserveNextMessageDelivery();
    expect(original?.id).toBe(message.id);
    first.close();

    const recovered = second.reserveNextMessageDelivery();
    expect(recovered?.id).toBe(message.id);
  });

  it('allows a current session to recover an expired message reservation', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    let now = 1_000;
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender', clock: () => now });
    const expired = Coordinator.open({
      cwd: repository.root,
      agent: 'recipient',
      clock: () => now,
    });
    coordinators.push(sender, expired);
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Recover delivery',
      body: 'The original follower stopped heartbeating.',
    });
    expect(expired.reserveNextMessageDelivery()?.id).toBe(message.id);

    now += 91_000;
    const replacement = Coordinator.open({
      cwd: repository.root,
      agent: 'recipient',
      clock: () => now,
    });
    coordinators.push(replacement);

    expect(replacement.reserveNextMessageDelivery()?.id).toBe(message.id);
    expect(() => expired.completeMessageDelivery(message.id)).toThrowError(
      expect.objectContaining({ code: 'NOT_ASSIGNED' }),
    );
  });

  it('migrates a version 2 database without losing unread messages', () => {
    const { repository, open } = setup();
    const sender = open('sender');
    const recipient = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Survive migration',
      body: 'This message predates delivery tracking.',
    });
    sender.close();
    recipient.close();

    const database = new Database(resolveRepository(repository.root).databasePath);
    database.exec(
      'DROP TABLE message_deliveries; DELETE FROM schema_migrations WHERE version = 3;',
    );
    database.close();

    const migrated = open('recipient');
    expect(migrated.reserveNextMessageDelivery()?.id).toBe(message.id);
    const verification = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(
      verification.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    ).toEqual({ version: 3 });
    verification.close();
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
    expect(() => reviewer.respondToHandoff(offer.id, true)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    reviewer.respondToHandoff(offer.id, true, {
      reason: 'The user moved parser ownership to the reviewer.',
      userAuthorized: true,
    });

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
    const [nested] = author.acquireClaims([{ path: 'src/parser', kind: 'tree' }]);
    if (!nested) throw new Error('Expected a nested tree claim.');
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Transfer only one overlapping claim.',
      claimIds: [nested.id],
    });

    expect(() =>
      reviewer.respondToHandoff(offer.id, true, {
        reason: 'The user authorized this transfer.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_CONFLICT' }));
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

    expect(
      reviewer.respondToHandoff(offer.id, true, {
        reason: 'The user asked the reviewer to continue after the author exited.',
        userAuthorized: true,
      }).status,
    ).toBe('accepted');
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

    expect(() =>
      reviewer.respondToHandoff(offer.id, true, {
        reason: 'The user authorized the original handoff.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_CONFLICT' }));
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
    const acknowledged = author.acknowledgePolicy(policy.hash);
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    expect(author.acknowledgePolicy(policy.hash).acknowledgedAt).toBe(acknowledged.acknowledgedAt);
    expect(
      author.events({ after: 0 }).filter((event) => event.kind === 'policy.acknowledged'),
    ).toHaveLength(1);

    writeFileSync(policy.path, `${policy.content}\nNew policy version.\n`, 'utf8');
    const changed = author.getPolicy();
    expect(changed).toMatchObject({ acknowledgedAt: null });
    expect(changed.hash).not.toBe(policy.hash);
    author.acknowledgePolicy(changed.hash);
    expect(
      author.events({ after: 0 }).filter((event) => event.kind === 'policy.acknowledged'),
    ).toHaveLength(2);
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
