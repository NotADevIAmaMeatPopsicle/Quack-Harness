// ─── Model Router ───────────────────────────────────────────────────
// Resolves which Claude model to use for each pipeline stage based on
// the ModelRoutingConfig. Falls back to legacy AdapterAgentConfig fields
// when no routing config is present, preserving backward compatibility.

import type { ModelRoutingConfig, AdapterAgentConfig } from "../core/types.js";

export type PipelineStage = "gate" | "enrich" | "plan" | "worker" | "judge";

export interface ModelResolverOptions {
  stage: PipelineStage;
  taskTags?: string[];
  retryAttempt?: number;
}

/** Tags that indicate a complex task requiring workerComplexModel */
export const COMPLEX_TAGS = ["architecture", "refactor", "design", "migration"];

/** Tags that prevent automated dispatch (requires manual/interactive session) */
export const MANUAL_TAGS = ["manual", "infrastructure", "requires-manual"];

/** Model tier ordering for escalation (lowest to highest capability) */
export const MODEL_TIERS: string[] = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

/**
 * Returns the next higher tier model, or the same model if already
 * at the highest tier or not in the tier list.
 */
export function getNextTierModel(currentModel: string): string {
  const idx = MODEL_TIERS.indexOf(currentModel);
  if (idx >= 0 && idx < MODEL_TIERS.length - 1) {
    return MODEL_TIERS[idx + 1];
  }
  return currentModel; // Already at highest tier or unknown model
}

/**
 * Resolves the model to use for a given pipeline stage.
 *
 * Resolution order:
 * 1. If `routing` (ModelRoutingConfig) is provided, use stage-specific model
 * 2. If `routing` is undefined, fall back to legacy `AdapterAgentConfig` fields
 * 3. For the worker stage, complexity tags may upgrade to workerComplexModel
 * 4. For the worker stage with retryEscalation, retries escalate the model tier
 *
 * @param routing - The model routing config (may be undefined for legacy configs)
 * @param legacy - The legacy agent config with model/judgeModel/enrichModel fields
 * @param options - Stage, optional task tags, and retry attempt number
 * @returns The resolved model identifier string
 */
export function resolveModel(
  routing: ModelRoutingConfig | undefined,
  legacy: AdapterAgentConfig,
  options: ModelResolverOptions,
): string {
  // If no routing config, fall back to legacy fields
  if (!routing) {
    switch (options.stage) {
      case "gate":
        return legacy.model;
      case "enrich":
        return legacy.enrichModel;
      case "plan":
        return legacy.enrichModel;
      case "worker":
        return legacy.model;
      case "judge":
        return legacy.judgeModel;
    }
  }

  // Use stage-specific model from routing config
  let model: string;
  switch (options.stage) {
    case "gate":
      model = routing.gateModel;
      break;
    case "enrich":
      model = routing.enrichModel;
      break;
    case "plan":
      model = routing.plannerModel;
      break;
    case "worker":
      // Check for complexity tags
      if (options.taskTags?.some((tag) => COMPLEX_TAGS.includes(tag.toLowerCase()))) {
        model = routing.workerComplexModel;
      } else {
        model = routing.workerModel;
      }
      break;
    case "judge":
      model = routing.judgeModel;
      break;
  }

  // Apply retry escalation for worker stage
  if (
    options.stage === "worker" &&
    routing.retryEscalation &&
    options.retryAttempt !== undefined &&
    options.retryAttempt > 0
  ) {
    model = getNextTierModel(model);
  }

  return model;
}
