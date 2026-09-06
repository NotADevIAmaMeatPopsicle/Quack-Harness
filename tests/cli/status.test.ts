import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { parseAllTasks, isTaskEligible } from "../../src/dispatcher/dependency-resolver";
import type { TaskSummary } from "../../src/dispatcher/dependency-resolver";
import type { TaskStatus, TaskPriority } from "../../src/core/types";

// ─── Test helpers ──────────────────────────────────────────────────────

function makeTaskContent(
  id: string,
  title: string,
  opts: {
    status?: TaskStatus;
    blockedBy?: string[];
    priority?: TaskPriority;
  } = {},
): string {
  const status = opts.status ?? "BACKLOG";
  const blockedBy =
    opts.blockedBy && opts.blockedBy.length > 0 ? `[${opts.blockedBy.join(", ")}]` : "[]";
  const priority = opts.priority ?? "P2-MEDIUM";

  return `# ${id}: ${title}

## Metadata
- **Priority:** ${priority}
- **Effort:** 4 hours
- **Status:** ${status}
- **Blocked By:** ${blockedBy}
- **Blocks:** []
- **Tags:** [test]

## Problem Statement
Test problem statement for ${id}.

## Current State
Current state description.

## Recommended Approach
Recommended approach description.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test file |

## Success Criteria
- [ ] Test criterion

## Testing Requirements
- [ ] Test requirement
`;
}

// ─── Tests: Status command logic ───────────────────────────────────

