// ─── Shared Codex structured evaluator ─────────────────────────────
// A fail-closed, read-only Codex CLI boundary for pipeline stages that
// consume typed JSON. This is intentionally separate from both the mutable
// implementation worker and the SHIP/AMEND/REJECT review runner.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ReviewerRunnerConfig } from "../review/reviewer-config.js";
import { buildCodexProcessEnv, codexShellEnvironmentPolicyArgs } from "./codex-process-security.js";
import {
  captureWorkspaceSnapshot,
  changedPaths,
  type WorkspaceSnapshot,
} from "../worker/codex-agent-worker.js";

export type CodexStructuredErrorKind =
  | "invalid_config"
  | "spawn_failed"
  | "unavailable"
  | "timeout"
  | "session_error"
  | "protocol_error"
  | "parse_failed"
  | "tree_mutated";

export type CodexStructuredResult<T> =
  | {
      status: "completed";
      value: T;
      rawText: string;
      sessionId: string;
      turnsUsed: number;
      durationMs: number;
    }
  | {
      status: "runner_error";
      errorKind: CodexStructuredErrorKind;
      message: string;
      sessionId?: string;
      exitCode?: number;
      stderrTail?: string;
      durationMs: number;
    };

export interface CodexStructuredRequest<T> {
  projectRoot: string;
  prompt: string;
  systemPrompt?: string;
  model: string;
  outputSchema: Record<string, unknown>;
  parse: (rawText: string) => T | null;
}

export type StructuredEvaluatorSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"] | "ignore";
    windowsHide: boolean;
    detached?: boolean;
  },
) => ChildProcess;

type WorkspaceProbeFn = (projectRoot: string, timeoutMs: number) => Promise<WorkspaceSnapshot>;

let _spawnFn: StructuredEvaluatorSpawnFn = nodeSpawn as unknown as StructuredEvaluatorSpawnFn;
let _workspaceProbeFn: WorkspaceProbeFn = captureWorkspaceSnapshot;

export function _setCodexStructuredSpawnFn(fn: StructuredEvaluatorSpawnFn | undefined): void {
  _spawnFn = fn ?? (nodeSpawn as unknown as StructuredEvaluatorSpawnFn);
}

export function _setCodexStructuredWorkspaceProbeFn(fn: WorkspaceProbeFn | undefined): void {
  _workspaceProbeFn = fn ?? captureWorkspaceSnapshot;
}

const SAFE_CONFIG_ID = /^[A-Za-z0-9._-]+$/;
const STDERR_TAIL_CHARS = 4_000;
const MAX_JSONL_LINE_CHARS = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowsNull(schema: Record<string, unknown>): boolean {
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.some((entry) => isRecord(entry) && entry.type === "null")
  );
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return allowsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}

/**
 * Convert a conventional JSON Schema into the strict object shape required by
 * Codex/OpenAI structured output. Every declared object property must appear
 * in `required`; properties that were optional remain semantically optional by
 * accepting null. The transformation is recursive and does not mutate the
 * caller's schema.
 */
export function prepareCodexOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key !== "properties" && key !== "required") {
        result[key] = visit(child);
      }
    }

    if (isRecord(value.properties)) {
      const originallyRequired = new Set(
        Array.isArray(value.required)
          ? value.required.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value.properties)) {
        const prepared = visit(child);
        properties[name] =
          !originallyRequired.has(name) && isRecord(prepared) ? nullableSchema(prepared) : prepared;
      }
      result.properties = properties;
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    } else if (value.required !== undefined) {
      result.required = visit(value.required);
    }

    return result;
  };

  return visit(schema) as Record<string, unknown>;
}

/** Exact argv construction; prompt content is represented only by stdin `-`. */
export function buildCodexStructuredArgs(input: {
  config: ReviewerRunnerConfig;
  request: Pick<CodexStructuredRequest<unknown>, "projectRoot" | "model">;
  schemaFile: string;
  outputFile: string;
}): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    ...(input.config.codex.profile ? ["-p", input.config.codex.profile] : []),
    ...(input.config.codex.provider
      ? ["-c", `model_provider="${input.config.codex.provider}"`]
      : []),
    ...codexShellEnvironmentPolicyArgs(),
    "-m",
    input.request.model,
    "--cd",
    input.request.projectRoot,
    "--json",
    "--output-schema",
    input.schemaFile,
    "--output-last-message",
    input.outputFile,
    "-",
  ];
}

