import type {
  JudgeVerdict,
  JudgeResult,
  CriterionEvaluation,
  FollowUpItem,
} from "../core/types.js";

/**
 * Raw criterion evaluation from LLM response (snake_case).
 */
interface RawCriterionEvaluation {
  criterion: string;
  status: string;
  evidence: string;
  reasoning: string;
  enforcement_type: string;
}

/**
 * Raw follow-up item from LLM response (snake_case).
 */
interface RawFollowUpItem {
  title: string;
  description: string;
  type: string;
  estimated_effort?: string;
}

/**
 * Shape of the raw JSON response expected from the LLM judge.
 * Uses snake_case field names as returned by the LLM, which are then
 * mapped to the camelCase JudgeResult interface.
 */
export interface RawJudgeResponse {
  verdict: string;
  confidence: number;
  scope_violations: string[];
  criteria_gaps: string[];
  quality_issues: string[];
  feedback: string;
  criteria_evaluation?: RawCriterionEvaluation[];
  follow_up_items?: RawFollowUpItem[];
}

/**
 * JSON Schema for structured output, matching the expected RawJudgeResponse shape.
 * Used with the SDK's outputFormat option to ensure well-formed JSON responses.
 */
export const JUDGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["APPROVE", "REVISE", "REJECT"],
    },
    confidence: { type: "number" },
    scope_violations: {
      type: "array",
      items: { type: "string" },
    },
    criteria_gaps: {
      type: "array",
      items: { type: "string" },
    },
    quality_issues: {
      type: "array",
      items: { type: "string" },
    },
    feedback: { type: "string" },
    criteria_evaluation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          status: {
            type: "string",
            enum: ["PASS", "FAIL", "PARTIAL"],
          },
          evidence: { type: "string" },
          reasoning: { type: "string" },
          enforcement_type: {
            type: "string",
            enum: ["deterministic_code", "llm_instruction_only", "not_implemented"],
          },
        },
        required: ["criterion", "status", "evidence", "reasoning", "enforcement_type"],
        additionalProperties: false,
      },
    },
    follow_up_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          type: {
            type: "string",
            enum: ["optimization", "edge_case", "testing", "refactoring", "scope_gap"],
          },
          estimated_effort: {
            type: "string",
            enum: ["1-2 hours", "2-3 hours", "3-4 hours", "4-6 hours"],
          },
        },
        required: ["title", "description", "type"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "verdict",
    "confidence",
    "scope_violations",
    "criteria_gaps",
    "quality_issues",
    "feedback",
  ],
  additionalProperties: false,
};

/** Valid verdict values */
const VALID_VERDICTS: ReadonlySet<string> = new Set(["APPROVE", "REVISE", "REJECT"]);

/**
 * Parses the raw JSON string from the LLM response and maps it
 * to the JudgeResult interface.
 *
 * Validates that:
 * - JSON is well-formed
 * - verdict is one of APPROVE, REVISE, REJECT
 * - confidence is a number between 0 and 1
 * - required array fields exist (defaults to empty arrays if missing)
 * - feedback is a string (defaults to empty string if missing)
 * - criteria_evaluation entries have valid status and enforcement_type
 *
 * Backward compatibility: If criteria_evaluation is missing but criteria_gaps
 * exists, the old format is still accepted.
 *
 * @param resultText - The raw JSON string from the LLM
 * @returns The mapped JudgeResult
 * @throws Error if the JSON is malformed or verdict is invalid
 */
export function parseJudgeResponse(resultText: string): JudgeResult {
  let raw: RawJudgeResponse;

  try {
    raw = JSON.parse(resultText) as RawJudgeResponse;
  } catch {
    throw new Error(`Failed to parse judge response as JSON: ${resultText}`);
  }

  // Validate verdict
  if (!raw.verdict || !VALID_VERDICTS.has(raw.verdict)) {
    throw new Error(
      `Invalid judge verdict: "${String(raw.verdict)}". Must be one of: APPROVE, REVISE, REJECT`,
    );
  }

  // Validate confidence
  if (raw.confidence === undefined || typeof raw.confidence !== "number") {
    throw new Error("Judge response missing required confidence field");
  }

  // Clamp confidence to [0, 1]
  const confidence = Math.max(0, Math.min(1, raw.confidence));

  // Parse criteria_evaluation if present
  let criteriaEvaluation: CriterionEvaluation[] | undefined;
  if (raw.criteria_evaluation) {
    const validStatuses = new Set(["PASS", "FAIL", "PARTIAL"]);
    const validEnforcementTypes = new Set([
      "deterministic_code",
      "llm_instruction_only",
      "not_implemented",
    ]);

    criteriaEvaluation = raw.criteria_evaluation.map((rawEval) => {
      if (!validStatuses.has(rawEval.status)) {
        throw new Error(
          `Invalid criterion status: "${rawEval.status}". Must be one of: PASS, FAIL, PARTIAL`,
        );
      }
      if (!validEnforcementTypes.has(rawEval.enforcement_type)) {
        throw new Error(
          `Invalid enforcement_type: "${rawEval.enforcement_type}". Must be one of: deterministic_code, llm_instruction_only, not_implemented`,
        );
      }

      return {
        criterion: rawEval.criterion,
        status: rawEval.status as "PASS" | "FAIL" | "PARTIAL",
        evidence: rawEval.evidence,
        reasoning: rawEval.reasoning,
        enforcement_type: rawEval.enforcement_type as
          | "deterministic_code"
          | "llm_instruction_only"
          | "not_implemented",
      };
    });

    // Auto-derive criteria_gaps from criteria_evaluation for backward compatibility
    if (!raw.criteria_gaps || raw.criteria_gaps.length === 0) {
      raw.criteria_gaps = criteriaEvaluation
        .filter((e) => e.status !== "PASS")
        .map((e) => e.criterion);
    }
  } else if (raw.criteria_gaps && raw.criteria_gaps.length > 0) {
    // Backward compatibility: map old criteria_gaps to new criteriaEvaluation format
    criteriaEvaluation = raw.criteria_gaps.map((gap) => ({
      criterion: gap,
      status: "PARTIAL" as const,
      evidence: "unknown",
      reasoning: "Legacy format - no details available",
      enforcement_type: "not_implemented" as const,
    }));
  }

  // Parse follow_up_items if present (only meaningful on APPROVE)
  let followUpItems: FollowUpItem[] | undefined;
  if (raw.follow_up_items && raw.follow_up_items.length > 0) {
    const validTypes = new Set([
      "optimization",
      "edge_case",
      "testing",
      "refactoring",
      "scope_gap",
    ]);
    const validEfforts = new Set(["1-2 hours", "2-3 hours", "3-4 hours", "4-6 hours"]);

    followUpItems = raw.follow_up_items
      .filter((item) => item.title && item.description && validTypes.has(item.type))
      .map((item) => ({
        title: item.title,
        description: item.description,
        type: item.type as FollowUpItem["type"],
        estimatedEffort:
          item.estimated_effort && validEfforts.has(item.estimated_effort)
            ? (item.estimated_effort as FollowUpItem["estimatedEffort"])
            : undefined,
      }));

    // Don't set to empty array — keep undefined if no valid items
    if (followUpItems.length === 0) followUpItems = undefined;
  }

  return {
    verdict: raw.verdict as JudgeVerdict,
    confidence,
    scopeViolations: raw.scope_violations ?? [],
    criteriaGaps: raw.criteria_gaps ?? [],
    qualityIssues: raw.quality_issues ?? [],
    feedback: raw.feedback ?? "",
    criteriaEvaluation,
    followUpItems,
  };
}
