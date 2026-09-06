// ─── Spec Ambiguity Reviewer ───────────────────────────────────────
// Fast LLM pass (Haiku by default) that evaluates task specs for ambiguity.
// Runs between gate and blueprint in the preflight pipeline.
// Uses structured JSON output — no agent session needed, just a single SDK
// query() call with outputFormat.
//
// Orthogonal to depth evaluation: depth checks "how much detail",
// this checks "how unambiguous".

import type { ParsedTask } from "../core/types.js";
import type { SpecReviewResult, AmbiguityFinding } from "./spec-review-types.js";
import { buildSpecReviewPrompt } from "./spec-reviewer-prompt.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";

/**
 * Minimal SDK message shape for the async generator.
 * Defined locally to avoid ESM/CJS import issues with the SDK package.
 */
interface SDKMessage {
  type: string;
  subtype?: string;
}

/**
 * Type for the SDK query function, defined locally to avoid importing
 * ESM-only SDK types from a CommonJS module context.
 */
type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 * Populated on first call via dynamic import() since the SDK is ESM-only.
 */
let _queryFn: QueryFn | undefined;

/**
 * Dynamically imports the Claude Agent SDK's query function.
 * Required because the SDK is an ES module and this project uses CommonJS.
 */
async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 * @param fn - The replacement query function, or undefined to reset
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

/**
 * JSON Schema for structured output, matching the expected response shape.
 * Used with the SDK's outputFormat option to ensure well-formed JSON responses.
 */
const SPEC_REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterionIndex: { type: "number" },
          criterionText: { type: "string" },
          dimension: {
            type: "string",
            enum: [
              "criterion_ambiguity",
              "interface_gap",
              "file_mapping",
              "visual_ambiguity",
              "ownership_ambiguity",
              "integration_gap",
            ],
          },
          explanation: { type: "string" },
          clarificationQuestion: { type: "string" },
          severity: { type: "string", enum: ["high", "medium"] },
        },
        required: [
          "criterionIndex",
          "criterionText",
          "dimension",
          "explanation",
          "clarificationQuestion",
          "severity",
        ],
        additionalProperties: false,
      },
    },
    suggestedClarifications: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["findings", "suggestedClarifications"],
  additionalProperties: false,
};

/** Default model for spec review — Haiku is cost-effective for pattern-matching */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Review a task specification for ambiguous language that could lead to
 * agent misimplementation.
 *
 * This is a fast LLM pass (Haiku by default) that runs between gate and
 * blueprint in the preflight pipeline. It checks 6 ambiguity dimensions:
 * criterion ambiguity, interface gaps, file mapping, visual/behavioral
 * ambiguity, ownership ambiguity, and integration gaps.
 *
 * Risk level is calculated deterministically AFTER parsing the LLM response:
 * - high: any finding with severity='high', OR 3+ total findings
 * - medium: 1-2 findings, all severity='medium'
 * - low: 0 findings
 *
 * @param task - The parsed task to evaluate
 * @param options - Optional configuration (model override)
 * @returns The spec review result with findings and risk level
 * @throws Error if the SDK call fails
 */
/** Default timeout for SDK spec review calls (120 seconds — longer than depth eval due to maxTurns: 8) */
const SDK_TIMEOUT_MS = 120_000;

