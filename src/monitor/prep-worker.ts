// ─── Prep Worker ───────────────────────────────────────────────────
// Runs gate checks (schema validation + depth evaluation) in a child
// process. Used by the monitor API to prep tasks on demand without
// blocking the server or hitting the nested session blocker.

import { spawn, type ChildProcess } from "node:child_process";

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

export class PrepWorker {
  private jobs = new Map<string, PrepJob>();
  private processes = new Map<string, ChildProcess>();

  constructor(
    private readonly projectRoot: string,
    private readonly quackBin: string,
  ) {}

  /**
   * Start a prep job for a task. Returns the job info immediately.
   * The prep runs as a child process to avoid nested session blocker.
   */
  start(taskId: string): PrepJob {
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

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("exit", (code) => {
      if (code === 0 && stdout) {
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
      this.processes.delete(taskId);
    });

    child.on("error", (err) => {
      job.status = "failed";
      job.error = err.message;
      this.processes.delete(taskId);
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

    child.kill("SIGTERM");
    const job = this.jobs.get(taskId);
    if (job) job.status = "failed";
    this.processes.delete(taskId);
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

  /**
   * Kill all running prep jobs (for graceful shutdown).
   */
  killAll(): void {
    for (const [taskId, child] of this.processes) {
      child.kill("SIGTERM");
      const job = this.jobs.get(taskId);
      if (job) job.status = "failed";
    }
    this.processes.clear();
  }
}
