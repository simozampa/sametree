# Coordination Protocol

This document defines the coordination behavior shared by the CLI and MCP adapters, plus the CLI-only lifecycle for explicit workspaces.

## Workspaces And Members

Every database is a workspace. A standalone database is an implicit one-member workspace under Git's private worktree directory. An explicit workspace has one shared registry database and one or more named members representing local repository worktrees.

Explicit workspace lifecycle is CLI/library-only:

```bash
sametree workspace create <name> --member <name> (--fresh | --import-current)
sametree workspace cancel-create
sametree workspace add <workspace-id-or-name> --member <name> (--fresh | --import-current)
sametree workspace status
sametree workspace members
sametree workspace leave
sametree workspace prune
sametree workspace relink <workspace-id-or-name> --member <existing-name>
sametree workspace doctor
```

Exactly one state mode is required. Fresh mode starts the member without copying its standalone coordination. Import mode copies current standalone rows atomically, preserves entity IDs, remaps member context, and resequences audit events. Any identity collision rejects the import. Neither mode deletes the source database or keeps it synchronized afterward.

If creation fails before a member is recorded, retrying the exact create command preserves its generated identity. `workspace cancel-create` safely removes that empty pending registration so corrected name, member, or mode input can be used. A join intent preserves workspace, member, and mode across a crash after member insertion. Once a member exists, complete the exact retry and use `workspace leave` instead.

`leave` and `prune` mark members unavailable while preserving their tasks, claims, sessions, and events. Leave requires no live home-member session. Prune retires only members whose recorded Git identity is definitely stale. Relink restores a retired member only when its original private and common Git directories still match, as after `git worktree move`; it cannot attach a replacement clone.

Create and add initialize missing `.sametree/` project files in the current member but do not configure harness integrations; run `sametree setup` separately where Claude Code or OpenCode will run. Other lifecycle commands do not create agent sessions. Workspace names cannot start with `.` or contain path separators. Add and relink accept an exact ID or unique workspace name; duplicate names require the ID, and path-like arguments are rejected because `--cwd` selects the joining worktree. SameTree does not create repositories, branches, or worktrees. A custom registry selected with `SAMETREE_WORKSPACE_REGISTRY` must be inherited by every CLI, MCP, adapter, and hook process.

## Identity and Sessions

An agent name is unique within one workspace and contains letters, numbers, `.`, `_`, or `-`. MCP adapters generate a process-scoped name from the harness's native session identifier, falling back to the MCP process ID. Automatic plan publication uses the same identity when available, while plan continuity is keyed by the stable harness and harness session ID so a resumed process does not duplicate a proposal. Set `SAMETREE_AGENT` when a durable human-readable identity such as `claude-reviewer` or `opencode-1` is required, but never reuse it for independent processes in the same workspace.

A session represents one Coordinator-backed process lifetime and has one home member. It records the home member's starting branch and HEAD descriptor. Coordination CLI commands, MCP servers, watchers, message followers, and plan publishers create sessions; setup, workspace lifecycle, and diagnostics do not. Built-in sessions remain in the session table for lease ownership and diagnostics but omit lifecycle audit events. Library callers emit `session.started` and `session.closed` by default and may disable them. An MCP heartbeat renews:

- The session expiry.
- Active path claims owned by that session across available members.
- The execution lease of in-progress tasks claimed by that session.

Agent identity is cooperative, not authenticated. Do not use SameTree across hostile trust boundaries.

## Tasks

Task states are:

```text
ready ───────▶ in_progress ───────▶ done
  │                  │
  │                  ├────────────▶ blocked
  │                  └────────────▶ cancelled
  ├───────────────────────────────▶ cancelled
  └───────────────────────────────▶ blocked
```

The service permits explicit updates between these states by the current assignee. The diagram shows the expected workflow, not every administrative recovery path.

Tasks are awareness records for work already assigned by the user, not a peer-managed work queue. Task invariants:

