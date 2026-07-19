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

printf '\033[1;35mSameTree: coordinate agents before they edit\033[0m\n\n'

prompt 'sametree setup --opencode'
"${CLI[@]}" setup --opencode | jq -r '"ready: launch " + (.restartCommands | join(" or "))'

SAMETREE_AGENT=agent-b SAMETREE_HARNESS=opencode \
  "${CLI[@]}" status >/dev/null

prompt 'agent-a records its task and claims its file'
task_json="$(SAMETREE_AGENT=agent-a SAMETREE_HARNESS=opencode \
  "${CLI[@]}" task create --title 'Add request validation' --priority high)"
task_id="$(jq -r '.id' <<<"$task_json")"
SAMETREE_AGENT=agent-a "${CLI[@]}" task claim "$task_id" >/dev/null
claim_json="$(SAMETREE_AGENT=agent-a "${CLI[@]}" claim acquire src/api.ts --ttl 3600)"
printf 'task:  %s (in progress)\n' "$(jq -r '.title' <<<"$task_json")"
printf 'file:  %s claimed by agent-a\n' "$(jq -r '.[0].path' <<<"$claim_json")"

prompt 'agent-b tries to claim the same file'
if conflict="$(SAMETREE_AGENT=agent-b "${CLI[@]}" claim acquire src/api.ts 2>&1)"; then
  printf 'expected duplicate claim to fail\n' >&2
  exit 1
fi
if [[ "$(jq -r '.error.code' <<<"$conflict")" != 'CLAIM_CONFLICT' ]]; then
  printf 'duplicate claim failed with an unexpected error\n' >&2
  exit 1
fi
jq -r '.error.code + ": another agent already owns this path"' <<<"$conflict"

prompt 'agent-a sends context instead of racing'
SAMETREE_AGENT=agent-a "${CLI[@]}" message send \
  --to agent-b --subject 'I own src/api.ts' \
  --body 'I will message you when validation is ready.' --task "$task_id" >/dev/null
SAMETREE_AGENT=agent-b "${CLI[@]}" message inbox --unread \
  | jq -r '.[0] | .sender + " -> " + .recipient + ": " + .subject'

printf '\n\033[1;32mConflicts stop early. Context stays shared and local.\033[0m\n'
sleep 1
