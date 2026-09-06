import { findBestTemplate } from "../../src/templates/template-matcher.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { TemplateRegistry } from "../../src/templates/template-types.js";

function makeTask(overrides: Partial<ParsedTask>): ParsedTask {
  return {
    id: "TASK-001",
    title: "Test Task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
    status: "BACKLOG",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [],
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "",
    ...overrides,
  };
}

function makeRegistry(): TemplateRegistry {
  return {
    updatedAt: "2024-01-01T00:00:00Z",
    templates: [
      {
        category: "dashboard-feature",
        sourceTaskId: "TASK-015",
        specTemplate: "Add dashboard feature...",
        successRate: 0.9,
        avgCostUsd: 5.0,
        filePatterns: ["src/monitor", "tests/monitor"],
        fileCount: 3,
        tags: ["dashboard", "ui"],
      },
      {
        category: "api-endpoint",
        sourceTaskId: "TASK-020",
        specTemplate: "Add API endpoint...",
        successRate: 0.85,
        avgCostUsd: 3.0,
        filePatterns: ["src/api", "tests/api"],
        fileCount: 2,
        tags: ["api", "backend"],
      },
      {
        category: "testing",
        sourceTaskId: "TASK-023",
        specTemplate: "Add tests...",
        successRate: 0.95,
        avgCostUsd: 2.0,
        filePatterns: ["tests/templates"],
        fileCount: 1,
        tags: ["testing"],
      },
    ],
    categoryStats: {
      "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      "dashboard-feature": { count: 1, avgSuccessRate: 0.9, avgCostUsd: 5.0 },
      "api-endpoint": { count: 1, avgSuccessRate: 0.85, avgCostUsd: 3.0 },
      testing: { count: 1, avgSuccessRate: 0.95, avgCostUsd: 2.0 },
      configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
    },
  };
}

describe("template-matcher", () => {
  describe("findBestTemplate", () => {
    it("should return match when category and tags overlap", () => {
      const task = makeTask({
        tags: ["dashboard", "ui"],
        filesToModify: [{ path: "src/monitor/widget.ts", action: "Create", notes: "" }],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      expect(match!.template.sourceTaskId).toBe("TASK-015");
      expect(match!.score).toBeGreaterThan(0.3);
      expect(match!.matchReasons).toContain("same category");
    });

    it("should return null when no template matches above threshold", () => {
      const task = makeTask({
        tags: ["random", "unknown"],
        filesToModify: [{ path: "src/other/file.ts", action: "Create", notes: "" }],
        problemStatement: "Some random task",
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).toBeNull();
    });

    it("should score file pattern overlap correctly", () => {
      const task = makeTask({
        tags: ["api"],
        filesToModify: [
          { path: "src/api/handler.ts", action: "Create", notes: "" },
          { path: "tests/api/handler.test.ts", action: "Create", notes: "" },
        ],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      expect(match!.template.sourceTaskId).toBe("TASK-020");
      expect(match!.matchReasons).toContain("same category");
      expect(match!.matchReasons.some((r) => r.includes("shared file patterns"))).toBe(true);
    });

    it("should prefer high success rate templates", () => {
      const task = makeTask({
        tags: ["testing"],
        filesToModify: [{ path: "tests/templates/foo.test.ts", action: "Create", notes: "" }],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      expect(match!.template.sourceTaskId).toBe("TASK-023");
      expect(match!.template.successRate).toBeGreaterThan(0.8);
      expect(match!.matchReasons).toContain("high success rate");
    });

    it("should score overlapping tags correctly", () => {
      const task = makeTask({
        tags: ["dashboard", "ui", "monitoring"],
        filesToModify: [{ path: "src/monitor/dashboard.ts", action: "Modify", notes: "" }],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      const tagMatch = match!.matchReasons.find((r) => r.includes("shared tags"));
      expect(tagMatch).toBeDefined();
    });

    it("should score similar complexity correctly", () => {
      const task = makeTask({
        tags: ["api"],
        filesToModify: [
          { path: "src/api/foo.ts", action: "Create", notes: "" },
          { path: "src/api/bar.ts", action: "Create", notes: "" },
        ],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      expect(match!.matchReasons).toContain("similar complexity");
    });

    it("should return the highest scoring match", () => {
      const task = makeTask({
        tags: ["dashboard", "ui"],
        filesToModify: [
          { path: "src/monitor/widget.ts", action: "Create", notes: "" },
          { path: "tests/monitor/widget.test.ts", action: "Create", notes: "" },
        ],
      });
      const registry = makeRegistry();

      const match = findBestTemplate(task, registry);

      expect(match).not.toBeNull();
      expect(match!.template.sourceTaskId).toBe("TASK-015");
      expect(match!.score).toBeGreaterThan(0.5); // Should score high with category + tags + files
    });

    it("should return null for empty registry", () => {
      const task = makeTask({ tags: ["dashboard"] });
      const emptyRegistry: TemplateRegistry = {
        updatedAt: "2024-01-01T00:00:00Z",
        templates: [],
        categoryStats: {
          "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        },
      };

      const match = findBestTemplate(task, emptyRegistry);

      expect(match).toBeNull();
    });
  });
});
