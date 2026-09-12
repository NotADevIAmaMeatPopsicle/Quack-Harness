import { buildClaudeChildEnvironment, selectClaudeApiKey } from "../sdk/claude-auth.js";
import type { KeyManager } from "../dispatcher/key-manager.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  getAdminRunStagePolicy,
  isAdminRunStage,
  type AdminRunStage,
  type AdminRunStageProgress,
} from "./admin-run-stage-policy.js";
import {
  cleanupTrustedNodeLaunch,
  confirmWindowsNodeLaunchAlreadyExited,
  spawnTrustedNode,
  terminateWindowsNodeJob,
  type TrustedNodeLaunch,
} from "./trusted-node-launch.js";

export type AdminRunStatus = "running" | "completed" | "failed" | "stopped";

export interface AdminRunCheckpointSummary {
  path: string;
  exists: boolean;
  updatedAt?: string;
  halted?: boolean;
  haltReason?: string;
  tasks?: Array<{
    taskId: string;
    status: string;
    lastError?: string;
    sessionId?: string;
    subtaskIds?: string[];
  }>;
  events?: Array<{
    timestamp: string;
    type: string;
    taskId?: string;
    message: string;
  }>;
  currentStage?: AdminRunStageProgress;
}

export type AdminRunWatchdogStatus = "healthy" | "stale_output" | "stalled" | "terminal";

export interface AdminRunWatchdog {
  status: AdminRunWatchdogStatus;
  reason: string;
  recommendedAction: string;
  stage: AdminRunStage;
  stageAgeMs: number;
  heartbeatAgeMs: number;
  outputIdleMs: number;
  outputStaleAfterMs: number;
}

export interface AdminRunSnapshot {
  runId: string;
  action: "overnight";
  projectId: string;
  projectRoot: string;
  status: AdminRunStatus;
  stage: AdminRunStage;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  stageStartedAt: string;
  completedAt?: string;
  durationMs: number;
  lastHeartbeatAt: string;
  lastOutputAt?: string;
  command: string[];
  checkpointPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stdoutTail: string[];
  stderrTail: string[];
  checkpoint?: AdminRunCheckpointSummary;
  watchdog: AdminRunWatchdog;
}

export interface StartOvernightAdminRunOptions {
  /** Supplied only by the resolved host project, never copied from an API body. */
  keyManager?: KeyManager;
  projectId: string;
  projectRoot: string;
  monitorUrl: string;
  taskIds?: string[];
  sourceBranch?: string;
  targetBranch?: string;
  checkpointPath?: string;
  allowParseErrors?: boolean;
  once?: boolean;
  maxDispatches?: number;
  maxCycles?: number;
  maxSubtasks?: number;
  autoEnrich?: boolean;
  autoDecompose?: boolean;
  verifyAfterDispatch?: boolean;
  dryRun?: boolean;
  /** When true, dispatch through /v1/federation/queue (requires QUACK_SERVICE_TOKEN). */
  federationDispatch?: boolean;
  /** Preferred federation host ID (operator-controlled; do not hard-code). */
  preferredHostId?: string;
  /** When true, pass allowLowPreflight:true to the federation queue. */
  allowLowPreflightOnFederationDispatch?: boolean;
  /** When true, auto-decompose proceeds to finalize without operator review. */
  autoAcknowledgeDecomposeReview?: boolean;
}

interface AdminRunRecord {
  runId: string;
  action: "overnight";
  projectId: string;
  projectRoot: string;
  status: AdminRunStatus;
  stage: AdminRunStage;
  child: ChildProcess;
  launch: TrustedNodeLaunch;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  stageStartedAt: string;
  completedAt?: string;
  lastHeartbeatAt: string;
  lastOutputAt?: string;
  command: string[];
  checkpointPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stdoutTail: string[];
  stderrTail: string[];
  heartbeatTimer?: NodeJS.Timeout;
  stopTerminationUnconfirmed?: boolean;
}

