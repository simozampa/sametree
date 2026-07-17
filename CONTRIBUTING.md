# Contributing

Thanks for helping make same-working-tree agent collaboration safer and easier to understand.

## Before You Start

Open an issue before a large feature or protocol change. Small bug fixes, tests, and documentation corrections can go directly to a pull request.

SameTree intentionally does not spawn agents, select models, create worktrees, or merge branches. Proposals in those areas should explain why they belong in the coordination core instead of an external orchestrator.

## Development Setup

```bash
git clone https://github.com/simozampa/sametree.git
cd sametree
npm ci
npm run check
```

Node.js 22.12 or newer and Git are required.

## Pull Requests

- Keep changes narrow and use small Conventional Commits.
- Add tests for behavior and concurrency invariants, not only implementation details.
- Update public types and protocol documentation together.
- Preserve stable error codes unless a breaking release is intentional.
- Do not weaken path normalization, transaction boundaries, or SQLite integrity settings without documenting the tradeoff.
- Do not add `Co-authored-by` trailers.

Run before submitting:

```bash
npm run check
npm pack --dry-run
```

## Testing Concurrency

Coordination bugs often disappear in single-process tests. Changes to tasks, claims, sessions, or handoffs should include competing-process coverage when feasible. A concurrency test should verify both the winner and the absence of partial writes by the loser.

After crash or contention tests, run SQLite `integrity_check` and verify application invariants such as no overlapping active claims between different agents.

## Regenerating the Demo

The animated SVG is generated from the real CLI flow in `scripts/demo.sh`. After changing that flow, install `asciinema` and `jq`, then run:

```bash
npm run build
node scripts/render-demo.mjs
```

The renderer records the real CLI flow, makes the animation play once, and holds its final frame. Run `scripts/demo.sh` directly first when debugging a failed recording. Do not hand-edit `docs/demo.svg`.

## Code Style

- Prefer the smallest complete implementation.
- Keep CLI and MCP adapters free of business rules.
- Use prepared SQL statements and strict TypeScript types.
- Comment non-obvious invariants and failure handling, not line-by-line mechanics.
- Return stable structured errors for expected conflicts.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
