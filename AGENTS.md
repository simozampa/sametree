# Agent Instructions

Read and follow these files before making changes:

- `.sametree/policy.md`
- `.sametree/coordination.md`
- The role matching your task under `.sametree/roles/`

Use the SameTree MCP tools to inspect status, policy state, and active claims; acknowledge policy only when `acknowledgedAt` is null, claim the task, and acquire narrow path claims when concurrent editing is plausible or uncertain. Claims are cooperative; never edit a path actively claimed by another agent.

Run `npm run check` before declaring work complete. Make small Conventional Commits and never add co-author trailers.
