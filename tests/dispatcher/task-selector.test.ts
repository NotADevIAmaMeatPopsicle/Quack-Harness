import type { TaskPriority, FileModification } from "../../src/core/types";
import type { TaskSummary } from "../../src/dispatcher/dependency-resolver";

const taskSelector =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/dispatcher/task-selector") as typeof import("../../src/dispatcher/task-selector");
const { parseEffort, estimateAgentFit, computeReadinessScore, selectTasks } = taskSelector;

function makeTaskSummary(
  id: string,
  opts: {
    priority?: TaskPriority;
    effort?: string;
    conventions?: string[];
    testingReqs?: string[];
    filesToModify?: FileModification[];
    currentState?: string;
    recommendedApproach?: string;
    successCriteria?: string[];
    contextReferences?: string[];
  } = {},
): TaskSummary {
  return {
    id,
    status: "BACKLOG" as const,
    blockedBy: [],
    task: {
      id,
      title: `Task ${id}`,
      priority: opts.priority ?? "P2-MEDIUM",
      effort: opts.effort ?? "4 hours",
      status: "BACKLOG" as const,
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      blockedBy: [],
      blocks: [],
      conventions: opts.conventions ?? [],
      tags: [],
      problemStatement: "Test problem",
      currentState: opts.currentState ?? "",
      recommendedApproach: opts.recommendedApproach ?? "",
      filesToModify: opts.filesToModify ?? [],
      successCriteria: opts.successCriteria ?? ["criterion"],
      testingRequirements: opts.testingReqs ?? ["requirement"],
      contextReferences: opts.contextReferences ?? [],
      rawContent: "",
    },
  };
}

describe("task-selector", () => {
  describe("parseEffort", () => {
    test("should parse range like '4-6 hours'", () => {
      expect(parseEffort("4-6 hours")).toBe(4);
    });

    test("should parse single number like '2 hours'", () => {
      expect(parseEffort("2 hours")).toBe(2);
    });

    test("should parse bare number", () => {
      expect(parseEffort("8")).toBe(8);
    });

    test("should return Infinity for unparseable string", () => {
      expect(parseEffort("unknown")).toBe(Infinity);
    });

    test("should use lower bound of range", () => {
      expect(parseEffort("6-8 hours")).toBe(6);
    });
  });

  describe("estimateAgentFit", () => {
    test("should return 'high' for well-specified tasks", () => {
      const task = makeTaskSummary("TASK-001", {
        conventions: ["ADR-012"],
        testingReqs: ["test requirement"],
        filesToModify: [{ path: "src/foo.ts", action: "Create", notes: "" }],
        effort: "4 hours",
      });
      expect(estimateAgentFit(task)).toBe("high");
    });

    test("should return 'low' for minimal tasks", () => {
      const task = makeTaskSummary("TASK-001", {
        conventions: [],
        testingReqs: [],
        filesToModify: [],
        effort: "20 hours",
      });
      expect(estimateAgentFit(task)).toBe("low");
    });

    test("should return 'medium' for partially specified tasks", () => {
      // testingReqs (2) + no filesToModify (0) + effort > 8 (0) = 2 -> medium
      const task = makeTaskSummary("TASK-001", {
        conventions: [],
        testingReqs: ["requirement"],
        filesToModify: [],
        effort: "12 hours",
      });
      expect(estimateAgentFit(task)).toBe("medium");
    });
  });

  describe("computeReadinessScore", () => {
    test("should give higher score to fully specified tasks", () => {
      const fullTask = makeTaskSummary("TASK-001", {
        currentState: "Has current state",
        recommendedApproach: "Has approach",
        filesToModify: [{ path: "src/foo.ts", action: "Create", notes: "" }],
        conventions: ["ADR-001"],
        contextReferences: ["ref1"],
        successCriteria: ["c1", "c2", "c3"],
      });

      const minimalTask = makeTaskSummary("TASK-002", {});

      const fullScore = computeReadinessScore(fullTask);
      const minimalScore = computeReadinessScore(minimalTask);

      expect(fullScore).toBeGreaterThan(minimalScore);
    });

    test("should cap at 100", () => {
      const task = makeTaskSummary("TASK-001", {
        currentState: "Has state",
        recommendedApproach: "Has approach",
        filesToModify: [{ path: "src/foo.ts", action: "Create", notes: "" }],
        conventions: ["ADR-001"],
        contextReferences: ["ref1"],
        successCriteria: ["c1", "c2", "c3"],
      });

      expect(computeReadinessScore(task)).toBeLessThanOrEqual(100);
    });
  });

  describe("selectTasks", () => {
    test("should sort by priority (P0 first)", () => {
      const tasks = [
        makeTaskSummary("TASK-003", { priority: "P2-MEDIUM" }),
        makeTaskSummary("TASK-001", { priority: "P0-CRITICAL" }),
        makeTaskSummary("TASK-002", { priority: "P1-HIGH" }),
      ];

      const sorted = selectTasks(tasks);

      expect(sorted[0].taskId).toBe("TASK-001");
      expect(sorted[1].taskId).toBe("TASK-002");
      expect(sorted[2].taskId).toBe("TASK-003");
    });

    test("should sort by effort within same priority", () => {
      const tasks = [
        makeTaskSummary("TASK-001", {
          priority: "P1-HIGH",
          effort: "8 hours",
        }),
        makeTaskSummary("TASK-002", {
          priority: "P1-HIGH",
          effort: "2 hours",
        }),
        makeTaskSummary("TASK-003", {
          priority: "P1-HIGH",
          effort: "4 hours",
        }),
      ];

      const sorted = selectTasks(tasks);

      expect(sorted[0].taskId).toBe("TASK-002");
      expect(sorted[1].taskId).toBe("TASK-003");
      expect(sorted[2].taskId).toBe("TASK-001");
    });

    test("should return empty array for empty input", () => {
      const sorted = selectTasks([]);
      expect(sorted).toEqual([]);
    });

    test("should populate TaskSelection fields correctly", () => {
      const tasks = [
        makeTaskSummary("TASK-001", {
          priority: "P1-HIGH",
          effort: "4-6 hours",
          conventions: ["ADR-001"],
          testingReqs: ["test req"],
        }),
      ];

      const sorted = selectTasks(tasks);

      expect(sorted).toHaveLength(1);
      expect(sorted[0].taskId).toBe("TASK-001");
      expect(sorted[0].priority).toBe("P1-HIGH");
      expect(sorted[0].effort).toBe("4-6 hours");
      expect(sorted[0].conventions).toEqual(["ADR-001"]);
      expect(sorted[0].hasTestCriteria).toBe(true);
      expect(sorted[0].readinessScore).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(sorted[0].estimatedAgentFit);
    });
  });
});
