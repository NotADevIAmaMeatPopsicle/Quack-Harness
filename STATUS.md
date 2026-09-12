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

## 0.3.0 verification

Source and packed-consumer installation checks passed on Windows Node 20.19.0
and 22.12.0. Linux package checks passed on those Node floors in CI and on
Node 20.20.2 in an isolated host checkout. Consumer checks cover native SQLite,
CLI version/help from an unrelated directory, all 21 required packaged files,
eight documentation resources and compiled dashboard assets.

The runtime and package changes received independent review. Ten focused suites
passed 251 tests with one Windows platform skip. A follow-up test-fixture
correction passed the complete affected dispatch suite on Windows (115 tests,
one skip) and Linux (109 tests, seven platform skips), with natural completion.
The GitHub release identifies the final source commit and artifact checksum.

The broad CI matrix is not wholly green. The earlier Node 22 shard snapshot
recorded 6,701 passing tests, 49 failures and 39 skips; it is diagnostic evidence,
not a successful full-suite result. Hosted Windows Node 20 also lacked a usable
native compilation toolchain, while the corresponding local installation passed.
These limitations remain visible; the historical verification above does not
replace current focused and package checks.

## Known limitations

- Provider-backed stages require external credentials and can incur usage charges.
- Distributed deployments require operator-supplied authentication, networking, and repository access.
- Windows persistence installation requires an explicit stop of the target runtime/listener before repair; it preserves other processes.
- Some integration tests exercise process, filesystem, network, Git, or Docker behavior and can be slower than unit tests.

The validation record above covers repository checks. Production,
hardware-specific, and external deployments must be validated in their target
environments.
