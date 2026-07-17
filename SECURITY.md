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

Do not use SameTree to coordinate mutually hostile agents. Use separate operating-system accounts, containers, or worktrees when isolation is required.

Keep the SQLite database on a local filesystem. Network filesystems and file-sync services can violate SQLite locking assumptions and are unsupported.
