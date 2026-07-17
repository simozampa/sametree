# Open-Source Landscape

SameTree was designed after reviewing the projects below in July 2026. This is not a claim that alternatives are bad or that SameTree is universally better. Each project optimizes for a different operating model.

## Closest Alternatives

| Project | Primary model | State and infrastructure | Same working tree? |
| --- | --- | --- | --- |
| [swarm-tools](https://github.com/joelhooks/swarm-tools) | Opinionated OpenCode and Claude worker coordination | Embedded libSQL event store plus Git-backed `.hive/` tasks; Bun | Yes by default; optional worktrees |
| [Swarm Protocol](https://github.com/phuryn/swarm-protocol) | Headless MCP coordination across agents and humans | PostgreSQL, commonly through Docker | Yes; claims are advisory |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Agent identities, mail, and file reservations | Local server, SQLite indexes, Git-audited messages | Yes |
| [CCPM](https://github.com/automazeio/ccpm) | PRD and epic execution through GitHub Issues | Markdown, GitHub, Git worktrees | Multiple streams share an epic worktree |
| [Gas Town](https://github.com/gastownhall/gastown) | Persistent multi-agent process and workflow manager | Dolt, Beads, tmux, daemons | No; workers use isolated worktrees |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | Session-scoped Claude teammates | Local task and mailbox files | Yes, with documented overwrite risk |

## Why Build Another Tool?

A mailbox plus advisory file reservations already exists elsewhere. SameTree focuses on a narrower combination:

- Already-running Claude Code and OpenCode instances launched independently by one developer.
- One existing dirty working tree rather than one worktree per worker.
- One embedded transactional store for tasks, atomic claims, leases, messages, handoffs, policy acknowledgements, and audit events.
- No local HTTP daemon, PostgreSQL, Dolt, Redis, Docker, GitHub account, or Bun runtime.
- Versioned cross-harness policy plus optional commit-time mechanical checks.
- An unambiguous OSI-approved MIT license.

If swarm-tools' task decomposition and plugin model fit your workflow, use it. If agents need to collaborate across machines or a human team, use a network-capable system such as Swarm Protocol or aweb. If independent workers rarely share uncommitted state, worktree-oriented systems provide stronger isolation than SameTree.

## Design Lessons Adopted

Several ideas recur across successful systems and are retained here:

- Tasks and communication are different primitives.
- Claims need expiries because agent processes crash.
- Handoffs must persist context beyond chat history.
- Current ownership must be visible before edits begin.
- Agents need a polling loop at natural boundaries.
- Claims cannot make concurrent same-file editing safe; work must be serialized.
- Prompt instructions drift, so checkable rules benefit from Git hooks.

## Material Differences

SameTree uses SQLite rather than append-only files because claim batches, dependency checks, and handoff acceptance need cross-process transactions. It keeps the database in Git's private worktree directory rather than a tracked project directory because active WAL files should not be synchronized through Git.

SameTree intentionally does not spawn agents, choose tasks, create worktrees, merge branches, or call models. It coordinates processes that the developer already controls.

## Sources

- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [swarm-tools repository](https://github.com/joelhooks/swarm-tools)
- [Swarm Protocol specification](https://github.com/phuryn/swarm-protocol/blob/main/docs/SPEC.md)
- [CCPM execution protocol](https://github.com/automazeio/ccpm/blob/main/skill/ccpm/references/execute.md)
- [Gas Town architecture](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md)
- [MCP Agent Mail repository](https://github.com/Dicklesworthstone/mcp_agent_mail)
- [SQLite WAL documentation](https://www.sqlite.org/wal.html)
- [Model Context Protocol stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

Repository behavior and licensing can change quickly. Recheck upstream documentation before making a long-term tooling decision.
