import {
  runCodexStructuredEvaluation,
  type CodexStructuredResult,
} from "../../llm/codex-structured-evaluator.js";
import type {
  IntentJudgmentRequest,
  IntentJudgmentRunnerErrorCode,
  IntentJudgmentRunResult,
} from "../judgment-types.js";
import type { CodexIntentJudgmentRunnerConfig } from "./intent-judgment-config.js";
import {
  INTENT_JUDGMENT_RESPONSE_SCHEMA,
  INTENT_JUDGMENT_SYSTEM_PROMPT,
  buildIntentJudgmentPrompt,
  parseIntentJudgmentResponse,
  type ParsedIntentJudgmentResponse,
} from "./intent-judgment-prompt.js";

function boundedMessage(message: string, maxChars = 500): string {
  return message.length <= maxChars ? message : `${message.slice(0, maxChars - 14)}...[truncated]`;
}

function mapErrorCode(kind: string, message: string): IntentJudgmentRunnerErrorCode {
  if (kind === "timeout") return "timeout";
  if (kind === "parse_failed") {
    return message.includes("no structured last message") ? "no_result" : "invalid_output";
  }
  return "sdk_error";
}

/**
 * Execute the shared intent contract through the hardened read-only Codex
 * evaluator. The cwd is only a sandbox/snapshot anchor: the prompt contains
 * the complete evidence packet and does not instruct Codex to inspect files.
 */
export async function runCodexIntentJudgment(
  request: IntentJudgmentRequest,
  config: CodexIntentJudgmentRunnerConfig,
  projectRoot: string,
): Promise<IntentJudgmentRunResult> {
  const built = buildIntentJudgmentPrompt(request);
  let result: CodexStructuredResult<ParsedIntentJudgmentResponse>;
  try {
    result = await runCodexStructuredEvaluation(
      {
        projectRoot,
        model: config.model,
        systemPrompt: INTENT_JUDGMENT_SYSTEM_PROMPT,
        prompt: built.prompt,
        outputSchema: INTENT_JUDGMENT_RESPONSE_SCHEMA,
        parse: (rawText) =>
          parseIntentJudgmentResponse(
            rawText,
            request.signals.map((signal) => signal.ref),
          ),
      },
      {
        runner: "codex-cli",
        model: config.model,
        maxTurns: config.maxTurns,
        timeoutMs: config.timeoutMs,
        codex: config.codex,
      },
    );
  } catch (error: unknown) {
    return {
      status: "runner_error",
      errorCode: "sdk_error",
      message: `Codex intent judgment failed unexpectedly (${error instanceof Error ? error.name : "unknown_error"})`,
      model: config.model,
      durationMs: 0,
      truncatedFields: built.truncatedFields,
    };
  }

  if (result.status === "runner_error") {
    return {
      status: "runner_error",
      errorCode: mapErrorCode(result.errorKind, result.message),
      message: boundedMessage(
        `Codex intent judgment failed (${result.errorKind}): ${result.message}`,
      ),
      model: config.model,
      durationMs: result.durationMs,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      truncatedFields: built.truncatedFields,
    };
  }

  return {
    status: "completed",
    judgment: {
      source: "intent_model",
      action: result.value.action,
      rationale: result.value.rationale,
    },
    consideredSignalRefs: result.value.consideredSignalRefs,
    model: config.model,
    durationMs: result.durationMs,
    turnsUsed: result.turnsUsed,
    sessionId: result.sessionId,
    truncatedFields: built.truncatedFields,
  };
}
