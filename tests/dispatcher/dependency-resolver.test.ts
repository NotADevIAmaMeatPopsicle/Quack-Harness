import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  discoverTaskFiles,
  parseAllTasks,
  isTaskEligible,
  resolveDependencies,
  loadStatusOverlay,
} from "../../src/dispatcher/dependency-resolver";
import type { TaskSummary } from "../../src/dispatcher/dependency-resolver";
import type { TaskStatus } from "../../src/core/types";
import { QuackDB } from "../../src/db";
import * as fsSync from "node:fs";

// ─── Test helpers ──────────────────────────────────────────────────────

function makeTaskContent(
  id: string,
  title: string,
  opts: {
    status?: TaskStatus;
    blockedBy?: string[];
    blocks?: string[];
    priority?: string;
  } = {},
): string {
  const status = opts.status ?? "BACKLOG";
  const blockedBy =
    opts.blockedBy && opts.blockedBy.length > 0 ? `[${opts.blockedBy.join(", ")}]` : "[]";
  const blocks = opts.blocks && opts.blocks.length > 0 ? `[${opts.blocks.join(", ")}]` : "[]";
  const priority = opts.priority ?? "P2-MEDIUM";

  return `# ${id}: ${title}

## Metadata
- **Priority:** ${priority}
- **Effort:** 4 hours
- **Status:** ${status}
- **Blocked By:** ${blockedBy}
- **Blocks:** ${blocks}
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

function makeTaskSummary(id: string, status: TaskStatus, blockedBy: string[] = []): TaskSummary {
  return {
    id,
    status,
    blockedBy,
    task: {
      id,
      title: `Task ${id}`,
      priority: "P2-MEDIUM",
      effort: "4 hours",
      status,
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      blockedBy,
      blocks: [],
      conventions: [],
      tags: [],
      problemStatement: "Test problem",
      currentState: "",
      recommendedApproach: "",
      filesToModify: [],
      successCriteria: ["Test criterion"],
      testingRequirements: ["Test requirement"],
      contextReferences: [],
      rawContent: "",
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("discoverTaskFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-dep-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should find TASK-*.md files in directory", async () => {
    await fs.writeFile(path.join(tmpDir, "TASK-001-foo.md"), "content");
    await fs.writeFile(path.join(tmpDir, "TASK-002-bar.md"), "content");
    await fs.writeFile(path.join(tmpDir, "README.md"), "content");
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "content");

    const files = await discoverTaskFiles(tmpDir);

    expect(files).toHaveLength(2);
    expect(files[0]).toContain("TASK-001-foo.md");
    expect(files[1]).toContain("TASK-002-bar.md");
  });

  test("should return empty array for non-existent directory", async () => {
    const files = await discoverTaskFiles(path.join(tmpDir, "nonexistent"));
    expect(files).toEqual([]);
  });

  test("should return empty array when no TASK files exist", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "content");

    const files = await discoverTaskFiles(tmpDir);
    expect(files).toEqual([]);
  });

  test("should return sorted results", async () => {
    await fs.writeFile(path.join(tmpDir, "TASK-003.md"), "content");
    await fs.writeFile(path.join(tmpDir, "TASK-001.md"), "content");
    await fs.writeFile(path.join(tmpDir, "TASK-002.md"), "content");

    const files = await discoverTaskFiles(tmpDir);

    expect(files).toHaveLength(3);
    expect(files[0]).toContain("TASK-001.md");
    expect(files[1]).toContain("TASK-002.md");
    expect(files[2]).toContain("TASK-003.md");
  });
});

describe("parseAllTasks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-parse-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should parse valid task files into TaskSummary map", async () => {
    await fs.writeFile(
      path.join(tmpDir, "TASK-001-first.md"),
      makeTaskContent("TASK-001", "First Task", { status: "BACKLOG" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "TASK-002-second.md"),
      makeTaskContent("TASK-002", "Second Task", {
        status: "COMPLETE",
        blockedBy: ["TASK-001"],
      }),
    );

    const { tasks, errors } = await parseAllTasks(tmpDir);

    expect(errors).toHaveLength(0);
    expect(tasks.size).toBe(2);
    expect(tasks.get("TASK-001")?.status).toBe("BACKLOG");
    expect(tasks.get("TASK-002")?.status).toBe("COMPLETE");
    expect(tasks.get("TASK-002")?.blockedBy).toEqual(["TASK-001"]);
  });

  test("should collect errors for invalid task files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "TASK-001-valid.md"),
      makeTaskContent("TASK-001", "Valid Task"),
    );
    await fs.writeFile(
      path.join(tmpDir, "TASK-002-invalid.md"),
      "# Not a valid task\nJust some text.",
    );

    const { tasks, errors } = await parseAllTasks(tmpDir);

    expect(tasks.size).toBe(1);
    expect(tasks.has("TASK-001")).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("TASK-002-invalid.md");
  });

  test("should handle empty directory", async () => {
    const { tasks, errors } = await parseAllTasks(tmpDir);

    expect(tasks.size).toBe(0);
    expect(errors).toHaveLength(0);
  });
});

describe("isTaskEligible", () => {
  test("should return true for BACKLOG task with no dependencies", () => {
    const task = makeTaskSummary("TASK-001", "BACKLOG");
    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", task);

    expect(isTaskEligible(task, allTasks)).toBe(true);
  });

  test("should return true for BACKLOG task with all dependencies COMPLETE", () => {
    const dep1 = makeTaskSummary("TASK-001", "COMPLETE");
    const dep2 = makeTaskSummary("TASK-002", "COMPLETE");
    const task = makeTaskSummary("TASK-003", "BACKLOG", ["TASK-001", "TASK-002"]);

    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", dep1);
    allTasks.set("TASK-002", dep2);
    allTasks.set("TASK-003", task);

    expect(isTaskEligible(task, allTasks)).toBe(true);
  });

  test("should return true when dependencies are VERIFIED", () => {
    const dep = makeTaskSummary("TASK-001", "VERIFIED");
    const task = makeTaskSummary("TASK-002", "BACKLOG", ["TASK-001"]);

    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", dep);
    allTasks.set("TASK-002", task);

    expect(isTaskEligible(task, allTasks)).toBe(true);
  });

  test("should return false for BACKLOG task with incomplete dependency", () => {
    const dep1 = makeTaskSummary("TASK-001", "COMPLETE");
    const dep2 = makeTaskSummary("TASK-002", "IN_PROGRESS");
    const task = makeTaskSummary("TASK-003", "BACKLOG", ["TASK-001", "TASK-002"]);

    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", dep1);
    allTasks.set("TASK-002", dep2);
    allTasks.set("TASK-003", task);

    expect(isTaskEligible(task, allTasks)).toBe(false);
  });

  test("should return false for BACKLOG task with missing dependency", () => {
    const task = makeTaskSummary("TASK-002", "BACKLOG", ["TASK-001"]);

    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-002", task);
    // TASK-001 does not exist

    expect(isTaskEligible(task, allTasks)).toBe(false);
  });

  test("should return false for non-BACKLOG tasks", () => {
    const inProgress = makeTaskSummary("TASK-001", "IN_PROGRESS");
    const complete = makeTaskSummary("TASK-002", "COMPLETE");
    const rejected = makeTaskSummary("TASK-003", "REJECTED");

    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", inProgress);
    allTasks.set("TASK-002", complete);
    allTasks.set("TASK-003", rejected);

    expect(isTaskEligible(inProgress, allTasks)).toBe(false);
    expect(isTaskEligible(complete, allTasks)).toBe(false);
    expect(isTaskEligible(rejected, allTasks)).toBe(false);
  });

  test("should return false for READY status tasks", () => {
    const task = makeTaskSummary("TASK-001", "READY");
    const allTasks = new Map<string, TaskSummary>();
    allTasks.set("TASK-001", task);

    expect(isTaskEligible(task, allTasks)).toBe(false);
  });
});

describe("resolveDependencies", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-resolve-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should classify eligible and blocked tasks", async () => {
    // TASK-001: COMPLETE (dependency for others)
    await fs.writeFile(
      path.join(tmpDir, "TASK-001.md"),
      makeTaskContent("TASK-001", "Base Task", { status: "COMPLETE" }),
    );

    // TASK-002: BACKLOG, blocked by TASK-001 (COMPLETE) -> eligible
    await fs.writeFile(
      path.join(tmpDir, "TASK-002.md"),
      makeTaskContent("TASK-002", "Ready Task", {
        status: "BACKLOG",
        blockedBy: ["TASK-001"],
      }),
    );

    // TASK-003: BACKLOG, no dependencies -> eligible
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

    const result = await resolveDependencies(tmpDir);

    expect(result.errors).toHaveLength(0);
    expect(result.eligible).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);

    const eligibleIds = result.eligible.map((t) => t.id).sort();
    expect(eligibleIds).toEqual(["TASK-002", "TASK-003"]);

    const blockedIds = result.blocked.map((t) => t.id);
    expect(blockedIds).toEqual(["TASK-004"]);
  });

  test("should skip non-BACKLOG tasks from both eligible and blocked", async () => {
    await fs.writeFile(
      path.join(tmpDir, "TASK-001.md"),
      makeTaskContent("TASK-001", "Complete Task", { status: "COMPLETE" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "TASK-002.md"),
      makeTaskContent("TASK-002", "In Progress Task", {
        status: "IN_PROGRESS",
      }),
    );

    const result = await resolveDependencies(tmpDir);

    expect(result.eligible).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  test("should handle empty directory", async () => {
    const result = await resolveDependencies(tmpDir);

    expect(result.eligible).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("should collect parse errors without failing", async () => {
    await fs.writeFile(
      path.join(tmpDir, "TASK-001.md"),
      makeTaskContent("TASK-001", "Good Task", { status: "BACKLOG" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "TASK-002-broken.md"),
      "This is not a valid task file at all.",
    );

    const result = await resolveDependencies(tmpDir);

    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0].id).toBe("TASK-001");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("TASK-002-broken.md");
  });
});

// ─── Status overlay (TASK-1202) ────────────────────────────────────────

describe("status overlay", () => {
  async function makeProjectWithSpecs(
    specs: Array<{ id: string; status: TaskStatus; blockedBy?: string[] }>,
  ): Promise<{ root: string; taskDir: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-overlay-"));
    const taskDir = path.join(root, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    for (const spec of specs) {
      await fs.writeFile(
        path.join(taskDir, `${spec.id}-test.md`),
        makeTaskContent(spec.id, `Task ${spec.id}`, {
          status: spec.status,
          blockedBy: spec.blockedBy,
        }),
      );
    }
    return { root, taskDir };
  }

  function seedDb(root: string, rows: Array<{ id: string; status: string }>): void {
    fsSync.mkdirSync(path.join(root, ".quack"), { recursive: true });
    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    for (const row of rows) {
      db.setStatus(row.id, row.status, "test");
    }
    db.close();
  }

  test("loadStatusOverlay returns null when the DB is absent and never creates it", async () => {
    const { root } = await makeProjectWithSpecs([]);

    expect(loadStatusOverlay(root)).toBeNull();
    expect(fsSync.existsSync(path.join(root, ".quack", "quack.db"))).toBe(false);
  });

  test("loadStatusOverlay reads task_status rows from a seeded DB", async () => {
    const { root } = await makeProjectWithSpecs([]);
    seedDb(root, [
      { id: "TASK-001", status: "COMPLETE" },
      { id: "TASK-002", status: "IN_PROGRESS" },
    ]);

    const overlay = loadStatusOverlay(root);

    expect(overlay).not.toBeNull();
    expect(overlay?.get("TASK-001")).toBe("COMPLETE");
    expect(overlay?.get("TASK-002")).toBe("IN_PROGRESS");
  });

  test("a junk file at the DB path warns and falls back to null", async () => {
    const { root } = await makeProjectWithSpecs([]);
    fsSync.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fsSync.writeFileSync(path.join(root, ".quack", "quack.db"), "not a sqlite database");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(loadStatusOverlay(root)).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("status overlay unavailable"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a DB overlay unblocks dependents whose dependency spec is stale", async () => {
    const { root, taskDir } = await makeProjectWithSpecs([
      { id: "TASK-001", status: "IN_PROGRESS" },
      { id: "TASK-002", status: "BACKLOG", blockedBy: ["TASK-001"] },
    ]);

    const withoutOverlay = await resolveDependencies(taskDir);
    expect(withoutOverlay.eligible.map((t) => t.id)).toEqual([]);

    seedDb(root, [{ id: "TASK-001", status: "COMPLETE" }]);
    const overlay = loadStatusOverlay(root);
    const withOverlay = await resolveDependencies(taskDir, { statusOverlay: overlay });

    expect(withOverlay.eligible.map((t) => t.id)).toEqual(["TASK-002"]);
  });

  test("a DB row also governs the candidate's own BACKLOG check", async () => {
    const { root, taskDir } = await makeProjectWithSpecs([{ id: "TASK-001", status: "BACKLOG" }]);
    seedDb(root, [{ id: "TASK-001", status: "IN_PROGRESS" }]);

    const overlay = loadStatusOverlay(root);
    const result = await resolveDependencies(taskDir, { statusOverlay: overlay });

    expect(result.eligible).toHaveLength(0);
  });

  test("VERIFIED overlay values satisfy dependency completeness", async () => {
    const { root, taskDir } = await makeProjectWithSpecs([
      { id: "TASK-001", status: "IN_PROGRESS" },
      { id: "TASK-002", status: "BACKLOG", blockedBy: ["TASK-001"] },
    ]);
    seedDb(root, [{ id: "TASK-001", status: "VERIFIED" }]);

    const overlay = loadStatusOverlay(root);
    const result = await resolveDependencies(taskDir, { statusOverlay: overlay });

    expect(result.eligible.map((t) => t.id)).toEqual(["TASK-002"]);
  });

  test("summaries carry statusSource + specStatus for drift display", async () => {
    const { root, taskDir } = await makeProjectWithSpecs([
      { id: "TASK-001", status: "IN_PROGRESS" },
      { id: "TASK-002", status: "BACKLOG" },
    ]);
    seedDb(root, [{ id: "TASK-001", status: "COMPLETE" }]);

    const overlay = loadStatusOverlay(root);
    const { tasks } = await parseAllTasks(taskDir, { statusOverlay: overlay });

    expect(tasks.get("TASK-001")).toMatchObject({
      status: "COMPLETE",
      statusSource: "db",
      specStatus: "IN_PROGRESS",
    });
    expect(tasks.get("TASK-002")).toMatchObject({
      status: "BACKLOG",
      statusSource: "file",
      specStatus: "BACKLOG",
    });
  });

  test("overlay ids with no matching spec produce no phantom tasks", async () => {
    const { root, taskDir } = await makeProjectWithSpecs([{ id: "TASK-001", status: "BACKLOG" }]);
    seedDb(root, [{ id: "TASK-999", status: "COMPLETE" }]);

    const overlay = loadStatusOverlay(root);
    const { tasks } = await parseAllTasks(taskDir, { statusOverlay: overlay });

    expect(tasks.size).toBe(1);
    expect(tasks.has("TASK-999")).toBe(false);
  });

  test("no overlay option leaves behavior and fields spec-derived", async () => {
    const { taskDir } = await makeProjectWithSpecs([{ id: "TASK-001", status: "BACKLOG" }]);

    const { tasks } = await parseAllTasks(taskDir);

    expect(tasks.get("TASK-001")).toMatchObject({
      status: "BACKLOG",
      statusSource: "file",
      specStatus: "BACKLOG",
    });
  });
});
