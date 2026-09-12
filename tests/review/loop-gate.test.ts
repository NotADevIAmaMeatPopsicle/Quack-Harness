import { evaluateLoopReview } from "../../src/review/loop-gate";
import type {
  ReviewerRunner,
  ReviewRequest,
  ReviewRunResult,
} from "../../src/review/reviewer-types";
import type { ReviewerRunnerConfig } from "../../src/review/reviewer-config";

const config: ReviewerRunnerConfig = {
  runner: "claude-sdk",
  model: "gpt-5.6-terra",
  maxTurns: 30,
  timeoutMs: 600_000,
  codex: { binaryPath: "codex", sandbox: "read-only", provider: "openai" },
};

const claudeProducer = {
  runner: "claude-sdk" as const,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

const request: ReviewRequest = {
  kind: "brief",
  taskId: "TASK-1307",
  taskSpec: "spec",
  artifact: "brief",
  projectRoot: process.cwd(),
};

function factory(result: ReviewRunResult, kind: ReviewerRunner["kind"]): () => ReviewerRunner {
  return () => ({ kind, run: () => Promise.resolve(result) });
}

function completed(
  overrides: Partial<Extract<ReviewRunResult, { status: "completed" }>> = {},
): ReviewRunResult {
  return {
    status: "completed",
    verdict: "SHIP",
    findings: [],
    summary: "clean",
    rawText: "{}",
    runner: "codex-cli",
    durationMs: 1,
    ...overrides,
  };
}

describe("evaluateLoopReview", () => {
  test("TASK-1313: enforce-mode injected safety signals block auto-approval and stop the decision", async () => {
    const evaluation = await evaluateLoopReview(
      config,
      true,
      request,
      factory(completed(), "codex-cli"),
      [
        {
          source: "loop_diff",
          code: "seal_machinery_tier_s",
          disposition: "safety",
          message: "machinery tamper",
          deterministic: true,
          safetyCode: "machinery_tamper",
        },
      ],
      undefined,
      undefined,
      claudeProducer,
    );

    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
    expect(evaluation.reviewGate.reasons).toContain("producer safety signal present");
    expect(evaluation.judgmentDecision?.action).toBe("stop");
    expect(evaluation.judgmentDecision?.safetyFloor.passed).toBe(false);
  });

  test("TASK-1313: report-mode (human_review) injected signals surface without stopping", async () => {
    const evaluation = await evaluateLoopReview(
      config,
      true,
      request,
      factory(completed(), "codex-cli"),
      [
        {
          source: "loop_diff",
          code: "seal_machinery_tier_s",
          disposition: "human_review",
          message: "machinery tamper (report mode)",
          deterministic: true,
        },
      ],
      undefined,
      undefined,
      claudeProducer,
    );

    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
    expect(evaluation.judgmentDecision?.action).not.toBe("stop");
    expect(
      evaluation.judgmentDecision?.signals.some(
        (signal) => signal.code === "seal_machinery_tier_s",
      ),
    ).toBe(true);
  });

  test("allows a clean cross-model SHIP result", async () => {
    const evaluation = await evaluateLoopReview(
      config,
      true,
      request,
      factory(completed(), "codex-cli"),
      [],
      undefined,
      undefined,
      claudeProducer,
    );

    expect(evaluation.reviewGate).toMatchObject({
      crossModelSatisfied: true,
      anchorAuditPassed: true,
      treeClean: true,
      eligibleForAutoApproval: true,
    });
  });

  test.each(["AMEND", "FIX_FIRST"] as const)(
    "blocks %s without rewriting the verdict",
    async (verdict) => {
      const evaluation = await evaluateLoopReview(
        config,
        false,
        request,
        factory(completed({ verdict }), "codex-cli"),
      );

      expect(evaluation.result).toMatchObject({ status: "completed", verdict });
      expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
    },
  );

  test("keeps runner_error distinct and fail closed", async () => {
    const result: ReviewRunResult = {
      status: "runner_error",
      errorKind: "spawn_failed",
      message: "CreateProcessAsUserW failed",
      runner: "codex-cli",
      durationMs: 1,
    };
    const evaluation = await evaluateLoopReview(
      config,
      true,
      request,
      factory(result, "codex-cli"),
    );

    expect(evaluation.result.status).toBe("runner_error");
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });

  test("missing anchors block approval but preserve SHIP", async () => {
    const evaluation = await evaluateLoopReview(
      config,
      false,
      request,
      factory(
        completed({ anchorsAudit: { total: 1, missing: ["src/missing.ts:1"] } }),
        "codex-cli",
      ),
    );

    expect(evaluation.result).toMatchObject({ status: "completed", verdict: "SHIP" });
    expect(evaluation.reviewGate.anchorAuditPassed).toBe(false);
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });

  test("dirty tree evidence blocks approval", async () => {
    const evaluation = await evaluateLoopReview(
      config,
      false,
      request,
      factory(completed({ treeDirtyAfterReview: true }), "codex-cli"),
    );

    expect(evaluation.reviewGate.treeClean).toBe(false);
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });

  test("same-provider review is only blocking when cross-model is required", async () => {
    const allowed = await evaluateLoopReview(
      config,
      false,
      request,
      factory(completed({ runner: "claude-sdk", model: "claude-sonnet-4-6" }), "claude-sdk"),
      [],
      undefined,
      undefined,
      claudeProducer,
    );
    const blocked = await evaluateLoopReview(
      config,
      true,
      request,
      factory(completed({ runner: "claude-sdk", model: "claude-sonnet-4-6" }), "claude-sdk"),
      [],
      undefined,
      undefined,
      claudeProducer,
    );

    expect(allowed.reviewGate.eligibleForAutoApproval).toBe(true);
    expect(allowed.reviewGate.reasons).toContain("same-provider review allowed by configuration");
    expect(blocked.reviewGate.eligibleForAutoApproval).toBe(false);
  });
});
