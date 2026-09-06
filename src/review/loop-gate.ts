import type { ReviewerRunnerConfig } from "./reviewer-config.js";
import { createReviewerRunner } from "./reviewer-runner.js";
import type {
  ReviewerRunner,
  ReviewerRunnerKind,
  ReviewRequest,
  ReviewRunResult,
} from "./reviewer-types.js";
import type {
  JudgmentDecision,
  JudgmentOrchestrationResult,
  JudgmentProjectionFailure,
  JudgmentRolloutMode,
  JudgmentSignal,
} from "../judgment/judgment-types.js";
import { projectLoopReviewDecision, stageForReviewKind } from "../judgment/judgment-adapters.js";
import { containJudgmentProjection } from "../judgment/judgment-events.js";
import { orchestrateJudgment } from "../judgment/judgment-orchestrator.js";
import { buildLoopIntentRequest } from "../judgment/intent-request.js";
import { createIntentJudgmentRunner } from "../judgment/runner/intent-judgment-runner.js";
import type { IntentJudgmentRunnerConfig } from "../judgment/runner/intent-judgment-config.js";

export interface LoopReviewGateFacts {
  crossModelSatisfied: boolean;
  anchorAuditPassed: boolean;
  treeClean: boolean;
  /** TASK-1324: the brief's deterministic fidelity audit. True when the
   *  audit passed OR was not applicable at this gate (diff/retry gates,
   *  pre-1324 briefs with no audit). Only an explicit `failed` withdraws
   *  eligibility. */
  fidelityPassed: boolean;
  eligibleForAutoApproval: boolean;
  reasons: string[];
}

export interface LoopReviewEvaluation {
  runnerKind: ReviewerRunnerKind;
  result: ReviewRunResult;
  reviewGate: LoopReviewGateFacts;
  judgmentDecision?: JudgmentDecision;
  judgmentProjectionFailure?: JudgmentProjectionFailure;
  /** TASK-1316: present only when the cutover ran (mode != off). */
  judgmentOrchestration?: JudgmentOrchestrationResult;
}

/**
 * TASK-1316: the per-stage intent cutover inputs. The caller resolves
 * the mode from `judgment.stages.loopBrief` / `.loopDiff` — one mount
 * serves brief, diff, and the retry-side diff review because the stage
 * derives from `request.kind`.
 */
export interface LoopJudgmentCutover {
  mode: JudgmentRolloutMode;
  runnerConfig?: IntentJudgmentRunnerConfig;
}

type ReviewerRunnerFactory = (config: unknown) => ReviewerRunner;

/**
 * Run one loop review and derive fail-closed approval facts without rewriting
 * the runner's typed result or verdict.
 *
 * TASK-1316: when the stage's judgment mode is not `off`, the legacy
 * projection is handed to the intent-judgment orchestrator under a
 * HOLD-OR-DEMOTE policy. Enforce-mode `human_review` withdraws
 * auto-approval eligibility with the rationale visible in `reasons[]`;
 * nothing an intent model returns can GRANT eligibility the
 * deterministic gate refused (the orchestrator refuses less-restrictive
 * candidates structurally). Off mode is byte-identical to pre-1316.
 */
