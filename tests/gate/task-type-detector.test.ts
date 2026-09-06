import { ParsedTask, TaskType, TaskPriority, TaskStatus } from "../../src/core/types";
import { detectTaskType } from "../../src/gate/task-type-detector";

function makeTask(tags: string[]): ParsedTask {
  return {
    id: "TASK-092-C",
    title: "Type detector task",
    priority: "P1-HIGH" as TaskPriority,
    effort: "2-3 hours",
    status: "READY" as TaskStatus,
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags,
    problemStatement: "Test task type detection.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-092-C",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
  };
}

describe("detectTaskType", () => {
  test("detects architecture tasks from architecture tags", () => {
    expect(detectTaskType(makeTask(["architecture"]))).toBe(TaskType.Architecture);
    expect(detectTaskType(makeTask(["ADR"]))).toBe(TaskType.Architecture);
  });

  test("detects test tasks from testing tags", () => {
    expect(detectTaskType(makeTask(["e2e"]))).toBe(TaskType.Test);
    expect(detectTaskType(makeTask(["playwright", "frontend"]))).toBe(TaskType.Test);
    expect(detectTaskType(makeTask(["testing"]))).toBe(TaskType.Test);
  });

  test("detects documentation tasks from documentation tags", () => {
    expect(detectTaskType(makeTask(["documentation"]))).toBe(TaskType.Documentation);
    expect(detectTaskType(makeTask(["guides"]))).toBe(TaskType.Documentation);
  });

  test("defaults to code when no matching tags exist", () => {
    expect(detectTaskType(makeTask(["backend", "api"]))).toBe(TaskType.Code);
    expect(detectTaskType(makeTask([]))).toBe(TaskType.Code);
  });
});
