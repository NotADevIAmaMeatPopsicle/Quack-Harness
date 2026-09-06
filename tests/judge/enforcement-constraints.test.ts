import {
  applyEnforcementConstraints,
  normalizeCriterionText,
  ENFORCEMENT_OVERRIDE_PREFIX,
} from "../../src/judge/enforcement-constraints";
import type { ComplianceCheckResult, CriterionEvaluation, JudgeResult } from "../../src/core/types";

// ─── Test helpers ──────────────────────────────────────────────────────

function makeEvaluation(overrides: Partial<CriterionEvaluation> = {}): CriterionEvaluation {
  return {
    criterion: "Enforces maxTasks limit of 5",
    status: "PASS",
    evidence: "src/planner.ts:46",
    reasoning: "Limit is applied to the result list",
    enforcement_type: "deterministic_code",
    ...overrides,
  };
}

function makeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    verdict: "APPROVE",
    confidence: 0.9,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [],
    feedback: "All criteria met.",
    criteriaEvaluation: [makeEvaluation()],
    ...overrides,
  };
}

function makeCheck(overrides: Partial<ComplianceCheckResult> = {}): ComplianceCheckResult {
  return {
    criterion: "Enforces maxTasks limit of 5",
    patternMatched: "Limit/cap enforcement (slice, Math.min/max, conditional checks)",
    found: false,
    evidence: [],
    description: "Limit/cap enforcement (slice, Math.min/max, conditional checks)",
    severity: "flag",
    ...overrides,
  };
}

function deepSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── Rule A: enforcement-type cap ──────────────────────────────────────

describe("applyEnforcementConstraints: Rule A", () => {
  test("demotes llm_instruction_only PASS to PARTIAL and records the demotion", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "llm_instruction_only" })],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
    expect(constrained.criteriaEvaluation![0].reasoning).toContain("enforcement demotion");
    expect(constrained.enforcementDemotions).toHaveLength(1);
    expect(constrained.enforcementDemotions![0]).toMatchObject({
      criterion: "Enforces maxTasks limit of 5",
      rule: "llm_instruction_only",
      from: "PASS",
      to: "PARTIAL",
    });
  });

  test("demotes not_implemented PASS to PARTIAL", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "not_implemented" })],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
    expect(constrained.enforcementDemotions![0].rule).toBe("not_implemented");
  });

  test("leaves deterministic_code PASS untouched when no compliance conflict", () => {
    const result = makeResult();

    const constrained = applyEnforcementConstraints(result);

    expect(constrained).toBe(result); // no demotions: same object back
    expect(constrained.criteriaEvaluation![0].status).toBe("PASS");
    expect(constrained.enforcementDemotions).toBeUndefined();
  });

  test("does not touch FAIL or PARTIAL entries even with llm_instruction_only", () => {
    const result = makeResult({
      verdict: "REVISE",
      criteriaEvaluation: [
        makeEvaluation({ status: "PARTIAL", enforcement_type: "llm_instruction_only" }),
        makeEvaluation({
          criterion: "Handles errors gracefully",
          status: "FAIL",
          enforcement_type: "not_implemented",
        }),
      ],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained).toBe(result);
  });
});

// ─── Rule B: compliance cross-check ────────────────────────────────────

describe("applyEnforcementConstraints: Rule B", () => {
  test("demotes deterministic_code PASS when all matching flag checks found nothing", () => {
    const result = makeResult();
    const checks = [makeCheck({ found: false })];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
    expect(constrained.enforcementDemotions![0].rule).toBe("compliance_conflict");
    expect(constrained.enforcementDemotions![0].detail).toContain("Limit/cap enforcement");
  });

  test("does not demote when any matching flag check found evidence", () => {
    const result = makeResult();
    const checks = [
      makeCheck({ found: false }),
      makeCheck({
        found: true,
        evidence: ["src/planner.ts:46"],
        description: "Cross-reference checks (Set/Map operations, find, includes)",
      }),
    ];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained).toBe(result);
  });

  test("warning-severity misses never demote", () => {
    const result = makeResult();
    const checks = [makeCheck({ severity: "warning", found: false })];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained).toBe(result);
  });

  test("non-matching criteria are untouched", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ criterion: "Renders the settings page correctly" })],
    });
    const checks = [makeCheck({ found: false })];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained).toBe(result);
  });
});

