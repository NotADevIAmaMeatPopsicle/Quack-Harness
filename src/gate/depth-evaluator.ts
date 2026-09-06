import { BatchConfig, DepthEvalResult, DepthScores, ParsedTask, TaskType } from "../core/types.js";
import { BatchClient, BatchRequest, DEFAULT_BATCH_CONFIG } from "../core/batch-client.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import {
  buildDepthResponseSchema,
  createEmptyDepthScores,
  getTaskTypeDepthConfig,
} from "./depth-dimensions.js";
import { buildDepthPrompt } from "./depth-prompt.js";
import { detectTaskType } from "./task-type-detector.js";

interface RawDepthResponse {
  ready: boolean;
  overall_score: number;
  scores: Record<string, number | undefined>;
  deficiencies: string[];
  enrichment_suggestions: string[];
}

interface SDKMessage {
  type: string;
  subtype?: string;
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

let _queryFn: QueryFn | undefined;

async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function evaluateTaskDepth(
  task: ParsedTask,
  conventionsSummary: string,
  options?: { model?: string; maxTurns?: number },
): Promise<DepthEvalResult> {
  const taskType = detectTaskType(task);
  const prompt = buildDepthPrompt(task, conventionsSummary);
  const model = options?.model ?? DEFAULT_MODEL;
  const maxTurns = options?.maxTurns ?? 5;
  const errors: Error[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callDepthEvaluation(prompt, model, taskType, maxTurns);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const errorDetails = errors
    .map((error, index) => `Attempt ${index + 1}: ${error.message}`)
    .join("\n\n");

  throw new Error(`Depth evaluation failed after ${errors.length} attempts:\n${errorDetails}`);
}

let SDK_TIMEOUT_MS = 90_000;

export function _setSdkTimeoutMs(ms: number | undefined): void {
  SDK_TIMEOUT_MS = ms ?? 90_000;
}

async function callDepthEvaluation(
  prompt: string,
  model: string,
  taskType: TaskType,
  maxTurns = 5,
): Promise<DepthEvalResult> {
  const queryFn = await getQueryFn();
  const messages: Array<{ type: string; subtype?: string; [key: string]: unknown }> = [];

  const queryResult = queryFn({
    prompt,
    options: {
      model,
      maxTurns,
      tools: [],
      ...getSdkPermissionOptions(),
      outputFormat: {
        type: "json_schema",
        schema: buildDepthResponseSchema(taskType),
      },
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Depth evaluation timed out after ${SDK_TIMEOUT_MS / 1000}s - SDK subprocess did not respond`,
          ),
        ),
      SDK_TIMEOUT_MS,
    );
    timer.unref();
  });

  const iterateGenerator = async (): Promise<DepthEvalResult> => {
    let assistantCount = 0;
    const maxAssistantMessages = 10;

    for await (const message of queryResult) {
      messages.push({ ...message } as { type: string; subtype?: string; [key: string]: unknown });

      if (message.type === "assistant") {
        assistantCount++;
        if (assistantCount > maxAssistantMessages) {
          const lastAssistant = messages.filter((entry) => entry.type === "assistant").pop();
          const lastContent =
            typeof lastAssistant?.result === "string"
              ? lastAssistant.result.slice(0, 500)
              : JSON.stringify(lastAssistant).slice(0, 500);

          throw new Error(
            `Depth evaluation stuck in structured output retry loop ` +
              `(${assistantCount} assistant messages without result).\n` +
              `This usually means the model cannot produce valid JSON - ` +
              `common causes: billing/credit limits, rate limiting, or service issues.\n` +
              `Last assistant response: ${lastContent}`,
          );
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          const successMessage = message as unknown as {
            result: string;
            structured_output?: unknown;
          };
          if (
            successMessage.structured_output !== undefined &&
            successMessage.structured_output !== null
          ) {
            return parseDepthResponse(JSON.stringify(successMessage.structured_output), taskType);
          }
          return parseDepthResponse(successMessage.result, taskType);
        }

        const errorMessage = message as unknown as {
          subtype: string;
          errors?: string[];
          total_cost_usd?: number;
          num_turns?: number;
          stop_reason?: string | null;
        };
        throw new Error(
          `Depth evaluation SDK error: ${errorMessage.subtype}\n` +
            `Errors: ${JSON.stringify(errorMessage.errors ?? [])}\n` +
            `Stop reason: ${errorMessage.stop_reason ?? "none"}\n` +
            `Cost: $${errorMessage.total_cost_usd ?? 0}, Turns: ${errorMessage.num_turns ?? 0}`,
        );
      }
    }

    const messageLog = messages
      .map((entry, index) => {
        const summary: Record<string, unknown> = {
          type: entry.type,
          subtype: entry.subtype,
        };
        if (entry.type === "result") {
          summary.result =
            typeof entry.result === "string" ? entry.result.slice(0, 500) : entry.result;
          summary.error = entry.error;
          summary.total_cost_usd = entry.total_cost_usd;
          summary.num_turns = entry.num_turns;
        }
        return `  [${index}] ${JSON.stringify(summary)}`;
      })
      .join("\n");

    throw new Error(
      `Depth evaluation returned no success result.\n` +
        `Model: ${model}\n` +
        `Messages received (${messages.length}):\n${messageLog || "  (none)"}\n` +
        `Prompt length: ${prompt.length} chars`,
    );
  };

  return Promise.race([iterateGenerator(), timeoutPromise]);
}

function parseDepthResponse(resultText: string, taskType: TaskType): DepthEvalResult {
  let raw: RawDepthResponse;

  try {
    raw = JSON.parse(resultText) as RawDepthResponse;
  } catch {
    throw new Error(`Failed to parse depth evaluation response as JSON: ${resultText}`);
  }

  if (
    typeof raw.overall_score !== "number" ||
    raw.scores === undefined ||
    raw.scores === null ||
    typeof raw.scores !== "object"
  ) {
    throw new Error("Depth evaluation response missing required score fields");
  }

  const config = getTaskTypeDepthConfig(taskType);
  const scores: DepthScores = {};
  const missingRequiredFields = config.dimensions
    .filter((dimension) => !dimension.optional)
    .filter((dimension) => typeof raw.scores[dimension.rawKey] !== "number")
    .map((dimension) => dimension.rawKey);

  if (missingRequiredFields.length > 0) {
    throw new Error(
      `Depth evaluation response missing required score fields: ${missingRequiredFields.join(", ")}`,
    );
  }

  const lowDimensionAdvisories: string[] = [];

  for (const dimension of config.dimensions) {
    const rawValue = raw.scores[dimension.rawKey];
    const fallbackValue =
      dimension.fallbackRawKey !== undefined ? raw.scores[dimension.fallbackRawKey] : undefined;
    const mappedValue =
      typeof rawValue === "number"
        ? rawValue
        : typeof fallbackValue === "number"
          ? fallbackValue
          : undefined;

    if (mappedValue !== undefined) {
      scores[dimension.resultKey] = mappedValue;
      if (mappedValue < 2) {
        lowDimensionAdvisories.push(
          `ADVISORY: dimension "${dimension.label}" scored ${mappedValue} (< 2) — ${dimension.rubric.low}`,
        );
      }
    }
  }

  // A low sub-score informs but no longer vetoes: readiness is the overall
  // threshold alone (TASK-1300 / v2 P0-4). The "ADVISORY:" prefix is a
  // contract — these lines must never match the gate's "BLOCKING" filter.
  return {
    taskType,
    threshold: config.threshold,
    ready: raw.overall_score >= config.threshold,
    overallScore: raw.overall_score,
    scores,
    deficiencies: [...lowDimensionAdvisories, ...(raw.deficiencies ?? [])],
    enrichmentSuggestions: raw.enrichment_suggestions ?? [],
  };
}

function createFailedDepthEvalResult(taskType: TaskType, message: string): DepthEvalResult {
  const config = getTaskTypeDepthConfig(taskType);
  return {
    taskType,
    threshold: config.threshold,
    ready: false,
    overallScore: 0,
    scores: createEmptyDepthScores(taskType),
    deficiencies: [message],
    enrichmentSuggestions: [],
  };
}

export async function batchEvaluateTaskDepth(
  tasks: Array<{ task: ParsedTask; conventionsSummary: string }>,
  options?: { model?: string },
  batchConfig?: BatchConfig,
): Promise<Map<string, DepthEvalResult>> {
  const config = batchConfig ?? DEFAULT_BATCH_CONFIG;
  const model = options?.model ?? DEFAULT_MODEL;
  const results = new Map<string, DepthEvalResult>();

  if (!config.enabled || tasks.length < config.minBatchSize) {
    for (const { task, conventionsSummary } of tasks) {
      const result = await evaluateTaskDepth(task, conventionsSummary, options);
      results.set(task.id, result);
    }
    return results;
  }

  const taskTypeById = new Map(tasks.map(({ task }) => [task.id, detectTaskType(task)]));

  const batchRequests: BatchRequest[] = tasks.map(({ task, conventionsSummary }) => {
    const taskType = taskTypeById.get(task.id) ?? TaskType.Code;
    return {
      id: task.id,
      model,
      systemPrompt:
        "You are evaluating whether a task specification is detailed enough for a background coding agent to execute without human guidance during execution. Respond ONLY with a valid JSON object.",
      userMessage: buildDepthPrompt(task, conventionsSummary),
      maxTokens: 1024,
      outputFormat: buildDepthResponseSchema(taskType),
    };
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required for batch evaluation");
  }

  const client = new BatchClient(apiKey, config);
  const batchResults = await client.submitAndWait(batchRequests, config.pollIntervalMs);

  for (const batchResult of batchResults) {
    const taskType = taskTypeById.get(batchResult.id) ?? TaskType.Code;

    if (batchResult.status === "success" && batchResult.response) {
      try {
        const responseText =
          typeof batchResult.response === "string"
            ? batchResult.response
            : JSON.stringify(batchResult.response);
        results.set(batchResult.id, parseDepthResponse(responseText, taskType));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        results.set(
          batchResult.id,
          createFailedDepthEvalResult(taskType, `Batch result parse error: ${message}`),
        );
      }
    } else {
      results.set(
        batchResult.id,
        createFailedDepthEvalResult(
          taskType,
          `Batch evaluation failed: ${batchResult.error ?? "unknown error"}`,
        ),
      );
    }
  }

  return results;
}
