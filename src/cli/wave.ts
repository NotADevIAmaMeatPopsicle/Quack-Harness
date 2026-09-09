// ─── CLI: quack wave ─────────────────────────────────────────────────
// Execute the current dependency-ready frontier with bounded concurrency.
// Each task is started through DispatchManager, which normally creates an
// isolated worktree and safely serializes its shared-checkout fallback.

import * as fsSync from "node:fs";
import * as path from "node:path";

import { loadAdapter, type ProjectAdapter } from "../core/adapter-loader.js";
import type { TaskSelection } from "../core/types.js";
import type { DuplicateClaimantCheck } from "../core/duplicate-claimants.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";
import { loadStatusOverlay, resolveDependencies } from "../dispatcher/dependency-resolver.js";
import { selectTasks } from "../dispatcher/task-selector.js";
import {
  DegradedSharedCheckoutBusyError,
  DispatchManager,
  type DispatchJob,
  type DispatchShutdownOptions,
  type DispatchShutdownResult,
  type StartOptions,
} from "../monitor/dispatch-manager.js";

export type WaveSignal = "SIGINT" | "SIGTERM";
type WaveSignalListener = () => void;

export interface WaveDispatchManager {
  start(
    taskId: string,
    options?: StartOptions,
    claimantCheck?: DuplicateClaimantCheck,
  ): DispatchJob;
  getJob(taskId: string): DispatchJob | undefined;
  getSharedCheckoutOccupants(): DispatchJob[];
  isWorktreeDegraded(): boolean;
  shutdownAll(options?: DispatchShutdownOptions): Promise<DispatchShutdownResult>;
  startWatchdog(): void;
  stopWatchdog(): void;
}

export interface WaveTaskResult {
  taskId: string;
  status: DispatchJob["status"] | "start_failed";
  exitCode?: number;
  error?: string;
}

export interface WaveCommandRuntime {
  createManager?: (adapter: ProjectAdapter, taskDir: string) => WaveDispatchManager;
  pollIntervalMs?: number;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  /** Force termination only after bounded cleanup reports a surviving child. */
  exitProcess?: (code: number) => void;
  addSignalListener?: (signal: WaveSignal, listener: WaveSignalListener) => void;
  removeSignalListener?: (signal: WaveSignal, listener: WaveSignalListener) => void;
  signalCleanupTimeoutMs?: number;
}

export type WaveRunOutcome =
  | { interrupted: false; results: WaveTaskResult[] }
  | { interrupted: true; signal: WaveSignal; cleanupTimedOut: boolean };

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalResult(job: DispatchJob): WaveTaskResult {
  const lastOutput = [...job.output].reverse().find((line) => line.trim().length > 0);
  return {
    taskId: job.taskId,
    status: job.status,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.status !== "completed" && lastOutput ? { error: lastOutput } : {}),
  };
}

async function waitForTerminalJob(
  manager: WaveDispatchManager,
  initialJob: DispatchJob,
  pollIntervalMs: number,
  shouldStop?: () => boolean,
): Promise<WaveTaskResult> {
  let job: DispatchJob | undefined = initialJob;
  while (job.status === "running") {
    if (shouldStop?.()) {
      return {
        taskId: initialJob.taskId,
        status: "stopped",
        error: "Wave interrupted while dispatch cleanup was in progress",
      };
    }
    let remainingDelay = pollIntervalMs;
    while (remainingDelay > 0 && !shouldStop?.()) {
      const slice = Math.min(remainingDelay, 25);
      await delay(slice);
      remainingDelay -= slice;
    }
    if (shouldStop?.()) {
      return {
        taskId: initialJob.taskId,
        status: "stopped",
        error: "Wave interrupted while dispatch cleanup was in progress",
      };
    }
    job = manager.getJob(initialJob.taskId);
    if (!job) {
      return {
        taskId: initialJob.taskId,
        status: "start_failed",
        error: "Dispatch job disappeared before reaching a terminal state",
      };
    }
  }
  return terminalResult(job);
}

/**
 * Execute every selected task with at most `parallelCount` active children.
 * Result slots follow selection order, not completion order, so failures are
 * reported deterministically. Each worker catches its own failure and keeps
 * consuming work; one task can never terminate its siblings early.
 */