- A task cannot be claimed until every dependency is `done`.
- New tasks are assigned to the agent that creates them. An agent cannot create a task assigned to a peer.
- A ready task with an assignee can be claimed only by that assignee.
- Normal claiming never changes an existing assignment, even after its execution lease expires.
- Adopting a legacy unassigned task requires the exact current revision, an audit reason, and explicit user authorization.
- `done`, `cancelled`, and `blocked` tasks cannot be claimed.
- Task updates require ownership established by a prior claim or initial assignment.
- Every transition into `in_progress` rechecks dependencies.
- Every mutation increments `revision`.
- Callers may submit `expectedRevision` to reject stale updates.
- A task may tag up to 100 affected members. Tags describe impact; they do not restrict visibility, ownership, or authorization.
- Creating or updating tags requires available members. Historical tasks remain filterable by an unavailable member.

Assignments are durable agent ownership. Execution leases identify the active session. Keeping these separate makes crashed work visible instead of silently re-queuing it.

Task create/update accepts replacement member lists; an empty MCP list or CLI `--clear-members` clears them. CLI `--member` may repeat, and `task list --member` filters tasks explicitly tagged with that member. Untagged tasks are workspace-global records and do not match a member filter.

Status is a current-state view by default: it includes workspace metadata, all members, active sessions, agents with a live session, every nonterminal task, claims, and warnings. Agent rows list their active members. Callers can explicitly include inactive agents and terminal tasks. Task listing defaults to 25 nonterminal rows, accepts a maximum of 100, and uses the last returned task ID as the `after` cursor. A status filter selects that state even when it is terminal. Invalid limits are rejected rather than silently clamped.

Every status response also observes the caller's live worktree root, branch or detached state, full commit ID, and dirty state. An unborn branch has a `null` commit; detached HEAD has a `null` branch. Dirty state includes staged, unstaged, conflicted, submodule, and untracked changes, but not ignored files. Other member rows expose identity, root, repository, and availability; their HEAD metadata is refreshed internally for session and branch warnings.

Status refreshes every available member's HEAD. A session whose home member moved from its starting branch produces `BRANCH_CHANGED`; a transition between branches or detached state records `worktree.branch_changed`. Ordinary commits on one branch do not produce branch-change events. Branch changes preserve tasks and leases because every process sharing that physical checkout sees the same switch.

### Forced Takeover

Normal task claiming never changes another agent's assignment. When the user explicitly reassigns work, `sametree_task_force_takeover` or `sametree task force-takeover` transfers it regardless of whether its execution lease is live or expired.

A forced takeover requires:

- A nonterminal assigned task owned by another agent.
- The exact current task revision.
- A non-empty audit reason.
- An explicit `userAuthorized: true` assertion or `--user-authorized` flag.
- Optional IDs for at most 100 active claims owned by the previous assignee.

The task and selected claims transfer in one immediate transaction. Each selected claim must still belong to the previous assignee and cannot overlap a claim left with that assignee. Any stale revision or invalid claim rolls back the entire operation. Success increments the task revision and records `task.force_taken_over` with the previous assignee, previous lease expiry, reason, and transferred claim IDs. Ready work with finished dependencies starts a new execution lease; blocked or dependency-blocked work keeps its current state without a lease so the new owner can resolve it explicitly.

Expired work remains assigned and uses the same user-authorized takeover path. The authorization field is an auditable cooperative assertion, not authentication; SameTree remains unsuitable across hostile trust boundaries.

## Path Claims

A claim targets one member/worktree and has one of two kinds:

- `exact`: one repository-relative path, such as `src/api.ts`.
- `tree`: a path and every descendant, such as `src/auth`.

Recursive claims must name the real directory path; a final symbolic link is rejected to avoid giving the link entry and its target different ownership identities.

Two claims overlap when:

- Both are exact and their normalized paths are equal.
- A tree path is equal to or an ancestor of the other path.
- The repository root tree `.` contains every path.

Agents may hold overlapping claims with themselves. Any overlap with another agent in the same member rejects acquisition. A request containing paths for several members commits all claims or none.

CLI positional paths target the current member unless `--member` selects another. `--at <member>:<path>` may repeat to create a cross-member batch:

