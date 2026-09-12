// ─── Blueprint Approval Tests ──────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  evaluateAutoApprove,
  saveBlueprintApproval,
  savePendingApproval,
  resavePendingApproval,
  loadApproval,
  updateApprovalState,
  isApprovalExpired,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type AutoApproveRules,
  type ApprovalState,
  type BlueprintApproval,
} from "../../src/dispatcher/blueprint-approval.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";
import type { PreflightResult } from "../../src/preflight/preflight-types.js";

describe("blueprint-approval", () => {
  const testLogDir = path.resolve(__dirname, "../fixtures/test-logs");

  beforeEach(async () => {
    await fs.mkdir(testLogDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testLogDir, { recursive: true, force: true });
  });

  // ─── Shared test fixtures ──────────────────────────────────────

  const defaultRules: AutoApproveRules = {
    maxFiles: 3,
    maxCriteria: 5,
    minBlueprintScore: 0.8,
    requireDecomposition: false,
  };

  const simpleBlueprint: Blueprint = {
    taskId: "TASK-001",
    fileAnalyses: [
      {
        filePath: "src/a.ts",
        action: "Modify",
        currentStructure: "",
        integrationPoints: "",
        patternToFollow: "",
      },
    ],
    codeExamples: [],
    verificationPatterns: [
      { criterion: "Test 1", checkType: "grep", pattern: "foo", fileGlob: "*.ts" },
    ],
    antiPatterns: [],
    preconditions: [],
  };

  const emptyBlueprint: Blueprint = {
    taskId: "TASK-001",
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  };

  function makePreflight(score: number, recommendDecomposition = false): PreflightResult {
    return {
      taskId: "TASK-001",
      timestamp: new Date().toISOString(),
      contentHash: "abc123",
      gate: { ready: true, score, dimensions: {} },
      blueprint: {
        fileAnalyses: 1,
        codeExamples: 0,
        verificationPatterns: 1,
        antiPatterns: 0,
        formattedMarkdown: "",
      },
      contextEstimate: {
        total: 1000,
        taskSpec: 500,
        blueprint: 500,
        repoMap: 0,
        relevantFiles: 0,
        relatedPatterns: 0,
        existingTests: 0,
        conventions: 0,
        claudeMd: 0,
        withinBudget: true,
      },
      complexity: {
        filesToModify: 1,
        successCriteria: 1,
        estimatedContextTokens: 1000,
        independentFeatures: 1,
        featureClusters: [],
        recommendDecomposition,
        reason: recommendDecomposition ? "Complex task" : "Simple task",
      },
    };
  }

  // ─── evaluateAutoApprove ───────────────────────────────────────

  describe("evaluateAutoApprove", () => {
    it("should auto-approve simple task with few files", () => {
      const result = evaluateAutoApprove(simpleBlueprint, undefined, defaultRules);
      expect(result).toBe(true);
    });

    it("should block task with too many files", () => {
      const blueprint: Blueprint = {
        ...simpleBlueprint,
        fileAnalyses: [
          {
            filePath: "src/a.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/b.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/c.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/d.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
        ],
      };
      const result = evaluateAutoApprove(blueprint, undefined, defaultRules);
      expect(result).toBe(false);
    });

    it("should block task with too many criteria", () => {
      const blueprint: Blueprint = {
        ...simpleBlueprint,
        verificationPatterns: [
          { criterion: "1", checkType: "grep", pattern: "a", fileGlob: "*.ts" },
          { criterion: "2", checkType: "grep", pattern: "b", fileGlob: "*.ts" },
          { criterion: "3", checkType: "grep", pattern: "c", fileGlob: "*.ts" },
          { criterion: "4", checkType: "grep", pattern: "d", fileGlob: "*.ts" },
          { criterion: "5", checkType: "grep", pattern: "e", fileGlob: "*.ts" },
          { criterion: "6", checkType: "grep", pattern: "f", fileGlob: "*.ts" },
        ],
      };
      const result = evaluateAutoApprove(blueprint, undefined, defaultRules);
      expect(result).toBe(false);
    });

    it("should block task with low blueprint score", () => {
      const preflight = makePreflight(6); // 6/10 = 0.6 < 0.8
      const result = evaluateAutoApprove(simpleBlueprint, preflight, defaultRules);
      expect(result).toBe(false);
    });

    it("should auto-approve task with high blueprint score", () => {
      const preflight = makePreflight(9); // 9/10 = 0.9 > 0.8
      const result = evaluateAutoApprove(simpleBlueprint, preflight, defaultRules);
      expect(result).toBe(true);
    });

    it("should block task when decomposition recommended and requireDecomposition is true", () => {
      const rules: AutoApproveRules = { ...defaultRules, requireDecomposition: true };
      const preflight = makePreflight(9, true);
      const result = evaluateAutoApprove(simpleBlueprint, preflight, rules);
      expect(result).toBe(false);
    });
  });

  // ─── savePendingApproval and loadApproval ──────────────────────

  describe("savePendingApproval and loadApproval", () => {
    it("should save and load approval state", async () => {
      await savePendingApproval("TASK-001", emptyBlueprint, undefined, testLogDir);
      const loaded = await loadApproval("TASK-001", testLogDir);

      expect(loaded).not.toBeNull();
      expect(loaded?.taskId).toBe("TASK-001");
      expect(loaded?.state).toBe("pending");
      expect(loaded?.blueprint.taskId).toBe("TASK-001");
    });

    it("should return null for non-existent approval", async () => {
      const loaded = await loadApproval("TASK-999", testLogDir);
      expect(loaded).toBeNull();
    });

    it("round-trips loop review evidence for auto-approved records", async () => {
      await saveBlueprintApproval(
        "TASK-1307",
        emptyBlueprint,
        undefined,
        testLogDir,
        "auto-approved",
        {
          review: {
            status: "completed",
            verdict: "SHIP",
            findings: [],
            summary: "clean",
            rawText: "{}",
            runner: "codex-cli",
            durationMs: 10,
          },
          reviewedAt: "2026-07-16T00:00:00.000Z",
          reviewGate: {
            crossModelSatisfied: true,
            crossModelEvidence: {
              status: "satisfied",
              basis: "different_runner",
              producer: {
                runner: "claude-sdk",
                provider: "anthropic",
                model: "claude-sonnet-4-6",
              },
              reviewer: {
                runner: "codex-cli",
                provider: "openai",
                model: "gpt-5.6-terra",
              },
            },
            anchorAuditPassed: true,
            treeClean: true,
            fidelityPassed: true,
            eligibleForAutoApproval: true,
            reasons: [],
          },
        },
      );

      const loaded = await loadApproval("TASK-1307", testLogDir);
      expect(loaded).toMatchObject({
        state: "auto-approved",
        executionMode: "loop",
        review: { status: "completed", verdict: "SHIP" },
        reviewGate: {
          crossModelEvidence: {
            status: "satisfied",
            basis: "different_runner",
          },
        },
      });
    });

    it("omits absent optional review evidence from legacy JSON", async () => {
      await savePendingApproval("TASK-LEGACY", emptyBlueprint, undefined, testLogDir);
      const raw = await fs.readFile(
        path.join(testLogDir, "approvals", "TASK-LEGACY.json"),
        "utf-8",
      );
      expect(raw).not.toContain('"review"');
      expect(raw).not.toContain('"executionMode"');
    });
  });

  // ─── resavePendingApproval (QPI-043) ───────────────────────────

  describe("resavePendingApproval (QPI-043)", () => {
    it("re-stamps createdAt while preserving blueprint and review evidence", async () => {
      // Seed the exact live shape: a loop-mode pend carrying a FIX_FIRST
      // review, created by an earlier dispatch.
      await saveBlueprintApproval(
        "TASK-1273",
        simpleBlueprint,
        makePreflight(9),
        testLogDir,
        "pending",
        {
          review: {
            status: "completed",
            verdict: "FIX_FIRST",
            findings: [],
            summary: "export-path bypass",
            rawText: "{}",
            runner: "codex-cli",
            durationMs: 10,
          },
          reviewedAt: "2026-08-09T01:06:10.041Z",
          reviewGate: {
            crossModelSatisfied: true,
            crossModelEvidence: {
              status: "satisfied",
              basis: "different_runner",
              producer: {
                runner: "claude-sdk",
                provider: "anthropic",
                model: "claude-sonnet-4-6",
              },
              reviewer: {
                runner: "codex-cli",
                provider: "openai",
                model: "gpt-5.6-terra",
              },
            },
            anchorAuditPassed: true,
            treeClean: true,
            fidelityPassed: true,
            eligibleForAutoApproval: false,
            reasons: ["review verdict is FIX_FIRST"],
          },
        },
      );
      const seeded = await loadApproval("TASK-1273", testLogDir);
      const backdated: BlueprintApproval = { ...seeded!, createdAt: "2026-08-09T01:06:10.041Z" };
      await fs.writeFile(
        path.join(testLogDir, "approvals", "TASK-1273.json"),
        JSON.stringify(backdated, null, 2),
        "utf-8",
      );

      const before = Date.now();
      await resavePendingApproval(backdated, testLogDir);
      const resaved = await loadApproval("TASK-1273", testLogDir);

      // Fresh createdAt is the whole point: it is what the monitor's
      // recency check classifies the exit by.
      expect(resaved!.state).toBe("pending");
      expect(new Date(resaved!.createdAt).getTime()).toBeGreaterThanOrEqual(before);
      // Evidence provenance survives untouched.
      expect(resaved!.reviewedAt).toBe("2026-08-09T01:06:10.041Z");
      expect(resaved!.review).toMatchObject({ verdict: "FIX_FIRST" });
      expect(resaved!.reviewGate).toMatchObject({
        eligibleForAutoApproval: false,
        reasons: ["review verdict is FIX_FIRST"],
        crossModelEvidence: {
          status: "satisfied",
          basis: "different_runner",
        },
      });
      expect(resaved!.executionMode).toBe("loop");
      expect(resaved!.blueprint.fileAnalyses).toHaveLength(1);
    });

    it("re-stamps an evidence-less pending record without inventing evidence", async () => {
      await savePendingApproval("TASK-LEGACY-2", emptyBlueprint, undefined, testLogDir);
      const seeded = await loadApproval("TASK-LEGACY-2", testLogDir);
      const backdated: BlueprintApproval = { ...seeded!, createdAt: "2026-08-08T00:00:00.000Z" };

      await resavePendingApproval(backdated, testLogDir);

      const raw = await fs.readFile(
        path.join(testLogDir, "approvals", "TASK-LEGACY-2.json"),
        "utf-8",
      );
      expect(raw).not.toContain('"review"');
      expect(raw).not.toContain('"executionMode"');
      const resaved = await loadApproval("TASK-LEGACY-2", testLogDir);
      expect(resaved!.state).toBe("pending");
      expect(new Date(resaved!.createdAt).getTime()).toBeGreaterThan(
        new Date("2026-08-08T00:00:00.000Z").getTime(),
      );
    });
  });

  // ─── updateApprovalState ───────────────────────────────────────

  describe("updateApprovalState", () => {
    it("should update approval state to approved", async () => {
      await savePendingApproval("TASK-001", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-001", "approved", testLogDir, "human");

      const loaded = await loadApproval("TASK-001", testLogDir);
      expect(loaded?.state).toBe("approved");
      expect(loaded?.approvedBy).toBe("human");
      expect(loaded?.decidedAt).toBeDefined();
    });

    it("should update approval state to rejected with reason", async () => {
      await savePendingApproval("TASK-001", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState(
        "TASK-001",
        "rejected",
        testLogDir,
        undefined,
        "Blueprint too complex",
      );

      const loaded = await loadApproval("TASK-001", testLogDir);
      expect(loaded?.state).toBe("rejected");
      expect(loaded?.rejectionReason).toBe("Blueprint too complex");
      expect(loaded?.decidedAt).toBeDefined();
    });

    it("should throw error for non-existent approval", async () => {
      await expect(
        updateApprovalState("TASK-999", "approved", testLogDir, "human"),
      ).rejects.toThrow("No pending approval found");
    });
  });

  // ─── Resume-after-approval flow ────────────────────────────────

  describe("resume-after-approval flow", () => {
    it("should detect approved state on resume and skip approval gate", async () => {
      await savePendingApproval("TASK-002", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-002", "approved", testLogDir, "human");

      const approval = await loadApproval("TASK-002", testLogDir);
      expect(approval).not.toBeNull();
      expect(approval?.state).toBe("approved");
      expect(approval?.approvedBy).toBe("human");
    });

    it("should detect auto-approved state on resume", async () => {
      await savePendingApproval("TASK-003", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-003", "auto-approved", testLogDir, "auto");

      const approval = await loadApproval("TASK-003", testLogDir);
      expect(approval?.state).toBe("auto-approved");
    });

    it("should preserve blueprint data after approval state changes", async () => {
      const blueprint: Blueprint = {
        taskId: "TASK-004",
        fileAnalyses: [
          {
            filePath: "src/foo.ts",
            action: "Modify",
            currentStructure: "struct",
            integrationPoints: "points",
            patternToFollow: "pattern",
          },
        ],
        codeExamples: [
          { file: "src/foo.ts", description: "test example", before: "old", after: "new" },
        ],
        verificationPatterns: [
          { criterion: "test", checkType: "grep", pattern: "x", fileGlob: "*.ts" },
        ],
        antiPatterns: ["do not stub"],
        preconditions: ["file exists"],
      };

      await savePendingApproval("TASK-004", blueprint, undefined, testLogDir);
      await updateApprovalState("TASK-004", "approved", testLogDir, "human");

      const loaded = await loadApproval("TASK-004", testLogDir);
      expect(loaded?.blueprint.fileAnalyses).toHaveLength(1);
      expect(loaded?.blueprint.codeExamples).toHaveLength(1);
      expect(loaded?.blueprint.verificationPatterns).toHaveLength(1);
      expect(loaded?.blueprint.antiPatterns).toHaveLength(1);
    });
  });

  // ─── Dispatcher approval gate simulation ───────────────────────
  // These tests simulate the dispatcher's approval gate logic to verify
  // that each approval state is handled correctly during dispatch.

  describe("dispatcher approval gate behavior", () => {
    /**
     * Simulates the dispatcher's approval gate decision logic.
     * This mirrors the actual code in dispatcher.ts lines 336-395.
     * Returns: 'skip' (approved, continue), 'block' (rejected, stop),
     *          'auto-approve' (evaluated and passed), 'pending' (needs human review)
     */
    function simulateApprovalGate(
      existingApproval: { state: ApprovalState; rejectionReason?: string } | null,
      blueprint: Blueprint,
      rules: AutoApproveRules,
      preflight?: PreflightResult,
    ): { action: "skip" | "block" | "auto-approve" | "pending"; error?: string } {
      if (existingApproval?.state === "approved" || existingApproval?.state === "auto-approved") {
        return { action: "skip" };
      } else if (existingApproval?.state === "rejected") {
        return {
          action: "block",
          error: `Blueprint was rejected. Run preflight again to generate a new blueprint.`,
        };
      } else {
        const shouldAutoApprove = evaluateAutoApprove(blueprint, preflight, rules);
        if (shouldAutoApprove) {
          return { action: "auto-approve" };
        } else {
          return { action: "pending" };
        }
      }
    }

    it("should block dispatch when approval state is rejected", async () => {
      await savePendingApproval("TASK-010", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-010", "rejected", testLogDir, undefined, "Bad plan");

      const approval = await loadApproval("TASK-010", testLogDir);
      const result = simulateApprovalGate(approval, simpleBlueprint, defaultRules);

      expect(result.action).toBe("block");
      expect(result.error).toContain("Blueprint was rejected");
    });

    it("should not auto-approve a rejected blueprint even if it meets thresholds", async () => {
      // This is the CRITICAL fix: even if the blueprint is simple enough to auto-approve,
      // a rejected state must block dispatch.
      await savePendingApproval("TASK-011", simpleBlueprint, undefined, testLogDir);
      await updateApprovalState(
        "TASK-011",
        "rejected",
        testLogDir,
        undefined,
        "Reviewed and rejected",
      );

      const approval = await loadApproval("TASK-011", testLogDir);
      // simpleBlueprint would auto-approve under defaultRules, but rejected state takes precedence
      const result = simulateApprovalGate(approval, simpleBlueprint, defaultRules);

      expect(result.action).toBe("block");
      expect(result.action).not.toBe("auto-approve");
    });

    it("should skip approval gate when state is approved", async () => {
      await savePendingApproval("TASK-012", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-012", "approved", testLogDir, "human");

      const approval = await loadApproval("TASK-012", testLogDir);
      const result = simulateApprovalGate(approval, simpleBlueprint, defaultRules);

      expect(result.action).toBe("skip");
    });

    it("should skip approval gate when state is auto-approved", async () => {
      await savePendingApproval("TASK-013", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-013", "auto-approved", testLogDir, "auto");

      const approval = await loadApproval("TASK-013", testLogDir);
      const result = simulateApprovalGate(approval, simpleBlueprint, defaultRules);

      expect(result.action).toBe("skip");
    });

    it("should auto-approve when no existing approval and blueprint is simple", () => {
      const result = simulateApprovalGate(null, simpleBlueprint, defaultRules);
      expect(result.action).toBe("auto-approve");
    });

    it("should pause for human review when no existing approval and blueprint is complex", () => {
      const complexBlueprint: Blueprint = {
        ...simpleBlueprint,
        fileAnalyses: [
          {
            filePath: "src/a.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/b.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/c.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
          {
            filePath: "src/d.ts",
            action: "Modify",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
        ],
      };
      const result = simulateApprovalGate(null, complexBlueprint, defaultRules);
      expect(result.action).toBe("pending");
    });
  });

  // ─── SSE event emission patterns ───────────────────────────────
  // Tests that the correct SSE events would be emitted for each approval state.

  describe("SSE event emission patterns", () => {
    /**
     * Simulates the event emission that the dispatcher performs
     * for each approval gate outcome. Returns the event stage name.
     */
    function getExpectedSSEEvent(
      existingApproval: { state: ApprovalState } | null,
      autoApproveResult: boolean,
    ): string | null {
      if (existingApproval?.state === "approved" || existingApproval?.state === "auto-approved") {
        return "stage_skipped"; // Already approved, emit skip event
      } else if (existingApproval?.state === "rejected") {
        return "session_error"; // Rejected, emit error event
      } else if (autoApproveResult) {
        return "checkpoint_saved"; // Auto-approved, save checkpoint
      } else {
        return "blueprint_pending_approval"; // Needs human review
      }
    }

    it("should emit blueprint_pending_approval when task needs human review", () => {
      const event = getExpectedSSEEvent(null, false);
      expect(event).toBe("blueprint_pending_approval");
    });

    it("should emit checkpoint_saved when task auto-approves", () => {
      const event = getExpectedSSEEvent(null, true);
      expect(event).toBe("checkpoint_saved");
    });

    it("should emit stage_skipped when blueprint already approved", () => {
      const event = getExpectedSSEEvent({ state: "approved" }, false);
      expect(event).toBe("stage_skipped");
    });

    it("should emit session_error when blueprint was rejected", () => {
      const event = getExpectedSSEEvent({ state: "rejected" }, false);
      expect(event).toBe("session_error");
    });
  });

  // ─── API endpoint behavior simulation ──────────────────────────
  // Tests that simulate the server endpoint behavior for approve/reject/replan.

  describe("API endpoint behavior", () => {
    it("approve endpoint should update state to approved and allow dispatch resume", async () => {
      // Simulate what POST /api/tasks/:id/blueprint/approve does
      await savePendingApproval("TASK-020", emptyBlueprint, undefined, testLogDir);

      // Step 1: Update state (what the endpoint does)
      await updateApprovalState("TASK-020", "approved", testLogDir, "human");

      // Step 2: On resume dispatch, approval gate should skip
      const approval = await loadApproval("TASK-020", testLogDir);
      expect(approval?.state).toBe("approved");
      expect(approval?.approvedBy).toBe("human");

      // Dispatcher would see approved state and skip the gate
      const isApproved = approval?.state === "approved" || approval?.state === "auto-approved";
      expect(isApproved).toBe(true);
    });

    it("reject endpoint should update state to rejected and block dispatch", async () => {
      // Simulate what POST /api/tasks/:id/blueprint/reject does
      await savePendingApproval("TASK-021", emptyBlueprint, undefined, testLogDir);

      // Step 1: Update state (what the endpoint does)
      await updateApprovalState("TASK-021", "rejected", testLogDir, undefined, "Wrong approach");

      // Step 2: On dispatch attempt, approval gate should block
      const approval = await loadApproval("TASK-021", testLogDir);
      expect(approval?.state).toBe("rejected");
      expect(approval?.rejectionReason).toBe("Wrong approach");

      // Dispatcher would see rejected state and refuse to proceed
      const isRejected = approval?.state === "rejected";
      expect(isRejected).toBe(true);

      // It should NOT fall through to auto-approve evaluation
      const isApproved = approval?.state === "approved" || approval?.state === "auto-approved";
      expect(isApproved).toBe(false);
    });

    it("replan endpoint should reject and invalidate, blocking dispatch until new preflight", async () => {
      // Simulate what POST /api/tasks/:id/blueprint/replan does
      await savePendingApproval("TASK-022", emptyBlueprint, undefined, testLogDir);

      // Step 1: Mark as rejected with replan reason
      await updateApprovalState("TASK-022", "rejected", testLogDir, undefined, "Requested re-plan");

      // Step 2: Verify state blocks dispatch
      const approval = await loadApproval("TASK-022", testLogDir);
      expect(approval?.state).toBe("rejected");
      expect(approval?.rejectionReason).toBe("Requested re-plan");

      // Dispatcher would see 'rejected' and refuse to proceed
      // This prevents dispatch from starting before the new preflight generates a new blueprint
      const isRejected = approval?.state === "rejected";
      expect(isRejected).toBe(true);
    });

    it("GET blueprint endpoint returns 404 when no approval exists", async () => {
      // Simulate what GET /api/tasks/:id/blueprint does
      const approval = await loadApproval("TASK-NONEXISTENT", testLogDir);
      // Server would return 404 when approval is null
      expect(approval).toBeNull();
    });
  });

  // ─── Backward compatibility ────────────────────────────────────
  // Tests that the approval gate is fully transparent when not configured.

  describe("backward compatibility", () => {
    it("should skip approval gate entirely when blueprintApproval is undefined in config", () => {
      // Simulates the dispatcher's config check: adapter.config.preflight?.blueprintApproval
      const config: {
        preflight?: { blueprintApproval?: { enabled: boolean; autoApproveWhen: AutoApproveRules } };
      } = {
        preflight: {
          // blueprintApproval is not set — simulates existing adapters without this config
        },
      };

      // The dispatcher guard: if (blueprintApprovalConfig?.enabled && !options?.dryRun && !completedStages.has("approve"))
      const blueprintApprovalConfig = config.preflight?.blueprintApproval;
      const shouldEnterApprovalGate = blueprintApprovalConfig?.enabled === true;

      expect(shouldEnterApprovalGate).toBe(false);
      // When false, the entire approval block is skipped — dispatch proceeds directly to branch
    });

    it("should skip approval gate entirely when blueprintApproval.enabled is false", () => {
      const config = {
        preflight: {
          blueprintApproval: {
            enabled: false,
            autoApproveWhen: {
              maxFiles: 3,
              maxCriteria: 5,
              minBlueprintScore: 0.8,
              requireDecomposition: false,
            },
          },
        },
      };

      const blueprintApprovalConfig = config.preflight.blueprintApproval;
      const shouldEnterApprovalGate = blueprintApprovalConfig?.enabled === true;

      expect(shouldEnterApprovalGate).toBe(false);
      // Even though autoApproveWhen is configured, enabled=false means skip entirely
    });

    it("should skip approval gate when preflight config itself is undefined", () => {
      const config: { preflight?: { blueprintApproval?: { enabled: boolean } } } = {};

      const blueprintApprovalConfig = config.preflight?.blueprintApproval;
      const shouldEnterApprovalGate = blueprintApprovalConfig?.enabled === true;

      expect(shouldEnterApprovalGate).toBe(false);
    });

    it("should enter approval gate only when explicitly enabled", () => {
      const config = {
        preflight: {
          blueprintApproval: {
            enabled: true,
            autoApproveWhen: {
              maxFiles: 3,
              maxCriteria: 5,
              minBlueprintScore: 0.8,
              requireDecomposition: false,
            },
          },
        },
      };

      const blueprintApprovalConfig = config.preflight.blueprintApproval;
      const shouldEnterApprovalGate = blueprintApprovalConfig?.enabled === true;

      expect(shouldEnterApprovalGate).toBe(true);
    });
  });

  // ─── Approval timeout ─────────────────────────────────────────────

  describe("approval timeout", () => {
    it("should not be expired for recently created pending approval", async () => {
      await savePendingApproval("TASK-030", emptyBlueprint, undefined, testLogDir);
      const approval = await loadApproval("TASK-030", testLogDir);
      expect(approval).not.toBeNull();
      expect(isApprovalExpired(approval!)).toBe(false);
    });

    it("should be expired when createdAt is older than timeout", () => {
      const oldApproval: BlueprintApproval = {
        taskId: "TASK-031",
        state: "pending",
        blueprint: emptyBlueprint,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      };
      expect(isApprovalExpired(oldApproval)).toBe(true);
    });

    it("should not be expired when createdAt is within timeout", () => {
      const recentApproval: BlueprintApproval = {
        taskId: "TASK-032",
        state: "pending",
        blueprint: emptyBlueprint,
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
      };
      expect(isApprovalExpired(recentApproval)).toBe(false);
    });

    it("should respect custom timeout value", () => {
      const approval: BlueprintApproval = {
        taskId: "TASK-033",
        state: "pending",
        blueprint: emptyBlueprint,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      };
      // With 1-hour timeout, should be expired
      expect(isApprovalExpired(approval, 1 * 60 * 60 * 1000)).toBe(true);
      // With 3-hour timeout, should not be expired
      expect(isApprovalExpired(approval, 3 * 60 * 60 * 1000)).toBe(false);
    });

    it("should not consider approved/rejected states as expired", () => {
      const approved: BlueprintApproval = {
        taskId: "TASK-034",
        state: "approved",
        blueprint: emptyBlueprint,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
        approvedBy: "human",
      };
      expect(isApprovalExpired(approved)).toBe(false);

      const rejected: BlueprintApproval = {
        taskId: "TASK-035",
        state: "rejected",
        blueprint: emptyBlueprint,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        rejectionReason: "test",
      };
      expect(isApprovalExpired(rejected)).toBe(false);
    });

    it("should have a default timeout of 24 hours", () => {
      expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  // ─── DispatchOutcome type ────────────────────────────────────────
  // Verifies that the awaiting_approval outcome is a valid DispatchOutcome value.

  describe("DispatchOutcome awaiting_approval", () => {
    it("should accept awaiting_approval as a valid DispatchOutcome", () => {
      // This test verifies at compile time that 'awaiting_approval' is valid
      const outcome: import("../../src/core/types.js").DispatchOutcome = "awaiting_approval";
      expect(outcome).toBe("awaiting_approval");
    });
  });

  // ─── Replan flow ─────────────────────────────────────────────────

  describe("replan flow", () => {
    it("should set state to rejected with re-plan reason", async () => {
      await savePendingApproval("TASK-040", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-040", "rejected", testLogDir, undefined, "Requested re-plan");

      const approval = await loadApproval("TASK-040", testLogDir);
      expect(approval?.state).toBe("rejected");
      expect(approval?.rejectionReason).toBe("Requested re-plan");
    });

    it("should allow clearing rejected approval after successful replan", async () => {
      // Simulate replan flow: reject → clear file → new dispatch gets fresh evaluation
      await savePendingApproval("TASK-041", emptyBlueprint, undefined, testLogDir);
      await updateApprovalState("TASK-041", "rejected", testLogDir, undefined, "Requested re-plan");

      // Clear the approval file (what the replan endpoint does on preflight success)
      const approvalPath = path.join(testLogDir, "approvals", "TASK-041.json");
      await fs.unlink(approvalPath);

      // Now loadApproval returns null — fresh dispatch gets new auto-approve evaluation
      const approval = await loadApproval("TASK-041", testLogDir);
      expect(approval).toBeNull();
    });
  });
});
