import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeClaudeDiagnostic } from "../sdk/claude-auth.js";
import type { DispatchJob } from "./dispatch-manager.js";

export interface DispatchObservationIdentity {
  projectId: string;
  taskId: string;
  jobId: string;
  hostId: string;
  leaseId: string;
  sessionId: string;
}

export interface DispatchTerminalObservation {
  version: 1;
  identity: DispatchObservationIdentity;
  job: Pick<
    DispatchJob,
    | "taskId"
    | "sessionId"
    | "pid"
    | "startedAt"
    | "status"
    | "exitCode"
    | "output"
    | "killedBySignal"
    | "branchName"
    | "commitSha"
    | "worktreePath"
    | "specStale"
  > & {
    completedAt: string;
    replacementSessionId?: string;
  };
}

const MAX_OBSERVATION_BYTES = 1024 * 1024;
const IDENTITY_FIELDS = ["projectId", "taskId", "jobId", "hostId", "leaseId", "sessionId"] as const;

function validIdentity(value: unknown): value is DispatchObservationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return IDENTITY_FIELDS.every(
    (key) =>
      typeof record[key] === "string" &&
      record[key].length > 0 &&
      record[key].length <= 512 &&
      record[key].trim() === record[key],
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= maxLength)
  );
}

function validTerminalJob(
  value: unknown,
  identity: DispatchObservationIdentity,
): value is DispatchTerminalObservation["job"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const stale = job.specStale as Record<string, unknown> | undefined;
  return (
    job.taskId === identity.taskId &&
    job.sessionId === identity.sessionId &&
    typeof job.status === "string" &&
    ["completed", "failed", "stopped"].includes(job.status) &&
    typeof job.pid === "number" &&
    Number.isInteger(job.pid) &&
    job.pid >= 0 &&
    validTimestamp(job.startedAt) &&
    validTimestamp(job.completedAt) &&
    Date.parse(job.completedAt) >= Date.parse(job.startedAt) &&
    (job.exitCode === undefined ||
      (typeof job.exitCode === "number" && Number.isInteger(job.exitCode))) &&
    (job.status !== "completed" || (job.exitCode === 0 && job.killedBySignal === undefined)) &&
    optionalString(job.killedBySignal, 64) &&
    optionalString(job.branchName, 1024) &&
    optionalString(job.commitSha, 128) &&
    optionalString(job.worktreePath, 4096) &&
    (stale === undefined ||
      (stale !== null &&
        typeof stale === "object" &&
        !Array.isArray(stale) &&
        typeof stale.verdict === "string" &&
        stale.verdict.length > 0 &&
        stale.verdict.length <= 128 &&
        typeof stale.reason === "string" &&
        stale.reason.length <= 2048 &&
        validTimestamp(stale.refusedAt))) &&
    Array.isArray(job.output) &&
    job.output.length <= 200 &&
    job.output.every((line) => typeof line === "string" && line.length <= 2048) &&
    job.output.join("").length <= 32 * 1024 &&
    optionalString(job.replacementSessionId, 512) &&
    job.replacementSessionId !== identity.sessionId
  );
}

export function sameDispatchObservationIdentity(
  left: DispatchObservationIdentity,
  right: DispatchObservationIdentity,
): boolean {
  return IDENTITY_FIELDS.every((key) => left[key] === right[key]);
}

export function dispatchObservationIdentity(
  projectId: string,
  job: DispatchJob,
): DispatchObservationIdentity | undefined {
  const identity = {
    projectId,
    taskId: job.taskId,
    sessionId: job.sessionId,
    jobId: job.federatedJobId,
    hostId: job.federatedHostId,
    leaseId: job.federatedLeaseId,
  };
  return validIdentity(identity) ? identity : undefined;
}

function boundedOutput(lines: readonly string[]): string[] {
  let remaining = 32 * 1024;
  const output: string[] = [];
  for (const line of lines.slice(-200).reverse()) {
    if (remaining <= 0) break;
    const sanitized = sanitizeClaudeDiagnostic(line).slice(-Math.min(2048, remaining));
    output.push(sanitized);
    remaining -= sanitized.length;
  }
  return output.reverse();
}

