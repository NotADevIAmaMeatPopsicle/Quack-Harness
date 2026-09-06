# Project status

Quack Harness is a public, pre-`1.0` project. The implementation is substantial and actively tested, while APIs and configuration remain subject to change before the first stable release.

## Supported today

- Node.js 20.19 or newer
- Structured Markdown task specifications
- Project adapters for commands, policy, and repository layout
- Readiness, enrichment, blueprint, execution, and judge stages
- Git worktree isolation and branch lifecycle management
- Local queues and distributed headnode/worker scheduling
- Express API, server-sent events, SQLite persistence, and React dashboard
- GitHub issue import, publication, and status synchronization
- Build, test, lint, convention, and custom verification commands

## Release verification

- [x] Adopt the GNU Affero General Public License v3.0 (`AGPL-3.0-only`).
- [x] Complete privacy, credential, provenance, and dependency scans.
- [x] Capture and verify a sanitized screenshot gallery from the real UI.
- [x] Pass installation, build, test, lint, type-check, packaging, and startup
      checks from a fresh clone.
- [x] Validate local Markdown links and applicable external links.
- [x] Review GitHub metadata and issue settings.
- [x] Publish a security policy and configure GitHub Private Vulnerability
      Reporting for confidential reports.

Repository visibility, anonymous rendering, and security-reporting settings are
rechecked whenever release or repository settings change.

The fresh-clone validation on 2026-09-06 passed 5,114 tests in 348 suites, with
9 intentionally skipped tests. Both root and frontend dependency audits
reported zero known vulnerabilities.

## Known limitations

- Provider-backed stages require external credentials and can incur usage charges.
- Distributed deployments require operator-supplied authentication, networking, and repository access.
- Some integration tests exercise process, filesystem, network, Git, or Docker behavior and can be slower than unit tests.
- Configuration and API compatibility are not guaranteed until `1.0`.

This file describes the candidate repository only. It does not claim that production, hardware-specific, or external deployment checks have passed.
