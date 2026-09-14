# Quack Harness self-development

The public project is `quack-harness`, targeting this repository's `main`.
Read `docs/SELF_DEVELOPMENT_TRACKER.md`, the assigned `docs/tasks/TASK-*.md`,
and `CONTRIBUTING.md` before making changes. Specs are plans; the canonical
monitor's verification records and accepted Git history determine completion.

- Work on one scoped task in the assigned isolated worktree. Do not change
  other projects, private infrastructure, credentials, live services or host configuration.
- Preserve public packaging, AGPL licensing, Node 20/22 support and frontend dependencies.
- The running harness stays on an accepted build while this checkout is edited.
- Never modify `.quack/adapter.json`, verification machinery, review policy,
  dependency locks or task acceptance criteria unless the task explicitly owns them.
- Readiness, security, federation and lifecycle changes require direct operator
  supervision. UI work must preserve server authority and show unknown states honestly.
- Implement real behavior and focused regression tests. Use isolated fixtures,
  close servers/browsers and release timers. Never exercise live project data in tests.
- Run the task's required checks. CI is informative and is not a waiting gate.
- Record actual commands and outcomes. Do not claim acceptance from an SDK
  completion event, a build alone or self-review.
- Do not push, merge, publish, deploy or send external messages from a worker.
  The operator owns Git integration after independent review and verification.

TypeScript is strict, React lives under `frontend/src`, server/core code under
`src`, Jest tests under `tests`. Keep Quack core project-agnostic.
