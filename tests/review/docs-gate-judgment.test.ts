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
Object.freeze(review.wikiArtifacts);

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
  it("keeps the full computed requirements while only missing actions reach the enforce signal", async () => {
    const input: ReviewBundleInput = {
      ...review,
      docsImpact: "support_bundle",
      requiredWikiActions: ["changelog_entry"],
      wikiArtifacts: [
        {
          action: "changelog_entry",
          pagePath: "wiki/changelog.md",
          commitSha: "abc1234",
          linkedTaskIds: [review.taskId],
        },
      ],
      supportDocCandidates: [{ title: "Guide", summary: "Feature usage." }],
    };
    const captured: IntentJudgmentRequest[] = [];
    const gate = await evaluateReviewGateWithJudgment(input, fullTask, {
      config: config("enforce"),
      runner: runner("repair", captured),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].stageContext.requiredWikiActions).toEqual([
      "changelog_entry",
      "feature_page_update",
      "support_bundle",
    ]);
    expect(captured[0].stageContext.requiredWikiActions).toEqual(gate.requiredWikiActions);
    expect(gate.missingWikiActions).toEqual(["feature_page_update", "support_bundle"]);
    expect(captured[0].signals[0].signal.message).toBe(
      "Missing required wiki artifacts for actions: feature_page_update, support_bundle",
    );
    expect(gate.mergeReady).toBe(false);
  });

  it.each([
    ["none", undefined, []],
    ["changelog_only", undefined, ["changelog_entry"]],
    ["changelog_only", [], ["changelog_entry"]],
    ["feature_page_update", undefined, ["changelog_entry", "feature_page_update"]],
    ["support_bundle", undefined, ["changelog_entry", "feature_page_update", "support_bundle"]],
    [
      "changelog_only",
      ["support_bundle", "changelog_entry"],
      ["changelog_entry", "support_bundle"],
    ],
    ["none", ["feature_page_update"], ["feature_page_update"]],
  ] as const)(
    "sends computed %s requirements with caller actions %j",
    async (docsImpact, supplied, expected) => {
      const input: ReviewBundleInput = {
        ...review,
        docsImpact,
        requiredWikiActions: supplied ? [...supplied] : undefined,
        findings: [{ title: "A separate unresolved finding", severity: "P2" }],
      };
      const captured: IntentJudgmentRequest[] = [];
      const gate = await evaluateReviewGateWithJudgment(input, fullTask, {
        config: config("shadow"),
        runner: runner("continue", captured),
      });
      expect(captured).toHaveLength(1);
      expect(gate.requiredWikiActions).toEqual(expected);
      expect(captured[0].stageContext.requiredWikiActions).toEqual(gate.requiredWikiActions);
      expect(gate.missingWikiActions).toEqual(expected);
      for (const action of expected) {
        expect(
          captured[0].signals.find(({ signal }) => signal.code === "missing_wiki_artifacts")?.signal
            .message,
        ).toContain(action);
      }
    },
  );

  it.each([true, false])(
    "preserves satisfied requirements with independent blocker=%s",
    async (blocked) => {
      const input: ReviewBundleInput = {
        ...review,
        docsImpact: "support_bundle",
        wikiArtifacts: (["changelog_entry", "feature_page_update", "support_bundle"] as const).map(
          (action) => ({
            action,
            pagePath: `wiki/${action}.md`,
            commitSha: "abc1234",
            linkedTaskIds: [review.taskId],
          }),
        ),
        supportDocCandidates: [{ title: "Operating guide", summary: "How to use the feature." }],
        findings: blocked ? [{ title: "Unresolved behavior", severity: "P2" }] : [],
      };
      const captured: IntentJudgmentRequest[] = [];
      const gate = await evaluateReviewGateWithJudgment(input, fullTask, {
        config: config("shadow"),
        runner: runner("continue", captured),
      });
      expect(gate.missingWikiActions).toEqual([]);
      expect(gate.mergeReady).toBe(!blocked);
      if (blocked) {
        expect(captured).toHaveLength(1);
        expect(captured[0].stageContext.requiredWikiActions).toEqual([
          "changelog_entry",
          "feature_page_update",
          "support_bundle",
        ]);
        expect(captured[0].signals.map(({ signal }) => signal.code)).toEqual([
          "unresolved_high_severity_finding",
        ]);
      } else {
        expect(captured).toEqual([]);
        expect(gate.judgmentOrchestration?.reason).toBe("no_blocking_signals");
      }
    },
  );

  it.each(["requiredWikiActions", "wikiArtifacts", "supportDocCandidates", "findings"] as const)(
    "does not alias the caller's %s array into the runner",
    async (field) => {
      const input: ReviewBundleInput = {
        ...review,
        requiredWikiActions: ["feature_page_update"],
        wikiArtifacts: [],
        supportDocCandidates: [],
        findings: [],
      };
      const before = structuredClone(input);
      const captured: IntentJudgmentRequest[] = [];
      const baseRunner = runner("continue", captured);
      const gate = await evaluateReviewGateWithJudgment(input, fullTask, {
        config: config("shadow"),
        runner: {
          ...baseRunner,
          run: (request) => {
            (request.stageContext[field] as unknown[]).push("runner-only mutation");
            return baseRunner.run(request);
          },
        },
      });
      expect(captured).toHaveLength(1);
      expect(input).toEqual(before);
      expect(gate.requiredWikiActions).toEqual(["changelog_entry", "feature_page_update"]);
      expect(captured[0].stageContext.requiredWikiActions).not.toBe(gate.requiredWikiActions);
    },
  );

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
