import { PrepQueue } from "../../src/monitor/prep-queue";
import type { TaskSummary } from "../../src/monitor/task-service";

/** Helper to create a minimal TaskSummary with sensible defaults. */
function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  const status = overrides.status ?? "READY";
  return {
    title: `Task ${overrides.id}`,
    priority: "P2-MEDIUM",
    effort: "M",
    status,
    effectiveStatus: overrides.effectiveStatus ?? status,
    blockedBy: [],
    blocks: [],
    tags: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    successCriteriaCount: 1,
    needsVerification: false,
    ...overrides,
  };
}

describe("PrepQueue", () => {
  let queue: PrepQueue;

  beforeEach(() => {
    queue = new PrepQueue();
  });

  describe("enqueue", () => {
    it("adds tasks to the queue", () => {
      const tasks = [makeTask({ id: "TASK-001" }), makeTask({ id: "TASK-002" })];

      queue.enqueue(tasks);

      expect(queue.size()).toBe(2);
      expect(queue.toArray()).toContain("TASK-001");
      expect(queue.toArray()).toContain("TASK-002");
    });

    it("skips duplicates already in the queue", () => {
      const task1 = makeTask({ id: "TASK-001" });
      const task2 = makeTask({ id: "TASK-002" });

      queue.enqueue([task1, task2]);
      queue.enqueue([task1, makeTask({ id: "TASK-003" })]);

      expect(queue.size()).toBe(3);
      expect(queue.toArray()).toEqual(expect.arrayContaining(["TASK-001", "TASK-002", "TASK-003"]));
    });

    it("skips duplicates within the same enqueue call", () => {
      const task = makeTask({ id: "TASK-001" });

      queue.enqueue([task, task]);

      expect(queue.size()).toBe(1);
    });
  });

  describe("dequeue", () => {
    it("returns the first item and removes it", () => {
      queue.enqueue([makeTask({ id: "TASK-001" }), makeTask({ id: "TASK-002" })]);

      const item = queue.dequeue();

      expect(item).toBeDefined();
      expect(item!.id).toBe("TASK-001");
      expect(queue.size()).toBe(1);
      expect(queue.toArray()).toEqual(["TASK-002"]);
    });

    it("returns undefined on empty queue", () => {
      const item = queue.dequeue();

      expect(item).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("removes a task by ID and returns true", () => {
      queue.enqueue([
        makeTask({ id: "TASK-001" }),
        makeTask({ id: "TASK-002" }),
        makeTask({ id: "TASK-003" }),
      ]);

      const result = queue.remove("TASK-002");

      expect(result).toBe(true);
      expect(queue.size()).toBe(2);
      expect(queue.toArray()).not.toContain("TASK-002");
    });

    it("returns false for a non-existent task", () => {
      queue.enqueue([makeTask({ id: "TASK-001" })]);

      const result = queue.remove("TASK-999");

      expect(result).toBe(false);
      expect(queue.size()).toBe(1);
    });
  });

  describe("peek", () => {
    it("returns the first item without removing it", () => {
      queue.enqueue([makeTask({ id: "TASK-001" }), makeTask({ id: "TASK-002" })]);

      const item = queue.peek();

      expect(item).toBeDefined();
      expect(item!.id).toBe("TASK-001");
      expect(queue.size()).toBe(2);
    });

    it("returns undefined on empty queue", () => {
      expect(queue.peek()).toBeUndefined();
    });
  });

  describe("size", () => {
    it("returns 0 for a new queue", () => {
      expect(queue.size()).toBe(0);
    });

    it("returns correct count after enqueue and dequeue", () => {
      queue.enqueue([
        makeTask({ id: "TASK-001" }),
        makeTask({ id: "TASK-002" }),
        makeTask({ id: "TASK-003" }),
      ]);
      expect(queue.size()).toBe(3);

      queue.dequeue();
      expect(queue.size()).toBe(2);

      queue.remove("TASK-003");
      expect(queue.size()).toBe(1);
    });
  });

  describe("isEmpty", () => {
    it("returns true when queue is empty", () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it("returns false when queue has items", () => {
      queue.enqueue([makeTask({ id: "TASK-001" })]);

      expect(queue.isEmpty()).toBe(false);
    });

    it("returns true after all items are dequeued", () => {
      queue.enqueue([makeTask({ id: "TASK-001" })]);
      queue.dequeue();

      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe("toArray", () => {
    it("returns ordered task IDs", () => {
      queue.enqueue([
        makeTask({ id: "TASK-003" }),
        makeTask({ id: "TASK-001" }),
        makeTask({ id: "TASK-002" }),
      ]);

      // Default order is priority_then_id; all same priority, so sorted by numeric ID
      expect(queue.toArray()).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    });

    it("returns an empty array for an empty queue", () => {
      expect(queue.toArray()).toEqual([]);
    });
  });

  describe("clear", () => {
    it("empties the queue", () => {
      queue.enqueue([makeTask({ id: "TASK-001" }), makeTask({ id: "TASK-002" })]);
      expect(queue.size()).toBe(2);

      queue.clear();

      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.toArray()).toEqual([]);
    });
  });

  describe("priority_then_id ordering (default)", () => {
    it("sorts P0 before P1 before P2 before P3", () => {
      queue.enqueue([
        makeTask({ id: "TASK-001", priority: "P3-LOW" }),
        makeTask({ id: "TASK-002", priority: "P0-CRITICAL" }),
        makeTask({ id: "TASK-003", priority: "P2-MEDIUM" }),
        makeTask({ id: "TASK-004", priority: "P1-HIGH" }),
      ]);

      expect(queue.toArray()).toEqual([
        "TASK-002", // P0-CRITICAL
        "TASK-004", // P1-HIGH
        "TASK-003", // P2-MEDIUM
        "TASK-001", // P3-LOW
      ]);
    });

    it("tie-breaks same priority by numeric ID", () => {
      queue.enqueue([
        makeTask({ id: "TASK-042", priority: "P1-HIGH" }),
        makeTask({ id: "TASK-007", priority: "P1-HIGH" }),
        makeTask({ id: "TASK-100", priority: "P1-HIGH" }),
      ]);

      expect(queue.toArray()).toEqual(["TASK-007", "TASK-042", "TASK-100"]);
    });

    it("treats unknown priority as lowest", () => {
      queue.enqueue([
        makeTask({ id: "TASK-001", priority: "P3-LOW" }),
        makeTask({ id: "TASK-002", priority: "UNKNOWN" }),
      ]);

      // P3-LOW (weight 3) comes before UNKNOWN (weight 99)
      expect(queue.toArray()).toEqual(["TASK-001", "TASK-002"]);
    });
  });

  describe("id_only ordering", () => {
    it("sorts purely by numeric ID, ignoring priority", () => {
      queue.setPriorityOrder("id_only");

      queue.enqueue([
        makeTask({ id: "TASK-050", priority: "P0-CRITICAL" }),
        makeTask({ id: "TASK-003", priority: "P3-LOW" }),
        makeTask({ id: "TASK-020", priority: "P1-HIGH" }),
      ]);

      expect(queue.toArray()).toEqual(["TASK-003", "TASK-020", "TASK-050"]);
    });
  });

  describe("dependency_chain ordering", () => {
    it("places unblocked tasks before blocked tasks", () => {
      queue.setPriorityOrder("dependency_chain");

      queue.enqueue([
        makeTask({ id: "TASK-001", priority: "P2-MEDIUM", blockedBy: ["TASK-003"] }),
        makeTask({ id: "TASK-002", priority: "P2-MEDIUM", blockedBy: [] }),
        makeTask({ id: "TASK-003", priority: "P2-MEDIUM", blockedBy: [] }),
      ]);

      const order = queue.toArray();
      // TASK-002 and TASK-003 (unblocked) should appear before TASK-001 (blocked)
      expect(order.indexOf("TASK-002")).toBeLessThan(order.indexOf("TASK-001"));
      expect(order.indexOf("TASK-003")).toBeLessThan(order.indexOf("TASK-001"));
    });

    it("sorts unblocked tasks by priority then ID", () => {
      queue.setPriorityOrder("dependency_chain");

      queue.enqueue([
        makeTask({ id: "TASK-010", priority: "P2-MEDIUM", blockedBy: [] }),
        makeTask({ id: "TASK-005", priority: "P0-CRITICAL", blockedBy: [] }),
        makeTask({ id: "TASK-020", priority: "P0-CRITICAL", blockedBy: [] }),
      ]);

      expect(queue.toArray()).toEqual(["TASK-005", "TASK-020", "TASK-010"]);
    });

    it("sorts blocked tasks among themselves by priority then ID", () => {
      queue.setPriorityOrder("dependency_chain");

      queue.enqueue([
        makeTask({ id: "TASK-003", priority: "P1-HIGH", blockedBy: ["TASK-001"] }),
        makeTask({ id: "TASK-004", priority: "P0-CRITICAL", blockedBy: ["TASK-002"] }),
        makeTask({ id: "TASK-001", priority: "P3-LOW", blockedBy: [] }),
      ]);

      // Unblocked first: TASK-001
      // Then blocked sorted by priority: TASK-004 (P0) before TASK-003 (P1)
      expect(queue.toArray()).toEqual(["TASK-001", "TASK-004", "TASK-003"]);
    });
  });

  describe("setPriorityOrder", () => {
    it("re-sorts existing queue items when order changes", () => {
      // Enqueue with default priority_then_id
      queue.enqueue([
        makeTask({ id: "TASK-050", priority: "P0-CRITICAL" }),
        makeTask({ id: "TASK-003", priority: "P3-LOW" }),
        makeTask({ id: "TASK-020", priority: "P1-HIGH" }),
      ]);

      // Default: priority_then_id
      expect(queue.toArray()).toEqual(["TASK-050", "TASK-020", "TASK-003"]);

      // Switch to id_only — should re-sort by numeric ID
      queue.setPriorityOrder("id_only");

      expect(queue.toArray()).toEqual(["TASK-003", "TASK-020", "TASK-050"]);
    });

    it("does not lose items when re-sorting", () => {
      queue.enqueue([
        makeTask({ id: "TASK-001" }),
        makeTask({ id: "TASK-002" }),
        makeTask({ id: "TASK-003" }),
      ]);

      queue.setPriorityOrder("id_only");
      expect(queue.size()).toBe(3);

      queue.setPriorityOrder("dependency_chain");
      expect(queue.size()).toBe(3);

      queue.setPriorityOrder("priority_then_id");
      expect(queue.size()).toBe(3);
    });
  });
});
