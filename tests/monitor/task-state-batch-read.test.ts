// ─── The N+1 pin (TASK-1317 S3, round-1 F7) ─────────────────────────
// Reading the verification register per task would add roughly one
// query per task to every /api/tasks request (268 in the tree where
// this was found) in place of a single batch read. This test pins the
// call count so that regression cannot land quietly.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { TaskService } from "../../src/monitor/task-service";
import type { VerifiedRow, TaskStatusRow } from "../../src/db/types";

/** The canonical parseable shape, mirrored from the dependency-resolver
 * suite's fixture builder — a shorter spec does not parse. */
function spec(id: string, status: string): string {
  return `# ${id}: Batch read fixture

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 4 hours
- **Status:** ${status}
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [test]

## Problem Statement
Fixture for the TASK-1317 batch-read pin.

## Current State
Fixture.

## Recommended Approach
Fixture.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test file |

## Success Criteria
- [ ] Fixture criterion

## Testing Requirements
- [ ] Fixture requirement
`;
}

/** Counts every register access so the pin is about calls, not results. */
class CountingDb {
  getAllVerifiedCalls = 0;
  getVerifiedCalls = 0;

  constructor(private readonly rows: Map<string, VerifiedRow>) {}

  getAllStatuses(): TaskStatusRow[] {
    return [];
  }

  getAllVerified(): Map<string, VerifiedRow> {
    this.getAllVerifiedCalls += 1;
    return this.rows;
  }

  getVerified(taskId: string): VerifiedRow | undefined {
    this.getVerifiedCalls += 1;
    return this.rows.get(taskId);
  }
}

describe("TASK-1317: the verification register is read in ONE batch", () => {
  let tmpDir: string;
  const TASK_COUNT = 12;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-1317-"));
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    for (let i = 1; i <= TASK_COUNT; i += 1) {
      const id = `TASK-${900 + i}`;
      await fs.writeFile(path.join(taskDir, `${id}-fixture.md`), spec(id, "BACKLOG"));
    }
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("calls getAllVerified once and getVerified never, regardless of task count", async () => {
    const rows = new Map<string, VerifiedRow>([
      [
        "TASK-901",
        {
          task_id: "TASK-901",
          verified_at: "2026-08-06",
          commit_sha: "abc1234",
          method: "on-merge",
          verdict: "SOFT-VERIFIED",
          criteria_checked: 3,
          criteria_passed: 3,
          notes: null,
        },
      ],
    ]);
    const db = new CountingDb(rows);

    const service = new TaskService(tmpDir, "docs/tasks");
    const result = await service.listTasks(
      undefined,
      undefined,
      db as unknown as Parameters<TaskService["listTasks"]>[2],
    );

    expect(result.tasks.length).toBe(TASK_COUNT);
    expect(db.getAllVerifiedCalls).toBe(1);
    // The whole point: never once per task.
    expect(db.getVerifiedCalls).toBe(0);
  });

  // The residual risk in TASK-1317 was never the resolver, which is
  // proven byte-identical by the value matrix. It was that
  // `refreshTasks` was restructured into a shared helper while having
  // ZERO test coverage, despite serving two live API routes
  // (server.ts:2959 and :3206). This closes that gap directly.
  it("refreshTasks and listTasks produce IDENTICAL projections and both batch once", async () => {
    const rows = new Map<string, VerifiedRow>([
      [
        "TASK-904",
        {
          task_id: "TASK-904",
          verified_at: "2026-08-06",
          commit_sha: "cafe123",
          method: "on-merge",
          verdict: "VERIFIED",
          criteria_checked: 2,
          criteria_passed: 2,
          notes: null,
        },
      ],
    ]);
    const sessions = new Map([
      ["TASK-905", { outcome: "approved", costUsd: 1.5, status: "completed" }],
    ]);

    const listDb = new CountingDb(rows);
    const refreshDb = new CountingDb(rows);
    const service = new TaskService(tmpDir, "docs/tasks");

    const listed = await service.listTasks(
      sessions,
      undefined,
      listDb as unknown as Parameters<TaskService["listTasks"]>[2],
    );
    const refreshed = await service.refreshTasks(
      sessions,
      undefined,
      refreshDb as unknown as Parameters<TaskService["listTasks"]>[2],
    );

    const byId = (tasks: typeof listed.tasks) =>
      [...tasks].sort((a, b) => a.id.localeCompare(b.id));

    expect(refreshed.tasks.length).toBe(listed.tasks.length);
    expect(byId(refreshed.tasks)).toEqual(byId(listed.tasks));

    // Evidence reaches BOTH paths, which was the round-2 HIGH.
    expect(refreshed.tasks.find((t) => t.id === "TASK-904")?.verification?.verdict).toBe(
      "VERIFIED",
    );
    // Session-derived authority survives the restructure on both paths.
    expect(refreshed.tasks.find((t) => t.id === "TASK-905")?.authority).toBe("session");

    expect(listDb.getAllVerifiedCalls).toBe(1);
    expect(refreshDb.getAllVerifiedCalls).toBe(1);
    expect(listDb.getVerifiedCalls).toBe(0);
    expect(refreshDb.getVerifiedCalls).toBe(0);
  });

  it("threads the verdict onto the projection so the two-tier state is visible", async () => {
    const rows = new Map<string, VerifiedRow>([
      [
        "TASK-902",
        {
          task_id: "TASK-902",
          verified_at: "2026-08-06",
          commit_sha: "deadbee",
          method: "on-merge",
          verdict: "SOFT-VERIFIED",
          criteria_checked: 1,
          criteria_passed: 1,
          notes: null,
        },
      ],
    ]);
    const db = new CountingDb(rows);
    const service = new TaskService(tmpDir, "docs/tasks");
    const result = await service.listTasks(
      undefined,
      undefined,
      db as unknown as Parameters<TaskService["listTasks"]>[2],
    );

    const withVerdict = result.tasks.find((t) => t.id === "TASK-902");
    const without = result.tasks.find((t) => t.id === "TASK-903");
    expect(withVerdict?.verification?.verdict).toBe("SOFT-VERIFIED");
    expect(withVerdict?.verification?.commitSha).toBe("deadbee");
    // Evidence only: the register says SOFT-VERIFIED and the status is
    // untouched. Authority movement is P2-4.
    expect(withVerdict?.effectiveStatus).toBe("BACKLOG");
    expect(without?.verification).toBeUndefined();
  });
});