export async function reviewSpecAmbiguity(
  task: ParsedTask,
  options?: { model?: string },
): Promise<SpecReviewResult> {
  const prompt = buildSpecReviewPrompt(task);
  const model = options?.model ?? DEFAULT_MODEL;

  const queryFn = await getQueryFn();

  const queryResult = queryFn({
    prompt,
    options: {
      model,
      maxTurns: 8,
      tools: [],
      ...getSdkPermissionOptions(),
      outputFormat: {
        type: "json_schema",
        schema: SPEC_REVIEW_SCHEMA,
      },
    },
  });

  // Race the SDK generator against a timeout to prevent indefinite hangs.
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Spec review timed out after ${SDK_TIMEOUT_MS / 1000}s — SDK subprocess did not respond`,
          ),
        ),
      SDK_TIMEOUT_MS,
    );
    timer.unref(); // Don't prevent process exit (Jest compatibility)
  });

  const iterateGenerator = async (): Promise<SpecReviewResult> => {
    // Track rapid assistant→user cycles that indicate structured output retry loops.
    // When the model returns non-JSON (e.g., billing errors like "Credit balance is too low"),
    // the SDK auto-retries by injecting correction messages, creating an infinite loop.
    let assistantCount = 0;
    const MAX_ASSISTANT_MESSAGES = 10;

    for await (const message of queryResult) {
      if (message.type === "assistant") {
        assistantCount++;
        if (assistantCount > MAX_ASSISTANT_MESSAGES) {
          throw new Error(
            `Spec review stuck in structured output retry loop ` +
              `(${assistantCount} assistant messages without result).\n` +
              `This usually means the model cannot produce valid JSON — ` +
              `common causes: billing/credit limits, rate limiting, or service issues.`,
          );
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          // When outputFormat is used, structured_output has the parsed JSON.
          const successMsg = message as unknown as {
            result: string;
            structured_output?: unknown;
          };
          if (successMsg.structured_output !== undefined && successMsg.structured_output !== null) {
            return parseSpecReviewResponse(JSON.stringify(successMsg.structured_output));
          }
          return parseSpecReviewResponse(successMsg.result);
        }

        // Handle SDK error results
        const errMsg = message as unknown as {
          subtype: string;
          errors?: string[];
          total_cost_usd?: number;
          num_turns?: number;
          stop_reason?: string | null;
        };
        throw new Error(
          `Spec review SDK error: ${errMsg.subtype}\n` +
            `Errors: ${JSON.stringify(errMsg.errors ?? [])}\n` +
            `Stop reason: ${errMsg.stop_reason ?? "none"}\n` +
            `Cost: $${errMsg.total_cost_usd ?? 0}, Turns: ${errMsg.num_turns ?? 0}`,
        );
      }
    }

    throw new Error("Spec review returned no success result");
  };

  return Promise.race([iterateGenerator(), timeoutPromise]);
}

/**
 * Parse the raw JSON string from the LLM response and calculate risk level.
 *
 * Risk level is calculated deterministically (NOT by the LLM):
 * - high: any finding with severity='high', OR 3+ total findings
 * - medium: 1-2 findings, all severity='medium'
 * - low: 0 findings
 *
 * @param resultText - The raw JSON string from the LLM
 * @returns The mapped SpecReviewResult with risk level
 * @throws Error if the JSON is malformed or missing required fields
 */
function parseSpecReviewResponse(resultText: string): SpecReviewResult {
  let raw: {
    findings: AmbiguityFinding[];
    suggestedClarifications: string[];
  };

  try {
    raw = JSON.parse(resultText) as {
      findings: AmbiguityFinding[];
      suggestedClarifications: string[];
    };
  } catch {
    throw new Error(`Failed to parse spec review response as JSON: ${resultText}`);
  }

  // Validate required fields exist
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.suggestedClarifications)) {
    throw new Error("Spec review response missing required fields");
  }

  const findings = raw.findings;
  const ambiguityCount = findings.length;
  const riskLevel = calculateRiskLevel(findings);

  return {
    ambiguityCount,
    riskLevel,
    findings,
    suggestedClarifications: raw.suggestedClarifications,
  };
}

/**
 * Calculate risk level deterministically from findings.
 *
 * @param findings - The array of ambiguity findings
 * @returns Risk level: high, medium, or low
 */
function calculateRiskLevel(findings: AmbiguityFinding[]): "low" | "medium" | "high" {
  if (findings.length === 0) return "low";
  if (findings.some((f) => f.severity === "high") || findings.length >= 3) return "high";
  return "medium";
}
