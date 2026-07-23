# Architecture

SameTree is a local-first coordination layer for a small number of cooperative coding agents sharing one physical working tree or an explicit workspace of local repository worktrees.

## Design Goals

- Work in an existing, possibly dirty working tree.
- Share coordination across repositories and linked worktrees without moving or copying files.
- Let independently launched Claude Code and OpenCode processes coordinate.
- Require no daemon, container, network port, or external database.
- Preserve task, shared-instruction, proposed-plan, message, claim, policy, and handoff state across agent restarts.
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

Each MCP client owns one server child process and one SameTree session. Every session has a home member and records the branch on which it started. A heartbeat every 20 seconds renews the session, tasks, and claims held by that process, including claims targeting other workspace members. CLI commands open their own sessions and leave acquired leases alive until explicit release or expiry; a later CLI process cannot renew an earlier process's session. Built-in CLI, streaming, and MCP sessions retain durable session rows but omit lifecycle audit events to keep the event stream focused on coordination.

The CLI and MCP server call the same `Coordinator` domain service. Neither adapter contains coordination rules.

Each harness also owns a message follower with the same generated workspace-global agent identity as its MCP child. The follower reserves one eligible message at a time. Claude Code treats each monitor line as accepted delivery. OpenCode writes the message ID back only after `promptAsync` accepts the injected prompt. Delivery records deduplicate adapter restarts without changing inbox read receipts.

Harness adapters publish proposed plans through the CLI at a stable boundary before implementation approval. Claude Code supplies the plan body directly to an `ExitPlanMode` hook. OpenCode's project plugin reads the finalized Plan file when `plan_exit` begins; it does not infer finality from ordinary Plan responses because those may only ask for clarification or report progress. Database uniqueness uses harness plus native session rather than process identity, so resuming one harness session cannot create a second plan merely because its process-derived agent name changed.

Harness adapters also observe native user-message boundaries for explicit shared instructions. Claude Code uses `UserPromptSubmit`; OpenCode uses `chat.message` only for root sessions and rejects SameTree-injected parts. Both require the prompt to begin at byte zero with the exact, case-sensitive `For all agents:` prefix and preserve the complete text. Ordinary prompts never reach the Coordinator. Capture is fail-open, so unavailable SameTree state cannot prevent a harness from accepting a user prompt.

## Workspace And Routing Model

Standalone mode remains zero-configuration. SameTree asks Git for the absolute private worktree directory and stores state at:

```bash
<private-git-directory>/sametree/state.sqlite3
```

The schema still represents this as an implicit workspace with one repository and one member. Linked worktrees are independent in standalone mode because each has a different private Git directory.

Explicit workspace registrations live at `$XDG_DATA_HOME/sametree/workspaces`, falling back to `~/.local/share/sametree/workspaces`. Each workspace contains:

```text
<registry>/<workspace-id>/workspace.json
<registry>/<workspace-id>/state.sqlite3
```

Joining writes two untracked bindings:

```text
<common-git-directory>/sametree/repository.json
<private-git-directory>/sametree/worktree.json
```

The common binding prevents linked worktrees from splitting one Git repository across explicit workspaces. The private binding identifies one member and routes only that physical worktree to the shared database. Unbound siblings remain standalone. All processes must resolve the binding through the same registry root, selected by `SAMETREE_WORKSPACE_REGISTRY` or the XDG default.

Workspace-global state includes agents, tasks, dependencies, shared instructions and immutable revisions, plans and immutable plan revisions, messages, handoffs, audit sequence, and session rows. Sessions have one home member; tasks may tag zero or more affected members; instructions may optionally reference a task without modifying it; claims target exactly one member; policy files and acknowledgements are member-scoped.

Versioned policy and role documents remain under the tracked `.sametree/` directory. Operational state and collaboration policy therefore have separate lifecycles.

## Workspace Transitions

Creating and joining a workspace requires an explicit state decision. Fresh mode ignores the standalone database. Import mode copies its normalized rows into the shared database, preserves entity IDs, remaps member context, assigns new workspace-global event sequences, and records source sequences. Any identity collision aborts the whole import. The source database remains in place but is not synchronized after joining.

Private-worktree and common-repository SQLite operation locks serialize session startup with create, add, leave, prune, and relink for each affected member. Shared database changes use `BEGIN IMMEDIATE`; binding writes are identity-checked and ordered so interrupted cleanup can be retried. Leave and prune retire members without deleting historical rows. Relink requires the original private and common Git identity, so it recovers moved worktrees but cannot substitute a clone.

## Why SQLite Instead of JSONL?

Append-only JSONL is inspectable, but compound operations still need cross-process locking. Examples include recording one idempotent shared-instruction revision with per-agent notices and acknowledgements, publishing one idempotent plan revision and all live-peer notifications, claiming a task only if its dependencies are complete, acquiring paths across several members all-or-nothing, accepting a handoff only if its task revision is unchanged, importing a standalone database, or atomically moving live task and path ownership after a user-authorized takeover.

