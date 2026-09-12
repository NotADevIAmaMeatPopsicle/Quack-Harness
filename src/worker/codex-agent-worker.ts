// ─── Codex CLI implementation worker ───────────────────────────────
// Opt-in implementation backend for runAgent(). It deliberately uses the
// Codex CLI process boundary instead of pretending the Claude Agent SDK and
// Codex expose the same tool/hook protocol.
//
// Security invariants:
// - argv is entirely runner-constructed (no caller-extensible arguments)
// - the sandbox is pinned to workspace-write; danger-full-access is impossible
// - cwd is the dispatcher-selected project worktree; no --add-dir is used
// - prompt content travels over stdin, never through argv
// - branch/HEAD and changed-path policy are checked after the subprocess
// - every exit contains/verifies descendants before denied paths are restored

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type {
  AdapterAgentConfig,
  AgentMessage,
  AgentResult,
  AdapterSandboxConfig,
  TaskContext,
  VerificationResult,
} from "../core/types.js";
import { verificationCommandShellString } from "../core/types.js";
import { parseTaskFile } from "../core/task-parser.js";
import { checkWritePath } from "../hooks/bash-guard.js";
import { verifyBeforeStop } from "../hooks/verify-before-stop.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { buildSystemPrompt, buildTaskPrompt } from "./prompt-builder.js";
import {
  buildCodexProcessEnv,
  codexShellEnvironmentPolicyArgs,
} from "../llm/codex-process-security.js";
import {
  prepareCodexDeniedPathGuard,
  type CodexDeniedPathGuard,
  type DeniedPathGuardResult,
} from "./codex-denied-path-guard.js";
import {
  buildContainedCodexSpawn,
  resolveWindowsTaskkillPath,
  verifyCodexDescendantsContained,
  type CodexContainmentEvidence,
} from "./codex-process-containment.js";
import {
  changedDependencyManifestPaths,
  runPostWorkerDependencyRefresh,
} from "../dispatcher/worktree-init.js";
import { resolveTrustedExecutable, runTrustedGit } from "./trusted-executable.js";

export interface CodexWorkerRunOptions {
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  retryFeedback?: string;
}

interface ResolvedCodexWorkerConfig {
  binaryPath: string;
  sandbox: "workspace-write";
  codexHome?: string;
  profile?: string;
  provider?: string;
  credentialEnvVar?: string;
  timeoutMs: number;
}

interface WorkspaceEntry {
  status: string;
  digest: string;
}

export interface WorkspaceSnapshot {
  head: string;
  branch: string;
  entries: Record<string, WorkspaceEntry>;
}

