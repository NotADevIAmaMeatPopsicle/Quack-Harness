import { parseJudgeResponse } from "../../src/judge/verdict";
import type { RawJudgeResponse } from "../../src/judge/verdict";
import { extractSuccessCriteria } from "../../src/judge/judge-prompt";
import type { ParsedTask } from "../../src/core/types";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeRawResponse(overrides: Partial<RawJudgeResponse> = {}): RawJudgeResponse {
  return {
    verdict: "APPROVE",
    confidence: 0.9,
    scope_violations: [],
    criteria_gaps: [],
    quality_issues: [],
    feedback: "All good.",
    ...overrides,
  };
}

function makeParsedTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "TASK-001",
    title: "Test task",
    priority: "P1-HIGH",
    effort: "2 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "",
    ...overrides,
  };
}

// ─── Tests: parseJudgeResponse — per-criterion evaluation ───────────

describe("parseJudgeResponse — per-criterion evaluation", () => {
  test("should parse full criteria_evaluation with all enforcement types", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      confidence: 0.75,
      criteria_evaluation: [
        {
          criterion: "Input validation enforced",
          status: "PASS",
          evidence: "src/validators.ts:15-25",
          reasoning: "Zod schema validates all inputs before processing",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Max items limit respected",
          status: "PARTIAL",
          evidence: "src/prompt.ts:42",
          reasoning: "Limit is only in prompt text, not enforced in code",
          enforcement_type: "llm_instruction_only",
        },
        {
          criterion: "Rate limiting enabled",
          status: "FAIL",
          evidence: "not found",
          reasoning: "No rate limiting code found in the diff",
          enforcement_type: "not_implemented",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaEvaluation).toBeDefined();
    expect(result.criteriaEvaluation).toHaveLength(3);

    // Check each enforcement type is preserved
    expect(result.criteriaEvaluation![0].enforcement_type).toBe("deterministic_code");
    expect(result.criteriaEvaluation![1].enforcement_type).toBe("llm_instruction_only");
    expect(result.criteriaEvaluation![2].enforcement_type).toBe("not_implemented");
  });

  test("should auto-derive criteria_gaps from non-PASS criteria_evaluation entries", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      criteria_gaps: [], // empty — should be derived
      criteria_evaluation: [
        {
          criterion: "Criterion A",
          status: "PASS",
          evidence: "a.ts:1",
          reasoning: "Good",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Criterion B",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Missing",
          enforcement_type: "not_implemented",
        },
        {
          criterion: "Criterion C",
          status: "PARTIAL",
          evidence: "c.ts:10",
          reasoning: "LLM only",
          enforcement_type: "llm_instruction_only",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaGaps).toHaveLength(2);
    expect(result.criteriaGaps).toContain("Criterion B");
    expect(result.criteriaGaps).toContain("Criterion C");
    expect(result.criteriaGaps).not.toContain("Criterion A");
  });

  test("should NOT override existing criteria_gaps when populated", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      criteria_gaps: ["Manually specified gap"],
      criteria_evaluation: [
        {
          criterion: "Some criterion",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Missing",
          enforcement_type: "not_implemented",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    // Original criteria_gaps preserved since it was non-empty
    expect(result.criteriaGaps).toEqual(["Manually specified gap"]);
  });
});

// ─── Tests: backward compatibility — old format with criteria_gaps ──

describe("parseJudgeResponse — backward compatibility", () => {
  test("should map old format criteria_gaps to criteriaEvaluation with PARTIAL status", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      confidence: 0.7,
      criteria_gaps: [
        "Email validation edge case not covered",
        "Missing error handling for network failures",
      ],
      // NO criteria_evaluation field
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaEvaluation).toBeDefined();
    expect(result.criteriaEvaluation).toHaveLength(2);

    // Each gap auto-mapped with PARTIAL status
    expect(result.criteriaEvaluation![0]).toEqual({
      criterion: "Email validation edge case not covered",
      status: "PARTIAL",
      evidence: "unknown",
      reasoning: "Legacy format - no details available",
      enforcement_type: "not_implemented",
    });

    expect(result.criteriaEvaluation![1]).toEqual({
      criterion: "Missing error handling for network failures",
      status: "PARTIAL",
      evidence: "unknown",
      reasoning: "Legacy format - no details available",
      enforcement_type: "not_implemented",
    });
  });

  test("should NOT create criteriaEvaluation when both criteria_gaps and criteria_evaluation are empty/absent", () => {
    const raw = makeRawResponse({
      criteria_gaps: [],
      // NO criteria_evaluation
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaEvaluation).toBeUndefined();
  });

  test("should handle old format with single criteria gap", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      criteria_gaps: ["Tests not added"],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaEvaluation).toBeDefined();
    expect(result.criteriaEvaluation).toHaveLength(1);
    expect(result.criteriaEvaluation![0].criterion).toBe("Tests not added");
    expect(result.criteriaEvaluation![0].status).toBe("PARTIAL");
  });
});