function validateConfig(config: ReviewerRunnerConfig): string | undefined {
  if (config.runner !== "codex-cli") {
    return "structured Codex evaluator requires runner=codex-cli";
  }
  if (config.codex.sandbox !== "read-only") {
    return "structured Codex evaluator sandbox must be read-only";
  }
  if (!config.codex.binaryPath.trim()) return "codex binaryPath must not be empty";
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    return "Codex evaluator timeoutMs must be a positive integer";
  }
  if (config.codex.provider && !SAFE_CONFIG_ID.test(config.codex.provider)) {
    return "Codex evaluator provider contains unsupported characters";
  }
  if (config.codex.profile && !SAFE_CONFIG_ID.test(config.codex.profile)) {
    return "Codex evaluator profile contains unsupported characters";
  }
  return undefined;
}

function treeKill(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    try {
      _spawnFn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through.
    }
  }
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort.
  }
}

interface ProcessResult {
  ok: boolean;
  timedOut: boolean;
  sessionId?: string;
  turnsUsed: number;
  exitCode?: number;
  errorKind?: CodexStructuredErrorKind;
  message?: string;
  stderrTail?: string;
}

function runProcess(input: {
  config: ReviewerRunnerConfig;
  request: CodexStructuredRequest<unknown>;
  args: string[];
  prompt: string;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    let lineBuffer = "";
    let stderr = "";
    let sessionId: string | undefined;
    let turnsUsed = 0;
    let terminalCompleted = false;
    let protocolError: string | undefined;

    const settle = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      if (line.length > MAX_JSONL_LINE_CHARS) {
        protocolError = `Codex JSONL event exceeded ${MAX_JSONL_LINE_CHARS} characters`;
        treeKill(child);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        const event = parsed as Record<string, unknown>;
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          sessionId = event.thread_id;
        } else if (event.type === "turn.completed") {
          turnsUsed += 1;
          terminalCompleted = true;
        } else if (event.type === "turn.failed" || event.type === "error") {
          const nested = event.error;
          const nestedMessage =
            nested && typeof nested === "object" && !Array.isArray(nested)
              ? (nested as Record<string, unknown>).message
              : undefined;
          protocolError =
            typeof nestedMessage === "string"
              ? nestedMessage
              : typeof event.message === "string"
                ? event.message
                : String(event.type);
        }
      } catch {
        protocolError = "Codex --json emitted a malformed JSONL event";
        treeKill(child);
      }
    };

    try {
      child = _spawnFn(input.config.codex.binaryPath, input.args, {
        cwd: input.request.projectRoot,
        env: buildCodexProcessEnv(input.config.codex),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error: unknown) {
      settle({
        ok: false,
        timedOut: false,
        turnsUsed,
        errorKind: "spawn_failed",
        message: error instanceof Error ? error.message : "Codex spawn failed",
      });
      return;
    }

    const timer = setTimeout(() => {
      treeKill(child);
      settle({
        ok: false,
        timedOut: true,
        sessionId,
        turnsUsed,
        errorKind: "timeout",
        message: `codex evaluator exceeded ${input.config.timeoutMs}ms and its process tree was killed (pid ${child.pid ?? "unknown"})`,
      });
    }, input.config.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      lineBuffer += chunk.toString();
      if (lineBuffer.length > MAX_JSONL_LINE_CHARS && !lineBuffer.includes("\n")) {
        protocolError = `Codex JSONL event exceeded ${MAX_JSONL_LINE_CHARS} characters`;
        treeKill(child);
        return;
      }
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_TAIL_CHARS * 2) {
        stderr = stderr.slice(-STDERR_TAIL_CHARS);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settle({
        ok: false,
        timedOut: false,
        sessionId,
        turnsUsed,
        errorKind: error.code === "ENOENT" ? "unavailable" : "spawn_failed",
        message:
          error.code === "ENOENT"
            ? `codex binary not found at "${input.config.codex.binaryPath}"`
            : error.message,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (lineBuffer.trim()) consumeLine(lineBuffer);
      if (protocolError) {
        settle({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          errorKind: "protocol_error",
          message: protocolError,
        });
      } else if (code !== 0) {
        const stderrTail = stderr.trim().slice(-STDERR_TAIL_CHARS);
        settle({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          exitCode: code ?? undefined,
          errorKind: "session_error",
          message: `codex exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
          ...(stderrTail ? { stderrTail } : {}),
        });
      } else if (!sessionId || !terminalCompleted) {
        settle({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          errorKind: "protocol_error",
          message: "codex exited successfully without a complete thread/turn JSONL result",
        });
      } else {
        settle({ ok: true, timedOut: false, sessionId, turnsUsed });
      }
    });

    child.stdin?.on("error", () => {
      // Canonical completion arrives through error/close.
    });
    try {
      child.stdin?.end(input.prompt);
    } catch (error: unknown) {
      clearTimeout(timer);
      treeKill(child);
      settle({
        ok: false,
        timedOut: false,
        sessionId,
        turnsUsed,
        errorKind: "session_error",
        message: `failed to send evaluator prompt: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  });
}

/** Run one typed, read-only Codex evaluation. Never rejects. */
export async function runCodexStructuredEvaluation<T>(
  request: CodexStructuredRequest<T>,
  config: ReviewerRunnerConfig,
): Promise<CodexStructuredResult<T>> {
  const startedAt = Date.now();
  const invalid = validateConfig(config);
  if (invalid) {
    return {
      status: "runner_error",
      errorKind: "invalid_config",
      message: invalid,
      durationMs: Date.now() - startedAt,
    };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-codex-eval-"));
    const schemaFile = path.join(tempDir, "output-schema.json");
    const outputFile = path.join(tempDir, "last-message.json");
    await fs.writeFile(
      schemaFile,
      JSON.stringify(prepareCodexOutputSchema(request.outputSchema)),
      "utf8",
    );
    await fs.writeFile(outputFile, "", "utf8");

    const before = await _workspaceProbeFn(request.projectRoot, config.timeoutMs);
    const args = buildCodexStructuredArgs({
      config,
      request,
      schemaFile,
      outputFile,
    });
    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt;
    const processResult = await runProcess({
      config,
      request,
      args,
      prompt,
    });
    const after = await _workspaceProbeFn(request.projectRoot, config.timeoutMs);

    const dirt = changedPaths(before, after);
    if (before.head !== after.head || before.branch !== after.branch || dirt.length > 0) {
      return {
        status: "runner_error",
        errorKind: "tree_mutated",
        message: `read-only Codex evaluator changed the worktree${dirt.length > 0 ? `: ${dirt.join(", ")}` : ""}`,
        sessionId: processResult.sessionId,
        durationMs: Date.now() - startedAt,
      };
    }
    if (!processResult.ok) {
      return {
        status: "runner_error",
        errorKind: processResult.errorKind ?? "session_error",
        message: processResult.message ?? "Codex evaluator failed",
        sessionId: processResult.sessionId,
        exitCode: processResult.exitCode,
        stderrTail: processResult.stderrTail,
        durationMs: Date.now() - startedAt,
      };
    }

    const rawText = (await fs.readFile(outputFile, "utf8")).trim();
    if (!rawText) {
      return {
        status: "runner_error",
        errorKind: "parse_failed",
        message: "Codex evaluator produced no structured last message",
        sessionId: processResult.sessionId,
        durationMs: Date.now() - startedAt,
      };
    }
    let value: T | null;
    try {
      value = request.parse(rawText);
    } catch {
      value = null;
    }
    if (value === null) {
      return {
        status: "runner_error",
        errorKind: "parse_failed",
        message: "Codex evaluator output failed stage schema validation",
        sessionId: processResult.sessionId,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      status: "completed",
      value,
      rawText,
      sessionId: processResult.sessionId!,
      turnsUsed: processResult.turnsUsed,
      durationMs: Date.now() - startedAt,
    };
  } catch (error: unknown) {
    return {
      status: "runner_error",
      errorKind: "session_error",
      message: error instanceof Error ? error.message : "Codex evaluator failed",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
