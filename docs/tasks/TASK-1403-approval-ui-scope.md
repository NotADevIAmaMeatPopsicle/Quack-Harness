# TASK-1403: Define the remaining approval identity and UI work

## Metadata
- **Priority:** P1-HIGH
- **Effort:** M
- **Status:** BACKLOG
- **Target Branch:** main
- **Execution Mode:** loop
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [analysis, documentation, approvals]

## Problem Statement
Existing approval/review functionality has accepted identity safeguards, but the
remaining blueprint-writer and current/stale/unknown UI requirements are not yet
separated into safe public implementation packets. Reconcile coverage before
duplicating or weakening an authority mechanism.

## Current State
The public source contains review/loop-gate.ts, monitor approval endpoints and
task detail UI. TASK-1364's actual admission-evidence work remains directly
supervised outside this pilot. This task defines remaining UI/writer contracts;
it does not implement authority changes or mark TASK-1364 complete.

## Recommended Approach
Trace the current blueprint and judge approval producers, identity checks and UI
consumers. Produce a table of existing behavior, regression evidence, missing
clauses and dependencies. Draft small implementation packets only for confirmed
gaps. Any proposal that writes approval/admission authority is explicitly held
for direct operator review; read-only UI work can be separately dispatched.

## Files to Modify
| File | Action | Description |
| --- | --- | --- |
| docs/APPROVAL_COMPLETION_PLAN.md | Create | Source-backed coverage and gap matrix |
| docs/tasks/TASK-1403-approval-ui-scope.md | Modify | Record evidence and proposed child boundaries |
| docs/SELF_DEVELOPMENT_TRACKER.md | Modify | Link reviewed coverage and the next bounded packets |

## Scope Boundaries
Documentation and read-only analysis only. No runtime, tests, adapter, secrets,
live approvals or task-status writes. Do not invent child task IDs without
checking the public inventory and operator allocation.

## Success Criteria
- [ ] Matrix names current producers, persisted identity fields, validation/fencing points and frontend consumers with file/function references.
- [ ] Each remaining clause is classified as implemented with evidence, missing, or requiring operating proof; historical backlog labels alone are not evidence.
- [ ] Proposed UI packets distinguish current, stale and unknown approvals without treating unknown as approved; writer packets retain immutable artifact identity.
- [ ] Dependencies on actual admission provenance are explicit; no duplicate implementation is assigned for existing TASK-1364 work.

## Testing Requirements
- [ ] Independently review every cited path/function against the selected source commit.
- [ ] Use existing regression evidence or identify exact missing tests; do not run unrelated full suites for this documentation task.
- [ ] Ensure no file outside the three allowed documentation paths changes.

## Context References
- docs/SELF_DEVELOPMENT_TRACKER.md
- src/review/loop-gate.ts
- src/monitor/server.ts
- frontend/src/pages/TaskDetailPage.tsx

## Decided Facts
- The operator must accept this scope audit before any approval-writer implementation is dispatched.
