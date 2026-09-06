import type {
  IntentJudgmentRequest,
  IntentJudgmentRunResult,
  IntentJudgmentRunner,
} from "../judgment-types.js";
import {
  IntentJudgmentRunnerConfigSchema,
  type IntentJudgmentRunnerConfig,
} from "./intent-judgment-config.js";
import { runClaudeIntentJudgment } from "./claude-intent-judgment-runner.js";

export function createIntentJudgmentRunner(rawConfig: unknown = {}): IntentJudgmentRunner {
  const config: IntentJudgmentRunnerConfig = IntentJudgmentRunnerConfigSchema.parse(rawConfig);

  return {
    kind: "claude-sdk",
    run: (request: IntentJudgmentRequest): Promise<IntentJudgmentRunResult> =>
      runClaudeIntentJudgment(request, config),
  };
}
