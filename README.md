# SameTree

**Local coordination for coding agents that share a Git working tree.**

[![CI](https://github.com/simozampa/sametree/actions/workflows/ci.yml/badge.svg)](https://github.com/simozampa/sametree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](package.json)

SameTree gives already-running Claude Code, OpenCode, and other MCP-capable agents a shared task board, inbox, path-claim registry, handoff protocol, and versioned collaboration policy. It runs locally, works in an existing dirty working tree, and needs no daemon, Docker container, PostgreSQL server, cloud account, or per-agent branch.

> [!WARNING]
> SameTree is alpha software. Its claims are cooperative leases, not operating-system locks. Back up important work and read the [operating boundaries](#operating-boundaries) before using it.

## Why SameTree?

Parallel coding agents usually solve conflicts by isolating every worker in a branch or worktree. That is useful for independent tasks, but it gets in the way when two agents need to inspect the same uncommitted state, alternate edits, or review work before it is committed.

SameTree is deliberately for the other case:

- Two to ten agents run on one machine.
- Every agent sees the same working tree, including uncommitted changes.
- Agents need durable context across Claude Code and OpenCode sessions.
- Coordination should not require a server process or external database.
- Repository policy should be shared once and acknowledged by every agent.
- Checkable Git rules should be enforced mechanically, not left only in a prompt.

## Features

- **Cross-harness MCP server** with structured tools for Claude Code, OpenCode, and other MCP clients.
- **Deterministic JSON CLI** for humans, shell scripts, hooks, and agents without MCP.
- **Durable tasks** with dependencies, priorities, revision checks, assignments, expiring execution leases, and explicit stale-work takeover.
- **Atomic path claims** for exact files or recursive directories. A claim batch either succeeds completely or writes nothing.
- **Direct messages and broadcasts** with threads, task links, unread state, and acknowledgements.
- **Structured handoffs** that reject stale task revisions and can transfer selected path claims on acceptance.
- **Versioned policy and role files** under `.sametree/`, with content-hash acknowledgements.
- **Optional Git hooks** for conflicting staged paths, oversized diffs, Conventional Commits, and forbidden `Co-authored-by` trailers.
- **Transactional audit events** with a sequence cursor for polling and diagnostics.
- **Worktree-local SQLite WAL state** stored under Git's private directory instead of committed into the repository.

## Requirements

- Node.js 22.12 or newer
- Git
- A local filesystem with working file locks

SameTree does not support state databases on NFS, SMB, cloud-synced folders, or multiple machines.

## Install

Install from source:

```bash
git clone https://github.com/simozampa/sametree.git
cd sametree
npm ci
npm run build
npm link
```

`npm link` exposes `sametree` and `sametree-mcp` on your current Node.js toolchain. SameTree is not yet published to the npm registry.

## Quick Start

Initialize the repository where agents will collaborate:

```bash
cd /path/to/your/project
sametree init
sametree --agent human doctor
```

This creates only versioned coordination files:

```text
.sametree/
├── config.json
├── coordination.md
├── policy.md
└── roles/
    ├── implementer.md
    └── reviewer.md
```

Live state is created on first use inside Git's worktree-specific private directory. It is normally `.git/sametree/state.sqlite3` and is never committed.

### Configure Claude Code

From the target project, add SameTree as a local-scoped stdio MCP server:

```bash
claude mcp add --scope local --transport stdio sametree \
  --env SAMETREE_HARNESS=claude-code -- sametree-mcp
```

Reference the generated coordination guide from the project's `CLAUDE.md`:

```markdown
@.sametree/coordination.md
```

Start each Claude Code instance with a distinct name:

```bash
SAMETREE_AGENT=claude-1 claude
SAMETREE_AGENT=claude-reviewer SAMETREE_ROLE=reviewer claude
```

Claude Code passes its stable project directory to SameTree automatically.

### Configure OpenCode

Add this to the target project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sametree": {
      "type": "local",
      "command": ["sametree-mcp"],
      "environment": {
        "SAMETREE_HARNESS": "opencode"
      },
      "enabled": true
    }
  }
}
```

Tell OpenCode to read `.sametree/coordination.md` from the project's `AGENTS.md`, then launch each instance with a distinct name:

```bash
SAMETREE_AGENT=opencode-1 opencode
SAMETREE_AGENT=opencode-reviewer SAMETREE_ROLE=reviewer opencode
```

The name is inherited by the MCP process. Do not hard-code one shared name in the MCP configuration when running more than one instance.

## Coordination Loop

An agent should follow this loop at natural work boundaries:

1. Call `sametree_status` and `sametree_policy_get` at session start.
2. Acknowledge the current policy hash with `sametree_policy_ack`.
3. Read `sametree_inbox` and pending handoffs.
4. Claim a ready task, then atomically claim the smallest required paths.
5. Send messages when ownership or implementation decisions overlap.
6. Check the inbox before commits and after each task.
7. Update the task and release claims, or offer a structured handoff.

Example with the CLI:

```bash
export SAMETREE_AGENT=opencode-1
export SAMETREE_HARNESS=opencode

