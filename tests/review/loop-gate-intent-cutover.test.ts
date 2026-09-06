// ─── Loop review intent cutover tests (TASK-1316) ───────────────────
// The mode matrix, the always-evaluate signal gate (without which this
// cutover would be inert), the never-upgrade pin, the degradation
// posture, and the two deliberate skips.
//
// NOTE: `tests/review/loop-gate.test.ts` is left UNTOUCHED on purpose —
// it calls `evaluateLoopReview` without a cutover argument, so it is
// the off-mode byte-identity control for everything here.

import type {
  IntentJudgmentRequest,
  IntentJudgmentRunResult,
  JudgmentSignal,
} from "../../src/judgment/judgment-types";

// The intent runner: controllable per test, and CONSTRUCTION is counted
// so the never-invoked pins are provable rather than inferred.
const mockRunnerRun = jest.fn<Promise<IntentJudgmentRunResult>, [IntentJudgmentRequest]>();
const mockCreateRunner = jest.fn(() => ({
  kind: "claude-sdk" as const,
  run: (request: IntentJudgmentRequest) => mockRunnerRun(request),
}));
jest.mock("../../src/judgment/runner/intent-judgment-runner", () => ({
  createIntentJudgmentRunner: (...args: unknown[]) => mockCreateRunner(...(args as [])),
}));

import { evaluateLoopReview, type LoopJudgmentCutover } from "../../src/review/loop-gate";
import type {
  ReviewerRunner,
  ReviewRequest,
  ReviewRunResult,
} from "../../src/review/reviewer-types";
import type { ReviewerRunnerConfig } from "../../src/review/reviewer-config";

const config: ReviewerRunnerConfig = {
  runner: "claude-sdk",
  maxTurns: 30,
  timeoutMs: 600_000,
  codex: { binaryPath: "codex", sandbox: "read-only" },
};

const SPEC_WITH_INTENT = [
  "## Intent",
  "Ship the behavior the spec describes, not the checklist.",
  "",
  "## Problem Statement",
  "The gate reads thresholds only.",
  "",
  "## Success Criteria",
  "- [ ] Intent is honored",
  "",
  "## Scope Boundaries",
  "- No adapter adoption",
  "",
].join("\n");

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    kind: "diff",
    taskId: "TASK-1316",
    taskSpec: SPEC_WITH_INTENT,
    artifact: "diff",
    projectRoot: process.cwd(),
    ...overrides,
  };
}

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

/** A runner that echoes the request's own refs, so the exact-ref contract holds. */
function respondWith(
  action: "continue" | "repair" | "human_review",
  rationale = ["because the intent is not met"],
): void {
  mockRunnerRun.mockImplementation((request) =>
    Promise.resolve({
      status: "completed",
      judgment: { source: "intent_model", action, rationale },
      consideredSignalRefs: request.signals.map((signal) => signal.ref),
      model: "test-model",
      durationMs: 1,
      truncatedFields: [],
    }),
  );
}

