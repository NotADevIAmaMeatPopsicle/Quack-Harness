import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ParsedTask } from "../../src/core/types";
import { runFixWorkflow } from "../../src/workflows/fix-orchestrator";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-fix-workflow-"));
}

function makeTask(): ParsedTask {
  return {
    id: "TASK-837",
    title: "Fix workflow",
    priority: "P1-HIGH",
    effort: "1-2 hours",
    status: "READY",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["workflow"],
    problemStatement: "Fix workflow.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [{ path: "src/workflows/fix-orchestrator.ts", action: "Create", notes: "" }],
    successCriteria: ["Fix API records attempts"],
    testingRequirements: ["Unit tests pass"],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "# TASK-837: Fix workflow",
  };
}

describe("runFixWorkflow", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("records a completed remediation attempt", async () => {
    const result = await runFixWorkflow({
      projectRoot,
      task: makeTask(),
      issues: ["Missing API docs"],
      fixed: true,
    });

    expect(result.statusCode).toBe(200);
    expect(result.exhausted).toBe(false);
    expect(result.record).toMatchObject({
      status: "completed",
      state: "verify_fix",
      attempts: [{ attempt: 1, kind: "fix", status: "fixed", verdict: "FIXED" }],
    });
    expect(result.record.evidenceBundle).toMatchObject({
      taskId: "TASK-837",
      workflowState: "verify_fix",
    });
  });

  it("escalates to a manual handoff bundle after the attempt cap", async () => {
    const first = await runFixWorkflow({
      projectRoot,
      task: makeTask(),
      issues: ["Still failing"],
      maxAttempts: 2,
    });
    const second = await runFixWorkflow({
      projectRoot,
      task: makeTask(),
      workflowId: first.record.workflowId,
      issues: ["Still failing"],
      maxAttempts: 2,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.exhausted).toBe(true);
    expect(second.record).toMatchObject({
      status: "blocked",
      state: "blocked",
      blockReasonCode: "workflow_attempts_exhausted",
      handoffBundle: {
        taskId: "TASK-837",
        blockReasonCode: "workflow_attempts_exhausted",
        issues: ["Still failing"],
      },
    });
    expect(second.record.attempts).toHaveLength(2);
  });
});
