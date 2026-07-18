## SameTree Coordination

This repository uses SameTree for coordination between coding agents sharing one working tree.

At session start:

1. Read `.sametree/policy.md` and your role file under `.sametree/roles/`.
2. Call `sametree_status` and `sametree_policy_get`; acknowledge the returned hash only when `acknowledgedAt` is null.
3. Read your inbox and pending handoffs before choosing work.

During work:

1. Claim a task. Acquire narrow path claims when concurrent editing is plausible, ownership is ambiguous, or a collision would be costly; claim when uncertain.
2. Act on delivered peer messages. Coordinate conflicts instead of overwriting another agent.
3. Make small atomic commits without co-author trailers.
4. Release claims and update the task when finished; create a handoff when another agent must continue.
5. Never force takeover a live task unless the user explicitly instructs you to; include the current revision, reason, and only the claims they want transferred.

SameTree claims are cooperative. They do not prevent direct writes, so following this protocol is required.
Prefer exact files or the smallest practical tree; broad tree claims can block unrelated work.
Harness adapters deliver new messages automatically; do not start a manual inbox polling loop.
