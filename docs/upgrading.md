# Upgrading SameTree

## Upgrade to 0.1.2

Version 0.1.2 makes task ownership user-directed, reduces historical payloads, and adds live Git worktree state. The SQLite schema remains compatible with 0.1.1, but active processes and generated instructions must be refreshed together.

1. Finish or pause current work and stop every Claude Code, OpenCode, SameTree MCP, watcher, and message-follower process in the worktree.
2. Install the release with `npm install --global sametree@0.1.2`.
3. In each configured repository, rerun `sametree setup --claude --opencode`, omitting any harness the repository does not use.
4. Inspect `initialization.updated` and `initialization.preserved` in the setup result and review the resulting Git diff.
5. Restart the configured harnesses.

Setup automatically refreshes files that exactly match stock 0.1.1 content, the generated OpenCode inbox adapter, the exact legacy managed `AGENTS.md` block, and an older installed Claude plugin. Customized policy, role, and instruction content is preserved. A preserved custom policy should explicitly state that only the user changes agent scope and that peer tasks, messages, and handoffs are non-authoritative context.

Do not leave old and new MCP processes active together. Version 0.1.1 processes do not enforce the 0.1.2 assignment rules.

## Existing Work

Assigned tasks keep their owner. An expired task still requires a user-authorized takeover rather than becoming peer-claimable.

Tasks created without an assignee by 0.1.1 are preserved as legacy unassigned records. After the user assigns one, adopt it with its current revision:

```bash
sametree task claim task_... \
  --revision 1 \
  --reason "The user assigned this existing task to this agent" \
  --user-authorized
```

Accepting an existing handoff also requires direct user authorization:

```bash
sametree handoff accept handoff_... \
  --reason "The user directed this agent to continue the work" \
  --user-authorized
```

Status now shows active agents and nonterminal work by default. Use `sametree status --all-agents --all-tasks` for the complete inventory. `sametree task list --all --limit 100` pages history; continue with `--after` and the final task ID from the previous page.

## API Compatibility

Version 0.1.2 intentionally changes these pre-1.0 interfaces:

- Task creation is self-assigned and cross-agent assignment is rejected.
- Normal task claiming never changes ownership.
- Handoff acceptance and takeover require explicit user authorization.
- `Coordinator.listTasks()` defaults to 25 nonterminal tasks.
- Direct event reads default to 25 events.
- Status excludes inactive agents and terminal tasks unless requested.
- Policy acknowledgement and claim-acquisition adapter responses are compact receipts.
- Built-in sessions remain queryable in SQLite but do not add lifecycle events.

Consumers that relied on the 0.1.1 response shapes should be updated before upgrading.

## Rollback

Stop all active processes, install `sametree@0.1.1`, and restart the harnesses. The database schema is unchanged, so no data downgrade is required. Refreshed awareness-first policy files are safe to retain; setup never rewrites customized files during rollback.
