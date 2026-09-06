import { extractTemplate } from "../../src/templates/template-extractor.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { RunAnalysis } from "../../src/analytics/analytics-types.js";

function makeTask(overrides: Partial<ParsedTask>): ParsedTask {
  return {
    id: "TASK-042",
    title: "Test Task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
    status: "COMPLETE",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["dashboard", "ui"],
    problemStatement: "Add a new dashboard widget for TASK-042.",
    currentState: "No widget exists.",
    recommendedApproach: "Create widget component in src/monitor/widget.ts.",
    filesToModify: [
      { path: "src/monitor/widget.ts", action: "Create", notes: "Widget component" },
      { path: "tests/monitor/widget.test.ts", action: "Create", notes: "Unit tests" },
    ],
    successCriteria: ["Widget renders"],
    testingRequirements: ["Unit tests pass"],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "# TASK-042 content",
    ...overrides,
  };
}

function makeRunHistory(overrides?: Partial<RunAnalysis>[]): RunAnalysis[] {
  const defaults: RunAnalysis[] = [
    {
      taskId: "TASK-042",
      sessionId: "session-1",
      outcome: "approved",
      costUsd: 5.0,
      turnsUsed: 10,
      retriesUsed: 0,
      taskTags: ["dashboard", "ui"],
      targetFiles: ["src/monitor/widget.ts"],
      criteriaResults: [{ criterion: "Widget renders", status: "PASS" }],
      feedbackThemes: [],
      gateScore: 4.5,
      complexity: { filesToModify: 2, successCriteria: 1 },
    },
    {
      taskId: "TASK-042",
      sessionId: "session-2",
      outcome: "approved",
      costUsd: 3.0,
      turnsUsed: 8,
      retriesUsed: 0,
      taskTags: ["dashboard", "ui"],
      targetFiles: ["src/monitor/widget.ts"],
      criteriaResults: [{ criterion: "Widget renders", status: "PASS" }],
      feedbackThemes: [],
      gateScore: 4.0,
      complexity: { filesToModify: 2, successCriteria: 1 },
    },
  ];
  if (overrides) {
    return overrides.map((o, i) => ({ ...defaults[i % defaults.length], ...o }));
  }
  return defaults;
}

describe("template-extractor", () => {
  describe("extractTemplate", () => {
    it("should produce a valid template from a completed task", () => {
      const task = makeTask({});
      const runs = makeRunHistory();

      const template = extractTemplate(task, runs);

      expect(template.sourceTaskId).toBe("TASK-042");
      expect(template.category).toBe("dashboard-feature");
      expect(template.tags).toEqual(["dashboard", "ui"]);
      expect(template.filePatterns).toContain("src/monitor");
      expect(template.filePatterns).toContain("tests/monitor");
      expect(template.fileCount).toBe(2);
      expect(typeof template.specTemplate).toBe("string");
      expect(template.specTemplate.length).toBeGreaterThan(0);
    });

    it("should calculate success rate from run history", () => {
      const task = makeTask({});
      const runs = makeRunHistory([
        { outcome: "approved", costUsd: 5.0 },
        { outcome: "rejected", costUsd: 3.0 },
      ]);

      const template = extractTemplate(task, runs);

      expect(template.successRate).toBe(0.5); // 1 approved / 2 total
    });

    it("should calculate 100% success rate when all approved", () => {
      const task = makeTask({});
      const runs = makeRunHistory();

      const template = extractTemplate(task, runs);

      expect(template.successRate).toBe(1.0);
    });

    it("should calculate 0% success rate when all rejected", () => {
      const task = makeTask({});
      const runs = makeRunHistory([
        { outcome: "rejected", costUsd: 2.0 },
        { outcome: "rejected", costUsd: 3.0 },
      ]);

      const template = extractTemplate(task, runs);

      expect(template.successRate).toBe(0);
    });

    it("should calculate average cost from run history", () => {
      const task = makeTask({});
      const runs = makeRunHistory(); // costs: 5.0 and 3.0

      const template = extractTemplate(task, runs);

      expect(template.avgCostUsd).toBe(4.0); // (5 + 3) / 2
    });

    it("should handle empty run history gracefully", () => {
      const task = makeTask({});

      const template = extractTemplate(task, []);

      expect(template.successRate).toBe(0);
      expect(template.avgCostUsd).toBe(0);
    });

    it("should extract directory-level file patterns", () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/templates/foo.ts", action: "Create", notes: "" },
          { path: "src/templates/bar.ts", action: "Create", notes: "" },
          { path: "tests/templates/foo.test.ts", action: "Create", notes: "" },
        ],
      });

      const template = extractTemplate(task, []);

      expect(template.filePatterns).toContain("src/templates");
      expect(template.filePatterns).toContain("tests/templates");
      // Deduplicated: not ['src/templates', 'src/templates', 'tests/templates']
      expect(template.filePatterns.length).toBe(2);
    });

    it("should truncate specTemplate to avoid oversized templates", () => {
      const longProblem = "A".repeat(800);
      const longApproach = "B".repeat(800);
      const task = makeTask({
        problemStatement: longProblem,
        recommendedApproach: longApproach,
      });

      const template = extractTemplate(task, []);

      // specTemplate should be capped (anonymizeSpec slices to 1000)
      expect(template.specTemplate.length).toBeLessThanOrEqual(1000);
    });

    it("should anonymize task-specific identifiers in specTemplate", () => {
      const task = makeTask({
        id: "TASK-099",
        problemStatement: "Fix the TASK-099 authentication flow using AuthService.",
        recommendedApproach: "Modify src/auth/AuthService.ts to add token refresh.",
      });

      const template = extractTemplate(task, []);

      // Should replace TASK-NNN references
      expect(template.specTemplate).not.toContain("TASK-099");
      // Should replace PascalCase identifiers with placeholders
      expect(template.specTemplate).not.toContain("AuthService");
    });

    it("should set fileCount from filesToModify length", () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
          { path: "src/c.ts", action: "Create", notes: "" },
        ],
      });

      const template = extractTemplate(task, []);

      expect(template.fileCount).toBe(3);
    });
  });
});
