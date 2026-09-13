import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  currentFederatedLockProcessIdentity, probeFederatedLockProcessIdentity,
  withOwnerFencedFileLock,
} from "./federation/store.js";
import {
  parseFullPreflightResult, preflightReportMatchesInput, preflightHashSchema, preflightJobIdSchema,
  type StampedPreflightResult,
} from "./preflight-job-result.js";

const MAX_RECORD_BYTES = 5 * 1024 * 1024;
export const MAX_RETAINED_PREFLIGHT_HISTORY = 20;
const inputSchema = z.object({
  contentHash: preflightHashSchema,
  schemaPolicyHash: preflightHashSchema,
  readinessJudgmentMode: z.enum(["off", "shadow", "enforce"]),
  requestedMode: z.enum(["auto", "deterministic"]),
}).strict();
const ownerSchema = z.object({
  instanceId: preflightJobIdSchema, host: z.string().min(1), pid: z.number().int().positive(),
  bootId: z.string().min(1), startedAt: z.string().min(1),
}).strict();
const replanSchema = z.object({
  approvalDigest: preflightHashSchema, approvalLogDir: z.string().min(1),
  requestedApprovalDigest: preflightHashSchema.optional(), prepared: z.boolean().optional(),
}).strict();
const jobSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), taskId: z.string().min(1),
  jobId: preflightJobIdSchema, revision: z.number().int().positive(),
  owner: ownerSchema, confirmationToken: preflightJobIdSchema, input: inputSchema,
  force: z.boolean(), route: z.enum(["preflight", "replan"]), preserveApprovals: z.boolean().optional(),
  status: z.enum(["accepted", "running", "completed", "failed", "recovery_required"]),
  acceptedAt: z.string().datetime(), startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(), pid: z.number().int().nonnegative().optional(),
  replan: replanSchema.optional(), result: z.unknown().optional(),
  error: z.string().optional(), errorType: z.string().optional(),
  claimants: z.array(z.string()).optional(),
  diagnostics: z.object({
    kind: z.enum(["runtime_unavailable", "spec_failed", "validation_failed", "internal_error"]),
    stage: z.string(), exitCode: z.number().int().optional(), stderrTail: z.string().optional(),
    retryable: z.boolean(),
  }).optional(),
  eventError: z.string().optional(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), projectId: z.string(), taskId: z.string(),
  activeJobId: preflightJobIdSchema.optional(), latestJobId: preflightJobIdSchema.optional(),
  supersededByJobId: preflightJobIdSchema.optional(),
  completedReplanJobId: preflightJobIdSchema.optional(),
}).strict();

export type PreflightInputIdentity = z.infer<typeof inputSchema>;
export type PreflightOwner = z.infer<typeof ownerSchema>;
export type PreflightReplan = z.infer<typeof replanSchema>;
export type PreflightJob = Omit<z.infer<typeof jobSchema>, "result"> & { result?: StampedPreflightResult };
export type PreflightJobSummary = Omit<PreflightJob, "result"> & {
  reportSummary: true;
  result?: Pick<StampedPreflightResult, "mode" | "degraded" | "gate"> & {
    blueprint: Pick<StampedPreflightResult["blueprint"], "structuredPreserved" | "fidelity"> & {
      structured: { fidelity?: StampedPreflightResult["blueprint"]["fidelity"] }; hasMarkdown: boolean;
    };
  };
};

function summarizeJob(job: PreflightJob): PreflightJobSummary {
  const { result, ...summary } = job;
  return { ...summary, reportSummary: true, ...(result ? { result: {
    mode: result.mode, degraded: result.degraded, gate: result.gate,
    blueprint: { structuredPreserved: result.blueprint.structuredPreserved, fidelity: result.blueprint.fidelity,
      structured: { fidelity: result.blueprint.structured?.fidelity },
      hasMarkdown: Boolean(result.blueprint.formattedMarkdown.trim()) },
  } } : {}) };
}
type TaskState = z.infer<typeof stateSchema>;

export class PreflightJobConflict extends Error {
  constructor(readonly code: string, readonly job?: PreflightJob) {
    super(code === "PREFLIGHT_REPLAN_PENDING"
      ? "A blueprint replan is unfinished. Use Replan blueprint to continue it."
      : code === "PREFLIGHT_REPLAN_REQUIRES_SEPARATE_ATTEMPT"
        ? "Wait for the fresh preflight to finish, then use Replan blueprint for a separate attempt."
        : code);
  }
}

