// ─── Status hygiene resolves first (TASK-1318 S2c) ──────────────────
// The defect these pins exist for: backlog hygiene suppressed tasks
// from automation by reading the RAW spec status, so a runtime row of
// BACKLOG and a spec line of REJECTED produced a projection that called
// the task eligible while hygiene called it dispatchBlocked. A markdown
// edit was still an automation veto.
//
// Every service-level case below fails if status hygiene moves back to
// parse time, because each one puts the runtime row and the spec line in
// direct conflict and asserts the runtime row wins.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyResolvedStatusHygiene,
  buildStructuralBacklogHygieneReport,
  evaluateStatusTaskHygiene,
  evaluateStructuralTaskHygiene,
} from "../../src/core/task-hygiene";
import { TaskService } from "../../src/monitor/task-service";
import type { ParsedTask } from "../../src/core/types";
import type { TaskStatusRow, VerifiedRow } from "../../src/db/types";

function spec(id: string, status: string, extraMetadata: string[] = []): string {
  return `# ${id}: Hygiene fixture

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 4 hours
- **Status:** ${status}
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [test]
${extraMetadata.join("\n")}

## Problem Statement
Fixture for the TASK-1318 hygiene split.

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

/** The only DB surface `TaskService` touches. */
class FakeDb {
  constructor(private readonly statuses: TaskStatusRow[]) {}

  getAllStatuses(): TaskStatusRow[] {
    return this.statuses;
  }

  getAllVerified(): Map<string, VerifiedRow> {
    return new Map<string, VerifiedRow>();
  }
}

function statusRow(taskId: string, status: string): TaskStatusRow {
  return {
    task_id: taskId,
    status,
    updated_at: "2026-08-07T00:00:00.000Z",
    updated_by: "dispatcher",
    previous_status: null,
  };
}

function asDb(db: FakeDb): Parameters<TaskService["listTasks"]>[2] {
  return db as unknown as Parameters<TaskService["listTasks"]>[2];
}

function reasonCodes(reasons?: { code: string }[]): string[] {
  return (reasons ?? []).map((reason) => reason.code);
}

describe("TASK-1318 S2c: the hygiene split", () => {
  const parsedTask = (
    id: string,
    status: string,
    supersededBy: string[] = [],
  ): Pick<ParsedTask, "id" | "status" | "supersededBy"> => ({
    id,
    status: status as ParsedTask["status"],
    supersededBy,
  });

  it("RED TASK-1338-A: structural hygiene delegates declared-id grouping", async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, "../../src/core/task-hygiene.ts"),
      "utf-8",
    );

    expect(source).toMatch(
      /groupTaskClaimantsByDeclaredId[\s\S]*from "\.\/duplicate-claimants\.js"/,
    );
    expect(source).not.toContain("const duplicateFilesByTaskId = new Map<string, string[]>();");
  });

  it("CONTROL TASK-1338-A: unsorted source order remains visible except in duplicateIds", () => {
    const encounterOrder = [
      "TASK-5-z-last-lexically.md",
      "TASK-5-a-first-lexically.md",
      "TASK-5-m-middle-lexically.md",
    ];
    const sources = encounterOrder.map((file, index) => ({
      file,
      task: {
        ...parsedTask("TASK-5", "READY"),
        title: `claimant ${index}`,
      } as ParsedTask,
    }));

    const structural = buildStructuralBacklogHygieneReport(sources);

    expect(structural.duplicateFilesByTaskId.get("TASK-5")).toEqual(encounterOrder);
    expect(structural.report.duplicateIds).toEqual([
      {
        taskId: "TASK-5",
        files: [...encounterOrder].sort(),
      },
    ]);
    expect(
      structural.report.excludedCandidates.map(
        (candidate) =>
          candidate.reasons.find((reason) => reason.code === "duplicate_id")?.relatedFiles,
      ),
    ).toEqual([encounterOrder, encounterOrder, encounterOrder]);
    expect(structural.duplicateFilesByTaskId.get("TASK-5")).toEqual(encounterOrder);
  });

  it("structural hygiene ignores status entirely", () => {
    const rejected = evaluateStructuralTaskHygiene(parsedTask("TASK-1", "REJECTED"));
    expect(rejected.dispatchBlocked).toBe(false);
    expect(rejected.reasons).toEqual([]);

    const superseded = evaluateStructuralTaskHygiene(parsedTask("TASK-2", "READY", ["TASK-9"]), [
      "TASK-2-a.md",
      "TASK-2-b.md",
    ]);
    expect(reasonCodes(superseded.reasons)).toEqual(["duplicate_id", "superseded"]);
  });

  it("status hygiene answers for whatever status it is handed", () => {
    expect(evaluateStatusTaskHygiene("TASK-3", "ON_HOLD").dispatchBlocked).toBe(true);
    expect(evaluateStatusTaskHygiene("TASK-3", "REJECTED").dispatchBlocked).toBe(true);
    expect(evaluateStatusTaskHygiene("TASK-3", "BACKLOG").dispatchBlocked).toBe(false);
    // A runtime row can hold any string; a non-canonical one suppresses
    // nothing rather than being coerced into a status it does not hold.
    expect(evaluateStatusTaskHygiene("TASK-3", "rejected").dispatchBlocked).toBe(false);
  });

  it("applying resolved status overrides the spec line in both directions", () => {
    const sources = [
      { file: "TASK-1-a.md", task: parsedTask("TASK-1", "REJECTED") as ParsedTask },
      { file: "TASK-2-b.md", task: parsedTask("TASK-2", "BACKLOG") as ParsedTask },
    ].map((source) => ({
      ...source,
      task: { ...source.task, title: `${source.task.id} title` } as ParsedTask,
    }));

    const structural = buildStructuralBacklogHygieneReport(sources);
    const applied = applyResolvedStatusHygiene(structural, [
      // Runtime says the REJECTED spec is back in the pool.
      { taskId: "TASK-1", title: "TASK-1 title", status: "BACKLOG", specStatus: "REJECTED" },
      // Runtime says the BACKLOG spec is finished.
      { taskId: "TASK-2", title: "TASK-2 title", status: "REJECTED", specStatus: "BACKLOG" },
    ]);

    expect(applied.byTaskId.get("TASK-1")?.dispatchBlocked).toBe(false);
    expect(reasonCodes(applied.byTaskId.get("TASK-2")?.reasons)).toEqual(["status_rejected"]);
    expect(applied.report.excludedCandidates.map((c) => c.taskId)).toEqual(["TASK-2"]);
    // The row reports the status the exclusion was decided on.
    expect(applied.report.excludedCandidates[0].status).toBe("REJECTED");
  });

  it("pairs each duplicate-id row with its own resolved input", () => {
    // Two files, one id, different Status lines. The duplicate report
    // exists to expose exactly this, so each row must keep its own
    // answer rather than both inheriting whichever file was read last.
    const sources = [
      {
        file: "TASK-5-a.md",
        task: { ...parsedTask("TASK-5", "READY"), title: "first file" } as ParsedTask,
      },
      {
        file: "TASK-5-b.md",
        task: { ...parsedTask("TASK-5", "REJECTED"), title: "second file" } as ParsedTask,
      },
    ];
    const applied = applyResolvedStatusHygiene(buildStructuralBacklogHygieneReport(sources), [
      { taskId: "TASK-5", title: "first file", status: "READY", specStatus: "READY" },
      { taskId: "TASK-5", title: "second file", status: "REJECTED", specStatus: "REJECTED" },
    ]);

    const rows = applied.report.excludedCandidates;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("READY");
    expect(reasonCodes(rows[0].reasons)).toEqual(["duplicate_id"]);
    expect(rows[1].status).toBe("REJECTED");
    expect(reasonCodes(rows[1].reasons)).toEqual(["duplicate_id", "status_rejected"]);
  });

  it("composing the two phases with the SPEC status reproduces the pre-split answer", () => {
    // Round-3 F3 deleted `buildBacklogHygieneReport`, the one-call
    // spec-only shim, once its last production caller was routed. This
    // still pins the composition it stood for, because a caller with no
    // overlay in reach is a legitimate case; what is no longer available
    // is a neutrally-named helper that makes the spec-only choice
    // invisible at the call site.
    const sources = [
      {
        file: "TASK-4-hold.md",
        task: { ...parsedTask("TASK-4", "ON_HOLD"), title: "Held" } as ParsedTask,
      },
    ];
    const { report, byTaskId } = applyResolvedStatusHygiene(
      buildStructuralBacklogHygieneReport(sources),
      sources.map((source) => ({
        taskId: source.task.id,
        title: source.task.title,
        status: source.task.status,
        specStatus: source.task.status,
      })),
    );

    expect(reasonCodes(byTaskId.get("TASK-4")?.reasons)).toEqual(["status_on_hold"]);
    expect(report.excludedCandidates).toEqual([
      {
        taskId: "TASK-4",
        title: "Held",
        status: "ON_HOLD",
        reasons: byTaskId.get("TASK-4")?.reasons,
      },
    ]);
  });
});

describe("TASK-1318 S2c: TaskService suppression follows the resolved status", () => {
  let tmpDir: string;
  let taskDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-1318-hygiene-"));
    taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    // Spec says REJECTED, the runtime store says it is back in the pool.
    await fs.writeFile(
      path.join(taskDir, "TASK-701-spec-rejected.md"),
      spec("TASK-701", "REJECTED"),
    );
    // Spec says BACKLOG, the runtime store says it was rejected.
    await fs.writeFile(path.join(taskDir, "TASK-702-db-rejected.md"), spec("TASK-702", "BACKLOG"));
    // Spec says ON_HOLD and no runtime row exists: still suppressed.
    await fs.writeFile(path.join(taskDir, "TASK-703-spec-hold.md"), spec("TASK-703", "ON_HOLD"));
    // Structural suppression must survive any runtime row.
    await fs.writeFile(
      path.join(taskDir, "TASK-704-superseded.md"),
      spec("TASK-704", "READY", ["- **Superseded By:** [TASK-999]"]),
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const db = () =>
    new FakeDb([
      statusRow("TASK-701", "BACKLOG"),
      statusRow("TASK-702", "REJECTED"),
      statusRow("TASK-704", "READY"),
    ]);

  it("a runtime row clears a spec REJECTED, and creates one over a spec BACKLOG", async () => {
    const service = new TaskService(tmpDir, "docs/tasks");
    const { tasks, hygiene } = await service.listTasks(undefined, undefined, asDb(db()));

    const specRejected = tasks.find((t) => t.id === "TASK-701");
    expect(specRejected?.status).toBe("REJECTED");
    expect(specRejected?.effectiveStatus).toBe("BACKLOG");
    expect(specRejected?.backlogHygiene?.dispatchBlocked).toBe(false);

    const dbRejected = tasks.find((t) => t.id === "TASK-702");
    expect(dbRejected?.status).toBe("BACKLOG");
    expect(dbRejected?.effectiveStatus).toBe("REJECTED");
    expect(reasonCodes(dbRejected?.backlogHygiene?.reasons)).toEqual(["status_rejected"]);

    // The report agrees with the per-task view, and reports the status
    // the decision was made on rather than the spec line.
    const excluded = hygiene?.excludedCandidates ?? [];
    expect(excluded.map((c) => c.taskId)).not.toContain("TASK-701");
    expect(excluded.find((c) => c.taskId === "TASK-702")?.status).toBe("REJECTED");
  });

  it("keeps suppressing a spec ON_HOLD when the runtime store is silent", async () => {
    const service = new TaskService(tmpDir, "docs/tasks");
    const { tasks } = await service.listTasks(undefined, undefined, asDb(db()));

    const held = tasks.find((t) => t.id === "TASK-703");
    expect(held?.effectiveStatus).toBe("ON_HOLD");
    expect(reasonCodes(held?.backlogHygiene?.reasons)).toEqual(["status_on_hold"]);
  });

  it("keeps structural suppression regardless of the runtime row", async () => {
    const service = new TaskService(tmpDir, "docs/tasks");
    const { tasks, hygiene } = await service.listTasks(undefined, undefined, asDb(db()));

    const superseded = tasks.find((t) => t.id === "TASK-704");
    expect(superseded?.effectiveStatus).toBe("READY");
    expect(reasonCodes(superseded?.backlogHygiene?.reasons)).toEqual(["superseded"]);
    expect(hygiene?.supersededTasks).toEqual([{ taskId: "TASK-704", supersededBy: ["TASK-999"] }]);
  });

  it("listTasks and refreshTasks still agree, hygiene included", async () => {
    const service = new TaskService(tmpDir, "docs/tasks");
    const listed = await service.listTasks(undefined, undefined, asDb(db()));
    const refreshed = await service.refreshTasks(undefined, undefined, asDb(db()));

    const byId = (tasks: typeof listed.tasks) =>
      [...tasks].sort((a, b) => a.id.localeCompare(b.id));

    expect(byId(refreshed.tasks)).toEqual(byId(listed.tasks));
    expect(refreshed.hygiene).toEqual(listed.hygiene);
  });

  it("falls back to spec authority when no DB is supplied", async () => {
    const service = new TaskService(tmpDir, "docs/tasks");
    const { tasks } = await service.listTasks();

    // No runtime overlay means the spec is the only answer available,
    // which is the resolver's documented precedence rather than a
    // regression: 1318 removes the spec as an OVERRIDE, not as a
    // fallback.
    expect(reasonCodes(tasks.find((t) => t.id === "TASK-701")?.backlogHygiene?.reasons)).toEqual([
      "status_rejected",
    ]);
    expect(tasks.find((t) => t.id === "TASK-702")?.backlogHygiene?.dispatchBlocked).toBe(false);
  });
});