// ─── Tests: verdict derivation relationship ─────────────────────────

describe("verdict derivation — criteria status to verdict relationship", () => {
  test("all PASS criteria should correspond to APPROVE verdict", () => {
    const raw = makeRawResponse({
      verdict: "APPROVE",
      confidence: 0.95,
      criteria_evaluation: [
        {
          criterion: "Criterion 1",
          status: "PASS",
          evidence: "a.ts:1",
          reasoning: "Deterministically enforced",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Criterion 2",
          status: "PASS",
          evidence: "b.ts:10",
          reasoning: "Validated with tests",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Criterion 3",
          status: "PASS",
          evidence: "c.ts:20",
          reasoning: "Properly implemented",
          enforcement_type: "deterministic_code",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("APPROVE");
    expect(result.criteriaEvaluation!.every((e) => e.status === "PASS")).toBe(true);
    expect(result.criteriaGaps).toEqual([]); // auto-derived: no non-PASS → empty
  });

  test("any FAIL criteria should correspond to REVISE verdict", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      confidence: 0.7,
      criteria_evaluation: [
        {
          criterion: "Criterion 1",
          status: "PASS",
          evidence: "a.ts:1",
          reasoning: "Good",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Criterion 2",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Not implemented",
          enforcement_type: "not_implemented",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("REVISE");
    expect(result.criteriaEvaluation!.some((e) => e.status === "FAIL")).toBe(true);
  });

  test("fundamental FAIL criteria should correspond to REJECT verdict", () => {
    const raw = makeRawResponse({
      verdict: "REJECT",
      confidence: 0.95,
      criteria_evaluation: [
        {
          criterion: "Core functionality works",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Fundamental approach is wrong — deleted tests instead of fixing them",
          enforcement_type: "not_implemented",
        },
        {
          criterion: "Existing tests pass",
          status: "FAIL",
          evidence: "tests/auth.test.ts deleted",
          reasoning: "Test file was deleted to avoid failures",
          enforcement_type: "not_implemented",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("REJECT");
    expect(result.criteriaEvaluation!.every((e) => e.status === "FAIL")).toBe(true);
  });

  test("PARTIAL criteria should correspond to REVISE verdict", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      confidence: 0.8,
      criteria_evaluation: [
        {
          criterion: "Enforces rate limit",
          status: "PARTIAL",
          evidence: "src/config.ts:30",
          reasoning: "Limit is set in config but only enforced via LLM instruction",
          enforcement_type: "llm_instruction_only",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("REVISE");
    expect(result.criteriaEvaluation![0].status).toBe("PARTIAL");
    expect(result.criteriaEvaluation![0].enforcement_type).toBe("llm_instruction_only");
  });

  test("mixed criteria statuses derive correct criteriaGaps", () => {
    const raw = makeRawResponse({
      verdict: "REVISE",
      confidence: 0.65,
      criteria_gaps: [], // should be auto-derived
      criteria_evaluation: [
        {
          criterion: "A passes",
          status: "PASS",
          evidence: "a.ts:1",
          reasoning: "OK",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "B is partial",
          status: "PARTIAL",
          evidence: "b.ts:1",
          reasoning: "LLM only",
          enforcement_type: "llm_instruction_only",
        },
        {
          criterion: "C fails",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Missing",
          enforcement_type: "not_implemented",
        },
        {
          criterion: "D passes too",
          status: "PASS",
          evidence: "d.ts:1",
          reasoning: "OK",
          enforcement_type: "deterministic_code",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));

    // Only non-PASS entries appear in criteriaGaps
    expect(result.criteriaGaps).toHaveLength(2);
    expect(result.criteriaGaps).toContain("B is partial");
    expect(result.criteriaGaps).toContain("C fails");
    expect(result.criteriaGaps).not.toContain("A passes");
    expect(result.criteriaGaps).not.toContain("D passes too");
  });
});

// ─── Tests: extractSuccessCriteria ──────────────────────────────────

describe("extractSuccessCriteria", () => {
  test("should extract criteria from parsedTask when available", () => {
    const task = makeParsedTask({
      successCriteria: ["Input validation enforced", "All tests pass", "No scope violations"],
    });

    const result = extractSuccessCriteria(task);

    expect(result).toEqual(["Input validation enforced", "All tests pass", "No scope violations"]);
  });

  test("should prefer parsedTask criteria over taskSpec markdown", () => {
    const task = makeParsedTask({
      successCriteria: ["From parsed task"],
    });

    const taskSpec = "## Success Criteria\n- [ ] From markdown";

    const result = extractSuccessCriteria(task, taskSpec);

    expect(result).toEqual(["From parsed task"]);
  });

  test("should extract criteria from markdown when parsedTask has none", () => {
    const taskSpec = [
      "# TASK-042: Test",
      "",
      "## Success Criteria",
      "- [ ] First criterion here",
      "- [ ] Second criterion here",
      "- [ ] Third criterion here",
      "",
      "## Testing Requirements",
      "- [ ] Some test requirement",
    ].join("\n");

    const result = extractSuccessCriteria(undefined, taskSpec);

    expect(result).toEqual([
      "First criterion here",
      "Second criterion here",
      "Third criterion here",
    ]);
  });

  test("should stop extracting at next section header", () => {
    const taskSpec = [
      "## Success Criteria",
      "- [ ] Criterion A",
      "- [ ] Criterion B",
      "## Implementation Details",
      "- [ ] This is not a criterion",
    ].join("\n");

    const result = extractSuccessCriteria(undefined, taskSpec);

    expect(result).toEqual(["Criterion A", "Criterion B"]);
  });

  test("should return empty array when no criteria found", () => {
    const taskSpec = "# TASK-001: No criteria section\n\nJust some text.";

    const result = extractSuccessCriteria(undefined, taskSpec);

    expect(result).toEqual([]);
  });

  test("should return empty array when parsedTask has empty criteria and no taskSpec", () => {
    const task = makeParsedTask({ successCriteria: [] });

    const result = extractSuccessCriteria(task);

    expect(result).toEqual([]);
  });

  test("should return empty array with no arguments", () => {
    const result = extractSuccessCriteria();

    expect(result).toEqual([]);
  });

  test("should handle criteria with checkbox syntax variations", () => {
    const taskSpec = [
      "## Success Criteria",
      "- [ ] Standard checkbox criterion",
      "- [x] Already checked criterion should not match",
      "- Not a checkbox item",
      "- [ ] Another valid criterion",
    ].join("\n");

    const result = extractSuccessCriteria(undefined, taskSpec);

    // Only unchecked checkboxes match the regex
    expect(result).toEqual(["Standard checkbox criterion", "Another valid criterion"]);
  });

  test("should handle multi-word Success Criteria header", () => {
    const taskSpec = [
      "## Success Criteria (Required)",
      "- [ ] Must validate input",
      "- [ ] Must return errors",
    ].join("\n");

    // The header detection uses .includes('Success Criteria'), so variants work
    const result = extractSuccessCriteria(undefined, taskSpec);

    expect(result).toEqual(["Must validate input", "Must return errors"]);
  });
});

// ─── Tests: enforcement_type validation ─────────────────────────────

describe("parseJudgeResponse — enforcement_type validation", () => {
  test("should accept all three valid enforcement types", () => {
    const types = ["deterministic_code", "llm_instruction_only", "not_implemented"] as const;

    for (const enforcementType of types) {
      const raw = makeRawResponse({
        criteria_evaluation: [
          {
            criterion: `Test ${enforcementType}`,
            status: "PASS",
            evidence: "file.ts:1",
            reasoning: "Test",
            enforcement_type: enforcementType,
          },
        ],
      });

      const result = parseJudgeResponse(JSON.stringify(raw));
      expect(result.criteriaEvaluation![0].enforcement_type).toBe(enforcementType);
    }
  });

  test("should reject unknown enforcement type", () => {
    const raw = makeRawResponse({
      criteria_evaluation: [
        {
          criterion: "Test",
          status: "PASS",
          evidence: "file.ts:1",
          reasoning: "Test",
          enforcement_type: "runtime_check", // not a valid type
        },
      ],
    });

    expect(() => parseJudgeResponse(JSON.stringify(raw))).toThrow(
      'Invalid enforcement_type: "runtime_check"',
    );
  });
});

// ─── Follow-Up Items Parsing ──────────────────────────────────────

describe("follow_up_items parsing", () => {
  it("should parse valid follow_up_items", () => {
    const raw = makeRawResponse({
      follow_up_items: [
        {
          title: "Add retry logic for flaky tests",
          description: "Tests occasionally fail due to timing; add retry wrapper",
          type: "edge_case",
          estimated_effort: "1-2 hours",
        },
        {
          title: "Optimize database queries",
          description: "N+1 query detected in task listing endpoint",
          type: "optimization",
          estimated_effort: "2-3 hours",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toHaveLength(2);
    expect(result.followUpItems![0].title).toBe("Add retry logic for flaky tests");
    expect(result.followUpItems![0].type).toBe("edge_case");
    expect(result.followUpItems![0].estimatedEffort).toBe("1-2 hours");
    expect(result.followUpItems![1].type).toBe("optimization");
  });

  it("should return undefined when follow_up_items is empty", () => {
    const raw = makeRawResponse({ follow_up_items: [] });
    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toBeUndefined();
  });

  it("should return undefined when follow_up_items is absent", () => {
    const raw = makeRawResponse();
    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toBeUndefined();
  });

  it("should filter out items with invalid type", () => {
    const raw = makeRawResponse({
      follow_up_items: [
        {
          title: "Valid item",
          description: "A valid follow-up",
          type: "testing",
        },
        {
          title: "Invalid item",
          description: "Has invalid type",
          type: "invalid_type",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toHaveLength(1);
    expect(result.followUpItems![0].title).toBe("Valid item");
  });

  it("should handle missing estimated_effort gracefully", () => {
    const raw = makeRawResponse({
      follow_up_items: [
        {
          title: "No effort estimate",
          description: "Missing optional field",
          type: "refactoring",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toHaveLength(1);
    expect(result.followUpItems![0].estimatedEffort).toBeUndefined();
  });

  it("should ignore invalid estimated_effort values", () => {
    const raw = makeRawResponse({
      follow_up_items: [
        {
          title: "Bad effort",
          description: "Invalid effort value",
          type: "testing",
          estimated_effort: "5 minutes",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.followUpItems).toHaveLength(1);
    expect(result.followUpItems![0].estimatedEffort).toBeUndefined();
  });

  it("should filter out items missing required fields", () => {
    const raw = makeRawResponse({
      follow_up_items: [
        {
          title: "",
          description: "Missing title",
          type: "testing",
        },
        {
          title: "Missing description",
          description: "",
          type: "optimization",
        },
        {
          title: "Valid",
          description: "This one is valid",
          type: "edge_case",
        },
      ],
    });

    const result = parseJudgeResponse(JSON.stringify(raw));
    // Only the valid item should remain (empty strings are falsy)
    expect(result.followUpItems).toHaveLength(1);
    expect(result.followUpItems![0].title).toBe("Valid");
  });
});
