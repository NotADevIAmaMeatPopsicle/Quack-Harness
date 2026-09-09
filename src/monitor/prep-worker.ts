// ─── Prep Worker ───────────────────────────────────────────────────
// Runs gate checks (schema validation + depth evaluation) in a child
// process. Used by the monitor API to prep tasks on demand without
// blocking the server or hitting the nested session blocker.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

export interface PrepShutdownSurvivor {
  version: 1;
  taskId: string;
  pid: number;
  startedAt: string;
  recordedAt: string;
  confirmationToken: string;
  strategy: "windows-process-tree" | "posix-process-group";
}

export interface PrepWorkerRuntime {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  execFileSync?: typeof execFileSync;
  killProcess?: typeof process.kill;
}

const PREP_SHUTDOWN_SURVIVOR_VERSION = 1;

export class PrepWorker {
  private jobs = new Map<string, PrepJob>();
  private processes = new Map<string, ChildProcess>();
  private stopRequestedTasks = new Set<string>();
  private unconfirmedProcessGroups = new Map<string, number>();
  private shutdownSurvivors = new Map<string, PrepShutdownSurvivor>();
  private unreadableSurvivorMarkers = new Set<string>();
  /** A Windows PID may be recycled, so each live ChildProcess handle is signalled at most once. */
  private attemptedWindowsTreeKills = new WeakSet<ChildProcess>();
  private confirmedWindowsTreeKills = new Set<string>();
  private shutdownInProgress = false;
  private shutdownPromise: Promise<PrepShutdownResult> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly quackBin: string,
    private readonly runtime: PrepWorkerRuntime = {},
  ) {
    this.refreshShutdownSurvivors();
  }

  private shutdownSurvivorDir(): string {
    return path.join(this.projectRoot, ".quack", "logs", "prep-shutdown-survivors");
  }

  private shutdownSurvivorPath(taskId: string): string {
    const safeTaskId = Buffer.from(taskId, "utf-8").toString("base64url");
    return path.join(this.shutdownSurvivorDir(), `${safeTaskId}.json`);
  }

  private parseShutdownSurvivor(markerPath: string): PrepShutdownSurvivor | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== PREP_SHUTDOWN_SURVIVOR_VERSION ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
        Number((parsed as { pid?: unknown }).pid) <= 0 ||
        typeof (parsed as { startedAt?: unknown }).startedAt !== "string" ||
        typeof (parsed as { recordedAt?: unknown }).recordedAt !== "string" ||
        typeof (parsed as { confirmationToken?: unknown }).confirmationToken !== "string" ||
        !(parsed as { confirmationToken: string }).confirmationToken ||
        ((parsed as { strategy?: unknown }).strategy !== undefined &&
          !["windows-process-tree", "posix-process-group"].includes(
            String((parsed as { strategy?: unknown }).strategy),
          ))
      ) {
        return undefined;
      }
      return {
        ...(parsed as Omit<PrepShutdownSurvivor, "strategy">),
        strategy:
          (parsed as { strategy?: PrepShutdownSurvivor["strategy"] }).strategy ??
          "windows-process-tree",
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reload durable survivor evidence. Unreadable records remain a
   * global admission barrier; guessing their PID or task ownership is unsafe.
   */
  private refreshShutdownSurvivors(): void {
    const directory = this.shutdownSurvivorDir();
    const survivors = new Map<string, PrepShutdownSurvivor>();
    const unreadable = new Set<string>();
    if (fs.existsSync(directory)) {
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json.lock")) {
            unreadable.add(entry.name);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const markerPath = path.join(directory, entry.name);
          const marker = this.parseShutdownSurvivor(markerPath);
          if (!marker || this.shutdownSurvivorPath(marker.taskId) !== markerPath) {
            unreadable.add(entry.name);
            continue;
          }
          survivors.set(marker.taskId, marker);
        }
      } catch {
        unreadable.add("unreadable-survivor-directory");
      }
    }
    this.shutdownSurvivors = survivors;
    this.unreadableSurvivorMarkers = unreadable;
  }

  private recordShutdownAttempt(
    taskId: string,
    child: ChildProcess,
    strategy: PrepShutdownSurvivor["strategy"],
  ): PrepShutdownSurvivor {
    if (!child.pid) throw new Error(`Cannot record process-tree identity for ${taskId}`);
    this.refreshShutdownSurvivors();
    const existing = this.shutdownSurvivors.get(taskId);
    if (existing) {
      if (existing.pid === child.pid && existing.strategy === strategy) return existing;
      throw new Error(
        `Prep process-tree shutdown for ${taskId} is already unconfirmed; refusing to re-signal stored PID ${existing.pid}`,
      );
    }

    const markerPath = this.shutdownSurvivorPath(taskId);
    if (fs.existsSync(`${markerPath}.lock`)) {
      throw new Error(`Prep shutdown reconciliation is locked for ${taskId}`);
    }
    const marker: PrepShutdownSurvivor = {
      version: PREP_SHUTDOWN_SURVIVOR_VERSION,
      taskId,
      pid: child.pid,
      startedAt: this.jobs.get(taskId)?.startedAt ?? new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      confirmationToken: randomUUID(),
      strategy,
    };
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    try {
      fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error: unknown) {
      this.refreshShutdownSurvivors();
      const winner = this.shutdownSurvivors.get(taskId);
      if (winner) {
        throw new Error(
          `Prep process-tree shutdown for ${taskId} is already unconfirmed; refusing to re-signal stored PID ${winner.pid}`,
        );
      }
      throw error;
    }
    this.shutdownSurvivors.set(taskId, marker);
    return marker;
  }

  private clearShutdownSurvivor(marker: PrepShutdownSurvivor): boolean {
    const markerPath = this.shutdownSurvivorPath(marker.taskId);
    const current = this.parseShutdownSurvivor(markerPath);
    if (!current || current.confirmationToken !== marker.confirmationToken) return false;
    try {
      fs.rmSync(markerPath);
      this.shutdownSurvivors.delete(marker.taskId);
      return true;
    } catch {
      return false;
    }
  }

  private clearExitedOwnedProcessGroups(): void {
    for (const [taskId, processGroupId] of this.unconfirmedProcessGroups) {
      if (this.processGroupExists(processGroupId)) continue;
      this.unconfirmedProcessGroups.delete(taskId);
      const marker = this.shutdownSurvivors.get(taskId);
      if (marker?.strategy === "posix-process-group" && marker.pid === processGroupId) {
        this.clearShutdownSurvivor(marker);
      }
    }
  }

  /** Durable records that require an operator to confirm the process tree is gone. */
  getShutdownSurvivors(): PrepShutdownSurvivor[] {
    this.clearExitedOwnedProcessGroups();
    this.refreshShutdownSurvivors();
    return Array.from(this.shutdownSurvivors.values(), (marker) => ({ ...marker }));
  }

  /**
   * Reconcile a failed process-tree kill after an operator independently
   * confirms that the original tree is stopped. The opaque token prevents a
   * stale acknowledgement from clearing a newer survivor record.
   */
  reconcileShutdownSurvivor(
    taskId: string,
    confirmationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    if (!processTreeConfirmedStopped || this.processes.has(taskId)) return false;
    const locallyOwnedGroup = this.unconfirmedProcessGroups.get(taskId);
    if (locallyOwnedGroup && this.processGroupExists(locallyOwnedGroup)) return false;
    this.refreshShutdownSurvivors();
    const marker = this.shutdownSurvivors.get(taskId);
    if (!marker || marker.confirmationToken !== confirmationToken) return false;

    const markerPath = this.shutdownSurvivorPath(taskId);
    const lockPath = `${markerPath}.lock`;
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf-8", flag: "wx" },
      );
    } catch {
      return false;
    }
    try {
      const current = this.parseShutdownSurvivor(markerPath);
      if (!current || current.confirmationToken !== confirmationToken) return false;
      fs.rmSync(markerPath);
      this.refreshShutdownSurvivors();
      return !this.shutdownSurvivors.has(taskId);
    } catch {
      return false;
    } finally {
      try {
        fs.rmSync(lockPath);
      } catch {
        // A retained lock fails closed until it is inspected.
      }
    }
  }

  /**
   * Start a prep job for a task. Returns the job info immediately.
   * The prep runs as a child process to avoid nested session blocker.
   */
  start(taskId: string): PrepJob {
    if (this.shutdownInProgress) {
      throw new Error("Prep worker is shutting down; resume the fleet before starting new prep");
    }
    this.clearExitedOwnedProcessGroups();
    this.refreshShutdownSurvivors();
    if (this.shutdownSurvivors.size > 0 || this.unreadableSurvivorMarkers.size > 0) {
      throw new Error(
        "Prep worker has unresolved Windows shutdown survivor evidence or POSIX process-group evidence; reconcile it before starting new prep",
      );
    }

    // Prevent double-prep
    const existing = this.getActiveJob(taskId);
    if (existing) {
      throw new Error(`Task ${taskId} prep is already running (pid ${existing.pid})`);
    }

    // Use a hidden "prep" command that runs just the gate checks
    // We'll implement this as a flag to the existing gate module
    const args = ["prep", taskId, "--project", this.projectRoot];

    const child = (this.runtime.spawnProcess ?? spawn)("node", [this.quackBin, ...args], {
      cwd: this.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX the prep CLI and every agent process it spawns share a
      // dedicated process group. Shutdown can therefore prove that the whole
      // tree exited rather than observing only the short-lived CLI wrapper.
      detached: (this.runtime.platform ?? process.platform) !== "win32",
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
      if ((this.runtime.platform ?? process.platform) !== "win32" && child.pid) {
        const marker = this.shutdownSurvivors.get(taskId);
        if (
          marker?.strategy === "posix-process-group" &&
          marker.pid === child.pid &&
          !this.processGroupExists(child.pid)
        ) {
          this.clearShutdownSurvivor(marker);
          this.unconfirmedProcessGroups.delete(taskId);
        }
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
    if ((this.runtime.platform ?? process.platform) !== "win32" && child.pid) {
      this.unconfirmedProcessGroups.set(taskId, child.pid);
    }
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
    if ((this.runtime.platform ?? process.platform) === "win32") return false;
    try {
      (this.runtime.killProcess ?? process.kill)(-processGroupId, 0);
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
    if ((this.runtime.platform ?? process.platform) === "win32" && child.pid) {
      if (this.attemptedWindowsTreeKills.has(child)) {
        throw new Error(
          `Refusing to retry Windows process-tree shutdown for ${taskId}; its numeric PID may have been recycled`,
        );
      }
      const marker = this.recordShutdownAttempt(taskId, child, "windows-process-tree");
      this.attemptedWindowsTreeKills.add(child);
      (this.runtime.execFileSync ?? execFileSync)(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: Math.max(1, windowsTimeoutMs),
        },
      );
      if (!this.clearShutdownSurvivor(marker)) {
        throw new Error(`Could not clear durable Windows shutdown evidence for ${taskId}`);
      }
      this.confirmedWindowsTreeKills.add(taskId);
      return;
    }

    if ((this.runtime.platform ?? process.platform) !== "win32" && child.pid) {
      this.recordShutdownAttempt(taskId, child, "posix-process-group");
      try {
        (this.runtime.killProcess ?? process.kill)(-child.pid, signal);
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
    this.refreshShutdownSurvivors();
    const pendingDurableSurvivors = Array.from(this.shutdownSurvivors.values()).filter(
      ({ taskId }) => !trackedIds.has(taskId),
    );
    const unreadableSurvivors = Array.from(
      this.unreadableSurvivorMarkers,
      (name) => `unreadable:${name}`,
    );
    const requested = Array.from(
      new Set([
        ...tracked.map(({ taskId }) => taskId),
        ...pendingGroups.map(({ taskId }) => taskId),
        ...pendingDurableSurvivors.map(({ taskId }) => taskId),
        ...unreadableSurvivors,
      ]),
    );
    const escalated: string[] = [];

    for (const { taskId, child } of tracked) {
      this.stopRequestedTasks.add(taskId);
      if ((this.runtime.platform ?? process.platform) !== "win32" && child.pid) {
        this.unconfirmedProcessGroups.set(taskId, child.pid);
      }
    }

    const trackedHasExited = ({ taskId, child }: (typeof tracked)[number]): boolean => {
      const lifecycleRecorded = this.processes.get(taskId) !== child;
      if (!child.pid) return lifecycleRecorded;
      if ((this.runtime.platform ?? process.platform) === "win32") {
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
    if ((this.runtime.platform ?? process.platform) === "win32") {
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
        (this.runtime.killProcess ?? process.kill)(-entry.processGroupId, "SIGKILL");
      } catch {
        // A concurrent exit is distinguished by the evidence check below.
      }
    }
    const remainingGroups = await waitForGroups(pendingGroups, forceTimeoutMs);

    // Clear only evidence tied to a process handle/group owned by this worker
    // and now proven absent. Durable records restored after restart are never
    // re-signalled by numeric PID/group ID because either may have been reused.
    for (const { taskId, child } of tracked) {
      if (!child.pid || !trackedHasExited({ taskId, child })) continue;
      const marker = this.shutdownSurvivors.get(taskId);
      if (marker) this.clearShutdownSurvivor(marker);
    }
    for (const { taskId, processGroupId } of pendingGroups) {
      if (this.processGroupExists(processGroupId)) continue;
      const marker = this.shutdownSurvivors.get(taskId);
      if (marker?.pid === processGroupId) this.clearShutdownSurvivor(marker);
    }

    this.refreshShutdownSurvivors();
    const remainingDurableSurvivors = Array.from(this.shutdownSurvivors.values());
    const remainingUnreadableSurvivors = Array.from(
      this.unreadableSurvivorMarkers,
      (name) => `unreadable:${name}`,
    );

    const timedOut = Array.from(
      new Set([
        ...remaining.map(({ taskId }) => taskId),
        ...remainingGroups.map(({ taskId }) => taskId),
        ...remainingDurableSurvivors.map(({ taskId }) => taskId),
        ...remainingUnreadableSurvivors,
      ]),
    );
    const timedOutSet = new Set(timedOut);
    for (const { taskId, child } of tracked) {
      if (timedOutSet.has(taskId)) continue;
      if (child.pid) this.unconfirmedProcessGroups.delete(taskId);
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
    this.clearExitedOwnedProcessGroups();
    this.refreshShutdownSurvivors();
    return (
      this.shutdownPromise === null &&
      this.processes.size === 0 &&
      this.unconfirmedProcessGroups.size === 0 &&
      this.shutdownSurvivors.size === 0 &&
      this.unreadableSurvivorMarkers.size === 0
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
      if ((this.runtime.platform ?? process.platform) !== "win32" && child.pid) {
        this.unconfirmedProcessGroups.set(taskId, child.pid);
      }
      try {
        this.signalProcessTree(taskId, child, "SIGKILL", 1_000);
      } catch {
        // Preserve tracking and fail closed until bounded shutdown can confirm.
      }
    }
  }
}
