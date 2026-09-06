import {
  evaluateReviewGate,
  evaluateReviewGateWithJudgment,
  type ReviewBundleInput,
} from "../../src/review/docs-gate";
import type {
  IntentJudgmentRequest,
  IntentJudgmentRunner,
} from "../../src/judgment/judgment-types";
import type { JudgmentConfig } from "../../src/judgment/runner/intent-judgment-config";
import * as judgmentAdapters from "../../src/judgment/judgment-adapters";

const review: ReviewBundleInput = {
  taskId: "TASK-1311",
  verdict: "VERIFIED",
  docsImpact: "changelog_only",
  wikiArtifacts: [],
};

const fullTask = [
  "# TASK-1311",
  "",
  "## Metadata",
  "- **Status:** IN_PROGRESS",
  "",
  "## Intent",
  "Ship the requested behavior even when a checklist artifact is stale.",
  "",
  "## Problem Statement",
  "The old gate cannot read intent.",
  "",
  "## Success Criteria",
  "- [ ] Intent judgment is auditable",
  "",
  "## Scope Boundaries",
  "- No adapter adoption",
].join("\n");

function config(mode: "off" | "shadow" | "enforce"): JudgmentConfig {
  return {
    runner: {
      provider: "claude-sdk",
      model: "test-model",
      maxTurns: 5,
      timeoutMs: 1_000,
    },
    stages: {
      docsReview: { mode },
      readiness: { mode: "off" },
      loopBrief: { mode: "off" },
      loopDiff: { mode: "off" },
      judge: { mode: "off" },
    },
  };
}

function runner(
  action: "continue" | "repair" | "human_review",
  captured: IntentJudgmentRequest[],
): IntentJudgmentRunner {
  return {
    kind: "claude-sdk",
    run: (request) => {
      captured.push(request);
      return Promise.resolve({
        status: "completed",
        judgment: { source: "intent_model", action, rationale: [action] },
        consideredSignalRefs: request.signals.map((signal) => signal.ref),
        model: "test-model",
        durationMs: 1,
        truncatedFields: [],
      });
    },
  };
}

