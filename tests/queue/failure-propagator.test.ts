import { propagateFailure } from "../../src/queue/failure-propagator";
import type { QueueItem } from "../../src/queue/queue-types";

function makeItem(
  taskId: string,
  status: QueueItem["status"],
  blockedBy: string[] = [],
): QueueItem {
  return {
    taskId,
    status,
    priority: 0,
    blockedBy,
    enqueuedAt: new Date().toISOString(),
    retryCount: 0,
  };
}

describe("propagateFailure", () => {
  describe("fail_fast", () => {
    it("marks all remaining queued/ready tasks as skipped on first failure", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "queued")],
        ["TASK-003", makeItem("TASK-003", "ready")],
        ["TASK-004", makeItem("TASK-004", "completed")],
        ["TASK-005", makeItem("TASK-005", "running")],
      ]);

      const result = propagateFailure("TASK-001", items, "fail_fast");

      expect(result.skipped).toContain("TASK-002");
      expect(result.skipped).toContain("TASK-003");
      // Completed and running tasks should not be skipped
      expect(result.skipped).not.toContain("TASK-004");
      expect(result.skipped).not.toContain("TASK-005");
      expect(result.skipped).not.toContain("TASK-001");
      expect(result.blocked).toEqual([]);
    });

    it("returns reason string including failed task ID", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "queued")],
      ]);

      const result = propagateFailure("TASK-001", items, "fail_fast");

      expect(result.reason).toContain("TASK-001");
      expect(result.reason).toContain("fail_fast");
    });
  });

  describe("skip_dependents", () => {
    it("blocks only direct dependents, independent tasks continue", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "queued", ["TASK-001"])],
        ["TASK-003", makeItem("TASK-003", "queued")], // independent
      ]);

      const result = propagateFailure("TASK-001", items, "skip_dependents");

      expect(result.blocked).toContain("TASK-002");
      expect(result.blocked).not.toContain("TASK-003");
      expect(result.skipped).toEqual([]);
    });

    it("transitively blocks dependents (A→B→C, A fails → B and C blocked)", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-A", makeItem("TASK-A", "failed")],
        ["TASK-B", makeItem("TASK-B", "queued", ["TASK-A"])],
        ["TASK-C", makeItem("TASK-C", "queued", ["TASK-B"])],
        ["TASK-D", makeItem("TASK-D", "ready")], // independent
      ]);

      const result = propagateFailure("TASK-A", items, "skip_dependents");

      expect(result.blocked).toContain("TASK-B");
      expect(result.blocked).toContain("TASK-C");
      expect(result.blocked).not.toContain("TASK-D");
    });

    it("does not block running or completed dependents", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "running", ["TASK-001"])],
        ["TASK-003", makeItem("TASK-003", "completed", ["TASK-001"])],
      ]);

      const result = propagateFailure("TASK-001", items, "skip_dependents");

      expect(result.blocked).toEqual([]);
    });

    it("handles diamond dependencies correctly", () => {
      // A fails, B and C depend on A, D depends on both B and C
      const items = new Map<string, QueueItem>([
        ["TASK-A", makeItem("TASK-A", "failed")],
        ["TASK-B", makeItem("TASK-B", "queued", ["TASK-A"])],
        ["TASK-C", makeItem("TASK-C", "queued", ["TASK-A"])],
        ["TASK-D", makeItem("TASK-D", "queued", ["TASK-B", "TASK-C"])],
      ]);

      const result = propagateFailure("TASK-A", items, "skip_dependents");

      expect(result.blocked).toContain("TASK-B");
      expect(result.blocked).toContain("TASK-C");
      expect(result.blocked).toContain("TASK-D");
    });

    it("mixed: some tasks blocked, some independent continue", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "queued", ["TASK-001"])],
        ["TASK-003", makeItem("TASK-003", "ready")],
        ["TASK-004", makeItem("TASK-004", "queued")],
        ["TASK-005", makeItem("TASK-005", "queued", ["TASK-002"])],
      ]);

      const result = propagateFailure("TASK-001", items, "skip_dependents");

      expect(result.blocked).toContain("TASK-002");
      expect(result.blocked).toContain("TASK-005");
      expect(result.blocked).not.toContain("TASK-003");
      expect(result.blocked).not.toContain("TASK-004");
    });
  });

  describe("continue_all", () => {
    it("does not block or skip any tasks on failure", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "queued", ["TASK-001"])],
        ["TASK-003", makeItem("TASK-003", "ready")],
      ]);

      const result = propagateFailure("TASK-001", items, "continue_all");

      expect(result.blocked).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.reason).toContain("continue_all");
    });
  });

  describe("edge cases", () => {
    it("handles empty queue", () => {
      const items = new Map<string, QueueItem>([["TASK-001", makeItem("TASK-001", "failed")]]);

      const result = propagateFailure("TASK-001", items, "skip_dependents");

      expect(result.blocked).toEqual([]);
      expect(result.skipped).toEqual([]);
    });

    it("handles no remaining queued tasks in fail_fast", () => {
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "failed")],
        ["TASK-002", makeItem("TASK-002", "completed")],
      ]);

      const result = propagateFailure("TASK-001", items, "fail_fast");

      expect(result.skipped).toEqual([]);
    });
  });
});
