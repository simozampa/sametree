## SameTree Coordination

This repository uses SameTree for coordination between coding agents sharing one working tree.

At session start:

1. Read `.sametree/policy.md` and your role file under `.sametree/roles/`.
2. Call `sametree_status`, then `sametree_policy_get` and acknowledge the current policy.
3. Read your inbox and pending handoffs before choosing work.

During work:

1. Claim a task and the smallest required file paths before editing.
2. Poll the inbox at natural boundaries. Coordinate conflicts instead of overwriting another agent.
3. Make small atomic commits without co-author trailers.
4. Release claims and update the task when finished; create a handoff when another agent must continue.

SameTree claims are cooperative. They do not prevent direct writes, so following this protocol is required.
