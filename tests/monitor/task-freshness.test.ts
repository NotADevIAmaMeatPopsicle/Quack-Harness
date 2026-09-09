import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  freshDirectoryCount,
  freshReadAllTasks,
  startFreshnessMonitor,
  startupValidation,
} from "../../src/monitor/task-freshness.js";
import { getUnverifiedApprovedTaskIds } from "../../src/monitor/task-service.js";
import type { TaskSessionInfo } from "../../src/monitor/task-service.js";
import type { VerifiedJsonEntry } from "../../src/core/types.js";

// Minimal valid task markdown for testing
function makeTask(id: string, status = "READY"): string {
  return `# ${id}: Test Task

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** ${status}
- **Blocked By:** []
- **Blocks:** []
- **Tags:** test

## Problem Statement
Test problem.

## Success Criteria
- [ ] Test criterion

## Testing Requirements
- [ ] Test requirement
`;
}

describe("task-freshness", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-freshness-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── freshDirectoryCount ───────────────────────────────────────

  describe("freshDirectoryCount", () => {
    it("counts files matching TASK-*.md pattern", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "TASK-002-test.md"), makeTask("TASK-002"));
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Readme");
      await fs.writeFile(path.join(tmpDir, "notes.txt"), "notes");

      const count = await freshDirectoryCount(tmpDir);
      expect(count).toBe(2);
    });

    it("returns 0 for empty directory", async () => {
      const count = await freshDirectoryCount(tmpDir);
      expect(count).toBe(0);
    });

    it("supports custom pattern", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Readme");

      const count = await freshDirectoryCount(tmpDir, /\.md$/);
      expect(count).toBe(2);
    });
  });

  // ─── freshReadAllTasks ─────────────────────────────────────────

  describe("freshReadAllTasks", () => {
    it("reads and parses task files", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "TASK-002-test.md"), makeTask("TASK-002", "COMPLETE"));

      const { tasks, parseErrors } = await freshReadAllTasks(tmpDir);
      expect(tasks).toHaveLength(2);
      expect(parseErrors).toHaveLength(0);
      expect(tasks[0].id).toBe("TASK-001");
      expect(tasks[0].status).toBe("READY");
      expect(tasks[1].id).toBe("TASK-002");
      expect(tasks[1].status).toBe("COMPLETE");
    });

    it("collects parse errors for malformed files", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "TASK-999-bad.md"), "not a valid task");

      const { tasks, parseErrors } = await freshReadAllTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(parseErrors).toHaveLength(1);
      expect(parseErrors[0].file).toBe("TASK-999-bad.md");
    });

    it("ignores non-task files", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Readme");

      const { tasks } = await freshReadAllTasks(tmpDir);
      expect(tasks).toHaveLength(1);
    });

    it("returns tasks sorted by filename", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-003-c.md"), makeTask("TASK-003"));
      await fs.writeFile(path.join(tmpDir, "TASK-001-a.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "TASK-002-b.md"), makeTask("TASK-002"));

      const { tasks } = await freshReadAllTasks(tmpDir);
      expect(tasks.map((t) => t.id)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    });
  });

  // ─── startFreshnessMonitor ─────────────────────────────────────

  describe("startFreshnessMonitor", () => {
    let stopMonitors: Array<() => Promise<void>>;

    beforeEach(() => {
      jest.useFakeTimers();
      stopMonitors = [];
    });

    afterEach(async () => {
      await Promise.allSettled(stopMonitors.map((stop) => stop()));
      jest.useRealTimers();
    });

    it("calls onDrift when disk count differs from parsed count", async () => {
      jest.useRealTimers(); // Use real timers for this async test
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "TASK-002-test.md"), makeTask("TASK-002"));

      const onDrift = jest.fn();
      const stop = startFreshnessMonitor({
        taskDir: tmpDir,
        intervalMs: 100, // Short interval for testing
        getLastParsedCount: () => 1, // Pretend we only know about 1 task
        onDrift,
      });
      stopMonitors.push(stop);

      // Wait for the interval to fire and async callback to resolve
      await new Promise((r) => setTimeout(r, 300));

      expect(onDrift).toHaveBeenCalledWith(2, 1);

      await stop();
    });

    it("does not call onDrift when counts match", async () => {
      jest.useRealTimers();
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));

      const onDrift = jest.fn();
      const stop = startFreshnessMonitor({
        taskDir: tmpDir,
        intervalMs: 100,
        getLastParsedCount: () => 1,
        onDrift,
      });
      stopMonitors.push(stop);

      await new Promise((r) => setTimeout(r, 300));

      expect(onDrift).not.toHaveBeenCalled();

      await stop();
    });

    it("stops when stop function is called", async () => {
      jest.useRealTimers();
      const onDrift = jest.fn();
      const stop = startFreshnessMonitor({
        taskDir: tmpDir,
        intervalMs: 100,
        getLastParsedCount: () => 0,
        onDrift,
      });
      stopMonitors.push(stop);

      await stop();

      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await new Promise((r) => setTimeout(r, 300));

      expect(onDrift).not.toHaveBeenCalled();
    });

    it("waits for an in-flight scan and suppresses callbacks after stop", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));

      const onDrift = jest.fn();
      const stop = startFreshnessMonitor({
        taskDir: tmpDir,
        intervalMs: 100,
        getLastParsedCount: () => 0,
        onDrift,
      });
      stopMonitors.push(stop);

      jest.advanceTimersByTime(100);
      await stop();

      expect(onDrift).not.toHaveBeenCalled();
    });
  });

  // ─── startupValidation ─────────────────────────────────────────

  describe("startupValidation", () => {
    it("logs diagnostic counts without throwing", async () => {
      await fs.writeFile(path.join(tmpDir, "TASK-001-test.md"), makeTask("TASK-001"));
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Readme");

      const logSpy = jest.spyOn(console, "log").mockImplementation();
      await startupValidation(tmpDir);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[task-service] Startup scan:"));
      logSpy.mockRestore();
    });

    it("handles missing directory gracefully", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation();
      await startupValidation(path.join(tmpDir, "nonexistent"));

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task directory not found"));
      logSpy.mockRestore();
    });
  });
});

