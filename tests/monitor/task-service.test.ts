/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TaskService } from "../../src/monitor/task-service";

describe("TaskService", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-task-svc-"));
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });

    // Write a valid task file
    await fs.writeFile(
      path.join(taskDir, "TASK-001-test-feature.md"),
      [
        "# TASK-001: Test Feature",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2-4 hours",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** test, feature",
        "",
        "## Problem Statement",
        "Need a test feature.",
        "",
        "## Success Criteria",
        "- Feature works",
        "- Tests pass",
        "",
        "## Testing Requirements",
        "- Unit tests for feature",
      ].join("\n"),
    );

    await fs.writeFile(
      path.join(taskDir, "TASK-002-another.md"),
      [
        "# TASK-002: Another Task",
        "",
        "## Metadata",
        "- **Priority:** P2-MEDIUM",
        "- **Effort:** 1-2 hours",
        "- **Status:** COMPLETE",
        "- **Blocked By:** [TASK-001]",
        "- **Tags:** cleanup",
        "",
        "## Problem Statement",
        "Another task to do.",
        "",
        "## Success Criteria",
        "- Done",
        "",
        "## Testing Requirements",
        "- Verify cleanup",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("listTasks returns summaries for all task files", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const { tasks, parseErrors } = await svc.listTasks();

    expect(tasks).toHaveLength(2);
    expect(parseErrors).toHaveLength(0);
    expect(tasks[0].id).toBe("TASK-001");
    expect(tasks[0].title).toBe("Test Feature");
    expect(tasks[0].priority).toBe("P1-HIGH");
    expect(tasks[0].status).toBe("READY");
    expect(tasks[0].effectiveStatus).toBe("READY"); // No session data → matches file status
    expect(tasks[0].tags).toContain("test");
    expect(tasks[0].successCriteriaCount).toBe(2);

    expect(tasks[1].id).toBe("TASK-002");
    expect(tasks[1].blockedBy).toContain("TASK-001");
  });

  test("listTasks overlays session outcomes onto effective status", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const sessionsByTask = new Map([
      ["TASK-001", { outcome: "approved", costUsd: 2.5, status: "completed" }],
    ]);
    const { tasks } = await svc.listTasks(sessionsByTask);

    // TASK-001 file says READY, but session says approved → COMPLETE
    expect(tasks[0].status).toBe("READY");
    expect(tasks[0].effectiveStatus).toBe("COMPLETE");
    expect(tasks[0].lastOutcome).toBe("approved");
    expect(tasks[0].lastCostUsd).toBe(2.5);

    // TASK-002 has no session data → effectiveStatus matches file
    expect(tasks[1].status).toBe("COMPLETE");
    expect(tasks[1].effectiveStatus).toBe("COMPLETE");
    expect(tasks[1].lastOutcome).toBeUndefined();
  });

  test("getTask returns full parsed task", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const task = await svc.getTask("TASK-001");

    expect(task).not.toBeNull();
    expect(task!.id).toBe("TASK-001");
    expect(task!.problemStatement).toContain("test feature");
    expect(task!.successCriteria).toHaveLength(2);
    expect(task!.rawContent).toContain("# TASK-001");
  });

  test("getTask returns null for missing task", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const task = await svc.getTask("TASK-999");
    expect(task).toBeNull();
  });

  test("getTask does not resolve a parent id to a subtask with the same prefix", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.writeFile(
      path.join(taskDir, "TASK-886-A-inventory-subtask.md"),
      [
        "# TASK-886-A: Inventory Subtask",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** inventory",
        "",
        "## Problem Statement",
        "Subtask only.",
        "",
        "## Success Criteria",
        "- Subtask works",
        "",
        "## Testing Requirements",
        "- Unit tests",
      ].join("\n"),
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    expect(await svc.getTask("TASK-886")).toBeNull();
    expect((await svc.getTask("TASK-886-A"))?.id).toBe("TASK-886-A");
  });

  test("listTasks returns empty result for missing directory", async () => {
    const svc = new TaskService(tmpDir, "nonexistent");
    const { tasks, parseErrors } = await svc.listTasks();
    expect(tasks).toEqual([]);
    expect(parseErrors).toEqual([]);
  });

  test("listTasks collects parse errors for unparseable files", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");

    // Write an invalid task file (missing Testing Requirements)
    await fs.writeFile(
      path.join(taskDir, "TASK-003-broken.md"),
      [
        "# TASK-003: Broken Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** broken",
        "",
        "## Problem Statement",
        "This task is missing required sections.",
        "",
        "## Success Criteria",
        "- Something",
      ].join("\n"),
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    const { tasks, parseErrors } = await svc.listTasks();

    // TASK-001 and TASK-002 should parse fine
    expect(tasks).toHaveLength(2);

    // TASK-003 should appear in parseErrors
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0].file).toBe("TASK-003-broken.md");
    expect(parseErrors[0].error).toContain("Testing Requirements");
  });

  test("listTasks reports duplicate task ids in backlog hygiene", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.writeFile(
      path.join(taskDir, "TASK-001-duplicate.md"),
      [
        "# TASK-001: Duplicate Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** duplicate",
        "",
        "## Problem Statement",
        "Duplicate id spec.",
        "",
        "## Success Criteria",
        "- Something",
        "",
        "## Testing Requirements",
        "- Verify duplicate handling",
      ].join("\n"),
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    const { hygiene } = await svc.listTasks();

    expect(hygiene?.duplicateIds).toEqual([
      expect.objectContaining({
        taskId: "TASK-001",
        files: expect.arrayContaining(["TASK-001-duplicate.md", "TASK-001-test-feature.md"]),
      }),
    ]);
    expect(hygiene?.excludedCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "TASK-001",
        }),
      ]),
    );
  });

  test("listTasks reports superseded tasks separately from active backlog", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.writeFile(
      path.join(taskDir, "TASK-003-superseded.md"),
      [
        "# TASK-003: Superseded Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Superseded By:** [TASK-900]",
        "- **Blocked By:** []",
        "- **Tags:** stale",
        "",
        "## Problem Statement",
        "This spec should stay out of automation.",
        "",
        "## Success Criteria",
        "- Something",
        "",
        "## Testing Requirements",
        "- Verify supersession handling",
      ].join("\n"),
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    const { tasks, hygiene } = await svc.listTasks();
    const superseded = tasks.find((task) => task.id === "TASK-003");

    expect(hygiene?.supersededTasks).toEqual([
      {
        taskId: "TASK-003",
        supersededBy: ["TASK-900"],
      },
    ]);
    expect(superseded?.backlogHygiene?.dispatchBlocked).toBe(true);
    expect(superseded?.supersededBy).toEqual(["TASK-900"]);
  });

  test("getTaskFilePath returns path for existing task", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const filePath = await svc.getTaskFilePath("TASK-001");

    expect(filePath).not.toBeNull();
    expect(filePath).toContain("TASK-001-test-feature.md");
  });

  test("getTaskFilePath returns null for missing task", async () => {
    const svc = new TaskService(tmpDir, "docs/tasks");
    const filePath = await svc.getTaskFilePath("TASK-999");
    expect(filePath).toBeNull();
  });

  test("getTaskFilePath uses parsed task id instead of prefix-only filename matching", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.writeFile(
      path.join(taskDir, "TASK-886-A-inventory-subtask.md"),
      [
        "# TASK-886-A: Inventory Subtask",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** inventory",
        "",
        "## Problem Statement",
        "Subtask only.",
        "",
        "## Success Criteria",
        "- Subtask works",
        "",
        "## Testing Requirements",
        "- Unit tests",
      ].join("\n"),
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    expect(await svc.getTaskFilePath("TASK-886")).toBeNull();
    expect(await svc.getTaskFilePath("TASK-886-A")).toContain("TASK-886-A-inventory-subtask.md");
  });

  test("getRawTaskFilePath prefers the parent task file over a subtask prefix match", async () => {
    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.writeFile(
      path.join(taskDir, "TASK-826-worktree-docker-cleanup-hook.md"),
      "# broken parent spec",
    );
    await fs.writeFile(
      path.join(taskDir, "TASK-826-A-docker-teardown-warning-fix.md"),
      "# broken subtask spec",
    );

    const svc = new TaskService(tmpDir, "docs/tasks");
    expect(await svc.getRawTaskFilePath("TASK-826")).toContain(
      "TASK-826-worktree-docker-cleanup-hook.md",
    );
    expect(await svc.getRawTaskFilePath("TASK-826-A")).toContain(
      "TASK-826-A-docker-teardown-warning-fix.md",
    );
  });
});
