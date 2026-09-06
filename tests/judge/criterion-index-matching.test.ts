// ─── Criterion-index matching (TASK-1320, P2-6) ─────────────────────
// Rule B decides whether a judge PASS gets demoted, and it used to
// identify WHICH criterion a compliance result belonged to by comparing
// free text. Both sides derive from one ordered list, so an exact
// identity was being discarded and approximately reconstructed.
//
// Round 1 reshaped this test file before it existed. Two of its findings
// are the reason these cases look the way they do:
//
//   R1-1: corroborating an LLM's index against the LLM's OWN echoed text
//   is circular. Corroboration is normalized EXACT equality against the
//   SPEC text, the one input the judge did not author. A reworded echo
//   therefore FALLS BACK, and that is by design, not a gap.
//
//   R1-2: my original motivating example did not actually fail, because
//   findBestGroup tries normalized exact equality first. The real
//   failure needs a REWORDED echo, and the test must prove the legacy
//   path mis-groups it.

import { applyEnforcementConstraints } from "../../src/judge/enforcement-constraints";
import type { ComplianceCheckResult, CriterionEvaluation, JudgeResult } from "../../src/core/types";

const CRITERIA = [
  "Validate the input payload before processing",
  "Validate the output payload before returning",
];

function evaluation(overrides: Partial<CriterionEvaluation> = {}): CriterionEvaluation {
  return {
    criterion: CRITERIA[0],
    status: "PASS",
    evidence: "src/x.ts:1",
    reasoning: "looks fine",
    enforcement_type: "deterministic_code",
    ...overrides,
  } as CriterionEvaluation;
}

/** A flag-severity check with no evidence: the shape that DEMOTES. */
function failing(criterion: string, criterionIndex?: number): ComplianceCheckResult {
  return {
    criterion,
    patternMatched: "p",
    found: false,
    evidence: [],
    description: `check for ${criterion}`,
    severity: "flag",
    ...(criterionIndex === undefined ? {} : { criterionIndex }),
  } as ComplianceCheckResult;
}

/** A passing check: present evidence, so it never demotes. */
function passing(criterion: string, criterionIndex?: number): ComplianceCheckResult {
  return { ...failing(criterion, criterionIndex), found: true, evidence: ["src/x.ts:9"] };
}

function judge(evaluations: CriterionEvaluation[]): JudgeResult {
  return {
    verdict: "APPROVE",
    feedback: "ok",
    criteriaEvaluation: evaluations,
    criteriaGaps: [],
    scopeViolations: [],
    qualityIssues: [],
  } as unknown as JudgeResult;
}

function demotedCriteria(result: JudgeResult): string[] {
  return (result.enforcementDemotions ?? []).map((d) => d.criterion);
}

describe("the reworded echo: the case that motivates the whole task", () => {
  // ROUND-2 R2-3 rewrote this block, and the criticism was correct.
  //
  // The first version put the FAILING check on the criterion under
  // evaluation and a PASSING check on the one legacy matching wrongly
  // selects, then asserted "no demotion". That assertion also passes if
  // matching returns null, if matching is disabled, or if compliance is
  // ignored entirely. It could not distinguish "mis-grouped onto a
  // passing group" from "never matched anything", which is the whole
  // claim it existed to make.
  //
  // Inverted: criterion 0 FAILS and criterion 1 PASSES. Now legacy
  // mis-grouping produces a visible WRONG DEMOTION of the evaluation on
  // criterion 0 evidence, and the index path produces none. Both
  // assertions are positive statements about behavior.
  const REWORDED = "Validate payload before processing";
  const checks = [failing(CRITERIA[0], 0), passing(CRITERIA[1], 1)];

  it("LEGACY text matching DEMOTES THE WRONG CRITERION, which is why this task exists", () => {
    // The judge is evaluating criterion 1, whose evidence is fine, but
    // reworded it. The reworded text scores 0.667 against criterion 0
    // and 0.429 against criterion 1, so legacy matching confidently
    // picks the FAILING group belonging to a different criterion.
    const out = applyEnforcementConstraints(judge([evaluation({ criterion: REWORDED })]), checks);
    expect(demotedCriteria(out)).toEqual([REWORDED]);
    expect(out.verdict).toBe("REVISE");
  });

  it("a CORROBORATED index prevents that wrong demotion", () => {
    // Same compliance array, same situation, but the judge echoed
    // criterion 1 exactly and named index 1. Resolution finds criterion
    // 1 PASSING group and correctly does not demote.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[1], criterionIndex: 1 })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([]);
    expect(out.verdict).toBe("APPROVE");
  });

  it("a corroborated index DEMOTES when the evidence really is its own", () => {
    // The other direction, so the pair cannot be satisfied by a fix that
    // simply stops demoting. Criterion 0 echoed exactly with index 0,
    // and criterion 0 own check is failing.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0], criterionIndex: 0 })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([CRITERIA[0]]);
  });

  it("a reworded echo WITH an index still falls back, by design", () => {
    // R1-1 accepted cost, pinned so nobody later loosens corroboration
    // back into fuzzy matching. The index says 1, the echo does not
    // match the spec text at 1, so the index is discarded and the legacy
    // path runs, producing the same wrong demotion as the first case.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: REWORDED, criterionIndex: 1 })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([REWORDED]);
  });
});

