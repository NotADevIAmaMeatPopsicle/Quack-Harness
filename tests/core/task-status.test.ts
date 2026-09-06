import {
  TASK_STATUSES,
  isTaskStatus,
  normalizeTaskStatus,
  stripTaskStatusAnnotation,
} from "../../src/core/task-status.js";

describe("task status constants", () => {
  it("normalizes supported status aliases through one canonical list", () => {
    expect(TASK_STATUSES).toEqual([
      "BACKLOG",
      "READY",
      "IN_PROGRESS",
      "BLOCKED",
      "ON_HOLD",
      "DECOMPOSED",
      "VERIFYING",
      "COMPLETE",
      "VERIFIED",
      "REJECTED",
    ]);
    expect(normalizeTaskStatus("on-hold")).toBe("ON_HOLD");
    expect(normalizeTaskStatus("in progress")).toBe("IN_PROGRESS");
    expect(normalizeTaskStatus("READY (waiting for review)")).toBe("READY");
    expect(normalizeTaskStatus("done")).toBeNull();
  });

  it("checks canonical status values", () => {
    expect(isTaskStatus("READY")).toBe(true);
    expect(isTaskStatus("DONE")).toBe(false);
    expect(stripTaskStatusAnnotation("COMPLETE (verified manually)")).toBe("COMPLETE");
  });
});
