// ─── Verify MCP Tool ────────────────────────────────────────────────
// Adapter-driven verification: runs project-specific tests, type-check,
// lint, and convention checks. Returns summarized results to the agent.
//
// Phase filtering: when the agent calls verify during work, only
// commands with phase "fast" or "all" are executed. "thorough" commands
// (full Docker suites) are reserved for post-judge verification only.

import {
  exec,
  spawn,
  type ChildProcess,
  type ExecException,
  type ExecOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ProjectAdapter } from "../../core/adapter-loader.js";
import {
  isStructuredVerificationCommand,
  verificationCommandShellString,
  type AdapterBundleMetadata,
  type AdapterFreshnessMetadata,
  type ParsedTask,
  type VerificationCommand,
  type ConventionCheck,
  type VerifyCommandResult,
  type VerificationResult,
} from "../../core/types.js";
import { summarizeOutput } from "./output-summarizer.js";
import { isDockerAvailable, run as dockerRun } from "../../testing/docker-test-runner.js";
import { analyzeTestOutput, isTestCommand } from "../../testing/test-output-analysis.js";
import {
  buildScopedTestCommand,
  collectScopedTestFiles,
} from "../../testing/scoped-test-command.js";
import {
  checkMachineryIntegrity,
  formatIntegrityFeedback,
  readAuthoritativeSafetyFloor,
  resolveAuthoritativeRoot,
} from "../../judgment/producers/machinery-integrity.js";

// ─── Command execution ────────────────────────────────────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandRuntime {
  command: string;
  env: NodeJS.ProcessEnv;
  shell?: string;
  error?: string;
}

interface CommandRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
}

interface ExecOutput {
  stdout: string;
  stderr: string;
}

interface VerificationRunOptions {
  /** Round-2 F8: sink for machinery-integrity mismatches (Stop hook wires events). */
  onIntegrityMismatch?: (mismatches: Array<{ path: string; reason: string }>) => void;
  runThorough?: boolean;
  includeOptional?: boolean;
  task?: ParsedTask;
  baseBranch?: string;
  authoritativeAdapterBundle?: AdapterBundleMetadata;
}

const WINDOWS_POSIX_TOOL_RE = /(?:^|[;&|()]\s*)(?:bash|sh|grep|sed|awk|xargs)\b/;

