# Security Policy

## Supported Versions

SameTree is currently alpha software. Security fixes are applied to the latest release and the `main` branch.

## Reporting a Vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/simozampa/sametree/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. You can expect an initial response within seven days.

## Security Boundaries

SameTree protects its own state against malformed inputs, accidental path escapes, and conflicting transactional updates. It is not a sandbox or authorization system.

Processes running as the same operating-system user can:

- Write source files without acquiring a claim.
- Read or modify the local SameTree database.
- Impersonate another agent name.
- Bypass Git hooks with `--no-verify`.
- Modify repository policy and hook files.
- Invoke shared-instruction CLI/library APIs with `userAuthorized: true` or modify harness capture plugins.

Do not use SameTree to coordinate mutually hostile agents. Use separate operating-system accounts, containers, or worktrees when isolation is required.

The exact `For all agents:` prefix prevents accidental capture of ordinary prompts by the shipped Claude Code and OpenCode adapters. It is a cooperative authorization signal, not proof of user identity. Agent-facing MCP exposes only instruction reads and per-agent acknowledgements, but a process with the same operating-system access can still forge the prefix, call the CLI or library directly, read stored instruction text, or alter local delivery state.

Keep the SQLite database on a local filesystem. Network filesystems and file-sync services can violate SQLite locking assumptions and are unsupported.
