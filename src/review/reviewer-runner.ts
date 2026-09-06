// ─── ReviewerRunner Factory ─────────────────────────────────────────
// Constructs a ReviewerRunner from config (TASK-1305). Construction is the
// module's ONLY throwing surface: invalid config fails loudly here; after
// that, run() never rejects.

import type { ReviewerRunner, ReviewRequest, ReviewRunResult } from "./reviewer-types.js";
import { ReviewerRunnerConfigSchema, type ReviewerRunnerConfig } from "./reviewer-config.js";
import { runClaudeSdkReview } from "./claude-sdk-runner.js";
import { runCodexCliReview } from "./codex-cli-runner.js";

/**
 * Create a reviewer runner. Accepts unknown input and validates it through
 * ReviewerRunnerConfigSchema — a typo'd key, an unknown field, or any
 * sandbox value other than "read-only" throws a zod error here.
 */
export function createReviewerRunner(rawConfig: unknown = {}): ReviewerRunner {
  const config: ReviewerRunnerConfig = ReviewerRunnerConfigSchema.parse(rawConfig);

  if (config.runner === "codex-cli") {
    return {
      kind: "codex-cli",
      run: (request: ReviewRequest): Promise<ReviewRunResult> => runCodexCliReview(request, config),
    };
  }

  return {
    kind: "claude-sdk",
    run: (request: ReviewRequest): Promise<ReviewRunResult> => runClaudeSdkReview(request, config),
  };
}
