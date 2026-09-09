// ─── Docker Manager ────────────────────────────────────────────────
// Manages Docker container lifecycle for task isolation.
// Uses child_process.execFile to call Docker CLI — no Docker SDK dependency.
// Provides the same spawn interface as the worktree path so the
// dispatch manager can branch between isolation methods transparently.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
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

export interface DockerReconciliationResult extends DockerCleanupResult {
  discoveredTaskIds: string[];
  ambiguousContainerIds: string[];
}

interface DockerInspectRecord {
  Id?: unknown;
  Config?: { Image?: unknown; Labels?: Record<string, unknown> | null };
  Mounts?: Array<{ Source?: unknown; Destination?: unknown }>;
  State?: { Running?: unknown };
  Created?: unknown;
}

interface DockerCreateUncertainty {
  version: 1;
  containerName: string;
  taskId: string;
  projectFingerprint: string;
  createdAt: string;
  confirmAfter: string;
  confirmationToken: string;
}

export class DockerManager {
  private containers = new Map<string, DockerContainer>();
  private pendingCommands = new Set<AbortController>();
  /** Durable create requests whose daemon outcome has not yet been proven. */
  private uncertainCreations = new Map<string, DockerCreateUncertainty>();
  private unreadableUncertaintyMarkers = new Set<string>();
  private readonly projectFingerprint: string;
  private readonly uncertaintyDir: string;

  constructor(
    private readonly projectRoot: string,
    private readonly config: DockerIsolationConfig,
    stateRoot?: string,
  ) {
    const resolvedRoot = path.resolve(projectRoot).replace(/\\/g, "/");
    this.projectFingerprint = createHash("sha256")
      .update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
      .digest("hex");
    this.uncertaintyDir =
      stateRoot ?? path.join(projectRoot, ".quack", "logs", "docker-create-uncertainty");
    this.refreshCreateUncertainty();
  }

