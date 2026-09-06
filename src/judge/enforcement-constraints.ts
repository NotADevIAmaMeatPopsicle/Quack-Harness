// ─── Judge Enforcement Verdict Constraints (TASK-1200) ─────────────
// Makes the verdict derivation honor the enforcement contract the judge
// prompt already states (judge-prompt.ts:217,358): a criterion that is
// not deterministically enforced in code cannot keep a PASS, and a run
// containing such a criterion cannot keep an APPROVE.
//
// Rule A (enforcement-type cap): a criterion with status PASS and
//   enforcement_type "llm_instruction_only" or "not_implemented" is
//   demoted to PARTIAL. This is internal consistency of the judge's own
//   claims: "enforced only by prompt text" or "no enforcement found"
//   contradicts PASS.
//
// Rule B (compliance cross-check): a PASS criterion whose matching
//   flag-severity pre-judge compliance checks ALL found no code evidence
//   is demoted to PARTIAL, regardless of the claimed enforcement_type
//   (the dishonest-tag case). Matching is best-single-match with
//   fail-open on ambiguity: an evaluation entry matches at most one
//   compliance group, and an ambiguous tie never demotes.
//
// Demotions are recoverable by design: APPROVE downgrades to REVISE
// (never REJECT) so the existing retry loop carries the demotion
// reasoning back to the builder. Always-on (no adapter flag); see the
// TASK-1200 spec for the rationale and the Codex review disposition.

import type {
  ComplianceCheckResult,
  CriterionEvaluation,
  EnforcementDemotion,
  JudgeResult,
} from "../core/types.js";

/** Prefix added to feedback when an APPROVE is downgraded to REVISE. */
export const ENFORCEMENT_OVERRIDE_PREFIX = "[ENFORCEMENT OVERRIDE]";

/** Containment matching requires the shorter side to be at least this long. */
const MIN_CONTAINMENT_LENGTH = 12;

/** Jaccard token-overlap threshold for the paraphrase/truncation strategy. */
const TOKEN_OVERLAP_THRESHOLD = 0.6;

/** Tokens shorter than this are ignored by the overlap strategy. */
const MIN_TOKEN_LENGTH = 3;

interface ComplianceGroup {
  normalized: string;
  tokens: Set<string>;
  results: ComplianceCheckResult[];
  /** TASK-1320: present only when every result in the group carried the
   *  same index. Absent for legacy/mixed payloads, which then use text
   *  grouping exactly as before (round-1 R1-6). */
  criterionIndex?: number;
}

interface GroupMatch {
  group: ComplianceGroup;
  /** 3 = exact normalized equality, 2 = containment, 1 = token overlap */
  rank: number;
  /** Tie-break within a rank (containment: shorter length; overlap: Jaccard) */
  score: number;
}

/**
 * Apply the enforcement verdict constraints to a parsed judge result.
 * Pure: never mutates the input; returns the same object when nothing
 * applies (legacy results without criteriaEvaluation, or no demotions).
 * Idempotent: demoted entries are no longer PASS, so re-application is
 * a no-op.
 */
