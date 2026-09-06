// ─── Intent-cutover inventory (TASK-1316, decision D1) ──────────────
// A SEPARATE completeness claim from `STAGE_INJECTION_EXCLUSIONS`
// (TASK-1313), which proves where producer SIGNALS are injected. This
// one proves which judgment stages read INTENT, and — for the single
// excluded stage — why that exclusion is a design decision rather than
// an oversight. Overloading one list with two claims would let a future
// change satisfy one and silently break the other (round-1 F9).

import { JUDGMENT_STAGES, type JudgmentStage } from "./judgment-types.js";

/**
 * Stages that read task intent through `orchestrateJudgment`.
 *
 * docs_review shipped in TASK-1311, readiness in TASK-1315, and the
 * three loop/judge stages in TASK-1316.
 */
export const INTENT_CUTOVER_TARGETS = [
  "docs_review",
  "readiness",
  "loop_brief",
  "loop_diff",
  "judge",
] as const satisfies readonly JudgmentStage[];

export interface IntentCutoverExclusion {
  stage: JudgmentStage;
  rationale: string;
}

/**
 * Stages deliberately NOT given an intent cutover.
 *
 * post_judge is where DETERMINISTIC verification speaks — build, test,
 * and lint results, with authority over the semantic layer by design
 * (`post-judge-verifier.ts` authority inversion). An intent candidate
 * there could only be theater in shadow or a hazard in enforce, and the
 * stage sits AFTER the judge seam TASK-1316 already covers, so nothing
 * goes unreviewed by excluding it.
 *
 * Note on the rationale's history: the exclusion was originally argued
 * from a "never auto-merge on needsReview" rule that does NOT exist as
 * stated (`needsReview` preserves an APPROVE and auto-merge stays
 * enabled). The exclusion stands; the false premise does not.
 */
export const INTENT_CUTOVER_EXCLUSIONS: readonly IntentCutoverExclusion[] = [
  {
    stage: "post_judge",
    rationale:
      "Deterministic build/test/lint authority is exactly what must not be judged away; the judge seam upstream is already covered.",
  },
] as const;

export interface IntentCutoverCallSiteExclusion {
  site: string;
  rationale: string;
}

/**
 * Call sites of an INCLUDED stage that are still deliberately unwired.
 *
 * The `judge` stage is a cutover target and is wired at the initial and
 * retry judge seams. The decomposition integration judge is a third
 * `runJudge` call whose non-APPROVE handling abandons the branch and
 * ends the run as `rejected` — terminal, not the recoverable retry the
 * hold-or-demote mapping assumes — so applying the cutover there would
 * turn a demotion into an escalation.
 */
export const INTENT_CUTOVER_CALL_SITE_EXCLUSIONS: readonly IntentCutoverCallSiteExclusion[] = [
  {
    site: "dispatcher:integration-judge",
    rationale:
      "A non-APPROVE verdict at this site is terminal (branch abandoned, run rejected), so a hold-or-demote mapping would escalate rather than demote.",
  },
] as const;

/**
 * Every judgment stage is accounted for: covered by the cutover, or
 * excluded with a recorded rationale. Exported (rather than asserted
 * only in tests) so the claim travels with the data.
 */
export function intentCutoverCoverageIsComplete(): boolean {
  const covered = new Set<JudgmentStage>([
    ...INTENT_CUTOVER_TARGETS,
    ...INTENT_CUTOVER_EXCLUSIONS.map((exclusion) => exclusion.stage),
  ]);
  return (
    covered.size === JUDGMENT_STAGES.length && JUDGMENT_STAGES.every((stage) => covered.has(stage))
  );
}