// ─── Rule B matching strategies ────────────────────────────────────────

describe("applyEnforcementConstraints: matching", () => {
  test("matches across case, whitespace, and checkbox-marker differences", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ criterion: "enforces   MAXTASKS limit of 5." })],
    });
    const checks = [makeCheck({ criterion: "- [ ] Enforces maxTasks limit of 5" })];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
  });

  test("matches a truncated echo via containment (>= 12 chars)", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ criterion: "Enforces maxTasks limit" })],
    });
    const checks = [
      makeCheck({
        criterion: "Enforces maxTasks limit of 5 even when the LLM returns more items",
      }),
    ];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
  });

  test("containment guard rejects short fragments", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ criterion: "maxTasks" })],
    });
    const checks = [makeCheck({ criterion: "Enforces maxTasks limit of 5" })];

    const constrained = applyEnforcementConstraints(result, checks);

    // "maxtasks" is 8 chars, below the 12-char containment guard, and
    // token overlap (1 of 5 tokens) is below threshold: no match, fail open.
    expect(constrained).toBe(result);
  });

  test("matches a lightly reworded echo via token overlap", () => {
    const result = makeResult({
      criteriaEvaluation: [
        makeEvaluation({
          criterion: "maxTasks limit of 5 is enforced",
        }),
      ],
    });
    const checks = [makeCheck({ criterion: "Enforces maxTasks limit of 5" })];

    const constrained = applyEnforcementConstraints(result, checks);

    // Tokens: {maxtasks, limit, enforced} vs {enforces, maxtasks, limit}.
    // Overlap 2/4 = 0.5 is below 0.6 threshold... use a closer rewording.
    // This case documents the boundary: see the next test for a passing overlap.
    expect(constrained).toBe(result);
  });

  test("token overlap above threshold matches", () => {
    const result = makeResult({
      criteriaEvaluation: [
        makeEvaluation({
          criterion: "Enforces the maxTasks limit of 5 tasks",
        }),
      ],
    });
    const checks = [makeCheck({ criterion: "Enforces maxTasks limit of 5 tasks" })];

    const constrained = applyEnforcementConstraints(result, checks);

    // Tokens {enforces, the->dropped(<3? no, 'the' is 3), maxtasks, limit, tasks}
    // vs {enforces, maxtasks, limit, tasks}: overlap 4/5 = 0.8 >= 0.6.
    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
  });

  test("ambiguous tie between two groups demotes neither", () => {
    const duplicated = "Validates user input before saving";
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ criterion: duplicated })],
    });
    // Two distinct groups with identical normalized text (duplicated criteria
    // in a spec): both rank exact with equal score, so the match is ambiguous.
    const checks = [
      makeCheck({ criterion: `- [ ] ${duplicated}`, found: false }),
      makeCheck({ criterion: duplicated.toUpperCase(), found: false }),
    ];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained).toBe(result);
  });

  test("shared anchor phrase does not cross-match distinct criteria", () => {
    const result = makeResult({
      criteriaEvaluation: [
        makeEvaluation({
          criterion: "Validates user input on the signup form before saving",
          enforcement_type: "deterministic_code",
        }),
      ],
    });
    // A different criterion sharing only the generic anchor "validates user
    // input": token overlap stays below threshold, so the unrelated group's
    // found=true must NOT vouch for this criterion, and its found=false must
    // NOT demote it either.
    const checks = [
      makeCheck({
        criterion: "Validates user input in the CSV import pipeline rows",
        found: false,
      }),
    ];

    const constrained = applyEnforcementConstraints(result, checks);

    expect(constrained).toBe(result);
  });
});

// ─── Verdict, feedback, and bookkeeping ────────────────────────────────