export async function evaluateLoopReview(
  config: ReviewerRunnerConfig,
  requireCrossModel: boolean,
  request: ReviewRequest,
  runnerFactory: ReviewerRunnerFactory = createReviewerRunner,
  injectedSignals: JudgmentSignal[] = [],
  cutover?: LoopJudgmentCutover,
  /** TASK-1324: the brief's pipeline-stamped fidelity result, passed at
   *  the BRIEF gate only (diff/retry gates omit it — the brief's
   *  fidelity was settled before any build ran). */
  briefFidelity?: import("../blueprint/blueprint-types.js").BriefFidelityResult,
): Promise<LoopReviewEvaluation> {
  const stage = stageForReviewKind(request.kind);
  const mode = cutover?.mode ?? "off";
  const runner = runnerFactory(config);
  const result = await runner.run(request);
  const crossModelSatisfied = runner.kind === "codex-cli";
  // TASK-1313: injected safety signals (enforce mode) block auto-approval
  // as defense-in-depth; the dispatcher's safety_stop transition is the
  // primary control.
  const injectedSafety = injectedSignals.some((signal) => signal.disposition === "safety");

  /**
   * The single exit every returned evaluation flows through, so the
   * cutover cannot diverge between the runner-error path and the
   * completed path (the TASK-1315 single-exit lesson).
   */
  const finalize = async (reviewGate: LoopReviewGateFacts): Promise<LoopReviewEvaluation> => {
    const projection = containJudgmentProjection(() =>
      projectLoopReviewDecision(stage, result, reviewGate, injectedSignals),
    );

    // Projection failure is contained fail-closed: the deterministic
    // gate facts stand and the intent runner is NEVER constructed.
    if (!projection.decision) {
      return {
        runnerKind: runner.kind,
        result,
        reviewGate,
        judgmentProjectionFailure: projection.failure,
      };
    }

    const legacy = projection.decision;

    // Off mode reproduces pre-1316 behavior exactly.
    //
    // A review that failed ENVIRONMENTALLY also short-circuits here: the
    // artifact under review does not exist, so there is nothing for an
    // intent model to read but an error string, and the outcome is
    // structurally inert anyway (legacy is already `human_review`, and
    // the monotonic policy refuses every less-restrictive candidate).
    // Spending a model call there would be theater, not judgment.
    if (mode === "off" || result.status === "runner_error") {
      return {
        runnerKind: runner.kind,
        result,
        reviewGate,
        judgmentDecision: legacy,
      };
    }

    const intentRequest = buildLoopIntentRequest(
      stage,
      request.taskId,
      request.taskSpec,
      result,
      reviewGate,
      legacy,
    );
    const intentRunner = intentRequest
      ? createIntentJudgmentRunner(cutover?.runnerConfig)
      : undefined;
    const orchestration = await orchestrateJudgment({
      mode,
      legacyDecision: legacy,
      request: intentRequest,
      runner: intentRunner,
      // A judgment-runner outage must never withdraw an auto-approval
      // the deterministic gate granted; the human pause path stays
      // available regardless (spec decision D2).
      onRunnerError: "preserve_legacy",
      // The intent model may confirm or demote here, never widen.
      outcomePolicy: "monotonic_hold_or_demote",
      // A CLEAN review is exactly the case worth reading intent on, so
      // the rescue-shaped signal gate must not skip it.
      signalGate: "always_evaluate",
    });
    const active = orchestration.activeDecision;

    // Enforce maps ONE action to a control change: `human_review`
    // withdraws eligibility. `continue` confirms; `repair` has no
    // control meaning at a review gate (there is no build to repair at
    // this seam) and is recorded in the orchestration only.
    const demoted =
      mode === "enforce" &&
      orchestration.reason === "enforced_candidate" &&
      active.action === "human_review";

    return {
      runnerKind: runner.kind,
      result,
      reviewGate: demoted
        ? {
            ...reviewGate,
            eligibleForAutoApproval: false,
            reasons: [
              ...reviewGate.reasons,
              ...active.rationale.map((line) => `INTENT HOLD: ${line}`),
            ],
          }
        : reviewGate,
      judgmentDecision: active,
      judgmentOrchestration: orchestration,
    };
  };

  const fidelityPassed = briefFidelity?.status !== "failed";

  if (result.status === "runner_error") {
    return finalize({
      crossModelSatisfied,
      anchorAuditPassed: false,
      treeClean: false,
      fidelityPassed,
      eligibleForAutoApproval: false,
      reasons: [
        `review runner failed: ${result.errorKind}`,
        ...(fidelityPassed ? [] : ["brief failed the deterministic fidelity audit"]),
        ...(injectedSafety ? ["producer safety signal present"] : []),
      ],
    });
  }

  const anchorAuditPassed = (result.anchorsAudit?.missing.length ?? 0) === 0;
  const treeClean = result.treeDirtyAfterReview !== true;
  const reasons: string[] = [];

  if (result.verdict !== "SHIP") {
    reasons.push(`review verdict is ${result.verdict}`);
  }
  if (!anchorAuditPassed) {
    reasons.push("review evidence contains missing anchors");
  }
  if (!treeClean) {
    reasons.push("review left the project tree dirty");
  }
  if (requireCrossModel && !crossModelSatisfied) {
    reasons.push("configured reviewer does not satisfy required cross-model review");
  } else if (!requireCrossModel && !crossModelSatisfied) {
    reasons.push("same-provider review allowed by configuration");
  }
  if (injectedSafety) {
    reasons.push("producer safety signal present");
  }
  if (!fidelityPassed) {
    // TASK-1324: name the violations so the gate shows WHY, not just that.
    const summary = (briefFidelity?.violations ?? [])
      .slice(0, 3)
      .map((v) => v.detail)
      .join("; ");
    reasons.push(`brief failed the deterministic fidelity audit${summary ? `: ${summary}` : ""}`);
  }

  return finalize({
    crossModelSatisfied,
    anchorAuditPassed,
    treeClean,
    fidelityPassed,
    eligibleForAutoApproval:
      result.verdict === "SHIP" &&
      anchorAuditPassed &&
      treeClean &&
      fidelityPassed &&
      !injectedSafety &&
      (!requireCrossModel || crossModelSatisfied),
    reasons,
  });
}
