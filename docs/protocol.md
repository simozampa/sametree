# Coordination Protocol

This document defines the behavior shared by the CLI and MCP adapters.

## Identity and Sessions

An agent name is a stable human-readable identity such as `claude-reviewer` or `opencode-1`. Names are unique within one working tree and contain letters, numbers, `.`, `_`, or `-`.

A session represents one process lifetime. Starting a CLI command or MCP server creates a new session for its agent. An MCP heartbeat renews:

- The session expiry.
- Active path claims owned by that session.
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

Task invariants:

- A task cannot be claimed until every dependency is `done`.
- A ready task with an assignee can be claimed only by that assignee.
- An active execution lease owned by another agent prevents a claim.
- An expired execution lease may be taken over explicitly.
- `done`, `cancelled`, and `blocked` tasks cannot be claimed.
- Task updates require ownership established by a prior claim or initial assignment.
- Every transition into `in_progress` rechecks dependencies.
- Every mutation increments `revision`.
- Callers may submit `expectedRevision` to reject stale updates.

Assignments are durable agent ownership. Execution leases identify the active session. Keeping these separate makes crashed work visible instead of silently re-queuing it.

## Path Claims

A claim has one of two kinds:

- `exact`: one repository-relative path, such as `src/api.ts`.
- `tree`: a path and every descendant, such as `src/auth`.

Two claims overlap when:

- Both are exact and their normalized paths are equal.
- A tree path is equal to or an ancestor of the other path.
- The repository root tree `.` contains every path.

Agents may hold overlapping claims with themselves. Any overlap with another agent rejects acquisition. A request containing multiple paths commits all claims or none.

Claims expire unless renewed and should be released immediately when work ends. They are advisory and do not modify filesystem permissions.

## Messages

A message is immutable and contains:

- Sender and optional recipient.
- Subject and body.
- Thread ID.
- Optional task ID.
- Creation time.

Omitting the recipient broadcasts to every other registered agent. Read receipts are per agent, so one recipient acknowledging a broadcast does not hide it from others.

Polling is the delivery mechanism. Agents should read their inbox at session start, after finishing a task, and before commits or unrelated work.

## Handoffs

A handoff is an offer/accept protocol rather than an immediate reassignment.

An offer captures:

- Current task and task revision.
- Source and destination agents.
- Human-readable summary.
- Structured JSON context.
- Optional path-claim IDs to transfer.
- Expiry.

Acceptance is one transaction. It verifies that the offer is active and that the task revision still matches, then transfers assignment, starts a destination execution lease, and transfers every still-valid selected claim. A selected claim cannot overlap a source claim left behind because that would create conflicting ownership after transfer. If the task or claims changed after the offer, acceptance fails with `HANDOFF_CONFLICT` and the agents must create a fresh offer.

Rejection records a terminal handoff state without changing task ownership.

## Policy

The shared policy is the tracked `.sametree/policy.md` file. SameTree computes its SHA-256 hash and records acknowledgements by agent and hash.

Editing any byte produces a new hash, so previous acknowledgements no longer satisfy the current policy. Clients should read and acknowledge the policy at session start.

Prompt policy is backed by optional Git hooks for rules that can be checked mechanically. Hooks remain bypassable safety rails.

## Events

Every meaningful mutation appends an event in the same transaction as current state. Consumers call `sametree_events` with the last seen sequence and persist the returned maximum as their next cursor.

Event polling is intended for context refresh and debugging. Current-state tools remain authoritative for decisions.

## Error Codes

Expected failures return stable machine-readable codes:

| Code | Meaning |
| --- | --- |
| `AGENT_REQUIRED` | No agent identity was provided |
| `CLAIM_CONFLICT` | Another agent owns an overlapping active claim |
| `HANDOFF_CONFLICT` | A handoff expired, resolved, or references stale work |
| `HOOK_REFUSED` | A configured Git policy check failed |
| `INVALID_INPUT` | Input or repository configuration is invalid |
| `NOT_ASSIGNED` | The actor does not own the requested entity |
| `NOT_FOUND` | A referenced agent, task, message, or handoff is absent |
| `NOT_GIT_REPOSITORY` | The working directory is not a non-bare Git tree |
| `POLICY_NOT_FOUND` | `.sametree/policy.md` is missing |
| `TASK_BLOCKED` | Task dependencies are unfinished |
| `TASK_UNAVAILABLE` | Task state, owner, lease, or revision prevents mutation |

MCP returns these as tool errors with the full structured object. The CLI writes the same object to stderr and exits non-zero.
