// ─── Shared intent-request tests (TASK-1315) ────────────────────────

import { TaskType } from "../../src/core/types";
import type { GateResult, JudgeResult, ParsedTask } from "../../src/core/types";
import type { LoopReviewGateFacts } from "../../src/review/loop-gate";
import type { ReviewRunResult } from "../../src/review/reviewer-types";
import {
  buildJudgeIntentRequest,
  buildLoopIntentRequest,
  buildReadinessIntentRequest,
  extractIntentSections,
  type ReadinessGateEvidence,
} from "../../src/judgment/intent-request";
import {
  projectJudgeDecision,
  projectLoopReviewDecision,
  projectReadinessDecision,
} from "../../src/judgment/judgment-adapters";

const RAW = [
  "# TASK-042: Test Task",
  "",
  "## Intent",
  "Honor the contract, not the checklist.",
  "",
  "## Problem Statement",
  "The gate rejects strong specs.",
  "",
  "## Success Criteria",
  "- [ ] Rescue works",
  "- [ ] Safety pinned",
  "",
  "## Scope Boundaries",
  "- No adapter flips",
].join("\n");

function makeTask(rawContent: string): ParsedTask {
  return {
    id: "TASK-042",
    title: "Test Task",
    priority: "P1-HIGH",
    effort: "4 hours",
    status: "BACKLOG",
    blockedBy: [],
    blocks: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    conventions: [],
    tags: [],
    problemStatement: "p",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    rawContent,
  };
}

const REJECTED: GateResult = {
  outcome: "rejected",
  reason: "Depth evaluation failed",
  details: {
    ready: false,
    taskType: TaskType.Code,
    threshold: 4.7,
    overallScore: 3.2,
    scores: { clarity: 3, scope: 3, testability: 3, conventions: 4 },
    deficiencies: ["needs more detail"],
    enrichmentSuggestions: [],
  },
};

const EVIDENCE: ReadinessGateEvidence = {
  schemaWarnings: ["Missing recommended section: Current State"],
  advisorySuggestedMinScore: 3.5,
  collisionDeficiencies: ["ADVISORY: collides with TASK-041"],
  depthResult: {
    ready: false,
    taskType: TaskType.Code,
    threshold: 4.7,
    overallScore: 3.2,
    scores: { clarity: 3, scope: 3, testability: 3, conventions: 4 },
    deficiencies: ["needs more detail"],
    enrichmentSuggestions: [],
  },
};

describe("extractIntentSections", () => {
  it("extracts the four canonical sections with the Scope fallback semantics", () => {
    const sections = extractIntentSections(RAW);
    expect(sections.empty).toBe(false);
    expect(sections.intent).toContain("Honor the contract");
    expect(sections.presentSections).toEqual([
      "Intent",
      "Problem Statement",
      "Success Criteria",
      "Scope Boundaries",
    ]);
    expect(sections.missingSections).toEqual([]);
  });

  it("reports empty when no canonical sections exist", () => {
    const sections = extractIntentSections("# T\n\nprose only");
    expect(sections.empty).toBe(true);
    expect(sections.missingSections).toHaveLength(4);
  });
});

describe("buildReadinessIntentRequest", () => {
  it("carries the task substance plus the gate evidence in stageContext", () => {
    const task = makeTask(RAW);
    const legacy = projectReadinessDecision(REJECTED);
    const request = buildReadinessIntentRequest(task, REJECTED, legacy, EVIDENCE);

    expect(request).toBeDefined();
    expect(request!.stage).toBe("readiness");
    expect(request!.taskIntent).toContain("Honor the contract");
    expect(request!.taskIntent).toContain("rejects strong specs");
    // sectionItems keeps checkbox markers (docs semantics since 1311, moved literally).
    expect(request!.successCriteria).toEqual(["[ ] Rescue works", "[ ] Safety pinned"]);
    expect(request!.scopeBoundaries).toEqual(["No adapter flips"]);
    expect(request!.stageContext).toMatchObject({
      outcome: "rejected",
      reason: "Depth evaluation failed",
      depthOverallScore: 3.2,
      depthDeficiencies: ["needs more detail"],
      advisorySuggestedMinScore: 3.5,
      collisionDeficiencies: ["ADVISORY: collides with TASK-041"],
      schemaWarnings: ["Missing recommended section: Current State"],
    });
    expect(request!.signals.length).toBeGreaterThan(0);
    expect(request!.signals.every((s) => typeof s.ref === "string")).toBe(true);
  });

  it("returns undefined when the spec carries no intent sections", () => {
    const task = makeTask("# T\n\nno sections");
    const legacy = projectReadinessDecision(REJECTED);
    expect(buildReadinessIntentRequest(task, REJECTED, legacy, EVIDENCE)).toBeUndefined();
  });

  it("skip-depth evidence (no depthResult) is carried honestly", () => {
    const task = makeTask(RAW);
    const legacy = projectReadinessDecision(REJECTED);
    const request = buildReadinessIntentRequest(task, REJECTED, legacy, {
      ...EVIDENCE,
      depthResult: undefined,
    });
    expect(request!.stageContext.depthOverallScore).toBeUndefined();
    expect(request!.stageContext.depthDeficiencies).toEqual([]);
  });
});

// ─── TASK-1316: the loop + judge builders ───────────────────────────

const CLEAN_REVIEW: ReviewRunResult = {
  status: "completed",
  verdict: "SHIP",
  findings: [],
  summary: "clean",
  rawText: "{}",
  runner: "codex-cli",
  durationMs: 1,
};

const ELIGIBLE_FACTS: LoopReviewGateFacts = {
  crossModelSatisfied: true,
  anchorAuditPassed: true,
  treeClean: true,
  fidelityPassed: true,
  eligibleForAutoApproval: true,
  reasons: [],
};

