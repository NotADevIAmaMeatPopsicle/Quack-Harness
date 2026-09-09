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
const UNCERTAIN_CREATE_WINDOW_MS = DOCKER_COMMAND_TIMEOUT_MS;
const UNCERTAIN_CREATE_PROBE_INTERVAL_MS = 250;

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Resolve symlinks/junctions in the existing portion of a path. The remaining
 * suffix is safe to append because none of its entries exist yet.
 */
function resolveThroughExistingAncestor(value: string): string {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    let entryExists = false;
    try {
      fs.lstatSync(existing);
      entryExists = true;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
    if (entryExists) {
      // If an existing symlink/junction is broken, fail closed instead of
      // treating it as an ordinary missing suffix that may later escape.
      const real = fs.realpathSync.native(existing);
      return path.resolve(real, ...suffix);
    }
  }
}

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
  Name?: unknown;
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
  /** Do not treat repeated absence as conclusive until this bounded deadline. */
  reconcileUntil: string;
  confirmationToken: string;
}

export interface DockerManagerOptions {
  /** Resolved host directory matching adapter logging.dir. */
  logDir?: string;
  /** Testable bound for a daemon request accepted before monitor loss. */
  uncertainCreateWindowMs?: number;
  /** Interval between name-based late-create probes. */
  uncertainCreateProbeIntervalMs?: number;
}

export class DockerManager {
  private containers = new Map<string, DockerContainer>();
  private pendingCommands = new Set<AbortController>();
  /** Durable create requests whose daemon outcome has not yet been proven. */
  private uncertainCreations = new Map<string, DockerCreateUncertainty>();
  private unreadableUncertaintyMarkers = new Set<string>();
  private readonly projectFingerprint: string;
  private readonly uncertaintyDir: string;
  private readonly hostLogDir: string;
  private readonly containerLogDir: string;
  private readonly uncertainCreateWindowMs: number;
  private readonly uncertainCreateProbeIntervalMs: number;

  constructor(
    private readonly projectRoot: string,
    private readonly config: DockerIsolationConfig,
    stateRoot?: string,
    options: DockerManagerOptions = {},
  ) {
    const resolvedRoot = path.resolve(projectRoot).replace(/\\/g, "/");
    this.projectFingerprint = createHash("sha256")
      .update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
      .digest("hex");
    this.uncertaintyDir =
      stateRoot ?? path.join(projectRoot, ".quack", "logs", "docker-create-uncertainty");
    this.hostLogDir = path.resolve(options.logDir ?? path.join(projectRoot, ".quack", "logs"));
    this.assertSafeLogDir();
    this.assertSafeConfiguredVolumes();
    const relativeLogDir = path
      .relative(path.resolve(projectRoot), this.hostLogDir)
      .replace(/\\/g, "/");
    this.containerLogDir = path.posix.resolve("/workspace", relativeLogDir || ".");
    this.uncertainCreateWindowMs = Math.max(
      1,
      options.uncertainCreateWindowMs ?? UNCERTAIN_CREATE_WINDOW_MS,
    );
    this.uncertainCreateProbeIntervalMs = Math.max(
      1,
      options.uncertainCreateProbeIntervalMs ?? UNCERTAIN_CREATE_PROBE_INTERVAL_MS,
    );
    this.refreshCreateUncertainty();
  }

  private assertSafeLogDir(): void {
    const resolvedRoot = path.resolve(this.projectRoot);
    const canonicalPrep = path.join(resolvedRoot, ".quack", "prep");
    const protectedPrep = path.resolve(resolvePrepStorageDirSync(resolvedRoot));
    if (!isSameOrDescendant(this.hostLogDir, resolvedRoot)) {
      throw new Error("Docker logging.dir must remain inside the project root");
    }
    if (
      isSameOrDescendant(this.hostLogDir, canonicalPrep) ||
      isSameOrDescendant(this.hostLogDir, protectedPrep)
    ) {
      throw new Error("Docker logging.dir must not overlap the protected .quack/prep tree");
    }

    const realRoot = resolveThroughExistingAncestor(resolvedRoot);
    const realLogDir = resolveThroughExistingAncestor(this.hostLogDir);
    const realCanonicalPrepDir = resolveThroughExistingAncestor(canonicalPrep);
    const realPrepDir = resolveThroughExistingAncestor(protectedPrep);
    if (!isSameOrDescendant(realLogDir, realRoot)) {
      throw new Error("Docker logging.dir resolves outside the project root");
    }
    if (
      isSameOrDescendant(realLogDir, realCanonicalPrepDir) ||
      isSameOrDescendant(realLogDir, realPrepDir)
    ) {
      throw new Error("Docker logging.dir resolves into the protected .quack/prep tree");
    }
  }