sametree status
sametree task create --title "Add request validation" --priority high
sametree task claim task_...
sametree claim acquire src/http/request.ts test/http/request.test.ts
sametree message send --to claude-reviewer \
  --subject "Validation ready" \
  --body "Please review task task_... at commit abc123" \
  --task task_...
sametree task update task_... --status done
sametree claim release --all
```

Successful command results and domain errors are JSON so agents and scripts can consume the interface reliably. Help and version output remain conventional command-line text.

CLI processes do not stay alive to heartbeat. The default task and path leases last 15 minutes. During longer CLI-only work, rerun `task claim <task-id>` and `claim acquire <paths...>` before expiry; use `claim acquire --ttl <seconds>` to request a path lease of up to 24 hours. MCP sessions renew their leases automatically.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `sametree_status` | Read the full coordination snapshot |
| `sametree_heartbeat` | Renew the current session and its leases |
| `sametree_task_create` | Create durable work and dependencies |
| `sametree_task_list` | List or filter tasks |
| `sametree_task_claim` | Claim ready work or take over an expired lease |
| `sametree_task_update` | Change assigned work with an optional revision check |
| `sametree_claim_acquire` | Atomically claim exact paths or directory trees |
| `sametree_claim_list` | Inspect active path claims |
| `sametree_claim_release` | Release selected or all owned claims |
| `sametree_message_send` | Send a direct message or broadcast |
| `sametree_inbox` | Poll direct and broadcast messages |
| `sametree_message_ack` | Mark a message read |
| `sametree_handoff_offer` | Offer task context and selected claims |
| `sametree_handoff_list` | Read incoming and outgoing handoffs |
| `sametree_handoff_respond` | Accept or reject a handoff |
| `sametree_policy_get` | Read the current policy and acknowledgement state |
| `sametree_policy_ack` | Acknowledge an exact policy hash |
| `sametree_events` | Poll the append-only audit stream |

The server also exposes `sametree://snapshot` and `sametree://policy/current` as read-only MCP resources.

## Git Safety Rails

Install optional hooks after reviewing them:

```bash
export SAMETREE_AGENT=human
sametree hooks install
```

Keep `SAMETREE_AGENT` set when committing from that shell. Agent-launched Git commands inherit the identity used to start their harness.

SameTree writes `pre-commit` and `commit-msg` only when those hook slots are empty or already managed by SameTree. Existing user hooks are reported and preserved, never overwritten.

The default policy checks:

- Staged paths must not overlap another agent's active claim.
- A staged diff must not exceed 400 changed lines.
- Commit subjects must follow Conventional Commits.
- Commit messages must not contain `Co-authored-by` trailers.

Configure these rules in `.sametree/config.json`. Hooks are safety rails, not a security boundary: Git permits `--no-verify`, and processes sharing an operating-system account can modify hooks.

## How It Works

Every MCP client starts its own short-lived SameTree process. CLI commands are short-lived processes too. They all open one SQLite database directly:

```text
Claude Code ─┐
Claude Code ─┼─ MCP stdio / CLI ─ Domain service ─ SQLite WAL
OpenCode ────┤                                  └─ Git working tree
OpenCode ────┘
```

SQLite `BEGIN IMMEDIATE` transactions serialize small mutations before conflict checks. Current state and its audit event commit together. WAL mode allows readers to continue while one process writes. No server needs to remain running.

Read [Architecture](docs/architecture.md) for storage and concurrency decisions, [Protocol](docs/protocol.md) for state transitions and invariants, and [Landscape](docs/landscape.md) for the alternatives reviewed before building SameTree.

## Operating Boundaries

- Claims coordinate cooperative agents; they cannot prevent a process from writing directly to a file.
- SameTree is for one local host and one working tree. It is not a distributed coordination service.
- Agents sharing an operating-system account are not mutually isolated or untrusted tenants.
- Same-file work must be serialized by message and claim transfer. SameTree does not merge simultaneous edits.
- Stdio MCP has no cross-process push channel here. Agents poll inboxes and events at natural boundaries.
- The database is operational state, not project history. Important decisions should also appear in commits, task descriptions, or durable documentation.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

The test suite covers domain state transitions, path traversal and symlink escapes, task and claim conflicts, policy hooks, two-process SQLite contention, and a real MCP stdio handshake.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

[MIT](LICENSE)
