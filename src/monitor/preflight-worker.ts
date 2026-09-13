import * as path from "node:path";
import * as fs from "node:fs";
import { EventWriter } from "./event-emitter.js";
import type { KeyManager } from "../dispatcher/key-manager.js";
import { toRuntimeDiagnostics } from "../core/runtime-errors.js";
import {
  OwnedCommandWorker, type OwnedCommandJob, type OwnedCommandWorkerRuntime,
  type OwnedCommandShutdownOptions, type OwnedCommandShutdownResult,
} from "./owned-command-worker.js";
import {
  PreflightJobStore, PreflightJobConflict, createPreflightOwner,
  type PreflightInputIdentity, type PreflightJob, type PreflightJobSummary, type PreflightStorageIssue, type PreflightOwner, type PreflightReplan,
} from "./preflight-job-store.js";
import { FULL_PREFLIGHT_OUTPUT_LIMIT, parsePreflightJobEnvelope, preflightReportMatchesInput, type StampedPreflightResult } from "./preflight-job-result.js";

export type PreflightJobStage = "preflight_job_started" | "preflight_job_completed" | "preflight_job_failed";
export interface PreflightWorkerOptions {
  projectId: string;
  logDir?: string;
  keyManager?: KeyManager;
  runtime?: OwnedCommandWorkerRuntime;
  onEvent?: (stage: PreflightJobStage, job: PreflightJob) => void;
}

/** Full-preflight coordination; containment and shutdown belong to the shared supervisor. */
export class PreflightWorker {
  readonly store: PreflightJobStore;
  private readonly supervisor: OwnedCommandWorker<StampedPreflightResult>;
  private ownerPromise?: Promise<PreflightOwner>;
  private readonly attempts = new Map<string, PreflightJob>();
  private readonly scheduled = new Map<string, NodeJS.Immediate>();
  private readonly pending = new Set<Promise<void>>();
  private readonly unpublished = new Map<string, OwnedCommandJob<StampedPreflightResult>>();
  private draining = false;
  private shutdownPromise?: Promise<OwnedCommandShutdownResult>;
  private unconfirmedShutdownTasks: string[] = [];

  constructor(private readonly projectRoot: string, quackBin: string,
    private readonly options: PreflightWorkerOptions) {
    this.store = new PreflightJobStore(projectRoot, options.projectId);
    // Create the destination before monitor watchers start. On Windows, watching
    // a missing log directory can miss its first event files entirely.
    fs.mkdirSync(options.logDir ?? path.join(projectRoot, ".quack/logs"), { recursive: true });
    this.supervisor = new OwnedCommandWorker(projectRoot, quackBin, options.runtime ?? {}, {
      label: "Preflight", survivorNamespace: "preflight-shutdown-survivors",
      outputLimit: FULL_PREFLIGHT_OUTPUT_LIMIT, outputUnit: "bytes",
      keyManager: options.keyManager,
      commandArgs: (taskId, jobId) => {
        const job = this.attempts.get(taskId);
        if (!job || job.jobId !== jobId) throw new Error("Preflight launch has no matching reservation");
        return ["preflight", taskId, "--project", projectRoot, "--json", "--job-id", jobId,
          "--project-id", options.projectId, "--expected-content-hash", job.input.contentHash,
          "--expected-schema-policy-hash", job.input.schemaPolicyHash,
          "--expected-readiness-mode", job.input.readinessJudgmentMode,
          "--mode", job.input.requestedMode, ...(job.force ? ["--force"] : [])];
      },
      parseResult: parsePreflightJobEnvelope,
      // Full attempts use the durable store, whose asynchronous commit must
      // finish before terminal events. Prep's synchronous store is unchanged.
      store: { read: () => undefined, write: () => undefined },
      onTerminal: (job) => this.track(this.publishTerminal(job)),
    });
  }