/** Host observations, never a source for restoring process ownership or dispatch permission. */
export class DispatchObservationStore {
  private readonly directory: string;

  constructor(
    projectRoot: string,
    private readonly projectId: string,
  ) {
    // This host-owned directory is not the worker's shared runtime log archive.
    this.directory = path.join(projectRoot, ".quack", "dispatch-observations");
  }

  private filename(identity: DispatchObservationIdentity): string {
    if (!validIdentity(identity) || identity.projectId !== this.projectId)
      throw new Error("Invalid dispatch observation identity");
    const digest = createHash("sha256")
      .update(JSON.stringify(IDENTITY_FIELDS.map((key) => identity[key])))
      .digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  write(
    identity: DispatchObservationIdentity,
    job: DispatchJob,
    completedAt: string,
    replacementSessionId?: string,
  ): void {
    const actual = dispatchObservationIdentity(this.projectId, job);
    if (
      !actual ||
      !sameDispatchObservationIdentity(actual, identity) ||
      !["completed", "failed", "stopped"].includes(job.status) ||
      job.operatorStopCleanupPending === true
    ) {
      throw new Error("Dispatch observation is not a settled exact attempt");
    }
    if (
      !validTimestamp(completedAt) ||
      !validTimestamp(job.startedAt) ||
      Date.parse(completedAt) < Date.parse(job.startedAt)
    )
      throw new Error("Invalid dispatch completion time");
    const observation: DispatchTerminalObservation = {
      version: 1,
      identity: { ...identity },
      job: {
        taskId: job.taskId,
        sessionId: job.sessionId,
        pid: job.pid,
        startedAt: job.startedAt,
        completedAt,
        status: job.status,
        exitCode: job.exitCode,
        killedBySignal: job.killedBySignal,
        branchName: job.branchName,
        commitSha: job.commitSha,
        worktreePath: job.worktreePath,
        specStale: job.specStale
          ? {
              ...job.specStale,
              reason: sanitizeClaudeDiagnostic(job.specStale.reason).slice(0, 2048),
            }
          : undefined,
        output: boundedOutput(job.output),
        replacementSessionId,
      },
    };
    if (!validTerminalJob(observation.job, identity))
      throw new Error("Invalid terminal dispatch observation");
    const content = JSON.stringify(observation, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_OBSERVATION_BYTES)
      throw new Error("Dispatch observation exceeds its size limit");
    const filename = this.filename(identity);
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.lstatSync(this.directory).isDirectory())
      throw new Error("Dispatch observation directory is not a regular directory");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  read(identity: DispatchObservationIdentity): DispatchTerminalObservation | undefined {
    const filename = this.filename(identity);
    let content: string;
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_OBSERVATION_BYTES)
        throw new Error("Unbounded or non-regular dispatch observation");
      content = fs.readFileSync(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      if (Buffer.byteLength(content, "utf8") > MAX_OBSERVATION_BYTES)
        throw new Error("Unbounded observation");
      const value = JSON.parse(content) as DispatchTerminalObservation;
      const job = value?.job;
      if (
        value?.version !== 1 ||
        !validIdentity(value.identity) ||
        !sameDispatchObservationIdentity(value.identity, identity) ||
        !validTerminalJob(job, identity)
      ) {
        throw new Error("Invalid dispatch observation");
      }
      return {
        version: 1,
        identity: { ...identity },
        job: {
          taskId: job.taskId,
          sessionId: job.sessionId,
          pid: job.pid,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          status: job.status,
          exitCode: job.exitCode,
          killedBySignal: job.killedBySignal,
          branchName: job.branchName,
          commitSha: job.commitSha,
          worktreePath: job.worktreePath,
          output: [...job.output],
          replacementSessionId: job.replacementSessionId,
          specStale: job.specStale
            ? {
                verdict: job.specStale.verdict,
                reason: job.specStale.reason,
                refusedAt: job.specStale.refusedAt,
              }
            : undefined,
        },
      };
    } catch {
      throw new Error(
        "Stored dispatch observation is malformed; this exact attempt cannot be reported reliably",
      );
    }
  }
}
