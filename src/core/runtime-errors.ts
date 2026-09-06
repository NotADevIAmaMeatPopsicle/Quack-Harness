export type RuntimeErrorKind =
  | "runtime_unavailable"
  | "spec_failed"
  | "validation_failed"
  | "internal_error";

export interface RuntimeDiagnostics {
  kind: RuntimeErrorKind;
  stage: string;
  exitCode?: number;
  stderrTail?: string;
  retryable: boolean;
}

export class QuackRuntimeError extends Error {
  readonly diagnostics: RuntimeDiagnostics;
  readonly causeError?: unknown;

  constructor(message: string, diagnostics: RuntimeDiagnostics, causeError?: unknown) {
    super(message);
    this.name = "QuackRuntimeError";
    this.diagnostics = diagnostics;
    this.causeError = causeError;
  }
}

interface ErrorLike {
  message?: unknown;
  diagnostics?: unknown;
}

export function isQuackRuntimeError(err: unknown): err is QuackRuntimeError {
  return err instanceof QuackRuntimeError;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof (err as ErrorLike).message === "string") {
    return (err as ErrorLike).message as string;
  }
  return String(err);
}

function extractExitCode(message: string): number | undefined {
  const match = message.match(/(?:exit(?:ed)?\s+code|code)\s+(\d+)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

export function classifyRuntimeErrorKind(message: string): RuntimeErrorKind {
  const lower = message.toLowerCase();

  if (
    lower.includes("timed out") ||
    lower.includes("subprocess") ||
    lower.includes("sdk error") ||
    lower.includes("structured output retry") ||
    lower.includes("rate limit") ||
    lower.includes("credit") ||
    lower.includes("spawn") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("service unavailable")
  ) {
    return "runtime_unavailable";
  }

  if (
    lower.includes("schema validation failed") ||
    lower.includes("invalid status value") ||
    lower.includes("missing required")
  ) {
    return "spec_failed";
  }

  if (lower.includes("validation failed")) {
    return "validation_failed";
  }

  return "internal_error";
}

function computeRetryable(kind: RuntimeErrorKind, exitCode?: number): boolean {
  if (kind !== "runtime_unavailable") return false;
  if (exitCode === undefined) return true;
  return exitCode !== 2;
}

function tailMessage(message: string, maxChars = 500): string {
  const normalized = message.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-8).join("\n");
  return tail.length <= maxChars ? tail : tail.slice(-maxChars);
}

export function toRuntimeDiagnostics(
  err: unknown,
  fallbackStage: string,
): RuntimeDiagnostics & { message: string } {
  if (isQuackRuntimeError(err)) {
    return {
      ...err.diagnostics,
      message: err.message,
    };
  }

  const message = extractErrorMessage(err);
  const kind = classifyRuntimeErrorKind(message);
  const exitCode = extractExitCode(message);
  return {
    kind,
    stage: fallbackStage,
    exitCode,
    stderrTail: tailMessage(message),
    retryable: computeRetryable(kind, exitCode),
    message,
  };
}
