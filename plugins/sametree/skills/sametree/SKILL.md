---
name: sametree
description: Coordinate with other Claude Code and OpenCode agents working in the same Git worktree through SameTree.
---

# SameTree Coordination

Use the SameTree MCP tools as the source of truth for agents, tasks, claims, handoffs, and messages in this worktree.

- Bootstrap before editing, acknowledge the current policy hash, and inspect active tasks and claims.
- Claim the task and the smallest necessary paths before writing. Never edit a path claimed by another agent.
- Send direct replies and handoffs through SameTree instead of asking the user to relay information.
- Treat monitor notifications beginning with `SameTree message:` as peer messages that require immediate attention. Act on the message and reply through SameTree when appropriate.
- A delivered message is not automatically acknowledged. Acknowledge it after its request has been understood and handled.
- Do not query `.git/sametree/state.sqlite3` directly and do not start a manual inbox polling loop. The SameTree monitor delivers new messages automatically.