describe("status command logic", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-status-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("parseAllTasks for status display", () => {
    test("should count tasks by status", async () => {
      await fs.writeFile(
        path.join(tmpDir, "TASK-001-first.md"),
        makeTaskContent("TASK-001", "First", { status: "BACKLOG" }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-002-second.md"),
        makeTaskContent("TASK-002", "Second", { status: "BACKLOG" }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-003-third.md"),
        makeTaskContent("TASK-003", "Third", { status: "COMPLETE" }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-004-fourth.md"),
        makeTaskContent("TASK-004", "Fourth", { status: "IN_PROGRESS" }),
      );

      const { tasks, errors } = await parseAllTasks(tmpDir);

      expect(errors).toHaveLength(0);
      expect(tasks.size).toBe(4);

      // Count by status
      const statusCounts = new Map<TaskStatus, number>();
      for (const task of tasks.values()) {
        const count = statusCounts.get(task.status) ?? 0;
        statusCounts.set(task.status, count + 1);
      }

      expect(statusCounts.get("BACKLOG")).toBe(2);
      expect(statusCounts.get("COMPLETE")).toBe(1);
      expect(statusCounts.get("IN_PROGRESS")).toBe(1);
    });

    test("should count tasks by priority", async () => {
      await fs.writeFile(
        path.join(tmpDir, "TASK-001.md"),
        makeTaskContent("TASK-001", "Critical", {
          status: "BACKLOG",
          priority: "P0-CRITICAL",
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-002.md"),
        makeTaskContent("TASK-002", "High", {
          status: "BACKLOG",
          priority: "P1-HIGH",
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-003.md"),
        makeTaskContent("TASK-003", "Also High", {
          status: "BACKLOG",
          priority: "P1-HIGH",
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-004.md"),
        makeTaskContent("TASK-004", "Low", {
          status: "BACKLOG",
          priority: "P3-LOW",
        }),
      );

      const { tasks } = await parseAllTasks(tmpDir);

      const priorityCounts = new Map<TaskPriority, number>();
      for (const task of tasks.values()) {
        const count = priorityCounts.get(task.task.priority) ?? 0;
        priorityCounts.set(task.task.priority, count + 1);
      }

      expect(priorityCounts.get("P0-CRITICAL")).toBe(1);
      expect(priorityCounts.get("P1-HIGH")).toBe(2);
      expect(priorityCounts.get("P3-LOW")).toBe(1);
      expect(priorityCounts.get("P2-MEDIUM")).toBeUndefined();
    });

    test("should handle empty task directory", async () => {
      const { tasks, errors } = await parseAllTasks(tmpDir);

      expect(tasks.size).toBe(0);
      expect(errors).toHaveLength(0);
    });

    test("should collect parse errors without stopping", async () => {
      await fs.writeFile(
        path.join(tmpDir, "TASK-001.md"),
        makeTaskContent("TASK-001", "Valid Task"),
      );
      await fs.writeFile(path.join(tmpDir, "TASK-002-broken.md"), "This is not a valid task file.");
      await fs.writeFile(
        path.join(tmpDir, "TASK-003.md"),
        makeTaskContent("TASK-003", "Another Valid"),
      );

      const { tasks, errors } = await parseAllTasks(tmpDir);

      expect(tasks.size).toBe(2);
      expect(tasks.has("TASK-001")).toBe(true);
      expect(tasks.has("TASK-003")).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("TASK-002-broken.md");
    });
  });

  describe("eligible tasks identification", () => {
    test("should identify unblocked BACKLOG tasks as eligible", async () => {
      // TASK-001: COMPLETE (dependency)
      await fs.writeFile(
        path.join(tmpDir, "TASK-001.md"),
        makeTaskContent("TASK-001", "Done Task", { status: "COMPLETE" }),
      );
      // TASK-002: BACKLOG, blocked by TASK-001 (COMPLETE) -> eligible
      await fs.writeFile(
        path.join(tmpDir, "TASK-002.md"),
        makeTaskContent("TASK-002", "Ready Task", {
          status: "BACKLOG",
          blockedBy: ["TASK-001"],
        }),
      );
      // TASK-003: BACKLOG, no deps -> eligible
      await fs.writeFile(
        path.join(tmpDir, "TASK-003.md"),
        makeTaskContent("TASK-003", "Free Task", { status: "BACKLOG" }),
      );
      // TASK-004: BACKLOG, blocked by TASK-002 (BACKLOG) -> blocked
      await fs.writeFile(
        path.join(tmpDir, "TASK-004.md"),
        makeTaskContent("TASK-004", "Blocked Task", {
          status: "BACKLOG",
          blockedBy: ["TASK-002"],
        }),
      );

      const { tasks } = await parseAllTasks(tmpDir);

      const eligible: TaskSummary[] = [];
      for (const task of tasks.values()) {
        if (isTaskEligible(task, tasks)) {
          eligible.push(task);
        }
      }

      const eligibleIds = eligible.map((t) => t.id).sort();
      expect(eligibleIds).toEqual(["TASK-002", "TASK-003"]);
    });

    test("should return no eligible tasks when all are blocked", async () => {
      // TASK-001: BACKLOG, blocked by TASK-002
      await fs.writeFile(
        path.join(tmpDir, "TASK-001.md"),
        makeTaskContent("TASK-001", "Task A", {
          status: "BACKLOG",
          blockedBy: ["TASK-002"],
        }),
      );
      // TASK-002: BACKLOG, blocked by TASK-001 (circular)
      await fs.writeFile(
        path.join(tmpDir, "TASK-002.md"),
        makeTaskContent("TASK-002", "Task B", {
          status: "BACKLOG",
          blockedBy: ["TASK-001"],
        }),
      );

      const { tasks } = await parseAllTasks(tmpDir);

      const eligible: TaskSummary[] = [];
      for (const task of tasks.values()) {
        if (isTaskEligible(task, tasks)) {
          eligible.push(task);
        }
      }

      expect(eligible).toHaveLength(0);
    });

    test("should not include non-BACKLOG tasks as eligible", async () => {
      await fs.writeFile(
        path.join(tmpDir, "TASK-001.md"),
        makeTaskContent("TASK-001", "In Progress", { status: "IN_PROGRESS" }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-002.md"),
        makeTaskContent("TASK-002", "Complete", { status: "COMPLETE" }),
      );
      await fs.writeFile(
        path.join(tmpDir, "TASK-003.md"),
        makeTaskContent("TASK-003", "Rejected", { status: "REJECTED" }),
      );

      const { tasks } = await parseAllTasks(tmpDir);

      const eligible: TaskSummary[] = [];
      for (const task of tasks.values()) {
        if (isTaskEligible(task, tasks)) {
          eligible.push(task);
        }
      }

      expect(eligible).toHaveLength(0);
    });
  });
});
