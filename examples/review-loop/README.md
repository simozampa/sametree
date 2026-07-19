# Four-Agent Review Loop

This recipe runs two OpenCode and two Claude Code processes in one working tree. It keeps implementation and review visible without creating per-agent branches.

## Set Up

From the repository the agents will edit:

```bash
sametree setup --claude --opencode
git status --short
git diff
git add -p
git diff --cached
```

Stage setup's hunks only. Add newly created files individually after reviewing their contents, then verify the complete staged diff before committing. The OpenCode file may be `opencode.jsonc` instead of `opencode.json`. Restart both harnesses after setup.

## Launch

Open four terminals at the same repository root:

```bash
SAMETREE_AGENT=opencode-worker-1 SAMETREE_ROLE=implementer opencode
```

```bash
SAMETREE_AGENT=opencode-worker-2 SAMETREE_ROLE=implementer opencode
```

```bash
SAMETREE_AGENT=claude-worker SAMETREE_ROLE=implementer claude
```

```bash
SAMETREE_AGENT=claude-reviewer SAMETREE_ROLE=reviewer claude
```

Use a fifth terminal for the human-readable activity stream:

```bash
SAMETREE_AGENT=observer sametree watch --tail
```

## Work

1. Give one implementer the worker prompt from [prompts.md](prompts.md).
2. Give the reviewer the reviewer prompt and the same task ID.
3. Agents record only the scopes you assigned to them, then claim disjoint paths. If scopes overlap, SameTree rejects the second claim before either agent commits.
4. The implementer sends a task-linked message or offers non-authoritative handoff context when the change is ready.
5. The reviewer reports findings through the task thread. It accepts a handoff only when you explicitly authorize it to edit the implementation.
6. The final owner runs checks, makes an atomic commit, marks the task done, and releases every claim.

Agent names need only be unique within this working tree. Prefix them with the repository name when several projects are open at once.