export type SpawnFn = (
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
type DeniedPathGuardFactory = (
  projectRoot: string,
  sandbox: AdapterSandboxConfig,
) => Promise<CodexDeniedPathGuard>;
type DescendantContainmentFn = (evidence: CodexContainmentEvidence) => Promise<void>;
type DependencyRefreshFn = typeof runPostWorkerDependencyRefresh;
type TrustedExecutableResolverFn = typeof resolveTrustedExecutable;

let _spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn;
let _workspaceProbeFn: WorkspaceProbeFn = captureWorkspaceSnapshot;
let _deniedPathGuardFactory: DeniedPathGuardFactory = prepareCodexDeniedPathGuard;
let _descendantContainmentFn: DescendantContainmentFn = verifyCodexDescendantsContained;
let _dependencyRefreshFn: DependencyRefreshFn = runPostWorkerDependencyRefresh;
let _trustedExecutableResolverFn: TrustedExecutableResolverFn = resolveTrustedExecutable;
let _workerPlatform: NodeJS.Platform = process.platform;

export function _setCodexWorkerSpawnFn(fn: SpawnFn | undefined): void {
  _spawnFn = fn ?? (nodeSpawn as unknown as SpawnFn);
}

export function _setWorkspaceProbeFn(fn: WorkspaceProbeFn | undefined): void {
  _workspaceProbeFn = fn ?? captureWorkspaceSnapshot;
}

export function _setCodexDeniedPathGuardFactory(fn: DeniedPathGuardFactory | undefined): void {
  _deniedPathGuardFactory = fn ?? prepareCodexDeniedPathGuard;
}

export function _setCodexDescendantContainmentFn(fn: DescendantContainmentFn | undefined): void {
  _descendantContainmentFn = fn ?? verifyCodexDescendantsContained;
}

export function _setCodexDependencyRefreshFn(fn: DependencyRefreshFn | undefined): void {
  _dependencyRefreshFn = fn ?? runPostWorkerDependencyRefresh;
}

export function _setCodexTrustedExecutableResolverFn(
  fn: TrustedExecutableResolverFn | undefined,
): void {
  _trustedExecutableResolverFn = fn ?? resolveTrustedExecutable;
}

export function _setCodexWorkerPlatform(platform: NodeJS.Platform | undefined): void {
  _workerPlatform = platform ?? process.platform;
}

const DEFAULT_TIMEOUT_MS = 1_800_000;
const STDERR_TAIL_CHARS = 4_000;
const MAX_JSONL_LINE_CHARS = 2_000_000;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function resolveConfig(agent: AdapterAgentConfig): ResolvedCodexWorkerConfig {
  const configured = agent.codex;
  const resolved: ResolvedCodexWorkerConfig = {
    binaryPath: configured?.binaryPath ?? "codex",
    sandbox: configured?.sandbox ?? "workspace-write",
    timeoutMs: configured?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(configured?.codexHome ? { codexHome: configured.codexHome } : {}),
    ...(configured?.profile ? { profile: configured.profile } : {}),
    ...(configured?.provider ? { provider: configured.provider } : {}),
    ...(configured?.credentialEnvVar ? { credentialEnvVar: configured.credentialEnvVar } : {}),
  };

  // Runtime checks protect callers that constructed AdapterConfig manually
  // instead of going through the Zod loader.
  if (!resolved.binaryPath.trim()) {
    throw new Error("agent.codex.binaryPath must not be empty");
  }
  if (resolved.sandbox !== "workspace-write") {
    throw new Error("Codex implementation sandbox must be workspace-write");
  }
  if (!Number.isInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error("agent.codex.timeoutMs must be a positive integer");
  }
  if (resolved.provider && !SAFE_PROVIDER_ID.test(resolved.provider)) {
    throw new Error("agent.codex.provider contains unsupported characters");
  }
  if (resolved.profile && !SAFE_PROVIDER_ID.test(resolved.profile)) {
    throw new Error("agent.codex.profile contains unsupported characters");
  }
  return resolved;
}

/**
 * Build the exact, non-extensible Codex invocation. The prompt is always read
 * from stdin (`-`). On resume, global sandbox/cwd options remain before the
 * subcommand so they cannot silently fall back to ambient defaults.
 */
export function buildCodexWorkerArgs(input: {
  config: ResolvedCodexWorkerConfig;
  projectRoot: string;
  model: string;
  resumeSessionId?: string;
}): string[] {
  if (input.resumeSessionId && !SAFE_SESSION_ID.test(input.resumeSessionId)) {
    throw new Error("Codex resume session id contains unsupported characters");
  }
  return [
    "exec",
    "--sandbox",
    "workspace-write",
    ...(input.config.profile ? ["-p", input.config.profile] : []),
    ...(input.config.provider ? ["-c", `model_provider="${input.config.provider}"`] : []),
    ...codexShellEnvironmentPolicyArgs(),
    "-m",
    input.model,
    "--cd",
    input.projectRoot,
    "--json",
    ...(input.resumeSessionId ? ["resume", input.resumeSessionId, "-"] : ["-"]),
  ];
}

function runGit(projectRoot: string, args: string[], timeoutMs: number): Promise<string> {
  return runTrustedGit(projectRoot, args, {
    timeoutMs: Math.min(timeoutMs, 15_000),
    maxBuffer: 4 * 1024 * 1024,
    errorContext: "Git workspace probe failed",
  });
}

function parsePorcelainZ(output: string): Array<{ status: string; file: string }> {
  const records = output.split("\0");
  const entries: Array<{ status: string; file: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3).replace(/\\/g, "/");
    entries.push({ status, file });
    if (status.includes("R") || status.includes("C")) {
      // Porcelain -z adds the source path as the next NUL-delimited record.
      const source = records[index + 1]?.replace(/\\/g, "/");
      if (source) entries.push({ status: " D", file: source });
      index += 1;
    }
  }
  return entries;
}

