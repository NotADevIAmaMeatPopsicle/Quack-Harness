import { reduceJudgment } from "./judgment-reducer.js";
import type {
  IntentJudgmentRequest,
  IntentJudgmentRunResult,
  IntentJudgmentRunner,
  JudgmentDecision,
  JudgmentOrchestrationResult,
  JudgmentRolloutMode,
  JudgmentSignal,
} from "./judgment-types.js";

export interface OrchestrateJudgmentInput {
  mode: JudgmentRolloutMode;
  legacyDecision: JudgmentDecision;
  request?: IntentJudgmentRequest;
  runner?: IntentJudgmentRunner;
  /**
   * TASK-1315: enforce-mode behavior when the runner degrades (typed
   * error). `fail_closed` (default, docs-review since 1311) synthesizes
   * a human_review decision; `preserve_legacy` keeps the legacy outcome
   * active with the degradation visible — the READINESS gate uses this
   * so pipeline availability never depends on runner uptime (five
   * verification layers follow the gate).
   */
  onRunnerError?: "fail_closed" | "preserve_legacy";
  /**
   * TASK-1316: what the intent model is ALLOWED to do to the outcome.
   *
   * `bidirectional` (default) lets a candidate move the action in either
   * direction — the readiness gate depends on this for its rescue path
   * (`continue` over a legacy rejection) and docs-review is unchanged.
   *
   * `monotonic_hold_or_demote` refuses any candidate LESS restrictive
   * than the legacy decision. The loop gates and the judge use it so an
   * intent model can confirm, pause, or demote, but can never widen
   * approval — structurally, rather than by convention at each call
   * site.
   */
  outcomePolicy?: "bidirectional" | "monotonic_hold_or_demote";
  /**
   * TASK-1316: whether the runner is invoked when the legacy decision
   * carries NO blocking (repair/human_review) signals.
   *
   * `skip_when_clean` (default) is the 1311/1315 economics: at
   * rescue-shaped stages a clean legacy decision has nothing to rescue,
   * so the call is pure cost.
   *
   * Hold-or-demote stages invert that. Their legacy decision is
   * `continue` precisely BECAUSE nothing deterministic objected — and
   * "the checklist passed but the work misses the point" is the entire
   * class they exist to catch. Under `skip_when_clean` a loop
   * auto-approval and a clean judge APPROVE would never reach the
   * runner, making enforce inert exactly where it was specified to act.
   * Those stages pass `always_evaluate`.
   *
   * The safety short-circuit and the off/no-request short-circuits are
   * upstream of this option and are unaffected.
   */
  signalGate?: "skip_when_clean" | "always_evaluate";
}

/**
 * Restrictiveness ordering for the monotonic policy. A candidate may
 * hold or increase restrictiveness; it may never decrease it.
 */
const ACTION_RESTRICTIVENESS: Record<JudgmentDecision["action"], number> = {
  continue: 0,
  repair: 1,
  human_review: 2,
  stop: 3,
};

function isLessRestrictive(candidate: JudgmentDecision, legacy: JudgmentDecision): boolean {
  return ACTION_RESTRICTIVENESS[candidate.action] < ACTION_RESTRICTIVENESS[legacy.action];
}

function sameDecisionAction(left: JudgmentDecision, right: JudgmentDecision): boolean {
  return left.action === right.action;
}

function validatedLegacyDecision(decision: JudgmentDecision): JudgmentDecision {
  return reduceJudgment({
    stage: decision.stage,
    signals: decision.signals,
    judgment: decision.judgment,
  });
}

function runnerUnavailableSignal(
  decision: JudgmentDecision,
  result: IntentJudgmentRunResult,
): JudgmentSignal {
  const errorCode = result.status === "runner_error" ? result.errorCode : "sdk_error";
  return {
    source: decision.stage,
    code: "intent_runner_unavailable",
    disposition: "human_review",
    message: "Intent judgment was unavailable; enforce mode requires human review.",
    deterministic: true,
    evidence: [`runner_error:${errorCode}`],
  };
}

function unhandledRunnerRejection(): IntentJudgmentRunResult {
  return {
    status: "runner_error",
    errorCode: "sdk_error",
    message: "Intent judgment runner rejected unexpectedly",
    model: "unknown",
    durationMs: 0,
    truncatedFields: [],
  };
}

function hasExactSignalRefs(
  result: IntentJudgmentRunResult,
  request: IntentJudgmentRequest,
): boolean {
  if (result.status !== "completed") return true;
  const actual = result.consideredSignalRefs;
  const expected = request.signals.map((signal) => signal.ref);
  return (
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    actual.every((ref) => expected.includes(ref))
  );
}

