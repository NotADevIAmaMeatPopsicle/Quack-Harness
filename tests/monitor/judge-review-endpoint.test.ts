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
import { execFileSync } from "node:child_process";
import { createMonitorServer } from "../../src/monitor/server.js";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager.js";
import { computeSpecIdentity } from "../../src/core/spec-identity.js";

const TEST_SPEC_IDENTITY = computeSpecIdentity("# TASK-TEST\n\nTest contract\n");

function taskMarkdown(taskId: string, contract: string): string {
  return [
    `# ${taskId}: Judge route fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** test, judge",
    "",
    "## Problem Statement",
    contract,
    "",
    "## Current State",
    "The fixture has a prior judge result that requires an operator decision.",
    "",
    "## Recommended Approach",
    "Resolve the exact current contract before starting a replacement run.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/example.ts` | Modify | Exercise the judge route |",
    "",
    "## Success Criteria",
    "- [ ] The judge decision applies only to this exact task contract",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the HTTP decision route",
    "",
    "## Anti-Patterns",
    "- Do not consume state from another task version",
    "",
    "## Context References",
    "- Judge review endpoint regression",
    "",
  ].join("\n");
}

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
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir, TEST_SPEC_IDENTITY);

      const { updateJudgeApprovalState } = await import("../../src/dispatcher/judge-approval.js");
      await updateJudgeApprovalState(
        taskId,
        "approved",
        logDir,
        "human",
        undefined,
        undefined,
        TEST_SPEC_IDENTITY,
      );

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
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, "TASK-005-reject.md"),
      taskMarkdown("TASK-005", "Reject the prior implementation and retry the current contract."),
    );
    await fs.writeFile(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: {
          name: "judge-endpoint-test",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        agent: { model: "claude-sonnet-4-6", maxTurns: 10, maxBudgetPerTask: 1 },
        verification: {
          commands: [
            { name: "fixture", command: "node --version", required: true, timeout: 60_000 },
          ],
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Automated-By: Quack",
          autoPush: false,
        },
        logging: { level: "info", dir: ".quack/logs" },
        executionMode: "dispatch",
      }),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.test"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Test"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: tempDir, stdio: "ignore" });
    await savePendingJudgeApproval("TASK-005", "diff", ["file.ts"], true, runtimeLogDir);

    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-005",
      sessionId: "mock-session",
      pid: 1,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    } satisfies DispatchJob);
    const monitor = createMonitorServer({
      logDir: runtimeLogDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot: tempDir,
      taskDir: "docs/tasks",
    });
    const started = await monitor.start();

    try {
      const response = await httpPost(
        `http://127.0.0.1:${started.port}/api/tasks/TASK-005/judge/reject`,
        { rejectionReason: "Try again" },
      );

      expect(response).toEqual(expect.objectContaining({ status: 200 }));
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
      await started.stop();
    }
  });

  it("archives a stale judge run and starts fresh from the authoritative spec", async () => {
    const taskId = "TASK-1333";
    const quackDir = path.join(tempDir, ".quack");
    const runtimeLogDir = path.join(quackDir, "logs");
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(runtimeLogDir, { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: {
          name: "judge-recycle-test",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        agent: { model: "claude-sonnet-4-6", maxTurns: 10, maxBudgetPerTask: 1 },
        verification: {
          commands: [
            { name: "fixture", command: "node --version", required: true, timeout: 60_000 },
          ],
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Automated-By: Quack",
          autoPush: false,
        },
        logging: { level: "info", dir: ".quack/logs" },
        executionMode: "dispatch",
      }),
    );

    const contractX = taskMarkdown("TASK-1333", "Contract X must be archived before retry.");
    const contractY = taskMarkdown("TASK-1333", "Contract Y is now authoritative for retry.");
    await fs.writeFile(path.join(taskDir, "TASK-1333-recycle.md"), contractX);
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: tempDir });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: tempDir });
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: tempDir });
    execFileSync("git", ["checkout", "-b", "quack/TASK-1333"], { cwd: tempDir });
    await fs.writeFile(path.join(tempDir, "worker-output.txt"), "paid work\n");
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "worker output"], { cwd: tempDir });
    execFileSync("git", ["checkout", "main"], { cwd: tempDir });
    await fs.writeFile(path.join(taskDir, "TASK-1333-recycle.md"), contractY);

    const { saveJudgeApproval } = await import("../../src/dispatcher/judge-approval.js");
    await saveJudgeApproval(
      taskId,
      "diff",
      ["worker-output.txt"],
      true,
      runtimeLogDir,
      "approved",
      undefined,
      {
        rationale: ["review under contract X"],
        diffFingerprint: "fp-x",
        heldAt: "2026-09-07T00:00:00.000Z",
      },
      computeSpecIdentity(contractX),
    );
    await fs.writeFile(
      path.join(runtimeLogDir, `checkpoint-${taskId}.json`),
      JSON.stringify({
        taskId,
        sessionId: "quack-TASK-1333-old",
        branchName: "quack/TASK-1333",
        completedStages: ["gate", "blueprint", "approve", "branch", "agent", "commit"],
        totalCostUsd: 1,
        retriesUsed: 0,
        startedAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:10:00.000Z",
      }),
    );

    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId,
      sessionId: "fresh-session",
      pid: 1,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    } satisfies DispatchJob);
    const monitor = createMonitorServer({
      logDir: runtimeLogDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot: tempDir,
      taskDir: "docs/tasks",
    });
    const started = await monitor.start();

    try {
      const response = await httpPost(
        `http://127.0.0.1:${started.port}/api/tasks/${taskId}/judge/recycle`,
        {},
      );
      const body = JSON.parse(response.body) as {
        ok: boolean;
        verdict: string;
        archive: { approvalPath: string; checkpointPath: string; branchRef: string };
      };

      expect(response).toEqual(expect.objectContaining({ status: 202 }));
      expect(body.ok).toBe(true);
      expect(body.verdict).toBe("stale");
      expect(await fs.readFile(body.archive.approvalPath, "utf-8")).toContain("fp-x");
      expect(await fs.stat(body.archive.checkpointPath)).toBeDefined();
      expect(
        execFileSync("git", ["rev-parse", body.archive.branchRef], {
          cwd: tempDir,
          encoding: "utf-8",
        }).trim(),
      ).toBe(
        execFileSync("git", ["rev-parse", "quack/TASK-1333"], {
          cwd: tempDir,
          encoding: "utf-8",
        }).trim(),
      );
      expect(startSpy).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ replaceArchivedJudgeRun: true }),
        { taskId, claimants: [] },
      );
      const recycleStartOptions = startSpy.mock.calls[0]?.[1];
      expect(recycleStartOptions).not.toHaveProperty("overridePausedRun");
      expect(recycleStartOptions).not.toHaveProperty("reuseWorktree");
      expect(recycleStartOptions).not.toHaveProperty("resume");
    } finally {
      startSpy.mockRestore();
      await started.stop();
    }
  });
});
