import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  executeSelectedWaveTasks,
  runWaveWithSignalCleanup,
  waveCommand,
  waveExitCode,
  type WaveDispatchManager,
  type WaveTaskResult,
  type WaveSignal,
} from "../../src/cli/wave";
import {
  DegradedSharedCheckoutBusyError,
  type DispatchJob,
  type DispatchShutdownOptions,
  type DispatchShutdownResult,
} from "../../src/monitor/dispatch-manager";
import type { TaskSelection } from "../../src/core/types";

function selection(taskId: string, priority: TaskSelection["priority"] = "P1-HIGH"): TaskSelection {
  return {
    taskId,
    priority,
    effort: "1 hour",
    blockedBy: [],
    conventions: [],
    hasTestCriteria: true,
    readinessScore: 90,
    estimatedAgentFit: "high",
  };
}

class FakeDispatchManager implements WaveDispatchManager {
  readonly jobs = new Map<string, DispatchJob>();
  readonly starts: string[] = [];
  readonly claimantCounts: number[] = [];
  readonly stops: string[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  maxActive = 0;
  shutdownAllCalls = 0;
  watchdogStarted = false;
  watchdogStopped = false;

  constructor(
    private readonly outcomes: Record<
      string,
      "completed" | "failed" | "throw" | "awaiting_approval"
    > = {},
    private readonly delayMs = 0,
    private readonly onStart?: (taskId: string) => void,
  ) {}

  start(
    taskId: string,
    options?: Parameters<WaveDispatchManager["start"]>[1],
    claimantCheck?: Parameters<WaveDispatchManager["start"]>[2],
  ): DispatchJob {
    this.starts.push(taskId);
    this.claimantCounts.push(claimantCheck?.claimants.length ?? 0);
    expect(options?.provenance).toEqual({
      channel: "cli",
      principal: "quack-wave:1",
    });
    if (this.outcomes[taskId] === "throw") {
      throw new Error(`could not start ${taskId}`);
    }

    const job: DispatchJob = {
      taskId,
      sessionId: `session-${taskId}`,
      pid: this.starts.length,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    };
    this.jobs.set(taskId, job);
    this.maxActive = Math.max(this.maxActive, this.getActiveJobs().length);
    this.onStart?.(taskId);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      const outcome = this.outcomes[taskId];
      const failed = outcome === "failed";
      job.status =
        outcome === "awaiting_approval" ? "awaiting_approval" : failed ? "failed" : "completed";
      job.exitCode = failed || outcome === "awaiting_approval" ? 1 : 0;
      if (failed) job.output.push(`deterministic failure for ${taskId}`);
    }, this.delayMs);
    this.timers.set(taskId, timer);
    return job;
  }

  getJob(taskId: string): DispatchJob | undefined {
    return this.jobs.get(taskId);
  }

  getActiveJobs(): DispatchJob[] {
    return [...this.jobs.values()].filter((job) => job.status === "running");
  }

  getSharedCheckoutOccupants(): DispatchJob[] {
    return [...this.jobs.values()].filter(
      (job) =>
        !job.worktreePath && (job.status === "running" || job.status === "awaiting_approval"),
    );
  }

  isWorktreeDegraded(): boolean {
    return false;
  }

  stop(taskId: string): boolean {
    const job = this.jobs.get(taskId);
    if (!job || (job.status !== "running" && job.status !== "awaiting_approval")) return false;
    this.stops.push(taskId);
    job.status = "stopped";
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    return true;
  }

  shutdownAll(_options?: DispatchShutdownOptions): Promise<DispatchShutdownResult> {
    this.shutdownAllCalls += 1;
    const requested: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "awaiting_approval") continue;
      requested.push(job.taskId);
      this.stop(job.taskId);
    }
    return Promise.resolve({ requested, exited: requested, escalated: [], timedOut: [] });
  }

  startWatchdog(): void {
    this.watchdogStarted = true;
  }

  stopWatchdog(): void {
    this.watchdogStopped = true;
  }
}

class DegradingDispatchManager extends FakeDispatchManager {
  private degraded = false;
  busyRefusals = 0;

  constructor(
    private readonly onFirstStart: () => void,
    outcomes: Record<string, "completed" | "failed" | "throw" | "awaiting_approval"> = {},
  ) {
    super(outcomes, 5);
  }

  override start(
    taskId: string,
    options?: Parameters<WaveDispatchManager["start"]>[1],
    claimantCheck?: Parameters<WaveDispatchManager["start"]>[2],
  ): DispatchJob {
    const occupants = this.getSharedCheckoutOccupants();
    if (this.degraded && occupants.length > 0) {
      this.busyRefusals += 1;
      throw new DegradedSharedCheckoutBusyError(taskId, occupants);
    }

    const job = super.start(taskId, options, claimantCheck);
    if (!this.degraded) {
      this.degraded = true;
      this.onFirstStart();
    }
    return job;
  }