/**
 * Apply the default-off judgment rollout policy around TASK-1310's reducer.
 * The runner may choose only a recoverable action; safety dominance is checked
 * before the call and re-applied to the model candidate afterward.
 */
export async function orchestrateJudgment(
  input: OrchestrateJudgmentInput,
): Promise<JudgmentOrchestrationResult> {
  const legacyDecision = validatedLegacyDecision(input.legacyDecision);

  if (!legacyDecision.safetyFloor.passed) {
    return {
      mode: input.mode,
      attempted: false,
      reason: "safety_stop",
      legacyDecision,
      activeDecision: legacyDecision,
      diverged: false,
    };
  }

  if (input.mode === "off") {
    return {
      mode: input.mode,
      attempted: false,
      reason: "mode_off",
      legacyDecision,
      activeDecision: legacyDecision,
      diverged: false,
    };
  }

  if (!input.request) {
    return {
      mode: input.mode,
      attempted: false,
      reason: "intent_context_unavailable",
      legacyDecision,
      activeDecision: legacyDecision,
      diverged: false,
    };
  }

  const hasBlockingSignal = legacyDecision.signals.some(
    (signal) => signal.disposition === "repair" || signal.disposition === "human_review",
  );
  if (!hasBlockingSignal && input.signalGate !== "always_evaluate") {
    return {
      mode: input.mode,
      attempted: false,
      reason: "no_blocking_signals",
      legacyDecision,
      activeDecision: legacyDecision,
      diverged: false,
    };
  }

  let runnerResult: IntentJudgmentRunResult;
  try {
    runnerResult = input.runner
      ? await input.runner.run(input.request)
      : unhandledRunnerRejection();
  } catch {
    runnerResult = unhandledRunnerRejection();
  }

  if (!hasExactSignalRefs(runnerResult, input.request)) {
    runnerResult = {
      status: "runner_error",
      errorCode: "invalid_output",
      message: "Intent judgment runner returned an invalid signal-ref set",
      model: runnerResult.model,
      durationMs: runnerResult.durationMs,
      ...(runnerResult.sessionId ? { sessionId: runnerResult.sessionId } : {}),
      truncatedFields: runnerResult.truncatedFields,
    };
  }

  if (runnerResult.status === "completed") {
    const candidateDecision = reduceJudgment({
      stage: legacyDecision.stage,
      signals: legacyDecision.signals,
      judgment: runnerResult.judgment,
    });

    // TASK-1316: under the monotonic policy an upgrade is refused
    // STRUCTURALLY — the candidate is still recorded (it is evidence),
    // but the legacy decision stays active and the refusal is typed.
    if (
      input.outcomePolicy === "monotonic_hold_or_demote" &&
      isLessRestrictive(candidateDecision, legacyDecision)
    ) {
      return {
        mode: input.mode,
        attempted: true,
        reason: "intent_upgrade_refused",
        legacyDecision,
        activeDecision: legacyDecision,
        candidateDecision,
        runnerResult,
        diverged: !sameDecisionAction(legacyDecision, candidateDecision),
      };
    }

    const activeDecision = input.mode === "enforce" ? candidateDecision : legacyDecision;
    return {
      mode: input.mode,
      attempted: true,
      reason: input.mode === "enforce" ? "enforced_candidate" : "shadow_candidate",
      legacyDecision,
      activeDecision,
      candidateDecision,
      runnerResult,
      diverged: !sameDecisionAction(legacyDecision, candidateDecision),
    };
  }

  if (input.mode === "shadow") {
    return {
      mode: input.mode,
      attempted: true,
      reason:
        runnerResult.errorCode === "invalid_output"
          ? "shadow_invalid_output"
          : "shadow_runner_error",
      legacyDecision,
      activeDecision: legacyDecision,
      runnerResult,
      diverged: false,
    };
  }

  // TASK-1315: the readiness gate opts into legacy preservation so a
  // runner outage cannot reject tasks the deterministic gate passed.
  if (input.onRunnerError === "preserve_legacy") {
    return {
      mode: input.mode,
      attempted: true,
      reason: "enforce_runner_error_legacy_preserved",
      legacyDecision,
      activeDecision: legacyDecision,
      runnerResult,
      diverged: false,
    };
  }

  const activeDecision = reduceJudgment({
    stage: legacyDecision.stage,
    signals: [...legacyDecision.signals, runnerUnavailableSignal(legacyDecision, runnerResult)],
    judgment: {
      source: "legacy_policy",
      action: "human_review",
      rationale: ["intent_runner_unavailable"],
    },
  });
  return {
    mode: input.mode,
    attempted: true,
    reason: "enforce_runner_error",
    legacyDecision,
    activeDecision,
    runnerResult,
    diverged: !sameDecisionAction(legacyDecision, activeDecision),
  };
}
