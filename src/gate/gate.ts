import { GateResult, ParsedTask } from "../core/types.js";
import { ProjectAdapter } from "../core/adapter-loader.js";
import { validateTaskSchema } from "./schema-validator.js";
import { evaluateTaskDepth } from "./depth-evaluator.js";
import { enrichTask } from "./enrichment-agent.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { resolveModel } from "../dispatcher/model-router.js";
import { getGateAdvisory } from "../analytics/gate-advisor.js";
import {
  detectArtifactCollisions,
  collisionsToDeficiencies,
} from "./artifact-collision-detector.js";
import { projectReadinessDecision } from "../judgment/judgment-adapters.js";
import { containJudgmentProjection } from "../judgment/judgment-events.js";
import { reduceJudgment } from "../judgment/judgment-reducer.js";
import { orchestrateJudgment } from "../judgment/judgment-orchestrator.js";
import { createIntentJudgmentRunner } from "../judgment/runner/intent-judgment-runner.js";
import {
  buildReadinessIntentRequest,
  type ReadinessGateEvidence,
} from "../judgment/intent-request.js";

type ReadinessGateOptions = {
  skipEnrichment?: boolean;
  skipDepthOnly?: boolean;
  allowEnrichmentFailureFallback?: boolean;
};

/**
 * Runs the full Task Readiness Gate pipeline.
 *
 * Pipeline:
 * 1. Schema validation
 * 2. Advisory lookup
 * 3. Artifact collision detection
 * 4. Depth evaluation
 * 5. Auto-enrichment when needed
 *
 * TASK-1315: every RETURNED GateResult flows through one shared exit
 * (`finalize`) that attaches the legacy readiness projection, runs the
 * intent-judgment orchestration when `judgment.stages.readiness.mode`
 * is not `off`, and emits `gate_result` / the final `judgment_decision`
 * (and `judgment_evaluation` when orchestration was attempted) so the
 * emitted events always match the RETURNED outcome. Off mode reproduces
 * the pre-1315 event content and order exactly.
 */
