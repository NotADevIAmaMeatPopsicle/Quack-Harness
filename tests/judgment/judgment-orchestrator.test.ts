import { orchestrateJudgment } from "../../src/judgment/judgment-orchestrator";
import { reduceJudgment } from "../../src/judgment/judgment-reducer";
import {
  SAFETY_FLOOR_CODES,
  type IntentJudgmentRequest,
  type IntentJudgmentRunner,
  type JudgmentDecision,
  type JudgmentSignal,
} from "../../src/judgment/judgment-types";

const blockingSignal: JudgmentSignal = {
  source: "docs_review",
  code: "missing_wiki_artifacts",
  disposition: "human_review",
  message: "wiki evidence is missing",
  deterministic: true,
};

function decision(
  signals: JudgmentSignal[],
  action: "continue" | "repair" | "human_review",
): JudgmentDecision {
  return reduceJudgment({
    stage: "docs_review",
    signals,
    judgment: { source: "legacy_policy", action, rationale: [action] },
  });
}

const request: IntentJudgmentRequest = {
  stage: "docs_review",
  taskId: "TASK-1311",
  taskIntent: "Ship the intended behavior.",
  successCriteria: ["Intent is covered"],
  scopeBoundaries: ["No adapter adoption"],
  stageContext: {},
  signals: [{ ref: "missing_wiki_artifacts#1", signal: blockingSignal }],
  contextMetadata: { presentSections: ["Intent"], missingSections: [] },
};

function completedRunner(
  action: "continue" | "repair" | "human_review",
  calls: string[],
): IntentJudgmentRunner {
  return {
    kind: "claude-sdk",
    run: () => {
      calls.push("run");
      return Promise.resolve({
        status: "completed",
        judgment: { source: "intent_model", action, rationale: [action] },
        consideredSignalRefs: ["missing_wiki_artifacts#1"],
        model: "test-model",
        durationMs: 1,
        truncatedFields: [],
      });
    },
  };
}

