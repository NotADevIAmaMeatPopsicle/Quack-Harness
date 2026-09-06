import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseTaskFile } from "../../src/core/task-parser";
import { deriveSessionStatus } from "../../src/core/task-state";
import { persistClaimantDiagnostic } from "../../src/monitor/claimant-diagnostic";
import { EventWriter } from "../../src/monitor/event-emitter";
import { EventReader } from "../../src/monitor/event-reader";
import { resolveWorkflowState } from "../../src/workflow/workflow-state-resolver";

function spec(taskId: string): string {
  return [
    `# ${taskId}: workflow diagnostic fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** SMALL",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** [fixture]",
    "",
    "## Problem Statement",
    "Keep diagnostics inert and repairable.",
    "",
    "## Success Criteria",
    "- [ ] Projection is truthful",
    "",
    "## Testing Requirements",
    "- [ ] Fresh reader",
  ].join("\n");
}

describe("TASK-1338-D claimant diagnostic workflow projection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("is visible for audit but inert for latest execution and cost summaries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338d-workflow-"));
    roots.push(root);
    const taskDir = path.join(root, "specs", "backlog");
    const logDir = path.join(root, "custom", "durable-log");
    fs.mkdirSync(taskDir, { recursive: true });
    const firstPath = path.join(taskDir, "TASK-610-a.md");
    const secondPath = path.join(taskDir, "TASK-999-cross.md");
    fs.writeFileSync(firstPath, spec("TASK-610"), "utf-8");
    fs.writeFileSync(secondPath, spec("TASK-610"), "utf-8");
    const task = parseTaskFile(fs.readFileSync(firstPath, "utf-8"), firstPath);

    const execution = new EventWriter({
      sessionId: "quack-TASK-610-execution",
      taskId: "TASK-610",
      project: "project-a",
      logDir,
    });
    execution.recordSession("completed", {
      outcome: "approved",
      totalCostUsd: 2.5,
      durationMs: 1000,
      turnsUsed: 4,
    });
    execution.emit("session_complete", { outcome: "approved", durationMs: 1000 });

    await persistClaimantDiagnostic({
      logDir,
      project: "project-a",
      diagnostic: {
        kind: "duplicate-claimants",
        taskId: "TASK-610",
        commitSha: "commit-610",
        claimants: ["TASK-999-cross.md", "TASK-610-a.md"],
        scannerMethod: "migration-scan",
        reason: "Task TASK-610 has a contested id.",
      },
    });

    const freshReader = new EventReader(logDir);
    expect(freshReader.getAllSessions()).toHaveLength(2);
    expect(
      freshReader.getAllSessions().some((session) => session.outcome === "claimant_diagnostic"),
    ).toBe(true);
    expect(
      deriveSessionStatus("READY", {
        outcome: "claimant_diagnostic",
        status: "completed",
      }),
    ).toBe("READY");
    expect(freshReader.getCostSummary()).toMatchObject({
      sessionCount: 1,
      totalCostUsd: 2.5,
    });

    const projection = await resolveWorkflowState({
      projectRoot: root,
      taskDir,
      task,
      reader: freshReader,
      hostId: "project-a",
    });
    expect(projection).toMatchObject({
      state: "blocked",
      blockReasonCode: "pending_manual_handoff",
      sessionId: "quack-TASK-610-execution",
      claimantDiagnostic: {
        taskId: "TASK-610",
        claimants: ["TASK-610-a.md", "TASK-999-cross.md"],
        commitSha: "commit-610",
        scannerMethod: "migration-scan",
      },
    });
    expect(task.status).toBe("READY");

    fs.rmSync(secondPath);
    const cleared = await resolveWorkflowState({
      projectRoot: root,
      taskDir,
      task,
      reader: new EventReader(logDir),
      hostId: "project-a",
    });
    expect(cleared.claimantDiagnostic).toBeUndefined();
    expect(cleared.blockReasonCode).not.toBe("pending_manual_handoff");
    expect(
      new EventReader(logDir)
        .getAllSessions()
        .some((session) => session.outcome === "claimant_diagnostic"),
    ).toBe(true);
  });

  it("keeps the same task id in a second project completely isolated", async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338d-project-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338d-project-b-"));
    roots.push(rootA, rootB);
    const taskDirA = path.join(rootA, "docs", "tasks");
    const taskDirB = path.join(rootB, "docs", "tasks");
    const logDirA = path.join(rootA, "logs-a");
    const logDirB = path.join(rootB, "logs-b");
    fs.mkdirSync(taskDirA, { recursive: true });
    fs.mkdirSync(taskDirB, { recursive: true });
    const specA = path.join(taskDirA, "TASK-610.md");
    const specB = path.join(taskDirB, "TASK-610.md");
    fs.writeFileSync(specA, spec("TASK-610"), "utf-8");
    fs.writeFileSync(specB, spec("TASK-610"), "utf-8");
    fs.writeFileSync(path.join(taskDirA, "TASK-999-cross.md"), spec("TASK-610"), "utf-8");
    fs.mkdirSync(path.join(rootB, ".quack"), { recursive: true });
    const verifiedB = path.join(rootB, ".quack", "verified.json");
    const cursorB = path.join(rootB, ".quack", "on-merge-cursor.json");
    fs.writeFileSync(verifiedB, "project-b-ledger\n", "utf-8");
    fs.writeFileSync(cursorB, "project-b-cursor\n", "utf-8");

    await persistClaimantDiagnostic({
      logDir: logDirA,
      project: "project-a",
      diagnostic: {
        kind: "duplicate-claimants",
        taskId: "TASK-610",
        commitSha: "same-id-project-a",
        claimants: ["TASK-610.md", "TASK-999-cross.md"],
        scannerMethod: "on-merge",
        reason: "Task TASK-610 has a contested id.",
      },
    });

    const projectionB = await resolveWorkflowState({
      projectRoot: rootB,
      taskDir: taskDirB,
      task: parseTaskFile(fs.readFileSync(specB, "utf-8"), specB),
      reader: new EventReader(logDirB),
      hostId: "project-b",
    });
    expect(projectionB.claimantDiagnostic).toBeUndefined();
    expect(projectionB.blockReasonCode).not.toBe("pending_manual_handoff");
    expect(new EventReader(logDirB).getAllSessions()).toEqual([]);
    expect(fs.readFileSync(verifiedB, "utf-8")).toBe("project-b-ledger\n");
    expect(fs.readFileSync(cursorB, "utf-8")).toBe("project-b-cursor\n");
    expect(fs.existsSync(path.join(rootB, ".quack", "quack.db"))).toBe(false);
  });
});
