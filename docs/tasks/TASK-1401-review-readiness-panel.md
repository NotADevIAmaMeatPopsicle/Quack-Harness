# TASK-1401: Show actionable review and merge readiness in the dashboard

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** M
- **Status:** READY
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
helper under frontend/src/lib if needed. Treat the detail response as untrusted
shape: check object/string/boolean/array types and filter malformed array members.
Render a selected task/review heading, code verdict, documentation gate, combined
readiness summary, blocking reasons, finding statuses, required/missing document
actions and artifact path/commit text. Keep raw JSON in a collapsed details element.
Use a keyboard-accessible button to select each row. Preserve loading/error/empty
states. A new selection or failed detail request must not present another bundle's
readiness as current. Refresh selected details along with the list, using existing
query behavior; avoid new global polling or project-selection behavior.

## Files to Modify
| File | Change |
| --- | --- |
| frontend/src/pages/ReviewsPage.tsx | Accessible review selection and structured detail display |
| frontend/src/lib/review-readiness.ts | Optional defensive presentation helper; no server gate logic |
| tests/monitor/reviews-dashboard-browser.test.ts | New isolated Chromium regression coverage of built UI |
| docs/MONITOR_GUIDE.md | Explain the panel and distinction between code/documentation readiness |

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

## Testing Requirements
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
