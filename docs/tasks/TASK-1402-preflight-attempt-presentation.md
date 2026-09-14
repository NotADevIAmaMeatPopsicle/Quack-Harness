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
FullPreflightJob contract before finalizing implementation; missing data must
stay unknown. This packet is not READY until that mapping and review are recorded.

## Recommended Approach
Map the real response fields and current state rendering. Add compact textual
attempt details using only returned timestamps and errors. Distinguish queued,
running, failed, completed and recovery-required states; preserve last-known
status labeling on network errors. Link fresh-retry/reconcile guidance to the
existing controls without adding requests or weakening confirmation/fencing.

## Files to Modify
| File | Change |
| --- | --- |
| frontend/src/pages/TaskDetailPage.tsx | Attempt detail and diagnostic presentation |
| tests/monitor/preflight-dashboard-browser.test.ts | Focused browser regression scenarios |
| docs/MONITOR_GUIDE.md | Document displayed evidence and existing recovery controls |

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