function commandNeedsWindowsPosixTools(command: string): boolean {
  return WINDOWS_POSIX_TOOL_RE.test(command.trim());
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function splitWindowsPathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function existingWindowsPosixDirs(
  env: NodeJS.ProcessEnv,
  existsSync: (filePath: string) => boolean,
): string[] {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const bashPath = env.QUACK_BASH_PATH;
  const rawCandidates = [
    ...splitWindowsPathList(env.QUACK_POSIX_BIN_DIR),
    bashPath ? path.win32.dirname(bashPath) : undefined,
    path.win32.join(programFiles, "Git", "usr", "bin"),
    path.win32.join(programFiles, "Git", "bin"),
    path.win32.join(programFilesX86, "Git", "usr", "bin"),
    path.win32.join(programFilesX86, "Git", "bin"),
    "C:\\msys64\\usr\\bin",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const unique = new Set<string>();
  const dirs: string[] = [];

  for (const candidate of rawCandidates) {
    const normalized = path.win32.normalize(candidate);
    const key = normalized.toLowerCase();
    if (unique.has(key)) continue;

    const hasUsefulTool =
      existsSync(path.win32.join(normalized, "bash.exe")) ||
      existsSync(path.win32.join(normalized, "sh.exe")) ||
      existsSync(path.win32.join(normalized, "grep.exe"));

    if (hasUsefulTool) {
      unique.add(key);
      dirs.push(normalized);
    }
  }

  return dirs;
}

function findWindowsBashPath(
  env: NodeJS.ProcessEnv,
  posixDirs: string[],
  existsSync: (filePath: string) => boolean,
): string | undefined {
  const configured = env.QUACK_BASH_PATH;
  if (configured && existsSync(configured)) return configured;

  for (const dir of posixDirs) {
    const candidate = path.win32.join(dir, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

export function prepareVerificationCommandRuntime(
  command: string,
  options: CommandRuntimeOptions = {},
): CommandRuntime {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;

  if (platform !== "win32" || !commandNeedsWindowsPosixTools(command)) {
    return { command, env };
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const posixDirs = existingWindowsPosixDirs(env, existsSync);

  if (posixDirs.length === 0) {
    return {
      command,
      env,
      error: [
        "POSIX verification tooling unavailable on Windows.",
        "This adapter command needs bash/grep/sed/awk-style tools, but Quack could not find Git Bash, MSYS2,",
        "or QUACK_POSIX_BIN_DIR/QUACK_BASH_PATH.",
        "Install Git for Windows or set QUACK_POSIX_BIN_DIR to a directory containing bash.exe/grep.exe.",
        "For exact host-specific guidance, run `pwsh -File scripts/admin/check-windows-shell-health.ps1` from the Quack repo.",
      ].join(" "),
    };
  }

  const key = pathEnvKey(env);
  const existingPath = env[key];
  env[key] = [posixDirs.join(path.win32.delimiter), existingPath]
    .filter(Boolean)
    .join(path.win32.delimiter);

  const shell = findWindowsBashPath(env, posixDirs, existsSync);
  if (!shell) {
    return {
      command,
      env,
      error: [
        "POSIX verification shell unavailable on Windows.",
        "Quack found POSIX tools but could not find bash.exe to run Unix-style quoted pipelines.",
        "Install Git for Windows or set QUACK_BASH_PATH to bash.exe.",
        "For exact host-specific guidance, run `pwsh -File scripts/admin/check-windows-shell-health.ps1` from the Quack repo.",
      ].join(" "),
    };
  }

  return { command, env, shell };
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      exec(`taskkill /F /T /PID ${pid}`, { windowsHide: true }, () => undefined);
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Best effort. The exec callback will still report the timeout.
  }
}

function normalizeVerificationTimeoutMs(timeout: number | undefined): number {
  const raw = timeout ?? 300_000;
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  // Historical generated adapters used seconds (60, 120, 300); docs and newer
  // adapters use milliseconds (60000, 120000). Support both shapes.
  return raw < 10_000 ? raw * 1000 : raw;
}

function execCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell?: string;
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const execOptions = {
      cwd: options.cwd,
      env: options.env,
      timeout: 0,
      maxBuffer: options.maxBuffer,
      detached: process.platform !== "win32",
      shell: options.shell,
      windowsHide: true,
    } as ExecOptions & { detached?: boolean };
    const child = exec(
      command,
      execOptions,
      (err: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        clearTimeout(timer);
        const stdoutText = String(stdout ?? "");
        const stderrText = String(stderr ?? "");
        if (err) {
          const enriched = Object.assign(err, {
            killed: timedOut || Boolean((err as Partial<ExecError>).killed),
            signal: timedOut ? "SIGTERM" : ((err as Partial<ExecError>).signal ?? null),
            stdout: stdoutText,
            stderr: stderrText,
          });
          reject(enriched);
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText });
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child?.pid);
    }, options.timeoutMs);
    timer.unref?.();
  });
}