export interface PreflightStorageIssue { taskId?: string; path: string; message: string }
export class PreflightStorageError extends Error {
  readonly code = "PREFLIGHT_STORAGE_RECOVERY_REQUIRED";
  constructor(readonly taskId: string, readonly recordPath: string, detail: string) {
    super(`Preflight storage for ${taskId} needs recovery: ${detail}. Restore the retained record; do not discard ownership or replan evidence to retry.`);
  }
}

export async function createPreflightOwner(projectRoot: string): Promise<PreflightOwner> {
  // Native identity probes can transiently return unknown (observed on Windows).
  // Retry identity acquisition once, before reserving or launching any work;
  // an unproven second attempt still refuses rather than falling back to a PID.
  let identity;
  try { identity = await currentFederatedLockProcessIdentity(projectRoot); }
  catch {
    await delay(100);
    identity = await currentFederatedLockProcessIdentity(projectRoot);
  }
  return { instanceId: randomUUID(), host: hostname(), pid: process.pid,
    ...identity };
}

function terminal(job: PreflightJob): boolean {
  return job.status === "completed" || job.status === "failed";
}

/** Durable attempts are diagnostics, never readiness/cache authority. */
export class PreflightJobStore {
  readonly projectRoot: string;
  private readonly directory: string;
  private readIssues: PreflightStorageIssue[] = [];
  private readonly warnedIssues = new Set<string>();
  // Display-only, one small summary per task. Exact reads/admission always validate disk.
  private readonly summaries = new Map<string, { signature: string; job: PreflightJobSummary }>();
  constructor(projectRoot: string, readonly projectId: string) {
    this.projectRoot = fs.realpathSync(projectRoot);
    this.directory = path.join(this.projectRoot, ".quack", "preflight-jobs");
  }

  private taskDirectory(taskId: string): string {
    if (!taskId) throw new Error("A task id is required");
    return path.join(this.directory, Buffer.from(taskId).toString("base64url"));
  }

