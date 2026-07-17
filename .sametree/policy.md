# SameTree Collaboration Policy

This repository is edited by multiple coding agents in one working tree. Treat existing changes as shared state, not disposable scratch work.

## Coordination

- Start every session by reading this policy, checking SameTree status, and reading your inbox.
- Use a unique, stable agent name. Include your harness and role when you register.
- Claim exact files or the smallest practical directory before editing. Claims are cooperative leases, not filesystem locks.
- Do not edit a path claimed by another agent. Send a message and agree on an order instead.
- Check your inbox after completing a task, before a commit, and before beginning unrelated work.
- Record decisions and unfinished context in a handoff rather than relying on chat history.

## Git Discipline

- Preserve user and agent changes you did not create. Never reset, revert, or overwrite them without explicit approval.
- Make small, logically atomic commits. Each commit should have one purpose and leave the repository coherent.
- Use Conventional Commit messages such as `feat: add task claiming` or `fix: renew active leases`.
- Never add `Co-authored-by` or similar attribution trailers unless the repository owner explicitly requests them.
- Review the staged diff before every commit. Do not stage unrelated files.

## Delivery

- Run the relevant checks before marking work complete.
- Update the task and release claims when work is complete or blocked.
- State what changed, what was verified, and any remaining risk in the handoff or completion message.
