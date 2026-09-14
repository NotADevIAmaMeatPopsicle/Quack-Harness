# TASK-1401: Show actionable review and merge readiness in the dashboard

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** M
- **Status:** VERIFIED
- **Target Branch:** main
- **Execution Mode:** loop
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [frontend, reviews, accessibility]

## Problem Statement
An operator can see a review verdict in the Reviews table but must read raw JSON
to learn why it is blocked, which documentation actions remain, and whether its
code verdict permits integration. A documentation-ready FAILED review must never
look safe to merge. Build a read-only, useful detail panel from existing evidence.

## Current State
At public baseline db66383e, frontend/src/pages/ReviewsPage.tsx fetches listReviews
and getReview but displays the selected bundle only with JSON.stringify. Table
rows are mouse-only and a missing mergeReady value is displayed as No.
frontend/src/api/contracts.ts intentionally represents detail as Record<string,
unknown>. src/review/docs-gate.ts defines PersistedReviewBundle, including verdict,
findings, wikiArtifacts and gate { mergeReady, requiredWikiActions,
missingWikiActions, issues }. The verdict is independent from gate.mergeReady.
src/monitor/routes/workflows.ts serves the persisted bundle. Do not change these
server authorities or infer that a record causes a merge.

## Recommended Approach
Read the producer and current page. Introduce a small defensive presentation
helper under frontend/src/lib/review-readiness.ts. Treat the detail response as untrusted
shape: check object/string/boolean/array types and filter malformed array members.
Render a selected task/review heading, code verdict, documentation gate, combined
readiness summary, blocking reasons, finding statuses, required/missing document
actions and artifact path/commit text. Keep raw JSON in a collapsed details element.
Use a keyboard-accessible button to select each row. Preserve loading/error/empty
states. A new selection or failed detail request must not present another bundle's
readiness as current. Refresh selected details along with the list, using existing
query behavior as specified below; avoid new global polling or project-selection behavior.

## Implementation Blueprint

1. Export `presentReviewReadiness(value: unknown): ReviewReadinessView` from
   frontend/src/lib/review-readiness.ts. `ReviewReadinessView` is a named exported
   TypeScript interface with `readiness: "ready" | "not-ready" | "unknown" |
   "incomplete"`, `verdict: string`, `documentation: "ready" | "not-ready" |
   "unknown"`, `evidenceProblems: string[]`, and typed presentation collections
   for issues/findings/actions/artifacts. Do not import server runtime modules
   into the browser. Internal collection type names are implementation choices.
2. ReviewsPage calls the helper only on a successfully retrieved detail whose
   response `reviewId` and nested `review.reviewId` match selectedReviewId.
   Keep the panel inline; a separate component/props contract is unnecessary.
3. Rename the list column to **Documentation gate**: true displays **Ready**,
   false displays **Not confirmed**, absent/invalid displays **Unknown**.
   The list producer collapses missing gate flags into false; do not pretend
   the list distinguishes a missing gate from a negative one. Its existing
   separate Verdict column stays. Never label the list's flag as merge approval.
4. The labelled detail region contains a task/review heading, a short readiness
   summary, and subsections **Code verification**, **Documentation gate**,
   **Blocking issues**, **Other issues**, **Findings**, **Documentation actions**,
   **Artifacts**, and collapsed **Raw review JSON**. Use existing card/table,
   error/muted text classes and plain lists; no new visual framework.
5. Combined summary text is **Ready for operator review**, **Not ready**,
   **Unknown**, or **Incomplete evidence**. Positive readiness requires explicit
   VERIFIED plus explicit gate.mergeReady true and no malformed/contradictory
   required evidence. It is not a merge action or permission. A valid false
   gate stays negative even with no blocking issues: judgment can legitimately
   block without adding an issue. Do not recompute its decision from issue counts.
6. List query keeps its existing 10-second refresh. Detail query uses its own
   `refetchInterval: 10000`, enabled only with a selected ID, preserving the
   existing `["review", selectedReviewId]` key and other queries' defaults. On a
   successful list response which removes the selected ID, select the first
   remaining ID or clear selection if empty. Do not clear on a list error.
   Detail initial loading, background refetch and any detail error take display
   precedence over cached readiness: show **Loading review details…** while
   fetching or **Unable to refresh review details** on failure, without a
   current positive readiness banner. Override the App's five-second default
   freshness window for the detail query with `staleTime: 0` and
   `refetchOnMount: "always"`, or implement an equivalent explicit selection
   generation/fresh-response guard. A cached A -> B -> A reselection must fetch
   A again even within five seconds, and cannot show A's cached positive banner
   while that response is pending. Keep the list/global freshness policy intact.
   Cached success on reselection or later
   error must not masquerade as fresh. Use no new global timer or effect loop.
