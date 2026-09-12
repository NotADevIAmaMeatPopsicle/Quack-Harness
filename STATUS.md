# Project status

## Supported today

- Node.js 20.19+ within Node 20, or 22.12+ within Node 22
- Structured Markdown task specifications
- Project adapters for commands, policy, and repository layout
- Readiness, enrichment, blueprint, execution, and judge stages
- Git worktree isolation and branch lifecycle management
- Local queues and distributed headnode/worker scheduling
- Express API, server-sent events, SQLite persistence, and React dashboard
- GitHub issue import, publication, and status synchronization
- Build, test, lint, convention, and custom verification commands

## Historical release verification (2026-09-10)

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

The fresh-clone validation on 2026-09-10 passed 5,258 tests in 356 suites, with
10 tests in 2 suites intentionally skipped. Both root and frontend dependency
audits reported zero known vulnerabilities.

## 0.3.0 candidate verification

The next version remains a candidate until its accepted source projection,
natural full-suite result, source install, packed consumer install, and exact
tag/artifact readback are recorded. The historical checklist above is not
acceptance of this candidate. The new installation checks cover the declared
Node floors, compiled UI and documentation assets, native SQLite, and CLI
identity. Published evidence must identify the tested commit and artifact
checksum; packaging preparation alone is not a completed release.

## Known limitations

- Provider-backed stages require external credentials and can incur usage charges.
- Distributed deployments require operator-supplied authentication, networking, and repository access.
- Windows persistence installation requires an explicit stop of the target runtime/listener before repair; it preserves other processes.
- Some integration tests exercise process, filesystem, network, Git, or Docker behavior and can be slower than unit tests.

The validation record above covers repository checks. Production,
hardware-specific, and external deployments must be validated in their target
environments.