export function applyEnforcementConstraints(
  result: JudgeResult,
  complianceChecks?: ComplianceCheckResult[],
  /** TASK-1320: the spec's ordered criteria, used ONLY to corroborate a
   *  judge-supplied index against the text at that position. Optional:
   *  without it no index can be corroborated and every evaluation takes
   *  the unchanged text path, which is exactly the pre-1320 behavior. */
  successCriteria?: readonly string[],
): JudgeResult {
  const evaluations = result.criteriaEvaluation;
  if (!evaluations || evaluations.length === 0) {
    return result;
  }

  const groups = groupComplianceByCriterion(complianceChecks ?? []);
  const demotions: EnforcementDemotion[] = [];

  const constrainedEvaluations = evaluations.map((evaluation) => {
    if (evaluation.status !== "PASS") {
      return evaluation;
    }

    // Rule A: enforcement-type cap.
    if (
      evaluation.enforcement_type === "llm_instruction_only" ||
      evaluation.enforcement_type === "not_implemented"
    ) {
      const detail =
        `enforcement_type "${evaluation.enforcement_type}" cannot keep PASS ` +
        `(the judge prompt contract says instruction-only or absent enforcement is at best PARTIAL)`;
      demotions.push({
        criterion: evaluation.criterion,
        rule: evaluation.enforcement_type,
        from: "PASS",
        to: "PARTIAL",
        detail,
      });
      return demoteEvaluation(evaluation, detail);
    }

    // Rule B: compliance cross-check (fires even under a deterministic_code claim).
    //
    // TASK-1320: resolve by INDEX first when the judge supplied one that
    // survives corroboration, otherwise fall back to the text strategies
    // byte-for-byte as before.
    const resolved = resolveGroup(evaluation, groups, successCriteria);
    if (resolved.kind === "no_group_for_index") {
      // Round-1 R1-4: a corroborated index whose criterion produced NO
      // compliance results. Falling back to text here could select a
      // DIFFERENT criterion's failing group and demote the wrong thing,
      // so this is the one case that neither demotes nor falls back.
      return evaluation;
    }
    const match = resolved.match;
    if (match) {
      const flagResults = match.group.results.filter((r) => r.severity === "flag");
      if (flagResults.length > 0 && flagResults.every((r) => !r.found)) {
        const patterns = [...new Set(flagResults.map((r) => r.description))].join("; ");
        const detail = `no code evidence found by flag-severity compliance check(s): ${patterns}`;
        demotions.push({
          criterion: evaluation.criterion,
          rule: "compliance_conflict",
          from: "PASS",
          to: "PARTIAL",
          detail,
        });
        return demoteEvaluation(evaluation, detail);
      }
    }

    return evaluation;
  });

  if (demotions.length === 0) {
    return result;
  }

  const criteriaGaps = [...result.criteriaGaps];
  for (const demotion of demotions) {
    if (!criteriaGaps.includes(demotion.criterion)) {
      criteriaGaps.push(demotion.criterion);
    }
  }

  const downgraded = result.verdict === "APPROVE";
  const summary = demotions.map((d) => `${d.rule}: "${d.criterion}"`).join("; ");

  return {
    ...result,
    verdict: downgraded ? "REVISE" : result.verdict,
    feedback: downgraded
      ? `${ENFORCEMENT_OVERRIDE_PREFIX} ${demotions.length} criterion(s) demoted PASS->PARTIAL ` +
        `(${summary}). Original verdict APPROVE downgraded to REVISE. ${result.feedback}`
      : result.feedback,
    criteriaEvaluation: constrainedEvaluations,
    criteriaGaps,
    enforcementDemotions: [...(result.enforcementDemotions ?? []), ...demotions],
  };
}

function demoteEvaluation(evaluation: CriterionEvaluation, detail: string): CriterionEvaluation {
  return {
    ...evaluation,
    status: "PARTIAL",
    reasoning: `${evaluation.reasoning} [enforcement demotion: ${detail}]`,
  };
}

// ─── Rule B matching ────────────────────────────────────────────────
// Compliance results are generated per success criterion, so grouping by
// the exact criterion string reconstructs the per-criterion groups. The
// judge's echo of a criterion may differ (case, markers, truncation,
// light rewording), so matching runs three strategies in rank order and
// picks the single best group; ambiguous ties never demote.

interface ComplianceGrouping {
  /** Text-keyed, exactly as before 1320. The legacy fallback uses this
   *  and only this, so index-free input is untouched. */
  text: ComplianceGroup[];
  /**
   * Index-keyed, built only from results that carry an index.
   *
   * ROUND-2 R2-2: this MUST be keyed on the index and not the criterion
   * text. The first build grouped everything by text, so two DUPLICATE
   * criteria collapsed into one group whose members disagreed about
   * their index; the group then forfeited its index and both
   * evaluations resolved to `no_group_for_index`, so neither was
   * demoted despite uniformly failing evidence. Round 1 had explicitly
   * required duplicate-criterion coverage and I did not write it, which
   * is how a regression walked straight past a criterion written to
   * catch it.
   */
  byIndex: Map<number, ComplianceGroup>;
}