  override isWorktreeDegraded(): boolean {
    return this.degraded;
  }
}

class ClaimantGuardedDegradingManager extends DegradingDispatchManager {
  override start(
    taskId: string,
    options?: Parameters<WaveDispatchManager["start"]>[1],
    claimantCheck?: Parameters<WaveDispatchManager["start"]>[2],
  ): DispatchJob {
    if ((claimantCheck?.claimants.length ?? 0) > 1) {
      throw new Error(`duplicate claimants for ${taskId}`);
    }
    return super.start(taskId, options, claimantCheck);
  }
}

function adapterJson(): string {
  return JSON.stringify({
    version: "1.0.0",
    project: {
      name: "wave-fixture",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 30,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
  });
}

function taskDoc(taskId: string, priority: string, blockedBy: string[] = []): string {
  return `# ${taskId}: Wave fixture

## Metadata
- **Priority:** ${priority}
- **Effort:** 1 hour
- **Status:** BACKLOG
- **Blocked By:** [${blockedBy.join(", ")}]
- **Blocks:** []
- **Tags:** wave

## Problem Statement
Exercise the wave runner.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/${taskId}.ts | Create | Fixture |

## Success Criteria
- [ ] The fixture is complete

## Testing Requirements
- [ ] The fixture is tested
`;
}

describe("executeSelectedWaveTasks", () => {
  it("honors the parallel limit, reports in selection order, and continues after failures", async () => {
    const manager = new FakeDispatchManager(
      {
        "TASK-002": "failed",
        "TASK-003": "throw",
      },
      5,
    );
    const selections = [
      selection("TASK-001"),
      selection("TASK-002"),
      selection("TASK-003"),
      selection("TASK-004"),
    ];

    const results = await executeSelectedWaveTasks(selections, 2, manager, "1", 1);

    expect(manager.maxActive).toBeLessThanOrEqual(2);
    expect(manager.starts).toEqual(
      expect.arrayContaining(["TASK-001", "TASK-002", "TASK-003", "TASK-004"]),
    );
    expect(results.map((result) => result.taskId)).toEqual(selections.map((item) => item.taskId));
    expect(results.map((result) => result.status)).toEqual([
      "completed",
      "failed",
      "start_failed",
      "completed",
    ]);
    expect(results[1].error).toContain("deterministic failure");
    expect(results[2].error).toContain("could not start");
    expect(waveExitCode(results, 0)).toBe(1);
  });

  it("rechecks degraded mode after claimant resolution and waits for a safe start", async () => {
    let releaseSecondClaimant!: () => void;
    const secondClaimantMayResolve = new Promise<void>((resolve) => {
      releaseSecondClaimant = resolve;
    });
    const manager = new DegradingDispatchManager(releaseSecondClaimant);
    const selections = [selection("TASK-001"), selection("TASK-002")];

    const results = await executeSelectedWaveTasks(
      selections,
      2,
      manager,
      "1",
      1,
      async (taskId) => {
        if (taskId === "TASK-002") await secondClaimantMayResolve;
        return { taskId, claimants: [] };
      },
    );

    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(manager.starts).toEqual(["TASK-001", "TASK-002"]);
    expect(manager.maxActive).toBe(1);
  });

  it("retries an atomic degraded-busy refusal after simultaneous claimant checks", async () => {
    let claimantArrivals = 0;
    let releaseClaimants!: () => void;
    const claimantBarrier = new Promise<void>((resolve) => {
      releaseClaimants = resolve;
    });
    const manager = new DegradingDispatchManager(() => undefined);
    const selections = [selection("TASK-001"), selection("TASK-002")];

    const results = await executeSelectedWaveTasks(
      selections,
      2,
      manager,
      "1",
      1,
      async (taskId) => {
        claimantArrivals += 1;
        if (claimantArrivals === selections.length) releaseClaimants();
        await claimantBarrier;
        return { taskId, claimants: [] };
      },
    );

    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(manager.busyRefusals).toBe(1);
    expect(claimantArrivals).toBe(3);
    expect(manager.starts).toEqual(["TASK-001", "TASK-002"]);
    expect(manager.maxActive).toBe(1);
  });

  it("refreshes claimant evidence after a degraded-busy retry", async () => {
    let claimantArrivals = 0;
    let releaseClaimants!: () => void;
    const claimantBarrier = new Promise<void>((resolve) => {
      releaseClaimants = resolve;
    });
    const callsByTask = new Map<string, number>();
    const manager = new ClaimantGuardedDegradingManager(() => undefined);
    const selections = [selection("TASK-001"), selection("TASK-002")];

    const results = await executeSelectedWaveTasks(
      selections,
      2,
      manager,
      "1",
      1,
      async (taskId) => {
        const taskCalls = (callsByTask.get(taskId) ?? 0) + 1;
        callsByTask.set(taskId, taskCalls);
        claimantArrivals += 1;
        if (claimantArrivals === selections.length) releaseClaimants();
        await claimantBarrier;
        return {
          taskId,
          claimants: taskCalls > 1 ? [`${taskId}-a.md`, `${taskId}-b.md`] : [],
        };
      },
    );

    expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
    const [refused] = results.filter((result) => result.status === "start_failed");
    expect(refused?.error).toContain("duplicate claimants");
    expect(manager.busyRefusals).toBe(1);
    expect(claimantArrivals).toBe(3);
    expect(manager.starts).toHaveLength(1);
  });

  it("fails the next selection instead of sharing a checkout paused for approval", async () => {
    let releaseSecondClaimant!: () => void;
    const secondClaimantMayResolve = new Promise<void>((resolve) => {
      releaseSecondClaimant = resolve;
    });
    const manager = new DegradingDispatchManager(releaseSecondClaimant, {
      "TASK-001": "awaiting_approval",
    });
    const selections = [selection("TASK-001"), selection("TASK-002")];

    const results = await executeSelectedWaveTasks(
      selections,
      2,
      manager,
      "1",
      1,
      async (taskId) => {
        if (taskId === "TASK-002") await secondClaimantMayResolve;
        return { taskId, claimants: [] };
      },
    );

    expect(results.map((result) => result.status)).toEqual(["awaiting_approval", "start_failed"]);
    expect(results[1].error).toContain("awaiting_approval");
    expect(manager.starts).toEqual(["TASK-001"]);
  }, 1_000);
});

describe("runWaveWithSignalCleanup", () => {
  it("documents signal-specific exit codes", async () => {
    const reference = await fs.readFile(
      path.resolve(__dirname, "../../docs/CLI_REFERENCE.md"),
      "utf-8",
    );

    expect(reference).toContain("| `130` | The wave was interrupted by `SIGINT`");
    expect(reference).toContain("| `143` | The wave was terminated by `SIGTERM`");
  });

  it("runs bounded, once-only cleanup on signals without forcing process exit", async () => {
    const manager = new FakeDispatchManager();
    manager.jobs.set("TASK-001", {
      taskId: "TASK-001",
      sessionId: "session-TASK-001",
      pid: 1,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    });

    const listeners = new Map<WaveSignal, () => void>();
    let releaseOperation!: (results: WaveTaskResult[]) => void;
    const operation = new Promise<WaveTaskResult[]>((resolve) => {
      releaseOperation = resolve;
    });

    const run = runWaveWithSignalCleanup(manager, () => operation, {
      addSignalListener: (signal, listener) => listeners.set(signal, listener),
      removeSignalListener: (signal) => listeners.delete(signal),
      signalCleanupTimeoutMs: 20,
    });

    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    const outcome = await run;
    releaseOperation([]);

    expect(outcome).toEqual({ interrupted: true, signal: "SIGINT", cleanupTimedOut: true });
    expect(manager.stops).toEqual(["TASK-001"]);
    expect(manager.shutdownAllCalls).toBe(1);
    expect(manager.watchdogStarted).toBe(true);
    expect(manager.watchdogStopped).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("cancels wave scheduling so no task starts after signal cleanup", async () => {
    let firstStarted!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const manager = new FakeDispatchManager({}, 10_000, () => firstStarted());
    const listeners = new Map<WaveSignal, () => void>();
    const selections = [selection("TASK-001"), selection("TASK-002")];

    const run = runWaveWithSignalCleanup(
      manager,
      (isCancelled) =>
        executeSelectedWaveTasks(selections, 1, manager, "1", 1, undefined, isCancelled),
      {
        addSignalListener: (signal, listener) => listeners.set(signal, listener),
        removeSignalListener: (signal) => listeners.delete(signal),
        signalCleanupTimeoutMs: 100,
      },
    );

    await firstStart;
    listeners.get("SIGTERM")?.();
    const outcome = await run;

    expect(outcome).toEqual({ interrupted: true, signal: "SIGTERM", cleanupTimedOut: false });
    expect(manager.starts).toEqual(["TASK-001"]);
    expect(manager.stops).toEqual(["TASK-001"]);
    expect(manager.shutdownAllCalls).toBe(1);
    expect(manager.watchdogStopped).toBe(true);
  });
});

describe("waveCommand", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-wave-"));
    await fs.mkdir(path.join(projectRoot, ".quack"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, ".quack", "adapter.json"), adapterJson());
    await fs.mkdir(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("dispatches the ranked ready frontier, skips blocked tasks, and exits zero", async () => {
    await Promise.all([
      fs.writeFile(
        path.join(projectRoot, "docs", "tasks", "TASK-001-ready.md"),
        taskDoc("TASK-001", "P0-CRITICAL"),
      ),
      fs.writeFile(
        path.join(projectRoot, "docs", "tasks", "TASK-002-blocked.md"),
        taskDoc("TASK-002", "P1-HIGH", ["TASK-001"]),
      ),
      fs.writeFile(
        path.join(projectRoot, "docs", "tasks", "TASK-003-ready.md"),
        taskDoc("TASK-003", "P2-MEDIUM"),
      ),
    ]);
    const manager = new FakeDispatchManager();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | undefined;

    await waveCommand(
      "1",
      { parallel: "2", project: projectRoot },
      {
        createManager: () => manager,
        pollIntervalMs: 1,
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    // Parallel workers may complete their asynchronous claimant checks in
    // either order. Coverage requires the selected frontier exactly once,
    // while executeSelectedWaveTasks keeps result reporting deterministic.
    expect(manager.starts).toHaveLength(2);
    expect(manager.starts).toEqual(expect.arrayContaining(["TASK-001", "TASK-003"]));
    expect(manager.claimantCounts).toEqual([0, 0]);
    expect(manager.watchdogStarted).toBe(true);
    expect(manager.watchdogStopped).toBe(true);
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Blocked tasks: 1");
    expect(stdout.join("\n")).toContain("Summary: 2/2 completed");
    expect(stdout.join("\n")).not.toContain("not yet implemented");
  });

  it("forces process termination only after bounded signal cleanup reports a survivor", async () => {
    await fs.writeFile(
      path.join(projectRoot, "docs", "tasks", "TASK-001-ready.md"),
      taskDoc("TASK-001", "P0-CRITICAL"),
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const manager = new FakeDispatchManager({}, 10_000, () => markStarted());
    const shutdownAll = jest.fn(() => {
      manager.stop("TASK-001");
      return Promise.resolve({
        requested: ["TASK-001"],
        exited: [],
        escalated: ["TASK-001"],
        timedOut: ["TASK-001"],
      });
    });
    manager.shutdownAll = shutdownAll;
    const listeners = new Map<WaveSignal, () => void>();
    const exitProcess = jest.fn();
    let exitCode: number | undefined;

    const run = waveCommand(
      "1",
      { parallel: "1", project: projectRoot },
      {
        createManager: () => manager,
        pollIntervalMs: 1,
        writeStdout: () => undefined,
        writeStderr: () => undefined,
        setExitCode: (code) => {
          exitCode = code;
        },
        exitProcess,
        addSignalListener: (signal, listener) => listeners.set(signal, listener),
        removeSignalListener: (signal) => listeners.delete(signal),
        signalCleanupTimeoutMs: 100,
      },
    );
    await started;
    listeners.get("SIGINT")?.();
    await run;

    expect(exitCode).toBe(130);
    expect(exitProcess).toHaveBeenCalledWith(130);
    expect(shutdownAll).toHaveBeenCalledTimes(1);
  });

  it("reports parse errors deterministically and returns a nonzero exit", async () => {
    await fs.writeFile(
      path.join(projectRoot, "docs", "tasks", "TASK-999-broken.md"),
      "# TASK-999: Broken\n\n## Metadata\n- **Priority:** P1-HIGH\n",
    );
    const stdout: string[] = [];
    let exitCode: number | undefined;

    await waveCommand(
      "1",
      { parallel: "1", project: projectRoot },
      {
        writeStdout: (text) => stdout.push(text),
        writeStderr: () => undefined,
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.join("\n")).toContain("Parse errors:");
    expect(stdout.join("\n")).toContain("TASK-999-broken.md");
    expect(stdout.join("\n")).toContain("No eligible tasks found");
  });

  it("rejects malformed parallel values before attempting dispatch", async () => {
    const stderr: string[] = [];
    let exitCode: number | undefined;

    await waveCommand(
      "1",
      { parallel: "2tasks", project: projectRoot },
      {
        writeStdout: () => undefined,
        writeStderr: (text) => stderr.push(text),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("--parallel must be a positive integer");
  });
});