interface AdminRunTimingState {
  status: AdminRunStatus;
  stage: AdminRunStage;
  startedAt: string;
  stageStartedAt: string;
  completedAt?: string;
  lastHeartbeatAt: string;
  lastOutputAt?: string;
}

export interface AdminRunManagerOptions {
  heartbeatIntervalMs?: number;
}

const MAX_TAIL_LINES = 120;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const TERMINAL_STATUSES: AdminRunStatus[] = ["completed", "failed", "stopped"];

export class AdminRunManager {
  private readonly runs = new Map<string, AdminRunRecord>();
  private readonly heartbeatIntervalMs: number;
  private terminalDrain = false;

  constructor(
    private readonly quackBin: string,
    options: AdminRunManagerOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  startOvernight(options: StartOvernightAdminRunOptions): AdminRunSnapshot {
    if (this.terminalDrain) {
      throw new Error("Admin run manager is terminally drained and cannot start new work");
    }
    const runId = createRunId("overnight");
    const checkpointPath =
      options.checkpointPath ??
      path.join(options.projectRoot, ".quack", "admin-runs", `${runId}-checkpoint.json`);
    const args = this.buildOvernightArgs(options, checkpointPath);
    const quackRoot = path.resolve(path.dirname(this.quackBin), "..");
    const launch = spawnTrustedNode({
      projectRoot: options.projectRoot,
      scriptPath: this.quackBin,
      args: args.slice(1),
      cwd: quackRoot,
      env: buildClaudeChildEnvironment(
        process.env,
        options.keyManager ? selectClaudeApiKey(options.keyManager) : undefined,
        true,
      ),
    });
    const child = launch.child;

    const now = new Date().toISOString();
    const record: AdminRunRecord = {
      runId,
      action: "overnight",
      projectId: options.projectId,
      projectRoot: options.projectRoot,
      status: "running",
      stage: "starting",
      child,
      launch,
      startedAt: now,
      updatedAt: now,
      stageStartedAt: now,
      lastHeartbeatAt: now,
      lastOutputAt: now,
      command: [launch.executablePath, ...args],
      checkpointPath,
      stdoutTail: [],
      stderrTail: [],
    };
    if (child.pid) record.pid = child.pid;
    this.runs.set(runId, record);
    this.startHeartbeat(record);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      this.recordOutput(record, "stdout", chunk);
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      this.recordOutput(record, "stderr", chunk);
    });
    child.on("error", (err) => {
      if (record.stopTerminationUnconfirmed) {
        record.error =
          record.error ?? `Admin process-tree termination remains unconfirmed (${err.message})`;
        this.touch(record);
        this.persistRunBestEffort(record);
        return;
      }
      this.clearHeartbeat(record);
      record.status = "failed";
      record.stage = "failed";
      record.stageStartedAt = new Date().toISOString();
      record.error = err.message;
      this.touch(record);
      this.persistRunBestEffort(record);
      cleanupTrustedNodeLaunch(record.launch);
    });
    child.on("close", (code, signal) => {
      if (record.stopTerminationUnconfirmed) {
        record.exitCode = code;
        record.signal = signal;
        record.error =
          record.error ?? "Admin process exited without positive process-tree termination proof";
        this.touch(record);
        this.persistRunBestEffort(record);
        return;
      }
      this.clearHeartbeat(record);
      record.exitCode = code;
      record.signal = signal;
      record.status = record.status === "stopped" ? "stopped" : code === 0 ? "completed" : "failed";
      record.stage =
        record.status === "completed"
          ? "completed"
          : record.status === "stopped"
            ? "stopped"
            : "failed";
      record.stageStartedAt = new Date().toISOString();
      record.completedAt = new Date().toISOString();
      this.touch(record);
      this.persistRunBestEffort(record);
      cleanupTrustedNodeLaunch(record.launch);
    });