// ─── getUnverifiedApprovedTaskIds ────────────────────────────────

describe("getUnverifiedApprovedTaskIds", () => {
  it("returns task IDs with approved session but no verified entry", () => {
    const sessions = new Map<string, TaskSessionInfo>([
      ["TASK-001", { outcome: "approved", costUsd: 0.5, status: "completed" }],
      ["TASK-002", { outcome: "rejected", costUsd: 0.1, status: "completed" }],
      ["TASK-003", { outcome: "approved", costUsd: 0.3, status: "completed" }],
    ]);

    const verified: Record<string, VerifiedJsonEntry> = {
      "TASK-001": {
        verified: "2026-03-01",
        commit: "abc123",
        method: "verify-task",
        verdict: "VERIFIED",
        criteriaChecked: 5,
        criteriaPassed: 5,
        notes: "",
      },
    };

    const result = getUnverifiedApprovedTaskIds(sessions, verified);
    expect(result).toEqual(new Set(["TASK-003"]));
  });

  it("returns all approved when no verified index provided", () => {
    const sessions = new Map<string, TaskSessionInfo>([
      ["TASK-001", { outcome: "approved", costUsd: 0.5, status: "completed" }],
      ["TASK-002", { outcome: "approved", costUsd: 0.3, status: "completed" }],
    ]);

    const result = getUnverifiedApprovedTaskIds(sessions);
    expect(result).toEqual(new Set(["TASK-001", "TASK-002"]));
  });

  it("returns empty set when no approved sessions exist", () => {
    const sessions = new Map<string, TaskSessionInfo>([
      ["TASK-001", { outcome: "rejected", costUsd: 0.5, status: "completed" }],
    ]);

    const result = getUnverifiedApprovedTaskIds(sessions, {});
    expect(result).toEqual(new Set());
  });

  it("returns empty set when all approved are verified", () => {
    const sessions = new Map<string, TaskSessionInfo>([
      ["TASK-001", { outcome: "approved", costUsd: 0.5, status: "completed" }],
    ]);

    const verified: Record<string, VerifiedJsonEntry> = {
      "TASK-001": {
        verified: "2026-03-01",
        commit: "abc",
        method: "pipeline",
        verdict: "VERIFIED",
        criteriaChecked: 3,
        criteriaPassed: 3,
        notes: "",
      },
    };

    const result = getUnverifiedApprovedTaskIds(sessions, verified);
    expect(result).toEqual(new Set());
  });
});
