import {
  evaluateLoopReview,
  mayReuseLoopReviewApproval,
  type LoopReviewGateFacts,
} from "../../src/review/loop-gate";
import type { ReviewerRunnerConfig } from "../../src/review/reviewer-config";
import type {
  ModelProvenance,
  ReviewerRunner,
  ReviewRequest,
  ReviewRunResult,
} from "../../src/review/reviewer-types";

const reviewerConfig: ReviewerRunnerConfig = {
  runner: "codex-cli",
  model: "gpt-5.6-terra",
  maxTurns: 30,
  timeoutMs: 600_000,
  codex: {
    binaryPath: "codex",
    sandbox: "read-only",
    provider: "openai",
  },
};

const completedReview: ReviewRunResult = {
  status: "completed",
  verdict: "SHIP",
  findings: [],
  summary: "clean",
  rawText: "{}",
  runner: "codex-cli",
  model: "gpt-5.6-terra",
  durationMs: 1,
};

const runnerFactory = (): ReviewerRunner => ({
  kind: "codex-cli",
  run: () => Promise.resolve(completedReview),
});

function request(kind: "brief" | "diff"): ReviewRequest {
  return {
    kind,
    taskId: "TASK-CROSS-MODEL",
    taskSpec: "spec",
    artifact: kind,
    projectRoot: process.cwd(),
  };
}

async function evaluate(
  kind: "brief" | "diff",
  requireCrossModel: boolean,
  producerProvenance?: ModelProvenance,
) {
  return evaluateLoopReview(
    reviewerConfig,
    requireCrossModel,
    request(kind),
    runnerFactory,
    [],
    undefined,
    undefined,
    producerProvenance,
  );
}

describe.each(["brief", "diff"] as const)("%s review cross-model provenance", (kind) => {
  test("fails closed when Codex producer and reviewer identities are the same", async () => {
    const evaluation = await evaluate(kind, true, {
      runner: "codex-cli",
      provider: "openai",
      model: "gpt-5.6-terra",
    });

    expect(evaluation.reviewGate).toMatchObject({
      crossModelSatisfied: false,
      eligibleForAutoApproval: false,
      crossModelEvidence: {
        status: "same",
        basis: "same_identity",
        producer: {
          runner: "codex-cli",
          provider: "openai",
          model: "gpt-5.6-terra",
        },
        reviewer: {
          runner: "codex-cli",
          provider: "openai",
          model: "gpt-5.6-terra",
        },
      },
    });
  });

  test("preserves true Claude-to-Codex cross-model approval", async () => {
    const evaluation = await evaluate(kind, true, {
      runner: "claude-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(evaluation.reviewGate).toMatchObject({
      crossModelSatisfied: true,
      eligibleForAutoApproval: true,
      crossModelEvidence: {
        status: "satisfied",
        basis: "different_runner",
      },
    });
  });

  test("fails closed when producer provenance is unknown", async () => {
    const evaluation = await evaluate(kind, true);

    expect(evaluation.reviewGate).toMatchObject({
      crossModelSatisfied: false,
      eligibleForAutoApproval: false,
      crossModelEvidence: {
        status: "unknown",
        basis: "producer_unknown",
      },
    });
  });

  test("preserves legacy opt-out behavior when cross-model review is not required", async () => {
    const evaluation = await evaluate(kind, false);

    expect(evaluation.reviewGate.crossModelEvidence).toMatchObject({
      status: "unknown",
      basis: "producer_unknown",
    });
    expect(evaluation.reviewGate.eligibleForAutoApproval).toBe(true);
  });
});

describe("resumed loop approvals", () => {
  const baseGate: LoopReviewGateFacts = {
    crossModelSatisfied: false,
    anchorAuditPassed: true,
    treeClean: true,
    fidelityPassed: true,
    eligibleForAutoApproval: false,
    reasons: [],
  };

  test("does not reuse legacy or unknown automatic clearance when cross-model is required", () => {
    expect(mayReuseLoopReviewApproval(baseGate, true, false)).toBe(false);
    expect(
      mayReuseLoopReviewApproval(
        {
          ...baseGate,
          crossModelEvidence: {
            status: "unknown",
            basis: "producer_unknown",
            reviewer: {
              runner: "codex-cli",
              provider: "openai",
              model: "gpt-5.6-terra",
            },
          },
        },
        true,
        false,
      ),
    ).toBe(false);
  });

  test("reuses auditable automatic clearance and preserves explicit human approval", () => {
    const satisfiedGate: LoopReviewGateFacts = {
      ...baseGate,
      crossModelSatisfied: true,
      eligibleForAutoApproval: true,
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
    };

    expect(mayReuseLoopReviewApproval(satisfiedGate, true, false)).toBe(true);
    expect(mayReuseLoopReviewApproval(baseGate, true, true)).toBe(true);
  });
});