describe("docs review judgment cutover", () => {
  it("keeps off and shadow control behavior byte-identical to the legacy decision", async () => {
    const legacy = evaluateReviewGate(review, fullTask);
    const captured: IntentJudgmentRequest[] = [];
    const off = await evaluateReviewGateWithJudgment(review, fullTask, {
      config: config("off"),
      runner: runner("continue", captured),
    });
    const shadow = await evaluateReviewGateWithJudgment(review, fullTask, {
      config: config("shadow"),
      runner: runner("continue", captured),
    });
    expect(captured).toHaveLength(1);
    expect(off.mergeReady).toBe(legacy.mergeReady);
    expect(off.judgmentDecision).toEqual(legacy.judgmentDecision);
    expect(shadow.mergeReady).toBe(legacy.mergeReady);
    expect(shadow.judgmentDecision).toEqual(legacy.judgmentDecision);
    expect(shadow.judgmentOrchestration?.candidateDecision?.action).toBe("continue");
  });

  it.each([
    ["continue", true],
    ["repair", false],
    ["human_review", false],
  ] as const)("maps enforce %s to mergeReady=%s", async (action, mergeReady) => {
    const captured: IntentJudgmentRequest[] = [];
    const gate = await evaluateReviewGateWithJudgment(review, fullTask, {
      config: config("enforce"),
      runner: runner(action, captured),
    });
    expect(gate.mergeReady).toBe(mergeReady);
    expect(gate.judgmentDecision?.action).toBe(action);
    expect(gate.judgmentDecision?.judgment.source).toBe("intent_model");
    expect(
      gate.issues.some((issue) => issue.code === "missing_wiki_artifacts" && issue.blocking),
    ).toBe(true);
  });

  it("fails closed in enforce on runner error without intent-model provenance", async () => {
    const errorRunner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () =>
        Promise.resolve({
          status: "runner_error",
          errorCode: "timeout",
          message: "timeout",
          model: "test-model",
          durationMs: 1,
          truncatedFields: [],
        }),
    };
    const gate = await evaluateReviewGateWithJudgment(review, fullTask, {
      config: config("enforce"),
      runner: errorRunner,
    });
    expect(gate.mergeReady).toBe(false);
    expect(gate.judgmentDecision?.action).toBe("human_review");
    expect(gate.judgmentDecision?.judgment.source).toBe("legacy_policy");
    expect(JSON.stringify(gate)).not.toContain('"source":"intent_model"');
  });

  it("audits an enforce-mode legacy projection failure", async () => {
    jest.spyOn(judgmentAdapters, "projectDocsReviewDecision").mockImplementationOnce(() => {
      throw new Error("synthetic projection failure");
    });
    const gate = await evaluateReviewGateWithJudgment(review, fullTask, {
      config: config("enforce"),
    });
    expect(gate.mergeReady).toBe(false);
    expect(gate.judgmentProjectionFailure?.errorCode).toBe("unexpected_projection_error");
    expect(gate.judgmentOrchestration).toEqual(
      expect.objectContaining({
        attempted: false,
        reason: "projection_failure",
        projectionFailure: gate.judgmentProjectionFailure,
      }),
    );
    expect(gate.judgmentDecision).toEqual(gate.judgmentOrchestration?.activeDecision);
    expect(gate.judgmentDecision?.action).toBe("human_review");
    expect(gate.judgmentDecision?.judgment.source).toBe("legacy_policy");
    expect(gate.judgmentDecision?.signals.at(-1)?.code).toBe("intent_runner_unavailable");
  });

  it.each(["shadow", "enforce"] as const)(
    "short-circuits %s when all intent sections are unavailable",
    async (mode) => {
      const captured: IntentJudgmentRequest[] = [];
      const legacy = evaluateReviewGate(review, "# Old task without sections");
      const gate = await evaluateReviewGateWithJudgment(review, "# Old task without sections", {
        config: config(mode),
        runner: runner("continue", captured),
      });
      expect(captured).toEqual([]);
      expect(gate.mergeReady).toBe(legacy.mergeReady);
      expect(gate.judgmentDecision).toEqual(legacy.judgmentDecision);
      expect(gate.judgmentOrchestration?.reason).toBe("intent_context_unavailable");
    },
  );

  it("invokes with partial context and names present/missing sections", async () => {
    const captured: IntentJudgmentRequest[] = [];
    const partial = [
      "# TASK-1311",
      "## Intent",
      "Ship intent.",
      "## Success Criteria",
      "- [ ] Covered",
    ].join("\n");
    await evaluateReviewGateWithJudgment(review, partial, {
      config: config("shadow"),
      runner: runner("continue", captured),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].contextMetadata).toEqual({
      presentSections: ["Intent", "Success Criteria"],
      missingSections: ["Problem Statement", "Scope Boundaries"],
    });
  });

  it("keeps repeated issue ordering and refs stable", async () => {
    const captured: IntentJudgmentRequest[] = [];
    const repeated: ReviewBundleInput = {
      taskId: "TASK-1311",
      verdict: "VERIFIED",
      docsImpact: "none",
      wikiArtifacts: [
        {
          pagePath: "",
          commitSha: "",
          linkedTaskIds: [],
        },
      ],
      findings: [
        { title: "one", severity: "P1" },
        { title: "two", severity: "P2" },
      ],
    };
    await evaluateReviewGateWithJudgment(repeated, fullTask, {
      config: config("shadow"),
      runner: runner("continue", captured),
    });
    expect(captured[0].signals.map((signal) => signal.ref)).toEqual([
      "invalid_wiki_artifact#1",
      "invalid_wiki_artifact#2",
      "invalid_wiki_artifact#3",
      "unresolved_high_severity_finding#1",
      "unresolved_high_severity_finding#2",
    ]);
  });
});
