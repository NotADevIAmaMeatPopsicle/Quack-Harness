// ─── Post-Run Analyzer Tests ───────────────────────────────────────

import { analyzeRun } from "../../src/analytics/post-run-analyzer.js";
import type { ParsedTask, AgentResult, JudgeResult } from "../../src/core/types.js";

describe("Post-Run Analyzer", () => {
  const mockTask: ParsedTask = {
    id: "TASK-001",
    title: "Test Task",
    priority: "P1-HIGH",
    effort: "2-4 hours",
    status: "IN_PROGRESS",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["backend", "api"],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [
      { path: "src/server.ts", action: "Modify", notes: "Add endpoint" },
      { path: "tests/server.test.ts", action: "Modify", notes: "Add tests" },
    ],
    successCriteria: ["Endpoint works", "Tests pass"],
    testingRequirements: ["Run tests"],
    contextReferences: [],
    rawContent: "# TASK-001",
  };

  const mockAgentResult: AgentResult = {
    taskId: "TASK-001",
    outcome: "success",
    filesModified: ["src/server.ts"],
    filesCreated: ["tests/server.test.ts"],
    verification: null,
    turnsUsed: 10,
    totalCostUsd: 0.25,
    messages: [],
  };

  const mockJudgeResult: JudgeResult = {
    verdict: "APPROVE",
    confidence: 0.9,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [],
    feedback: "Good implementation. Tests pass and lint is clean.",
    criteriaEvaluation: [
      {
        criterion: "Endpoint works",
        status: "PASS",
        evidence: "src/server.ts:42",
        reasoning: "Endpoint implemented correctly",
        enforcement_type: "deterministic_code",
      },
      {
        criterion: "Tests pass",
        status: "PASS",
        evidence: "tests/server.test.ts:10",
        reasoning: "All tests passing",
        enforcement_type: "deterministic_code",
      },
    ],
  };

  it("should extract RunAnalysis from approved session", () => {
    const analysis = analyzeRun({
      sessionId: "session-001",
      task: mockTask,
      agentResult: mockAgentResult,
      judgeResult: mockJudgeResult,
      outcome: "approved",
      totalCostUsd: 0.25,
      durationMs: 120000,
      retriesUsed: 0,
      gateScore: 4.2,
      blueprintMetrics: { fileAnalyses: 3, codeExamples: 5 },
    });

    expect(analysis.taskId).toBe("TASK-001");
    expect(analysis.sessionId).toBe("session-001");
    expect(analysis.outcome).toBe("approved");
    expect(analysis.costUsd).toBe(0.25);
    expect(analysis.turnsUsed).toBe(10);
    expect(analysis.retriesUsed).toBe(0);
    expect(analysis.taskTags).toEqual(["backend", "api"]);
    expect(analysis.targetFiles).toEqual(["src/server.ts", "tests/server.test.ts"]);
    expect(analysis.criteriaResults).toHaveLength(2);
    expect(analysis.criteriaResults[0].criterion).toBe("Endpoint works");
    expect(analysis.criteriaResults[0].status).toBe("PASS");
    expect(analysis.gateScore).toBe(4.2);
    expect(analysis.blueprintMetrics).toEqual({ fileAnalyses: 3, codeExamples: 5 });
    expect(analysis.complexity.filesToModify).toBe(2);
    expect(analysis.complexity.successCriteria).toBe(2);
  });

  it("should extract feedback themes from judge feedback", () => {
    const judgeWithThemes: JudgeResult = {
      ...mockJudgeResult,
      feedback:
        "Tests are failing. Lint errors detected. Missing error handling for edge cases. Type errors in module.",
    };

    const analysis = analyzeRun({
      sessionId: "session-002",
      task: mockTask,
      judgeResult: judgeWithThemes,
      outcome: "rejected",
      totalCostUsd: 0.15,
      durationMs: 60000,
      retriesUsed: 2,
    });

    expect(analysis.feedbackThemes).toContain("test_failures");
    expect(analysis.feedbackThemes).toContain("lint_errors");
    expect(analysis.feedbackThemes).toContain("type_errors");
    expect(analysis.feedbackThemes).toContain("error_handling_gaps");
    expect(analysis.feedbackThemes).toContain("edge_case_gaps");
  });

  it("should handle missing judge result", () => {
    const analysis = analyzeRun({
      sessionId: "session-003",
      task: mockTask,
      outcome: "error",
      totalCostUsd: 0.05,
      durationMs: 10000,
      retriesUsed: 0,
    });

    expect(analysis.outcome).toBe("error");
    expect(analysis.criteriaResults).toEqual([]);
    expect(analysis.feedbackThemes).toEqual([]);
  });

  it("should classify complexity correctly", () => {
    const simpleTask: ParsedTask = {
      ...mockTask,
      filesToModify: [{ path: "file.ts", action: "Modify", notes: "Simple change" }],
      successCriteria: ["Criterion 1", "Criterion 2"],
    };

    const analysis = analyzeRun({
      sessionId: "session-004",
      task: simpleTask,
      outcome: "approved",
      totalCostUsd: 0.1,
      durationMs: 30000,
      retriesUsed: 0,
    });

    expect(analysis.complexity.filesToModify).toBe(1);
    expect(analysis.complexity.successCriteria).toBe(2);
  });
});
