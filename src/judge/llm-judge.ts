import { getClaudeSdkEnvironment, type ClaudeApiKeys } from "../sdk/claude-auth.js";
// ─── LLM-as-Judge ──────────────────────────────────────────────────
// Evaluates agent-produced changes against the original task spec.
// Uses a separate Claude Agent SDK session with read-only codebase
// access. Returns a structured JudgeResult with verdict, confidence,
// scope violations, criteria gaps, quality issues, and feedback.
//
// Uses the same ESM dynamic import pattern as depth-evaluator.ts and
// enrichment-agent.ts for the Claude Agent SDK (ESM-only package).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type {
  JudgeResult,
  VerificationResult,
  ParsedTask,
  BatchConfig,
  DeterministicCheck,
} from "../core/types.js";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "./judge-prompt.js";
import { parseJudgeResponse } from "./verdict.js";
import { JUDGE_RESPONSE_SCHEMA } from "./verdict.js";
import { applyEnforcementConstraints } from "./enforcement-constraints.js";
import { projectJudgeDecision } from "../judgment/judgment-adapters.js";
import { containJudgmentProjection } from "../judgment/judgment-events.js";
import type {
  JudgeJudgmentTraceEntry,
  JudgmentProjectionFailure,
  JudgmentSignal,
} from "../judgment/judgment-types.js";
import { runSpecComplianceChecks } from "./spec-compliance.js";
import { BatchClient, BatchRequest, DEFAULT_BATCH_CONFIG } from "../core/batch-client.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { runCodexStructuredEvaluation } from "../llm/codex-structured-evaluator.js";

// ─── SDK type shims ─────────────────────────────────────────────────
// Defined locally to avoid ESM/CJS import issues with the SDK package.

/** Content block within a BetaMessage */
interface ContentBlock {
  type: string;
  text?: string;
}

interface SDKSuccessResult {
  type: "result";
  subtype: "success";
  result: string;
}