7. Select with a `<button type="button">` labelled `Select review <reviewId>`
   and `aria-pressed` state. Native Tab, Enter and Space operate it; no custom
   arrow-key grid is required. Retain a visible focus outline. Label the detail
   section using its heading; loading is role=status and error is role=alert.
   Raw JSON uses closed-by-default `<details><summary>Raw review JSON</summary>`
   with the existing stream/pre-wrap `<pre>` styling; all data is React text.
8. Add a **Reviews: readiness and blockers** section to docs/MONITOR_GUIDE.md
   explaining code versus documentation readiness, list uncertainty, all four
   summary states, refresh/error behavior, keyboard selection, artifact text
   and raw disclosure. State that this page cannot approve or merge changes.

## Exact Data Contract and Defensive Rules

Use GET /v1/reviews/:id's `{ ok: true, reviewId, reviewPath?, review }` shape.
`ok` proves retrieval, not verification. Do not read the separate task-summary
API's `reviewGate`, `closeoutState` or `docsPipeline` shapes here.

- `review.taskId`, `review.reviewId`, `review.verdict`: strings; verdict is
  VERIFIED, PARTIAL or FAILED. Invalid/missing identity or verdict is incomplete.
- `review.gate.mergeReady`: boolean; missing/wrong type is unknown, never truthy
  coercion. `gate.requiredWikiActions` and `gate.missingWikiActions` are string
  arrays. `gate.issues` is an array of `{ code: string, message: string,
  blocking: boolean, field?: string, blockReasonCode?: string }`.
- `review.findings` is optional; members have `{ title: string,
  severity: "P1" | "P2" | "P3", status?: "open" | "resolved" | "waived",
  file?: string }`. Omitted finding status means open, matching the producer.
- `review.wikiArtifacts` is optional; members have `pagePath: string`,
  `commitSha: string`, `linkedTaskIds: string[]`, and optional `action: string`.
  Render path/commit as text. Retain valid partial path/commit text and mark
  incomplete artifact evidence rather than silently discarding it.
- A well-formed empty array means **None recorded** (for issues/findings/artifacts)
  or **None required** / **None missing** (for actions). Omitted optional findings
  or wikiArtifacts are valid absence and display **None recorded**. Required
  gate arrays absent or wrong-shaped arrays/members produce **Incomplete
  evidence**, suppress combined Ready, and retain usable text. In particular,
  a nonboolean issue.blocking is not a nonblocking issue. Unknown status/severity
  values also show incomplete rather than silently mapping to a safe value.
- Contradictory gate.mergeReady true plus a blocking issue, missing required
  action, or open P1 finding is **Incomplete evidence**. Keep the recorded gate
  and verdict visible separately; do not mutate or claim to repair server data.
- Optional summary/reviewNotes/reviewer fields may be shown as text when strings.
  Their absence does not block readiness. No score is invented.

## Files to Modify
| File | Action | Description |
| --- | --- | --- |
| frontend/src/pages/ReviewsPage.tsx | Modify | Accessible review selection and structured detail display |
| frontend/src/lib/review-readiness.ts | Create | Defensive presentation helper and named view interface; no server gate mutation |
| tests/monitor/reviews-dashboard-browser.test.ts | Create | New isolated Chromium regression coverage of built UI |
| docs/MONITOR_GUIDE.md | Modify | Explain the panel and distinction between code/documentation readiness |

## Scope Boundaries
Only the four listed files are allowed. No new endpoint, merge/approval action,
backend mutation, new dependency, packaging change, authentication change, global
project-routing change, gate-policy modification or live runtime restart.
Reuse existing styling; do not redesign the site. Render artifact paths as text,
not arbitrary clickable URLs. Never use dangerouslySetInnerHTML.

## Success Criteria
- [ ] A selected well-formed bundle exposes its task/review identity, verdict, documentation state, blockers/findings and required/missing actions without opening raw JSON.
- [ ] Combined readiness is positive only for an explicit VERIFIED verdict and explicit gate.mergeReady true. A FAILED/PARTIAL verdict stays non-ready even when documentation is ready. Missing/invalid values show Unknown or Incomplete evidence, never Ready.
- [ ] Blocking gate issues are distinguished from nonblocking issues; finding status and available artifact path/commit text remain visible. Empty arrays have useful empty states without invented success.
- [ ] Keyboard-only selection works. Switching reviews, loading, empty lists and detail request errors cannot display another review's readiness as current.
- [ ] Raw payload remains available in a collapsed diagnostic disclosure; text containing markup is inert. Malformed optional shapes do not crash the page.
- [ ] A real browser regression suite covers ready, docs-blocked, failed-but-docs-ready, missing/malformed evidence, keyboard selection and a failed detail fetch. Existing review API regression suites and the full build pass.
- [ ] The table labels its flag Documentation gate, never combined merge readiness; FAILED and PARTIAL rows with ready docs cannot imply a positive combined outcome. Missing list evidence remains conservative.
- [ ] Detail refresh covers cached reselection, delayed A-to-B responses, success-to-refresh-error, a successful empty-list transition and changing details while list summaries stay identical; no stale Ready banner remains during fetching/error. Keyboard checks cover Tab, Enter, Space, pressed state and the diagnostic disclosure.

