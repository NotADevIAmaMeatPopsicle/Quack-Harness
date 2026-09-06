import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { QueuePersistence } from "../../src/queue/queue-persistence";
import type { QueueItem } from "../../src/queue/queue-types";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-qp-"));
}

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
    enqueuedAt: "2024-01-01T00:00:00.000Z",
    retryCount: 0,
  };
}

describe("QueuePersistence", () => {
  let tmpDir: string;
  let persistence: QueuePersistence;

  beforeEach(() => {
    tmpDir = makeTempDir();
    persistence = new QueuePersistence(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("append and readEvents", () => {
    it("writes events to JSONL on state changes", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });

      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_started",
        taskId: "TASK-001",
      });

      const events = persistence.readEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("task_enqueued");
      expect(events[0].taskId).toBe("TASK-001");
      expect(events[1].type).toBe("task_started");
    });

    it("returns empty array for non-existent log", () => {
      const events = persistence.readEvents();
      expect(events).toEqual([]);
    });
  });

  describe("replay", () => {
    it("reconstructs queue state from JSONL on startup", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });
      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-002",
        priority: 1,
        blockedBy: ["TASK-001"],
      });
      persistence.append({
        ts: "2024-01-01T00:02:00.000Z",
        type: "task_ready",
        taskId: "TASK-001",
      });
      persistence.append({
        ts: "2024-01-01T00:03:00.000Z",
        type: "task_started",
        taskId: "TASK-001",
      });
      persistence.append({
        ts: "2024-01-01T00:10:00.000Z",
        type: "task_completed",
        taskId: "TASK-001",
        outcome: "approved",
        costUsd: 1.5,
        durationMs: 420000,
      });

      const items = persistence.replay();

      expect(items.size).toBe(2);

      const task1 = items.get("TASK-001");
      expect(task1).toBeDefined();
      expect(task1!.status).toBe("completed");
      expect(task1!.outcome).toBe("approved");
      expect(task1!.costUsd).toBe(1.5);

      const task2 = items.get("TASK-002");
      expect(task2).toBeDefined();
      expect(task2!.status).toBe("queued");
      expect(task2!.blockedBy).toEqual(["TASK-001"]);
    });

    it("resets running tasks to queued on crash recovery", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });
      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_started",
        taskId: "TASK-001",
      });
      // Simulate crash — no completion event

      const items = persistence.replay();

      const task = items.get("TASK-001");
      expect(task).toBeDefined();
      expect(task!.status).toBe("queued"); // Reset from "running" to "queued"
    });

    it("preserves completed and failed tasks on recovery", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });
      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_completed",
        taskId: "TASK-001",
        outcome: "approved",
      });
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-002",
        priority: 0,
        blockedBy: [],
      });
      persistence.append({
        ts: "2024-01-01T00:02:00.000Z",
        type: "task_failed",
        taskId: "TASK-002",
        outcome: "rejected",
        reason: "judge rejected",
      });

      const items = persistence.replay();

      expect(items.get("TASK-001")!.status).toBe("completed");
      expect(items.get("TASK-002")!.status).toBe("failed");
      expect(items.get("TASK-002")!.error).toBe("judge rejected");
    });

    it("retains the spec_changed outcome when replaying a blocked task", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });
      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_blocked",
        taskId: "TASK-001",
        outcome: "spec_changed",
        reason: "contested id claimed by two files",
      });

      expect(persistence.replay().get("TASK-001")).toMatchObject({
        status: "blocked",
        outcome: "spec_changed",
        blockedReason: "contested id claimed by two files",
      });
    });

    it("returns empty map for empty log", () => {
      // Create empty file
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(logPath, "", "utf-8");

      const items = persistence.replay();
      expect(items.size).toBe(0);
    });

    it("skips malformed JSONL lines gracefully", () => {
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(
        logPath,
        [
          JSON.stringify({
            ts: "2024-01-01T00:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-001",
            priority: 0,
            blockedBy: [],
          }),
          "NOT VALID JSON",
          JSON.stringify({
            ts: "2024-01-01T00:01:00.000Z",
            type: "task_ready",
            taskId: "TASK-001",
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const items = persistence.replay();

      expect(items.size).toBe(1);
      expect(items.get("TASK-001")!.status).toBe("ready");
    });

    it("handles task_unblocked events correctly", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-002",
        priority: 0,
        blockedBy: ["TASK-001"],
      });
      persistence.append({
        ts: "2024-01-01T00:01:00.000Z",
        type: "task_unblocked",
        taskId: "TASK-002",
        reason: "TASK-001",
      });

      const items = persistence.replay();

      const task = items.get("TASK-002");
      expect(task).toBeDefined();
      expect(task!.blockedBy).toEqual([]);
    });
  });

  describe("compact", () => {
    it("produces snapshot and starts fresh log when over limit", () => {
      // Write enough events to trigger compaction check
      // We'll manually verify compact behavior
      const items = new Map<string, QueueItem>([
        ["TASK-001", makeItem("TASK-001", "completed")],
        ["TASK-002", makeItem("TASK-002", "failed")],
      ]);

      // Write many lines to exceed threshold (we mock by writing directly)
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 10001; i++) {
        lines.push(
          JSON.stringify({
            ts: "2024-01-01T00:00:00.000Z",
            type: "task_enqueued",
            taskId: `TASK-${i}`,
          }),
        );
      }
      fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");

      persistence.compact(items);

      // Snapshot should exist
      const snapshotPath = path.join(tmpDir, "dispatch-queue-snapshot.json");
      expect(fs.existsSync(snapshotPath)).toBe(true);

      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as unknown[];
      expect(snapshot).toHaveLength(2);

      // Log should be fresh (empty)
      const newLog = fs.readFileSync(logPath, "utf-8").trim();
      expect(newLog).toBe("");
    });

    it("does not compact when under limit", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
        priority: 0,
        blockedBy: [],
      });

      const items = new Map<string, QueueItem>([["TASK-001", makeItem("TASK-001", "queued")]]);

      persistence.compact(items);

      // Snapshot should not exist
      const snapshotPath = path.join(tmpDir, "dispatch-queue-snapshot.json");
      expect(fs.existsSync(snapshotPath)).toBe(false);

      // Original log should still have the event
      const events = persistence.readEvents();
      expect(events).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("removes all persisted state", () => {
      persistence.append({
        ts: "2024-01-01T00:00:00.000Z",
        type: "task_enqueued",
        taskId: "TASK-001",
      });

      persistence.clear();

      const events = persistence.readEvents();
      expect(events).toEqual([]);
    });
  });
});