interface SDKMessage {
  type: string;
  subtype?: string;
  /** SDKAssistantMessage wraps a BetaMessage with structured content blocks */
  message?: { content?: ContentBlock[] | string };
  [key: string]: unknown;
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

// ─── Lazy SDK loading ───────────────────────────────────────────────

let _queryFn: QueryFn | undefined;

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

// ─── Constants ──────────────────────────────────────────────────────

/** Default model for judge evaluation -- Sonnet is cost-effective for evaluation tasks */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Maximum turns for judge session — needs enough room to read files before rendering verdict.
 *  Raised from 15 to 30: large diffs (8+ files) were exhausting the budget before producing a verdict. */
const JUDGE_MAX_TURNS = 30;

// ─── Judge input ────────────────────────────────────────────────────

/**
 * Input data required to run the LLM-as-Judge evaluation.
 */
export interface JudgeInput {
  /** Full content of the TASK-*.md file */
  taskSpec: string;
  /** Git diff of all changes made by the agent */
  gitDiff: string;
  /** Verification results from the deterministic checks */
  verificationResults: VerificationResult;
  /** Parsed task (for extracting success criteria for compliance checks) */
  task?: ParsedTask;
  /** Changed file paths (for compliance checks) */
  changedFiles?: string[];
  /** Compact summary of recent BACKLOG/READY tasks for follow-up dedup */
  recentBacklogSummary?: string;
  /**
   * Pre-dispatch spec-review output (loaded from preflight cache by the
   * dispatcher when contentHash matches current task). TASK-894: surfaced
   * to the judge as informational context so it can give the worker the
   * benefit of any reasonable interpretation on criteria flagged ambiguous
   * BEFORE dispatch.
   */
  specReview?: {
    riskLevel: "low" | "medium" | "high";
    findings: Array<{
      criterionIndex: number;
      criterionText?: string;
      dimension: string;
      severity: "high" | "medium" | "low";
      explanation: string;
      suggestedClarification?: string;
    }>;
  };
}

// ─── Main judge function ────────────────────────────────────────────

/**
 * Runs the LLM-as-Judge evaluation on agent-produced changes.
 *
 * This is Layer 2 of the verification pipeline (Honk pattern).
 * After the agent passes deterministic verification (Layer 1),
 * the judge evaluates the git diff against the original task spec
 * for scope violations, uncovered success criteria, and quality issues.
 *
 * The judge has READ-ONLY codebase access (Read, Glob, Grep) so it
 * can verify claims about existing code patterns without modifying
 * the codebase.
 *
 * @param input - The judge input: task spec, git diff, verification results
 * @param adapter - The project adapter with config, criteria, and project root
 * @param options - Optional overrides for model and maxTurns
 * @returns Structured JudgeResult with verdict, confidence, and details
 * @throws Error if the SDK call fails after one retry
 */
export async function runJudge(
  input: JudgeInput,
  adapter: ProjectAdapter,
  options?: {
    model?: string;
    maxTurns?: number;
    blueprintChecks?: DeterministicCheck[];
    /** TASK-1313: producer-derived signals injected by the dispatcher. */
    injectedSignals?: JudgmentSignal[];
  },
): Promise<JudgeResult> {
  const evaluator = adapter.config.evaluationProviders?.judge;
  const model =
    options?.model ?? evaluator?.model ?? adapter.config.agent.judgeModel ?? DEFAULT_MODEL;
  const maxTurns = options?.maxTurns ?? JUDGE_MAX_TURNS;
  const verificationCommandRequirements = Object.fromEntries(
    adapter.config.verification.commands.map((command) => [
      command.name,
      command.required !== false,
    ]),
  );

  // Run pre-judge compliance checks if we have task and diff
  let complianceChecks = undefined;
  if (input.task && input.gitDiff) {
    // Merge adapter checks with blueprint-derived checks
    const allChecks = [
      ...(adapter.config.deterministicChecks ?? []),
      ...(options?.blueprintChecks ?? []),
    ];
    complianceChecks = await runSpecComplianceChecks(
      input.task,
      input.gitDiff,
      input.changedFiles ?? [],
      allChecks,
      adapter.projectRoot,
    );
  }

  // Build the evaluation prompt with universal + project-specific criteria + compliance
  const prompt = buildJudgePrompt({
    taskSpec: input.taskSpec,
    gitDiff: input.gitDiff,
    verificationResults: input.verificationResults,
    verificationCommandRequirements,
    judgeCriteria: adapter.judgeCriteria,
    complianceChecks,
    parsedTask: input.task,
    changedFiles: input.changedFiles,
    recentBacklogSummary: input.recentBacklogSummary,
    specReview: input.specReview,
  });

  let lastError: Error | undefined;

  // Attempt up to 2 times (initial + 1 retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawResult =
        evaluator?.runner === "codex-cli"
          ? await callCodexJudgeEvaluation(prompt, model, adapter.projectRoot, evaluator)
          : await callJudgeEvaluation(
              prompt,
              model,
              maxTurns,
              adapter.projectRoot,
              adapter.config.agent.apiKeys,
            );
      const judgmentTrace: JudgeJudgmentTraceEntry[] = [];
      let judgmentProjectionFailure: JudgmentProjectionFailure | undefined;
      const rawProjection = containJudgmentProjection(() =>
        projectJudgeDecision(rawResult, { phase: "raw", extraSignals: options?.injectedSignals }),
      );
      if (rawProjection.decision) {
        judgmentTrace.push({
          sequence: 0,
          phase: "raw",
          decision: rawProjection.decision,
        });
      } else {
        judgmentProjectionFailure = rawProjection.failure;
      }

      // Enforcement verdict constraints (TASK-1200) apply before path
      // validation so every return path below carries the constrained
      // statuses and demotion records.
      // TASK-1320: pass the spec's ordered criteria so a judge-supplied
      // criterionIndex can be corroborated against text the judge did not author.
      const result = applyEnforcementConstraints(
        rawResult,
        complianceChecks,
        input.task?.successCriteria,
      );
      const enforcementProjection = containJudgmentProjection(() =>
        projectJudgeDecision(result, {
          phase: "enforcement",
          extraSignals: options?.injectedSignals,
        }),
      );
      if (enforcementProjection.decision) {
        judgmentTrace.push({
          sequence: 1,
          phase: "enforcement",
          decision: enforcementProjection.decision,
        });
      } else {
        judgmentProjectionFailure ??= enforcementProjection.failure;
      }

      // Post-verdict path validation: detect hallucinated file paths.
      // Only override if we have a meaningful sample (>= 2 cited paths)
      // AND some valid paths exist (avoids false positives in test envs
      // where projectRoot is a temp dir with no source files).
      const pathAudit = validateVerdictPaths(result, adapter.projectRoot);
      const pathOverride =
        pathAudit.total >= 2 && pathAudit.valid.length > 0 && pathAudit.hallucinationRate > 0.3;
      if (pathOverride) {
        const hallucinatedList = pathAudit.hallucinated.join(", ");
        const overriddenResult: JudgeResult = {
          ...result,
          verdict: "REVISE",
          feedback: `[PATH VALIDATION OVERRIDE] Judge cited ${pathAudit.hallucinated.length}/${pathAudit.total} non-existent paths (${hallucinatedList}). Original verdict "${result.verdict}" overridden to REVISE. Re-evaluate with verified file reads. Original feedback: ${result.feedback}`,
          complianceChecks,
        };
        const pathProjection = containJudgmentProjection(() =>
          projectJudgeDecision(overriddenResult, {
            phase: "path_audit",
            pathAudit: { ...pathAudit, overridden: true },
            extraSignals: options?.injectedSignals,
          }),
        );
        if (pathProjection.decision) {
          judgmentTrace.push({
            sequence: 2,
            phase: "path_audit",
            decision: pathProjection.decision,
          });
        } else {
          judgmentProjectionFailure ??= pathProjection.failure;
        }
        return {
          ...overriddenResult,
          judgmentTrace,
          ...(pathProjection.decision ? { judgmentDecision: pathProjection.decision } : {}),
          ...(judgmentProjectionFailure ? { judgmentProjectionFailure } : {}),
        };
      }

      // Include compliance checks in the final result
      const pathProjection = containJudgmentProjection(() =>
        projectJudgeDecision(result, {
          phase: "path_audit",
          pathAudit: { ...pathAudit, overridden: false },
          extraSignals: options?.injectedSignals,
        }),
      );
      if (pathProjection.decision) {
        judgmentTrace.push({
          sequence: 2,
          phase: "path_audit",
          decision: pathProjection.decision,
        });
      } else {
        judgmentProjectionFailure ??= pathProjection.failure;
      }
      return {
        ...result,
        complianceChecks,
        judgmentTrace,
        ...(pathProjection.decision ? { judgmentDecision: pathProjection.decision } : {}),
        ...(judgmentProjectionFailure ? { judgmentProjectionFailure } : {}),
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Judge evaluation failed after retry: ${lastError?.message ?? "unknown error"}`);
}

async function callCodexJudgeEvaluation(
  prompt: string,
  model: string,
  projectRoot: string,
  config: NonNullable<ProjectAdapter["config"]["evaluationProviders"]>["judge"],
): Promise<JudgeResult> {
  if (!config) throw new Error("Codex judge provider is missing configuration");
  const result = await runCodexStructuredEvaluation(
    {
      projectRoot,
      model,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      prompt,
      outputSchema: JUDGE_RESPONSE_SCHEMA,
      parse: (rawText) => {
        try {
          return parseJudgeResponse(rawText);
        } catch {
          return null;
        }
      },
    },
    config,
  );
  if (result.status === "runner_error") {
    throw new Error(`Codex judge ${result.errorKind}: ${result.message}`);
  }
  return { ...result.value, claudeSessionId: result.sessionId };
}

/**
 * Attempts to extract a valid judge JSON response from text that may contain
 * markdown, prose, or multiple JSON-like blocks. Tries multiple strategies:
 * 1. Direct JSON.parse of the full text
 * 2. Extract from ```json code fences
 * 3. Find balanced brace blocks containing "verdict"
 */
function extractJudgeJson(text: string): JudgeResult | null {
  // Strategy 1: Direct parse
  try {
    return parseJudgeResponse(text);
  } catch {
    /* continue */
  }

  // Strategy 2: Extract from ```json code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return parseJudgeResponse(fenceMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  // Strategy 3: Find balanced JSON objects containing "verdict"
  // Walk through the text finding opening braces and try to parse balanced blocks
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    // Find the matching close brace by counting depth
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      if (depth === 0) break;
    }

    if (depth !== 0) continue;

    const candidate = text.slice(i, j + 1);
    if (!candidate.includes('"verdict"')) continue;

    try {
      return parseJudgeResponse(candidate);
    } catch {
      /* try next block */
    }
  }

  return null;
}

// ─── Post-verdict path validation ──────────────────────────────────

/** Regex to extract file paths from judge evidence/feedback text */
const FILE_PATH_REGEX =
  /(?:^|\s|`)((?:src|tests|test|lib|app|dist|docs|\.quack)\/[\w./-]+\.\w+)(?:[:\s`]|$)/g;