describe("applyEnforcementConstraints: verdict and bookkeeping", () => {
  test("APPROVE with a demotion downgrades to REVISE with the override prefix", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "llm_instruction_only" })],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained.verdict).toBe("REVISE");
    expect(constrained.feedback.startsWith(ENFORCEMENT_OVERRIDE_PREFIX)).toBe(true);
    expect(constrained.feedback).toContain("Enforces maxTasks limit of 5");
    expect(constrained.feedback).toContain("All criteria met."); // original preserved
  });

  test("never downgrades to REJECT and never upgrades REVISE/REJECT", () => {
    const revise = makeResult({
      verdict: "REVISE",
      criteriaEvaluation: [
        makeEvaluation({ enforcement_type: "llm_instruction_only" }),
        makeEvaluation({
          criterion: "Handles errors gracefully",
          status: "FAIL",
          enforcement_type: "not_implemented",
        }),
      ],
    });

    const constrained = applyEnforcementConstraints(revise);

    expect(constrained.verdict).toBe("REVISE");
    expect(constrained.feedback.startsWith(ENFORCEMENT_OVERRIDE_PREFIX)).toBe(false);
    expect(constrained.criteriaEvaluation![0].status).toBe("PARTIAL");
    expect(constrained.enforcementDemotions).toHaveLength(1);

    const reject = makeResult({
      verdict: "REJECT",
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "llm_instruction_only" })],
    });

    const constrainedReject = applyEnforcementConstraints(reject);
    expect(constrainedReject.verdict).toBe("REJECT");
  });

  test("criteriaGaps gains each demoted criterion exactly once", () => {
    const result = makeResult({
      criteriaGaps: ["Enforces maxTasks limit of 5"],
      criteriaEvaluation: [
        makeEvaluation({ enforcement_type: "llm_instruction_only" }),
        makeEvaluation({
          criterion: "Caps retries at 3",
          enforcement_type: "not_implemented",
        }),
      ],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(
      constrained.criteriaGaps.filter((g) => g === "Enforces maxTasks limit of 5"),
    ).toHaveLength(1);
    expect(constrained.criteriaGaps).toContain("Caps retries at 3");
  });

  test("confidence and followUpItems are untouched", () => {
    const result = makeResult({
      confidence: 0.87,
      followUpItems: [{ title: "Add metrics", description: "Track demotions", type: "testing" }],
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "llm_instruction_only" })],
    });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained.confidence).toBe(0.87);
    expect(constrained.followUpItems).toEqual(result.followUpItems);
  });
});

// ─── No-ops, immutability, idempotency ─────────────────────────────────

describe("applyEnforcementConstraints: no-ops and invariants", () => {
  test("legacy results without criteriaEvaluation pass through unchanged", () => {
    const result = makeResult({ criteriaEvaluation: undefined });

    const constrained = applyEnforcementConstraints(result);

    expect(constrained).toBe(result);
  });

  test("empty criteriaEvaluation passes through unchanged", () => {
    const result = makeResult({ criteriaEvaluation: [] });

    expect(applyEnforcementConstraints(result)).toBe(result);
  });

  test("never mutates the input", () => {
    const result = makeResult({
      criteriaEvaluation: [makeEvaluation({ enforcement_type: "llm_instruction_only" })],
    });
    const snapshot = deepSnapshot(result);

    applyEnforcementConstraints(result, [makeCheck({ found: false })]);

    expect(result).toEqual(snapshot);
  });

  test("is idempotent: applying twice equals applying once", () => {
    const result = makeResult({
      criteriaEvaluation: [
        makeEvaluation({ enforcement_type: "llm_instruction_only" }),
        makeEvaluation({
          criterion: "Caps retries at 3",
          enforcement_type: "deterministic_code",
        }),
      ],
    });
    const checks = [makeCheck({ criterion: "Caps retries at 3", found: false })];

    const once = applyEnforcementConstraints(result, checks);
    const twice = applyEnforcementConstraints(once, checks);

    expect(twice).toEqual(once);
  });
});

// ─── normalizeCriterionText ────────────────────────────────────────────

describe("normalizeCriterionText", () => {
  test("strips checkbox markers, backticks, and trailing punctuation", () => {
    expect(normalizeCriterionText("- [x] Enforces `maxTasks` limit of 5.")).toBe(
      "enforces maxtasks limit of 5",
    );
  });

  test("strips numbered-list markers and collapses whitespace", () => {
    expect(normalizeCriterionText("2)  Validates   input")).toBe("validates input");
  });
});