async function digestPath(projectRoot: string, relativePath: string): Promise<string> {
  const absolute = path.resolve(projectRoot, relativePath);
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      return `symlink:${await fs.readlink(absolute)}`;
    }
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
    return createHash("sha256")
      .update(await fs.readFile(absolute))
      .digest("hex");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return "missing";
    }
    throw error;
  }
}

/** Capture branch identity plus content fingerprints for every dirty path. */
export async function captureWorkspaceSnapshot(
  projectRoot: string,
  timeoutMs: number,
): Promise<WorkspaceSnapshot> {
  const [headRaw, branchRaw, statusRaw] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "HEAD"], timeoutMs),
    // Dispatch worktrees may intentionally be detached at the base commit
    // before Quack creates/attaches the task branch. `symbolic-ref` exits 1
    // for that valid state; `rev-parse --abbrev-ref` returns the stable
    // sentinel `HEAD` and still reports a normal branch name when attached.
    runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
    runGit(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeoutMs),
  ]);
  const entries: Record<string, WorkspaceEntry> = {};
  for (const entry of parsePorcelainZ(statusRaw)) {
    entries[entry.file] = {
      status: entry.status,
      digest: await digestPath(projectRoot, entry.file),
    };
  }
  return {
    head: headRaw.trim(),
    branch: branchRaw.trim(),
    entries,
  };
}

export function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...paths]
    .filter((file) => {
      const left = before.entries[file];
      const right = after.entries[file];
      return left?.status !== right?.status || left?.digest !== right?.digest;
    })
    .sort();
}

