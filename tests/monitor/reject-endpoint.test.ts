/* eslint-disable @typescript-eslint/no-unused-vars */
// ─── Reject Endpoint Logic Tests ──────────────────────────────────
// Tests for the POST /api/tasks/:id/reject logic.
// Because server.ts currently has unresolved merge conflicts, we test
// the reject-endpoint logic directly against the filesystem + TaskService
// rather than spinning up a full HTTP server.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { TaskService } from "../../src/monitor/task-service";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTaskFile(id: string, status: string): string {
  return [
    `# ${id}: Test Task`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 2-4 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Tags:** test",
    "",
    "## Problem Statement",
    "Test problem",
    "",
    "## Success Criteria",
    "- Criterion 1",
    "",
    "## Testing Requirements",
    "- Test it",
  ].join("\n");
}

/**
 * Replicate the reject endpoint logic from server.ts POST /api/tasks/:id/reject.
 * This mirrors the implementation so we can test it without importing server.ts.
 */
async function rejectTask(
  taskService: TaskService,
  projectRoot: string,
  taskId: string,
  reason: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const filePath = await taskService.getTaskFilePath(taskId);
  if (!filePath) {
    return { status: 404, body: { error: `Task ${taskId} not found` } };
  }

  const content = await fs.readFile(filePath, "utf-8");
  const statusMatch = content.match(/\*\*Status:\*\*\s*(\w+)/);
  const previousStatus = statusMatch?.[1] ?? "UNKNOWN";

  if (previousStatus === "REJECTED") {
    return { status: 400, body: { error: `Task ${taskId} is already REJECTED` } };
  }

  const updated = content.replace(/(\*\*Status:\*\*\s*)\w+/, "$1REJECTED");
  await fs.writeFile(filePath, updated, "utf-8");

  // Write to verified.json
  const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
  let verifiedData: { tasks: Record<string, unknown>; [key: string]: unknown };
  try {
    const raw = await fs.readFile(verifiedPath, "utf-8");
    verifiedData = JSON.parse(raw) as typeof verifiedData;
  } catch {
    verifiedData = {
      _description: "Post-completion verification index.",
      _schema: { taskId: "TASK-NNN", verified: "ISO date", method: "string", verdict: "string" },
      tasks: {},
    };
  }
  verifiedData.tasks[taskId] = {
    verified: new Date().toISOString().split("T")[0],
    commit: "n/a",
    method: "api",
    verdict: "REJECTED",
    criteriaChecked: 0,
    criteriaPassed: 0,
    notes: reason || "Rejected via API",
  };
  await fs.mkdir(path.dirname(verifiedPath), { recursive: true });
  await fs.writeFile(verifiedPath, JSON.stringify(verifiedData, null, 2) + "\n", "utf-8");

  return {
    status: 200,
    body: { success: true, taskId, previousStatus, newStatus: "REJECTED" },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("POST /api/tasks/:id/reject logic", () => {
  let projectRoot: string;
  let taskDir: string;
  let taskService: TaskService;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-test-reject-"));
    taskDir = path.join(projectRoot, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });

    // Create a READY task
    await fs.writeFile(
      path.join(taskDir, "TASK-001-test.md"),
      makeTaskFile("TASK-001", "READY"),
      "utf-8",
    );

    // Create an already-REJECTED task
    await fs.writeFile(
      path.join(taskDir, "TASK-002-rejected.md"),
      makeTaskFile("TASK-002", "REJECTED"),
      "utf-8",
    );

    taskService = new TaskService(projectRoot, "docs/tasks");
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("returns 404 for non-existent task", async () => {
    const result = await rejectTask(taskService, projectRoot, "TASK-999", "Does not exist");
    expect(result.status).toBe(404);
    expect(result.body.error).toContain("TASK-999");
  });

  it("returns 400 for already-REJECTED task", async () => {
    const result = await rejectTask(taskService, projectRoot, "TASK-002", "Already rejected");
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("already REJECTED");
  });

  it("successfully rejects a READY task and updates file status", async () => {
    const result = await rejectTask(taskService, projectRoot, "TASK-001", "Wrong approach");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      taskId: "TASK-001",
      previousStatus: "READY",
      newStatus: "REJECTED",
    });

    // Verify the task file was updated
    const updatedContent = await fs.readFile(path.join(taskDir, "TASK-001-test.md"), "utf-8");
    expect(updatedContent).toContain("**Status:** REJECTED");
  });

  it("writes rejection entry to verified.json", async () => {
    await rejectTask(taskService, projectRoot, "TASK-001", "Wrong approach");

    const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
    const raw = await fs.readFile(verifiedPath, "utf-8");
    const verifiedData = JSON.parse(raw) as {
      tasks: Record<
        string,
        {
          verdict: string;
          method: string;
          notes: string;
          criteriaChecked: number;
          criteriaPassed: number;
        }
      >;
    };

    const entry = verifiedData.tasks["TASK-001"];
    expect(entry).toBeDefined();
    expect(entry.verdict).toBe("REJECTED");
    expect(entry.method).toBe("api");
    expect(entry.notes).toBe("Wrong approach");
    expect(entry.criteriaChecked).toBe(0);
    expect(entry.criteriaPassed).toBe(0);
  });
});
