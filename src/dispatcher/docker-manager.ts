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
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 5_000;
const DOCKER_SETUP_TIMEOUT_MS = 15 * 60_000;
const UNCERTAIN_CREATE_CONFIRMATION_DELAY_MS = 1_000;

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

export interface DockerCleanupResult {
  removedTaskIds: string[];
  failedTaskIds: string[];
}

export class DockerManager {
  private containers = new Map<string, DockerContainer>();
  private pendingCommands = new Set<AbortController>();
  /** Earliest time an absent container name is conclusive after an aborted create. */
  private uncertainCreations = new Map<string, number>();

  constructor(
    private readonly projectRoot: string,
    private readonly config: DockerIsolationConfig,
  ) {}

  private async runDocker(
    args: string[],
    timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    const controller = new AbortController();
    this.pendingCommands.add(controller);
    try {
      const result = await execFileAsync("docker", args, {
        encoding: "utf-8",
        timeout: Math.max(1, timeoutMs),
        windowsHide: true,
        signal: controller.signal,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } finally {
      this.pendingCommands.delete(controller);
    }
  }

  /** Cancel Docker CLI calls so bounded shutdown does not leave helper processes behind. */
  abortPendingCommands(): void {
    for (const controller of this.pendingCommands) controller.abort();
  }

  /**
   * Check that Docker is available and return the server version.
   * Throws if Docker is not installed or the daemon is not running.
   */
  async checkDocker(): Promise<string> {
    try {
      const { stdout } = await this.runDocker(["info", "--format", "{{.ServerVersion}}"]);
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
    if (existing && existing.status !== "removed") {
      throw new Error(
        `Container cleanup is unresolved for ${taskId} (${existing.containerId}, ${existing.status})`,
      );
    }

    const containerName = `quack-${taskId}-${Date.now()}`;
    const info: DockerContainer = {
      // Docker commands accept the unique name as well as the eventual ID,
      // which lets shutdown clean up even if `docker create` is interrupted
      // before stdout returns the ID.
      containerId: containerName,
      taskId,
      image: this.config.image,
      workDir: "/workspace",
      logsVolume: "/workspace/.quack/logs",
      startedAt: new Date().toISOString(),
      status: "creating",
    };
    this.containers.set(taskId, info);

    try {
      const createArgs = this.buildCreateArgs(taskId, containerName);
      const { stdout } = await this.runDocker(createArgs);
      const containerId = stdout.trim() || containerName;
      info.containerId = containerId;

      // Start the container
      await this.runDocker(["start", containerId]);
      info.status = "running";

      // Run pre-install command if configured
      if (this.config.preInstallCommand) {
        await this.runDocker(
          ["exec", containerId, "sh", "-c", this.config.preInstallCommand],
          DOCKER_SETUP_TIMEOUT_MS,
        );
      }

      return info;
    } catch (err) {
      info.status = "stopped";
      const errorCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      const errorName = err instanceof Error ? err.name : "";
      const commandKilled =
        typeof err === "object" && err !== null && "killed" in err
          ? (err as { killed?: unknown }).killed === true
          : false;
      if (
        info.containerId === containerName &&
        (errorName === "AbortError" ||
          errorCode === "ABORT_ERR" ||
          errorCode === "ETIMEDOUT" ||
          commandKilled)
      ) {
        // The Docker CLI can be aborted after the daemon accepted `create` but
        // before stdout returned its ID. An immediate "no such container"
        // probe is not proof of absence while that request may still land.
        this.uncertainCreations.set(
          info.containerId,
          Date.now() + UNCERTAIN_CREATE_CONFIRMATION_DELAY_MS,
        );
      }
      await this.forceRemoveContainer(info.containerId);
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
      await this.runDocker(["stop", "-t", "10", containerId], DOCKER_CLEANUP_TIMEOUT_MS);
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
    await this.forceRemoveContainer(containerId);
  }

  /**
   * Force-remove a container and retain its tracking record when Docker cannot
   * confirm removal. Shutdown paths use the boolean result as lifecycle
   * evidence instead of treating a swallowed CLI error as success.
   */
  async forceRemoveContainer(containerId: string): Promise<boolean> {
    let removalCommandSucceeded = false;
    try {
      await this.runDocker(["rm", "-f", containerId], DOCKER_CLEANUP_TIMEOUT_MS);
      removalCommandSucceeded = true;
    } catch (error: unknown) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      const errorName = error instanceof Error ? error.name : "";
      if (errorName === "AbortError" || errorCode === "ABORT_ERR" || errorCode === "ETIMEDOUT") {
        return false;
      }
      const detail =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr)
          : error instanceof Error
            ? error.message
            : String(error);
      if (!/no such (?:object|container)/i.test(detail)) {
        try {
          await this.runDocker(
            ["inspect", "--type", "container", containerId],
            DOCKER_CLEANUP_TIMEOUT_MS,
          );
          return false;
        } catch (inspectError: unknown) {
          const inspectDetail =
            typeof inspectError === "object" && inspectError !== null && "stderr" in inspectError
              ? String((inspectError as { stderr?: unknown }).stderr)
              : inspectError instanceof Error
                ? inspectError.message
                : String(inspectError);
          if (!/no such (?:object|container)/i.test(inspectDetail)) return false;
        }
      }
    }

    const uncertainUntil = this.uncertainCreations.get(containerId);
    if (!removalCommandSucceeded && uncertainUntil !== undefined && Date.now() < uncertainUntil) {
      return false;
    }

    // Update tracking
    for (const [taskId, info] of this.containers) {
      if (info.containerId === containerId) {
        info.status = "removed";
        this.containers.delete(taskId);
        this.uncertainCreations.delete(containerId);
        break;
      }
    }
    return true;
  }

  /**
   * Extract git results from a container (diff + recent log + current branch).
   */
  async extractResults(
    containerId: string,
  ): Promise<{ diff: string; log: string; branch: string }> {
    const [diffResult, logResult, branchResult] = await Promise.all([
      this.runDocker(["exec", containerId, "git", "diff", "HEAD"]).catch(() => ({
        stdout: "",
      })),
      this.runDocker(["exec", containerId, "git", "log", "--oneline", "-10"]).catch(() => ({
        stdout: "",
      })),
      this.runDocker(["exec", containerId, "git", "rev-parse", "--abbrev-ref", "HEAD"]).catch(
        () => ({ stdout: "" }),
      ),
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
      const { stdout } = await this.runDocker(args);
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

  /** Containers that still require confirmed removal, including stopped ones. */
  getTrackedContainers(): DockerContainer[] {
    return Array.from(this.containers.values()).filter(
      (container) => container.status !== "removed",
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
  async cleanupAll(): Promise<DockerCleanupResult> {
    const active = this.getTrackedContainers();
    const outcomes = await Promise.all(
      active.map(async (c) => {
        // Shutdown is already in its forced phase. `rm -f` both terminates and
        // removes without spending the entire bound on Docker's stop grace.
        const removed = await this.forceRemoveContainer(c.containerId);
        return { taskId: c.taskId, removed };
      }),
    );
    return {
      removedTaskIds: outcomes.filter((outcome) => outcome.removed).map(({ taskId }) => taskId),
      failedTaskIds: outcomes.filter((outcome) => !outcome.removed).map(({ taskId }) => taskId),
    };
  }

  /**
   * Build the `docker create` argument list.
   */
  private buildCreateArgs(taskId: string, containerName?: string): string[] {
    const args = ["create"];

    // Container name for easy identification
    args.push("--name", containerName ?? `quack-${taskId}-${Date.now()}`);

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