SQLite provides:

- Cross-process transactions and crash recovery.
- One canonical current-state model without replay at startup.
- Atomic current-state and audit-event writes.
- Foreign keys, strict tables, checks, and prepared statements.
- A single embedded file with no service lifecycle.

JSON remains at the boundaries and inside bounded event/context payloads, not as the writable source of truth. Handoff context is limited to 100,000 serialized UTF-8 bytes.

## Connection Settings

Every persistent database connection configures:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;
PRAGMA trusted_schema = OFF;
PRAGMA cell_size_check = ON;
PRAGMA wal_autocheckpoint = 1000;
```

An explicit `:memory:` database keeps SQLite's in-memory journal mode while applying the remaining safety settings.

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

Input normalization and broad filesystem inspection happen before a transaction. Member availability is rechecked in the write transaction, and lifecycle Git-identity checks are repeated while holding the affected member's operation locks. Claim path normalization happens before its transaction and availability is rechecked inside it. SameTree performs no network operations.

Status observes full porcelain-v2 branch, commit, and dirty state for the caller's current member. It also refreshes each available member's cheap HEAD descriptor. A branch transition records `worktree.branch_changed`; active sessions started on a different branch produce `BRANCH_CHANGED`. Ordinary commits on one branch and detached-HEAD commits do not create false branch-switch events. Branch changes do not cancel leases.

## Path Safety

Claims accept exact files and recursive directory trees, not arbitrary globs. Predictable overlap is more important than compact syntax.

Before a claim reaches SQLite, SameTree resolves the target member and:

- Rejects empty paths, NULs, absolute escapes, and `..` traversal.
- Resolves the deepest existing ancestor to catch a future path below an escaping symlink.
- Stores repository-relative POSIX paths.
- Normalizes Unicode to NFC.
- Uses that member repository's `core.ignorecase` setting for the comparison key.
- Compares tree prefixes only at path-component boundaries.

Batch acquisition across members is atomic. An overlap with another agent in the same physical member rejects the entire batch. Matching paths in linked worktrees of one repository are allowed with `LINKED_WORKTREE_OVERLAP`, because they may conflict later during branch integration. Matching paths in unrelated repositories neither conflict nor warn.

## Leases and Crashes

Sessions, task execution, claims, and handoffs use wall-clock expiries. A daemonless design cannot provide a shared persistent monotonic clock. Retiring a member closes sessions whose home is that member; closed sessions cannot acquire, renew, accept, or update work. Claims targeting an unavailable member are not renewed or transferable.

Graceful MCP shutdown closes the session but leaves its claims and execution lease visible until explicit release or expiry. This preserves pending handoffs across normal client shutdown. Expired in-progress work is not silently marked ready or exposed as peer-claimable work. Its assignment remains durable until the owner resumes it or the user explicitly reassigns it.

Normal claims never change task assignment. A separate forced-takeover operation exists for a direct user reassignment, whether the prior execution lease is live or expired: it requires the current task revision, an audit reason, explicit user authorization, and selected claim IDs. The task and claims move in one immediate transaction, or none move. This is a cooperative recovery mechanism rather than an authorization boundary.

Leases cannot fence direct filesystem writes. They are coordination state for cooperative agents, not mandatory locks.

## Audit Model

SameTree is not fully event-sourced. Normalized tables hold current state, while `events` is an append-only transactional audit stream with:

- A globally increasing sequence cursor.
- Event and entity identifiers.
- Actor name and event kind.
- A bounded JSON payload.
- Millisecond timestamp.

Audit consumers poll after a sequence cursor. Resource subscriptions remain unnecessary because the audit stream is for context refresh and debugging; addressed messages use the separate durable follower and native harness adapters.

Events in an explicit workspace use one global sequence and carry member/worktree origin where applicable. Imported events receive new sequences while retaining source workspace and sequence metadata internally.

Built-in adapters keep process history in the session table without adding start and close events. This keeps the audit stream focused on tasks, shared instructions, plans, claims, messages, handoffs, and policy changes while preserving session diagnostics.

## Security Model

SameTree validates paths and SQL inputs, refuses symlinked registry and state paths, never loads SQLite extensions, and stores databases and bindings with restrictive permissions where supported. Registry databases must remain on a local filesystem, and every member must be locally accessible on one machine. The exact shared-instruction prefix and `userAuthorized` fields are auditable cooperative assertions, not authentication.

It is not a security boundary between processes sharing an operating-system account. Such processes can edit files directly, bypass Git hooks, inspect the local database, or impersonate another agent name. Use separate sandboxes or worktrees for mutually untrusted agents.
