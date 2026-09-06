import { categorizeTask } from "../../src/templates/task-categorizer.js";
import type { ParsedTask } from "../../src/core/types.js";

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

describe("task-categorizer", () => {
  describe("categorizeTask", () => {
    it("should categorize dashboard feature by tag", () => {
      const task = makeTask({ tags: ["dashboard"] });
      expect(categorizeTask(task)).toBe("dashboard-feature");
    });

    it("should categorize dashboard feature by ui tag", () => {
      const task = makeTask({ tags: ["ui"] });
      expect(categorizeTask(task)).toBe("dashboard-feature");
    });

    it("should categorize api endpoint by tag", () => {
      const task = makeTask({ tags: ["api"] });
      expect(categorizeTask(task)).toBe("api-endpoint");
    });

    it("should categorize testing by tag", () => {
      const task = makeTask({ tags: ["testing"] });
      expect(categorizeTask(task)).toBe("testing");
    });

    it("should categorize bug fix by tag", () => {
      const task = makeTask({ tags: ["bug"] });
      expect(categorizeTask(task)).toBe("bug-fix");
    });

    it("should categorize refactor by tag", () => {
      const task = makeTask({ tags: ["refactor"] });
      expect(categorizeTask(task)).toBe("refactor");
    });

    it("should categorize configuration by tag", () => {
      const task = makeTask({ tags: ["configuration"] });
      expect(categorizeTask(task)).toBe("configuration");
    });

    it("should categorize infrastructure by tag", () => {
      const task = makeTask({ tags: ["infra"] });
      expect(categorizeTask(task)).toBe("infrastructure");
    });

    it("should categorize integration by tag", () => {
      const task = makeTask({ tags: ["integration"] });
      expect(categorizeTask(task)).toBe("integration");
    });

    it("should categorize dashboard feature by file pattern", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/monitor/public/index.html", action: "Modify", notes: "" }],
      });
      expect(categorizeTask(task)).toBe("dashboard-feature");
    });

    it("should categorize api endpoint by file pattern", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/api/endpoint.ts", action: "Create", notes: "" }],
      });
      expect(categorizeTask(task)).toBe("api-endpoint");
    });

    it("should categorize testing by test file pattern", () => {
      const task = makeTask({
        filesToModify: [{ path: "tests/foo.test.ts", action: "Create", notes: "" }],
      });
      expect(categorizeTask(task)).toBe("testing");
    });

    it("should categorize new module when all creates", () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/foo/bar.ts", action: "Create", notes: "" },
          { path: "src/foo/baz.ts", action: "Create", notes: "" },
        ],
      });
      expect(categorizeTask(task)).toBe("new-module");
    });

    it("should categorize integration by problem statement", () => {
      const task = makeTask({
        problemStatement: "Integrate the new API with the existing dashboard",
      });
      expect(categorizeTask(task)).toBe("integration");
    });

    it("should categorize bug fix by problem statement", () => {
      const task = makeTask({
        problemStatement: "Fix the broken authentication flow",
      });
      expect(categorizeTask(task)).toBe("bug-fix");
    });

    it("should categorize refactor by problem statement", () => {
      const task = makeTask({
        problemStatement: "Refactor the logging module to improve performance",
      });
      expect(categorizeTask(task)).toBe("refactor");
    });

    it("should default to integration when modifying files", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/foo/bar.ts", action: "Modify", notes: "" }],
      });
      expect(categorizeTask(task)).toBe("integration");
    });

    it("should default to new-module when no files to modify", () => {
      const task = makeTask({ filesToModify: [] });
      expect(categorizeTask(task)).toBe("new-module");
    });
  });
});
