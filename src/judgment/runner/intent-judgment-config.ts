import { z } from "zod";
import { CodexRunnerConfigSchema } from "../../review/reviewer-config.js";

export const ClaudeIntentJudgmentRunnerConfigSchema = z
  .object({
    provider: z.literal("claude-sdk").default("claude-sdk"),
    model: z.string().min(1).default("claude-sonnet-4-6"),
    maxTurns: z.number().int().positive().default(5),
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

export const CodexIntentJudgmentRunnerConfigSchema = z
  .object({
    provider: z.literal("codex-cli"),
    /** Explicit because a Claude model fallback is never valid Codex argv. */
    model: z.string().min(1),
    /** Retained for config-shape parity; Codex CLI has no hard turn-count flag. */
    maxTurns: z.number().int().positive().default(5),
    timeoutMs: z.number().int().positive().default(120_000),
    codex: CodexRunnerConfigSchema.default({
      binaryPath: "codex",
      sandbox: "read-only",
    }),
  })
  .strict();

export const IntentJudgmentRunnerConfigSchema = z.union([
  CodexIntentJudgmentRunnerConfigSchema,
  ClaudeIntentJudgmentRunnerConfigSchema,
]);

export type IntentJudgmentRunnerConfig = z.infer<typeof IntentJudgmentRunnerConfigSchema>;
export type ClaudeIntentJudgmentRunnerConfig = z.infer<
  typeof ClaudeIntentJudgmentRunnerConfigSchema
>;
export type CodexIntentJudgmentRunnerConfig = z.infer<typeof CodexIntentJudgmentRunnerConfigSchema>;

// TASK-1315: the per-stage mode shape is shared by every intent cutover
// stage (docs-review since 1311, readiness since 1315).
export const JudgmentStageModeConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "enforce"]).default("off"),
  })
  .strict();

/** Compatibility alias (pre-1315 name). */
export const DocsReviewJudgmentStageConfigSchema = JudgmentStageModeConfigSchema;

// ─── Safety-floor wiring config (TASK-1313) ─────────────────────────
// DELIBERATELY `.optional()` WITHOUT defaults at any level: a defaulted
// object would materialize into every normalized adapter config and
// change `sharedHash` for adapters that never opted in (round-1 F5).
// Absent key = "off" everywhere, resolved at read sites via
// resolveSafetyFloorConfig().
//
// Mode vocabulary crosswalk: intent-model stages use off/shadow/enforce
// (shadow COMPUTES a candidate decision without applying it). Safety
// signals use off/report/enforce — `report` INJECTS facts as visible
// non-blocking signals (safety-tier facts demoted to human_review); it
// is deliberately not named "shadow" because the mechanism differs.

export const SafetySignalsModeSchema = z.enum(["off", "report", "enforce"]);
export const SafetyCheckModeSchema = z.enum(["off", "warn", "enforce"]);

export const SafetyFloorConfigSchema = z
  .object({
    signals: z.object({ mode: SafetySignalsModeSchema }).strict().optional(),
    preVerificationIntegrity: z.object({ mode: SafetyCheckModeSchema }).strict().optional(),
    resumeValidation: z.object({ mode: SafetyCheckModeSchema }).strict().optional(),
  })
  .strict();

export type SafetyFloorConfig = z.infer<typeof SafetyFloorConfigSchema>;
export type SafetySignalsMode = z.infer<typeof SafetySignalsModeSchema>;
export type SafetyCheckMode = z.infer<typeof SafetyCheckModeSchema>;

export interface ResolvedSafetyFloorConfig {
  signalsMode: SafetySignalsMode;
  preVerificationIntegrityMode: SafetyCheckMode;
  resumeValidationMode: SafetyCheckMode;
}

/** Absent config (or absent sub-keys) resolve to off — today's behavior. */
export function resolveSafetyFloorConfig(
  config: SafetyFloorConfig | undefined,
): ResolvedSafetyFloorConfig {
  return {
    signalsMode: config?.signals?.mode ?? "off",
    preVerificationIntegrityMode: config?.preVerificationIntegrity?.mode ?? "off",
    resumeValidationMode: config?.resumeValidation?.mode ?? "off",
  };
}

export const JudgmentConfigSchema = z
  .object({
    runner: IntentJudgmentRunnerConfigSchema.default({
      provider: "claude-sdk",
      model: "claude-sonnet-4-6",
      maxTurns: 5,
      timeoutMs: 120_000,
    }),
    stages: z
      .object({
        docsReview: JudgmentStageModeConfigSchema.default({ mode: "off" }),
        // TASK-1315: the readiness gate cutover. D1 (spec): defaulting
        // this key shifts normalized-config bytes ONLY for adapters that
        // carry an explicit `judgment` block; the top-level key stays
        // optional and non-materializing for everyone else.
        readiness: JudgmentStageModeConfigSchema.default({ mode: "off" }),
        // TASK-1316: the loop + judge cutovers. Same D1-class hash
        // semantics as readiness — these materialize ONLY for adapters
        // that carry an explicit `judgment` block.
        loopBrief: JudgmentStageModeConfigSchema.default({ mode: "off" }),
        loopDiff: JudgmentStageModeConfigSchema.default({ mode: "off" }),
        judge: JudgmentStageModeConfigSchema.default({ mode: "off" }),
      })
      .strict()
      .default({
        docsReview: { mode: "off" },
        readiness: { mode: "off" },
        loopBrief: { mode: "off" },
        loopDiff: { mode: "off" },
        judge: { mode: "off" },
      }),
    safetyFloor: SafetyFloorConfigSchema.optional(),
    /**
     * TASK-1319 (P2-5): advisory-override logging.
     *
     * `.optional()` and non-materializing, matching `safetyFloor`, so
     * adapters that carry no `judgment` block are byte-unchanged.
     *
     * Round-1 R1-7: the default is `warn`, NOT `enforce`. An operator
     * whose client posts no body must not be unable to approve at 3am,
     * and `warn` is also what produces the evidence for deciding when
     * enforcing is safe. Same off/shadow/enforce discipline as every
     * other v2 cutover, with `warn` reading more honestly than `shadow`
     * here because the record IS written; only the refusal is withheld.
     */
    advisoryOverride: z
      .object({
        mode: z.enum(["off", "warn", "enforce"]).default("warn"),
      })
      .strict()
      .optional(),
  })
  .strict();

export type JudgmentConfig = z.infer<typeof JudgmentConfigSchema>;
