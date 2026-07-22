# Upgrading SameTree

## Upgrade To 0.4.2

Version 0.4.2 fixes native SQLite crashes when a harness launches globally installed SameTree with a different Node.js runtime than the one that installed it. This can happen when Claude Code or OpenCode changes `PATH`: the npm bin path still resolves `sametree`, but its `#!/usr/bin/env node` shebang selects the harness runtime. SameTree now records the exact Node executable during npm installation and relaunches both CLI and MCP entrypoints with it before opening SQLite.

There is no database schema change from 0.4.1. From your normal shell, run `npm install --global sametree@0.4.2 --force`, then rerun `sametree setup --claude --opencode` in each worktree and restart the harnesses. Do not run `npm rebuild better-sqlite3` from inside a harness with a different Node runtime: that rewrites the shared global native binding for the harness ABI and breaks other clients.

## Upgrade To 0.4.1

Version 0.4.1 fixes Claude Code setup when a genuine SameTree marketplace was registered from another project, package-manager cache, or development checkout. Setup now verifies SameTree marketplace/plugin metadata and safely rebinds that user-global marketplace to the current package path. An unrelated marketplace that merely uses the `sametree` name is still rejected. Setup also checks the SQLite native binding before writing harness configuration and reports an actionable npm reinstall command when the active Node ABI does not match.

There is no database schema change from 0.4.0. Install `sametree@0.4.1` with npm under the Node.js runtime used by Claude Code and OpenCode, then rerun `sametree setup --claude --opencode` directly in each worktree that launches a harness. Do not use `bunx` for SameTree because its native dependency may be installed for a different Node ABI.

## Upgrade To 0.4.0

Version 0.4.0 adds explicit shared user instructions, immutable revisions and revocation, per-agent revision acknowledgements, structured delivery, and exact-prefix capture for Claude Code and OpenCode. It upgrades coordination databases from schema 5 to schema 6. SameTree 0.3.x cannot read schema 6, so prepare rollback backups before any 0.4 command opens existing state.

1. Finish or pause work and stop every Claude Code, OpenCode, SameTree MCP, watcher, message follower, and other process using each standalone or workspace database.
2. Back up every `state.sqlite3` with its `-wal` and `-shm` sidecars as one coherent set while all processes are stopped.
3. Install `npm install --global sametree@0.4.0`.
4. Rerun `sametree setup --claude --opencode` in every physical worktree that launches a harness, omitting unused harnesses. This updates the Claude plugin with its `UserPromptSubmit` hook and refreshes the generated OpenCode project plugin with `chat.message` capture. Review setup statuses and tracked-file diffs.
5. Restart the harnesses. The first 0.4 coordination or diagnostic command migrates the selected database in place.

Do not run 0.3.x and 0.4 processes against the same database. Schema 6 adds shared instruction, immutable revision, acknowledgement, and structural-notification tables; all schema-5 coordination state and IDs are preserved. Existing workspace imports copy instruction state and reject source-identity or entity-ID collisions.

Automatic capture is deliberately narrow. Only a prompt beginning at its first character with the exact, case-sensitive prefix `For all agents:` is recorded, and the complete prompt text is preserved. Ordinary prompts and near matches remain local. MCP exposes only instruction reads and per-agent acknowledgements. User-facing CLI/library mutation requires an explicit direct-user-authorization assertion and never creates tasks or expands scope.

For rollback, stop every 0.4 process, remove the complete schema-6 database set, and restore the exact coherent schema-5 backup before reinstalling 0.3.x. There is no automatic schema downgrade. Rerun the older setup so Claude Code and OpenCode integrations match the restored package; instructions recorded after upgrading are absent from the schema-5 backup.

## Upgrade To 0.3.0

Version 0.3.0 adds automatic proposed-plan sharing for Claude Code and OpenCode, immutable plan revisions, peer notifications, and CLI/MCP plan access. It upgrades coordination databases from schema 4 to schema 5. SameTree 0.2.x cannot read schema 5, so prepare rollback backups before any 0.3 command opens existing state.

