import { getClaudeSdkEnvironment } from "../../sdk/claude-auth.js";
import { getSdkPermissionOptions } from "../../sdk/permission-mode.js";
import type {
  IntentJudgmentRequest,
  IntentJudgmentRunnerErrorCode,
  IntentJudgmentRunResult,
} from "../judgment-types.js";
import type { ClaudeIntentJudgmentRunnerConfig } from "./intent-judgment-config.js";
import {
  INTENT_JUDGMENT_RESPONSE_SCHEMA,
  INTENT_JUDGMENT_SYSTEM_PROMPT,
  buildIntentJudgmentPrompt,
  parseIntentJudgmentResponse,
} from "./intent-judgment-prompt.js";

interface ContentBlock {
  type: string;
  text?: string;
}

interface SDKMessage {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  [key: string]: unknown;
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

let queryFnOverride: QueryFn | undefined;

async function getQueryFn(): Promise<QueryFn> {
  if (queryFnOverride) return queryFnOverride;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
}

export function _setIntentJudgmentQueryFn(fn: QueryFn | undefined): void {
  queryFnOverride = fn;
}

function boundedMessage(message: string, maxChars = 500): string {
  return message.length <= maxChars ? message : `${message.slice(0, maxChars - 14)}...[truncated]`;
}

function errorResult(
  config: ClaudeIntentJudgmentRunnerConfig,
  startedAt: number,
  truncatedFields: string[],
  errorCode: IntentJudgmentRunnerErrorCode,
  message: string,
  sessionId?: string,
): IntentJudgmentRunResult {
  return {
    status: "runner_error",
    errorCode,
    message: boundedMessage(message),
    model: config.model,
    durationMs: Date.now() - startedAt,
    ...(sessionId ? { sessionId } : {}),
    truncatedFields,
  };
}

export async function runClaudeIntentJudgment(
  request: IntentJudgmentRequest,
  config: ClaudeIntentJudgmentRunnerConfig,
): Promise<IntentJudgmentRunResult> {
  const startedAt = Date.now();
  let truncatedFields: string[] = [];
  let sessionId: string | undefined;

  try {
    const built = buildIntentJudgmentPrompt(request);
    truncatedFields = built.truncatedFields;
    const queryFn = await getQueryFn();
    const abortController = new AbortController();
    const queryResult = queryFn({
      prompt: built.prompt,
      options: {
        model: config.model,
        maxTurns: config.maxTurns,
        systemPrompt: INTENT_JUDGMENT_SYSTEM_PROMPT,
        tools: [],
        allowedTools: [],
        disallowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"],
        outputFormat: {
          type: "json_schema",
          schema: INTENT_JUDGMENT_RESPONSE_SCHEMA,
        },
        abortController,
        ...getSdkPermissionOptions(),
        env: getClaudeSdkEnvironment(),
      },
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutToken = Symbol("intent-judgment-timeout");
    const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
      timeoutTimer = setTimeout(() => {
        abortController.abort();
        resolve(timeoutToken);
      }, config.timeoutMs);
      timeoutTimer.unref?.();
    });

    let structuredOutput: unknown;
    let resultText = "";
    let sawResult = false;
    let sdkError: { subtype: string; errorCount: number } | undefined;
    let costUsd: number | undefined;
    let turnsUsed: number | undefined;

    const iterate = async (): Promise<void> => {
      for await (const message of queryResult) {
        const messageSessionId = message.session_id;
        if (typeof messageSessionId === "string") sessionId = messageSessionId;

        if (message.type !== "result") continue;
        sawResult = true;
        const record = message as Record<string, unknown>;
        if (typeof record.total_cost_usd === "number") {
          costUsd = record.total_cost_usd;
        }
        if (typeof record.num_turns === "number") {
          turnsUsed = record.num_turns;
        }
        if (message.subtype === "success") {
          structuredOutput = record.structured_output;
          if (typeof record.result === "string") resultText = record.result;
        } else {
          sdkError = {
            subtype: message.subtype ?? "unknown",
            errorCount: Array.isArray(record.errors) ? record.errors.length : 0,
          };
        }
        break;
      }
    };

    const iterationPromise = iterate();
    iterationPromise.catch(() => undefined);
    const raced = await Promise.race([iterationPromise, timeoutPromise]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    if (raced === timeoutToken) {
      return errorResult(
        config,
        startedAt,
        truncatedFields,
        "timeout",
        `Intent judgment exceeded ${config.timeoutMs}ms`,
        sessionId,
      );
    }

    if (sdkError) {
      return errorResult(
        config,
        startedAt,
        truncatedFields,
        "sdk_error",
        `SDK result subtype "${sdkError.subtype}" reported ${sdkError.errorCount} error(s)`,
        sessionId,
      );
    }

    if (!sawResult) {
      return errorResult(
        config,
        startedAt,
        truncatedFields,
        "no_result",
        "Intent judgment session ended without a result message",
        sessionId,
      );
    }

    const parsed = parseIntentJudgmentResponse(
      structuredOutput ?? resultText,
      request.signals.map((signal) => signal.ref),
    );
    if (!parsed) {
      return errorResult(
        config,
        startedAt,
        truncatedFields,
        "invalid_output",
        "Intent judgment result did not match the strict response contract",
        sessionId,
      );
    }

    return {
      status: "completed",
      judgment: {
        source: "intent_model",
        action: parsed.action,
        rationale: parsed.rationale,
      },
      consideredSignalRefs: parsed.consideredSignalRefs,
      model: config.model,
      durationMs: Date.now() - startedAt,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(turnsUsed !== undefined ? { turnsUsed } : {}),
      ...(sessionId ? { sessionId } : {}),
      truncatedFields,
    };
  } catch (error: unknown) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return errorResult(
      config,
      startedAt,
      truncatedFields,
      aborted ? "aborted" : "sdk_error",
      aborted
        ? "Intent judgment session was aborted"
        : `Intent judgment SDK failed: ${error instanceof Error ? error.name : "unknown_error"}`,
      sessionId,
    );
  }
}
