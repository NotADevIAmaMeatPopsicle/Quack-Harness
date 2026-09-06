// ─── Judge Review Endpoint Tests ──────────────────────────────────
// Tests for judge review API endpoints

import {
  savePendingJudgeApproval,
  loadJudgeApproval,
  deleteJudgeApproval,
} from "../../src/dispatcher/judge-approval.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createMonitorServer } from "../../src/monitor/server.js";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager.js";

async function httpPost(
  url: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(data);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("Judge Review Endpoints", () => {
  let tempDir: string;
  let logDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-review-endpoint-test-"));
    logDir = path.join(tempDir, "logs");
    await fs.mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("Judge approval state persistence for API endpoints", () => {
    it("should save approval state that can be retrieved by GET endpoint", async () => {
      const taskId = "TASK-001";
      const diff = "sample diff";
      const filesChanged = ["file1.ts", "file2.ts"];
      await savePendingJudgeApproval(taskId, diff, filesChanged, true, logDir);

      const approval = await loadJudgeApproval(taskId, logDir);

      expect(approval).not.toBeNull();
      expect(approval?.taskId).toBe(taskId);
      expect(approval?.state).toBe("pending");
      expect(approval?.diff).toBe(diff);
      expect(approval?.verificationPassed).toBe(true);
    });

    it("should return null for non-existent approvals (404 scenario)", async () => {
      const approval = await loadJudgeApproval("TASK-999", logDir);
      expect(approval).toBeNull();
    });

    it("should update approval state from pending to approved", async () => {
      const taskId = "TASK-002";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");
      await updateJudgeApprovalState(taskId, "approved", logDir, "human");

      const approval = await loadJudgeApproval(taskId, logDir);
      expect(approval?.state).toBe("approved");
      expect(approval?.approvedBy).toBe("human");
    });

    it("should update approval state from pending to rejected with reason", async () => {
      const taskId = "TASK-003";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");
      await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, "Wrong approach");

      const approval = await loadJudgeApproval(taskId, logDir);
      expect(approval?.state).toBe("rejected");
      expect(approval?.rejectionReason).toBe("Wrong approach");
    });

    it("should handle approval state updates for feedback scenarios", async () => {
      const taskId = "TASK-004";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");
      await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, undefined);

      const approval = await loadJudgeApproval(taskId, logDir);
      expect(approval?.state).toBe("rejected");
      expect(approval?.rejectionReason).toBeUndefined();
    });

    it("should throw error when trying to update non-existent approval", async () => {
      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");

      await expect(
        updateJudgeApprovalState("TASK-999", "approved", logDir, "human"),
      ).rejects.toThrow("No pending judge approval found");
    });

    it("should reject then delete approval to enable clean retry (reject endpoint flow)", async () => {
      const taskId = "TASK-005";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      // Step 1: Reject endpoint marks as rejected
      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");
      await updateJudgeApprovalState(
        taskId,
        "rejected",
        logDir,
        undefined,
        "Use different approach",
      );

      const rejected = await loadJudgeApproval(taskId, logDir);
      expect(rejected?.state).toBe("rejected");

      // Step 2: Reject endpoint deletes approval file before re-dispatching
      const deleted = await deleteJudgeApproval(taskId, logDir);
      expect(deleted).toBe(true);

      // Step 3: Next dispatch finds no approval → creates fresh one
      const afterRetry = await loadJudgeApproval(taskId, logDir);
      expect(afterRetry).toBeNull();
    });
  });

  it("preserves dispatch-mode judge rejection start options", async () => {
    const quackDir = path.join(tempDir, ".quack");
    const runtimeLogDir = path.join(quackDir, "logs");
    await fs.mkdir(runtimeLogDir, { recursive: true });
    await fs.writeFile(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: { name: "judge-endpoint-test", root: ".", taskDir: "docs/tasks" },
        agent: { model: "claude-sonnet-4-6", maxTurns: 10, maxBudgetPerTask: 1 },
        executionMode: "dispatch",
      }),
    );
    await savePendingJudgeApproval("TASK-005", "diff", ["file.ts"], true, runtimeLogDir);

    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-005",
      sessionId: "mock-session",
      pid: 1,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    } satisfies DispatchJob);
    const port = 30000 + Math.floor(Math.random() * 10000);
    const monitor = createMonitorServer({
      logDir: runtimeLogDir,
      port,
      projectRoot: tempDir,
      taskDir: "docs/tasks",
    });
    const { stop } = await monitor.start();

    try {
      const response = await httpPost(`http://localhost:${port}/api/tasks/TASK-005/judge/reject`, {
        rejectionReason: "Try again",
      });

      expect(response.status).toBe(200);
      expect(startSpy).toHaveBeenCalledWith(
        "TASK-005",
        expect.objectContaining({
          judgeFeedback: "Try again",
          duplicateClaimantCheck: { taskId: "TASK-005", claimants: [] },
        }),
        { taskId: "TASK-005", claimants: [] },
      );
      expect(startSpy.mock.calls[0]?.[1]).not.toHaveProperty("reuseWorktree");
      expect(startSpy.mock.calls[0]?.[1]).not.toHaveProperty("resume");
    } finally {
      startSpy.mockRestore();
      await stop();
    }
  });
});