  private uncertaintyPath(containerName: string): string {
    return path.join(this.uncertaintyDir, `${containerName.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private parseCreateUncertainty(markerPath: string): DockerCreateUncertainty | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        typeof (parsed as { containerName?: unknown }).containerName !== "string" ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        (parsed as { projectFingerprint?: unknown }).projectFingerprint !==
          this.projectFingerprint ||
        typeof (parsed as { createdAt?: unknown }).createdAt !== "string" ||
        typeof (parsed as { confirmAfter?: unknown }).confirmAfter !== "string" ||
        !Number.isFinite(Date.parse((parsed as { confirmAfter: string }).confirmAfter)) ||
        typeof (parsed as { confirmationToken?: unknown }).confirmationToken !== "string" ||
        !(parsed as { confirmationToken: string }).confirmationToken
      ) {
        return undefined;
      }
      return parsed as DockerCreateUncertainty;
    } catch {
      return undefined;
    }
  }

  private refreshCreateUncertainty(): void {
    const records = new Map<string, DockerCreateUncertainty>();
    const unreadable = new Set<string>();
    if (fs.existsSync(this.uncertaintyDir)) {
      try {
        for (const entry of fs.readdirSync(this.uncertaintyDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const markerPath = path.join(this.uncertaintyDir, entry.name);
          const marker = this.parseCreateUncertainty(markerPath);
          if (!marker || this.uncertaintyPath(marker.containerName) !== markerPath) {
            unreadable.add(entry.name);
            continue;
          }
          records.set(marker.containerName, marker);
        }
      } catch {
        unreadable.add("unreadable-uncertainty-directory");
      }
    }
    this.uncertainCreations = records;
    this.unreadableUncertaintyMarkers = unreadable;
  }

  private persistCreateUncertainty(containerName: string, taskId: string): DockerCreateUncertainty {
    const marker: DockerCreateUncertainty = {
      version: 1,
      containerName,
      taskId,
      projectFingerprint: this.projectFingerprint,
      createdAt: new Date().toISOString(),
      confirmAfter: new Date(Date.now() + UNCERTAIN_CREATE_CONFIRMATION_DELAY_MS).toISOString(),
      confirmationToken: randomUUID(),
    };
    const markerPath = this.uncertaintyPath(containerName);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    this.uncertainCreations.set(containerName, marker);
    return marker;
  }

  private clearCreateUncertainty(marker: DockerCreateUncertainty): boolean {
    const markerPath = this.uncertaintyPath(marker.containerName);
    const current = this.parseCreateUncertainty(markerPath);
    if (!current || current.confirmationToken !== marker.confirmationToken) return false;
    try {
      fs.rmSync(markerPath);
      this.uncertainCreations.delete(marker.containerName);
      return true;
    } catch {
      return false;
    }
  }

  private async reconcileCreateUncertainty(): Promise<{
    failedTaskIds: string[];
    ambiguousContainerIds: string[];
  }> {
    this.refreshCreateUncertainty();
    const failedTaskIds: string[] = [];
    const ambiguousContainerIds = Array.from(
      this.unreadableUncertaintyMarkers,
      (name) => `uncertainty:${name}`,
    );
    for (const marker of this.uncertainCreations.values()) {
      const delayMs = Math.max(0, Date.parse(marker.confirmAfter) - Date.now());
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      const removed = await this.forceRemoveContainer(marker.containerName);
      if (!removed) failedTaskIds.push(marker.taskId);
    }
    return { failedTaskIds, ambiguousContainerIds };
  }

  private hostPathMatchesProjectRoot(source: string): boolean {
    const normalize = (value: string): string => {
      const normalized = value
        .replace(/\\/g, "/")
        .replace(/^\/host_mnt\/([a-z])\//i, "$1:/")
        .replace(/\/$/, "");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return normalize(source) === normalize(path.resolve(this.projectRoot));
  }

  /**
   * Discover Quack containers that survived a monitor process and remove this
   * project's containers before new admission. Legacy containers without a
   * project fingerprint are accepted only when their /workspace mount proves
   * ownership; ambiguous records fail closed and are never removed.
   */
  async reconcileExistingContainers(): Promise<DockerReconciliationResult> {
    const uncertainty = await this.reconcileCreateUncertainty();
    if (uncertainty.failedTaskIds.length > 0 || uncertainty.ambiguousContainerIds.length > 0) {
      return {
        discoveredTaskIds: [],
        removedTaskIds: [],
        failedTaskIds: uncertainty.failedTaskIds,
        ambiguousContainerIds: uncertainty.ambiguousContainerIds,
      };
    }
    const { stdout } = await this.runDocker([
      "ps",
      "-a",
      "--filter",
      "label=quack.taskId",
      "--format",
      "{{.ID}}",
    ]);
    const containerIds = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const discoveredTaskIds: string[] = [];
    const ambiguousContainerIds: string[] = [];

    for (const containerId of containerIds) {
      let record: DockerInspectRecord;
      try {
        const inspected = await this.runDocker(["inspect", "--type", "container", containerId]);
        const parsed = JSON.parse(inspected.stdout) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("invalid inspect data");
        record = parsed[0] as DockerInspectRecord;
      } catch {
        ambiguousContainerIds.push(containerId);
        continue;
      }

      const labels = record.Config?.Labels;
      const taskId = labels?.["quack.taskId"];
      const owner = labels?.["quack.projectFingerprint"];
      if (typeof taskId !== "string" || !taskId) {
        ambiguousContainerIds.push(containerId);
        continue;
      }
      if (owner !== undefined && typeof owner !== "string") {
        ambiguousContainerIds.push(containerId);
        continue;
      }
      if (typeof owner === "string" && owner !== this.projectFingerprint) continue;
      if (
        owner === undefined &&
        !record.Mounts?.some(
          (mount) =>
            mount.Destination === "/workspace" &&
            typeof mount.Source === "string" &&
            this.hostPathMatchesProjectRoot(mount.Source),
        )
      ) {
        ambiguousContainerIds.push(containerId);
        continue;
      }

      const info: DockerContainer = {
        containerId:
          typeof record.Id === "string" && record.Id.length > 0 ? record.Id : containerId,
        taskId,
        image: typeof record.Config?.Image === "string" ? record.Config.Image : this.config.image,
        workDir: "/workspace",
        logsVolume: "/workspace/.quack/logs",
        startedAt: typeof record.Created === "string" ? record.Created : new Date().toISOString(),
        status: record.State?.Running === true ? "running" : "stopped",
      };
      if (this.containers.has(taskId)) {
        ambiguousContainerIds.push(containerId);
        continue;
      }
      this.containers.set(taskId, info);
      discoveredTaskIds.push(taskId);
    }

    if (ambiguousContainerIds.length > 0) {
      return {
        discoveredTaskIds,
        ambiguousContainerIds,
        removedTaskIds: [],
        failedTaskIds: discoveredTaskIds,
      };
    }
    const cleanup = await this.cleanupAll();
    return { discoveredTaskIds, ambiguousContainerIds, ...cleanup };
  }

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
    let uncertainty: DockerCreateUncertainty;
    try {
      // Persist intent before Docker can accept the create. If the monitor is
      // lost before stdout arrives, the next monitor owns a bounded name-based
      // reconciliation rather than trusting a one-shot label scan.
      uncertainty = this.persistCreateUncertainty(containerName, taskId);
    } catch (error: unknown) {
      this.containers.delete(taskId);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot create container for ${taskId}: durable create ownership could not be recorded (${detail})`,
      );
    }

    try {
      const createArgs = this.buildCreateArgs(taskId, containerName);
      const { stdout } = await this.runDocker(createArgs);
      const containerId = stdout.trim() || containerName;
      info.containerId = containerId;
      if (!this.clearCreateUncertainty(uncertainty)) {
        throw new Error(`could not clear durable create ownership for ${containerName}`);
      }

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
      // When `docker create` did not return, the durable marker remains. An
      // immediate "no such container" probe is not proof of absence while the
      // daemon request may still land; restart reconciliation waits first.
      const removed = await this.forceRemoveContainer(info.containerId);
      if (removed) this.clearCreateUncertainty(uncertainty);
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

    const uncertainty = this.uncertainCreations.get(containerId);
    if (
      !removalCommandSucceeded &&
      uncertainty !== undefined &&
      Date.now() < Date.parse(uncertainty.confirmAfter)
    ) {
      return false;
    }

    // Update tracking
    for (const [taskId, info] of this.containers) {
      if (info.containerId === containerId) {
        info.status = "removed";
        this.containers.delete(taskId);
        break;
      }
    }
    if (uncertainty) this.clearCreateUncertainty(uncertainty);
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
    args.push("--label", `quack.projectFingerprint=${this.projectFingerprint}`);

    // Image
    args.push(this.config.image);

    // Keep container running (sleep) so we can docker exec into it
    args.push("sleep", "infinity");

    return args;
  }
}
