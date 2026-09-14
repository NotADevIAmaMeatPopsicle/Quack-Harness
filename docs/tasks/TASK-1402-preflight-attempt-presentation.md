# TASK-1402: Present preflight attempt timing and diagnostics clearly

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** M
- **Status:** BACKLOG
- **Target Branch:** main
- **Execution Mode:** loop
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [frontend, preflight]

## Problem Statement
The task detail page has durable attempt identity, fresh retry and reconciliation
controls, but an operator still needs clearer timing and diagnostic context for
the current attempt. Improve presentation without changing recovery authority.

## Current State
TaskDetailPage.tsx already uses project/task query keys, jobId correlation,
accepted/running/recovery_required states and guarded retry/replan. Preserve
those behaviors. Revalidate available timestamp/error fields against the
FullPreflightJob contract before implementation; missing data must stay unknown.
The source mapping below is complete at dbd295fe; independent spec review and
task-specific verification policy remain required before marking READY.

## Recommended Approach
Map the real response fields and current state rendering. Add compact textual
attempt details using only returned timestamps and errors. Distinguish queued,
running, failed, completed and recovery-required states; preserve last-known
status labeling on network errors. Link fresh-retry/reconcile guidance to the
existing controls without adding requests or weakening confirmation/fencing.

## Source Mapping and Display Contract

src/monitor/preflight-job-store.ts already defines acceptedAt as required and
startedAt/completedAt as optional ISO datetimes. Failed/completed terminal
records require completedAt. frontend/src/api/contracts.ts currently exposes
acceptedAt but omits the two optional timestamps. Add those two optional string
fields to the frontend interface only; do not change server responses.

Display **Queued at**, **Started at**, and **Finished at** with the existing date
formatter. Missing/invalid values display **Unknown**. Display **Run duration**
only when startedAt and completedAt are valid and nondecreasing; otherwise show
**Unknown**. No new timer or fabricated live duration. result.timestamp is a
report timestamp, not a substitute for completedAt. Keep jobId visible.

Use existing job.error/errorType for terminal/recovery diagnostics and eventError
for incomplete event recording; do not expose confirmationToken or owner/process
metadata. Preserve the existing last-known warning on refresh errors. Preserve
the current status predicates, project/task query keys, retry coalescing notice,
captured-attempt toast correlation and explicit reconciliation confirmation.

## Files to Modify
| File | Action | Description |
| --- | --- | --- |
| frontend/src/pages/TaskDetailPage.tsx | Modify | Attempt detail and diagnostic presentation |
| frontend/src/api/contracts.ts | Modify | Add only startedAt/completedAt optional timestamp fields already returned by the server |
| tests/monitor/preflight-dashboard-browser.test.ts | Modify | Focused browser regression scenarios |
| docs/MONITOR_GUIDE.md | Modify | Document displayed evidence and existing recovery controls |

## Scope Boundaries
No server/store/worker changes, polling redesign, approval writes, automatic
reconciliation, new dependencies or changes to fresh-retry semantics. Final
field mapping and amended packet must pass independent review before dispatch.

## Success Criteria
- [ ] A source-backed mapping identifies which attempt timestamps/error fields are available and which cannot be displayed; no fabricated duration or state.
- [ ] Current attempt identity, available timing and diagnostic reason are readable for all five states, with missing evidence explicitly unknown.
- [ ] Network errors label retained information as last-known; switching project/task never shows another task's error or attempt as current.
- [ ] Existing fresh retry, captured-attempt toast, coalescing and reconciliation protections remain intact.

## Testing Requirements
- [ ] Extend isolated browser fixtures for timestamps, errors, missing data and project/task changes; no live jobs.
- [ ] Run npm run build and npx jest tests/monitor/preflight-dashboard-browser.test.ts --runInBand.
- [ ] Directly lint the changed TSX/test files and retain existing retry/reconcile browser controls.

## Context References
- docs/SELF_DEVELOPMENT_TRACKER.md
- frontend/src/pages/TaskDetailPage.tsx
- frontend/src/api/contracts.ts
- tests/monitor/preflight-dashboard-browser.test.ts

## Decided Facts
- This changes display only; existing server-side recovery and approval authority remain intact.
