import { z } from "zod";
import type { PreflightResult } from "../preflight/preflight-types.js";
import { BLUEPRINT_FAILURE_MESSAGE_LIMIT, BLUEPRINT_FAILURE_ERROR_LIMIT,
  BLUEPRINT_FAILURE_ERRORS_LIMIT } from "../blueprint/generation-failure.js";

export const FULL_PREFLIGHT_OUTPUT_LIMIT = 4 * 1024 * 1024;
export const PREFLIGHT_DIAGNOSTIC_LIMIT = 64 * 1024;
export const preflightHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const preflightJobIdSchema = z.string().uuid();
const count = z.number().finite().nonnegative();

const diagnosticKind = z.enum([
  "runtime_unavailable",
  "spec_failed",
  "validation_failed",
  "internal_error",
]);
const failureSchema = z.object({
  source: z.enum(["claude-sdk", "codex-cli", "pipeline"]),
  code: z.string().max(100),
  message: z.string().max(BLUEPRINT_FAILURE_MESSAGE_LIMIT),
  failedAt: z.string().datetime(),
  kind: diagnosticKind,
  stage: z.string(),
  retryable: z.boolean(),
  exitCode: z.number().int().optional(),
  stderrTail: z.string().max(BLUEPRINT_FAILURE_MESSAGE_LIMIT).optional(),
  sdkSubtype: z.string().max(100).optional(),
  sdkErrors: z
    .array(z.string().max(BLUEPRINT_FAILURE_ERROR_LIMIT))
    .max(BLUEPRINT_FAILURE_ERRORS_LIMIT)
    .optional(),
});

// Validate every required report section. Optional producer extensions remain
// intact, including structured blueprints, refusal details and fidelity facts.
const reportSchema = z.object({
  taskId: z.string().min(1),
  timestamp: z.string().datetime(),
  contentHash: preflightHashSchema,
  inputContentHash: preflightHashSchema.optional(),
  schemaPolicyHash: preflightHashSchema,
  gate: z.object({
    ready: z.boolean(), score: z.number().finite().min(0).max(5),
    dimensions: z.record(z.string(), z.number().finite()),
    readinessJudgmentMode: z.enum(["off", "shadow", "enforce"]).optional(),
    gateSkipped: z.boolean().optional(),
  }).passthrough(),
  blueprint: z.object({
    fileAnalyses: count, codeExamples: count, verificationPatterns: count,
    antiPatterns: count, formattedMarkdown: z.string(),
    generationFailure: failureSchema.optional(), generatedAt: z.string().datetime().optional(),
  }).passthrough(),
  complexity: z.object({
    filesToModify: count, successCriteria: count, estimatedContextTokens: count,
    independentFeatures: count,
    featureClusters: z.array(z.object({
      label: z.string(), criteriaIndices: z.array(count), files: z.array(z.string()),
    })),
    recommendDecomposition: z.boolean(), reason: z.string(),
  }).passthrough(),
  contextEstimate: z.object({
    taskSpec: count, blueprint: count, repoMap: count, relevantFiles: count,
    relatedPatterns: count, existingTests: count, conventions: count,
    claudeMd: count, total: count, withinBudget: z.boolean(),
  }).passthrough(),
  decomposition: z.object({
    decomposed: z.boolean(), subtaskIds: z.array(z.string()), subtaskFiles: z.array(z.string()),
    committedSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
  }).passthrough().optional(),
  mode: z.enum(["full", "deterministic"]).optional(),
  degraded: z.object({
    reason: z.string(), checksRun: z.array(z.string()), checksSkipped: z.array(z.string()),
    diagnostics: failureSchema.partial().extend({
      kind: diagnosticKind,
      stage: z.string(), exitCode: z.number().int().optional(),
      stderrTail: z.string().optional(), retryable: z.boolean(),
      message: z.string().max(BLUEPRINT_FAILURE_MESSAGE_LIMIT).optional(),
    }),
  }).optional(),
}).passthrough();

export type StampedPreflightResult = PreflightResult & { schemaPolicyHash: string };

export function parseFullPreflightResult(value: unknown): StampedPreflightResult {
  const result = reportSchema.parse(value);
  if ("error" in result) throw new Error("Preflight returned an error instead of a report");
  return result as unknown as StampedPreflightResult;
}

export function parsePreflightJobEnvelope(value: unknown, jobId: string): StampedPreflightResult {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > FULL_PREFLIGHT_OUTPUT_LIMIT) {
    throw new Error("Preflight result exceeds its bounded output size");
  }
  const envelope = z.object({ jobId: preflightJobIdSchema, result: z.unknown() }).strict().parse(value);
  if (envelope.jobId !== jobId) throw new Error("Preflight result belongs to a different attempt");
  return parseFullPreflightResult(envelope.result);
}

/** A committed parent rewrite is the only legitimate report/input hash change. */
export function preflightReportMatchesInput(result: StampedPreflightResult, inputHash: string): boolean {
  return result.contentHash === inputHash || (result.inputContentHash === inputHash &&
    result.decomposition?.decomposed === true && result.decomposition.subtaskFiles.length > 0 &&
    /^[a-f0-9]{7,64}$/.test(result.decomposition.committedSha ?? ""));
}
