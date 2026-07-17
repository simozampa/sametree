# SameTree

**Local coordination for coding agents that share a Git working tree.**

[![CI](https://github.com/simozampa/sametree/actions/workflows/ci.yml/badge.svg)](https://github.com/simozampa/sametree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](package.json)

SameTree lets Claude Code, OpenCode, and other MCP agents coordinate inside one Git working tree. Agents share tasks, path claims, messages, handoffs, and repository policy without a daemon or cloud service.

<p align="center">
  <img src="docs/demo.svg" alt="SameTree setup, task and path ownership, conflict prevention, and agent messaging" width="100%">
</p>

## What It Does

- Gives agents a shared task board and inbox.
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

Setup is required once per project. It configures the requested harnesses and writes shared instructions under `.sametree/`. After that, start agents normally in separate terminals:

```bash
opencode
```

```bash
claude
```

Every instance gets a unique identity automatically and joins the agents in that worktree. Different projects and Git worktrees use separate state. Avoid switching branches while agents are active because every process in that worktree sees the same checkout.

## Coordination Loop

The generated agent instructions tell each agent to:

1. Check current tasks, claims, messages, and policy.
2. Claim a task and the smallest paths it needs.
3. Coordinate conflicts instead of overwriting another agent.
4. Update or hand off work and release claims when finished.

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
SAMETREE_AGENT=observer sametree watch --tail
```

Optional Git hooks can reject commits that overlap active claims or violate repository policy:

```bash
export SAMETREE_AGENT=human
sametree hooks install
```

## How It Works

Each MCP client starts a local SameTree process. All clients in one worktree open the same SQLite database under Git's private worktree directory:

```text
Claude Code ─┐
Claude Code ─┼─ MCP stdio / CLI ─ Domain service ─ SQLite WAL
OpenCode ────┤                                  └─ Git working tree
OpenCode ────┘
```

There is no server to run. State stays local and is never committed.

SameTree is designed for trusted agents on one machine. It coordinates edits but does not merge simultaneous changes or sandbox processes.

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
