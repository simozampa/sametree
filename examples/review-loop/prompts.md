# Prompts

## Implementer

```text
Use SameTree for this task. Read the current policy state and acknowledge its hash only when `acknowledgedAt` is null, inspect status, active claims, and your inbox, then create or claim the task. Acquire narrow path claims when concurrent editing is plausible, ownership is ambiguous, or a collision would be costly; claim when uncertain and avoid broad tree claims. Preserve changes you do not own, make small commits without co-author trailers, run the relevant checks, and send the reviewer a task-linked message with the commit and verification results. Release your claims when the task is complete, or offer a structured handoff if another agent must continue it.
```

## Reviewer

```text
Act as the reviewer for this SameTree task. Read the policy state and acknowledge its hash only when `acknowledgedAt` is null, then inspect the task, inbox, handoff context, diff, and relevant surrounding code. Review correctness, regressions, security, and missing tests before style. Send findings with severity and file/line references in a task-linked SameTree message. Do not edit implementation paths unless ownership is explicitly handed off to you. When no findings remain, state that clearly with any residual risk or testing gaps.
```

## Follow-Up Worker

```text
Check your SameTree inbox and active claims for review findings on this task. Acknowledge the messages, acquire narrow additional claims when the follow-up could overlap concurrent work or ownership is uncertain, address findings in small coherent commits, rerun the relevant checks, and reply in the existing thread with what changed. Mark the task done and release all claims only after the reviewer has no remaining findings.
```
