# SameTree

**Coordinate Claude Code and OpenCode agents in one working tree or across a local workspace.**

[![CI](https://github.com/simozampa/sametree/actions/workflows/ci.yml/badge.svg)](https://github.com/simozampa/sametree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](package.json)

SameTree gives coding agents shared tasks, path claims, messages, handoffs, and policy. It runs locally through MCP, with no daemon, cloud service, or external database service.

<p align="center">
  <img src="docs/demo.svg" alt="SameTree setup, task and path ownership, conflict prevention, and agent messaging" width="100%">
</p>

## Why SameTree

- Keep user-assigned work and agent activity visible in one place.
- Surface conflicting path claims before cooperative agents edit the same files.
- Deliver peer messages directly to active Claude Code and OpenCode sessions.
- Coordinate several repositories or linked worktrees when one checkout is not enough.
- Keep operational state local and outside tracked files.

## Install

Requires Node.js 22.12 or newer, Git, and a local filesystem.

```bash
npm install --global sametree
```

This installs the `sametree` CLI and `sametree-mcp` server.

> SameTree is pre-1.0 alpha software. Back up important coordination state before upgrades. When upgrading from 0.1.x, stop active agents and read the [upgrade guide](docs/upgrading.md) before opening existing state with 0.2.0.

## Quick Start

Run setup in every working tree that will launch a harness. Setup installs or updates a user-scoped Claude Code plugin and a project-scoped OpenCode integration that can inject peer messages into active sessions.

```bash
cd /path/to/your/project
sametree setup --claude --opencode
git status --short
git diff
```

Review the setup result, the contents of newly created files shown by Git status, and tracked-file diffs before launching agents. Omit `--claude` or `--opencode` when unused. If every agent shares this working tree, skip the optional workspace section.

## Optional Workspaces

Repositories and linked worktrees are isolated by default. To share coordination across them, create a workspace from one member and add the others by workspace name or ID:

```bash
cd /path/to/frontend
sametree workspace create Product --member frontend --fresh

cd /path/to/backend
sametree workspace add Product --member backend --fresh

sametree workspace status
sametree workspace doctor
```

Use `--fresh` to start without copying standalone coordination state. Use `--import-current` when existing tasks, messages, and history should move into the shared workspace. Both modes preserve the source database as an independent snapshot.

Run `sametree setup` in every workspace member that launches a harness. All members must remain on one machine and use the same local workspace registry. See [Upgrading](docs/upgrading.md) for migration, custom registry, and recovery details.

## Start Agents

After single-tree or workspace setup is complete, start agents normally in separate terminals:

```bash
claude
```

```bash
opencode
```

Each process gets its own identity and joins the coordination state for that working tree. SameTree starts with the harness, so there is no server to launch separately.

Automatic OpenCode delivery requires a local TUI process. Attach mode reports the identity limitation instead of consuming messages for another process.

## Coordination Model

- Tasks record work already assigned by the user; they are not a peer-managed queue.
- Claims identify files an agent intends to edit and reject hard conflicts in the same working tree.
- Messages and handoffs carry context but never change an agent's scope without user authorization.
- Linked-worktree overlaps produce integration warnings rather than pretending branches cannot diverge.

Claims are cooperative records, not filesystem locks. SameTree can reject conflicting claims, but it cannot prevent a process from editing files directly.

Agents normally use MCP tools directly. Humans and scripts can use the same state through the CLI:

```bash
SAMETREE_AGENT=human sametree status
```

## Local By Design

SameTree stores operational state in SQLite under Git's private directories or the local workspace registry. Policy and role files under `.sametree/` remain versioned with the repository.

SameTree is for trusted processes on one machine. It does not merge simultaneous edits, synchronize files, sandbox agents, or support state databases on network and cloud-synced filesystems.

## Documentation

- [Architecture](docs/architecture.md): storage, routing, and concurrency
- [Protocol](docs/protocol.md): tools, state transitions, and invariants
- [Upgrading](docs/upgrading.md): migration, rollback, and workspace recovery
- [Landscape](docs/landscape.md): comparison with related tools
- [Four-agent review loop](examples/review-loop/): worker and reviewer example
- [Contributing](CONTRIBUTING.md): development and demo generation
- [Security](SECURITY.md): vulnerability reporting

## License

[MIT](LICENSE)
