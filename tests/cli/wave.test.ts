import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createWaveDispatchManager,
  executeSelectedWaveTasks,
  waveCommand,
  waveExitCode,
  type WaveDispatchManager,
  type WaveSignal,
} from "../../src/cli/wave";
import type {
  DispatchJob,
  DispatchShutdownOptions,
  DispatchShutdownResult,
} from "../../src/monitor/dispatch-manager";
import type { TaskSelection } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

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
    return Promise.resolve({
      requested,
      exited: requested,
      escalated: [],
      timedOut: [],
      durableAccountingComplete: true,
    });
  }

  startWatchdog(): void {
    this.watchdogStarted = true;
  }

  stopWatchdog(): void {
    this.watchdogStopped = true;
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

  it("forwards operator-owned local-read authorization to its dispatch manager", () => {
    const trustedOrigin = path.join(path.dirname(projectRoot), "wave-origin.git");
    const adapter = {
      projectRoot,
      config: {
        project: { taskDir: "docs/tasks" },
        logging: { dir: ".quack/logs" },
      },
      trustedLocalReadRemotePaths: [trustedOrigin],
    } as ProjectAdapter;

    const manager = createWaveDispatchManager(adapter, path.join(projectRoot, "docs", "tasks"));

    expect(
      (manager as unknown as { trustedLocalReadRemotePaths?: readonly string[] })
        .trustedLocalReadRemotePaths,
    ).toEqual([trustedOrigin]);
    manager.stopWatchdog();
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
    let releaseDurableEvidence!: () => void;
    const durableEvidenceReady = new Promise<void>((resolve) => {
      releaseDurableEvidence = resolve;
    });
    let durableEvidencePersisted = false;
    const shutdownAll = jest.fn(async () => {
      manager.stop("TASK-001");
      await durableEvidenceReady;
      durableEvidencePersisted = true;
      return {
        requested: ["TASK-001"],
        exited: [],
        escalated: ["TASK-001"],
        timedOut: ["TASK-001"],
        durableAccountingComplete: true,
      };
    });
    manager.shutdownAll = shutdownAll;
    const listeners = new Map<WaveSignal, () => void>();
    const exitProcess = jest.fn(() => {
      expect(durableEvidencePersisted).toBe(true);
    });
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(exitProcess).not.toHaveBeenCalled();
    releaseDurableEvidence();
    await run;

    expect(exitCode).toBe(130);
    expect(exitProcess).toHaveBeenCalledWith(130);
    expect(shutdownAll).toHaveBeenCalledTimes(1);
  });

  it("does not force process termination when shutdown fails before durable accounting", async () => {
    await fs.writeFile(
      path.join(projectRoot, "docs", "tasks", "TASK-001-ready.md"),
      taskDoc("TASK-001", "P0-CRITICAL"),
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const manager = new FakeDispatchManager({}, 10_000, () => markStarted());
    const shutdownAll = jest.fn(() =>
      Promise.reject(new Error("durable shutdown journal unavailable")),
    );
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
        signalCleanupTimeoutMs: 10,
      },
    );
    await started;
    listeners.get("SIGINT")?.();
    await run;

    expect(exitCode).toBe(130);
    expect(shutdownAll).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    manager.stop("TASK-001");
  });

  it("does not force process termination when timed-out survivors lack durable accounting", async () => {
    await fs.writeFile(
      path.join(projectRoot, "docs", "tasks", "TASK-001-ready.md"),
      taskDoc("TASK-001", "P0-CRITICAL"),
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const manager = new FakeDispatchManager({}, 10_000, () => markStarted());
    manager.shutdownAll = jest.fn(() =>
      Promise.resolve({
        requested: ["TASK-001"],
        exited: [],
        escalated: ["TASK-001"],
        timedOut: ["TASK-001"],
        durableAccountingComplete: false,
      }),
    );
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
        signalCleanupTimeoutMs: 10,
      },
    );
    await started;
    listeners.get("SIGTERM")?.();
    await run;

    expect(exitCode).toBe(143);
    expect(exitProcess).not.toHaveBeenCalled();
    manager.stop("TASK-001");
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