describe("round-2 R2-1: criteria that NORMALIZE identically", () => {
  // Normalization strips trailing punctuation, which is exactly what
  // distinguishes these two. So a claimed index "matches" at position 1
  // even when the judge echoed position 0. Trusting that would demote on
  // the wrong evidence via the mechanism built to prevent exactly that.
  const COLLIDING = ["Require audit logging.", "Require audit logging!"];

  it("an ambiguous normalized match is NOT corroboration, and falls open to legacy", () => {
    const checks = [passing(COLLIDING[0], 0), failing(COLLIDING[1], 1)];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: COLLIDING[0], criterionIndex: 1 })]),
      checks,
      COLLIDING,
    );
    // Legacy matching sees two groups that normalize identically and
    // tie, and a tie never demotes. What must NOT happen is a demotion
    // via the failing group at index 1.
    expect(demotedCriteria(out)).toEqual([]);
  });
});

describe("round-2 R2-2: EXACT duplicate criteria", () => {
  // Round 1 required this coverage and the first build did not have it,
  // which is how a regression walked past the criterion written to catch
  // it. Text-keyed grouping collapsed both duplicates into one group
  // whose members disagreed about their index; the group forfeited its
  // index and NEITHER evaluation was demoted despite failing evidence.
  const DUPES = ["Require audit logging", "Require audit logging"];

  it("duplicate criteria still demote on their own failing evidence", () => {
    const checks = [failing(DUPES[0], 0), failing(DUPES[1], 1)];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: DUPES[0], criterionIndex: 0 })]),
      checks,
      DUPES,
    );
    expect(demotedCriteria(out)).toEqual([DUPES[0]]);
  });

  it("compliance results for duplicates keep SEPARATE index groups", () => {
    const checks = [failing(DUPES[0], 0), passing(DUPES[1], 1)];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: DUPES[1], criterionIndex: 1 })]),
      checks,
      DUPES,
    );
    // Ambiguous under normalization, so it falls open to legacy, where
    // the merged text group holds one failing and one passing check.
    // Rule B demotes only when EVERY flag check failed, so it does not.
    expect(demotedCriteria(out)).toEqual([]);
  });
});

describe("an LLM-supplied index is a claim, and cannot cause a wrong demotion", () => {
  const checks = [failing(CRITERIA[0], 0), passing(CRITERIA[1], 1)];

  it.each([
    ["negative", -1],
    ["past the end", 7],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
  ])("an index that is %s is discarded and falls back", (_label, index) => {
    // The judge echoes criterion 1 (whose check PASSES) but supplies a
    // junk index. Falling back to text finds criterion 1's passing
    // group, so nothing is demoted. What must never happen is a demotion
    // of criterion 1 via criterion 0's failing group, or a throw.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[1], criterionIndex: index })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([]);
  });

  it("an in-range index whose echoed text belongs to ANOTHER criterion is discarded", () => {
    // The hallucination case, and the point of the task. The judge
    // echoes criterion 1 but claims index 0, whose check is failing.
    // Trusting the index blindly would demote criterion 1 on criterion
    // 0's evidence. Corroboration against the SPEC text rejects it, and
    // the text fallback then correctly finds criterion 1's passing group.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[1], criterionIndex: 0 })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([]);
  });

  it("without successCriteria no index can be corroborated, so nothing changes", () => {
    // The batch judge path calls applyEnforcementConstraints with no
    // criteria at all. Every evaluation must take the legacy path.
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0], criterionIndex: 0 })]),
      checks,
    );
    // Legacy text matching finds criterion 0's FAILING group by exact
    // normalized equality, so this demotes, exactly as it did pre-1320.
    expect(demotedCriteria(out)).toEqual([CRITERIA[0]]);
  });
});

