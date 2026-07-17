#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$(mktemp -d)"
CLI=(node "$ROOT/dist/cli.js")

cleanup() {
  rm -rf "$DEMO"
}
trap cleanup EXIT

prompt() {
  printf '\033[1;36m$\033[0m %s\n' "$1"
  sleep 0.7
}

git init --quiet --initial-branch=main "$DEMO"
cd "$DEMO"

printf '\033[1;35mSameTree: four agents, one working tree\033[0m\n\n'

prompt 'sametree setup --opencode'
"${CLI[@]}" setup --opencode | jq -c '{created: .initialization.created, opencode}'

SAMETREE_AGENT=claude-reviewer SAMETREE_HARNESS=claude-code \
  "${CLI[@]}" status >/dev/null

prompt 'opencode-worker creates and claims a task'
task_json="$(SAMETREE_AGENT=opencode-worker SAMETREE_HARNESS=opencode \
  "${CLI[@]}" task create --title 'Add request validation' --priority high)"
task_id="$(jq -r '.id' <<<"$task_json")"
jq -c '{id, title, status, priority}' <<<"$task_json"
SAMETREE_AGENT=opencode-worker "${CLI[@]}" task claim "$task_id" \
  | jq -c '{id, status, assignee}'

prompt 'opencode-worker claims src/ recursively'
claim_json="$(SAMETREE_AGENT=opencode-worker \
  "${CLI[@]}" claim acquire --tree src --ttl 3600)"
claim_id="$(jq -r '.[0].id' <<<"$claim_json")"
jq -c '.[] | {path, kind, agentName}' <<<"$claim_json"

prompt 'claude-reviewer tries to claim src/api/'
if conflict="$(SAMETREE_AGENT=claude-reviewer \
  "${CLI[@]}" claim acquire --tree src/api 2>&1)"; then
  printf 'expected nested claim to fail\n' >&2
  exit 1
fi
if [[ "$(jq -r '.error.code' <<<"$conflict")" != 'CLAIM_CONFLICT' ]]; then
  printf 'nested claim failed with an unexpected error\n' >&2
  exit 1
fi
jq -c '.error | {code, message}' <<<"$conflict"

prompt 'worker sends context and offers a handoff'
SAMETREE_AGENT=opencode-worker "${CLI[@]}" message send \
  --to claude-reviewer --subject 'Ready for review' \
  --body 'Validation is implemented and checks pass.' --task "$task_id" \
  | jq -c '{sender, recipient, subject}'
handoff_json="$(SAMETREE_AGENT=opencode-worker "${CLI[@]}" handoff offer "$task_id" \
  --to claude-reviewer --summary 'Review and finish validation.' --claim "$claim_id")"
handoff_id="$(jq -r '.id' <<<"$handoff_json")"
jq -c '{id, fromAgent, toAgent, status}' <<<"$handoff_json"

prompt 'claude-reviewer accepts task and path ownership'
SAMETREE_AGENT=claude-reviewer SAMETREE_ROLE=reviewer \
  "${CLI[@]}" handoff accept "$handoff_id" \
  | jq -c '{taskId, toAgent, status}'

prompt "sametree watch --once | grep -E 'task|claim|message|handoff'"
SAMETREE_AGENT=observer "${CLI[@]}" watch --once \
  | grep -E 'task|claim|message|handoff'

printf '\n\033[1;32mNo daemon. No worktrees. Shared context stays local.\033[0m\n'
sleep 1