const cutover = (mode: LoopJudgmentCutover["mode"]): LoopJudgmentCutover => ({ mode });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("evaluateLoopReview intent cutover (TASK-1316)", () => {
  test("off mode never constructs a runner and returns the pre-1316 shape", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [],
      cutover("off"),
    );

    expect(mockCreateRunner).not.toHaveBeenCalled();
    expect(evaluation.judgmentOrchestration).toBeUndefined();
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
    expect(evaluation.judgmentDecision?.judgment.source).toBe("legacy_policy");
  });

  test("an absent cutover argument is off (every pre-1316 caller)", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
    );

    expect(mockCreateRunner).not.toHaveBeenCalled();
    expect(evaluation.judgmentOrchestration).toBeUndefined();
  });

  // THE load-bearing test: a clean review carries ZERO blocking signals,
  // so the default signal gate would skip the runner and make this whole
  // cutover inert exactly where it is supposed to act.
  test("a CLEAN eligible review still reaches the runner (always_evaluate)", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [],
      cutover("shadow"),
    );

    expect(evaluation.judgmentDecision?.signals).toHaveLength(0);
    expect(mockCreateRunner).toHaveBeenCalledTimes(1);
    expect(mockRunnerRun).toHaveBeenCalledTimes(1);
    expect(evaluation.judgmentOrchestration?.attempted).toBe(true);
    expect(evaluation.judgmentOrchestration?.reason).toBe("shadow_candidate");
  });

  test("shadow observes divergence without touching eligibility", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [],
      cutover("shadow"),
    );

    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
    expect(evaluation.reviewGate.reasons).toEqual([]);
    expect(evaluation.judgmentOrchestration?.diverged).toBe(true);
    expect(evaluation.judgmentOrchestration?.candidateDecision?.action).toBe("human_review");
  });

  test("enforce human_review WITHDRAWS eligibility with the rationale visible", async () => {
    respondWith("human_review", ["the diff satisfies the checklist but not the intent"]);
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [],
      cutover("enforce"),
    );

    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
    expect(evaluation.reviewGate.reasons).toContain(
      "INTENT HOLD: the diff satisfies the checklist but not the intent",
    );
    expect(evaluation.judgmentDecision?.action).toBe("human_review");
  });

  test.each(["continue", "repair"] as const)(
    "enforce %s leaves a granted eligibility untouched",
    async (action) => {
      respondWith(action);
      const evaluation = await evaluateLoopReview(
        config,
        true,
        reviewRequest(),
        factory(completed(), "codex-cli"),
        [],
        cutover("enforce"),
      );

      expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
      expect(evaluation.reviewGate.reasons).toEqual([]);
    },
  );

  // NEVER-UPGRADE: the deterministic gate refused; no intent action can
  // grant what it refused.
  test.each(["continue", "repair"] as const)(
    "enforce %s can NEVER grant eligibility the deterministic gate refused",
    async (action) => {
      respondWith(action);
      const evaluation = await evaluateLoopReview(
        config,
        true,
        reviewRequest(),
        factory(completed({ verdict: "FIX_FIRST" }), "codex-cli"),
        [],
        cutover("enforce"),
      );

      expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
      expect(evaluation.judgmentOrchestration?.reason).toBe("intent_upgrade_refused");
      // The refused candidate survives as evidence.
      expect(evaluation.judgmentOrchestration?.candidateDecision?.action).toBe(action);
      expect(evaluation.judgmentOrchestration?.activeDecision.judgment.source).toBe(
        "legacy_policy",
      );
    },
  );

  test("a spec with no intent sections skips orchestration and constructs no runner", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest({ taskSpec: "no sections here" }),
      factory(completed(), "codex-cli"),
      [],
      cutover("enforce"),
    );

    expect(mockCreateRunner).not.toHaveBeenCalled();
    expect(evaluation.judgmentOrchestration?.reason).toBe("intent_context_unavailable");
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
  });

  test("a review that failed ENVIRONMENTALLY never spends a runner call", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(
        {
          status: "runner_error",
          errorKind: "spawn_failed",
          message: "CreateProcessAsUserW failed",
          runner: "codex-cli",
          durationMs: 1,
        },
        "codex-cli",
      ),
      [],
      cutover("enforce"),
    );

    expect(mockCreateRunner).not.toHaveBeenCalled();
    expect(evaluation.judgmentOrchestration).toBeUndefined();
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });

  test("an intent-runner outage PRESERVES the legacy outcome (D2)", async () => {
    mockRunnerRun.mockResolvedValue({
      status: "runner_error",
      errorCode: "timeout",
      message: "timed out",
      model: "test-model",
      durationMs: 1,
      truncatedFields: [],
    });
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [],
      cutover("enforce"),
    );

    expect(evaluation.judgmentOrchestration?.reason).toBe("enforce_runner_error_legacy_preserved");
    // A judgment-runner outage must not withdraw an approval the
    // deterministic gate granted.
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
  });

  test("a safety-dispositioned signal short-circuits BEFORE the runner", async () => {
    respondWith("continue");
    const safety: JudgmentSignal = {
      source: "loop_diff",
      code: "seal_machinery_tier_s",
      disposition: "safety",
      message: "machinery tamper",
      deterministic: true,
      safetyCode: "machinery_tamper",
    };
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest(),
      factory(completed(), "codex-cli"),
      [safety],
      cutover("enforce"),
    );

    expect(mockRunnerRun).not.toHaveBeenCalled();
    expect(evaluation.judgmentOrchestration?.reason).toBe("safety_stop");
    expect(evaluation.judgmentDecision?.action).toBe("stop");
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });

  test("the brief stage uses the same mount and carries its own stage tag", async () => {
    respondWith("human_review");
    const evaluation = await evaluateLoopReview(
      config,
      true,
      reviewRequest({ kind: "brief", artifact: "## Brief" }),
      factory(completed(), "codex-cli"),
      [],
      cutover("enforce"),
    );

    expect(mockRunnerRun.mock.calls[0]?.[0].stage).toBe("loop_brief");
    expect(evaluation.judgmentDecision?.stage).toBe("loop_brief");
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(false);
  });
});