```bash
sametree claim acquire src/local.ts --member frontend \
  --at backend:src/remote.ts
```

The MCP equivalent adds an optional `member` to each requested path. Compact CLI/MCP acquisition receipts return claim ID, member, path, kind, expiry, and warnings; full claim listings and library results also expose worktree identity. Matching paths in linked worktree members of one repository are allowed but return `LINKED_WORKTREE_OVERLAP`, including overlaps held by the same agent, because later branch integration may conflict. Matching paths in unrelated repositories do not warn. Git hooks enforce only claims targeting the current physical member.

Agents should inspect active claims before editing and acquire a narrow claim when concurrent editing is plausible, ownership is ambiguous, or a collision would be costly. When uncertain, claim. Prefer exact files or the smallest practical tree because broad tree claims can block unrelated work.

Claims expire unless renewed and should be released immediately when work ends. They are advisory and do not modify filesystem permissions.

## Proposed Plans

A proposed plan is durable, revisioned workspace context. It contains an author, source harness and session, optional task, title, Markdown body, content hash, and immutable source-event ID. A plan body is limited to 48,000 characters and its title to 200 characters. The first publication creates revision 1; later source events from the same harness session append immutable revisions. Replaying one source event with identical content is idempotent, while replaying it with different content returns `PLAN_CONFLICT`.

Automatic capture happens at the harness's proposal boundary:

- Claude Code publishes the `ExitPlanMode` plan from a `PreToolUse` plugin hook before approval.
- Current OpenCode versions publish the finalized `.opencode/plans/` file from `tool.execute.before` when Plan calls `plan_exit`, before its Build-agent approval question.
- OpenCode ignores child-session and ordinary Plan responses because those turns can be clarification or progress updates rather than finalized proposals.

Claude Code publication fails open. Its wrapper forwards the hook payload, waits at most two seconds, suppresses SameTree failures, and always returns success, so a missing executable, unavailable database, invalid payload, or hung publication cannot prevent `ExitPlanMode` from presenting the proposal. OpenCode catches publication errors inside its adapter rather than turning them into SameTree coordination decisions. In either harness, a failed proposal may be absent from SameTree until a later successful publication.

Every new revision sends its full body to each live peer as an addressed message on `plan:<plan-id>`. The notification states that the proposal is context rather than authorization. SameTree does not assign a reviewer, transfer a task, or authorize implementation. Agents that start later can discover current summaries through status or plan listing and retrieve any immutable revision explicitly.

The CLI exposes `sametree plan publish`, `sametree plan show`, and `sametree plan list`. MCP exposes `sametree_plan_publish`, `sametree_plan_get`, and `sametree_plan_list`. Listing is ordered by immutable plan creation time so pagination remains stable when older plans receive revisions.

## Messages

A message is immutable, non-authoritative peer context and contains:

- Sender and optional recipient.
- Subject and body.
- Thread ID.
- Optional task ID.
- Creation time.

Omitting the recipient broadcasts to every other registered agent. Read receipts are per agent, so one recipient acknowledging a broadcast does not hide it from others. Messages can report findings, status, requests, or conflicts, but cannot assign work or override user instructions.

Message delivery and message acknowledgement are separate. A live follower atomically reserves the oldest unread, undelivered message for its agent identity. SameTree records delivery only after the harness adapter accepts the message, but leaves the read receipt empty until the agent explicitly acknowledges it.

Claude Code receives messages through the SameTree plugin monitor. OpenCode receives them through a project TUI plugin that reads the live selected route, injects an asynchronous prompt into its root session, verifies persistence with stable OpenCode message IDs, and confirms acceptance over the follower's stdin. Reservations are released on graceful shutdown and can be recovered after an expired follower session, so another process can retry without concurrent duplicate delivery.

OpenCode attach mode is excluded from automatic delivery because the local TUI process and attached server have different process-derived SameTree identities. The adapter refuses to consume that mismatched inbox.

