import type {
  DepthEvalResult,
  EnforcementDemotion,
  GateResult,
  JudgeResult,
  PostJudgeResult,
} from "../../src/core/types.js";
import {
  projectDocsReviewDecision,
  projectJudgeDecision,
  projectLoopReviewDecision,
  projectPostJudgeDecision,
  projectPostJudgeErrorDecision,
  projectReadinessDecision,
} from "../../src/judgment/judgment-adapters.js";

function judge(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    verdict: "APPROVE",
    confidence: 0.9,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [],
    feedback: "ok",
    ...overrides,
  };
}

describe("judgment adapters", () => {
  it("maps missing readiness schema to the safety floor", () => {
    const result: GateResult = {
      outcome: "rejected",
      reason: "Schema validation failed",
      details: { valid: false, missing: ["filesToModify"], warnings: [] },
    };
    const decision = projectReadinessDecision(result);
    expect(decision.action).toBe("stop");
    expect(decision.safetyFloor.blockers[0]).toMatchObject({
      safetyCode: "missing_required_schema",
    });
  });

  it("keeps free-text BLOCKING depth claims out of the safety floor", () => {
    const depth: DepthEvalResult = {
      taskType: "code" as never,
      threshold: 4,
      ready: false,
      overallScore: 2,
      scores: {},
      deficiencies: ["BLOCKING missing dependency"],
      enrichmentSuggestions: [],
    };
    const decision = projectReadinessDecision({
      outcome: "rejected",
      reason: "Blocking deficiencies detected",
      details: depth,
    });
    expect(decision.action).toBe("human_review");
    expect(decision.safetyFloor.passed).toBe(true);
  });

  it("maps docs blocking to human review and retains legacy evidence", () => {
    const decision = projectDocsReviewDecision(
      [
        {
          code: "unresolved_high_severity_finding",
          message: "P1 open",
          blocking: true,
          field: "findings",
          blockReasonCode: "unresolved_high_finding",
        },
      ],
      false,
    );
    expect(decision.action).toBe("human_review");
    expect(decision.signals[0]).toMatchObject({
      code: "unresolved_high_severity_finding",
      disposition: "human_review",
      evidence: ["findings", "unresolved_high_finding"],
    });
  });

  it("maps a loop runner error to human review, never safety", () => {
    const decision = projectLoopReviewDecision(
      "loop_diff",
      {
        status: "runner_error",
        runner: "codex-cli",
        errorKind: "timeout",
        message: "timed out",
        durationMs: 100,
      },
      {
        crossModelSatisfied: true,
        anchorAuditPassed: false,
        treeClean: false,
        fidelityPassed: true,
        eligibleForAutoApproval: false,
        reasons: ["review runner failed: timeout"],
      },
    );
    expect(decision.action).toBe("human_review");
    expect(decision.signals[0].disposition).toBe("human_review");
    expect(decision.safetyFloor.passed).toBe(true);
  });

  it.each([
    ["APPROVE", "continue"],
    ["REVISE", "repair"],
    ["REJECT", "human_review"],
  ] as const)("maps judge %s to %s", (verdict, action) => {
    expect(projectJudgeDecision(judge({ verdict })).action).toBe(action);
  });

  it("emits one signal per demotion on every verdict", () => {
    const demotions: EnforcementDemotion[] = [
      {
        criterion: "one",
        rule: "llm_instruction_only",
        from: "PASS",
        to: "PARTIAL",
        detail: "one detail",
      },
      {
        criterion: "two",
        rule: "compliance_conflict",
        from: "PASS",
        to: "PARTIAL",
        detail: "two detail",
      },
    ];
    for (const verdict of ["APPROVE", "REVISE", "REJECT"] as const) {
      const decision = projectJudgeDecision(judge({ verdict, enforcementDemotions: demotions }));
      expect(decision.signals.filter((item) => item.code === "enforcement_demotion")).toHaveLength(
        2,
      );
    }
  });

  it("records path audit facts structurally and repairs on override", () => {
    const decision = projectJudgeDecision(judge(), {
      phase: "path_audit",
      pathAudit: {
        total: 3,
        valid: ["src/a.ts"],
        hallucinated: ["src/no.ts", "src/no2.ts"],
        hallucinationRate: 2 / 3,
        overridden: true,
      },
    });
    expect(decision.action).toBe("repair");
    const pathSignal = decision.signals.find((item) => item.code === "path_audit_override");
    expect(pathSignal).toBeDefined();
    expect(pathSignal?.evidence).toContain("total=3");
    expect(pathSignal?.evidence).toContain("hallucinated=2");
  });

  it.each([
    [{ verified: true, needsReview: undefined }, "continue"],
    [{ verified: false, needsReview: undefined }, "repair"],
    [{ verified: true, needsReview: true }, "human_review"],
  ] as const)("maps post-judge %#", (state, action) => {
    const result: PostJudgeResult = {
      verified: state.verified,
      buildPassed: true,
      testsPassed: true,
      lintPassed: true,
      testCount: 1,
      findings: [],
      summary: "summary",
      ...(state.needsReview === undefined ? {} : { needsReview: state.needsReview }),
    };
    expect(projectPostJudgeDecision(result).action).toBe(action);
  });

  it("keeps authority inversion and its error path in human review", () => {
    const verified: PostJudgeResult = {
      verified: true,
      buildPassed: true,
      testsPassed: true,
      lintPassed: true,
      testCount: 1,
      findings: [],
      summary: "pass",
    };
    expect(projectPostJudgeDecision(verified, "REJECT").action).toBe("human_review");
    expect(projectPostJudgeErrorDecision("boom").action).toBe("human_review");
  });
});
