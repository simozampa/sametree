import type { SameTreeConfig } from './config.js';

export function configTemplate(config: SameTreeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const POLICY_TEMPLATE = `# SameTree Collaboration Policy

This repository is edited by multiple coding agents in one working tree. Treat existing changes as shared state, not disposable scratch work.

## Coordination

- Start every session by reading this policy and checking SameTree status.
- Use a unique, stable agent name. Include your harness and role when you register.
- Inspect active claims before editing. Acquire narrow path claims when concurrent editing is plausible, ownership is ambiguous, or a collision would be costly; claim when uncertain.
- Prefer exact files or the smallest practical tree. Broad tree claims unnecessarily block independent work, and all claims remain cooperative leases rather than filesystem locks.
- Do not edit a path claimed by another agent. Send a message and agree on an order instead.
- Act on automatically delivered peer messages and reply through SameTree when appropriate.
- Record decisions and unfinished context in a handoff rather than relying on chat history.

## Git Discipline

- Preserve user and agent changes you did not create. Never reset, revert, or overwrite them without explicit approval.
- Make small, logically atomic commits. Each commit should have one purpose and leave the repository coherent.
- Use Conventional Commit messages such as \`feat: add task claiming\` or \`fix: renew active leases\`.
- Never add \`Co-authored-by\` or similar attribution trailers unless the repository owner explicitly requests them.
- Review the staged diff before every commit. Do not stage unrelated files.

## Delivery

- Run the relevant checks before marking work complete.
- Update the task and release claims when work is complete or blocked.
- State what changed, what was verified, and any remaining risk in the handoff or completion message.
`;

export const IMPLEMENTER_ROLE_TEMPLATE = `# Implementer

Own a narrow task from investigation through verification.

- Confirm dependencies and inspect active claims before editing; claim narrow paths when overlap is plausible or uncertain.
- Prefer the smallest correct change that matches existing patterns.
- Ask the reviewer focused questions through SameTree messages when a decision is ambiguous.
- Commit coherent increments, then send the task ID and commit hash for review.
- Do not mark a task done until its acceptance checks pass.
`;

export const REVIEWER_ROLE_TEMPLATE = `# Reviewer

Review for correctness, regressions, security, and missing tests before style.

- Read the task, handoff, diff, and relevant surrounding code.
- Report findings with severity and file/line references through a task-linked message.
- Do not edit implementation files unless ownership is explicitly transferred to you.
- Acknowledge when no findings remain and identify any testing gaps or residual risk.
`;

export const INTEGRATION_TEMPLATE = `## SameTree Coordination

This repository uses SameTree for coordination between coding agents sharing one working tree.

At session start:

1. Read \`.sametree/policy.md\` and your role file under \`.sametree/roles/\`.
2. Call \`sametree_status\` and \`sametree_policy_get\`; acknowledge the returned hash only when \`acknowledgedAt\` is null.
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
`;
