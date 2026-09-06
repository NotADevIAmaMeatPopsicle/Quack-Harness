import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ParsedTask } from "../../src/core/types";
import { runVerifyWorkflow } from "../../src/workflows/verify-orchestrator";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-verify-workflow-"));
}

function makeTask(): ParsedTask {
  return {
    id: "TASK-837",
    title: "Verify workflow",
    priority: "P1-HIGH",
    effort: "1-2 hours",
    status: "READY",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["workflow"],
    problemStatement: "Verify workflow.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [{ path: "src/workflows/verify-orchestrator.ts", action: "Create", notes: "" }],
    successCriteria: ["Verify API returns phase data"],
    testingRequirements: ["Unit tests pass"],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "# TASK-837: Verify workflow",
  };
}

describe("runVerifyWorkflow", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns deterministic verified phase results and evidence", async () => {
    const result = await runVerifyWorkflow({
      projectRoot,
      task: makeTask(),
      projectId: "quack",
    });

    expect(result.statusCode).toBe(200);
    expect(result.verdict).toBe("VERIFIED");
    expect(result.record.state).toBe("verified");
    expect(result.record.attempts[0].phaseResults).toEqual([
      { name: "review_linkage", status: "skipped", summary: "Review linkage was not required." },
      { name: "success_criteria", status: "passed", summary: "1 success criteria present." },
    ]);
    expect(result.record.evidenceBundle).toMatchObject({
      taskId: "TASK-837",
      workflowState: "verified",
      verification: {
        verdict: "VERIFIED",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });
  });

  it("blocks verification when review linkage is required but missing", async () => {
    const result = await runVerifyWorkflow({
      projectRoot,
      task: makeTask(),
      requireReview: true,
    });

    expect(result.statusCode).toBe(409);
    expect(result.verdict).toBe("BLOCKED");
    expect(result.record).toMatchObject({
      status: "blocked",
      state: "blocked",
      blockReasonCode: "review_linkage_required",
    });
    expect(result.record.evidenceBundle).toMatchObject({
      workflowState: "blocked",
      blockReasonCode: "review_linkage_required",
    });
  });
});
