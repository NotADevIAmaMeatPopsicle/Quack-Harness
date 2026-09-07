# Security policy

## Reporting a vulnerability

GitHub Private Vulnerability Reporting is enabled for this repository. Use the
**Report a vulnerability** option in the repository's **Security** tab. Include
the affected version or commit, reproduction steps, impact, and any suggested
mitigation. If GitHub's reporting form is temporarily unavailable, contact a
maintainer privately through their GitHub profile. Do not open a public issue
for a suspected vulnerability.

Please do not disclose a vulnerability publicly until maintainers have confirmed a remediation and coordinated disclosure.

## Supported versions

Security fixes target the current default branch. Older snapshots are not maintained.

## Deployment guidance

Quack Harness can execute commands, modify repositories, and call external model providers. Operators should:

- use least-privilege repository and service credentials
- keep keys and tokens in environment variables or a secret store
- avoid embedding credentials in Git URLs or task text
- bind the monitor to trusted interfaces and require authentication for remote access
- restrict adapter write paths and command allowlists
- isolate worker jobs in dedicated worktrees or containers
- review generated changes before merge
- rotate credentials immediately if exposure is suspected

Secrets committed to Git history should be considered compromised even after the visible branch is rewritten.
