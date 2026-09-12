// ─── Judge Approval Tests ──────────────────────────────────────────
// Tests for judge approval state machine and auto-approve evaluator

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  evaluateJudgeAutoApprove,
  savePendingJudgeApproval,
  saveJudgeApproval,
  resavePendingJudgeApproval,
  loadJudgeApproval,
  updateJudgeApprovalState,
  deleteJudgeApproval,
  isApprovalExpired,
  type JudgeAutoApproveRules,
  type JudgeApproval,
} from "../../src/dispatcher/judge-approval.js";
import { computeSpecIdentity } from "../../src/core/spec-identity.js";

const TEST_SPEC_IDENTITY = computeSpecIdentity("# TASK-TEST\n\nTest contract\n");

describe("Judge Approval", () => {
  let tempDir: string;
  let logDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "judge-approval-test-"));
    logDir = path.join(tempDir, "logs");
    await fs.mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("evaluateJudgeAutoApprove", () => {
    const defaultRules: JudgeAutoApproveRules = {
      requireVerificationPass: true,
      maxFilesChanged: 3,
      maxDiffLines: 200,
    };

    it("should auto-approve small change (< maxFilesChanged, < maxDiffLines, verification pass)", () => {
      const diff = "line 1\nline 2\nline 3";
      const result = evaluateJudgeAutoApprove(diff, 2, true, defaultRules);
      expect(result).toBe(true);
    });

    it("should block when verification fails and requireVerificationPass is true", () => {
      const diff = "line 1\nline 2";
      const result = evaluateJudgeAutoApprove(diff, 2, false, defaultRules);
      expect(result).toBe(false);
    });

    it("should auto-approve when verification fails but requireVerificationPass is false", () => {
      const diff = "line 1\nline 2";
      const rules: JudgeAutoApproveRules = {
        requireVerificationPass: false,
        maxFilesChanged: 3,
        maxDiffLines: 200,
      };
      const result = evaluateJudgeAutoApprove(diff, 2, false, rules);
      expect(result).toBe(true);
    });

    it("should block when diff exceeds maxDiffLines", () => {
      const diff = Array(201).fill("line").join("\n");
      const result = evaluateJudgeAutoApprove(diff, 2, true, defaultRules);
      expect(result).toBe(false);
    });

    it("should auto-approve when diff is exactly at maxDiffLines", () => {
      const diff = Array(200).fill("line").join("\n");
      const result = evaluateJudgeAutoApprove(diff, 2, true, defaultRules);
      expect(result).toBe(true);
    });

    it("should block for large change (> maxFilesChanged)", () => {
      const diff = "line 1\nline 2";
      const result = evaluateJudgeAutoApprove(diff, 4, true, defaultRules);
      expect(result).toBe(false);
    });

    it("should auto-approve when filesChanged is exactly at maxFilesChanged", () => {
      const diff = "line 1\nline 2";
      const result = evaluateJudgeAutoApprove(diff, 3, true, defaultRules);
      expect(result).toBe(true);
    });

    it("should block when filesChanged exceeds maxFilesChanged even with verification pass and small diff", () => {
      const diff = "single line";
      const rules: JudgeAutoApproveRules = {
        requireVerificationPass: false,
        maxFilesChanged: 2,
        maxDiffLines: 500,
      };
      const result = evaluateJudgeAutoApprove(diff, 5, true, rules);
      expect(result).toBe(false);
    });
  });

  describe("savePendingJudgeApproval and loadJudgeApproval", () => {
    it("should save and load approval state", async () => {
      const taskId = "TASK-001";
      const diff = "sample diff";
      const filesChanged = ["file1.ts", "file2.ts"];
      const verificationPassed = true;

      await savePendingJudgeApproval(taskId, diff, filesChanged, verificationPassed, logDir);
      const loaded = await loadJudgeApproval(taskId, logDir);

      expect(loaded).not.toBeNull();
      expect(loaded?.taskId).toBe(taskId);
      expect(loaded?.state).toBe("pending");
      expect(loaded?.diff).toBe(diff);
      expect(loaded?.filesModified).toEqual(filesChanged);
      expect(loaded?.verificationPassed).toBe(verificationPassed);
      expect(loaded?.createdAt).toBeDefined();
    });

    it("should return null when approval does not exist", async () => {
      const loaded = await loadJudgeApproval("TASK-999", logDir);
      expect(loaded).toBeNull();
    });

    it("should separate filesModified and filesCreated based on prefix", async () => {
      const taskId = "TASK-002";
      const diff = "sample diff";
      const filesChanged = ["existing.ts", "new: newfile.ts", "created: another.ts"];
      const verificationPassed = true;

      await savePendingJudgeApproval(taskId, diff, filesChanged, verificationPassed, logDir);
      const loaded = await loadJudgeApproval(taskId, logDir);

      expect(loaded?.filesModified).toEqual(["existing.ts"]);
      expect(loaded?.filesCreated).toEqual(["newfile.ts", "another.ts"]);
    });

    it("round-trips loop runner_error evidence and worker session", async () => {
      await saveJudgeApproval("TASK-1307", "diff", ["file.ts"], true, logDir, "pending", {
        review: {
          status: "runner_error",
          errorKind: "spawn_failed",
          message: "sandbox unavailable",
          runner: "codex-cli",
          durationMs: 5,
        },
        reviewedAt: "2026-07-16T00:00:00.000Z",
        reviewGate: {
          crossModelSatisfied: false,
          crossModelEvidence: {
            status: "unknown",
            basis: "producer_unknown",
            reviewer: {
              runner: "codex-cli",
              provider: "openai",
              model: "gpt-5.6-terra",
            },
          },
          anchorAuditPassed: false,
          treeClean: false,
          fidelityPassed: true,
          eligibleForAutoApproval: false,
          reasons: ["review runner failed: spawn_failed"],
        },
        agentSessionId: "worker-session",
      });

      expect(await loadJudgeApproval("TASK-1307", logDir)).toMatchObject({
        executionMode: "loop",
        agentSessionId: "worker-session",
        review: { status: "runner_error", errorKind: "spawn_failed" },
        reviewGate: {
          crossModelEvidence: {
            status: "unknown",
            basis: "producer_unknown",
          },
        },
      });
    });
  });

  describe("updateJudgeApprovalState", () => {
    it("should update approval state to approved", async () => {
      const taskId = "TASK-003";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir, TEST_SPEC_IDENTITY);

      await updateJudgeApprovalState(
        taskId,
        "approved",
        logDir,
        "human",
        undefined,
        undefined,
        TEST_SPEC_IDENTITY,
      );
      const loaded = await loadJudgeApproval(taskId, logDir);

      expect(loaded?.state).toBe("approved");
      expect(loaded?.approvedBy).toBe("human");
      expect(loaded?.decidedAt).toBeDefined();
    });

    it("should update approval state to rejected with reason", async () => {
      const taskId = "TASK-004";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, "Wrong approach");
      const loaded = await loadJudgeApproval(taskId, logDir);

      expect(loaded?.state).toBe("rejected");
      expect(loaded?.rejectionReason).toBe("Wrong approach");
      expect(loaded?.decidedAt).toBeDefined();
    });

    it("should throw error when approval does not exist", async () => {
      await expect(
        updateJudgeApprovalState("TASK-999", "approved", logDir, "human"),
      ).rejects.toThrow("No pending judge approval found");
    });
  });

  describe("isApprovalExpired", () => {
    it("should return false for non-pending approvals", async () => {
      const taskId = "TASK-005";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir, TEST_SPEC_IDENTITY);
      await updateJudgeApprovalState(
        taskId,
        "approved",
        logDir,
        "human",
        undefined,
        undefined,
        TEST_SPEC_IDENTITY,
      );
      const loaded = await loadJudgeApproval(taskId, logDir);

      const expired = isApprovalExpired(loaded!, 1000);
      expect(expired).toBe(false);
    });

    it("should return false for fresh pending approvals", async () => {
      const taskId = "TASK-006";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);
      const loaded = await loadJudgeApproval(taskId, logDir);

      const expired = isApprovalExpired(loaded!, 24 * 60 * 60 * 1000);
      expect(expired).toBe(false);
    });

    it("should return true for pending approvals past timeout", async () => {
      const taskId = "TASK-007";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);
      const loaded = await loadJudgeApproval(taskId, logDir);

      // Set createdAt to 2 days ago
      const approval = {
        ...loaded!,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const approvalPath = path.join(logDir, "approvals", `${taskId}-judge.json`);
      await fs.writeFile(approvalPath, JSON.stringify(approval, null, 2), "utf-8");

      const reloaded = await loadJudgeApproval(taskId, logDir);
      const expired = isApprovalExpired(reloaded!, 24 * 60 * 60 * 1000);
      expect(expired).toBe(true);
    });
  });

  describe("deleteJudgeApproval", () => {
    it("should delete an existing approval file", async () => {
      const taskId = "TASK-008";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      const before = await loadJudgeApproval(taskId, logDir);
      expect(before).not.toBeNull();

      const deleted = await deleteJudgeApproval(taskId, logDir);
      expect(deleted).toBe(true);

      const after = await loadJudgeApproval(taskId, logDir);
      expect(after).toBeNull();
    });

    it("should return false when approval file does not exist", async () => {
      const deleted = await deleteJudgeApproval("TASK-999", logDir);
      expect(deleted).toBe(false);
    });
  });

  describe("rejection → retry flow", () => {
    it("should preserve rejected state until explicit deletion", async () => {
      const taskId = "TASK-009";
      await savePendingJudgeApproval(taskId, "diff", ["file.ts"], true, logDir);

      // Reject the approval
      await updateJudgeApprovalState(taskId, "rejected", logDir, undefined, "Wrong approach");
      const rejected = await loadJudgeApproval(taskId, logDir);
      expect(rejected?.state).toBe("rejected");
      expect(rejected?.rejectionReason).toBe("Wrong approach");

      // State stays rejected (dispatcher should not clear it)
      const reloaded = await loadJudgeApproval(taskId, logDir);
      expect(reloaded?.state).toBe("rejected");

      // API endpoint deletes file to allow fresh approval on retry
      const deleted = await deleteJudgeApproval(taskId, logDir);
      expect(deleted).toBe(true);

      // Next dispatch will not find an existing approval
      const afterDelete = await loadJudgeApproval(taskId, logDir);
      expect(afterDelete).toBeNull();
    });
  });

  // ─── resavePendingJudgeApproval (QPI-043 twin) ─────────────────

  describe("resavePendingJudgeApproval (QPI-043)", () => {
    it("re-stamps createdAt while preserving diff, files, evidence, session, and the intent hold", async () => {
      await saveJudgeApproval(
        "TASK-1273",
        "diff --git a/x b/x\n+1\n",
        ["src/x.ts", "new: src/y.ts"],
        true,
        logDir,
        "pending",
        {
          review: {
            status: "completed",
            verdict: "FIX_FIRST",
            findings: [],
            summary: "needs a look",
            rawText: "{}",
            runner: "codex-cli",
            durationMs: 10,
          },
          reviewedAt: "2026-08-09T01:06:10.041Z",
          reviewGate: {
            crossModelSatisfied: true,
            anchorAuditPassed: true,
            treeClean: true,
            fidelityPassed: true,
            eligibleForAutoApproval: false,
            reasons: ["review verdict is FIX_FIRST"],
          },
          agentSessionId: "worker-session",
        },
        {
          rationale: ["migration touches auth"],
          diffFingerprint: "fp-1",
          heldAt: "2026-08-09T01:06:00.000Z",
          action: "human_review",
        },
      );
      const seeded = await loadJudgeApproval("TASK-1273", logDir);
      const backdated: JudgeApproval = { ...seeded!, createdAt: "2026-08-09T01:06:10.041Z" };
      await fs.writeFile(
        path.join(logDir, "approvals", "TASK-1273-judge.json"),
        JSON.stringify(backdated, null, 2),
        "utf-8",
      );

      const before = Date.now();
      await resavePendingJudgeApproval(backdated, logDir);
      const resaved = await loadJudgeApproval("TASK-1273", logDir);

      expect(resaved!.state).toBe("pending");
      expect(new Date(resaved!.createdAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(resaved!.diff).toBe("diff --git a/x b/x\n+1\n");
      // The modified/created split round-trips through the raw prefixed form.
      expect(resaved!.filesModified).toEqual(["src/x.ts"]);
      expect(resaved!.filesCreated).toEqual(["src/y.ts"]);
      expect(resaved!.verificationPassed).toBe(true);
      expect(resaved!.reviewedAt).toBe("2026-08-09T01:06:10.041Z");
      expect(resaved!.review).toMatchObject({ verdict: "FIX_FIRST" });
      expect(resaved!.agentSessionId).toBe("worker-session");
      // Dropping the hold would break TASK-1316's release mechanism.
      expect(resaved!.intentHold).toMatchObject({
        diffFingerprint: "fp-1",
        heldAt: "2026-08-09T01:06:00.000Z",
        action: "human_review",
      });
      expect(resaved!.executionMode).toBe("loop");
    });

    it("re-stamps an evidence-less pending record without inventing evidence or a hold", async () => {
      await savePendingJudgeApproval("TASK-LEGACY-J", "d", ["a.ts"], false, logDir);
      const seeded = await loadJudgeApproval("TASK-LEGACY-J", logDir);
      const backdated: JudgeApproval = { ...seeded!, createdAt: "2026-08-08T00:00:00.000Z" };

      await resavePendingJudgeApproval(backdated, logDir);

      const raw = await fs.readFile(
        path.join(logDir, "approvals", "TASK-LEGACY-J-judge.json"),
        "utf-8",
      );
      expect(raw).not.toContain('"review"');
      expect(raw).not.toContain('"intentHold"');
      const resaved = await loadJudgeApproval("TASK-LEGACY-J", logDir);
      expect(resaved!.state).toBe("pending");
      expect(new Date(resaved!.createdAt).getTime()).toBeGreaterThan(
        new Date("2026-08-08T00:00:00.000Z").getTime(),
      );
    });
  });
});
