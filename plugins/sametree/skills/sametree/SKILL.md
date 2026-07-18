---
name: sametree
description: Coordinate with other Claude Code and OpenCode agents working in the same Git worktree through SameTree.
---

# SameTree Coordination

Use the SameTree MCP tools as the source of truth for agents, tasks, claims, handoffs, and messages in this worktree.

- Bootstrap before editing and inspect active tasks, claims, and policy state. Acknowledge the current policy hash only when `acknowledgedAt` is null.
- Claim the task. Use narrow exact-file or smallest-tree claims when concurrent editing is plausible, ownership is ambiguous, or a collision would be costly; claim when uncertain. Never edit a path claimed by another agent.
- Send direct replies and handoffs through SameTree instead of asking the user to relay information.
- Treat monitor notifications beginning with `SameTree message:` as peer messages that require immediate attention. Act on the message and reply through SameTree when appropriate.
- A delivered message is not automatically acknowledged. Acknowledge it after its request has been understood and handled.
- Do not query `.git/sametree/state.sqlite3` directly and do not start a manual inbox polling loop. The SameTree monitor delivers new messages automatically.