  private safeConfiguredVolume(volume: string): { destination: string; argument: string } {
    const fields = volume.split(":");
    let destinationIndex = -1;
    for (let index = fields.length - 1; index >= 0; index -= 1) {
      if (fields[index].startsWith("/")) {
        destinationIndex = index;
        break;
      }
    }
    if (destinationIndex < 1) {
      throw new Error(`Docker volume must include a source and absolute destination: ${volume}`);
    }

    const source = fields.slice(0, destinationIndex).join(":");
    const destination = path.posix.normalize(fields[destinationIndex]);
    const options = fields.slice(destinationIndex + 1).join(":");
    const optionSet = new Set(options.split(",").filter(Boolean));
    if (!optionSet.has("ro") || optionSet.has("rw")) {
      throw new Error(`Docker volume ${volume} must be explicitly read-only (:ro)`);
    }

    const looksLikeBindSource =
      path.isAbsolute(source) ||
      /^[A-Za-z]:[\\/]/.test(source) ||
      source.startsWith(".") ||
      source.includes("/") ||
      source.includes("\\");
    if (!looksLikeBindSource) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) {
        throw new Error(`Docker volume has an invalid named source: ${volume}`);
      }
      return { destination, argument: `${source}:${destination}:${options}` };
    }

    const resolvedRoot = path.resolve(this.projectRoot);
    const resolvedSource = path.isAbsolute(source)
      ? path.resolve(source)
      : path.resolve(resolvedRoot, source);
    if (!isSameOrDescendant(resolvedSource, resolvedRoot)) {
      throw new Error(`Docker bind source must remain inside the project root: ${source}`);
    }
    const realRoot = resolveThroughExistingAncestor(resolvedRoot);
    const realSource = resolveThroughExistingAncestor(resolvedSource);
    if (!isSameOrDescendant(realSource, realRoot)) {
      throw new Error(`Docker bind source resolves outside the project root: ${source}`);
    }
    return {
      destination,
      argument: `${realSource.replace(/\\/g, "/")}:${destination}:${options}`,
    };
  }

  private assertSafeConfiguredVolumes(): void {
    for (const volume of this.config.volumes ?? []) {
      const { destination } = this.safeConfiguredVolume(volume);
      if (
        isSameOrDescendant(destination, "/workspace") ||
        isSameOrDescendant("/workspace", destination)
      ) {
        throw new Error(
          `Docker volume destination ${destination} overlaps the protected /workspace tree`,
        );
      }
    }
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
        !Number.isFinite(Date.parse((parsed as { createdAt: string }).createdAt)) ||
        typeof (parsed as { confirmAfter?: unknown }).confirmAfter !== "string" ||
        !Number.isFinite(Date.parse((parsed as { confirmAfter: string }).confirmAfter)) ||
        ((parsed as { reconcileUntil?: unknown }).reconcileUntil !== undefined &&
          (typeof (parsed as { reconcileUntil?: unknown }).reconcileUntil !== "string" ||
            !Number.isFinite(Date.parse((parsed as { reconcileUntil: string }).reconcileUntil)))) ||
        typeof (parsed as { confirmationToken?: unknown }).confirmationToken !== "string" ||
        !(parsed as { confirmationToken: string }).confirmationToken
      ) {
        return undefined;
      }
      const marker = parsed as Omit<DockerCreateUncertainty, "reconcileUntil"> & {
        reconcileUntil?: string;
      };
      return {
        ...marker,
        // Markers written by the previous release used only a one-second
        // confirmAfter value. Upgrade them in memory to the full Docker command
        // acceptance window instead of trusting one negative daemon lookup.
        reconcileUntil:
          marker.reconcileUntil ??
          new Date(Date.parse(marker.createdAt) + this.uncertainCreateWindowMs).toISOString(),
      };
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
    const now = Date.now();
    const marker: DockerCreateUncertainty = {
      version: 1,
      containerName,
      taskId,
      projectFingerprint: this.projectFingerprint,
      createdAt: new Date(now).toISOString(),
      confirmAfter: new Date(now + this.uncertainCreateProbeIntervalMs).toISOString(),
      reconcileUntil: new Date(now + this.uncertainCreateWindowMs).toISOString(),
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
      let nextProbeAt = Date.parse(marker.confirmAfter);
      const deadline = Date.parse(marker.reconcileUntil);
      let resolved = false;
      while (!resolved) {
        const delayMs = Math.max(0, nextProbeAt - Date.now());
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }

        const outcome = await this.removeContainerOnce(marker.containerName);
        if (outcome === "removed") {
          resolved = this.clearCreateUncertainty(marker);
          break;
        }
        if (outcome === "unconfirmed") break;
        if (Date.now() >= deadline) {
          // Repeated name probes covered the entire bounded period in which the
          // interrupted Docker CLI could still have delivered its create.
          resolved = this.clearCreateUncertainty(marker);
          break;
        }
        nextProbeAt = Math.min(deadline, Date.now() + this.uncertainCreateProbeIntervalMs);
      }
      if (!resolved) {
        failedTaskIds.push(marker.taskId);
      } else {
        const tracked = this.containers.get(marker.taskId);
        if (tracked?.containerId === marker.containerName && tracked.status === "stopped") {
          this.containers.delete(marker.taskId);
        }
      }
    }
    return { failedTaskIds, ambiguousContainerIds };
  }

  private normalizeHostPath(value: string): string {
    const normalized = value
      .replace(/\\/g, "/")
      .replace(/^\/host_mnt\/([a-z])\//i, "$1:/")
      .replace(/\/$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  private hostPathMatchesRoot(source: string, root: string): boolean {
    const normalizedSource = this.normalizeHostPath(source);
    if (normalizedSource === this.normalizeHostPath(path.resolve(root))) return true;
    try {
      return normalizedSource === this.normalizeHostPath(resolveThroughExistingAncestor(root));
    } catch {
      return false;
    }
  }

  private hostPathMatchesProjectRoot(source: string): boolean {
    return this.hostPathMatchesRoot(source, this.projectRoot);
  }

  /**
   * Discover Quack containers that survived a monitor process and remove this
   * project's containers before new admission. Legacy containers without a
   * project fingerprint are accepted only when their /workspace mount proves
   * ownership; ambiguous records fail closed and are never removed.
   */
  async reconcileExistingContainers(
    registeredProjectRoots: readonly string[] = [this.projectRoot],
  ): Promise<DockerReconciliationResult> {
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
    const discoveredContainers: DockerContainer[] = [];
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
      if (owner === undefined) {
        const workspaceSource = record.Mounts?.find(
          (mount) => mount.Destination === "/workspace" && typeof mount.Source === "string",
        )?.Source;
        if (typeof workspaceSource !== "string") {
          ambiguousContainerIds.push(containerId);
          continue;
        }
        if (!this.hostPathMatchesProjectRoot(workspaceSource)) {
          const belongsToRegisteredPeer = registeredProjectRoots.some(
            (root) =>
              !this.hostPathMatchesRoot(root, this.projectRoot) &&
              this.hostPathMatchesRoot(workspaceSource, root),
          );
          if (belongsToRegisteredPeer) continue;
          ambiguousContainerIds.push(containerId);
          continue;
        }
      }

      const info: DockerContainer = {
        containerId:
          typeof record.Id === "string" && record.Id.length > 0 ? record.Id : containerId,
        taskId,
        image: typeof record.Config?.Image === "string" ? record.Config.Image : this.config.image,
        workDir: "/workspace",
        logsVolume: this.containerLogDir,
        startedAt: typeof record.Created === "string" ? record.Created : new Date().toISOString(),
        status: record.State?.Running === true ? "running" : "stopped",
      };
      const tracked = this.containers.get(taskId);
      if (tracked && (tracked.status === "creating" || tracked.status === "running")) {
        const inspectedId = typeof record.Id === "string" ? record.Id : containerId;
        const inspectedName = typeof record.Name === "string" ? record.Name.replace(/^\//, "") : "";
        const sameContainer =
          inspectedId === tracked.containerId ||
          inspectedId.startsWith(tracked.containerId) ||
          tracked.containerId.startsWith(inspectedId) ||
          inspectedName === tracked.containerId;
        if (sameContainer) continue;
        ambiguousContainerIds.push(containerId);
        continue;
      }
      this.containers.set(taskId, info);
      discoveredTaskIds.push(taskId);
      discoveredContainers.push(info);
    }

    if (ambiguousContainerIds.length > 0) {
      return {
        discoveredTaskIds,
        ambiguousContainerIds,
        removedTaskIds: [],
        failedTaskIds: discoveredTaskIds,
      };
    }
    const outcomes = await Promise.all(
      discoveredContainers.map(async (container) => ({
        taskId: container.taskId,
        removed: await this.forceRemoveContainer(container.containerId),
      })),
    );
    return {
      discoveredTaskIds,
      ambiguousContainerIds,
      removedTaskIds: outcomes.filter(({ removed }) => removed).map(({ taskId }) => taskId),
      failedTaskIds: outcomes.filter(({ removed }) => !removed).map(({ taskId }) => taskId),
    };
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
   * Mounts project root as read-only, the configured logging.dir as read-write,
   * and .quack/prep as read-only. Passes through configured env vars.
   */
  async createContainer(taskId: string): Promise<DockerContainer> {
    this.assertSafeLogDir();
    this.assertSafeConfiguredVolumes();
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
      logsVolume: this.containerLogDir,
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
    const outcome = await this.removeContainerOnce(containerId);
    if (outcome === "unconfirmed") return false;

    const uncertainty = this.uncertainCreations.get(containerId);
    if (
      outcome === "absent" &&
      uncertainty !== undefined &&
      Date.now() < Date.parse(uncertainty.reconcileUntil)
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

  /** One Docker remove/inspect observation; absence alone is not late-create proof. */
  private async removeContainerOnce(
    containerId: string,
  ): Promise<"removed" | "absent" | "unconfirmed"> {
    try {
      await this.runDocker(["rm", "-f", containerId], DOCKER_CLEANUP_TIMEOUT_MS);
      return "removed";
    } catch (error: unknown) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      const errorName = error instanceof Error ? error.name : "";
      if (errorName === "AbortError" || errorCode === "ABORT_ERR" || errorCode === "ETIMEDOUT") {
        return "unconfirmed";
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
          return "unconfirmed";
        } catch (inspectError: unknown) {
          const inspectDetail =
            typeof inspectError === "object" && inspectError !== null && "stderr" in inspectError
              ? String((inspectError as { stderr?: unknown }).stderr)
              : inspectError instanceof Error
                ? inspectError.message
                : String(inspectError);
          if (!/no such (?:object|container)/i.test(inspectDetail)) return "unconfirmed";
        }
      }
      return "absent";
    }
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

    // Adapter logging.dir → its equivalent container path (JSONL events stream to host)
    this.assertSafeLogDir();
    fs.mkdirSync(this.hostLogDir, { recursive: true });
    // Resolve the newly created directory as well so a symlink/junction in any
    // previously missing segment cannot turn this into an arbitrary RW mount.
    this.assertSafeLogDir();
    // Pass Docker the resolved target, not a mutable symlink/junction alias.
    const logsDir = resolveThroughExistingAncestor(this.hostLogDir).replace(/\\/g, "/");
    args.push("-v", `${logsDir}:${this.containerLogDir}:rw`);

    // .quack/prep → read-only
    const prepDir = resolvePrepStorageDirSync(this.projectRoot).replace(/\\/g, "/");
    args.push("-v", `${prepDir}:/workspace/.quack/prep:ro`);

    // Additional configured volumes
    this.assertSafeConfiguredVolumes();
    for (const vol of this.config.volumes ?? []) {
      args.push("-v", this.safeConfiguredVolume(vol).argument);
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