export async function executeSelectedWaveTasks(
  selections: readonly TaskSelection[],
  parallelCount: number,
  manager: WaveDispatchManager,
  waveNumber: string,
  pollIntervalMs = 250,
  resolveClaimantCheck?: (taskId: string) => Promise<DuplicateClaimantCheck>,
  shouldStop?: () => boolean,
): Promise<WaveTaskResult[]> {
  const results = new Array<WaveTaskResult>(selections.length);
  let nextIndex = 0;

  const waitForSafeStart = async (taskId: string): Promise<void> => {
    while (manager.isWorktreeDegraded()) {
      if (shouldStop?.()) return;
      const occupants = manager.getSharedCheckoutOccupants();
      const unresolved = occupants.filter((job) => job.status !== "running");
      if (unresolved.length > 0) {
        throw new DegradedSharedCheckoutBusyError(taskId, occupants);
      }
      if (occupants.length === 0) return;
      await delay(pollIntervalMs);
    }
  };

  const runWorker = async (): Promise<void> => {
    while (nextIndex < selections.length) {
      if (shouldStop?.()) return;
      const index = nextIndex++;
      const selection = selections[index];

      try {
        // DispatchManager deliberately falls back to the shared directory
        // when worktree creation fails. In that degraded state it exposes a
        // guard that forbids parallel starts. Wait for a live child; an
        // approval-paused shared checkout fails later admission immediately.
        await waitForSafeStart(selection.taskId);
        if (shouldStop?.()) return;

        let job: DispatchJob | undefined;
        while (!job) {
          await waitForSafeStart(selection.taskId);
          if (shouldStop?.()) return;

          // Refresh this evidence on every retry. Another worker can hold the
          // degraded checkout while task files change, so reusing the scan
          // that preceded the wait would make duplicate-claimant admission
          // stale at the exact point start() finally proceeds.
          const claimantCheck = resolveClaimantCheck
            ? await resolveClaimantCheck(selection.taskId)
            : undefined;
          if (shouldStop?.()) return;

          // The claimant scan is asynchronous. Another worker can degrade the
          // manager while this worker is awaiting it, so re-check immediately
          // before the synchronous start call.
          await waitForSafeStart(selection.taskId);
          if (shouldStop?.()) return;
          try {
            job = manager.start(
              selection.taskId,
              {
                provenance: {
                  channel: "cli",
                  principal: `quack-wave:${waveNumber}`,
                },
              },
              claimantCheck,
            );
            break;
          } catch (err: unknown) {
            // The precheck and start() are separated by an async boundary.
            // If a sibling degrades isolation in that gap, the manager's
            // typed refusal is authoritative. A live occupant is retryable;
            // an approval pause requires operator action and fails promptly.
            if (err instanceof DegradedSharedCheckoutBusyError && !err.hasUnresolvedOccupant) {
              await delay(pollIntervalMs);
              if (shouldStop?.()) return;
              continue;
            }
            throw err;
          }
        }
        results[index] = await waitForTerminalJob(manager, job, pollIntervalMs, shouldStop);
      } catch (err: unknown) {
        results[index] = {
          taskId: selection.taskId,
          status: "start_failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  const workerCount = Math.min(parallelCount, selections.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * Own signal registration and manager shutdown for one wave execution.
 * Cleanup is once-only and the wait for worker settlement is bounded; this
 * never calls process.exit, allowing the command's normal finally path to run.
 */
export async function runWaveWithSignalCleanup(
  manager: WaveDispatchManager,
  operation: (isCancelled: () => boolean) => Promise<WaveTaskResult[]>,
  runtime: Pick<
    WaveCommandRuntime,
    "addSignalListener" | "removeSignalListener" | "signalCleanupTimeoutMs"
  > = {},
): Promise<WaveRunOutcome> {
  const addSignalListener =
    runtime.addSignalListener ??
    ((signal: WaveSignal, listener: WaveSignalListener) => {
      process.once(signal, listener);
    });
  const removeSignalListener =
    runtime.removeSignalListener ??
    ((signal: WaveSignal, listener: WaveSignalListener) => {
      process.off(signal, listener);
    });
  const cleanupTimeoutMs = runtime.signalCleanupTimeoutMs ?? 2_000;

  let interruptedBy: WaveSignal | undefined;
  let shutdownResult:
    | Promise<
        | { kind: "shutdown"; result: DispatchShutdownResult }
        | { kind: "shutdown_failed"; error: unknown }
      >
    | undefined;
  let resolveSignal!: (signal: WaveSignal) => void;
  const signalPromise = new Promise<{ kind: "signal"; signal: WaveSignal }>((resolve) => {
    resolveSignal = (signal) => resolve({ kind: "signal", signal });
  });

  const requestCleanup = (signal: WaveSignal): void => {
    if (interruptedBy) return;
    interruptedBy = signal;
    const phaseTimeoutMs = Math.max(1, Math.floor(cleanupTimeoutMs / 2));
    shutdownResult = manager
      .shutdownAll({
        gracefulTimeoutMs: phaseTimeoutMs,
        forceTimeoutMs: Math.max(1, cleanupTimeoutMs - phaseTimeoutMs),
      })
      .then(
        (result) => ({ kind: "shutdown" as const, result }),
        (error: unknown) => ({ kind: "shutdown_failed" as const, error }),
      );
    resolveSignal(signal);
  };

  const onSigint = (): void => requestCleanup("SIGINT");
  const onSigterm = (): void => requestCleanup("SIGTERM");
  addSignalListener("SIGINT", onSigint);
  addSignalListener("SIGTERM", onSigterm);
  let watchdogStarted = false;

  try {
    manager.startWatchdog();
    watchdogStarted = true;
    const operationResult = Promise.resolve()
      .then(() => operation(() => interruptedBy !== undefined))
      .then(
        (results) => ({ kind: "completed" as const, results }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );

    const first = await Promise.race([operationResult, signalPromise]);
    if (first.kind === "completed") return { interrupted: false, results: first.results };
    if (first.kind === "failed") throw first.error;

    // Bound only the cooperative wave workers here. DispatchManager owns the
    // bounded TERM/KILL/Docker cleanup sequence and must always reach its
    // durable survivor/ownership writes before this function can authorize a
    // forced process exit.
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    const operationSettlement = Promise.race([
      operationResult,
      new Promise<{ kind: "timeout" }>((resolve) => {
        operationTimer = setTimeout(() => resolve({ kind: "timeout" }), cleanupTimeoutMs);
      }),
    ]);
    const shutdown = await shutdownResult!;
    const operationOutcome = await operationSettlement;
    if (operationTimer) clearTimeout(operationTimer);
    const managerTimedOut = shutdown.kind === "shutdown" && shutdown.result.timedOut.length > 0;
    return {
      interrupted: true,
      signal: first.signal,
      cleanupTimedOut:
        operationOutcome.kind === "timeout" ||
        shutdown.kind === "shutdown_failed" ||
        managerTimedOut,
    };
  } finally {
    removeSignalListener("SIGINT", onSigint);
    removeSignalListener("SIGTERM", onSigterm);
    if (watchdogStarted) manager.stopWatchdog();
  }
}

/** A wave is successful only when every selected dispatch completed cleanly. */
export function waveExitCode(results: readonly WaveTaskResult[], parseErrorCount: number): number {
  return parseErrorCount === 0 && results.every((result) => result.status === "completed") ? 0 : 1;
}

function formatResult(result: WaveTaskResult): string[] {
  if (result.status === "completed") {
    return [
      `  [OK] ${result.taskId}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`,
    ];
  }
  const lines = [
    `  [${result.status.toUpperCase()}] ${result.taskId}` +
      `${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`,
  ];
  if (result.error) lines.push(`    ${result.error}`);
  return lines;
}

function defaultManager(adapter: ProjectAdapter, taskDir: string): WaveDispatchManager {
  const quackBin = path.resolve(__dirname, "..", "index.js");
  const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
  return new DispatchManager(
    adapter.projectRoot,
    quackBin,
    adapter.config.isolation,
    undefined,
    logDir,
    async (taskId) => ({
      taskId,
      claimants: await listDuplicateClaimants(taskDir, taskId),
    }),
  );
}

function writeSync(fd: 1 | 2, text: string): void {
  fsSync.writeSync(fd, text.endsWith("\n") ? text : `${text}\n`);
}

export async function waveCommand(
  waveNumber: string,
  options: { parallel: string; project?: string },
  runtime: WaveCommandRuntime = {},
): Promise<void> {
  const writeStdout = runtime.writeStdout ?? ((text: string) => writeSync(1, text));
  const writeStderr = runtime.writeStderr ?? ((text: string) => writeSync(2, text));
  const setExitCode =
    runtime.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    parsePositiveInteger(waveNumber, "waveNumber");
    const parallelCount = parsePositiveInteger(options.parallel, "--parallel");
    const projectPath = options.project ?? process.cwd();
    const adapter = await loadAdapter(projectPath);
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

    const statusOverlay = loadStatusOverlay(adapter.projectRoot);
    const resolution = await resolveDependencies(taskDir, { statusOverlay });
    const selections = selectTasks(resolution.eligible);
    const parseErrors = [...resolution.errors].sort(
      (left, right) => left.file.localeCompare(right.file) || left.error.localeCompare(right.error),
    );

    const plan: string[] = [
      `\nWave ${waveNumber} — ${adapter.config.project.name}`,
      "=".repeat(40),
      "",
    ];
    if (statusOverlay) {
      plan.push(
        `Status overlay: .quack/quack.db (${statusOverlay.size} rows; db wins over spec)`,
        "",
      );
    }
    if (parseErrors.length > 0) {
      plan.push("Parse errors:");
      for (const error of parseErrors) {
        plan.push(`  ${error.file}: ${error.error}`);
      }
      plan.push("");
    }
    plan.push(`Eligible tasks: ${selections.length}`);
    plan.push(`Blocked tasks: ${resolution.blocked.length}`);
    plan.push(`Parallel limit: ${parallelCount}`, "");

    if (selections.length === 0) {
      plan.push("No eligible tasks found for this wave.", "");
      writeStdout(plan.join("\n"));
      setExitCode(waveExitCode([], parseErrors.length));
      return;
    }

    plan.push("Dispatching:");
    for (const selection of selections) {
      plan.push(
        `  ${selection.taskId} [${selection.priority}] — ` +
          `effort: ${selection.effort}, fit: ${selection.estimatedAgentFit}, ` +
          `readiness: ${selection.readinessScore}`,
      );
    }
    plan.push("");
    writeStdout(plan.join("\n"));

    const manager = (runtime.createManager ?? defaultManager)(adapter, taskDir);
    const outcome = await runWaveWithSignalCleanup(
      manager,
      (isCancelled) =>
        executeSelectedWaveTasks(
          selections,
          parallelCount,
          manager,
          waveNumber,
          runtime.pollIntervalMs,
          async (taskId) => ({
            taskId,
            claimants: await listDuplicateClaimants(taskDir, taskId),
          }),
          isCancelled,
        ),
      runtime,
    );
    if (outcome.interrupted) {
      const timeoutNote = outcome.cleanupTimedOut
        ? " Worker shutdown reported unresolved resources after bounded cleanup."
        : "";
      writeStderr(
        `Wave interrupted by ${outcome.signal}; dispatch cleanup requested.${timeoutNote}`,
      );
      const signalExitCode = outcome.signal === "SIGINT" ? 130 : 143;
      setExitCode(signalExitCode);
      if (outcome.cleanupTimedOut) {
        (runtime.exitProcess ?? ((code: number) => process.exit(code)))(signalExitCode);
      }
      return;
    }
    const results = outcome.results;

    const completed = results.filter((result) => result.status === "completed").length;
    const report = ["Wave results:"];
    for (const result of results) report.push(...formatResult(result));
    report.push(
      "",
      `Summary: ${completed}/${results.length} completed; ${results.length - completed} incomplete or failed.`,
      "",
    );
    writeStdout(report.join("\n"));
    setExitCode(waveExitCode(results, parseErrors.length));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`Error: ${message}`);
    setExitCode(1);
  }
}
