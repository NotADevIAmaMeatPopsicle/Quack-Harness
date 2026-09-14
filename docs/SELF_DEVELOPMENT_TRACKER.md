# Quack Harness public self-development

## Authority and current checkpoint

The maintainer authorized supervised self-development of the public project on
2026-09-14. This tracker continues the broader feature/stability objective; it
does not erase earlier accepted work or claim that the roadmap is complete.

Public baseline: db66383e. Bootstrap branch:
codex/TASK-1400-public-self-development. Project ID: quack-harness.
The public repository had no adapter or task backlog at kickoff. TASK-1400 is
operator setup (this adapter, conventions, tracker and initial task packets),
not a completed worker implementation. Runtime registration and the first
dispatch are pending until recorded below.

Use one implementation lane for the pilot. The operator owns task preparation,
review decisions and Git integration. Workers use isolated worktrees, do not
change the running harness, and do not push/merge/deploy. Brief and diff review
are independent of the builder. Any software approval is recorded as the
operator agent's decision, not as a personal review by the maintainer.

## Defined first tasks

| Task | Outcome | State / dispatch condition |
| --- | --- | --- |
| TASK-1401 | Actionable read-only review/merge-readiness detail panel | READY specification; must pass prep and independent brief review before implementation |
| TASK-1402 | Clear current preflight attempt timing, diagnostics and recovery presentation | BACKLOG; source revalidation, spec review and task-specific verification required |
| TASK-1403 | Reconcile and define remaining approval identity UI clauses | BACKLOG; analysis/spec task only; no approval-authority changes |

READY is not proof of passing prep. Canonical job/review records and accepted
Git history win over task-file status. Never dispatch the whole roadmap at once.

## Remaining roadmap and execution boundary

| Area | Remaining work | Lane |
| --- | --- | --- |
| Admission/approval provenance | Record actual admitting evidence and propagate it into approvals; retain existing TASK-1364 work rather than duplicate it | Directly supervised prerequisite |
| Approval writer and UI | Map current/stale/unknown identity; TASK-1403 defines the remaining small implementation packets | TASK-1403 then reviewed children |
| Cross-host starts | Explicit authority configuration and supported live proof; code already exists | Operator setup/proof; pilot uses co-located headnode execution |
| Worker logging configuration | Automatic host-local adapter propagation, beyond accepted native-path/Docker-binding support | Authority design before worker dispatch |
| Preflight experience | TASK-1402 presentation plus retained-report observability gaps | Bounded UI first; store/recovery changes supervised |
| Lane selection | Judgment tie-breaker for ambiguous deterministic routing | Define decision contract and failure controls first |
| Recommendations to tasks | Grounded, deduplicated finding-to-task workflow | Re-scope existing TASK-101 requirements |
| Generated artifacts | Registry and supported creation/retrieval lifecycle | Re-scope existing TASK-099 requirements |
| Structured debrief | Persisted post-run analysis linked to feedback/revision | Re-scope existing TASK-095 requirements |
| Merge-readiness panel | TASK-1401 first read-only implementation | Pilot worker |
| Echo/status parity | Map integration ownership and authoritative state differences | Boundary audit before cross-repo implementation |
| Live task board | Audit Phase 4 coverage and distinguish execution, verification and gate states | Inventory then bounded UI packets |
| Operating proof | Paused-job resume/reclaim gaps, Windows process identity, crash ownership and supported Docker/cache cases | Focused supervised regressions |
| Docs event path validation | Validate the separately identified unchecked job-event filename path with isolated fixtures | Security validation; no live exploit probe |

The roadmap rows are not equal-size tasks or a reliable percentage denominator.
Do not mark an area complete when only one of its children is accepted.

## Verification and progress reporting

For each dispatch, record task ID, exact base/source commit, job/session identity,
prep verdict, independent review verdict, focused test results, blocked criteria,
and next action. Full-suite runs need an affected-contract reason; use the
task's focused suites and appropriate build instead of repeating unrelated tests.
GitHub CI does not block this loop. Public packaging must remain intact.

The initial adapter is scoped to the Reviews pilot. It requires full build,
existing review API tests, changed-TypeScript lint, the TASK-1401 real-browser
suite and direct page TSX lint. Configure appropriate required
commands before dispatching another feature area. No automatic main merge.

## Session log

### 2026-09-14: public admin kickoff

Created an isolated bootstrap branch, a public-only self-development adapter,
three task packets and the roadmap above. No feature is claimed implemented.
The operator will record registration, prep and dispatch results after readback.
