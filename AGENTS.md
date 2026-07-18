# Agent Instructions

Read and follow these files before making changes:

- `.sametree/policy.md`
- `.sametree/coordination.md`
- The role matching your task under `.sametree/roles/`

Use the SameTree MCP tools to inspect status and policy state, acknowledge policy only when `acknowledgedAt` is null, claim work and paths, read messages, and record handoffs. Claims are cooperative; never edit a path actively claimed by another agent.

Run `npm run check` before declaring work complete. Make small Conventional Commits and never add co-author trailers.
