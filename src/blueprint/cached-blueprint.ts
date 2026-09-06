// ─── Cached Blueprint Rehydration ───────────────────────────────────
// TASK-1306: resolve a cached preflight into the dispatcher's blueprint
// inputs. Before this module, cache-hit dispatches rehydrated an EMPTY
// blueprint stub — the approval gate evaluated zero counts, the approval
// file showed humans an empty plan, and blueprint-derived judge checks
// were lost. With a persisted `structured` object, a cache hit now behaves
// like a fresh generation; legacy caches (no `structured`) keep the old
// stub behavior exactly — additive read, no forced regeneration.

import type { Blueprint } from "./blueprint-types.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import { createMinimalBlueprint, validateBlueprint } from "./blueprint-agent.js";

export interface ResolvedCachedBlueprint {
  /** The blueprint the dispatcher should use (real object or legacy stub). */
  blueprint: Blueprint;
  /** The prompt markdown (always the cached formattedMarkdown — byte-identical worker context). */
  blueprintMarkdown: string;
  /** True when a persisted structured object was rehydrated; false = legacy stub. */
  structured: boolean;
}

/**
 * Resolve a cached preflight into blueprint inputs, or null when the cache
 * cannot serve a blueprint (no formattedMarkdown → caller generates fresh).
 *
 * A present `structured` object is normalized through the SAME
 * `validateBlueprint` the agent parse path uses (single normalizer): a
 * well-formed object rehydrates with real content; a partial/malformed blob
 * falls back to the legacy stub — a half-object is never treated as a brief.
 */
export function resolveCachedBlueprint(
  cached: PreflightResult | null | undefined,
): ResolvedCachedBlueprint | null {
  const markdown = cached?.blueprint?.formattedMarkdown;
  if (!cached || typeof markdown !== "string" || markdown.length === 0) {
    return null;
  }

  // TASK-1324 round-2 F1: the verdict persisted BESIDE structured (it
  // survives the 256KB size-drop). Reattached to whatever object this
  // resolution yields, so a size-dropped audited brief never reads as
  // unchecked at the approval predicate.
  const persistedFidelity = cached.blueprint.fidelity;

  const raw = cached.blueprint.structured;
  if (raw) {
    const normalized = validateBlueprint(raw);
    if (normalized) {
      return {
        blueprint:
          normalized.fidelity || !persistedFidelity
            ? normalized
            : { ...normalized, fidelity: persistedFidelity },
        blueprintMarkdown: markdown,
        structured: true,
      };
    }
  }

  const stub = createMinimalBlueprint(cached.taskId);
  return {
    // TASK-1324: the stub itself is NOT audited (the pre-1324
    // LEGACY-cache tolerance contract, TASK-1306), but a persisted
    // verdict from the ORIGINAL synthesis reattaches — absent fidelity
    // still reads as "not checked", never as "ok".
    blueprint: persistedFidelity ? { ...stub, fidelity: persistedFidelity } : stub,
    blueprintMarkdown: markdown,
    structured: false,
  };
}
