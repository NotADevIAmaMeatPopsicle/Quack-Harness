import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePrepGateResult } from "./prep-job-result.js";
import type { PrepJob } from "./prep-worker.js";

// UTF-8 serialization includes both result and diagnostic copies. This single
// total bound applies before any write and again on read, including Unicode.
const MAX_PREP_JOB_BYTES = 1024 * 1024;

/** Diagnostic observations only. This store never writes readiness or prep cache. */
export class PrepJobStore {
  constructor(
    private readonly logDir: string,
    private readonly projectId: string,
  ) {}

  private latestPath(taskId: string): string {
    return path.join(this.logDir, "prep-jobs", `${Buffer.from(taskId).toString("base64url")}.json`);
  }

  write(job: PrepJob): void {
    if (job.status === "running" || !job.completedAt || !job.jobId) {
      throw new Error("Only closed prep attempts may be persisted as terminal observations");
    }
    const content = JSON.stringify(job, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_PREP_JOB_BYTES)
      throw new Error("Prep diagnostic record exceeds its size limit");
    const latest = this.latestPath(job.taskId);
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    // Retain every attempt, then atomically replace the latest observation.
    fs.writeFileSync(
      path.join(
        this.logDir,
        `prep-${Buffer.from(job.taskId).toString("base64url")}-${job.jobId}.log`,
      ),
      content,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(this.logDir, `events-prep-${job.jobId}.jsonl`),
      JSON.stringify({
        sessionId: job.jobId,
        taskId: job.taskId,
        project: this.projectId,
        timestamp: job.completedAt,
        stage: job.status === "completed" ? "prep_job_completed" : "prep_failed",
        payload: job,
      }) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const temporary = `${latest}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, latest);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  read(taskId: string): PrepJob | undefined {
    let content: string;
    try {
      const filename = this.latestPath(taskId);
      if (fs.statSync(filename).size > MAX_PREP_JOB_BYTES)
        throw new Error("Prep diagnostic record exceeds its size limit");
      content = fs.readFileSync(filename, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_PREP_JOB_BYTES)
        throw new Error("Prep diagnostic record exceeds its size limit");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const job = JSON.parse(content) as PrepJob;
      if (
        !job ||
        typeof job !== "object" ||
        job.taskId !== taskId ||
        typeof job.jobId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(job.jobId) ||
        !Number.isInteger(job.pid) ||
        job.pid < 0 ||
        typeof job.startedAt !== "string" ||
        !Number.isFinite(Date.parse(job.startedAt)) ||
        typeof job.completedAt !== "string" ||
        !Number.isFinite(Date.parse(job.completedAt)) ||
        Date.parse(job.completedAt) < Date.parse(job.startedAt) ||
        !["completed", "failed"].includes(job.status) ||
        !(job.exitCode === null || Number.isInteger(job.exitCode)) ||
        !(job.signal === null || typeof job.signal === "string") ||
        (job.error !== undefined && typeof job.error !== "string") ||
        !job.diagnostics ||
        typeof job.diagnostics.stdout !== "string" ||
        typeof job.diagnostics.stderr !== "string" ||
        typeof job.diagnostics.stdoutTruncated !== "boolean" ||
        typeof job.diagnostics.stderrTruncated !== "boolean"
      ) {
        throw new Error("Invalid terminal record");
      }
      if (
        job.diagnostics.stdout.length > 64 * 1024 ||
        job.diagnostics.stderr.length > 64 * 1024 ||
        (job.error?.length ?? 0) > 64 * 1024 ||
        (job.persistenceError !== undefined &&
          (typeof job.persistenceError !== "string" || job.persistenceError.length > 64 * 1024))
      )
        throw new Error("Unbounded terminal diagnostics");
      if (job.status === "completed") {
        if (job.exitCode !== 0 || job.signal !== null || job.error !== undefined)
          throw new Error("Completed prep has contradictory exit evidence");
        job.result = parsePrepGateResult(job.result);
      } else if (job.result !== undefined) throw new Error("Failed prep record contains a result");
      return job;
    } catch {
      throw new Error(
        "Stored prep diagnostic is malformed; the previous attempt cannot be reported reliably",
      );
    }
  }
}