function treeKill(child: ChildProcess, platform: NodeJS.Platform, projectRoot: string): void {
  const pid = child.pid;
  if (pid && platform === "win32") {
    try {
      const taskkillPath = resolveWindowsTaskkillPath(process.env, projectRoot);
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
      _spawnFn(taskkillPath, ["/pid", String(pid), "/t", "/f"], {
        cwd: path.dirname(taskkillPath),
        env: systemRoot
          ? {
              SystemRoot: systemRoot,
              SYSTEMROOT: systemRoot,
              WINDIR: systemRoot,
              PATH: path.dirname(taskkillPath),
            }
          : {},
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }
  if (pid && platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct kill.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best effort after a timeout or protocol failure.
  }
}

interface CodexExecutionResult {
  ok: boolean;
  timedOut: boolean;
  descendantsContained: boolean;
  sessionId?: string;
  turnsUsed: number;
  messages: AgentMessage[];
  error?: string;
}

function eventString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function executeCodex(input: {
  config: ResolvedCodexWorkerConfig;
  args: string[];
  prompt: string;
  projectRoot: string;
  events?: IEventWriter;
}): Promise<CodexExecutionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let settling = false;
    let child: ChildProcess;
    let lineBuffer = "";
    let stderr = "";
    let sessionId: string | undefined;
    let turnsUsed = 0;
    let terminalCompleted = false;
    let protocolError: string | undefined;
    let executionInterrupted = false;
    let windowsCompletionObserved = false;
    let windowsCompletionMarker: string | undefined;
    let linuxPidNamespace = false;
    const messages: AgentMessage[] = [];

    const settle = (result: CodexExecutionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const settleAfterContainment = (
      result: Omit<CodexExecutionResult, "descendantsContained">,
    ): void => {
      if (settled || settling) return;
      settling = true;
      const pid = child.pid;
      if (!pid) {
        settle({ ...result, descendantsContained: true });
        return;
      }
      void _descendantContainmentFn({
        pid,
        platform: _workerPlatform,
        interrupted: executionInterrupted,
        linuxPidNamespace,
        windowsCompletionObserved,
      }).then(
        () => settle({ ...result, descendantsContained: true }),
        (error: unknown) =>
          settle({
            ...result,
            ok: false,
            descendantsContained: false,
            error: [
              result.error,
              `Codex descendant containment failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ]
              .filter(Boolean)
              .join(" | "),
          }),
      );
    };

    const interruptTree = (): void => {
      executionInterrupted = true;
      treeKill(child, _workerPlatform, input.projectRoot);
    };

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      if (line.length > MAX_JSONL_LINE_CHARS) {
        protocolError = `Codex JSONL event exceeded ${MAX_JSONL_LINE_CHARS} characters`;
        interruptTree();
        return;
      }
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("event is not an object");
        }
        event = parsed as Record<string, unknown>;
      } catch {
        protocolError = "Codex --json emitted a malformed JSONL event";
        interruptTree();
        return;
      }

      const type = eventString(event.type);
      if (type === "thread.started") {
        sessionId = eventString(event.thread_id) ?? sessionId;
      } else if (type === "turn.completed") {
        turnsUsed += 1;
        terminalCompleted = true;
      } else if (type === "turn.failed" || type === "error") {
        const error = event.error;
        const errorMessage =
          error && typeof error === "object" && !Array.isArray(error)
            ? eventString((error as Record<string, unknown>).message)
            : undefined;
        protocolError = errorMessage ?? eventString(event.message) ?? type;
      } else if (type === "item.completed") {
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (record.type === "agent_message") {
            const content = eventString(record.text) ?? "";
            const turnNumber = Math.max(1, turnsUsed + 1);
            messages.push({
              role: "assistant",
              content,
              timestamp: new Date().toISOString(),
              turnNumber,
            });
            input.events?.emit("agent_turn", {
              turnNumber,
              role: "assistant",
              contentPreview: content.slice(0, 200),
            });
          }
        }
      }
    };

    try {
      const spawnPlan = buildContainedCodexSpawn({
        binaryPath: input.config.binaryPath,
        args: input.args,
        cwd: input.projectRoot,
        env: buildCodexProcessEnv(input.config),
        platform: _workerPlatform,
      });
      windowsCompletionMarker = spawnPlan.windowsCompletionMarker;
      linuxPidNamespace = spawnPlan.linuxPidNamespace ?? false;
      child = _spawnFn(spawnPlan.command, spawnPlan.args, spawnPlan.options);
    } catch (error: unknown) {
      settle({
        ok: false,
        timedOut: false,
        descendantsContained: true,
        turnsUsed,
        messages,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      interruptTree();
      settleAfterContainment({
        ok: false,
        timedOut: true,
        sessionId,
        turnsUsed,
        messages,
        error: `codex implementation exceeded ${input.config.timeoutMs}ms and its process tree was killed (pid ${child.pid ?? "unknown"})`,
      });
    }, input.config.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      lineBuffer += chunk.toString();
      if (lineBuffer.length > MAX_JSONL_LINE_CHARS && !lineBuffer.includes("\n")) {
        protocolError = `Codex JSONL event exceeded ${MAX_JSONL_LINE_CHARS} characters`;
        interruptTree();
        return;
      }
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      if (windowsCompletionMarker && stderr.includes(windowsCompletionMarker)) {
        windowsCompletionObserved = true;
      }
      if (stderr.length > STDERR_TAIL_CHARS * 2) {
        stderr = stderr.slice(-STDERR_TAIL_CHARS);
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      executionInterrupted = child.pid !== undefined;
      settleAfterContainment({
        ok: false,
        timedOut: false,
        sessionId,
        turnsUsed,
        messages,
        error:
          error.code === "ENOENT"
            ? `codex binary not found at "${input.config.binaryPath}"`
            : error.message,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (signal) executionInterrupted = true;
      if (lineBuffer.trim()) consumeLine(lineBuffer);
      if (protocolError) {
        settleAfterContainment({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          messages,
          error: protocolError,
        });
        return;
      }
      if (code !== 0) {
        const tail = stderr
          .replace(windowsCompletionMarker ?? "\0", "")
          .trim()
          .slice(-STDERR_TAIL_CHARS);
        settleAfterContainment({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          messages,
          error: `codex exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}${tail ? `: ${tail}` : ""}`,
        });
        return;
      }
      if (!sessionId || !terminalCompleted) {
        settleAfterContainment({
          ok: false,
          timedOut: false,
          sessionId,
          turnsUsed,
          messages,
          error: "codex exited successfully without a complete thread/turn JSONL result",
        });
        return;
      }
      settleAfterContainment({ ok: true, timedOut: false, sessionId, turnsUsed, messages });
    });

    child.stdin?.on("error", () => {
      // The process error/close path provides the canonical result.
    });
    try {
      child.stdin?.end(input.prompt);
    } catch (error: unknown) {
      clearTimeout(timer);
      interruptTree();
      settleAfterContainment({
        ok: false,
        timedOut: false,
        sessionId,
        turnsUsed,
        messages,
        error: `failed to send prompt to codex: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

function providerPrompt(taskId: string, context: TaskContext, adapter: ProjectAdapter): string {
  const verification = adapter.config.verification.commands
    .map((command) => `- ${command.name}: ${verificationCommandShellString(command)}`)
    .join("\n");
  const writable = adapter.config.sandbox.writablePaths.join(", ") || "the project worktree";
  const denied = adapter.config.sandbox.deniedPaths.join(", ") || "none configured";
  const disposable = adapter.config.sandbox.disposablePaths ?? [];
  const deniedPathNotice =
    disposable.length > 0
      ? `Disposable paths available for this turn: ${disposable.join(", ")}. They are independent mirrors; you may use or modify them for tests, but Quack discards their changes and restores trusted originals before mandatory verification. Other denied paths remain quarantined; do not recreate them.`
      : "Denied paths are quarantined during this turn. Do not recreate them. If a denied dependency directory such as node_modules makes an in-turn command unavailable, report that limitation honestly; Quack restores the original directory before mandatory post-run verification.";
  return [
    buildSystemPrompt(adapter, context.claudeMd),
    "# Codex CLI implementation contract (provider-specific override)",
    "You are running non-interactively in Codex's workspace-write sandbox inside a dedicated Quack git worktree.",
    "The Claude-only MCP verify and git tools mentioned above are not available. Run the listed deterministic verification commands directly before finishing when their dependencies are available; Quack reruns them after you exit.",
    deniedPathNotice,
    "Do not run git write commands (including add, commit, checkout, reset, merge, rebase, push, or branch mutations). Quack seals the output after this worker returns.",
    `Writable paths: ${writable}`,
    `Denied paths: ${denied}`,
    "Verification commands:",
    verification || "- none (Quack will still apply its verification contract)",
    buildTaskPrompt(taskId, context),
  ].join("\n\n");
}

function relativeTaskSpec(context: TaskContext, projectRoot: string): string | undefined {
  if (!context.taskSpecPath) return undefined;
  const absolute = path.isAbsolute(context.taskSpecPath)
    ? path.resolve(context.taskSpecPath)
    : path.resolve(projectRoot, context.taskSpecPath);
  const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
  return relative.startsWith("..") ? undefined : relative;
}

/** Execute one implementation turn through the Codex CLI. */
export async function runCodexImplementationAgent(
  taskId: string,
  context: TaskContext,
  adapter: ProjectAdapter,
  options?: CodexWorkerRunOptions,
  events?: IEventWriter,
): Promise<AgentResult> {
  const requestedMaxTurns = options?.maxTurns ?? adapter.config.agent.maxTurns;
  const requestedMaxBudgetUsd = options?.maxBudgetUsd ?? adapter.config.agent.maxBudgetPerTask;
  const configuredTimeoutMs = adapter.config.agent.codex?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limitationNotice: AgentMessage = {
    role: "system",
    content:
      `Codex CLI limitation: Quack maxTurns=${requestedMaxTurns} and maxBudgetUsd=${requestedMaxBudgetUsd} ` +
      `are observational and are not enforced by this provider. timeoutMs=${configuredTimeoutMs} is the hard runtime ceiling; ` +
      "turnsUsed is parsed after completion, and totalCostUsd=0 means the CLI did not report USD cost, not that execution was free.",
    timestamp: new Date().toISOString(),
    turnNumber: 0,
  };
  const complete = (result: Omit<AgentResult, "taskId" | "totalCostUsd">): AgentResult => {
    const completeResult: AgentResult = {
      taskId,
      totalCostUsd: 0,
      ...result,
      messages: [...result.messages, limitationNotice],
    };
    events?.emit("agent_complete", {
      outcome: completeResult.outcome,
      turnsUsed: completeResult.turnsUsed,
      totalCostUsd: 0,
      filesModified: completeResult.filesModified,
      claudeSessionId: completeResult.claudeSessionId,
    });
    return completeResult;
  };

  let config: ResolvedCodexWorkerConfig;
  let before: WorkspaceSnapshot;
  try {
    config = resolveConfig(adapter.config.agent);
    config = {
      ...config,
      binaryPath: _trustedExecutableResolverFn(config.binaryPath, adapter.projectRoot, "Codex CLI"),
    };
    before = await _workspaceProbeFn(adapter.projectRoot, config.timeoutMs);
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: 0,
      messages: [],
      error: `Codex worker preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const model = options?.model ?? adapter.config.agent.model;
  let args: string[];
  try {
    args = buildCodexWorkerArgs({
      config,
      projectRoot: adapter.projectRoot,
      model,
      resumeSessionId: options?.resumeSessionId,
    });
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: 0,
      messages: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const prompt = options?.resumeSessionId
    ? (options.retryFeedback ??
      "Continue implementing the task from the current worktree state. Re-read the task and inspect the existing diff before making focused corrections.")
    : providerPrompt(taskId, context, adapter);

  let deniedPathGuard: CodexDeniedPathGuard;
  try {
    deniedPathGuard = await _deniedPathGuardFactory(adapter.projectRoot, adapter.config.sandbox);
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: 0,
      messages: [],
      error: `Codex denied-path preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let execution: CodexExecutionResult | undefined;
  let executionError: unknown;
  let deniedPathResult: DeniedPathGuardResult | undefined;
  let restorationError: unknown;
  try {
    execution = await executeCodex({
      config,
      args,
      prompt,
      projectRoot: adapter.projectRoot,
      events,
    });
  } catch (error: unknown) {
    executionError = error;
  }
  if (!execution?.descendantsContained) {
    return complete({
      outcome: execution?.timedOut ? "timeout" : "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: execution?.turnsUsed ?? 0,
      messages: execution?.messages ?? [],
      error:
        "Codex descendant containment could not be verified; protected paths remain quarantined: " +
        (execution?.error ??
          (executionError instanceof Error ? executionError.message : "unknown execution failure")),
      claudeSessionId: execution?.sessionId,
    });
  }
  try {
    deniedPathResult = await deniedPathGuard.finish();
  } catch (error: unknown) {
    restorationError = error;
  }
  if (restorationError) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: execution?.turnsUsed ?? 0,
      messages: execution?.messages ?? [],
      error: `Codex denied-path restoration failed: ${
        restorationError instanceof Error ? restorationError.message : "unknown restoration error"
      }`,
      claudeSessionId: execution?.sessionId,
    });
  }
  if (executionError) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: execution?.turnsUsed ?? 0,
      messages: execution?.messages ?? [],
      error: `Codex worker execution failed: ${
        executionError instanceof Error ? executionError.message : "unknown execution error"
      }`,
      claudeSessionId: execution?.sessionId,
    });
  }

  let after: WorkspaceSnapshot;
  try {
    after = await _workspaceProbeFn(adapter.projectRoot, config.timeoutMs);
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: [],
      filesCreated: [],
      verification: null,
      turnsUsed: execution.turnsUsed,
      messages: execution.messages,
      error: `Codex worker postflight failed: ${error instanceof Error ? error.message : String(error)}`,
      claudeSessionId: execution.sessionId,
    });
  }

  let touched = changedPaths(before, after);
  let created = touched.filter((file) => {
    const status = after.entries[file]?.status ?? "";
    return status === "??" || status.includes("A");
  });
  let modified = touched.filter((file) => !created.includes(file));
  const taskSpecPath = relativeTaskSpec(context, adapter.projectRoot);
  const collectSafetyErrors = (): string[] => {
    const errors: string[] = (deniedPathResult?.violations ?? []).map(
      (file) => `Codex wrote denied path (restored): ${file}`,
    );
    if (before.head !== after.head) errors.push("Codex changed git HEAD");
    if (before.branch !== after.branch) errors.push("Codex changed the checked-out branch");
    for (const file of touched) {
      if (taskSpecPath && file.toLowerCase() === taskSpecPath.toLowerCase()) {
        errors.push(`Codex modified the active task contract: ${file}`);
        continue;
      }
      const writeCheck = checkWritePath(file, adapter.config.sandbox, adapter.projectRoot);
      if (!writeCheck.allowed) errors.push(writeCheck.reason ?? `Write denied: ${file}`);
    }
    return errors;
  };
  let safetyErrors = collectSafetyErrors();

  if (!execution.ok || safetyErrors.length > 0) {
    return complete({
      outcome: execution.timedOut ? "timeout" : "failure",
      filesModified: modified,
      filesCreated: created,
      verification: null,
      turnsUsed: execution.turnsUsed,
      messages: execution.messages,
      error: [...(execution.error ? [execution.error] : []), ...safetyErrors].join(" | "),
      claudeSessionId: execution.sessionId,
    });
  }

  // The disposable dependency mirror is intentionally discarded by the
  // denied-path guard. If the worker changed an npm manifest, rebuild the
  // restored trusted dependency directory from that manifest before required
  // verification. Every affected package is installed in a private staging
  // directory and the trusted trees are swapped only after all installs pass.
  // The refresh disables lifecycle scripts and receives a stripped environment,
  // so worker-authored package scripts never inherit service credentials.
  const changedManifests = changedDependencyManifestPaths(touched);
  let refreshResult;
  try {
    // Always enter the refresh boundary. With no newly changed manifests it
    // is a cheap no-op, but it also recovers or fails closed on a transaction
    // abandoned by an earlier worker process before verification can begin.
    refreshResult = await _dependencyRefreshFn(adapter.projectRoot, changedManifests, events);
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: modified,
      filesCreated: created,
      verification: null,
      turnsUsed: execution.turnsUsed,
      messages: execution.messages,
      error: `Safe dependency refresh failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      claudeSessionId: execution.sessionId,
    });
  }
  if (!refreshResult.success) {
    const details = refreshResult.errors
      .map((error) => `${error.step}: ${error.message}`)
      .join(" | ");
    return complete({
      outcome: "failure",
      filesModified: modified,
      filesCreated: created,
      verification: null,
      turnsUsed: execution.turnsUsed,
      messages: execution.messages,
      error: `Safe dependency refresh failed: ${details}`,
      claudeSessionId: execution.sessionId,
    });
  }

  if (changedManifests.length > 0) {
    try {
      after = await _workspaceProbeFn(adapter.projectRoot, config.timeoutMs);
    } catch (error: unknown) {
      return complete({
        outcome: "failure",
        filesModified: modified,
        filesCreated: created,
        verification: null,
        turnsUsed: execution.turnsUsed,
        messages: execution.messages,
        error: `Codex worker dependency-refresh postflight failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        claudeSessionId: execution.sessionId,
      });
    }
    touched = changedPaths(before, after);
    created = touched.filter((file) => {
      const status = after.entries[file]?.status ?? "";
      return status === "??" || status.includes("A");
    });
    modified = touched.filter((file) => !created.includes(file));
    safetyErrors = collectSafetyErrors();
    if (safetyErrors.length > 0) {
      return complete({
        outcome: "failure",
        filesModified: modified,
        filesCreated: created,
        verification: null,
        turnsUsed: execution.turnsUsed,
        messages: execution.messages,
        error: safetyErrors.join(" | "),
        claudeSessionId: execution.sessionId,
      });
    }
  }

  let verification: VerificationResult | null = null;
  try {
    const parsedTask = (() => {
      try {
        return parseTaskFile(context.taskSpec);
      } catch {
        return undefined;
      }
    })();
    events?.emit("verification_start", {
      commandCount: adapter.config.verification.commands.length,
    });
    const verified = await verifyBeforeStop(adapter, { task: parsedTask });
    verification = verified.verification;
    const verificationCommands = verification.commands.map((command) => ({
      name: command.name,
      passed: command.passed,
      required: command.required,
      status: command.status,
    }));
    events?.emit("verification_result", {
      allPassed: verification.allPassed,
      commands: verificationCommands,
    });
    if (!verified.canStop) {
      return complete({
        outcome: "failure",
        filesModified: modified,
        filesCreated: created,
        verification,
        turnsUsed: execution.turnsUsed,
        messages: execution.messages,
        error: verified.feedback,
        claudeSessionId: execution.sessionId,
      });
    }
  } catch (error: unknown) {
    return complete({
      outcome: "failure",
      filesModified: modified,
      filesCreated: created,
      verification,
      turnsUsed: execution.turnsUsed,
      messages: execution.messages,
      error: `Codex worker verification failed: ${error instanceof Error ? error.message : String(error)}`,
      claudeSessionId: execution.sessionId,
    });
  }

  return complete({
    outcome: "success",
    filesModified: modified,
    filesCreated: created,
    verification,
    turnsUsed: execution.turnsUsed,
    messages: execution.messages,
    claudeSessionId: execution.sessionId,
  });
}