## Testing Requirements
- [ ] Cached reselection is a distinct regression: load ready A, select B, change A's fixture to blocked, then select A again within five seconds while delaying its new response. Assert a new A request occurs, cached Ready stays hidden while it is pending, and the final blocked state appears. Separately change the selected bundle while returning byte-identical list summaries and prove its own detail refresh updates the panel.
- [ ] Follow tests/monitor/preflight-dashboard-browser.test.ts for disposable fixture/server/browser lifecycle, but never invoke real workers or paid providers. Ensure server and browser close after failures.
- [ ] Run npm run build before npx jest tests/monitor/reviews-dashboard-browser.test.ts --runInBand. Assert rendered text and interaction, not source-code strings. Use actual persisted bundle shapes; fixture HTTP responses are acceptable for deterministic malformed/error cases.
- [ ] Run npx jest tests/monitor/reviews-v1-api.test.ts tests/monitor/review-docs-ui-api.test.ts --runInBand to preserve the API contract.
- [ ] Run npx eslint frontend/src/pages/ReviewsPage.tsx tests/monitor/reviews-dashboard-browser.test.ts and include frontend/src/lib/review-readiness.ts if created. Root typecheck is part of npm run build; frontend typecheck runs in its build.

## Context References
- AGENTS.md
- docs/conventions/self-development.md
- src/review/docs-gate.ts
- src/monitor/routes/workflows.ts
- frontend/src/api/contracts.ts
- frontend/src/pages/ReviewsPage.tsx
- tests/monitor/preflight-dashboard-browser.test.ts

## Decided Facts
- This is a read-only UI pilot for the public quack-harness project.
- gate.mergeReady alone does not prove code verification or authorize a merge.
- Operator handles independent review, accepted Git integration and live deployment.

## Mandated Checks
- npm run build
- npx jest tests/monitor/reviews-dashboard-browser.test.ts --runInBand
- npx jest tests/monitor/reviews-v1-api.test.ts tests/monitor/review-docs-ui-api.test.ts --runInBand

## Spec Review and Findings Disposition

2026-09-14, base 82c677cf: first preflight job
39a8e495-79ab-4e63-b0b4-68948c999726 completed with depth 4.6 (rejected), plus
eight spec ambiguities. No worker was started. A fresh native Codex read-only
review also returned AMEND, session 01a0a16c-72c0-7e63-a7e8-83c376f3de9e
(Codex gpt-6-astra via the laptop's existing Azure provider). Raw review is
retained in operator evidence; no credentials were transferred.

- Native P1 list semantics: accepted. The list flag is relabelled and the
  exact producer's false/missing collapse is documented; FAILED/PARTIAL controls added.
- Native P1 malformed evidence: accepted. Valid omissions, damaged arrays,
  nonboolean blocking, partial artifacts, omitted finding status and judgment
  false-with-empty-issues behavior are explicit above.
- Native P1 refresh/selection: accepted. Own 10-second detail query, fetch/error
  precedence, successful-list reconciliation and five race/cache cases are required.
- Native P2 accessibility: accepted. Named native buttons, pressed state, focus,
  labelled region, announcements and keyboard disclosure are testable requirements.
- Depth helper/props specificity: calibrated. The helper export/view interface is
  named; the panel stays inline, so an extra component/props API is unnecessary.
- Depth documentation/refetch criteria: accepted with the named documentation
  section, required content and exact detail-query refresh contract.
- Depth grep-based conformance: rejected as a substitute for behavioral tests.
  Observable labels and export names are specified, but browser assertions and
  API regressions remain the acceptance evidence.
- Preflight ambiguities 1/2/3 (layout/summary/grouping): accepted through the
  subsection order, exact summary labels and textual empty-state rules.
- Preflight ambiguities 4/8 (data interfaces): accepted through the producer-backed
  field map, typed view boundary and defensive rules.
- Preflight ambiguities 5/6 (keyboard/transitions/disclosure): accepted through
  native button semantics, fetch/error precedence and details/summary design.
- Preflight ambiguity 7 (API suite mapping): clarified. The existing API suites
  are exactly reviews-v1-api.test.ts and review-docs-ui-api.test.ts named in the
  mandated command. No unrelated suite is implied.

The second preflight passed depth at 4.9. A real headnode Codex brief review
(azure / gpt-5.6-terra, session 01a0a17c-c93b-7130-b280-9b4539d81eb4) then
returned FIX_FIRST for one material generated-blueprint defect: adding only an
interval plus isFetching guards does not invalidate cached reselection during
the App's default freshness window. Accepted: section 6 now requires an explicit
freshness override or equivalent response-generation guard; the testing section
defines the distinct within-five-seconds A -> B -> A case. No implementation
started on the rejected brief. Re-run prep and independent brief review on this
amended packet. Changes remain inside the original four-file UI scope.
