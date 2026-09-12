# Changelog

Notable changes to Quack Harness, newest first. Released entries describe changes merged into public `main`; Unreleased describes the current release candidate.

## Unreleased — 0.3.0

- Source installs now install the frontend dependencies needed by the build.
  Packed installs validate and use their included CLI, dashboard and runtime
  assets without requiring the source checkout or frontend development files.
- Package verification covers source and packed-consumer installation on the
  supported Node.js lines: 20.19 or newer in Node 20, and 22.12 or newer in Node 22.
- Added a Windows worker installer and documented recovery, drain, monitoring
  and event contracts used by operators.
- Successful shared-checkout jobs release deferred ownership after reconciliation
  confirms that their processes have stopped and the original Git state has been
  restored. Exact durable completion evidence supports recovery after restart;
  paused, failed and ambiguous work retains its protection.
- Package dependency criteria no longer incorrectly demand Set/Map lookup code.
  Explicit cross-reference and dependency-existence checks still apply.

## 2026-09-12 — Core lifecycle and publication recovery

Merged in [PR #1](https://github.com/NotADevIAmaMeatPopsicle/Quack-Harness/pull/1).
This entry covers [`65aad7a` → `e1ce0b9e`](https://github.com/NotADevIAmaMeatPopsicle/Quack-Harness/compare/65aad7a2b5994b25c394ca0a6acae5c5efe6a215...e1ce0b9e0d2d23f96fd0f33cd4416d9faa455e44), from the previous public `main` revision through the merge. Package version remains `0.2.0`.

### Added

- **GitHub sync-map migration:** `quack migrate-github-sync-map --project <path>` reconciles legacy mappings with the task IDs declared in specifications. `--dry-run` previews the migration; reports identify conflicting, ambiguous and orphaned entries.
- **Offline federation-lock repair:** `quack repair-federation-lock <jobId>` inspects stale legacy locks. Applying recovery requires confirmation that shared Quack processes are stopped and a fingerprint matching the inspected lock.
- **Worker registration diagnostics:** the Fleet dashboard identifies invalid listener registrations while keeping valid workers visible. Invalid registrations cannot receive work.
- **Claude authentication health reporting:** bounded, cached probes report the selected credential's result, with sanitized diagnostics and project-specific cache ownership.

### Fixed

- **Paused and interrupted runs:** recovery binds saved approval and checkpoint state to the original project, job, host and session. Resume checks reject conflicting or duplicate starts and preserve pending approval state.
- **Task identity:** GitHub synchronization, task allocation, status updates and parent/subtask attribution use declared task IDs consistently, including four-digit IDs. Duplicate declarations block ambiguous operations.
- **Task decomposition:** journaled specification updates, reservations and recovery checks protect against partial writes, competing task creation and dispatch before finalization completes.
- **Verification records:** canonical database writes and regenerated projections are coordinated. Reading verification state no longer creates authoritative records; malformed write payloads are rejected.
- **Preparation results:** missing or invalid provider results are recorded as failures instead of successful preparation. Shutdown and result handling preserve truthful terminal state.
- **Federation scheduling:** worker evidence is associated with the exact dispatch attempt, blocked preparation gates can be reconsidered after prerequisites change, and dashboard cancellation carries the job's project identity.
- **GitHub issue publication:** cursor-based pagination removes the previous 100-issue lookup ceiling while checking repository identity and pagination progress. Publication recovery handles uncertain creation outcomes without blindly creating another issue.
- **Git and Docker publication:** repository, remote, branch and commit checks protect publication and cleanup. Durable recovery records preserve uncertain outcomes, and merge worktrees remain available until the operations using them finish.
- **Provider authentication:** Claude-backed execution paths share credential selection and sanitization rules, including Docker execution and review paths.
- **Monitor shutdown:** timers, GitHub polling, watchers and owned subprocess work are stopped or drained during shutdown, reducing leaked activity and late writes.

### Changed

- Decomposition validates a maximum-subtask setting of **2–6**, with **4** as the default.
- Verification and subprocess execution apply stricter command, environment and path checks, with bounded process cleanup and retained failure evidence.
- Expanded regression coverage for recovery, publication, verification, authentication and shutdown. Native Git lock tests now wait for their fixture work to settle and retain diagnostics after a timeout, preventing assertions from spilling into the next test.
