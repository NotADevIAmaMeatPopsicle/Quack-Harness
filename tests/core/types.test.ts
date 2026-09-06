import type { ParsedTask, AdapterConfig, JudgeResult, SessionResult } from "../../src/core/types";

describe("core types", () => {
  it("should allow constructing a ParsedTask", () => {
    const task: ParsedTask = {
      id: "TASK-001",
      title: "Test Task",
      priority: "P2-MEDIUM",
      effort: "2-3 hours",
      status: "BACKLOG",
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      blockedBy: [],
      blocks: ["TASK-002"],
      conventions: [],
      tags: ["test"],
      problemStatement: "Need to test types",
      currentState: "",
      recommendedApproach: "",
      filesToModify: [{ path: "src/foo.ts", action: "Create", notes: "new file" }],
      successCriteria: ["Types compile"],
      testingRequirements: ["Type test passes"],
      contextReferences: [],
      rawContent: "# TASK-001: Test Task",
    };

    expect(task.id).toBe("TASK-001");
    expect(task.priority).toBe("P2-MEDIUM");
    expect(task.blocks).toContain("TASK-002");
  });

  it("should allow constructing an AdapterConfig", () => {
    const config: AdapterConfig = {
      version: "1.0",
      project: {
        name: "test-project",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {
        model: "claude-opus-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 50,
        maxBudgetPerTask: 5.0,
        maxRetries: 1,
      },
      verification: {
        commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: ["src/", "tests/"],
        deniedPaths: [".env"],
        allowedBashPatterns: ["npm test *"],
        deniedBashPatterns: ["rm *"],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Implemented-by: Quack Agent",
        autoCreatePr: true,
        autoPush: true,
      },
      logging: {
        dir: ".quack/logs",
        level: "debug",
        retainDays: 30,
      },
    };

    expect(config.project.name).toBe("test-project");
    expect(config.verification.commands).toHaveLength(1);
  });

  it("should allow constructing a JudgeResult", () => {
    const result: JudgeResult = {
      verdict: "APPROVE",
      confidence: 0.92,
      scopeViolations: [],
      criteriaGaps: [],
      qualityIssues: [],
      feedback: "",
    };

    expect(result.verdict).toBe("APPROVE");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("should allow constructing a SessionResult", () => {
    const session: SessionResult = {
      sessionId: "quack-TASK-001-20260214",
      taskId: "TASK-001",
      project: "test-project",
      startTime: "2026-02-14T10:00:00Z",
      endTime: "2026-02-14T10:30:00Z",
      durationMs: 1800000,
      model: "claude-opus-4-6",
      totalCostUsd: 2.5,
      turnsUsed: 25,
      turnsMax: 50,
      readinessGate: { schemaValid: true, depthScore: 4.2, enriched: false },
      filesModified: ["src/foo.ts"],
      filesCreated: ["src/bar.ts"],
      verification: {
        allPassed: true,
        commands: [{ name: "tests", passed: true, output: "10 passed" }],
        conventionChecks: [],
      },
      judgeResult: {
        verdict: "APPROVE",
        confidence: 0.95,
        scopeViolations: [],
        criteriaGaps: [],
        qualityIssues: [],
        feedback: "",
      },
      result: "success",
      prUrl: "https://github.com/org/repo/pull/1",
    };

    expect(session.result).toBe("success");
    expect(session.readinessGate.schemaValid).toBe(true);
  });
});