    this.persistRunBestEffort(record);
    return this.toSnapshot(record);
  }

  async listRuns(): Promise<AdminRunSnapshot[]> {
    const snapshots = await Promise.all(
      [...this.runs.values()].map((run) => this.getRun(run.runId)),
    );
    return snapshots
      .filter((run): run is AdminRunSnapshot => !!run)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getRun(runId: string): Promise<AdminRunSnapshot | undefined> {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    const snapshot = this.toSnapshot(record);
    if (record.checkpointPath) {
      snapshot.checkpoint = await readCheckpointSummary(record.checkpointPath);
      this.applyCheckpointTiming(snapshot, snapshot.checkpoint);
    }
    return snapshot;
  }

  stopRun(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record || record.status !== "running") return false;
    const termination = this.terminateRunProcessTree(record);
    if (!termination.confirmed) {
      record.stopTerminationUnconfirmed = true;
      record.error = termination.warning ?? "Admin process-tree termination is unconfirmed";
      this.touch(record);
      this.persistRunBestEffort(record);
      return false;
    }
    if (record.stopTerminationUnconfirmed) record.error = undefined;
    record.stopTerminationUnconfirmed = false;
    record.status = "stopped";
    record.stage = "stopped";
    record.stageStartedAt = new Date().toISOString();
    this.touch(record);
    this.clearHeartbeat(record);
    this.persistRunBestEffort(record);
    return true;
  }

  stopAll(): boolean {
    let allConfirmed = true;
    for (const record of this.runs.values()) {
      if (record.status !== "running") continue;
      if (!this.stopRun(record.runId)) allConfirmed = false;
    }
    return allConfirmed;
  }

  beginTerminalDrain(): void {
    this.terminalDrain = true;
  }

  hasLiveProcesses(): boolean {
    return [...this.runs.values()].some(
      (record) =>
        record.stopTerminationUnconfirmed === true ||
        (record.child.exitCode === null && record.child.signalCode === null),
    );
  }

  private terminateRunProcessTree(record: AdminRunRecord): {
    confirmed: boolean;
    warning?: string;
  } {
    if (process.platform === "win32") {
      if (!record.launch.windowsJob) {
        return { confirmed: false, warning: "Admin run has no Windows Job Object" };
      }
      const result = terminateWindowsNodeJob(record.launch.windowsJob);
      if (!result.confirmed && confirmWindowsNodeLaunchAlreadyExited(record.launch)) {
        return {
          confirmed: true,
          warning:
            "the admin run completed while stop was opening its Job Object; trusted exit evidence proves the wrapper and payload are absent",
        };
      }
      return result;
    }

    const processGroupId = record.child.pid;
    if (!processGroupId || processGroupId <= 0) {
      return { confirmed: false, warning: "Admin run process group id is unavailable" };
    }
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    try {
      process.kill(-processGroupId, "SIGTERM");
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ESRCH") {
        return {
          confirmed: false,
          warning: `Admin process-group termination failed (${
            error instanceof Error ? error.message : String(error)
          })`,
        };
      }
    }
    const gracefulDeadline = Date.now() + 2_000;
    while (Date.now() < gracefulDeadline) {
      try {
        process.kill(-processGroupId, 0);
        Atomics.wait(sleeper, 0, 0, 20);
      } catch (error: unknown) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code === "ESRCH") return { confirmed: true };
        return {
          confirmed: false,
          warning: `Admin process-group status is unconfirmed (${
            error instanceof Error ? error.message : String(error)
          })`,
        };
      }
    }
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The active-zero poll below remains authoritative.
    }
    const forcedDeadline = Date.now() + 5_000;
    while (Date.now() < forcedDeadline) {
      try {
        process.kill(-processGroupId, 0);
        Atomics.wait(sleeper, 0, 0, 20);
      } catch (error: unknown) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code === "ESRCH") return { confirmed: true };
        break;
      }
    }
    return {
      confirmed: false,
      warning: "Admin process group remains live after SIGKILL",
    };
  }

  private buildOvernightArgs(
    options: StartOvernightAdminRunOptions,
    checkpointPath: string,
  ): string[] {
    const args = [
      this.quackBin,
      "overnight",
      "--project",
      options.projectRoot,
      "--monitor-url",
      options.monitorUrl,
      "--checkpoint",
      checkpointPath,
    ];
    if (options.taskIds && options.taskIds.length > 0) {
      args.push("--task-ids", options.taskIds.join(","));
    }
    if (options.sourceBranch) args.push("--source-branch", options.sourceBranch);
    if (options.targetBranch) args.push("--target-branch", options.targetBranch);
    if (options.allowParseErrors) args.push("--allow-parse-errors");
    if (options.once) args.push("--once");
    if (options.maxDispatches !== undefined)
      args.push("--max-dispatches", String(options.maxDispatches));
    if (options.maxCycles !== undefined) args.push("--max-cycles", String(options.maxCycles));
    if (options.maxSubtasks !== undefined) args.push("--max-subtasks", String(options.maxSubtasks));
    if (options.autoEnrich) args.push("--auto-enrich");
    if (options.autoDecompose === false) args.push("--no-auto-decompose");
    if (options.verifyAfterDispatch === false) args.push("--no-verify-after-dispatch");
    if (options.dryRun) args.push("--dry-run");
    if (options.federationDispatch) args.push("--federation-dispatch");
    if (options.preferredHostId) args.push("--preferred-host-id", options.preferredHostId);
    if (options.allowLowPreflightOnFederationDispatch)
      args.push("--allow-low-preflight-on-federation-dispatch");
    if (options.autoAcknowledgeDecomposeReview) args.push("--auto-acknowledge-decompose-review");
    return args;
  }

  private recordOutput(record: AdminRunRecord, stream: "stdout" | "stderr", chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return;
    const target = stream === "stdout" ? record.stdoutTail : record.stderrTail;
    target.push(...lines);
    target.splice(0, Math.max(0, target.length - MAX_TAIL_LINES));
    const previousStage = record.stage;
    for (const line of lines) {
      record.stage = classifyAdminRunStageLine(line, record.stage);
    }
    this.touch(record);
    if (record.stage !== previousStage) {
      record.stageStartedAt = record.updatedAt;
    }
    record.lastOutputAt = record.updatedAt;
    this.persistRunBestEffort(record);
  }

  private touch(record: AdminRunRecord): void {
    const now = new Date().toISOString();
    record.updatedAt = now;
    record.lastHeartbeatAt = now;
  }

  private startHeartbeat(record: AdminRunRecord): void {
    record.heartbeatTimer = setInterval(() => {
      if (record.status !== "running") {
        this.clearHeartbeat(record);
        return;
      }
      this.touch(record);
      this.persistRunBestEffort(record);
    }, this.heartbeatIntervalMs);
    record.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(record: AdminRunRecord): void {
    if (!record.heartbeatTimer) return;
    clearInterval(record.heartbeatTimer);
    record.heartbeatTimer = undefined;
  }

  private applyCheckpointTiming(
    snapshot: AdminRunSnapshot,
    checkpoint: AdminRunCheckpointSummary,
  ): void {
    if (checkpoint.updatedAt) {
      snapshot.lastHeartbeatAt = maxTimestamp(snapshot.lastHeartbeatAt, checkpoint.updatedAt);
    }
    if (!checkpoint.currentStage) {
      snapshot.watchdog = this.buildWatchdog(snapshot, Date.now());
      return;
    }

    snapshot.stage = checkpoint.currentStage.stage;
    snapshot.stageStartedAt = checkpoint.currentStage.startedAt;
    snapshot.lastHeartbeatAt = maxTimestamp(
      snapshot.lastHeartbeatAt,
      checkpoint.currentStage.lastHeartbeatAt,
    );
    if (checkpoint.currentStage.lastOutputAt) {
      snapshot.lastOutputAt = snapshot.lastOutputAt
        ? maxTimestamp(snapshot.lastOutputAt, checkpoint.currentStage.lastOutputAt)
        : checkpoint.currentStage.lastOutputAt;
    }
    snapshot.watchdog = this.buildWatchdog(snapshot, Date.now(), checkpoint.currentStage);
  }

  private toSnapshot(record: AdminRunRecord): AdminRunSnapshot {
    const end = record.completedAt ? Date.parse(record.completedAt) : Date.now();
    return {
      runId: record.runId,
      action: record.action,
      projectId: record.projectId,
      projectRoot: record.projectRoot,
      status: record.status,
      stage: record.stage,
      pid: record.pid,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      stageStartedAt: record.stageStartedAt,
      completedAt: record.completedAt,
      durationMs: Math.max(0, end - Date.parse(record.startedAt)),
      lastHeartbeatAt: record.lastHeartbeatAt,
      lastOutputAt: record.lastOutputAt,
      command: record.command,
      checkpointPath: record.checkpointPath,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      stdoutTail: record.stdoutTail.slice(-MAX_TAIL_LINES),
      stderrTail: record.stderrTail.slice(-MAX_TAIL_LINES),
      watchdog: this.buildWatchdog(record, end),
    };
  }

  private buildWatchdog(
    state: AdminRunTimingState,
    nowMs: number,
    checkpointStage?: AdminRunStageProgress,
  ): AdminRunWatchdog {
    const heartbeatAgeMs = Math.max(0, nowMs - Date.parse(state.lastHeartbeatAt));
    const outputIdleMs = Math.max(0, nowMs - Date.parse(state.lastOutputAt ?? state.startedAt));
    const stageAgeMs = Math.max(0, nowMs - Date.parse(state.stageStartedAt));
    const stagePolicy = getAdminRunStagePolicy(state.stage);
    const outputStaleAfterMs = checkpointStage?.staleAfterMs ?? stagePolicy.outputStaleAfterMs;
    const stageRecommendedAction =
      checkpointStage?.recommendedAction ?? stagePolicy.recommendedAction;
    if (TERMINAL_STATUSES.includes(state.status)) {
      return {
        status: "terminal",
        reason: `run is ${state.status}`,
        recommendedAction: "Review final status, output tail, and checkpoint summary.",
        stage: state.stage,
        stageAgeMs,
        heartbeatAgeMs,
        outputIdleMs,
        outputStaleAfterMs,
      };
    }
    if (heartbeatAgeMs > this.heartbeatIntervalMs * 3) {
      return {
        status: "stalled",
        reason: `admin heartbeat is stale for ${heartbeatAgeMs}ms`,
        recommendedAction:
          "Check the monitor process and the admin run child process before starting another run.",
        stage: state.stage,
        stageAgeMs,
        heartbeatAgeMs,
        outputIdleMs,
        outputStaleAfterMs,
      };
    }
    if (outputStaleAfterMs > 0 && outputIdleMs > outputStaleAfterMs) {
      return {
        status: "stale_output",
        reason: `${state.stage} has not emitted output for ${outputIdleMs}ms`,
        recommendedAction: stageRecommendedAction,
        stage: state.stage,
        stageAgeMs,
        heartbeatAgeMs,
        outputIdleMs,
        outputStaleAfterMs,
      };
    }
    return {
      status: "healthy",
      reason: "admin heartbeat is current",
      recommendedAction: stageRecommendedAction,
      stage: state.stage,
      stageAgeMs,
      heartbeatAgeMs,
      outputIdleMs,
      outputStaleAfterMs,
    };
  }

  private async persistRun(record: AdminRunRecord): Promise<void> {
    if (!record.checkpointPath) return;
    const runPath = path.join(path.dirname(record.checkpointPath), `${record.runId}.json`);
    await fs.mkdir(path.dirname(runPath), { recursive: true });
    await fs.writeFile(runPath, JSON.stringify(this.toSnapshot(record), null, 2) + "\n", "utf-8");
  }

  private persistRunBestEffort(record: AdminRunRecord): void {
    void this.persistRun(record).catch(() => {
      // Admin run persistence is diagnostic; failed writes must not crash the monitor.
    });
  }
}