describe("orchestrateJudgment", () => {
  it.each(SAFETY_FLOOR_CODES)(
    "short-circuits %s before a hostile continue runner",
    async (safetyCode) => {
      const calls: string[] = [];
      const safetySignal: JudgmentSignal = {
        ...blockingSignal,
        code: safetyCode,
        disposition: "safety",
        safetyCode,
      };
      const result = await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: decision([safetySignal], "continue"),
        request: {
          ...request,
          signals: [{ ref: `${safetyCode}#1`, signal: safetySignal }],
        },
        runner: completedRunner("continue", calls),
      });
      expect(calls).toEqual([]);
      expect(result.reason).toBe("safety_stop");
      expect(result.activeDecision.action).toBe("stop");
    },
  );

  it("keeps a divergent completed candidate observational in shadow", async () => {
    const calls: string[] = [];
    const legacy = decision([blockingSignal], "human_review");
    const result = await orchestrateJudgment({
      mode: "shadow",
      legacyDecision: legacy,
      request,
      runner: completedRunner("continue", calls),
    });
    expect(calls).toEqual(["run"]);
    expect(result.activeDecision).toEqual(legacy);
    expect(result.candidateDecision?.action).toBe("continue");
    expect(result.diverged).toBe(true);
  });

  it("makes a completed candidate authoritative in enforce", async () => {
    const calls: string[] = [];
    const result = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: decision([blockingSignal], "human_review"),
      request,
      runner: completedRunner("continue", calls),
    });
    expect(result.reason).toBe("enforced_candidate");
    expect(result.activeDecision.action).toBe("continue");
    expect(result.activeDecision.judgment.source).toBe("intent_model");
  });

  it("short-circuits off, advisory-only, and missing-context cases", async () => {
    const calls: string[] = [];
    const runner = completedRunner("continue", calls);
    const advisory = { ...blockingSignal, disposition: "advisory" as const };
    const cases = [
      await orchestrateJudgment({
        mode: "off",
        legacyDecision: decision([blockingSignal], "human_review"),
        request,
        runner,
      }),
      await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: decision([advisory], "continue"),
        request: { ...request, signals: [{ ref: "missing_wiki_artifacts#1", signal: advisory }] },
        runner,
      }),
      await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: decision([blockingSignal], "human_review"),
        runner,
      }),
    ];
    expect(calls).toEqual([]);
    expect(cases.map((item) => item.reason)).toEqual([
      "mode_off",
      "no_blocking_signals",
      "intent_context_unavailable",
    ]);
  });

  it("preserves legacy on shadow error and fails closed without fabricated provenance in enforce", async () => {
    const runner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () =>
        Promise.resolve({
          status: "runner_error",
          errorCode: "timeout",
          message: "timed out",
          model: "test-model",
          durationMs: 5,
          truncatedFields: [],
        }),
    };
    const legacy = decision([blockingSignal], "human_review");
    const shadow = await orchestrateJudgment({
      mode: "shadow",
      legacyDecision: legacy,
      request,
      runner,
    });
    const enforce = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request,
      runner,
    });
    expect(shadow.activeDecision).toEqual(legacy);
    expect(enforce.activeDecision.action).toBe("human_review");
    expect(enforce.activeDecision.judgment.source).toBe("legacy_policy");
    expect(enforce.activeDecision.signals.at(-1)?.code).toBe("intent_runner_unavailable");
    expect(JSON.stringify(enforce)).not.toContain('"source":"intent_model"');
  });

  it("TASK-1315: onRunnerError preserve_legacy keeps the legacy outcome active in enforce; fail_closed default unchanged", async () => {
    const runner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () =>
        Promise.resolve({
          status: "runner_error",
          errorCode: "sdk_error",
          message: "boom",
          model: "test-model",
          durationMs: 5,
          truncatedFields: [],
        }),
    };
    const legacy = decision([blockingSignal], "repair");
    const preserved = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request,
      runner,
      onRunnerError: "preserve_legacy",
    });
    expect(preserved.reason).toBe("enforce_runner_error_legacy_preserved");
    expect(preserved.activeDecision).toEqual(legacy);
    expect(preserved.diverged).toBe(false);
    expect(preserved.runnerResult?.status).toBe("runner_error");

    const failClosed = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request,
      runner,
      onRunnerError: "fail_closed",
    });
    expect(failClosed.reason).toBe("enforce_runner_error");
    expect(failClosed.activeDecision.action).toBe("human_review");

    // Shadow ignores the option entirely (legacy preserved either way).
    const shadowPreserved = await orchestrateJudgment({
      mode: "shadow",
      legacyDecision: legacy,
      request,
      runner,
      onRunnerError: "preserve_legacy",
    });
    expect(shadowPreserved.reason).toBe("shadow_runner_error");
    expect(shadowPreserved.activeDecision).toEqual(legacy);
  });

  it("TASK-1316: monotonic_hold_or_demote REFUSES a less-restrictive candidate; bidirectional (default) allows it", async () => {
    const legacy = decision([blockingSignal], "human_review");

    // A continue-hungry runner against a human_review legacy decision:
    // the classic upgrade attempt.
    const upgrade = completedRunner("continue", []);
    const refused = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request,
      runner: upgrade,
      outcomePolicy: "monotonic_hold_or_demote",
    });
    expect(refused.reason).toBe("intent_upgrade_refused");
    expect(refused.activeDecision).toEqual(legacy);
    expect(refused.candidateDecision?.action).toBe("continue");
    expect(refused.diverged).toBe(true);

    // Default policy: the readiness rescue path must still work.
    const allowed = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request,
      runner: completedRunner("continue", []),
    });
    expect(allowed.reason).toBe("enforced_candidate");
    expect(allowed.activeDecision.action).toBe("continue");
  });

  it("TASK-1316: monotonic policy ALLOWS holds and demotions", async () => {
    const legacyRepair = decision([blockingSignal], "repair");
    for (const [action, expected] of [
      ["repair", "repair"],
      ["human_review", "human_review"],
    ] as const) {
      const result = await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: legacyRepair,
        request,
        runner: completedRunner(action, []),
        outcomePolicy: "monotonic_hold_or_demote",
      });
      expect(result.reason).toBe("enforced_candidate");
      expect(result.activeDecision.action).toBe(expected);
    }
  });

  // The signal gate decides whether a CLEAN legacy decision reaches the
  // runner. Rescue-shaped stages skip it (nothing to rescue);
  // hold-or-demote stages must not, or their enforce mapping is inert
  // exactly where it was specified to act.
  describe("TASK-1316: signalGate", () => {
    const cleanLegacy = decision([], "continue");
    const cleanRequest: IntentJudgmentRequest = {
      ...request,
      signals: [],
    };

    /** A clean request carries no refs, so the runner must echo none. */
    function cleanRunner(
      action: "continue" | "repair" | "human_review",
      calls: string[],
    ): IntentJudgmentRunner {
      return {
        kind: "claude-sdk",
        run: () => {
          calls.push("run");
          return Promise.resolve({
            status: "completed",
            judgment: { source: "intent_model", action, rationale: [action] },
            consideredSignalRefs: [],
            model: "test-model",
            durationMs: 1,
            truncatedFields: [],
          });
        },
      };
    }

    it("skips a clean legacy decision by DEFAULT (1311/1315 economics unchanged)", async () => {
      const calls: string[] = [];
      const result = await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: cleanLegacy,
        request: cleanRequest,
        runner: cleanRunner("human_review", calls),
      });
      expect(calls).toEqual([]);
      expect(result.reason).toBe("no_blocking_signals");
      expect(result.activeDecision).toEqual(cleanLegacy);
    });

    it("evaluates a clean legacy decision under always_evaluate", async () => {
      const calls: string[] = [];
      const result = await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: cleanLegacy,
        request: cleanRequest,
        runner: cleanRunner("human_review", calls),
        signalGate: "always_evaluate",
        outcomePolicy: "monotonic_hold_or_demote",
      });
      expect(calls).toEqual(["run"]);
      expect(result.reason).toBe("enforced_candidate");
      // A demotion from a clean pass is the whole point of the inversion.
      expect(result.activeDecision.action).toBe("human_review");
    });

    it("always_evaluate never bypasses the off or safety short-circuits", async () => {
      const calls: string[] = [];
      const safetySignal: JudgmentSignal = {
        ...blockingSignal,
        code: "secret_exposure",
        disposition: "safety",
        safetyCode: "secret_exposure",
      };
      const off = await orchestrateJudgment({
        mode: "off",
        legacyDecision: cleanLegacy,
        request: cleanRequest,
        runner: cleanRunner("human_review", calls),
        signalGate: "always_evaluate",
      });
      const safety = await orchestrateJudgment({
        mode: "enforce",
        legacyDecision: decision([safetySignal], "continue"),
        request: { ...request, signals: [{ ref: "secret_exposure#1", signal: safetySignal }] },
        runner: completedRunner("continue", calls),
        signalGate: "always_evaluate",
      });
      expect(calls).toEqual([]);
      expect(off.reason).toBe("mode_off");
      expect(safety.reason).toBe("safety_stop");
    });
  });

  it("contains a runner that violates the never-reject contract", async () => {
    const runner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () => Promise.reject(new Error("unexpected")),
    };
    const result = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: decision([blockingSignal], "human_review"),
      request,
      runner,
    });
    expect(result.reason).toBe("enforce_runner_error");
    expect(result.activeDecision.action).toBe("human_review");
  });

  it("fails closed when an injected completed runner omits a signal ref", async () => {
    const runner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () =>
        Promise.resolve({
          status: "completed",
          judgment: {
            source: "intent_model",
            action: "continue",
            rationale: ["ignored evidence"],
          },
          consideredSignalRefs: [],
          model: "test-model",
          durationMs: 1,
          truncatedFields: [],
        }),
    };
    const result = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: decision([blockingSignal], "human_review"),
      request,
      runner,
    });
    expect(result.reason).toBe("enforce_runner_error");
    expect(result.runnerResult).toEqual(
      expect.objectContaining({
        status: "runner_error",
        errorCode: "invalid_output",
      }),
    );
    expect(result.activeDecision.action).toBe("human_review");
  });

  it("distinguishes invalid completed output from a shadow transport error", async () => {
    const runner: IntentJudgmentRunner = {
      kind: "claude-sdk",
      run: () =>
        Promise.resolve({
          status: "completed",
          judgment: {
            source: "intent_model",
            action: "continue",
            rationale: ["ignored evidence"],
          },
          consideredSignalRefs: [],
          model: "test-model",
          durationMs: 1,
          truncatedFields: [],
        }),
    };
    const result = await orchestrateJudgment({
      mode: "shadow",
      legacyDecision: decision([blockingSignal], "human_review"),
      request,
      runner,
    });
    expect(result.reason).toBe("shadow_invalid_output");
    expect(result.runnerResult).toEqual(
      expect.objectContaining({
        status: "runner_error",
        errorCode: "invalid_output",
      }),
    );
    expect(result.activeDecision.judgment.source).toBe("legacy_policy");
  });
});
