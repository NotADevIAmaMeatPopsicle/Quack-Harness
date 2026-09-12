// TASK-1333 / QPI-045: a judge clearance is valid only for the spec
// contract it reviewed. These tests exercise the state-transition writer
// directly so an HTTP-only guard cannot satisfy the contract.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { computeSpecIdentity } from "../../src/core/spec-identity.js";
import {
  loadJudgeApproval,
  saveJudgeApproval,
  updateJudgeApprovalState,
} from "../../src/dispatcher/judge-approval.js";

type ApprovalWriterWithIdentity = (
  taskId: string,
  state: "approved" | "auto-approved" | "rejected",
  logDir: string,
  approvedBy?: string,
  rejectionReason?: string,
  decision?: Record<string, unknown>,
  currentSpecIdentity?: ReturnType<typeof computeSpecIdentity>,
) => Promise<unknown>;

const updateWithIdentity = updateJudgeApprovalState as ApprovalWriterWithIdentity;

describe("TASK-1333 judge approval writer identity boundary", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-judge-identity-"));
  });

  afterEach(async () => {
    await fs.rm(logDir, { recursive: true, force: true });
  });

  it("refuses a stale human clearance atomically and names the recycle action", async () => {
    const original = computeSpecIdentity(
      "# TASK-1333\n\n## Metadata\n- **Status:** BACKLOG\n\n## Contract\nContract X\n",
    );
    const amended = computeSpecIdentity("# TASK-1333\n\nContract Y\n");
    await saveJudgeApproval(
      "TASK-1333",
      "diff",
      ["src/a.ts"],
      true,
      logDir,
      "pending",
      undefined,
      {
        rationale: ["human review required"],
        diffFingerprint: "fingerprint",
        heldAt: "2026-09-07T00:00:00.000Z",
      },
      original,
    );

    await expect(
      updateWithIdentity(
        "TASK-1333",
        "approved",
        logDir,
        "operator",
        undefined,
        undefined,
        amended,
      ),
    ).rejects.toThrow(/POST \/api\/tasks\/TASK-1333\/judge\/recycle/);

    const after = await loadJudgeApproval("TASK-1333", logDir);
    expect(after?.state).toBe("pending");
    expect(after?.intentHold?.diffFingerprint).toBe("fingerprint");
    expect(after?.approvedBy).toBeUndefined();
  });

  it("permits a clearance whose semantic contract still matches", async () => {
    const original = computeSpecIdentity(
      "# TASK-1333\n\n## Metadata\n- **Status:** BACKLOG\n\n## Contract\nContract X\n",
    );
    const operationalEdit = computeSpecIdentity(
      "# TASK-1333\n\n## Metadata\n- **Status:** IN_PROGRESS\n\n## Contract\nContract X\n",
    );
    await saveJudgeApproval(
      "TASK-1333",
      "diff",
      ["src/a.ts"],
      true,
      logDir,
      "pending",
      undefined,
      undefined,
      original,
    );

    await updateWithIdentity(
      "TASK-1333",
      "approved",
      logDir,
      "operator",
      undefined,
      undefined,
      operationalEdit,
    );

    expect((await loadJudgeApproval("TASK-1333", logDir))?.state).toBe("approved");
  });

  it("grandfathers only a genuinely pre-1332 approval record", async () => {
    const approvalDir = path.join(logDir, "approvals");
    await fs.mkdir(approvalDir, { recursive: true });
    await fs.writeFile(
      path.join(approvalDir, "TASK-LEGACY-judge.json"),
      JSON.stringify({
        taskId: "TASK-LEGACY",
        state: "pending",
        diff: "legacy diff",
        filesModified: [],
        filesCreated: [],
        verificationPassed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    await updateWithIdentity(
      "TASK-LEGACY",
      "approved",
      logDir,
      "operator",
      undefined,
      undefined,
      computeSpecIdentity("# TASK-LEGACY\n\nCurrent contract\n"),
    );

    expect((await loadJudgeApproval("TASK-LEGACY", logDir))?.state).toBe("approved");
  });

  it("does not mistake a stamping-aware unresolved identity for legacy", async () => {
    await saveJudgeApproval("TASK-UNKNOWN", "diff", [], true, logDir, "pending");

    await expect(
      updateWithIdentity(
        "TASK-UNKNOWN",
        "approved",
        logDir,
        "operator",
        undefined,
        undefined,
        computeSpecIdentity("# TASK-UNKNOWN\n\nCurrent contract\n"),
      ),
    ).rejects.toThrow(/could not be resolved|no spec identity/i);
    expect((await loadJudgeApproval("TASK-UNKNOWN", logDir))?.state).toBe("pending");
  });
});
