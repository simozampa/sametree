# Architecture

SameTree is a local-first coordination layer for a small number of cooperative coding agents sharing one Git working tree.

## Design Goals

- Work in an existing, possibly dirty working tree.
- Let independently launched Claude Code and OpenCode processes coordinate.
- Require no daemon, container, network port, or external database.
- Preserve task, message, claim, policy, and handoff state across agent restarts.
- Make conflicting state transitions atomic and auditable.
- Keep adapters thin enough that MCP and CLI behavior cannot diverge.

## Process Model

```text
┌────────────────────┐    stdio     ┌────────────────────┐
│ Claude Code client │─────────────▶│ SameTree MCP child │──┐
│ + monitor          │◀── messages ─│ SameTree follower  │──┤
└────────────────────┘              └────────────────────┘  │
┌────────────────────┐    stdio     ┌────────────────────┐  │
│ OpenCode client    │─────────────▶│ SameTree MCP child │──┤
│ + project plugin   │◀── messages ─│ SameTree follower  │──┤
└────────────────────┘              └────────────────────┘  │
┌────────────────────┐              ┌────────────────────┐  │
│ Human or hook      │─────────────▶│ SameTree CLI       │──┤
└────────────────────┘              └────────────────────┘  │
                                                           ▼
                                                ┌────────────────────┐
                                                │ Domain coordinator │
                                                └─────────┬──────────┘
                                                          ▼
                                                ┌────────────────────┐
                                                │ SQLite WAL         │
                                                └────────────────────┘
```

Each MCP client owns one server child process and one SameTree session. A heartbeat every 20 seconds renews the session, tasks, and path claims held by that process. CLI commands open their own sessions and leave acquired leases alive until explicit release or expiry; a later CLI process cannot renew an earlier process's session.

The CLI and MCP server call the same `Coordinator` domain service. Neither adapter contains coordination rules.

Each harness also owns a message follower with the same generated agent identity as its MCP child. The follower reserves one eligible message at a time. Claude Code treats each monitor line as accepted delivery. OpenCode writes the message ID back only after `promptAsync` accepts the injected prompt. Delivery records deduplicate adapter restarts without changing inbox read receipts.

## State Location

SameTree asks Git for the absolute, worktree-specific private directory:

```bash
git rev-parse --absolute-git-dir
```

It appends `sametree/state.sqlite3` without resolving child symlinks, allowing the database opener to reject a symlinked state directory safely.

This is preferable to a tracked `.sametree/state.sqlite3` because SQLite WAL sidecars should not be synchronized by Git. It also handles repositories where `.git` is a file and gives linked worktrees independent coordination state.

Versioned policy and role documents remain under the tracked `.sametree/` directory. Operational state and collaboration policy therefore have separate lifecycles.

## Why SQLite Instead of JSONL?

Append-only JSONL is inspectable, but compound operations still need cross-process locking. Examples include claiming a task only if its dependencies are complete, acquiring several paths all-or-nothing, or accepting a handoff only if its task revision is unchanged.

SQLite provides:

- Cross-process transactions and crash recovery.
- One canonical current-state model without replay at startup.
- Atomic current-state and audit-event writes.
- Foreign keys, strict tables, checks, and prepared statements.
- A single embedded file with no service lifecycle.

JSON remains at the boundaries and inside bounded event/context payloads, not as the writable source of truth. Handoff context is limited to 100,000 serialized UTF-8 bytes.

## Connection Settings

Every process configures its connection with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 2500;
PRAGMA trusted_schema = OFF;
PRAGMA cell_size_check = ON;
PRAGMA wal_autocheckpoint = 1000;
```

SameTree requires SQLite 3.51.3 or newer because earlier WAL versions were affected by a rare multi-connection reset race. The pinned `better-sqlite3` release currently bundles SQLite 3.53.x.

## Transaction Model

Mutations use `BEGIN IMMEDIATE`. The write reservation is obtained before reading conflict-sensitive state, so two processes cannot both observe a path or task as free and then both commit ownership.

A typical mutation is:

1. Normalize and validate untrusted input outside the transaction.
2. Begin an immediate transaction.
3. Read the current entity and any conflicting leases.
4. Check ownership, dependency, expiry, and revision invariants.
5. Update current state.
6. Append an audit event in the same transaction.
7. Commit and return the committed representation.

No Git command, filesystem traversal, or network operation runs inside a database transaction.

## Path Safety

Claims accept exact files and recursive directory trees, not arbitrary globs. Predictable overlap is more important than compact syntax.

Before a claim reaches SQLite, SameTree:

- Rejects empty paths, NULs, absolute escapes, and `..` traversal.
- Resolves the deepest existing ancestor to catch a future path below an escaping symlink.
- Stores repository-relative POSIX paths.
- Normalizes Unicode to NFC.
- Uses a case-folded comparison key when Git reports `core.ignorecase=true`.
- Compares tree prefixes only at path-component boundaries.

Batch acquisition is atomic. An overlap with another agent rejects the entire batch.

## Leases and Crashes

Sessions, task execution, claims, and handoffs use wall-clock expiries. A daemonless design cannot provide a shared persistent monotonic clock.

Graceful MCP shutdown closes the session but leaves its claims and execution lease visible until explicit release or expiry. This preserves pending handoffs across normal client shutdown. Expired in-progress work is not silently marked ready; another agent performs an explicit takeover, producing an audit event.

Leases cannot fence direct filesystem writes. They are coordination state for cooperative agents, not mandatory locks.

## Audit Model

SameTree is not fully event-sourced. Normalized tables hold current state, while `events` is an append-only transactional audit stream with:

- A globally increasing sequence cursor.
- Event and entity identifiers.
- Actor name and event kind.
- A bounded JSON payload.
- Millisecond timestamp.

Audit consumers poll after a sequence cursor. Resource subscriptions remain unnecessary because the audit stream is for context refresh and debugging; addressed messages use the separate durable follower and native harness adapters.

## Security Model

SameTree validates paths and SQL inputs, refuses symlinked state paths, never loads SQLite extensions, and stores its database with restrictive permissions where supported.

It is not a security boundary between processes sharing an operating-system account. Such processes can edit files directly, bypass Git hooks, inspect the local database, or impersonate another agent name. Use separate sandboxes or worktrees for mutually untrusted agents.
