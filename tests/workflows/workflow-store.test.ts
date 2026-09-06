import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createEvidenceBundle } from "../../src/workflow/evidence-bundle";
import { WorkflowStore, type WorkflowRecord } from "../../src/workflows/workflow-store";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-workflow-store-"));
}

function makeRecord(workflowId: string): WorkflowRecord {
  const evidenceBundle = createEvidenceBundle({
    taskId: "TASK-837",
    workflowId,
    workflowState: "verified",
  });
  return {
    workflowId,
    taskId: "TASK-837",
    kind: "verify",
    status: "completed",
    state: "verified",
    attempts: [],
    findings: [],
    evidenceBundle,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
  };
}

describe("WorkflowStore", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("persists and retrieves workflow records", async () => {
    const store = new WorkflowStore(projectRoot);
    const record = makeRecord("workflow-task-837-verify-test");

    await store.save(record);

    await expect(store.get(record.workflowId)).resolves.toEqual(record);
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "workflows", `${record.workflowId}.json`)),
    ).toBe(true);
  });
});
