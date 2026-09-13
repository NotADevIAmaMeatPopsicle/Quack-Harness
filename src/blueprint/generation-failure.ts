import type { BriefFidelityResult } from "./blueprint-types.js";
import { isQuackRuntimeError, type RuntimeDiagnostics } from "../core/runtime-errors.js";
import type { CodexStructuredErrorKind } from "../llm/codex-structured-evaluator.js";

export const BLUEPRINT_FAILURE_MESSAGE_LIMIT = 2000;
export const BLUEPRINT_FAILURE_ERROR_LIMIT = 300;
export const BLUEPRINT_FAILURE_ERRORS_LIMIT = 8;

/** Pipeline evidence, never accepted from model-authored blueprint JSON. */
export interface BlueprintGenerationFailure extends RuntimeDiagnostics {
  source: "claude-sdk" | "codex-cli" | "pipeline";
  code: string;
  message: string;
  failedAt: string;
  sdkSubtype?: string;
  sdkErrors?: string[];
}

export function blueprintFailure(
  input: Omit<BlueprintGenerationFailure, "stage" | "failedAt">,
): BlueprintGenerationFailure {
  const message = input.message.slice(0, BLUEPRINT_FAILURE_MESSAGE_LIMIT);
  return {
    ...input,
    code: input.code.slice(0, 100),
    message,
    stage: "preflight.blueprint",
    failedAt: new Date().toISOString(),
    stderrTail: (input.stderrTail ?? message).slice(-BLUEPRINT_FAILURE_MESSAGE_LIMIT),
    ...(input.sdkSubtype ? { sdkSubtype: input.sdkSubtype.slice(0, 100) } : {}),
    ...(input.sdkErrors
      ? {
          sdkErrors: input.sdkErrors
            .slice(0, BLUEPRINT_FAILURE_ERRORS_LIMIT)
            .map((error) => error.slice(0, BLUEPRINT_FAILURE_ERROR_LIMIT)),
        }
      : {}),
  };
}

export function codexBlueprintFailure(
  code: CodexStructuredErrorKind,
  message: string,
  exitCode?: number,
): BlueprintGenerationFailure {
  const kind =
    code === "parse_failed" || code === "protocol_error"
      ? "validation_failed"
      : code === "invalid_config" || code === "tree_mutated"
        ? "internal_error"
        : "runtime_unavailable";
  return blueprintFailure({
    source: "codex-cli",
    code,
    message,
    kind,
    retryable: kind !== "internal_error",
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

export function blueprintFailureFromError(
  error: unknown,
  source: BlueprintGenerationFailure["source"],
): BlueprintGenerationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const timeout = error instanceof Error && error.name === "TimeoutError";
  const unavailable =
    timeout ||
    [
      "ENOENT",
      "MODULE_NOT_FOUND",
      "ERR_MODULE_NOT_FOUND",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
    ].includes(code);
  const diagnostics = isQuackRuntimeError(error)
    ? error.diagnostics
    : {
        kind: unavailable ? ("runtime_unavailable" as const) : ("internal_error" as const),
        retryable: unavailable,
      };
  return blueprintFailure({
    ...diagnostics,
    source,
    code: timeout ? "timeout" : code || "exception",
    message,
  });
}

export function blueprintFailureGuidance(failure: BlueprintGenerationFailure): string {
  return failure.retryable
    ? `${failure.message} Restore the configured blueprint provider/runtime or correct its output, then retry preflight.`
    : `${failure.message} Inspect the configuration, workspace or blueprint validation findings before retrying preflight.`;
}

export function fidelityBlueprintFailure(fidelity: BriefFidelityResult): BlueprintGenerationFailure {
  const details = fidelity.violations.map((violation) => `${violation.kind}: ${violation.detail}`).join("; ");
  return blueprintFailure({ source: "pipeline", code: "fidelity_failed", kind: "validation_failed", retryable: false,
    message: `Generated blueprint failed deterministic fidelity validation${details ? `: ${details}` : ""}` });
}
