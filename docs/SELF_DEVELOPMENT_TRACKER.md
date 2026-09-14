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
dispatch are recorded below. Registration is complete; no worker implementation
has started or been accepted at this checkpoint.

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

- Bootstrap is published on public main at 82c677cf. Adapter/schema validation
  succeeds and all three task packets parse with nonempty file maps and zero warnings.
- The canonical headnode now registers quack-harness as a separate project.
  Its accepted running code is unchanged. Other project execution holds remain intact.
- Clean public install, full Linux build, TSX lint and a Chromium startup probe
  pass on Node 20.20.2. Both existing review API suites pass: 42 tests in 17.534s.
  These are baseline checks, not evidence that the new panel exists.
- TASK-1401 first preflight 39a8e495-79ab-4e63-b0b4-68948c999726 completed with
  depth 4.6 and eight spec ambiguities. A fresh independent Codex spec review
  returned AMEND, session 01a0a16c-72c0-7e63-a7e8-83c376f3de9e. Its four
  findings and the prep feedback are dispositioned in the amended task packet.
  Passing prep on the amended content remains required before dispatch.
- Transport setup found that the stock listener sends no local dashboard
  credential. An isolated real-middleware probe returns 401 for that request
  shape and 200 for the scoped authenticated control, with zero real dispatches.
  The operator is tracking the defect separately. Preserve dashboard auth;
  an authenticated worker-internal start with real assigned federation markers
  is the bounded pilot workaround, with normal leases and evidence reporting.
- The headnode's Codex reviewer is not logged in. Reviewer provisioning choice
  is pending from the maintainer. The independent spec review above ran on the
  laptop's existing provider without credential transfer. Do not disable the
  cross-model gates or claim a worker started while this prerequisite is unresolved.