export function classifyAdminRunStageLine(line: string, current: AdminRunStage): AdminRunStage {
  const text = line.toLowerCase();
  if (text.includes("halted:")) return "halted";
  if (text.includes("overnight runner summary")) return "summarizing";
  if (text.includes("[overnight] gate")) return "gate";
  if (text.includes("[overnight] spec review")) return "spec_review";
  if (text.includes("[overnight] blueprint")) return "blueprint";
  if (text.includes("[overnight] analysis")) return "analysis";
  if (text.includes("[overnight] prep")) return "prep";
  if (text.includes("[overnight] enrich")) return "enrich";
  if (text.includes("[overnight] decompose")) return "decompose";
  if (text.includes("[overnight] dispatch")) return "dispatch";
  if (text.includes("[overnight] waiting")) return "waiting";
  if (text.includes("verify")) return "verify";
  if (text.includes("loaded") && text.includes("overnight queue")) return "inventory";
  return current;
}

async function readCheckpointSummary(filePath: string): Promise<AdminRunCheckpointSummary> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: string;
      halted?: boolean;
      haltReason?: string;
      tasks?: Array<{
        taskId: string;
        status: string;
        lastError?: string;
        sessionId?: string;
        subtaskIds?: string[];
      }>;
      events?: Array<{
        timestamp: string;
        type: string;
        taskId?: string;
        message: string;
      }>;
      currentStage?: {
        stage?: string;
        status?: string;
        startedAt?: string;
        lastHeartbeatAt?: string;
        lastOutputAt?: string;
        staleAfterMs?: number;
        recommendedAction?: string;
        taskId?: string;
        detail?: string;
        error?: string;
      };
    };
    const rawStage = parsed.currentStage;
    const stage = rawStage?.stage;
    const currentStageStatus: AdminRunStageProgress["status"] | undefined =
      typeof rawStage?.status === "string"
        ? rawStage.status === "failed"
          ? "failed"
          : rawStage.status === "completed"
            ? "completed"
            : "running"
        : undefined;
    const currentStage =
      stage &&
      isAdminRunStage(stage) &&
      currentStageStatus &&
      typeof rawStage?.startedAt === "string" &&
      typeof rawStage.lastHeartbeatAt === "string"
        ? {
            stage,
            status: currentStageStatus,
            startedAt: rawStage.startedAt,
            lastHeartbeatAt: rawStage.lastHeartbeatAt,
            lastOutputAt: rawStage.lastOutputAt,
            staleAfterMs:
              typeof rawStage.staleAfterMs === "number"
                ? rawStage.staleAfterMs
                : getAdminRunStagePolicy(stage).outputStaleAfterMs,
            recommendedAction:
              typeof rawStage.recommendedAction === "string"
                ? rawStage.recommendedAction
                : getAdminRunStagePolicy(stage).recommendedAction,
            taskId: rawStage.taskId,
            detail: rawStage.detail,
            error: rawStage.error,
          }
        : undefined;
    return {
      path: filePath,
      exists: true,
      updatedAt: parsed.updatedAt,
      halted: parsed.halted,
      haltReason: parsed.haltReason,
      tasks: parsed.tasks?.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastError: task.lastError,
        sessionId: task.sessionId,
        subtaskIds: task.subtaskIds,
      })),
      events: parsed.events?.slice(-20),
      currentStage,
    };
  } catch {
    return {
      path: filePath,
      exists: false,
    };
  }
}

function maxTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function createRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${suffix}`;
}