export async function runReadinessGate(
  task: ParsedTask,
  adapter: ProjectAdapter,
  options?: ReadinessGateOptions,
  events?: IEventWriter,
): Promise<GateResult> {
  // Round-1 F4: pass/enriched GateResults discard the gate's working
  // evidence, so the cutover captures it as the pipeline runs.
  const evidence: ReadinessGateEvidence = {
    schemaWarnings: [],
    advisorySuggestedMinScore: 3.0,
    collisionDeficiencies: [],
  };

  const mode = adapter.config.judgment?.stages.readiness.mode ?? "off";

  const emitDecision = (decision: NonNullable<GateResult["judgmentDecision"]>): void => {
    events?.emit("judgment_decision", {
      taskId: task.id,
      stage: "readiness",
      sequence: 0,
      final: true,
      decision,
    });
  };

  const finalize = async (
    result: GateResult,
    resultEventPayload: Record<string, unknown>,
  ): Promise<GateResult> => {
    const projected = containJudgmentProjection(() => projectReadinessDecision(result));

    // Round-1 F7: projection failure is contained fail-closed — the
    // deterministic outcome stands, the runner is NEVER invoked, and the
    // synthesized decision carries the typed failure.
    if (!projected.decision) {
      events?.emit("gate_result", resultEventPayload);
      events?.emit("judgment_projection_failed", {
        taskId: task.id,
        stage: "readiness",
        ...projected.failure,
        sequence: 0,
      });
      // Off mode: pre-1315 behavior byte-identical — no decision is
      // attached or emitted on projection failure.
      if (mode === "off") {
        return result;
      }
      const fallback = reduceJudgment({
        stage: "readiness",
        signals: [],
        judgment: {
          source: "legacy_policy",
          action: "human_review",
          rationale: ["judgment_projection_failure"],
        },
      });
      emitDecision(fallback);
      return {
        ...result,
        judgmentDecision: fallback,
        judgmentOrchestration: {
          mode,
          attempted: false,
          reason: "projection_failure",
          legacyDecision: fallback,
          activeDecision: fallback,
          projectionFailure: projected.failure,
          diverged: false,
        },
      };
    }

    const legacy = projected.decision;

    // Off mode: pre-1315 behavior byte-identical (content and order).
    if (mode === "off") {
      events?.emit("gate_result", resultEventPayload);
      emitDecision(legacy);
      return { ...result, judgmentDecision: legacy };
    }

    // Round-1 F8: enriched outcomes SKIP orchestration — the dispatcher
    // deterministically auto-approves enriched output, and attaching an
    // ignored intent candidate as active would be incoherent authority.
    if (result.outcome === "enriched") {
      events?.emit("gate_result", resultEventPayload);
      emitDecision(legacy);
      return { ...result, judgmentDecision: legacy };
    }

    const request = buildReadinessIntentRequest(task, result, legacy, evidence);
    const runner = request
      ? createIntentJudgmentRunner(adapter.config.judgment?.runner)
      : undefined;
    const orchestration = await orchestrateJudgment({
      mode,
      legacyDecision: legacy,
      request,
      runner,
      // The readiness availability posture (round-1 F3): a runner outage
      // must never reject tasks the deterministic gate passed.
      onRunnerError: "preserve_legacy",
    });
    const active = orchestration.activeDecision;

    let finalResult: GateResult = {
      ...result,
      judgmentDecision: active,
      judgmentOrchestration: orchestration,
    };
    let finalEventPayload = resultEventPayload;

    // Enforce reviews REJECTIONS only (round-1b F1: legacy passes carry
    // advisory-only signals and the orchestrator's signal gate never
    // invokes the runner for them; enriched skipped above).
    if (
      mode === "enforce" &&
      result.outcome === "rejected" &&
      // r2-F2: ONLY a completed enforced candidate maps outcomes —
      // degradation (preserve_legacy) leaves every legacy field alone.
      orchestration.reason === "enforced_candidate"
    ) {
      if (active.action === "continue") {
        const rationaleLines = active.rationale.map((line) => `INTENT RESCUE: ${line}`);
        // r2-F4: deterministic ADVISORY findings survive the rescue.
        const advisoryLines = (evidence.depthResult?.deficiencies ?? []).filter((deficiency) =>
          deficiency.startsWith("ADVISORY:"),
        );
        finalResult = {
          outcome: "pass",
          task,
          advisories: [...advisoryLines, ...rationaleLines],
          judgmentDecision: active,
          judgmentOrchestration: orchestration,
        };
        finalEventPayload = { outcome: "pass", intentRescue: true };
      } else {
        finalResult = {
          ...result,
          reason: `${result.reason} | intent: ${active.rationale.join("; ")}`,
          judgmentDecision: active,
          judgmentOrchestration: orchestration,
        };
        // r2-F3: the emitted payload matches the RETURNED reason.
        finalEventPayload = {
          ...resultEventPayload,
          reason: finalResult.reason,
          intentConfirmedRejection: true,
        };
      }
    }

    events?.emit("gate_result", finalEventPayload);
    emitDecision(active);
    // r2-F3: evaluation is emitted only when orchestration was ATTEMPTED
    // (the documented contract) — skip reasons stay off the stream.
    if (orchestration.attempted) {
      events?.emit("judgment_evaluation", {
        taskId: task.id,
        stage: "readiness",
        sequence: 0,
        // TASK-1316 repair: `JudgmentEvaluationPayload` declares
        // `final: false` and the 1311 emitters (workflows, federation)
        // honor it — the FINAL flag belongs to `judgment_decision`, and
        // this companion record must not claim it. The 1315 emission
        // said `true`; the loose `EventPayload` union hid it from tsc.
        final: false,
        orchestration,
      });
    }
    return finalResult;
  };

  const schemaResult = validateTaskSchema(task, adapter.config.gate?.requiredSections ?? []);
  evidence.schemaWarnings = [...schemaResult.warnings];

  events?.emit("gate_schema", {
    valid: schemaResult.valid,
    missing: schemaResult.missing,
    warnings: schemaResult.warnings,
  });

  if (!schemaResult.valid) {
    return finalize(
      {
        outcome: "rejected",
        reason: "Schema validation failed",
        details: schemaResult,
      },
      { outcome: "rejected", reason: "Schema validation failed" },
    );
  }

  let advisorySuggestedMinScore = 3.0;
  try {
    const advisory = getGateAdvisory(task, adapter.projectRoot);
    advisorySuggestedMinScore = advisory.suggestedMinScore;
    if (advisory.warnings.length > 0 || advisory.relevantPatterns.length > 0) {
      events?.emit("gate_advisory", {
        suggestedMinScore: advisory.suggestedMinScore,
        warnings: advisory.warnings,
        relevantPatterns: advisory.relevantPatterns.map((pattern) => pattern.pattern),
      });
    }
  } catch {
    // Advisory failure is non-fatal.
  }
  evidence.advisorySuggestedMinScore = advisorySuggestedMinScore;

  let collisionDeficiencies: string[] = [];
  try {
    const collisions = detectArtifactCollisions(task, adapter);
    if (collisions.blockers.length > 0 || collisions.warnings.length > 0) {
      events?.emit("gate_artifact_collisions", {
        blockerCount: collisions.blockers.length,
        warningCount: collisions.warnings.length,
        blockers: collisions.blockers,
        warnings: collisions.warnings,
      });
    }
    collisionDeficiencies = collisionsToDeficiencies(collisions);
  } catch {
    // Detection failure is non-fatal.
  }
  evidence.collisionDeficiencies = [...collisionDeficiencies];

  if (options?.skipDepthOnly) {
    events?.emit("gate_depth", {
      ready: true,
      skipped: true,
      reason: "skipDepthOnly",
    });
    return finalize(
      {
        outcome: "pass",
        task,
        ...(collisionDeficiencies.length > 0 ? { advisories: collisionDeficiencies } : {}),
      },
      { outcome: "pass", mode: "skip_depth_only" },
    );
  }

  const gateModel = resolveModel(adapter.config.modelRouting, adapter.config.agent, {
    stage: "gate",
  });
  let depthResult = await evaluateTaskDepth(task, adapter.conventionsDoc, {
    model: gateModel,
  });

  if (collisionDeficiencies.length > 0) {
    depthResult = {
      ...depthResult,
      deficiencies: [...collisionDeficiencies, ...depthResult.deficiencies],
    };
  }
  evidence.depthResult = depthResult;

  events?.emit("gate_depth", {
    ready: depthResult.ready,
    overallScore: depthResult.overallScore,
    deficiencies: depthResult.deficiencies,
  });

  const advisoryDeficiencies = depthResult.deficiencies.filter((deficiency) =>
    deficiency.startsWith("ADVISORY:"),
  );

  if (depthResult.ready) {
    if (advisorySuggestedMinScore > 3.0 && depthResult.overallScore < advisorySuggestedMinScore) {
      // TASK-1319 (R1-8): this event was called `gate_advisory_override`
      // and the name was BACKWARDS. Nothing is overridden here. A depth
      // verdict that came back READY is routed to enrichment anyway
      // BECAUSE the advisory minimum is higher, which is the advisory
      // being HONORED. The original P2-5 plan was to bolt an "actor"
      // onto it as though a human had overridden something, which would
      // have put the exact opposite of the truth into the audit trail.
      // Renamed, and deliberately NOT one of TASK-1319's override
      // surfaces.
      events?.emit("gate_advisory_applied", {
        depthScore: depthResult.overallScore,
        advisorySuggestedMinScore,
        action: "route_to_enrichment",
      });
    } else {
      return finalize(
        {
          outcome: "pass",
          task,
          ...(advisoryDeficiencies.length > 0 ? { advisories: advisoryDeficiencies } : {}),
        },
        { outcome: "pass" },
      );
    }
  }

  // The depth LLM can flag a structural hard-stop in free text (e.g. a
  // dependency that does not exist) by prefixing a deficiency with
  // "BLOCKING". Only not-ready results reach this filter; it converts a
  // pointless enrichment run into a rejection. Judgment-plane material for
  // v2 Phase 2 — kept as-is in Phase 0 (TASK-1300).
  const blockingDeficiencies = depthResult.deficiencies.filter((deficiency) =>
    deficiency.toUpperCase().startsWith("BLOCKING"),
  );
  if (blockingDeficiencies.length > 0) {
    return finalize(
      {
        outcome: "rejected",
        reason: `Blocking deficiencies prevent dispatch: ${blockingDeficiencies.map((deficiency) => deficiency.slice(0, 100)).join("; ")}`,
        details: depthResult,
      },
      {
        outcome: "rejected",
        reason: "Blocking deficiencies detected",
        blockingDeficiencies,
      },
    );
  }

  if (options?.skipEnrichment) {
    return finalize(
      {
        outcome: "rejected",
        reason: "Depth evaluation failed",
        details: depthResult,
      },
      { outcome: "rejected", reason: "Depth evaluation failed" },
    );
  }

  const enrichModel = resolveModel(adapter.config.modelRouting, adapter.config.agent, {
    stage: "enrich",
  });

  let enrichedContent: string;
  try {
    enrichedContent = await enrichTask(
      task,
      depthResult.deficiencies,
      depthResult.enrichmentSuggestions,
      adapter,
      { model: enrichModel },
    );
  } catch (error: unknown) {
    if (!options?.allowEnrichmentFailureFallback) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    return finalize(
      {
        outcome: "pass",
        task,
        ...(advisoryDeficiencies.length > 0 ? { advisories: advisoryDeficiencies } : {}),
      },
      { outcome: "pass", enrichmentFallback: true, reason },
    );
  }

  const enrichedTask: ParsedTask = {
    ...task,
    rawContent: enrichedContent,
  };

  return finalize(
    {
      outcome: "enriched",
      task: {
        original: task,
        enriched: enrichedTask,
        diff: "enriched by agent",
        approved: false,
      },
      ...(advisoryDeficiencies.length > 0 ? { advisories: advisoryDeficiencies } : {}),
    },
    { outcome: "enriched" },
  );
}