  private readJson(filename: string): unknown {
    try {
      if (fs.statSync(filename).size > MAX_RECORD_BYTES) throw new Error("Preflight record exceeds size limit");
      const text = fs.readFileSync(filename, "utf8");
      if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error("Preflight record exceeds size limit");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private writeJson(filename: string, value: unknown): void {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error("Preflight record exceeds size limit");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private state(taskId: string): TaskState {
    const filename = path.join(this.taskDirectory(taskId), "state.json");
    try {
      const raw = this.readJson(filename);
      if (raw === undefined) return { version: 1, projectId: this.projectId, taskId };
      const state = stateSchema.parse(raw);
      if (state.taskId !== taskId || state.projectId !== this.projectId) throw new Error("Preflight state identity mismatch");
      return state;
    } catch (error) { throw new PreflightStorageError(taskId, filename, error instanceof Error ? error.message : String(error)); }
  }

  private writeState(state: TaskState): void {
    this.writeJson(path.join(this.taskDirectory(state.taskId), "state.json"), stateSchema.parse(state));
  }

  private applyTerminalState(state: TaskState, job: PreflightJob): void {
    delete state.activeJobId;
    if (job.status === "completed" && job.result?.mode === "full" &&
      !job.result.degraded && !job.result.blueprint.structuredPreserved && job.replan?.prepared !== false &&
      job.result.blueprint.formattedMarkdown.trim().length > 0 &&
      job.result.blueprint.fidelity?.status !== "failed" && job.result.blueprint.structured?.fidelity?.status !== "failed" &&
      state.supersededByJobId === job.jobId) {
      delete state.supersededByJobId;
      state.completedReplanJobId = job.jobId;
    }
  }

  read(taskId: string, jobId: string): PreflightJob | undefined {
    preflightJobIdSchema.parse(jobId);
    const filename = path.join(this.taskDirectory(taskId), `${jobId}.json`);
    try {
      const raw = this.readJson(filename);
      if (raw === undefined) return undefined;
      return this.validateJob(raw, taskId, jobId);
    } catch (error) { throw new PreflightStorageError(taskId, filename, error instanceof Error ? error.message : String(error)); }
  }

  private validateJob(raw: unknown, taskId: string, jobId: string): PreflightJob {
    const parsed = jobSchema.parse(raw);
    if (parsed.preserveApprovals && (parsed.replan || parsed.route !== "preflight" || !parsed.force)) {
      throw new Error("An approval-preserving preflight must be fresh and cannot carry a replan");
    }
    if (parsed.jobId !== jobId || parsed.taskId !== taskId || parsed.projectId !== this.projectId) {
      throw new Error("Preflight job identity mismatch");
    }
    const result = parsed.result === undefined ? undefined : parseFullPreflightResult(parsed.result);
    if (parsed.status === "completed" && (!result || !parsed.completedAt)) throw new Error("Incomplete terminal preflight record");
    if (parsed.status === "failed" && !parsed.completedAt) throw new Error("Incomplete failed preflight record");
    if (result && (result.taskId !== taskId || !preflightReportMatchesInput(result, parsed.input.contentHash) ||
      result.schemaPolicyHash !== parsed.input.schemaPolicyHash ||
      (result.gate.readinessJudgmentMode ?? "off") !== parsed.input.readinessJudgmentMode)) {
      throw new Error("Preflight report identity mismatch");
    }
    return { ...parsed, result };
  }

  latest(taskId: string): PreflightJob | undefined {
    const state = this.state(taskId);
    const id = state.activeJobId ?? state.latestJobId;
    if (!id) return undefined;
    const job = this.read(taskId, id);
    if (!job) throw new PreflightStorageError(taskId, this.taskDirectory(taskId), "Preflight state references a missing attempt");
    return job;
  }

  private exclusive<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    return withOwnerFencedFileLock(path.join(this.taskDirectory(taskId), "mutation.lock"), this.projectRoot, action);
  }

  async reserve(taskId: string, input: PreflightInputIdentity, options: {
    owner: PreflightOwner; force: boolean; preserveApprovals?: boolean; replan?: PreflightReplan;
    prepareReplan?: () => Promise<PreflightReplan>;
  }): Promise<{ job: PreflightJob; created: boolean }> {
    input = inputSchema.parse(input);
    ownerSchema.parse(options.owner);
    if (options.replan) replanSchema.parse(options.replan);
    if (options.preserveApprovals && (!options.force || options.replan || options.prepareReplan)) {
      throw new PreflightJobConflict("PREFLIGHT_INVALID_OPTIONS");
    }
    return this.exclusive<{ job: PreflightJob; created: boolean }>(taskId, async () => {
      const state = this.state(taskId);
      const active = state.activeJobId ? this.read(taskId, state.activeJobId) : undefined;
      if (state.activeJobId && !active) throw new PreflightStorageError(taskId, this.taskDirectory(taskId), "Missing active preflight record");
      // A crash can follow terminal publication but precede index release.
      if (active && terminal(active)) {
        this.applyTerminalState(state, active);
        this.writeState(state);
      }
      if (active && !terminal(active)) {
        if (active.status === "recovery_required") throw new PreflightJobConflict("PREFLIGHT_RECOVERY_REQUIRED", active);
        if (JSON.stringify(active.input) !== JSON.stringify(input)) throw new PreflightJobConflict("PREFLIGHT_INPUT_CHANGED", active);
        if (options.preserveApprovals && active.replan) throw new PreflightJobConflict("PREFLIGHT_REPLAN_PENDING", active);
        if (active.preserveApprovals && (options.replan || options.prepareReplan)) {
          throw new PreflightJobConflict("PREFLIGHT_REPLAN_REQUIRES_SEPARATE_ATTEMPT", active);
        }
        if (options.replan && !active.force) throw new PreflightJobConflict("PREFLIGHT_REPLAN_REQUIRES_FRESH_ATTEMPT", active);
        if (options.replan && active.replan && (options.replan.approvalLogDir !== active.replan.approvalLogDir ||
          (options.replan.approvalDigest !== active.replan.approvalDigest &&
            options.replan.approvalDigest !== active.replan.requestedApprovalDigest))) {
          throw new PreflightJobConflict("PREFLIGHT_REPLAN_CHANGED", active);
        }
        if (options.replan && !active.replan) {
          active.replan = options.replan;
          active.revision++;
          this.writeJson(path.join(this.taskDirectory(taskId), `${active.jobId}.json`), active);
          state.supersededByJobId = active.jobId;
          this.writeState(state);
        }
        await this.prepareReplan(active, false, options.prepareReplan);
        return { job: active, created: false };
      }
      const previousJob = state.supersededByJobId ? this.read(taskId, state.supersededByJobId) : undefined;
      const previousReplan = previousJob?.replan;
      if (state.supersededByJobId && !previousReplan) throw new PreflightStorageError(taskId, this.taskDirectory(taskId), "Missing replan supersession evidence");
      if (previousReplan && options.preserveApprovals) throw new PreflightJobConflict("PREFLIGHT_REPLAN_PENDING", previousJob);
      if (previousReplan && !options.force && !options.replan) throw new PreflightJobConflict("PREFLIGHT_FRESH_REPLACEMENT_REQUIRED");
      if (previousReplan?.prepared === false && !options.prepareReplan) {
        throw new PreflightJobConflict("PREFLIGHT_REPLAN_PREPARATION_REQUIRED");
      }
      const replan = options.replan ?? previousReplan;
      const job: PreflightJob = {
        version: 1, projectId: this.projectId, taskId, jobId: randomUUID(), revision: 1,
        owner: options.owner, confirmationToken: randomUUID(), input,
        force: replan ? true : options.force, route: options.replan ? "replan" : "preflight",
        ...(options.preserveApprovals ? { preserveApprovals: true } : {}),
        status: "accepted", acceptedAt: new Date().toISOString(), ...(replan ? { replan } : {}),
      };
      this.writeJson(path.join(this.taskDirectory(taskId), `${job.jobId}.json`), job);
      this.writeState({ ...state, activeJobId: job.jobId, latestJobId: job.jobId,
        ...(replan ? { supersededByJobId: job.jobId } : {}) });
      await this.prepareReplan(job, true, options.prepareReplan);
      return { job, created: true };
    });
  }

  /** Called only inside the reservation lock; never surrounds model execution. */
  private async prepareReplan(job: PreflightJob, created: boolean,
    prepare?: () => Promise<PreflightReplan>): Promise<void> {
    if (!prepare || !job.replan || job.replan.prepared !== false) return;
    const requested = job.replan;
    try {
      const receipt = replanSchema.parse(await prepare());
      if (receipt.approvalLogDir !== requested.approvalLogDir) throw new Error("Replan approval location changed");
      job.replan = { ...receipt, prepared: true,
        requestedApprovalDigest: requested.requestedApprovalDigest ?? requested.approvalDigest };
      job.revision++;
      this.writeJson(path.join(this.taskDirectory(job.taskId), `${job.jobId}.json`), job);
    } catch (error) {
      job.replan = { ...requested, prepared: false };
      job.error = error instanceof Error ? error.message : String(error);
      job.errorType = "PREFLIGHT_REPLAN_PREPARATION_FAILED";
      job.revision++;
      if (created) {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
      }
      this.writeJson(path.join(this.taskDirectory(job.taskId), `${job.jobId}.json`), job);
      if (created) {
        const state = this.state(job.taskId);
        this.applyTerminalState(state, job);
        this.writeState(state);
      }
      throw new PreflightJobConflict("PREFLIGHT_REPLAN_PREPARATION_FAILED", job);
    }
  }

  async update(taskId: string, jobId: string, ownerToken: string,
    change: (job: PreflightJob) => PreflightJob): Promise<PreflightJob> {
    return this.exclusive(taskId, () => {
      const state = this.state(taskId);
      const current = this.read(taskId, jobId);
      if (!current || state.activeJobId !== jobId || current.owner.instanceId !== ownerToken || terminal(current)) {
        throw new PreflightJobConflict("PREFLIGHT_ATTEMPT_CHANGED", current);
      }
      const updated = change(structuredClone(current));
      if (updated.jobId !== current.jobId || updated.taskId !== current.taskId ||
        updated.projectId !== current.projectId || JSON.stringify(updated.input) !== JSON.stringify(current.input) ||
        JSON.stringify(updated.owner) !== JSON.stringify(current.owner) || updated.confirmationToken !== current.confirmationToken ||
        updated.acceptedAt !== current.acceptedAt || updated.force !== current.force || updated.route !== current.route ||
        updated.preserveApprovals !== current.preserveApprovals) {
        throw new Error("Preflight attempt identity is immutable");
      }
      updated.revision = current.revision + 1;
      const filename = path.join(this.taskDirectory(taskId), `${jobId}.json`);
      const validated = this.validateJob(updated, taskId, jobId);
      // Terminal record wins before index release or any caller emits an event.
      this.writeJson(filename, validated);
      if (terminal(validated)) {
        this.applyTerminalState(state, validated);
        this.writeState(state);
        this.pruneTerminalHistory(state);
      }
      return Promise.resolve(validated);
    });
  }

  /** Repair only the terminal/index publication window; never release live work. */
  async repairTerminalIndex(taskId: string): Promise<PreflightJob | undefined> {
    const state = this.state(taskId);
    const current = this.latest(taskId);
    if (!state.activeJobId || !current || !terminal(current)) return current;
    return this.exclusive(taskId, () => {
      const latestState = this.state(taskId);
      const active = latestState.activeJobId ? this.read(taskId, latestState.activeJobId) : undefined;
      if (active && terminal(active)) {
        this.applyTerminalState(latestState, active);
        this.writeState(latestState);
      }
      return Promise.resolve(this.latest(taskId));
    });
  }

  /** A restored owner is never killed by numeric PID. Retain unproven work. */
  async recover(taskId: string): Promise<PreflightJob | undefined> {
    const current = await this.repairTerminalIndex(taskId);
    if (!current || terminal(current) || current.status === "recovery_required") return current;
    const probe = current.owner.host === hostname()
      ? await probeFederatedLockProcessIdentity(this.projectRoot, current.owner.pid,
        { reuseVerifiedSelfIdentity: true }) : { state: "unknown" as const };
    if (probe.state === "alive" && probe.identity.bootId === current.owner.bootId &&
      probe.identity.startedAt === current.owner.startedAt) return current;
    return this.update(taskId, current.jobId, current.owner.instanceId, (job) => ({ ...job,
      status: "recovery_required", errorType: "PREFLIGHT_OWNERSHIP_UNCONFIRMED",
      error: "Confirm the original process tree has stopped before retrying this attempt.",
    }));
  }

  async reconcile(taskId: string, jobId: string, revision: number, confirmationToken: string,
    processTreeConfirmedStopped: boolean): Promise<PreflightJob> {
    const job = this.read(taskId, jobId);
    if (!job || !processTreeConfirmedStopped || job.status !== "recovery_required" ||
      job.revision !== revision || job.confirmationToken !== confirmationToken) {
      throw new PreflightJobConflict("PREFLIGHT_RECOVERY_CONFIRMATION_REQUIRED", job);
    }
    return this.update(taskId, jobId, job.owner.instanceId, (current) => {
      if (current.revision !== revision || current.status !== "recovery_required") throw new PreflightJobConflict("PREFLIGHT_ATTEMPT_CHANGED", current);
      return { ...current, status: "failed", completedAt: new Date().toISOString(),
        errorType: "PREFLIGHT_INTERRUPTED", error: "Interrupted attempt reconciled; retry preflight." };
    });
  }

  supersession(taskId: string): PreflightJob | undefined {
    const state = this.state(taskId);
    if (!state.supersededByJobId) return undefined;
    const job = this.read(taskId, state.supersededByJobId);
    if (!job?.replan) throw new PreflightStorageError(taskId, this.taskDirectory(taskId), "Missing preflight supersession evidence");
    return job;
  }

  completedReplan(taskId: string): PreflightJob | undefined {
    const id = this.state(taskId).completedReplanJobId;
    if (!id) return undefined;
    const job = this.read(taskId, id);
    if (!job?.replan || job.status !== "completed") throw new PreflightStorageError(taskId, this.taskDirectory(taskId), "Invalid completed replan receipt");
    return job;
  }

  listLatest(): PreflightJob[] {
    return this.enumerate((taskId) => this.latest(taskId));
  }

  /** Only indexed active attempts need ownership or terminal-index recovery. */
  listRecoveryTaskIds(): string[] {
    return this.enumerate((taskId) => this.state(taskId).activeJobId ? taskId : undefined);
  }

  /** Stat-fenced display cache avoids loading report bodies on every dashboard/drain poll. */
  listSummaries(): PreflightJobSummary[] {
    const jobs = this.enumerate((taskId) => {
      const state = this.state(taskId);
      const id = state.activeJobId ?? state.latestJobId;
      if (!id) { this.summaries.delete(taskId); return undefined; }
      const filename = path.join(this.taskDirectory(taskId), `${id}.json`);
      try {
        const stat = fs.statSync(filename, { bigint: true });
        const signature = `${id}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        const cached = this.summaries.get(taskId);
        if (cached?.signature === signature) return structuredClone(cached.job);
        const job = this.read(taskId, id);
        if (!job) throw new Error("Preflight state references a missing attempt");
        const summary = summarizeJob(job);
        this.summaries.set(taskId, { signature, job: summary });
        return structuredClone(summary);
      } catch (error) {
        this.summaries.delete(taskId);
        if (error instanceof PreflightStorageError) throw error;
        throw new PreflightStorageError(taskId, filename, error instanceof Error ? error.message : String(error));
      }
    });
    const retained = new Set(jobs.map((job) => job.taskId));
    for (const taskId of this.summaries.keys()) if (!retained.has(taskId)) this.summaries.delete(taskId);
    return jobs;
  }

  private enumerate<T>(read: (taskId: string) => T | undefined): T[] {
    this.readIssues = [];
    const jobs: T[] = [];
    try {
      if (!fs.existsSync(this.directory)) return jobs;
      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
        // Editor files and noncanonical names cannot be owned task records.
        if (!entry.isDirectory()) continue;
        const taskId = Buffer.from(entry.name, "base64url").toString("utf8");
        if (!taskId || Buffer.from(taskId).toString("base64url") !== entry.name) continue;
        try { const job = read(taskId); if (job) jobs.push(job); }
        catch (error) { this.recordReadIssue(taskId, error); }
      }
    } catch (error) { this.recordReadIssue(undefined, error); }
    return jobs;
  }

  recordReadIssue(taskId: string | undefined, error: unknown): void {
    const issue: PreflightStorageIssue = { ...(taskId ? { taskId } : {}),
      path: taskId ? this.taskDirectory(taskId) : this.directory,
      message: error instanceof Error ? error.message : String(error) };
    this.readIssues.push(issue);
    const key = `${issue.path}:${issue.message}`;
    if (!this.warnedIssues.has(key)) { this.warnedIssues.add(key); console.warn("[preflight-storage]", issue); }
  }

  getReadIssues(): PreflightStorageIssue[] { return this.readIssues.map((issue) => ({ ...issue })); }

  /** Only unreferenced, validated terminal history expires. Ownership/approval receipts never do. */
  private pruneTerminalHistory(state: TaskState): void {
    try {
      const directory = this.taskDirectory(state.taskId);
      if (fs.lstatSync(directory).isSymbolicLink()) return;
      const protectedIds = new Set([state.activeJobId, state.latestJobId, state.supersededByJobId, state.completedReplanJobId]);
      const old: PreflightJob[] = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        if (!preflightJobIdSchema.safeParse(id).success || protectedIds.has(id)) continue;
        try { const job = this.read(state.taskId, id); if (job && terminal(job)) old.push(job); }
        catch { /* Preserve unproven records for operator recovery; never delete them as history. */ }
      }
      old.sort((a, b) => (b.completedAt ?? b.acceptedAt).localeCompare(a.completedAt ?? a.acceptedAt) || b.jobId.localeCompare(a.jobId));
      for (const job of old.slice(MAX_RETAINED_PREFLIGHT_HISTORY)) fs.unlinkSync(path.join(directory, `${job.jobId}.json`));
    } catch (error) {
      // Publication already succeeded. Retention failure cannot turn that report into failure.
      console.warn("[preflight-storage] History retention failed:", error instanceof Error ? error.message : String(error));
    }
  }

  async recordEventError(taskId: string, jobId: string, message: string): Promise<void> {
    return this.exclusive(taskId, () => {
      const job = this.read(taskId, jobId);
      if (!job) throw new Error("Missing preflight attempt");
      this.writeJson(path.join(this.taskDirectory(taskId), `${jobId}.json`), {
        ...job, eventError: message.slice(0, 1000),
      });
      return Promise.resolve();
    });
  }
}