1. Finish or pause work and stop every Claude Code, OpenCode, SameTree MCP, watcher, message follower, and other process using the standalone or workspace database.
2. Back up each standalone or explicit workspace `state.sqlite3` with any `-wal` and `-shm` sidecars as one coherent set while all processes are stopped.
3. Install `npm install --global sametree@0.3.0`.
4. Rerun `sametree setup --claude --opencode` in every physical worktree that launches a harness, omitting unused harnesses. This updates the Claude plugin with its `ExitPlanMode` hook and installs the managed `.opencode/plugins/sametree-plan-publisher.ts` project plugin. Review setup statuses and tracked-file diffs.
5. Restart the harnesses. The first 0.3 coordination or diagnostic command migrates the selected database in place.

Do not run 0.2.x and 0.3 processes against the same database. Schema 5 adds `plans` and `plan_revisions`; all schema-4 coordination state and IDs are preserved. Existing workspace imports also copy plan state and reject plan identity collisions.

For rollback, stop every 0.3 process, remove the complete schema-5 database set, and restore the exact coherent schema-4 backup before reinstalling 0.2.x. There is no automatic schema downgrade. Rerun the older setup so harness integrations match the restored package version; plans published after upgrading are absent from the schema-4 backup.

## Upgrade To 0.2.0

Version 0.2.0 adds explicit multi-repository workspaces, linked-worktree integration warnings, member-qualified tasks, claims, and policies, and workspace lifecycle recovery. It upgrades coordination databases from schema 3 to schema 4. SameTree 0.1.x cannot read schema 4, so prepare rollback backups before any 0.2 command opens existing state.

1. Finish or pause work and stop every Claude Code, OpenCode, SameTree MCP, watcher, message follower, and other process using the repository.
2. Back up each private standalone database while all processes are stopped. Preserve `state.sqlite3` with any `-wal` and `-shm` sidecars as one coherent set.
3. Install `npm install --global sametree@0.2.0`.
4. Rerun `sametree setup --claude --opencode` in every physical worktree that will launch a harness, omitting unused harnesses. Review `initialization.updated`, `initialization.preserved`, Claude/OpenCode integration statuses, and the Git diff. Setup may update the user-scoped Claude plugin and replaces only the generated OpenCode inbox file carrying SameTree's managed marker.
5. If standalone isolation is still desired, restart the harnesses. The first 0.2 coordination or diagnostic command migrates that database in place to an implicit one-member workspace.
6. If members should share coordination, choose a registry location and follow the explicit workspace procedure below before restarting harnesses.

Do not run 0.1.x and 0.2 processes together. Version 0.1.x ignores explicit workspace bindings and may create split-brain standalone state, while rejecting any private database already migrated to schema 4.

## Create An Explicit Workspace

The default registry root is `$XDG_DATA_HOME/sametree/workspaces`, falling back to `~/.local/share/sametree/workspaces`. For a custom local path, export one value before running setup or starting any CLI, MCP, monitor, OpenCode plugin, or hook process:

```bash
export SAMETREE_WORKSPACE_REGISTRY=/local/state/sametree/workspaces
```

Generated MCP configuration intentionally does not embed this machine-specific path. The harness must inherit the variable.

Create the workspace from one member:

```bash
cd /path/to/frontend
sametree workspace create "Product" --member frontend --import-current
```

Use the returned ID for every additional member:

```bash
sametree --cwd /path/to/backend \
  workspace add Product --member backend --fresh

sametree --cwd /path/to/frontend workspace status
sametree --cwd /path/to/frontend workspace members
sametree --cwd /path/to/frontend workspace doctor
sametree --cwd /path/to/frontend doctor
```

Exactly one state mode is mandatory:

- `--fresh` leaves the member's prior standalone tasks, agents, messages, claims, and history outside the workspace. Existing shared workspace state is unaffected.
- `--import-current` copies current standalone state into the workspace, preserves entity IDs, remaps rows to the new member, and gives imported events new workspace-global sequences.

Add and relink accept the exact workspace ID or a unique workspace name. Use the ID when names are duplicated. The command always joins its current `--cwd`; path-like workspace arguments are rejected with guidance. Create and add initialize missing `.sametree/` files, while `sametree setup` remains required for harness integration.

Import aborts on agent-name, session, task, claim, message, handoff, event, repository, worktree, member-name, or path identity collisions. Combining independently active repositories often exposes agent-name collisions; resolve the plan before retrying rather than editing databases manually.