  private owner(): Promise<PreflightOwner> {
    this.ownerPromise ??= createPreflightOwner(this.projectRoot).catch((error: unknown) => {
      this.ownerPromise = undefined;
      throw error;
    });
    return this.ownerPromise;
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.catch((error: unknown) => {
      console.error("Preflight coordination failed:", error instanceof Error ? error.message : String(error));
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async recover(): Promise<void> {
    for (const taskId of this.store.listRecoveryTaskIds()) {
      try { await this.store.recover(taskId); }
      catch (error) { this.store.recordReadIssue(taskId, error); }
    }
  }

  async start(taskId: string, input: PreflightInputIdentity, options: { force: boolean; preserveApprovals?: boolean; replan?: PreflightReplan; prepareReplan?: () => Promise<PreflightReplan> }):
    Promise<{ job: PreflightJob; created: boolean }> {
    if (this.draining) throw new PreflightJobConflict("PREFLIGHT_DRAINING");
    const owner = await this.owner();
    await this.store.recover(taskId);
    if (this.draining) throw new PreflightJobConflict("PREFLIGHT_DRAINING");
    let reserved;
    try { reserved = await this.store.reserve(taskId, input, { ...options, owner }); }
    catch (error) {
      if (error instanceof PreflightJobConflict && error.code === "PREFLIGHT_REPLAN_PREPARATION_FAILED" && error.job?.status === "failed") {
        await this.emit("preflight_job_failed", error.job);
      }
      throw error;
    }
    if (reserved.created) {
      this.attempts.set(taskId, structuredClone(reserved.job));
      await this.emit("preflight_job_started", reserved.job);
      if (this.draining) {
        await this.failBeforeLaunch(reserved.job, "Preflight interrupted before launch");
        return { ...reserved, job: this.store.read(taskId, reserved.job.jobId)! };
      }
      const handle = setImmediate(() => {
        this.scheduled.delete(reserved.job.jobId);
        this.track(this.launch(reserved.job));
      });
      this.scheduled.set(reserved.job.jobId, handle);
    }
    return reserved;
  }

  private async launch(job: PreflightJob): Promise<void> {
    if (this.draining) { await this.failBeforeLaunch(job, "Preflight interrupted by monitor shutdown"); return; }
    try {
      const owned = this.supervisor.start(job.taskId, job.jobId);
      await this.store.update(job.taskId, job.jobId, job.owner.instanceId,
        (current) => ({ ...current, status: "running", pid: owned.pid, startedAt: owned.startedAt }));
    } catch (error) {
      const recorded = this.store.read(job.taskId, job.jobId);
      if (recorded?.status === "completed" || recorded?.status === "failed") return;
      // A failure after spawn cannot erase the active ownership reservation.
      if (this.supervisor.getActiveJob(job.taskId)) {
        this.supervisor.stop(job.taskId);
        throw error;
      }
      await this.failBeforeLaunch(job, error instanceof Error ? error.message : String(error));
    }
  }

  private async failBeforeLaunch(job: PreflightJob, message: string): Promise<void> {
    const failed = await this.store.update(job.taskId, job.jobId, job.owner.instanceId, (current) => ({
      ...current, status: "failed", completedAt: new Date().toISOString(), error: message,
      errorType: "PREFLIGHT_LAUNCH_FAILED", diagnostics: toRuntimeDiagnostics(message, "preflight_launch"),
    }));
    this.attempts.delete(job.taskId);
    await this.emit("preflight_job_failed", failed);
  }

  private async publishTerminal(owned: OwnedCommandJob<StampedPreflightResult>): Promise<void> {
    const attempt = this.attempts.get(owned.taskId);
    if (!attempt || attempt.jobId !== owned.jobId) throw new Error("Preflight terminal observation has no matching attempt");
    this.unpublished.set(attempt.jobId, owned);
    const survivor = this.supervisor.getShutdownSurvivors().some((item) => item.taskId === owned.taskId);
    const job = await this.store.update(attempt.taskId, attempt.jobId, attempt.owner.instanceId, (current) => {
      if (survivor) return { ...current, status: "recovery_required",
        errorType: "PREFLIGHT_OWNERSHIP_UNCONFIRMED", error: "Process tree termination needs confirmation before retry." };
      if (current.replan?.prepared === false) return { ...current, status: "failed",
        completedAt: owned.completedAt ?? new Date().toISOString(), errorType: "PREFLIGHT_REPLAN_PREPARATION_FAILED",
        error: current.error ?? "Replan approval preparation did not finish; retry replan." };
      const duplicate = owned.result?.decomposition?.refused?.errorType === "duplicate_claimants";
      const matches = owned.result && owned.result.taskId === current.taskId &&
        preflightReportMatchesInput(owned.result, current.input.contentHash) &&
        owned.result.schemaPolicyHash === current.input.schemaPolicyHash &&
        (owned.result.gate.readinessJudgmentMode ?? "off") === current.input.readinessJudgmentMode &&
        (!current.force || Date.parse(owned.result.timestamp) >= Date.parse(current.acceptedAt));
      if (owned.status === "completed" && owned.result && matches && !duplicate) {
        return { ...current, status: "completed", completedAt: owned.completedAt,
          result: owned.result, error: undefined, errorType: undefined };
      }
      let failure: { errorType?: string; message?: string; claimants?: string[] } = {};
      try {
        const parsed = JSON.parse(owned.diagnostics?.stderr ?? "") as Record<string, unknown>;
        if (parsed.jobId === current.jobId && typeof parsed.errorType === "string") {
          failure = { errorType: parsed.errorType,
            ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
            ...(Array.isArray(parsed.claimants) && parsed.claimants.every((item) => typeof item === "string")
              ? { claimants: parsed.claimants } : {}) };
        }
      } catch { /* Non-JSON runtime failures retain their bounded diagnostic text. */ }
      const message = duplicate ? "duplicate_claimants" : failure.message ?? owned.error ?? "Preflight result identity mismatch";
      return { ...current, status: "failed", completedAt: owned.completedAt ?? new Date().toISOString(),
        error: message, ...(failure.claimants ? { claimants: failure.claimants } : {}),
        errorType: duplicate ? "duplicate_claimants" : failure.errorType ?? (
          owned.exitCode === 0 ? "PREFLIGHT_INVALID_RESULT" : "PREFLIGHT_CHILD_FAILED"
        ),
        diagnostics: { ...toRuntimeDiagnostics(message, "preflight_child"),
          ...(owned.exitCode === null || owned.exitCode === undefined ? {} : { exitCode: owned.exitCode }),
          stderrTail: owned.diagnostics?.stderr ?? "" },
      };
    });
    this.unpublished.delete(attempt.jobId);
    this.attempts.delete(attempt.taskId);
    await this.emit(job.status === "completed" ? "preflight_job_completed" : "preflight_job_failed", job);
  }

  private async emit(stage: PreflightJobStage, job: PreflightJob): Promise<void> {
    try {
      new EventWriter({ sessionId: "preflight", taskId: job.taskId, project: job.projectId,
        logDir: this.options.logDir ?? path.join(this.projectRoot, ".quack/logs") }).emit(stage, { ...job });
      this.options.onEvent?.(stage, structuredClone(job));
      if (job.replan && (job.status === "completed" || job.status === "failed")) {
        const replaced = this.store.completedReplan(job.taskId)?.jobId === job.jobId;
        new EventWriter({ sessionId: "approval", taskId: job.taskId, project: job.projectId,
          logDir: this.options.logDir ?? path.join(this.projectRoot, ".quack/logs") }).emit(
          replaced ? "blueprint_replan_complete" : "blueprint_replan_failed", {
            taskId: job.taskId, jobId: job.jobId,
            ...(replaced ? {} : { error: job.error ?? "Fresh replacement is unavailable; retry replan." }),
          });
      }
    }
    catch (error) {
      try { await this.store.recordEventError(job.taskId, job.jobId, error instanceof Error ? error.message : String(error)); }
      catch { console.error(`Preflight event diagnostics could not be saved for ${job.jobId}`); }
    }
  }

  getJob(taskId: string, jobId?: string): PreflightJob | undefined {
    const job = jobId ? this.store.read(taskId, jobId) : this.store.latest(taskId);
    return job && this.withPublicationStatus(job);
  }

  private withPublicationStatus<T extends PreflightJob | PreflightJobSummary>(job: T): T {
    return this.unpublished.has(job.jobId) && job.status !== "completed" && job.status !== "failed"
      ? { ...job, status: "recovery_required", errorType: "PREFLIGHT_PUBLICATION_FAILED",
        error: "The child closed, but its result could not be recorded. Retry recovery after restoring storage." }
      : job;
  }

  async reconcile(taskId: string, jobId: string, revision: number, token: string, confirmed: boolean): Promise<PreflightJob> {
    const current = this.store.read(taskId, jobId);
    if (!current || current.revision !== revision || current.confirmationToken !== token || !confirmed ||
      this.supervisor.getActiveJob(taskId)) throw new PreflightJobConflict("PREFLIGHT_RECOVERY_CONFIRMATION_REQUIRED", current);
    const unpublished = this.unpublished.get(jobId);
    if (unpublished) { await this.publishTerminal(unpublished); return this.store.read(taskId, jobId)!; }
    const survivor = this.supervisor.getShutdownSurvivors().find((item) => item.taskId === taskId);
    if (survivor && !this.supervisor.reconcileShutdownSurvivor(taskId, survivor.confirmationToken, true)) {
      throw new PreflightJobConflict("PREFLIGHT_RECOVERY_REQUIRED", current);
    }
    return this.store.reconcile(taskId, jobId, revision, token, true);
  }

  getActiveJobs(): PreflightJob[] {
    return this.getStatusSnapshot().jobs.filter((job) => job.status !== "completed" && job.status !== "failed")
      .map(({ result: _result, ...job }) => job);
  }

  /** Restored recovery records are retained uncertainty, not a child owned here. */
  hasActiveWork(): boolean {
    return this.hasLiveProcesses() || this.getActiveJobs().some((job) => job.status !== "recovery_required");
  }

  getStatusSnapshot(): { jobs: PreflightJobSummary[]; storageIssues: PreflightStorageIssue[]; unconfirmedShutdownTasks: string[]; shutdownUnconfirmed: boolean } {
    // Return issues from this enumeration with its rows, not from a prior reader.
    const jobs = this.store.listSummaries().map((job) => this.withPublicationStatus(job));
    return { jobs, storageIssues: this.store.getReadIssues(), unconfirmedShutdownTasks: [...this.unconfirmedShutdownTasks], shutdownUnconfirmed: !this.supervisor.canResumeAfterShutdown() };
  }

  hasLiveProcesses(): boolean {
    // Storage uncertainty separately blocks drain certification, not cleanup of
    // processes this monitor owns. Unregistration never deletes retained records.
    return this.supervisor.hasLiveProcesses() || this.scheduled.size > 0 || this.pending.size > 0 || this.unpublished.size > 0;
  }

  beginTerminalDrain(): void {
    this.draining = true;
    this.supervisor.beginTerminalDrain();
  }

  shutdownAll(options: OwnedCommandShutdownOptions = {}): Promise<OwnedCommandShutdownResult> {
    this.beginTerminalDrain();
    this.shutdownPromise ??= this.shutdownOwned(options).finally(() => { this.shutdownPromise = undefined; });
    return this.shutdownPromise;
  }

  private async shutdownOwned(options: OwnedCommandShutdownOptions): Promise<OwnedCommandShutdownResult> {
    for (const [jobId, handle] of this.scheduled) {
      clearImmediate(handle);
      const job = [...this.attempts.values()].find((item) => item.jobId === jobId);
      if (job) this.track(this.failBeforeLaunch(job, "Preflight interrupted before launch"));
    }
    this.scheduled.clear();
    const result = await this.supervisor.shutdownAll(options);
    this.unconfirmedShutdownTasks = [...result.timedOut];
    await this.waitForIdle();
    for (const taskId of result.timedOut) {
      const job = this.attempts.get(taskId);
      if (job) await this.store.update(taskId, job.jobId, job.owner.instanceId, (current) => ({ ...current,
        status: "recovery_required", errorType: "PREFLIGHT_OWNERSHIP_UNCONFIRMED",
        error: "Process tree termination needs confirmation before retry." }));
    }
    return result;
  }

  async waitForIdle(timeoutMs = 5000): Promise<boolean> {
    const idle = await this.supervisor.waitForIdle(timeoutMs);
    // Each store operation already has the bounded owner-fenced lock deadline.
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    return idle && this.scheduled.size === 0;
  }
}