interface PathAuditResult {
  total: number;
  valid: string[];
  hallucinated: string[];
  hallucinationRate: number;
}

/**
 * Validates that file paths cited in the judge verdict actually exist on disk.
 * Extracts paths from criteria_evaluation evidence and feedback fields, checks
 * each with fs.existsSync(). Returns audit results.
 */
export function validateVerdictPaths(result: JudgeResult, projectRoot: string): PathAuditResult {
  const citedPaths = new Set<string>();

  // Extract paths from criteria evaluations
  if (result.criteriaEvaluation) {
    for (const crit of result.criteriaEvaluation) {
      if (crit.evidence) {
        for (const match of crit.evidence.matchAll(FILE_PATH_REGEX)) {
          citedPaths.add(match[1]);
        }
        // Also handle "file:line" format (e.g., "src/foo.ts:42")
        const fileLineMatches = crit.evidence.match(/(?:^|\s|`)([^\s`]+\.\w+):\d+/g);
        if (fileLineMatches) {
          for (const m of fileLineMatches) {
            const filePart = m.trim().replace(/^`/, "").replace(/:\d+$/, "");
            if (filePart.includes("/")) citedPaths.add(filePart);
          }
        }
      }
      if (crit.reasoning) {
        for (const match of crit.reasoning.matchAll(FILE_PATH_REGEX)) {
          citedPaths.add(match[1]);
        }
      }
    }
  }

  // Extract paths from scope violations
  for (const violation of result.scopeViolations) {
    for (const match of violation.matchAll(FILE_PATH_REGEX)) {
      citedPaths.add(match[1]);
    }
  }

  if (citedPaths.size === 0) {
    return { total: 0, valid: [], hallucinated: [], hallucinationRate: 0 };
  }

  const valid: string[] = [];
  const hallucinated: string[] = [];

  for (const p of citedPaths) {
    const fullPath = path.resolve(projectRoot, p);
    if (fs.existsSync(fullPath)) {
      valid.push(p);
    } else {
      hallucinated.push(p);
    }
  }

  return {
    total: citedPaths.size,
    valid,
    hallucinated,
    hallucinationRate: citedPaths.size > 0 ? hallucinated.length / citedPaths.size : 0,
  };
}

/**
 * Calls the Claude Agent SDK to perform the judge evaluation.
 * The judge session has:
 * - Read-only codebase access (Read, Glob, Grep allowed)
 * - Write tools disallowed (Edit, Write, Bash, WebSearch, WebFetch)
 * - Structured JSON output via outputFormat
 *
 * @param prompt - The fully assembled judge evaluation prompt
 * @param model - The model identifier to use
 * @param maxTurns - Maximum turns for the judge session
 * @param projectRoot - Absolute path to the project root
 * @returns The parsed JudgeResult
 * @throws Error if no result message is received or parsing fails
 */
async function callJudgeEvaluation(
  prompt: string,
  model: string,
  maxTurns: number,
  projectRoot: string,
  apiKeys?: ClaudeApiKeys,
): Promise<JudgeResult> {
  const queryFn = await getQueryFn();

  // Pass static judge instructions as system prompt for automatic caching
  // by the Agent SDK. The dynamic per-task content stays in the user prompt.
  const queryResult = queryFn({
    prompt,
    options: {
      model,
      maxTurns,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
      ...getSdkPermissionOptions(),
      env: getClaudeSdkEnvironment(apiKeys),
      cwd: projectRoot,
    },
  });

  let lastResultText = "";
  let claudeSessionId: string | undefined;
  const assistantMessages: string[] = [];

  for await (const message of queryResult) {
    // Capture Claude session ID from first message that carries it
    if (!claudeSessionId && typeof (message as Record<string, unknown>).session_id === "string") {
      claudeSessionId = (message as Record<string, unknown>).session_id as string;
    }

    // Collect assistant message content for JSON extraction fallback.
    // SDKAssistantMessage has { message: BetaMessage } where content
    // is an array of ContentBlocks, not a plain string.
    if (message.type === "assistant" && message.message) {
      const blocks = message.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            assistantMessages.push(block.text);
          }
        }
      } else if (typeof blocks === "string") {
        assistantMessages.push(blocks);
      }
    }

    if (message.type === "result" && message.subtype === "success") {
      lastResultText = (message as unknown as SDKSuccessResult).result;
    }
  }

  // Try parsing the SDK result first
  if (lastResultText) {
    try {
      const result = parseJudgeResponse(lastResultText);
      result.claudeSessionId = claudeSessionId;
      return result;
    } catch {
      // Fall through to extract JSON from assistant messages
    }
  }

  // Fallback: extract JSON from assistant messages (the judge may have
  // written its verdict as a JSON block in conversation rather than as
  // structured output)
  const allContent = assistantMessages.join("\n");
  const parsed = extractJudgeJson(allContent);
  if (parsed) {
    parsed.claudeSessionId = claudeSessionId;
    return parsed;
  }

  // Last resort: try the SDK result text through the same extraction
  if (lastResultText) {
    const fromResult = extractJudgeJson(lastResultText);
    if (fromResult) {
      fromResult.claudeSessionId = claudeSessionId;
      return fromResult;
    }
  }

  throw new Error(
    `Judge evaluation returned no parseable result. SDK result: "${lastResultText.slice(0, 200)}"`,
  );
}

// ─── Batch Judge Evaluation ──────────────────────────────────────────

/**
 * Evaluate multiple judge inputs in batch via the Anthropic Batch API
 * (50% cost discount). Falls back to sequential runJudge calls if batch
 * is disabled or the number of inputs is below minBatchSize.
 *
 * Note: Batch judge evaluation does NOT have read-only codebase access
 * (no Read/Glob/Grep tools) since the Batch API is a direct Messages API
 * call, not an Agent SDK session. The judge prompt must contain all
 * necessary context (task spec, git diff, verification results).
 *
 * @param inputs - Array of judge inputs
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional model override
 * @param batchConfig - Batch processing configuration
 * @returns Map from task spec (first 20 chars) or index to JudgeResult
 */
export async function batchJudge(
  inputs: JudgeInput[],
  adapter: ProjectAdapter,
  options?: { model?: string },
  batchConfig?: BatchConfig,
): Promise<Map<string, JudgeResult>> {
  const config = batchConfig ?? DEFAULT_BATCH_CONFIG;
  const model = options?.model ?? adapter.config.agent.judgeModel ?? DEFAULT_MODEL;
  const results = new Map<string, JudgeResult>();
  const verificationCommandRequirements = Object.fromEntries(
    adapter.config.verification.commands.map((command) => [
      command.name,
      command.required !== false,
    ]),
  );

  // Fall back to sequential if batch disabled or too few inputs
  if (!config.enabled || inputs.length < config.minBatchSize) {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const result = await runJudge(input, adapter, options);
      const key = input.task?.id ?? `judge-${i}`;
      results.set(key, result);
    }
    return results;
  }

  // Build batch requests
  const batchRequests: BatchRequest[] = inputs.map((input, i) => {
    const prompt = buildJudgePrompt({
      taskSpec: input.taskSpec,
      gitDiff: input.gitDiff,
      verificationResults: input.verificationResults,
      verificationCommandRequirements,
      judgeCriteria: adapter.judgeCriteria,
      parsedTask: input.task,
      specReview: input.specReview,
    });

    const key = input.task?.id ?? `judge-${i}`;

    return {
      id: key,
      model,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userMessage: prompt,
      maxTokens: 4096,
      outputFormat: JUDGE_RESPONSE_SCHEMA,
    };
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for batch judge evaluation",
    );
  }

  const client = new BatchClient(apiKey, config);
  const batchResults = await client.submitAndWait(batchRequests, config.pollIntervalMs);

  for (const batchResult of batchResults) {
    if (batchResult.status === "success" && batchResult.response) {
      try {
        const responseText =
          typeof batchResult.response === "string"
            ? batchResult.response
            : JSON.stringify(batchResult.response);

        // Try direct parse first, then extraction strategies
        let judgeResult: JudgeResult | null = null;
        try {
          judgeResult = parseJudgeResponse(responseText);
        } catch {
          judgeResult = extractJudgeJson(responseText);
        }

        if (judgeResult) {
          // Enforcement verdict constraints (TASK-1200): the batch path
          // computes no compliance checks, so only the enforcement-type
          // cap (Rule A) is in effect here.
          results.set(batchResult.id, applyEnforcementConstraints(judgeResult));
        } else {
          results.set(
            batchResult.id,
            makeErrorJudgeResult(`Failed to parse batch judge response for ${batchResult.id}`),
          );
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        results.set(batchResult.id, makeErrorJudgeResult(`Batch judge parse error: ${msg}`));
      }
    } else {
      results.set(
        batchResult.id,
        makeErrorJudgeResult(`Batch judge failed: ${batchResult.error ?? "unknown error"}`),
      );
    }
  }

  return results;
}

/**
 * Create a REJECT JudgeResult for error cases.
 */
function makeErrorJudgeResult(errorMsg: string): JudgeResult {
  return {
    verdict: "REJECT",
    confidence: 0,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [errorMsg],
    feedback: errorMsg,
  };
}