Both modes preserve the source database at its private Git path, but it becomes an independent snapshot and receives no post-join workspace changes. A source opened for import is migrated to schema 4 first.

Workspace create/add refuses unexpired standalone sessions. A killed process may block the transition until the default 90-second session lease expires. Repeating the exact command safely resumes an interrupted transition. If create failed before recording a member, run `sametree workspace cancel-create` to discard its empty registration before changing name, member, or mode. An interrupted add recovers its exact inserted member and requires the originally recorded join mode before completing the source transition.

## Existing State

Schema 4 preserves existing IDs while adding implicit workspace, repository, member, session-home, task-member, claim-member, policy-member, event-origin, and branch metadata. Existing tasks are associated with the implicit member during migration.

Assigned tasks keep their owner. Expired tasks still require a user-authorized takeover. Legacy unassigned tasks require their current revision, reason, and direct user authorization:

```bash
sametree task claim task_... \
  --revision 1 \
  --reason "The user assigned this existing task to this agent" \
  --user-authorized
```

Accepting a handoff remains user-authorized:

```bash
sametree handoff accept handoff_... \
  --reason "The user directed this agent to continue the work" \
  --user-authorized
```

Exact stock 0.1.1 and 0.1.2 policy and coordination files are refreshed with workspace-aware guidance. Customized files are preserved and must be reviewed manually.

## Member Recovery

`sametree workspace leave` retires the current member after its live sessions stop. It removes local bindings but preserves shared history and does not copy shared changes back to the standalone database.

`sametree workspace prune` conservatively retires members whose recorded root or private Git identity is definitely stale. `sametree workspace relink <workspace-id-or-name> --member <name>` restores a moved worktree only when its original private and common Git identities still match. Use `git worktree move` when moving linked worktrees; a clone or replacement worktree cannot assume an old member identity.

Unavailable members remain visible for historical task and claim filtering and make `workspace doctor` report a warning.

## API Compatibility

Version 0.2.0 intentionally changes these pre-1.0 interfaces:

- Status includes workspace, members, sessions, agent active-member data, task member tags, claim member data, and integration warnings.
- Task create/update accepts member tags; task list accepts a member filter.
- Claim acquisition accepts member-qualified paths. Compact adapter receipts return member and warnings; full lists and library results also expose worktree identity.
- Policy reads and acknowledgements accept a member and are scoped by member.
- Events include member/worktree origin where applicable.
- `WorkspaceContext` reports whether the common repository binding is present.
- Standalone databases automatically migrate to schema 4.

Workspace lifecycle is available through the CLI and library, not MCP tools. Existing MCP coordination tools automatically use the bound workspace.

## Rollback

There is no automatic schema downgrade and no command that merges shared workspace state back into several standalone databases.

For a reliable rollback:

1. Stop all 0.2 processes.
2. Preserve the explicit registry database if later recovery may be needed.
3. Run `sametree workspace leave` under 0.2 for each accessible bound member whose local binding should be removed. Stop all member sessions first.
4. For every physical worktree, locate its private Git directory with `git rev-parse --absolute-git-dir`. Remove the complete post-upgrade `sametree/state.sqlite3`, `-wal`, and `-shm` set before restoring the exact coherent schema-3 backup set. Verify `SELECT MAX(version) FROM schema_migrations` is `3` before starting 0.1.x.
5. Restore the pre-upgrade `.sametree/policy.md` and `.sametree/coordination.md` files. The 0.1.2 setup treats stock 0.2 workspace-aware guidance as customized and will not downgrade it automatically.
6. Install `sametree@0.1.2`, rerun its setup where needed, explicitly verify the user-scoped Claude plugin reports `0.1.2`, and restart harnesses only after every worktree is routed independently.

After `--import-current`, the source has already been migrated to schema 4 and must be restored from a pre-upgrade backup for 0.1.x. After `--fresh`, a source might remain schema 3 only if no 0.2 coordination or diagnostic command opened it. Do not rely on that possibility without checking a backup.

Workspace work performed after joining is absent from old standalone backups. Keep the shared database if that history matters. Registry records and shared history are not deleted by leave.
