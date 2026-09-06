// ─── ReviewerRunner Config ──────────────────────────────────────────
// Zod schema for reviewer runner configuration (TASK-1305).
//
// Mounted independently by AdapterConfigSchema under both loop review gates.
//
// Escalation is closed by CONSTRUCTION, not by blocklist: there is no
// caller-extensible argv surface (no extraArgs), the runner builds the
// complete argument vector itself, and `sandbox` is a z.literal so no
// other value is representable. Both objects are `.strict()` (the
// ValidationIntakeConfigSchema precedent) so a typo'd or smuggled key
// fails the parse loudly instead of being silently dropped.

import { z } from "zod";

export const CodexRunnerConfigSchema = z
  .object({
    binaryPath: z.string().min(1).default("codex"),
    /** Hard floor: reviews are read-only; no other value is representable. */
    sandbox: z.literal("read-only").default("read-only"),
    /** CODEX_HOME override for the plugin-free headless profile. Operator-trust surface. */
    codexHome: z.string().optional(),
  })
  .strict();

export const ReviewerRunnerConfigSchema = z
  .object({
    runner: z.enum(["claude-sdk", "codex-cli"]).default("claude-sdk"),
    /** claude-sdk: session model; codex-cli: -m value. Runner default applies when absent. */
    model: z.string().optional(),
    /** claude-sdk only (judge parity). */
    maxTurns: z.number().int().positive().default(30),
    timeoutMs: z.number().int().positive().default(600_000),
    codex: CodexRunnerConfigSchema.default({
      binaryPath: "codex",
      sandbox: "read-only",
    }),
  })
  .strict();

export type CodexRunnerConfig = z.infer<typeof CodexRunnerConfigSchema>;
export type ReviewerRunnerConfig = z.infer<typeof ReviewerRunnerConfigSchema>;
