// ─── Docker Manager ────────────────────────────────────────────────
// Manages Docker container lifecycle for task isolation.
// Uses child_process.execFile to call Docker CLI — no Docker SDK dependency.
// Provides the same spawn interface as the worktree path so the
// dispatch manager can branch between isolation methods transparently.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DockerIsolationConfig } from "../core/types.js";
import { resolvePrepStorageDirSync } from "../core/prep-storage.js";

const execFileAsync = promisify(execFile);

export interface DockerContainer {
  containerId: string;
  taskId: string;
  image: string;
  workDir: string;
  logsVolume: string;
  startedAt: string;
  status: "creating" | "running" | "stopped" | "removed";
  exitCode?: number;
}

export class DockerManager {
  private containers = new Map<string, DockerContainer>();

  constructor(
    private readonly projectRoot: string,
    private readonly config: DockerIsolationConfig,
  ) {}

  /**
   * Check that Docker is available and return the server version.
   * Throws if Docker is not installed or the daemon is not running.
   */
  async checkDocker(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
      return stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Docker is not available: ${msg}`);
    }
  }

  /**
   * Create and start a container for a task dispatch.
   * Mounts project root as read-only, .quack/logs as read-write,
   * and .quack/prep as read-only. Passes through configured env vars.
   */
  async createContainer(taskId: string): Promise<DockerContainer> {
    // Prevent double-create
    const existing = this.containers.get(taskId);
    if (existing && (existing.status === "creating" || existing.status === "running")) {
      throw new Error(`Container already exists for ${taskId} (${existing.containerId})`);
    }

    const info: DockerContainer = {
      containerId: "",
      taskId,
      image: this.config.image,
      workDir: "/workspace",
      logsVolume: "/workspace/.quack/logs",
      startedAt: new Date().toISOString(),
      status: "creating",
    };
    this.containers.set(taskId, info);

    try {
      const createArgs = this.buildCreateArgs(taskId);
      const { stdout } = await execFileAsync("docker", createArgs);
      const containerId = stdout.trim();
      info.containerId = containerId;

      // Start the container
      await execFileAsync("docker", ["start", containerId]);
      info.status = "running";

      // Run pre-install command if configured
      if (this.config.preInstallCommand) {
        await execFileAsync("docker", [
          "exec",
          containerId,
          "sh",
          "-c",
          this.config.preInstallCommand,
        ]);
      }

      return info;
    } catch (err) {
      info.status = "stopped";
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create container for ${taskId}: ${msg}`);
    }
  }

  /**
   * Execute a command inside the container. Returns the ChildProcess
   * for stdout/stderr streaming (same interface as worktree spawn).
   */
  execAgent(containerId: string, command: string[], env?: Record<string, string>): ChildProcess {
    const args = ["exec"];

    // Pass environment variables
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Pass through configured env vars from host
    for (const envVar of this.config.envPassthrough) {
      const value = process.env[envVar];
      if (value !== undefined) {
        args.push("-e", `${envVar}=${value}`);
      }
    }

    args.push(containerId, ...command);

    return spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /**
   * Stop a running container. Sends SIGTERM with a 10s grace period,
   * then removes based on cleanup policy.
   */
  async stopContainer(containerId: string, failed = false): Promise<void> {
    try {
      await execFileAsync("docker", ["stop", "-t", "10", containerId]);
    } catch {
      // Container may already be stopped
    }

    // Update tracking
    for (const info of this.containers.values()) {
      if (info.containerId === containerId) {
        info.status = "stopped";
        break;
      }
    }

    // Apply cleanup policy
    const shouldRemove =
      this.config.cleanupPolicy === "remove" ||
      (this.config.cleanupPolicy === "keep_on_failure" && !failed);

    if (shouldRemove) {
      await this.removeContainer(containerId);
    }
  }

  /**
   * Force-remove a container.
   */
  async removeContainer(containerId: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
    } catch {
      // Container may already be removed
    }

    // Update tracking
    for (const [taskId, info] of this.containers) {
      if (info.containerId === containerId) {
        info.status = "removed";
        this.containers.delete(taskId);
        break;
      }
    }
  }

  /**
   * Extract git results from a container (diff + recent log + current branch).
   */
  async extractResults(
    containerId: string,
  ): Promise<{ diff: string; log: string; branch: string }> {
    const [diffResult, logResult, branchResult] = await Promise.all([
      execFileAsync("docker", ["exec", containerId, "git", "diff", "HEAD"]).catch(() => ({
        stdout: "",
      })),
      execFileAsync("docker", ["exec", containerId, "git", "log", "--oneline", "-10"]).catch(
        () => ({ stdout: "" }),
      ),
      execFileAsync("docker", [
        "exec",
        containerId,
        "git",
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]).catch(() => ({ stdout: "" })),
    ]);

    return {
      diff: diffResult.stdout,
      log: logResult.stdout,
      branch: branchResult.stdout.trim(),
    };
  }

  /**
   * Get container logs (stdout/stderr) from Docker.
   */
  async getLogs(containerId: string, tail?: number): Promise<string> {
    try {
      const args = ["logs", containerId];
      if (tail !== undefined) {
        args.push("--tail", String(tail));
      }
      const { stdout } = await execFileAsync("docker", args);
      return stdout;
    } catch {
      return "";
    }
  }

  /**
   * Get all tracked containers.
   */
  getActiveContainers(): DockerContainer[] {
    return Array.from(this.containers.values()).filter(
      (c) => c.status === "creating" || c.status === "running",
    );
  }

  /**
   * Get container info by task ID.
   */
  getContainer(taskId: string): DockerContainer | undefined {
    return this.containers.get(taskId);
  }

  /**
   * Stop and remove all tracked containers (for kill switch / shutdown).
   */
  async cleanupAll(): Promise<void> {
    const active = this.getActiveContainers();
    await Promise.all(
      active.map(async (c) => {
        try {
          await execFileAsync("docker", ["stop", "-t", "5", c.containerId]);
        } catch {
          // ignore
        }
        try {
          await execFileAsync("docker", ["rm", "-f", c.containerId]);
        } catch {
          // ignore
        }
      }),
    );
    this.containers.clear();
  }

  /**
   * Build the `docker create` argument list.
   */
  private buildCreateArgs(taskId: string): string[] {
    const args = ["create"];

    // Container name for easy identification
    args.push("--name", `quack-${taskId}-${Date.now()}`);

    // Resource limits
    args.push("--memory", `${this.config.resourceLimits.memoryMb}m`);
    args.push("--cpus", String(this.config.resourceLimits.cpus));
    if (this.config.resourceLimits.storageMb) {
      args.push("--storage-opt", `size=${this.config.resourceLimits.storageMb}M`);
    }

    // Network mode
    args.push("--network", this.config.networkMode);

    // Volume mounts
    // Project root → /workspace (read-only)
    const normalizedRoot = this.projectRoot.replace(/\\/g, "/");
    args.push("-v", `${normalizedRoot}:/workspace:ro`);

    // .quack/logs → read-write (JSONL events stream to host)
    const logsDir = path.join(this.projectRoot, ".quack", "logs").replace(/\\/g, "/");
    args.push("-v", `${logsDir}:/workspace/.quack/logs:rw`);

    // .quack/prep → read-only
    const prepDir = resolvePrepStorageDirSync(this.projectRoot).replace(/\\/g, "/");
    args.push("-v", `${prepDir}:/workspace/.quack/prep:ro`);

    // Additional configured volumes
    for (const vol of this.config.volumes) {
      args.push("-v", vol);
    }

    // Environment variables — passed via --env args (no shell expansion)
    for (const envVar of this.config.envPassthrough) {
      const value = process.env[envVar];
      if (value !== undefined) {
        args.push("--env", `${envVar}=${value}`);
      }
    }

    // Working directory inside container
    args.push("-w", "/workspace");

    // Label for identification
    args.push("--label", `quack.taskId=${taskId}`);

    // Image
    args.push(this.config.image);

    // Keep container running (sleep) so we can docker exec into it
    args.push("sleep", "infinity");

    return args;
  }
}