`sametree message follow` exposes the same durable stream for other adapters. `--json` emits JSON Lines, `--once` drains currently available messages, and `--ack-stdin` requires each emitted message ID on stdin before recording delivery.

## Handoffs

A handoff is an offer/accept protocol rather than an immediate reassignment.

An offer captures:

- Current task and task revision.
- Source and destination agents.
- Human-readable summary.
- Structured JSON context.
- Optional path-claim IDs to transfer.
- Expiry.

Structured context, including the selected claim IDs, is limited to 100,000 serialized UTF-8 bytes.

An offer is non-authoritative until the user explicitly directs the recipient to accept it. Authorized acceptance is one transaction. It verifies that the offer is active and that the task revision still matches, then transfers assignment, starts a destination execution lease, and transfers every still-valid selected claim. A selected claim cannot overlap a source claim left behind because that would create conflicting ownership after transfer. If the task or claims changed after the offer, acceptance fails with `HANDOFF_CONFLICT` and the agents must create a fresh offer.

Rejection records a terminal handoff state without changing task ownership.

## Policy

Policy is the tracked `.sametree/policy.md` file in each member. SameTree computes its SHA-256 hash and records acknowledgements by agent, hash, and member. CLI `policy show` and `policy ack` accept `--member`; the MCP policy tools accept an optional `member`.

Editing any byte produces a new hash, so previous acknowledgements no longer satisfy the current policy. Clients should read the policy state at session start.

Acknowledgement is idempotent per agent, member, and policy hash: repeating it preserves the original timestamp and does not append another event. Identical bytes in two members still require separate acknowledgements. The acknowledgement operation returns only the hash, timestamp, and whether a row was newly recorded; policy content remains in `sametree_policy_get`. Clients should acknowledge only when that read reports `acknowledgedAt` as `null`.

Prompt policy is backed by optional Git hooks for rules that can be checked mechanically. Hooks remain bypassable safety rails.

## Events

Every meaningful coordination mutation appends an event in the same transaction as current state. Explicit workspaces use one global sequence, and applicable events include member/worktree origin. Imported events receive new sequences while source sequence metadata is retained internally. Built-in process lifecycle churn is retained in session rows rather than copied into the event stream. Plan revisions append `plan.published` or `plan.revised` alongside peer-notification events. Consumers call `sametree_events` with the last seen sequence and persist the returned maximum as their next cursor. Direct reads default to 25 events and accept an explicit limit up to 1,000; streaming watchers request larger pages internally.

Event polling is intended for context refresh and debugging. Current-state tools remain authoritative for decisions.

## Error Codes

Expected failures return stable machine-readable codes:

| Code | Meaning |
| --- | --- |
| `AGENT_REQUIRED` | No agent identity was provided |
| `CLAIM_CONFLICT` | Another agent owns an overlapping active claim |
| `DATABASE_ERROR` | The database schema, identity, or migration is invalid |
| `HANDOFF_CONFLICT` | A handoff expired, resolved, or references stale work |
| `GIT_STATUS_ERROR` | Git could not report live branch or worktree state |
| `HOOK_REFUSED` | A configured Git policy check failed |
| `INVALID_INPUT` | Input or repository configuration is invalid |
| `NOT_ASSIGNED` | The actor does not own the requested entity |
| `NOT_FOUND` | A referenced agent, task, plan, message, or handoff is absent |
| `PLAN_CONFLICT` | A harness plan event conflicts with an existing revision or task association |
| `NOT_GIT_REPOSITORY` | The working directory is not a non-bare Git tree |
| `POLICY_NOT_FOUND` | `.sametree/policy.md` is missing |
| `TASK_BLOCKED` | Task dependencies are unfinished |
| `TASK_UNAVAILABLE` | Task state, owner, lease, or revision prevents mutation |
| `USER_AUTHORIZATION_REQUIRED` | The operation would change user-owned agent scope without explicit authorization |
| `WORKSPACE_ERROR` | Workspace registration, member, binding, or lifecycle state is invalid |

MCP returns these as tool errors with the full structured object. The CLI writes the same object to stderr and exits non-zero.