describe("round-1 R1-4: a corroborated index with no compliance group", () => {
  it("does NOT demote and does NOT fall back to text", () => {
    // Criterion 1 produced no compliance results at all. Falling back to
    // text here would match criterion 0's FAILING group by token overlap
    // and demote criterion 1 on another criterion's evidence, which is
    // the wrong-demotion outcome the whole design exists to prevent.
    const checks = [failing(CRITERIA[0], 0)];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[1], criterionIndex: 1 })]),
      checks,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([]);
    expect(out.verdict).toBe("APPROVE");
  });
});

describe("round-1 R1-6: legacy and mixed payloads keep working", () => {
  it("index-FREE compliance results group by text exactly as before", () => {
    const legacy = [failing(CRITERIA[0]), passing(CRITERIA[1])];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0] })]),
      legacy,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([CRITERIA[0]]);
  });

  it("a mixed payload does NOT demote when an index-free row CONTRADICTS the indexed one", () => {
    // ROUND-2b caught this, and caught that my own rewrite hid it.
    //
    // Splitting text and index views made the index group hold only the
    // indexed row. With `[failing(C, 0), passing(C)]` that group is
    // all-failing, so Rule B demoted, even though a matching check for
    // the same criterion PASSED. A false demotion, which is the exact
    // failure direction this task exists to prevent, reintroduced by the
    // fix for R2-2.
    //
    // My rewritten pin used two FAILING rows and therefore could not see
    // it. Index-free rows are now folded into the index group they
    // belong to.
    const contradictory = [failing(CRITERIA[0], 0), passing(CRITERIA[0])];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0], criterionIndex: 0 })]),
      contradictory,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([]);
  });

  it("a MIXED payload uses the indexed evidence when nothing contradicts it", () => {
    // BEHAVIOR CHANGED at round 2, and this test changed with it rather
    // than being deleted.
    //
    // The first build grouped everything by criterion TEXT, so a mixed
    // payload put both rows in one group whose members disagreed about
    // their index; the group forfeited its index and the evaluation got
    // `no_group_for_index`, demoting nothing. That was a workaround for
    // text-keyed grouping, and R2-2 showed the workaround itself broke
    // duplicate criteria.
    //
    // Index groups are now keyed by INDEX, so the two rows never share a
    // group and there is nothing to forfeit. The index-bearing row is
    // unambiguous evidence for index 0 and is used. The index-free row
    // stays in the text view for the legacy path.
    //
    // This is the better answer: the old behavior discarded good
    // evidence because a sibling row happened to be older.
    const mixed = [failing(CRITERIA[0], 0), failing(CRITERIA[0])];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0], criterionIndex: 0 })]),
      mixed,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([CRITERIA[0]]);
  });

  it("an index-free EVALUATION over a mixed payload still uses the legacy text path", () => {
    // The other half of the mixed case: when the judge supplies no
    // index, nothing about the new index groups may change the answer.
    // Both rows are in the text group and both fail, so legacy Rule B
    // demotes exactly as it did before 1320.
    const mixed = [failing(CRITERIA[0], 0), failing(CRITERIA[0])];
    const out = applyEnforcementConstraints(
      judge([evaluation({ criterion: CRITERIA[0] })]),
      mixed,
      CRITERIA,
    );
    expect(demotedCriteria(out)).toEqual([CRITERIA[0]]);
  });
});