async function runCommand(command: string, timeoutMs: number, cwd: string): Promise<ExecResult> {
  const runtime = prepareVerificationCommandRuntime(command);
  if (runtime.error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: runtime.error,
    };
  }

  try {
    const { stdout, stderr } = await execCommand(runtime.command, {
      cwd,
      env: runtime.env,
      shell: runtime.shell,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB to handle large test output
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    if (isExecError(err)) {
      // Check for timeout (killed signal)
      if (err.killed || err.signal === "SIGTERM") {
        return {
          exitCode: 1,
          stdout: err.stdout ?? "",
          stderr: `Command timed out after ${timeoutMs}ms`,
        };
      }
      return {
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }

    // Unknown error (e.g., command not found)
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Command execution error: ${message}`,
    };
  }
}

/**
 * Run a structured verification command via {@link spawn} with `shell: false`.
 * No shell parsing, no Windows POSIX-PATH fix-up. The bytes that reach the
 * executable are exactly `cmd` + `args[]`, so cross-platform behavior matches
 * regardless of host shell.
 *
 * Mirrors the legacy {@link runCommand} contract: returns ExecResult with
 * exit code, stdout, stderr; honors timeout (kills process tree on TERM);
 * caps buffer at maxBuffer and truncates with a marker if exceeded.
 */
async function runStructuredCommand(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let truncated = false;

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: `Spawn error: ${message}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);
    timer.unref?.();

    const appendCapped = (current: string, chunk: string): string => {
      if (truncated) return current;
      const next = current + chunk;
      if (next.length > options.maxBuffer) {
        truncated = true;
        killProcessTree(child.pid);
        return next.slice(0, options.maxBuffer) + "\n... [truncated]";
      }
      return next;
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendCapped(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCapped(stderr, String(chunk));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || `Spawn error: ${message}`,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          exitCode: 1,
          stdout,
          stderr: `Command timed out after ${options.timeoutMs}ms`,
        });
        return;
      }
      const exitCode = typeof code === "number" ? code : signal ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/**
 * Polymorphic dispatch for a {@link VerificationCommand}: structured commands
 * route through {@link runStructuredCommand} (no shell), legacy string
 * commands route through {@link runCommand} (existing shell-fixup path).
 */
async function runVerificationCommandShell(
  command: VerificationCommand,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  if (isStructuredVerificationCommand(command)) {
    const resolvedCwd = command.cwd ? path.resolve(cwd, command.cwd) : cwd;
    const env: NodeJS.ProcessEnv = command.env
      ? { ...process.env, ...command.env }
      : { ...process.env };
    return runStructuredCommand(command.cmd, command.args, {
      cwd: resolvedCwd,
      env,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  return runCommand(command.command, timeoutMs, cwd);
}

interface ExecError {
  code: number | null;
  killed: boolean;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null && "stdout" in err && "stderr" in err;
}

// ─── Verification runners ─────────────────────────────────────────

async function runVerificationCommand(
  cmd: VerificationCommand,
  cwd: string,
  options: { task?: ParsedTask; baseBranch?: string } = {},
): Promise<VerifyCommandResult> {
  // Shell-string view of the command for pattern matching, scoped-test
  // building, and human-readable evidence. Same value for both legacy and
  // structured forms.
  const cmdString = verificationCommandShellString(cmd);

  // Route Docker-environment commands to DockerTestRunner
  if (cmd.environment === "docker" && cmd.docker) {
    if (!isDockerAvailable()) {
      return {
        name: cmd.name,
        passed: true, // Warn but don't fail when Docker is unavailable
        output: `[Docker unavailable] Skipping Docker command "${cmd.name}" — Docker Desktop not running`,
      };
    }

    const dockerResult = dockerRun({
      composeFile: cmd.docker.composeFile,
      service: cmd.docker.service,
      command: cmdString,
      workDir: cwd,
      timeout: normalizeVerificationTimeoutMs(cmd.timeout),
      dependsOn: cmd.docker.dependsOn,
    });

    const combinedOutput = [dockerResult.stdout, dockerResult.stderr].filter(Boolean).join("\n");
    const testAnalysis = isTestCommand(cmd.name, cmdString)
      ? analyzeTestOutput(combinedOutput)
      : undefined;
    const passed =
      dockerResult.exitCode === 0 && !(cmd.required !== false && testAnalysis?.explicitNoTests);
    const output = summarizeOutput(combinedOutput, passed);
    return {
      name: cmd.name,
      passed,
      output:
        testAnalysis?.explicitNoTests && cmd.required !== false
          ? "Verification command reported zero tests. Required test commands cannot pass with 0/0 coverage."
          : output,
    };
  }

  // Default: run on host. Polymorphic — structured commands take the spawn
  // path (no shell), legacy take the existing exec+shell-fixup path.
  const timeoutMs = normalizeVerificationTimeoutMs(cmd.timeout);
  const result = await runVerificationCommandShell(cmd, cwd, timeoutMs);
  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const testAnalysis = isTestCommand(cmd.name, cmdString)
    ? analyzeTestOutput(result.stdout, result.stderr)
    : undefined;

  if (result.exitCode !== 0 && cmd.required !== false && isTestCommand(cmd.name, cmdString)) {
    const testFiles = collectScopedTestFiles(options.task, cwd, options.baseBranch ?? "main");
    const scopedCommand = buildScopedTestCommand(cmdString, testFiles);

    if (scopedCommand) {
      // Scoped retries always go through the legacy shell path because the
      // scoped-command builder produces a shell string.
      const scopedResult = await runCommand(scopedCommand, timeoutMs, cwd);
      const scopedOutput = [scopedResult.stdout, scopedResult.stderr].filter(Boolean).join("\n");
      const scopedAnalysis = analyzeTestOutput(scopedResult.stdout, scopedResult.stderr);

      if (scopedResult.exitCode === 0 && !scopedAnalysis.explicitNoTests) {
        const output = summarizeOutput(scopedOutput, true);
        return {
          name: cmd.name,
          passed: true,
          output: [
            `Full test command failed, but scoped task tests passed via: ${scopedCommand}`,
            "Treating full-suite failure as pre-existing drift for this task.",
            output,
          ].join("\n"),
        };
      }
    }
  }

  const passed =
    result.exitCode === 0 && !(cmd.required !== false && testAnalysis?.explicitNoTests);
  const output = summarizeOutput(combinedOutput, passed);

  return {
    name: cmd.name,
    passed,
    output:
      testAnalysis?.explicitNoTests && cmd.required !== false
        ? "Verification command reported zero tests. Required test commands cannot pass with 0/0 coverage."
        : output,
  };
}

async function runConventionCheck(
  check: ConventionCheck,
  cwd: string,
): Promise<VerifyCommandResult> {
  const result = await runCommand(check.command, 30_000, cwd);
  const passed = result.exitCode === 0;

  let output: string;
  if (passed) {
    output = `Convention check passed (${check.conventionRef})`;
  } else {
    // For convention checks, stderr typically contains the violation details
    const details = result.stderr || result.stdout || "Convention violation detected";
    output = `Convention violation [${check.conventionRef}]: ${details}`.trim();
    // Truncate if needed
    if (output.length > 2000) {
      output = output.slice(0, 1970) + "\n... [output truncated]";
    }
  }

  return {
    name: check.name,
    passed,
    output,
  };
}

// ─── Main verification function ───────────────────────────────────

/**
 * Filter verification commands by phase.
 * - Worker agent (default): only "fast" and "all" phases run
 * - Post-judge: all phases run (fast + thorough + all)
 */
function filterByPhase(
  commands: VerificationCommand[],
  runThorough: boolean,
): VerificationCommand[] {
  if (runThorough) return commands;
  // Commands without a phase default to "all" (backward compatible)
  return commands.filter((c) => !c.phase || c.phase === "fast" || c.phase === "all");
}

function evaluateAdapterFreshness(
  adapter: ProjectAdapter,
  authoritativeBundle: AdapterBundleMetadata | undefined,
): AdapterFreshnessMetadata | undefined {
  if (!authoritativeBundle) return undefined;

  const localHash = adapter.adapterBundle?.sharedHash;
  const authoritativeHash = authoritativeBundle.sharedHash;
  if (!localHash) {
    return {
      status: "unknown",
      authoritativeHash,
      reason: "Local adapter bundle metadata is unavailable.",
    };
  }
  if (localHash !== authoritativeHash) {
    return {
      status: "stale",
      localHash,
      authoritativeHash,
      reason: "Local adapter bundle hash differs from the authoritative bundle hash.",
    };
  }
  return {
    status: "fresh",
    localHash,
    authoritativeHash,
  };
}

export async function runVerification(
  adapter: ProjectAdapter,
  scope: string,
  options?: VerificationRunOptions,
): Promise<VerificationResult> {
  const cwd = adapter.projectRoot;
  const verificationConfig = adapter.config.verification;

  // ── Machinery-integrity barrier (TASK-1313 S3) ────────────────────
  // Mounted HERE, not only in the Stop hook: the in-session MCP verify
  // tool reaches this executor directly, and tampered machinery must be
  // caught before any adapter command runs. Config is read from the
  // AUTHORITATIVE root (never the worktree copy); non-worktree roots
  // self-compare and are structurally clean, so CLI/API verification on
  // ordinary clones is unaffected.
  const authoritativeRoot = resolveAuthoritativeRoot(cwd);
  if (path.resolve(authoritativeRoot) !== path.resolve(cwd)) {
    const floorConfig = await readAuthoritativeSafetyFloor(authoritativeRoot);
    if (floorConfig.preVerificationIntegrityMode !== "off") {
      const integrity = await checkMachineryIntegrity(cwd, authoritativeRoot);
      if (!integrity.clean) {
        // Round-2 F8: surface the finding to any caller-supplied sink
        // (the Stop hook passes the session event writer).
        try {
          options?.onIntegrityMismatch?.(integrity.mismatches);
        } catch {
          // Observability only — never verification-fatal.
        }
        const feedback = formatIntegrityFeedback(integrity);
        if (floorConfig.preVerificationIntegrityMode === "enforce") {
          return {
            allPassed: false,
            commands: [
              {
                name: "machinery-integrity",
                passed: false,
                output: feedback,
              },
            ],
            conventionChecks: [],
          };
        }
        // warn: verification proceeds; the finding rides along visibly.
        const warned = await runVerificationBody();
        return {
          ...warned,
          commands: [
            {
              name: "machinery-integrity",
              passed: true,
              output: `WARN (not blocking): ${feedback}`,
            },
            ...warned.commands,
          ],
        };
      }
    }
  }
  return runVerificationBody();

  async function runVerificationBody(): Promise<VerificationResult> {
    const runThorough = options?.runThorough ?? false;
    const includeOptional = options?.includeOptional ?? true;
    const baseBranch = options?.baseBranch ?? adapter.config.git?.baseBranch ?? "main";
    const adapterFreshness = evaluateAdapterFreshness(adapter, options?.authoritativeAdapterBundle);

    let commandsToRun: VerificationCommand[];
    let checksToRun: ConventionCheck[];

    if (scope === "blocker") {
      // Worker self-bailed via Stuck-Loop Detection.
      // Treat as a clean stop — allPassed: true so the dispatcher does NOT
      // mark the run as a verification failure. The blocker context is in the
      // worker's PROGRESS.md and messages; the judge will evaluate it.
      return {
        allPassed: true,
        commands: [
          {
            name: "blocker",
            passed: true,
            output:
              "Worker reported a stuck-loop blocker. Treating as a clean stop for judge evaluation.",
          },
        ],
        conventionChecks: [],
        adapterFreshness,
      };
    }

    if (adapterFreshness?.status === "stale") {
      return {
        allPassed: false,
        commands: [
          {
            name: "adapter-freshness",
            passed: false,
            output:
              `Blocked stale adapter bundle: local ${adapterFreshness.localHash ?? "unknown"} ` +
              `does not match authoritative ${adapterFreshness.authoritativeHash ?? "unknown"}.`,
          },
        ],
        conventionChecks: [],
        adapterFreshness,
      };
    }

    if (scope === "all") {
      commandsToRun = filterByPhase(verificationConfig.commands, runThorough);
      if (!includeOptional) {
        commandsToRun = commandsToRun.filter((command) => command.required !== false);
      }
      checksToRun = verificationConfig.conventionChecks;
    } else {
      // Find matching command or convention check by name
      const matchingCommand = verificationConfig.commands.find((c) => c.name === scope);
      const matchingCheck = verificationConfig.conventionChecks.find((c) => c.name === scope);

      if (!matchingCommand && !matchingCheck) {
        const allNames = [
          ...verificationConfig.commands.map((c) => c.name),
          ...verificationConfig.conventionChecks.map((c) => c.name),
        ];
        return {
          allPassed: false,
          commands: [
            {
              name: scope,
              passed: false,
              output: `Unknown verification command "${scope}". Available: ${allNames.join(", ")}`,
            },
          ],
          conventionChecks: [],
          adapterFreshness,
        };
      }

      commandsToRun = matchingCommand ? [matchingCommand] : [];
      checksToRun = matchingCheck ? [matchingCheck] : [];
    }

    // Run all verification commands
    const commandResults: VerifyCommandResult[] = [];
    for (const cmd of commandsToRun) {
      const result = await runVerificationCommand(cmd, cwd, {
        task: options?.task,
        baseBranch,
      });
      commandResults.push(result);
    }

    // Run all convention checks
    const checkResults: VerifyCommandResult[] = [];
    for (const check of checksToRun) {
      const result = await runConventionCheck(check, cwd);
      checkResults.push(result);
    }

    const commandsPassed = commandResults.every((result, index) => {
      const command = commandsToRun[index];
      return command?.required === false || result.passed;
    });
    const allPassed = commandsPassed && checkResults.every((r) => r.passed);

    return {
      allPassed,
      commands: commandResults,
      conventionChecks: checkResults,
      adapterFreshness,
    };
  }
}

// ─── Result formatting ────────────────────────────────────────────

export function formatVerificationResult(result: VerificationResult): string {
  const lines: string[] = [];

  lines.push(result.allPassed ? "VERIFICATION PASSED" : "VERIFICATION FAILED");
  lines.push("");

  if (result.adapterFreshness) {
    lines.push(
      `Adapter freshness: ${result.adapterFreshness.status}` +
        (result.adapterFreshness.localHash ? ` local=${result.adapterFreshness.localHash}` : "") +
        (result.adapterFreshness.authoritativeHash
          ? ` authoritative=${result.adapterFreshness.authoritativeHash}`
          : ""),
    );
    lines.push("");
  }

  if (result.commands.length > 0) {
    lines.push("Commands:");
    for (const cmd of result.commands) {
      const status = cmd.passed ? "PASS" : "FAIL";
      lines.push(`  [${status}] ${cmd.name}: ${cmd.output}`);
    }
  }

  if (result.conventionChecks.length > 0) {
    lines.push("");
    lines.push("Convention Checks:");
    for (const check of result.conventionChecks) {
      const status = check.passed ? "PASS" : "FAIL";
      lines.push(`  [${status}] ${check.name}: ${check.output}`);
    }
  }

  return lines.join("\n");
}

// ─── Tool definition factory ──────────────────────────────────────

/**
 * Create the verify MCP tool definition for the given adapter.
 *
 * Returns a tool definition compatible with the Claude Agent SDK's
 * `createSdkMcpServer()`. The tool accepts a `scope` parameter:
 * - "all": runs all verification commands + all convention checks
 * - specific name: runs only that command or convention check
 */
export function createVerifyToolDefinition(
  adapter: ProjectAdapter,
  options?: { task?: ParsedTask },
) {
  // We need to dynamically import the SDK since it's ESM-only.
  // The tool factory returns the definition object; the actual SDK
  // imports happen at server creation time in server.ts.
  const allCommandNames = [
    ...adapter.config.verification.commands.map((c) => c.name),
    ...adapter.config.verification.conventionChecks.map((c) => c.name),
  ];

  const scopeDescription = `"all" to run everything, "blocker" to report a stuck-loop bail-out (clean stop for judge evaluation), or one of: ${allCommandNames.join(", ")}`;

  return {
    name: "verify",
    description:
      "Run the project's verification suite (tests, type-check, lint, convention checks). " +
      "Call this before finishing to ensure all checks pass.",
    scopeDescription,
    handler: async (scope: string): Promise<string> => {
      const result = await runVerification(adapter, scope, { task: options?.task });
      return formatVerificationResult(result);
    },
  };
}
