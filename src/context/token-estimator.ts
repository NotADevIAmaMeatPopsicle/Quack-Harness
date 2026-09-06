// ─── Token Estimation Utility ──────────────────────────────────────
// Character-based token approximation for context budget decisions.
// Uses the ~4 chars per token heuristic (sufficient for budget estimation,
// no need for a real tokenizer library).

import type { TaskContext, ContextSizeEstimate } from "../core/types.js";

// Re-export for convenience
export type { ContextSizeEstimate } from "../core/types.js";

/** Default context budget in tokens (~30K for static prompt) */
const DEFAULT_CONTEXT_BUDGET = 30_000;

/**
 * Estimate the number of tokens in a text string.
 * Uses the approximation of 1 token ≈ 4 characters.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (minimum 0)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for each section of a TaskContext and produce a breakdown.
 *
 * @param context - The assembled TaskContext
 * @param budget - Optional custom budget threshold (default: 30K tokens)
 * @returns Per-section token breakdown with total and budget status
 */
export function estimateTokensForContext(
  context: TaskContext,
  budget: number = DEFAULT_CONTEXT_BUDGET,
): ContextSizeEstimate {
  const taskSpec = estimateTokens(context.taskSpec);
  const blueprint = estimateTokens(context.blueprint ?? "");
  const repoMap = estimateTokens(context.repoMap ?? "");
  const relevantFiles = estimateTokens(context.relevantFiles.join("\n"));
  const relatedPatterns = estimateTokens(context.relatedPatterns.join("\n"));
  const existingTests = estimateTokens(context.existingTests.join("\n"));

  // Conventions: summary + individual convention documents
  const conventionTexts = [context.conventionsSummary, ...Object.values(context.conventions)].join(
    "\n",
  );
  const conventions = estimateTokens(conventionTexts);

  const claudeMd = estimateTokens(context.claudeMd.join("\n"));

  const total =
    taskSpec +
    blueprint +
    repoMap +
    relevantFiles +
    relatedPatterns +
    existingTests +
    conventions +
    claudeMd;

  return {
    taskSpec,
    blueprint,
    repoMap,
    relevantFiles,
    relatedPatterns,
    existingTests,
    conventions,
    claudeMd,
    total,
    withinBudget: total <= budget,
  };
}
