// ─── Prep Worker ───────────────────────────────────────────────────
// Runs gate checks (schema validation + depth evaluation) in a child
// process. Used by the monitor API to prep tasks on demand without
// blocking the server or hitting the nested session blocker.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

export interface PrepJob {
  taskId: string;
  pid: number;
  startedAt: string;
  status: "running" | "completed" | "failed";
  result?: {
    schemaValid: boolean;
    schemaErrors: string[];
    depthScore: number;
    depthReady: boolean;
    deficiencies: string[];
    outcome: "pass" | "enriched" | "rejected";
  };
  error?: string;
}

export interface PrepShutdownOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export interface PrepShutdownResult {
  requested: string[];
  exited: string[];
  escalated: string[];
  timedOut: string[];
}

export class PrepWorker {
  private jobs = new Map<string, PrepJob>();
  private processes = new Map<string, ChildProcess>();
  private stopRequestedTasks = new Set<string>();
  private unconfirmedProcessGroups = new Map<string, number>();
  private unconfirmedWindowsTrees = new Map<string, number>();
  private confirmedWindowsTreeKills = new Set<string>();
  private shutdownInProgress = false;
  private shutdownPromise: Promise<PrepShutdownResult> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly quackBin: string,
  ) {}

  /**
   * Start a prep job for a task. Returns the job info immediately.
   * The prep runs as a child process to avoid nested session blocker.
   */
  start(taskId: string): PrepJob {
    if (this.shutdownInProgress) {
      throw new Error("Prep worker is shutting down; resume the fleet before starting new prep");
    }

    // Prevent double-prep
    const existing = this.getActiveJob(taskId);
    if (existing) {
      throw new Error(`Task ${taskId} prep is already running (pid ${existing.pid})`);
    }

    // Use a hidden "prep" command that runs just the gate checks
    // We'll implement this as a flag to the existing gate module
    const args = ["prep", taskId, "--project", this.projectRoot];

    const child = spawn("node", [this.quackBin, ...args], {
      cwd: this.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX the prep CLI and every agent process it spawns share a
      // dedicated process group. Shutdown can therefore prove that the whole
      // tree exited rather than observing only the short-lived CLI wrapper.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CLAUDE_CODE: undefined,
      },
    });

    const job: PrepJob = {
      taskId,
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
      status: "running",
    };

    let stdout = "";
    let stderr = "";
    this.stopRequestedTasks.delete(taskId);
    this.confirmedWindowsTreeKills.delete(taskId);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("exit", (code) => {
      const stopRequested = this.stopRequestedTasks.delete(taskId);
      if (stopRequested) {
        job.status = "failed";
        job.error ||= "Prep stopped before completion";
      } else if (code === 0 && stdout) {
        try {
          // Parse JSON output from the prep command
          const result = JSON.parse(stdout.trim()) as PrepJob["result"];
          job.status = "completed";
          job.result = result;
        } catch (err) {
          job.status = "failed";
          job.error = `Failed to parse prep output: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        job.status = "failed";
        job.error = stderr || `Exit code ${code}`;
      }
      if (this.processes.get(taskId) === child) {
        this.processes.delete(taskId);
      }
    });

    child.on("error", (err) => {
      job.status = "failed";
      job.error = this.stopRequestedTasks.delete(taskId)
        ? "Prep stopped before completion"
        : err.message;
      if (this.processes.get(taskId) === child) {
        this.processes.delete(taskId);
      }
    });

    this.jobs.set(taskId, job);
    this.processes.set(taskId, child);

    return job;
  }

  /**
   * Stop a running prep job.
   */
  stop(taskId: string): boolean {
    const child = this.processes.get(taskId);
    if (!child) return false;

    this.stopRequestedTasks.add(taskId);
    try {
      this.signalProcessTree(taskId, child, "SIGTERM", 1_000);
    } catch {
      // The child may have exited between lookup and signalling. Its lifecycle
      // handler remains responsible for clearing the process record.
    }
    return true;
  }

  /**
   * Get job by task ID (any status).
   */
  getJob(taskId: string): PrepJob | undefined {
    return this.jobs.get(taskId);
  }

  /**
   * Get active (running) job for a task.
   */
  getActiveJob(taskId: string): PrepJob | undefined {
    const job = this.jobs.get(taskId);
    return job?.status === "running" ? job : undefined;
  }

  /**
   * Get all active jobs.
   */
  getActiveJobs(): PrepJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.status === "running");
  }

  /**
   * Clean up completed/failed jobs older than the given age.
   */
  cleanup(maxAgeMs = 3600000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [taskId, job] of this.jobs) {
      if (job.status !== "running" && new Date(job.startedAt).getTime() < cutoff) {
        this.jobs.delete(taskId);
      }
    }
  }

  private processGroupExists(processGroupId: number): boolean {
    if (process.platform === "win32") return false;
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      return code !== "ESRCH";
    }
  }

  private signalProcessTree(
    taskId: string,
    child: ChildProcess,
    signal: NodeJS.Signals,
    windowsTimeoutMs: number,
  ): void {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: Math.max(1, windowsTimeoutMs),
      });
      this.confirmedWindowsTreeKills.add(taskId);
      this.unconfirmedWindowsTrees.delete(taskId);
      return;
    }

    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Compatibility for a child created before process-group isolation was
        // enabled, or for platforms that reject negative group PIDs.
      }
    }
    child.kill(signal);
  }

  private async performShutdownAll(options: PrepShutdownOptions): Promise<PrepShutdownResult> {
    const gracefulTimeoutMs = Math.max(0, options.gracefulTimeoutMs ?? 1_000);
    const forceTimeoutMs = Math.max(0, options.forceTimeoutMs ?? 1_000);
    const tracked = Array.from(this.processes, ([taskId, child]) => ({ taskId, child }));
    const trackedIds = new Set(tracked.map(({ taskId }) => taskId));
    const pendingGroups = Array.from(this.unconfirmedProcessGroups, ([taskId, processGroupId]) => ({
      taskId,
      processGroupId,
    })).filter(({ taskId }) => !trackedIds.has(taskId));
    const pendingWindowsTrees = Array.from(this.unconfirmedWindowsTrees, ([taskId, pid]) => ({
      taskId,
      pid,
    })).filter(({ taskId }) => !trackedIds.has(taskId));
    const requested = Array.from(
      new Set([
        ...tracked.map(({ taskId }) => taskId),
        ...pendingGroups.map(({ taskId }) => taskId),
        ...pendingWindowsTrees.map(({ taskId }) => taskId),
      ]),
    );
    const escalated: string[] = [];

    for (const { taskId, child } of tracked) {
      this.stopRequestedTasks.add(taskId);
      if (process.platform !== "win32" && child.pid) {
        this.unconfirmedProcessGroups.set(taskId, child.pid);
      } else if (process.platform === "win32" && child.pid) {
        this.unconfirmedWindowsTrees.set(taskId, child.pid);
      }
    }

    const trackedHasExited = ({ taskId, child }: (typeof tracked)[number]): boolean => {
      const lifecycleRecorded = this.processes.get(taskId) !== child;
      if (!child.pid) return lifecycleRecorded;
      if (process.platform === "win32") {
        return lifecycleRecorded && this.confirmedWindowsTreeKills.has(taskId);
      }
      return lifecycleRecorded && !this.processGroupExists(child.pid);
    };
    const waitForTracked = async (
      entries: Array<(typeof tracked)[number]>,
      timeoutMs: number,
    ): Promise<Array<(typeof tracked)[number]>> => {
      const deadline = Date.now() + timeoutMs;
      let remaining = entries.filter((entry) => !trackedHasExited(entry));
      while (remaining.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        remaining = entries.filter((entry) => !trackedHasExited(entry));
      }
      return remaining;
    };
    const waitForGroups = async (
      entries: typeof pendingGroups,
      timeoutMs: number,
    ): Promise<typeof pendingGroups> => {
      const deadline = Date.now() + timeoutMs;
      let remaining = entries.filter(({ processGroupId }) =>
        this.processGroupExists(processGroupId),
      );
      while (remaining.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        remaining = entries.filter(({ processGroupId }) => this.processGroupExists(processGroupId));
      }
      return remaining;
    };

    let remaining = tracked;
    if (process.platform === "win32") {
      for (const entry of remaining) {
        escalated.push(entry.taskId);
        try {
          this.signalProcessTree(entry.taskId, entry.child, "SIGKILL", forceTimeoutMs);
        } catch {
          // The evidence check below keeps an unconfirmed tree admission-blocking.
        }
      }
    } else {
      for (const entry of remaining) {
        try {
          this.signalProcessTree(entry.taskId, entry.child, "SIGTERM", forceTimeoutMs);
        } catch {
          // A concurrent exit is distinguished by the evidence check below.
        }
      }
      remaining = await waitForTracked(remaining, gracefulTimeoutMs);
      for (const entry of remaining) {
        escalated.push(entry.taskId);
        try {
          this.signalProcessTree(entry.taskId, entry.child, "SIGKILL", forceTimeoutMs);
        } catch {
          // The evidence check below keeps an unconfirmed group admission-blocking.
        }
      }
    }

    remaining = await waitForTracked(remaining, forceTimeoutMs);

    for (const entry of pendingGroups) {
      if (!this.processGroupExists(entry.processGroupId)) continue;
      if (!escalated.includes(entry.taskId)) escalated.push(entry.taskId);
      try {
        process.kill(-entry.processGroupId, "SIGKILL");
      } catch {
        // A concurrent exit is distinguished by the evidence check below.
      }
    }
    const remainingGroups = await waitForGroups(pendingGroups, forceTimeoutMs);

    const remainingWindowsTrees: typeof pendingWindowsTrees = [];
    for (const entry of pendingWindowsTrees) {
      if (!escalated.includes(entry.taskId)) escalated.push(entry.taskId);
      try {
        execFileSync("taskkill", ["/pid", String(entry.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: Math.max(1, forceTimeoutMs),
        });
        this.unconfirmedWindowsTrees.delete(entry.taskId);
      } catch {
        remainingWindowsTrees.push(entry);
      }
    }

    const timedOut = Array.from(
      new Set([
        ...remaining.map(({ taskId }) => taskId),
        ...remainingGroups.map(({ taskId }) => taskId),
        ...remainingWindowsTrees.map(({ taskId }) => taskId),
      ]),
    );
    const timedOutSet = new Set(timedOut);
    for (const { taskId, child } of tracked) {
      if (timedOutSet.has(taskId)) continue;
      if (child.pid) this.unconfirmedProcessGroups.delete(taskId);
      this.unconfirmedWindowsTrees.delete(taskId);
    }
    for (const { taskId } of pendingGroups) {
      if (!timedOutSet.has(taskId)) this.unconfirmedProcessGroups.delete(taskId);
    }

    return {
      requested,
      exited: requested.filter((taskId) => !timedOutSet.has(taskId)),
      escalated,
      timedOut,
    };
  }

  /**
   * Stop all prep process trees and wait for bounded exit evidence. New prep
   * admission remains closed until resumeAfterShutdown() succeeds.
   */
  async shutdownAll(options: PrepShutdownOptions = {}): Promise<PrepShutdownResult> {
    this.shutdownInProgress = true;
    if (this.shutdownPromise) return this.shutdownPromise;

    const shutdown = this.performShutdownAll(options);
    this.shutdownPromise = shutdown;
    try {
      return await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = null;
    }
  }

  canResumeAfterShutdown(): boolean {
    for (const [taskId, processGroupId] of this.unconfirmedProcessGroups) {
      if (!this.processGroupExists(processGroupId)) {
        this.unconfirmedProcessGroups.delete(taskId);
      }
    }
    return (
      this.shutdownPromise === null &&
      this.processes.size === 0 &&
      this.unconfirmedProcessGroups.size === 0 &&
      this.unconfirmedWindowsTrees.size === 0
    );
  }

  resumeAfterShutdown(): boolean {
    if (!this.canResumeAfterShutdown()) return false;
    this.shutdownInProgress = false;
    this.confirmedWindowsTreeKills.clear();
    return true;
  }

  /**
   * Legacy synchronous shutdown trigger. It force-signals complete process
   * trees but preserves lifecycle tracking. Callers that can await confirmation
   * should use shutdownAll().
   */
  killAll(): void {
    this.shutdownInProgress = true;
    for (const [taskId, child] of this.processes) {
      this.stopRequestedTasks.add(taskId);
      if (process.platform !== "win32" && child.pid) {
        this.unconfirmedProcessGroups.set(taskId, child.pid);
      } else if (process.platform === "win32" && child.pid) {
        this.unconfirmedWindowsTrees.set(taskId, child.pid);
      }
      try {
        this.signalProcessTree(taskId, child, "SIGKILL", 1_000);
      } catch {
        // Preserve tracking and fail closed until bounded shutdown can confirm.
      }
    }
  }
}
