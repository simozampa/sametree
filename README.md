# SameTree

**Run multiple Claude Code and OpenCode agents in the same repository and branch.**

[![CI](https://github.com/simozampa/sametree/actions/workflows/ci.yml/badge.svg)](https://github.com/simozampa/sametree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](package.json)

SameTree is a local multi-agent coordination MCP server for running multiple Claude Code, OpenCode, and other coding agents in parallel on the same repository, branch, and working tree. Agents share tasks, file claims, messages, handoffs, and repository policy without separate Git worktrees, a daemon, or a cloud service.

<p align="center">
  <img src="docs/demo.svg" alt="SameTree setup, task and path ownership, conflict prevention, and agent messaging" width="100%">
</p>

## What It Does

- Gives agents a shared task board and inbox.
- Delivers peer messages to active Claude Code and OpenCode sessions automatically.
- Prevents agents from unknowingly editing the same paths.
- Transfers work through structured handoffs.
- Shares coordination rules through versioned repository files.
- Stores all live state locally in the Git worktree.

## Requirements

- Node.js 22.12 or newer
- Git
- A local filesystem

SameTree does not support state databases on NFS, SMB, cloud-synced folders, or multiple machines.

## Install

```bash
git clone https://github.com/simozampa/sametree.git
cd sametree
npm ci
npm run build
npm link
```

SameTree is not yet published to npm. `npm link` exposes `sametree` and `sametree-mcp` from the source checkout.

## Quick Start

```bash
cd /path/to/your/project
sametree setup --claude --opencode
```

Setup is required once per project. It configures MCP, installs the SameTree Claude Code monitor plugin at user scope, creates the project OpenCode TUI inbox plugin, and writes shared instructions under `.sametree/`. Review these trusted local integrations before enabling them because they can inject peer messages into active agent sessions.

After setup, start agents normally in separate terminals:

```bash
opencode
```

```bash
claude
```

Every instance gets a unique identity automatically and joins the agents in that worktree. Peer messages wake the addressed Claude Code or OpenCode session without a user relay or an agent polling loop. Different projects and Git worktrees use separate state. Avoid switching branches while agents are active because every process in that worktree sees the same checkout.

Automatic OpenCode delivery requires a local TUI process. `opencode attach` can connect to a different server process with a different SameTree identity, so its adapter reports the limitation instead of consuming another identity's messages.

After upgrading SameTree, refresh Claude Code's cached plugin with `claude plugin update --scope user sametree@sametree`.

## Coordination Loop

The generated agent instructions tell each agent to:

1. Check current tasks, claims, and policy.
2. Claim a task and the smallest paths it needs.
3. Coordinate conflicts instead of overwriting another agent.
4. Update or hand off work and release claims when finished.

The Claude Code monitor and OpenCode plugin deliver new messages as they arrive. Delivery does not mark a message read; the receiving agent acknowledges it after handling the request.

Agents normally use the MCP tools directly. The CLI provides the same coordination surface for humans and scripts:

```bash
export SAMETREE_AGENT=opencode-1
export SAMETREE_HARNESS=opencode

sametree status
sametree task create --title "Add request validation" --priority high
sametree task claim task_...
sametree claim acquire src/http/request.ts test/http/request.test.ts
sametree task update task_... --status done
sametree claim release --all
sametree message follow --json
SAMETREE_AGENT=observer sametree watch --tail
```

An explicit `SAMETREE_AGENT` must remain unique to one harness process. Do not launch independent processes with the same override; the MCP and inbox follower inside one process share the identity automatically.

Optional Git hooks can reject commits that overlap active claims or violate repository policy:

```bash
export SAMETREE_AGENT=human
sametree hooks install
```

## How It Works

Each MCP client starts a local SameTree process. All clients in one worktree open the same SQLite database under Git's private worktree directory:

```text
Claude Code ─┐
Claude Code ─┼─ MCP stdio / native inbox adapters ─ Domain service ─ SQLite WAL
OpenCode ────┤                                                   └─ Git working tree
OpenCode ────┘
```

There is no server to run. State stays local and is never committed.

SameTree is designed for trusted agents on one machine. It coordinates edits but does not merge simultaneous changes or sandbox processes.

## FAQ

### Can multiple Claude Code and OpenCode agents safely work in the same repository?

SameTree reduces collisions between Claude Code and OpenCode instances sharing one checkout. Each agent gets its own identity, sees the same task board, and claims files before editing them.

### Do parallel coding agents need separate branches or Git worktrees?

Not when the work is intertwined. SameTree is built for agents collaborating on the same branch and live working tree. Independent tasks can still use separate Git worktrees, which SameTree keeps isolated.

### How do coding agents share context across sessions?

SameTree stores tasks, messages, delivery state, handoffs, claims, and policy acknowledgements in a worktree-local SQLite database. Claude Code and OpenCode access shared state through MCP tools, while native adapters push addressed messages into active sessions.

### Is SameTree a Conductor alternative?

[Conductor](https://conductor.build/) gives each task an isolated workspace, branch, files, and merge path. SameTree coordinates agents inside one live working tree. Use Conductor-style isolation for independent tasks and SameTree for coupled work that must share uncommitted state.

### How is SameTree different from agent-talk?

[agent-talk](https://github.com/xhluca/agent-talk) provides encrypted agent-to-agent messaging across people and machines through a relay. SameTree stays on one machine and adds tasks, file claims, handoffs, policy, and Git checks for agents sharing a working tree.

### Does SameTree work across multiple machines?

No. SameTree is intentionally local to one machine and one Git worktree. Use a networked coordination or messaging tool when agents need to communicate across machines.

## Documentation

- [Architecture](docs/architecture.md): storage and concurrency decisions
- [Protocol](docs/protocol.md): tools, state transitions, and invariants
- [Four-agent review loop](examples/review-loop/): worker and reviewer example
- [Contributing](CONTRIBUTING.md): development and demo generation
- [Security](SECURITY.md): vulnerability reporting

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE)