describe("buildLoopIntentRequest", () => {
  it("carries the spec's substance, the review evidence, and the gate's own conclusion", () => {
    const legacy = projectLoopReviewDecision("loop_diff", CLEAN_REVIEW, ELIGIBLE_FACTS);
    const request = buildLoopIntentRequest(
      "loop_diff",
      "TASK-042",
      RAW,
      CLEAN_REVIEW,
      ELIGIBLE_FACTS,
      legacy,
    );

    expect(request?.stage).toBe("loop_diff");
    expect(request?.taskIntent).toContain("Honor the contract");
    expect(request?.taskIntent).toContain("The gate rejects strong specs");
    expect(request?.successCriteria).toHaveLength(2);
    expect(request?.scopeBoundaries).toEqual(["No adapter flips"]);
    expect(request?.stageContext).toMatchObject({
      reviewKind: "diff",
      reviewVerdict: "SHIP",
      findingCount: 0,
      blockingFindingCount: 0,
      eligibleForAutoApproval: true,
      crossModelSatisfied: true,
    });
    expect(request?.contextMetadata.missingSections).toEqual([]);
  });

  it("mirrors the legacy decision's signals exactly (the orchestrator's ref contract)", () => {
    const blockedFacts: LoopReviewGateFacts = {
      ...ELIGIBLE_FACTS,
      eligibleForAutoApproval: false,
      reasons: ["review verdict is FIX_FIRST"],
    };
    const review: ReviewRunResult = { ...CLEAN_REVIEW, verdict: "FIX_FIRST" };
    const legacy = projectLoopReviewDecision("loop_brief", review, blockedFacts);
    const request = buildLoopIntentRequest(
      "loop_brief",
      "TASK-042",
      RAW,
      review,
      blockedFacts,
      legacy,
    );

    expect(request?.signals.map((signal) => signal.signal)).toEqual(legacy.signals);
    expect(request?.signals.map((signal) => signal.ref)).toEqual(["review_non_ship#1"]);
    expect(request?.stageContext.gateReasons).toEqual(["review verdict is FIX_FIRST"]);
  });

  it("surfaces a runner failure as evidence rather than a verdict", () => {
    const failed: ReviewRunResult = {
      status: "runner_error",
      errorKind: "timeout",
      message: "killed after 600s",
      runner: "codex-cli",
      durationMs: 600_000,
    };
    const facts: LoopReviewGateFacts = {
      crossModelSatisfied: true,
      anchorAuditPassed: false,
      treeClean: false,
      fidelityPassed: true,
      eligibleForAutoApproval: false,
      reasons: ["review runner failed: timeout"],
    };
    const legacy = projectLoopReviewDecision("loop_diff", failed, facts);
    const request = buildLoopIntentRequest("loop_diff", "TASK-042", RAW, failed, facts, legacy);

    expect(request?.stageContext).toMatchObject({
      reviewStatus: "runner_error",
      runnerErrorKind: "timeout",
    });
    expect(request?.stageContext.reviewVerdict).toBeUndefined();
  });

  it("returns undefined when the spec carries no intent sections", () => {
    const legacy = projectLoopReviewDecision("loop_diff", CLEAN_REVIEW, ELIGIBLE_FACTS);
    expect(
      buildLoopIntentRequest(
        "loop_diff",
        "TASK-042",
        "# T\n\nno sections",
        CLEAN_REVIEW,
        ELIGIBLE_FACTS,
        legacy,
      ),
    ).toBeUndefined();
  });
});

describe("buildJudgeIntentRequest", () => {
  const JUDGE: JudgeResult = {
    verdict: "APPROVE",
    confidence: 0.91,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [],
    feedback: "All criteria met.",
    criteriaEvaluation: [
      {
        criterion: "Rescue works",
        status: "PASS",
        evidence: "src/gate/gate.ts:140",
        reasoning: "wired",
        enforcement_type: "deterministic_code",
      },
    ],
    enforcementDemotions: [
      {
        criterion: "Safety pinned",
        rule: "llm_instruction_only",
        from: "PASS",
        to: "PARTIAL",
        detail: "mentioned, not enforced",
      },
    ],
  };

  it("carries the verdict, the criteria evidence, and the 1200 demotions", () => {
    const legacy = projectJudgeDecision(JUDGE, { phase: "enforcement" });
    const request = buildJudgeIntentRequest("TASK-042", RAW, JUDGE, legacy);

    expect(request?.stage).toBe("judge");
    expect(request?.stageContext).toMatchObject({
      verdict: "APPROVE",
      confidence: 0.91,
      feedback: "All criteria met.",
    });
    expect(request?.stageContext.criteriaEvaluation).toEqual([
      "PASS [deterministic_code] Rescue works",
    ]);
    expect(request?.stageContext.enforcementDemotions).toEqual([
      "Safety pinned: PASS->PARTIAL (llm_instruction_only)",
    ]);
    expect(request?.signals.map((signal) => signal.signal)).toEqual(legacy.signals);
  });

  it("returns undefined when the spec carries no intent sections", () => {
    const legacy = projectJudgeDecision(JUDGE);
    expect(
      buildJudgeIntentRequest("TASK-042", "# T\n\nno sections", JUDGE, legacy),
    ).toBeUndefined();
  });

  it("bounds a runaway feedback field instead of shipping it whole", () => {
    const legacy = projectJudgeDecision(JUDGE);
    const request = buildJudgeIntentRequest(
      "TASK-042",
      RAW,
      { ...JUDGE, feedback: "x".repeat(9_000) },
      legacy,
    );
    const feedback = request?.stageContext.feedback as string;
    expect(feedback.length).toBeLessThan(9_000);
    expect(feedback).toMatch(/\[TRUNCATED\]$/);
  });
});