function groupComplianceByCriterion(checks: ComplianceCheckResult[]): ComplianceGrouping {
  const byCriterion = new Map<string, ComplianceGroup>();
  const byIndex = new Map<number, ComplianceGroup>();
  // ROUND-2b: index-free rows are held aside and folded into any index
  // group they belong to. See the merge below for why.
  const indexFree: ComplianceCheckResult[] = [];

  for (const check of checks) {
    const existing = byCriterion.get(check.criterion);
    if (existing) {
      existing.results.push(check);
    } else {
      const normalized = normalizeCriterionText(check.criterion);
      byCriterion.set(check.criterion, {
        normalized,
        tokens: tokenizeCriterion(normalized),
        results: [check],
      });
    }

    if (typeof check.criterionIndex === "number") {
      const indexed = byIndex.get(check.criterionIndex);
      if (indexed) {
        indexed.results.push(check);
      } else {
        const normalized = normalizeCriterionText(check.criterion);
        byIndex.set(check.criterionIndex, {
          normalized,
          tokens: tokenizeCriterion(normalized),
          results: [check],
          criterionIndex: check.criterionIndex,
        });
      }
    } else {
      indexFree.push(check);
    }
  }

  // ROUND-2b: fold index-free rows into the index group for the SAME
  // criterion.
  //
  // Without this, splitting the views silently DISCARDED contradictory
  // evidence. Given `[failing(C, 0), passing(C)]` the index group held
  // only the failing row, and Rule B demotes when every flag check in
  // the group failed, so it demoted on a criterion whose other check
  // passed. That is a FALSE demotion, and it is the failure direction
  // this whole task exists to prevent, reintroduced by the fix for R2-2.
  //
  // Worse, my rewritten R1-6 test used two FAILING rows, so it could not
  // see this. The confirmation round caught the test hiding the
  // regression, not just the regression.
  //
  // Matched on normalized text because that is what the group already
  // carries, and because being slightly broad here means INCLUDING
  // evidence rather than missing it, which is the safe direction.
  if (indexFree.length > 0) {
    for (const group of byIndex.values()) {
      for (const check of indexFree) {
        if (normalizeCriterionText(check.criterion) === group.normalized) {
          group.results.push(check);
        }
      }
    }
  }

  return { text: [...byCriterion.values()], byIndex };
}

/**
 * Normalize criterion text for matching: lowercase, strip list/checkbox
 * markers and backticks, collapse whitespace, trim trailing punctuation.
 */
