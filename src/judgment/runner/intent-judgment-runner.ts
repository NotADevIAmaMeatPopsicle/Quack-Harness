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
import { runCodexIntentJudgment } from "./codex-intent-judgment-runner.js";

export function createIntentJudgmentRunner(
  rawConfig: unknown = {},
  projectRoot = process.cwd(),
): IntentJudgmentRunner {
  const config: IntentJudgmentRunnerConfig = IntentJudgmentRunnerConfigSchema.parse(rawConfig);

  if (config.provider === "codex-cli") {
    return {
      kind: "codex-cli",
      run: (request: IntentJudgmentRequest): Promise<IntentJudgmentRunResult> =>
        runCodexIntentJudgment(request, config, projectRoot),
    };
  }

  return {
    kind: "claude-sdk",
    run: (request: IntentJudgmentRequest): Promise<IntentJudgmentRunResult> =>
      runClaudeIntentJudgment(request, config),
  };
}
