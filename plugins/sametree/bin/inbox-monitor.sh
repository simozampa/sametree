#!/bin/sh
set -eu

if [ -n "${SAMETREE_AGENT:-}" ]; then
  agent=$SAMETREE_AGENT
elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  agent="claude-code-${CLAUDE_CODE_SESSION_ID}"
else
  printf '%s\n' 'SameTree: CLAUDE_CODE_SESSION_ID is unavailable; inbox monitor stopped.' >&2
  exit 1
fi

executable=${SAMETREE_BIN:-sametree}
project=${CLAUDE_PROJECT_DIR:-$PWD}

exec "$executable" --cwd "$project" --agent "$agent" --harness claude-code \
  message follow --json --prefix 'SameTree message: '