export function normalizeCriterionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s>*+-]*(?:\[[ xX]?\])?\s*/u, "")
    .replace(/^\d+[.)]\s*/u, "")
    .replace(/`/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[\s.!?:;,]+$/u, "")
    .trim();
}

function tokenizeCriterion(normalized: string): Set<string> {
  return new Set(
    normalized.split(/[^a-z0-9]+/u).filter((token) => token.length >= MIN_TOKEN_LENGTH),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreGroup(
  evalNormalized: string,
  evalTokens: Set<string>,
  group: ComplianceGroup,
): GroupMatch | null {
  if (evalNormalized.length === 0 || group.normalized.length === 0) {
    return null;
  }

  if (evalNormalized === group.normalized) {
    return { group, rank: 3, score: 1 };
  }

  const shorter =
    evalNormalized.length <= group.normalized.length ? evalNormalized : group.normalized;
  const longer = shorter === evalNormalized ? group.normalized : evalNormalized;
  if (shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter)) {
    return { group, rank: 2, score: shorter.length };
  }

  const overlap = tokenOverlap(evalTokens, group.tokens);
  if (overlap >= TOKEN_OVERLAP_THRESHOLD) {
    return { group, rank: 1, score: overlap };
  }

  return null;
}

/**
 * Resolve which compliance group an evaluation is talking about.
 *
 * TASK-1320. Two paths, and the ORDER is the whole design:
 *
 * 1. INDEX, but only when corroborated. The judge is an LLM, so the
 *    index it emits is a claim. Round-1 R1-1 killed the original
 *    corroboration idea (compare the judge's index against the judge's
 *    own echoed text with a similarity threshold) as circular: a model
 *    confused about which criterion it is evaluating emits a
 *    consistent-but-wrong index AND a consistent-but-wrong echo, and a
 *    0.6 threshold accepts it. The arithmetic was supplied and it is
 *    convincing.
 *
 *    So corroboration is normalized EXACT equality against the SPEC
 *    text at that position. The spec text is the one input the judge did
 *    not author. Any threshold below 1.0 reintroduces the fuzzy matching
 *    this exists to replace, wearing a different name.
 *
 *    The cost is stated rather than hidden: a REWORDED echo fails
 *    corroboration and falls back to text, exactly as today. The index
 *    makes the unambiguous case exact; it does not rescue the ambiguous
 *    one.
 *
 * 2. Otherwise the pre-1320 text strategies, unchanged.
 *
 * The `no_group_for_index` outcome is round-1 R1-4: a corroborated index
 * whose criterion produced NO compliance results. Falling back to text
 * there could match a DIFFERENT criterion's failing group and demote the
 * wrong criterion, so it neither demotes nor falls back.
 */
type GroupResolution =
  | { kind: "matched"; match: GroupMatch | null }
  | { kind: "no_group_for_index" };

function resolveGroup(
  evaluation: CriterionEvaluation,
  groups: ComplianceGrouping,
  successCriteria?: readonly string[],
): GroupResolution {
  const index = evaluation.criterionIndex;

  const usable =
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    successCriteria !== undefined &&
    index < successCriteria.length;

  if (usable && successCriteria) {
    const evalNormalized = normalizeCriterionText(evaluation.criterion);
    // The one comparison the judge did not author both sides of.
    const matchesAtIndex = normalizeCriterionText(successCriteria[index]) === evalNormalized;

    // ROUND-2 R2-1: matching at the claimed index is NOT enough. Two
    // spec criteria can normalize identically ("Require audit logging."
    // and "Require audit logging!" both become "require audit logging"),
    // and normalization is exactly what strips the punctuation that
    // distinguishes them. A judge echoing criterion 0 while claiming
    // index 1 would then be "corroborated" and demoted on criterion 1's
    // evidence, which is the wrong-demotion outcome this task exists to
    // prevent, reintroduced by the mechanism meant to prevent it.
    //
    // So the echoed text must identify EXACTLY ONE position. When the
    // spec is ambiguous under normalization, the index cannot
    // disambiguate it either, and we fail open to legacy matching.
    const positions = successCriteria.reduce<number>(
      (count, criterion) => count + (normalizeCriterionText(criterion) === evalNormalized ? 1 : 0),
      0,
    );

    if (matchesAtIndex && positions === 1) {
      const group = groups.byIndex.get(index);
      if (!group) {
        return { kind: "no_group_for_index" };
      }
      return {
        kind: "matched",
        match: { group, rank: INDEX_MATCH_RANK, score: 1 },
      };
    }
  }

  return { kind: "matched", match: findBestGroup(evaluation.criterion, groups.text) };
}

/** Above every text rank, so an index match is never outranked. Only
 *  ever produced by an exact-corroborated index. */
const INDEX_MATCH_RANK = 100;

function findBestGroup(criterion: string, groups: ComplianceGroup[]): GroupMatch | null {
  if (groups.length === 0) {
    return null;
  }
  const evalNormalized = normalizeCriterionText(criterion);
  const evalTokens = tokenizeCriterion(evalNormalized);

  const matches: GroupMatch[] = [];
  for (const group of groups) {
    const match = scoreGroup(evalNormalized, evalTokens, group);
    if (match) {
      matches.push(match);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.rank - a.rank || b.score - a.score);
  const best = matches[0];
  if (!best) {
    return null;
  }
  const runnerUp = matches[1];
  if (runnerUp && runnerUp.rank === best.rank && runnerUp.score === best.score) {
    // Two different groups are equally plausible; never demote on a guess.
    return null;
  }
  return best;
}
