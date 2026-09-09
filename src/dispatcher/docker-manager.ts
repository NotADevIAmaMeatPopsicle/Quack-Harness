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
  containerName: string;
  taskId: string;
  image: string;
  workDir: string;
  logsVolume: string;
  /** Host worktree mounted read-write at /workspace. */
  worktreePath: string;
  /** Fresh per-dispatch output directory inside the disposable worktree. */
  runtimeLogDir: string;
  /** Task-specific gitdir exposed through the dedicated metadata mount. */
  gitDir: string;
  startedAt: string;
  status: "creating" | "running" | "stopped" | "cleanup_pending" | "removed";
  /** A cleanup attempt did not prove absence; admission must reconcile it. */
  cleanupPending?: boolean;
  /** Intentional cleanup-policy retention, durable across monitor restarts. */
  retained?: boolean;
  retentionConfirmed?: boolean;
  exitCode?: number;
}

export interface DockerCleanupResult {
  removedTaskIds: string[];
  failedTaskIds: string[];
  retainedTaskIds?: string[];
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
  version: 2;
  containerName: string;
  taskId: string;
  projectFingerprint: string;
  createdAt: string;
  /** Set only when an interrupted/timed-out create is observed. */
  interruptedAt?: string;
  confirmAfter?: string;
  /** Do not treat repeated absence as conclusive until this bounded deadline. */
  reconcileUntil?: string;
  confirmationToken: string;
}

interface DockerRetentionMarker {
  version: 1;
  containerId: string;
  containerName: string;
  taskId: string;
  projectFingerprint: string;
  worktreePath: string;
  runtimeLogDir: string;
  gitDir: string;
  policy: "keep_on_failure" | "always_keep";
  retainedAt: string;
  stopConfirmed: boolean;
  confirmationToken: string;
}

export interface DockerStopResult {
  removed: boolean;
  retained: boolean;
}

export interface DockerManagerOptions {
  /** Resolved host directory matching adapter logging.dir. */
  logDir?: string;
  /** Testable bound for a daemon request accepted before monitor loss. */
  uncertainCreateWindowMs?: number;
  /** Interval between name-based late-create probes. */
  uncertainCreateProbeIntervalMs?: number;
  /** Trusted Quack installation root, mounted read-only for the CLI runtime. */
  runtimeRoot?: string;
}

export class DockerManager {
  private containers = new Map<string, DockerContainer>();
  private pendingCommands = new Set<AbortController>();
  /** Durable create requests whose daemon outcome has not yet been proven. */
  private uncertainCreations = new Map<string, DockerCreateUncertainty>();
  private unreadableUncertaintyMarkers = new Set<string>();
  /** Durable intentional retention records. */
  private retainedContainers = new Map<string, DockerRetentionMarker>();
  private unreadableRetentionMarkers = new Set<string>();
  private readonly projectFingerprint: string;
  private readonly uncertaintyDir: string;
  private readonly retentionDir: string;
  private readonly hostLogDir: string;
  private readonly uncertainCreateWindowMs: number;
  private readonly uncertainCreateProbeIntervalMs: number;
  private readonly runtimeRoot?: string;

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
    this.retentionDir = path.join(this.uncertaintyDir, "retained");
    this.hostLogDir = path.resolve(options.logDir ?? path.join(projectRoot, ".quack", "logs"));
    this.assertSafeLogDir();
    this.assertSafeConfiguredVolumes();
    this.uncertainCreateWindowMs = Math.max(
      1,
      options.uncertainCreateWindowMs ?? UNCERTAIN_CREATE_WINDOW_MS,
    );
    this.uncertainCreateProbeIntervalMs = Math.max(
      1,
      options.uncertainCreateProbeIntervalMs ?? UNCERTAIN_CREATE_PROBE_INTERVAL_MS,
    );
    this.runtimeRoot = options.runtimeRoot
      ? resolveThroughExistingAncestor(path.resolve(options.runtimeRoot))
      : undefined;
    this.refreshCreateUncertainty();
    this.refreshRetentionMarkers();
  }

  /** Translate a trusted host runtime entry point to its read-only container mount. */
  containerPathForHost(hostPath: string): string {
    const resolved = resolveThroughExistingAncestor(path.resolve(hostPath));
    if (isSameOrDescendant(resolved, resolveThroughExistingAncestor(this.projectRoot))) {
      const relative = path.relative(resolveThroughExistingAncestor(this.projectRoot), resolved);
      return path.posix.join("/workspace", relative.replace(/\\/g, "/"));
    }
    if (this.runtimeRoot && isSameOrDescendant(resolved, this.runtimeRoot)) {
      const relative = path.relative(this.runtimeRoot, resolved);
      return path.posix.join("/quack-runtime", relative.replace(/\\/g, "/"));
    }
    throw new Error("Quack runtime entry point is outside trusted Docker runtime mounts");
  }

  private assertSafeLogDir(): void {
    const resolvedRoot = path.resolve(this.projectRoot);
    const relativeLogDir = path.relative(resolvedRoot, this.hostLogDir);
    const dedicatedLogDir = path.join(resolvedRoot, ".quack", "logs");
    const canonicalPrep = path.join(resolvedRoot, ".quack", "prep");
    const protectedPrep = path.resolve(resolvePrepStorageDirSync(resolvedRoot));
    if (
      path.isAbsolute(relativeLogDir) ||
      relativeLogDir === ".." ||
      relativeLogDir.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Docker logging.dir must remain inside the project root");
    }
    if (comparablePath(this.hostLogDir) !== comparablePath(dedicatedLogDir)) {
      throw new Error(
        "Docker isolation requires logging.dir to be the dedicated .quack/logs runtime directory",
      );
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

  private safeConfiguredVolume(
    volume: string,
    worktreePath?: string,
  ): { destination: string; argument: string } {
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
    if (options !== "ro") {
      throw new Error(`Docker volume ${volume} must be explicitly read-only (:ro)`);
    }

    const looksLikeBindSource =
      path.isAbsolute(source) ||
      /^[A-Za-z]:[\\/]/.test(source) ||
      source.startsWith(".") ||
      source.includes("/") ||
      source.includes("\\");
    if (!looksLikeBindSource) {
      throw new Error(
        `Docker named volume ${source} is not trusted; configure an explicit project-relative read-only bind source instead`,
      );
    }

    const resolvedRoot = path.resolve(this.projectRoot);
    const resolvedSource = path.isAbsolute(source)
      ? path.resolve(source)
      : path.resolve(resolvedRoot, source);
    if (!isSameOrDescendant(resolvedSource, resolvedRoot)) {
      throw new Error(`Docker bind source must remain inside the project root: ${source}`);
    }
    const relativeSource = path.relative(resolvedRoot, resolvedSource);
    const mountRoot = worktreePath ? path.resolve(worktreePath) : resolvedRoot;
    const mountSource = path.resolve(mountRoot, relativeSource);
    const realRoot = resolveThroughExistingAncestor(mountRoot);
    const realSource = resolveThroughExistingAncestor(mountSource);
    if (!isSameOrDescendant(realSource, realRoot)) {
      throw new Error(`Docker bind source resolves outside the project root: ${source}`);
    }
    if (worktreePath && !fs.existsSync(realSource)) {
      throw new Error(`Docker bind source does not exist in the task worktree: ${source}`);
    }
    if (worktreePath) this.assertReadOnlyBindTreeSafe(realSource, realRoot);
    return {
      destination,
      argument: `${realSource.replace(/\\/g, "/")}:${destination}:${options}`,
    };
  }

  private assertSafeConfiguredVolumes(worktreePath?: string): void {
    for (const volume of this.config.volumes ?? []) {
      const { destination } = this.safeConfiguredVolume(volume, worktreePath);
      if (
        isSameOrDescendant(destination, "/workspace") ||
        isSameOrDescendant("/workspace", destination) ||
        isSameOrDescendant(destination, "/quack-runtime") ||
        isSameOrDescendant("/quack-runtime", destination) ||
        isSameOrDescendant(destination, "/quack-git") ||
        isSameOrDescendant("/quack-git", destination)
      ) {
        throw new Error(
          `Docker volume destination ${destination} overlaps a protected runtime tree`,
        );
      }
    }
  }

  private assertReadOnlyBindTreeSafe(source: string, root: string): void {
    const pending = [source];
    let entries = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      const stat = fs.lstatSync(current);
      const realCurrent = fs.realpathSync.native(current);
      if (!isSameOrDescendant(realCurrent, root)) {
        throw new Error(`Docker bind source resolves outside the task worktree: ${current}`);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Docker bind source contains an untrusted symlink or junction: ${current}`);
      }
      if (stat.isFile()) {
        if (stat.nlink !== 1) {
          throw new Error(`Docker bind source contains an untrusted hard link: ${current}`);
        }
        continue;
      }
      if (!stat.isDirectory()) {
        throw new Error(`Docker bind source contains an unsupported entry: ${current}`);
      }
      entries += 1;
      if (entries > 100_000) {
        throw new Error("Docker bind source exceeds the safe validation limit");
      }
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    }
  }

  private resolveWorktreeGitDir(worktreePath: string): {
    hostGitRoot: string;
    containerGitDir: string;
  } {
    const projectGitPath = path.join(this.projectRoot, ".git");
    const hostGitRoot = fs.realpathSync.native(projectGitPath);
    const dotGitPath = path.join(worktreePath, ".git");
    const dotGit = fs.readFileSync(dotGitPath, "utf-8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
    if (!match) {
      throw new Error("Docker dispatch requires a linked Git worktree");
    }
    const worktreeGitDir = fs.realpathSync.native(path.resolve(worktreePath, match[1].trim()));
    const worktreeAdminRoot = path.join(hostGitRoot, "worktrees");
    if (!isSameOrDescendant(worktreeGitDir, worktreeAdminRoot)) {
      throw new Error("Docker worktree git metadata resolves outside the authoritative repository");
    }
    const relativeGitDir = path.relative(hostGitRoot, worktreeGitDir).replace(/\\/g, "/");
    return {
      hostGitRoot,
      containerGitDir: path.posix.join("/quack-git", relativeGitDir),
    };
  }

  private authoritativePolicyMounts(): Array<{ source: string; destination: string }> {
    const projectRoot = fs.realpathSync.native(this.projectRoot);
    const files = ["adapter.json", "conventions.md", "judge-criteria.md", "verify.js"];
    const mounts: Array<{ source: string; destination: string }> = [];
    for (const fileName of files) {
      const source = path.join(this.projectRoot, ".quack", fileName);
      if (!fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      const realSource = fs.realpathSync.native(source);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !isSameOrDescendant(realSource, projectRoot)
      ) {
        throw new Error(`Docker policy file has an untrusted identity: .quack/${fileName}`);
      }
      mounts.push({
        source: realSource,
        destination: `/workspace/.quack/${fileName}`,
      });
    }
    return mounts;
  }

  private uncertaintyPath(containerName: string): string {
    return path.join(this.uncertaintyDir, `${containerName.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private createRuntimeLogDir(
    taskId: string,
    worktreePath: string,
  ): { hostPath: string; containerPath: string } {
    // Container output belongs to the disposable task worktree. Never expose
    // the monitor's authoritative log/control tree as a writable bind mount.
    const base = path.join(worktreePath, ".quack", "docker-runtime");
    const realWorktree = resolveThroughExistingAncestor(worktreePath);
    const prospectiveBase = resolveThroughExistingAncestor(base);
    if (!isSameOrDescendant(prospectiveBase, realWorktree)) {
      throw new Error("Docker dispatch log root resolves outside the task worktree");
    }
    fs.mkdirSync(base, { recursive: true });
    const realBase = resolveThroughExistingAncestor(base);
    if (!isSameOrDescendant(realBase, realWorktree)) {
      throw new Error("Docker dispatch log root resolves outside the task worktree");
    }

    const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const runtimeLogDir = path.join(base, `${safeTaskId}-${randomUUID()}`);
    fs.mkdirSync(runtimeLogDir, { recursive: false });
    const stat = fs.lstatSync(runtimeLogDir);
    const realRuntimeLogDir = fs.realpathSync.native(runtimeLogDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isSameOrDescendant(realRuntimeLogDir, realBase) ||
      fs.readdirSync(realRuntimeLogDir).length !== 0
    ) {
      throw new Error("Docker dispatch log directory is not a fresh contained directory");
    }
    const relative = path.relative(realWorktree, realRuntimeLogDir).replace(/\\/g, "/");
    return {
      hostPath: realRuntimeLogDir,
      containerPath: path.posix.join("/workspace", relative),
    };
  }

  private assertRuntimeLogDirSafe(runtimeLogDir: string, worktreePath: string): string {
    const realWorktree = resolveThroughExistingAncestor(worktreePath);
    const realBase = resolveThroughExistingAncestor(
      path.join(realWorktree, ".quack", "docker-runtime"),
    );
    const stat = fs.lstatSync(runtimeLogDir);
    const realRuntimeLogDir = fs.realpathSync.native(runtimeLogDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isSameOrDescendant(realRuntimeLogDir, realBase) ||
      !isSameOrDescendant(realRuntimeLogDir, realWorktree)
    ) {
      throw new Error("Docker dispatch log directory changed identity before mount");
    }
    // The leaf is freshly created for this dispatch. Refuse any pre-mount
    // descendant, including hard links and reparse/symlink aliases, so the RW
    // mount cannot expose data that predates this run.
    if (fs.readdirSync(realRuntimeLogDir).length !== 0) {
      throw new Error("Docker dispatch log directory must remain empty until container creation");
    }
    return realRuntimeLogDir;
  }

  private containerRuntimeLogPath(worktreePath: string, runtimeLogDir: string): string {
    const realWorktree = resolveThroughExistingAncestor(worktreePath);
    const realRuntimeLogDir = resolveThroughExistingAncestor(runtimeLogDir);
    if (!isSameOrDescendant(realRuntimeLogDir, realWorktree)) {
      throw new Error("Docker runtime log directory is outside the task worktree");
    }
    const relative = path.relative(realWorktree, realRuntimeLogDir).replace(/\\/g, "/");
    const containerPath = path.posix.join("/workspace", relative);
    if (!containerPath.startsWith("/workspace/.quack/docker-runtime/")) {
      throw new Error("Docker runtime log directory is outside the isolated runtime subtree");
    }
    return containerPath;
  }

  private parseCreateUncertainty(markerPath: string): DockerCreateUncertainty | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        ![1, 2].includes(Number((parsed as { version?: unknown }).version)) ||
        typeof (parsed as { containerName?: unknown }).containerName !== "string" ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        (parsed as { projectFingerprint?: unknown }).projectFingerprint !==
          this.projectFingerprint ||
        typeof (parsed as { createdAt?: unknown }).createdAt !== "string" ||
        !Number.isFinite(Date.parse((parsed as { createdAt: string }).createdAt)) ||
        ((parsed as { interruptedAt?: unknown }).interruptedAt !== undefined &&
          (typeof (parsed as { interruptedAt?: unknown }).interruptedAt !== "string" ||
            !Number.isFinite(Date.parse((parsed as { interruptedAt: string }).interruptedAt)))) ||
        ((parsed as { confirmAfter?: unknown }).confirmAfter !== undefined &&
          (typeof (parsed as { confirmAfter?: unknown }).confirmAfter !== "string" ||
            !Number.isFinite(Date.parse((parsed as { confirmAfter: string }).confirmAfter)))) ||
        ((parsed as { reconcileUntil?: unknown }).reconcileUntil !== undefined &&
          (typeof (parsed as { reconcileUntil?: unknown }).reconcileUntil !== "string" ||
            !Number.isFinite(Date.parse((parsed as { reconcileUntil: string }).reconcileUntil)))) ||
        typeof (parsed as { confirmationToken?: unknown }).confirmationToken !== "string" ||
        !(parsed as { confirmationToken: string }).confirmationToken
      ) {
        return undefined;
      }
      const marker = parsed as Omit<DockerCreateUncertainty, "version" | "reconcileUntil"> & {
        version: 1 | 2;
        reconcileUntil?: string;
      };
      return {
        ...marker,
        version: 2,
        // Markers written by the previous release used only a one-second
        // confirmAfter value. Upgrade them in memory to the full Docker command
        // acceptance window instead of trusting one negative daemon lookup.
        ...(marker.version === 1
          ? {
              interruptedAt: marker.createdAt,
              confirmAfter:
                marker.confirmAfter ??
                new Date(
                  Date.parse(marker.createdAt) + this.uncertainCreateProbeIntervalMs,
                ).toISOString(),
              reconcileUntil:
                marker.reconcileUntil ??
                new Date(Date.parse(marker.createdAt) + this.uncertainCreateWindowMs).toISOString(),
            }
          : {}),
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
      version: 2,
      containerName,
      taskId,
      projectFingerprint: this.projectFingerprint,
      createdAt: new Date(now).toISOString(),
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

  private markCreateInterrupted(
    marker: DockerCreateUncertainty,
  ): DockerCreateUncertainty | undefined {
    const markerPath = this.uncertaintyPath(marker.containerName);
    const current = this.parseCreateUncertainty(markerPath);
    if (!current || current.confirmationToken !== marker.confirmationToken) return undefined;
    if (current.interruptedAt && current.confirmAfter && current.reconcileUntil) return current;
    const observedAt = Date.now();
    const interrupted: DockerCreateUncertainty = {
      ...current,
      interruptedAt: new Date(observedAt).toISOString(),
      confirmAfter: new Date(observedAt + this.uncertainCreateProbeIntervalMs).toISOString(),
      reconcileUntil: new Date(observedAt + this.uncertainCreateWindowMs).toISOString(),
    };
    const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf-8");
    fs.renameSync(temporaryPath, markerPath);
    this.uncertainCreations.set(marker.containerName, interrupted);
    return interrupted;
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

  private retentionPath(taskId: string): string {
    return path.join(this.retentionDir, `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private parseRetentionMarker(markerPath: string): DockerRetentionMarker | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        typeof (parsed as { containerId?: unknown }).containerId !== "string" ||
        typeof (parsed as { containerName?: unknown }).containerName !== "string" ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        (parsed as { projectFingerprint?: unknown }).projectFingerprint !==
          this.projectFingerprint ||
        typeof (parsed as { worktreePath?: unknown }).worktreePath !== "string" ||
        typeof (parsed as { runtimeLogDir?: unknown }).runtimeLogDir !== "string" ||
        typeof (parsed as { gitDir?: unknown }).gitDir !== "string" ||
        !["keep_on_failure", "always_keep"].includes(
          String((parsed as { policy?: unknown }).policy),
        ) ||
        typeof (parsed as { retainedAt?: unknown }).retainedAt !== "string" ||
        !Number.isFinite(Date.parse((parsed as { retainedAt: string }).retainedAt)) ||
        typeof (parsed as { stopConfirmed?: unknown }).stopConfirmed !== "boolean" ||
        typeof (parsed as { confirmationToken?: unknown }).confirmationToken !== "string" ||
        !(parsed as { confirmationToken: string }).confirmationToken
      ) {
        return undefined;
      }
      return parsed as DockerRetentionMarker;
    } catch {
      return undefined;
    }
  }

  private refreshRetentionMarkers(): void {
    const retained = new Map<string, DockerRetentionMarker>();
    const unreadable = new Set<string>();
    if (fs.existsSync(this.retentionDir)) {
      try {
        for (const entry of fs.readdirSync(this.retentionDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const markerPath = path.join(this.retentionDir, entry.name);
          const marker = this.parseRetentionMarker(markerPath);
          if (!marker || this.retentionPath(marker.taskId) !== markerPath) {
            unreadable.add(entry.name);
            continue;
          }
          retained.set(marker.taskId, marker);
        }
      } catch {
        unreadable.add("unreadable-retention-directory");
      }
    }
    this.retainedContainers = retained;
    this.unreadableRetentionMarkers = unreadable;
  }

  private persistRetention(
    container: DockerContainer,
    policy: DockerRetentionMarker["policy"],
  ): DockerRetentionMarker {
    const existing = this.retainedContainers.get(container.taskId);
    if (
      existing &&
      existing.containerId === container.containerId &&
      existing.containerName === container.containerName
    ) {
      container.retained = true;
      return existing;
    }
    const marker: DockerRetentionMarker = {
      version: 1,
      containerId: container.containerId,
      containerName: container.containerName,
      taskId: container.taskId,
      projectFingerprint: this.projectFingerprint,
      worktreePath: container.worktreePath,
      runtimeLogDir: container.runtimeLogDir,
      gitDir: container.gitDir,
      policy,
      retainedAt: new Date().toISOString(),
      stopConfirmed: false,
      confirmationToken: randomUUID(),
    };
    const markerPath = this.retentionPath(container.taskId);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    this.retainedContainers.set(container.taskId, marker);
    container.retained = true;
    return marker;
  }

  private confirmRetentionStopped(marker: DockerRetentionMarker): boolean {
    const markerPath = this.retentionPath(marker.taskId);
    const current = this.parseRetentionMarker(markerPath);
    if (!current || current.confirmationToken !== marker.confirmationToken) return false;
    const confirmed: DockerRetentionMarker = { ...current, stopConfirmed: true };
    const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(confirmed, null, 2)}\n`, "utf-8");
      fs.renameSync(temporaryPath, markerPath);
      this.retainedContainers.set(marker.taskId, confirmed);
      return true;
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best effort only; the original unconfirmed marker remains.
      }
      return false;
    }
  }

  private clearRetention(marker: DockerRetentionMarker): boolean {
    const markerPath = this.retentionPath(marker.taskId);
    const current = this.parseRetentionMarker(markerPath);
    if (!current || current.confirmationToken !== marker.confirmationToken) return false;
    try {
      fs.rmSync(markerPath);
      this.retainedContainers.delete(marker.taskId);
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
      // A create intent with no observed interruption may still be executing in
      // another process. Absence is never proof in that state.
      if (!marker.interruptedAt || !marker.confirmAfter || !marker.reconcileUntil) {
        const outcome = await this.removeContainerOnce(marker.containerName);
        if (outcome === "removed" && this.clearCreateUncertainty(marker)) continue;
        failedTaskIds.push(marker.taskId);
        continue;
      }
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
    this.refreshRetentionMarkers();
    const unreadableRetention = Array.from(
      this.unreadableRetentionMarkers,
      (name) => `retention:${name}`,
    );
    if (
      uncertainty.failedTaskIds.length > 0 ||
      uncertainty.ambiguousContainerIds.length > 0 ||
      unreadableRetention.length > 0
    ) {
      return {
        discoveredTaskIds: [],
        removedTaskIds: [],
        failedTaskIds: uncertainty.failedTaskIds,
        ambiguousContainerIds: [...uncertainty.ambiguousContainerIds, ...unreadableRetention],
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
    const retainedTaskIds: string[] = [];
    const unconfirmedRetainedTaskIds: string[] = [];
    const seenRetentionTasks = new Set<string>();
    const seenOwnedContainerKeys = new Set<string>();

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
      const inspectedId = typeof record.Id === "string" ? record.Id : containerId;
      const inspectedName = typeof record.Name === "string" ? record.Name.replace(/^\//, "") : "";
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
      seenOwnedContainerKeys.add(inspectedId);
      if (inspectedName) seenOwnedContainerKeys.add(inspectedName);

      const retained = this.retainedContainers.get(taskId);
      if (
        retained &&
        retained.projectFingerprint === this.projectFingerprint &&
        (retained.containerId === inspectedId || retained.containerName === inspectedName)
      ) {
        const info: DockerContainer = {
          containerId: inspectedId,
          containerName: inspectedName || retained.containerName,
          taskId,
          image: typeof record.Config?.Image === "string" ? record.Config.Image : this.config.image,
          workDir: "/workspace",
          logsVolume: this.containerRuntimeLogPath(retained.worktreePath, retained.runtimeLogDir),
          worktreePath: retained.worktreePath,
          runtimeLogDir: retained.runtimeLogDir,
          gitDir: retained.gitDir,
          startedAt: typeof record.Created === "string" ? record.Created : retained.retainedAt,
          status: record.State?.Running === true ? "running" : "stopped",
          retained: true,
          retentionConfirmed: retained.stopConfirmed,
        };
        this.containers.set(taskId, info);
        discoveredTaskIds.push(taskId);
        if (retained.stopConfirmed && record.State?.Running !== true) {
          retainedTaskIds.push(taskId);
        } else {
          info.retentionConfirmed = false;
          unconfirmedRetainedTaskIds.push(taskId);
        }
        seenRetentionTasks.add(taskId);
        continue;
      }

      const workspaceSource = record.Mounts?.find(
        (mount) => mount.Destination === "/workspace" && typeof mount.Source === "string",
      )?.Source;
      const labeledRuntimeLog = labels?.["quack.runtimeLogPath"];
      const labeledGitDir = labels?.["quack.gitDir"];
      const runtimeLogRelative =
        typeof labeledRuntimeLog === "string" &&
        labeledRuntimeLog.startsWith("/workspace/.quack/docker-runtime/")
          ? path.posix.relative("/workspace", labeledRuntimeLog)
          : undefined;
      const runtimeLogSource =
        typeof workspaceSource === "string" && runtimeLogRelative
          ? path.resolve(workspaceSource, runtimeLogRelative)
          : undefined;
      const info: DockerContainer = {
        containerId: inspectedId.length > 0 ? inspectedId : containerId,
        containerName: inspectedName || containerId,
        taskId,
        image: typeof record.Config?.Image === "string" ? record.Config.Image : this.config.image,
        workDir: "/workspace",
        logsVolume:
          typeof labeledRuntimeLog === "string"
            ? labeledRuntimeLog
            : "/workspace/.quack/docker-runtime",
        worktreePath:
          typeof workspaceSource === "string" ? workspaceSource : path.resolve(this.projectRoot),
        runtimeLogDir: typeof runtimeLogSource === "string" ? runtimeLogSource : this.hostLogDir,
        gitDir:
          typeof labeledGitDir === "string" && labeledGitDir.startsWith("/quack-git/worktrees/")
            ? labeledGitDir
            : "/quack-git/worktrees/unresolved",
        startedAt: typeof record.Created === "string" ? record.Created : new Date().toISOString(),
        status: record.State?.Running === true ? "running" : "stopped",
      };
      const tracked = this.containers.get(taskId);
      if (
        tracked &&
        !tracked.cleanupPending &&
        (tracked.status === "creating" || tracked.status === "running")
      ) {
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

    // A retained marker whose container is absent from a complete daemon list
    // has been explicitly removed out of band. Clear only its exact tokened
    // generation; a concurrent replacement cannot be erased.
    for (const [taskId, marker] of this.retainedContainers) {
      if (seenRetentionTasks.has(taskId)) continue;
      this.clearRetention(marker);
    }

    // A complete, unambiguous daemon list is proof that a previously
    // cleanup-pending, fully-created container is absent. Keep ambiguous
    // scans fail-closed and never infer absence from them.
    if (ambiguousContainerIds.length === 0) {
      for (const [taskId, tracked] of this.containers) {
        if (
          tracked.cleanupPending &&
          !seenOwnedContainerKeys.has(tracked.containerId) &&
          !seenOwnedContainerKeys.has(tracked.containerName) &&
          !this.uncertainCreations.has(tracked.containerName)
        ) {
          tracked.status = "removed";
          this.containers.delete(taskId);
        }
      }
    }

    if (ambiguousContainerIds.length > 0) {
      return {
        discoveredTaskIds,
        ambiguousContainerIds,
        removedTaskIds: [],
        failedTaskIds: Array.from(
          new Set([
            ...discoveredTaskIds.filter((taskId) => !retainedTaskIds.includes(taskId)),
            ...unconfirmedRetainedTaskIds,
          ]),
        ),
        ...(retainedTaskIds.length > 0 ? { retainedTaskIds } : {}),
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
      failedTaskIds: [
        ...unconfirmedRetainedTaskIds,
        ...outcomes.filter(({ removed }) => !removed).map(({ taskId }) => taskId),
      ],
      ...(retainedTaskIds.length > 0 ? { retainedTaskIds } : {}),
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
   * Mounts only a task worktree read-write. Git metadata is mounted separately
   * so commits work, while authoritative policy/prep files stay read-only.
   */
  async createContainer(taskId: string, worktreePath: string): Promise<DockerContainer> {
    this.assertSafeLogDir();
    const expectedWorktree = path.resolve(this.projectRoot, ".quack", "worktrees", taskId);
    const resolvedWorktree = path.resolve(worktreePath);
    if (comparablePath(resolvedWorktree) !== comparablePath(expectedWorktree)) {
      throw new Error(`Docker dispatch ${taskId} requires its task-specific managed worktree`);
    }
    const realWorktree = resolveThroughExistingAncestor(resolvedWorktree);
    const realProject = resolveThroughExistingAncestor(this.projectRoot);
    if (
      !fs.existsSync(resolvedWorktree) ||
      comparablePath(realWorktree) === comparablePath(realProject) ||
      !isSameOrDescendant(realWorktree, path.join(realProject, ".quack", "worktrees"))
    ) {
      throw new Error(`Docker dispatch ${taskId} worktree identity could not be verified`);
    }
    this.assertSafeConfiguredVolumes(realWorktree);
    const gitMount = this.resolveWorktreeGitDir(realWorktree);
    // Prevent double-create
    const existing = this.containers.get(taskId);
    if (existing && existing.status !== "removed") {
      throw new Error(
        `Container cleanup is unresolved for ${taskId} (${existing.containerId}, ${existing.status})`,
      );
    }

    const containerName = `quack-${taskId}-${randomUUID()}`;
    const runtimeLog = this.createRuntimeLogDir(taskId, realWorktree);
    const runtimeLogDir = runtimeLog.hostPath;
    const info: DockerContainer = {
      // Docker commands accept the unique name as well as the eventual ID,
      // which lets shutdown clean up even if `docker create` is interrupted
      // before stdout returns the ID.
      containerId: containerName,
      containerName,
      taskId,
      image: this.config.image,
      workDir: "/workspace",
      logsVolume: runtimeLog.containerPath,
      worktreePath: realWorktree,
      runtimeLogDir,
      gitDir: gitMount.containerGitDir,
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
      const createArgs = this.buildCreateArgs(
        taskId,
        realWorktree,
        runtimeLogDir,
        runtimeLog.containerPath,
        gitMount.hostGitRoot,
        gitMount.containerGitDir,
        containerName,
      );
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

      // The creation transaction is complete only after every setup action
      // succeeded. Until this exact token is cleared, restart admission stays
      // blocked and reconciles the uniquely named attempt.
      if (!this.clearCreateUncertainty(uncertainty)) {
        throw new Error(`could not clear durable create ownership for ${containerName}`);
      }

      return info;
    } catch (err) {
      info.status = "stopped";
      let interrupted = uncertainty;
      try {
        interrupted = this.markCreateInterrupted(uncertainty) ?? uncertainty;
      } catch {
        // The original intent marker stays present and therefore fail-closed.
      }
      // When `docker create` did not return, the durable marker remains. An
      // immediate "no such container" probe is not proof of absence while the
      // daemon request may still land; restart reconciliation waits first.
      const removed = await this.forceRemoveContainer(info.containerId).catch(() => false);
      if (removed) this.clearCreateUncertainty(interrupted);
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

    const tracked = Array.from(this.containers.values()).find(
      (container) => container.containerId === containerId,
    );
    if (tracked) {
      args.push("-e", `GIT_DIR=${tracked.gitDir}`, "-e", "GIT_WORK_TREE=/workspace");
    }

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
  async stopContainer(containerId: string, failed = false): Promise<DockerStopResult> {
    const container = Array.from(this.containers.values()).find(
      (candidate) => candidate.containerId === containerId,
    );
    const shouldRemove =
      this.config.cleanupPolicy === "remove" ||
      (this.config.cleanupPolicy === "keep_on_failure" && !failed);

    let retention: DockerRetentionMarker | undefined;
    if (!shouldRemove && container) {
      const policy = this.config.cleanupPolicy;
      if (policy === "keep_on_failure" || policy === "always_keep") {
        retention = this.persistRetention(container, policy);
      }
    }

    let stopConfirmed = false;
    try {
      await this.runDocker(["stop", "-t", "10", containerId], DOCKER_CLEANUP_TIMEOUT_MS);
      stopConfirmed = true;
    } catch (error: unknown) {
      const detail =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr)
          : error instanceof Error
            ? error.message
            : String(error);
      stopConfirmed = /no such (?:object|container)/i.test(detail);
    }

    // Update tracking
    for (const info of this.containers.values()) {
      if (info.containerId === containerId) {
        if (stopConfirmed) info.status = "stopped";
        break;
      }
    }

    if (shouldRemove) {
      return { removed: await this.forceRemoveContainer(containerId), retained: false };
    }
    if (!retention || !stopConfirmed || !this.confirmRetentionStopped(retention)) {
      return { removed: false, retained: false };
    }
    if (container) container.retentionConfirmed = true;
    return { removed: false, retained: true };
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
    const tracked = Array.from(this.containers.values()).find(
      (container) =>
        container.containerId === containerId || container.containerName === containerId,
    );
    const uncertainty =
      this.uncertainCreations.get(containerId) ??
      (tracked ? this.uncertainCreations.get(tracked.containerName) : undefined);
    if (outcome === "unconfirmed") {
      if (tracked) {
        tracked.cleanupPending = true;
        tracked.status = "cleanup_pending";
      }
      return false;
    }

    if (outcome === "absent" && uncertainty !== undefined) {
      if (
        !uncertainty.interruptedAt ||
        !uncertainty.reconcileUntil ||
        Date.now() < Date.parse(uncertainty.reconcileUntil)
      ) {
        if (tracked) {
          tracked.cleanupPending = true;
          tracked.status = "cleanup_pending";
        }
        return false;
      }
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
    for (const marker of this.retainedContainers.values()) {
      if (marker.containerId === containerId || marker.containerName === containerId) {
        this.clearRetention(marker);
      }
    }
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
    const tracked = Array.from(this.containers.values()).find(
      (container) => container.containerId === containerId,
    );
    const execPrefix = tracked
      ? ["exec", "-e", `GIT_DIR=${tracked.gitDir}`, "-e", "GIT_WORK_TREE=/workspace", containerId]
      : ["exec", containerId];
    const [diffResult, logResult, branchResult] = await Promise.all([
      this.runDocker([...execPrefix, "git", "diff", "HEAD"]).catch(() => ({
        stdout: "",
      })),
      this.runDocker([...execPrefix, "git", "log", "--oneline", "-10"]).catch(() => ({
        stdout: "",
      })),
      this.runDocker([...execPrefix, "git", "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({
        stdout: "",
      })),
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

  /** Resources that still make shutdown/admission safety unproven. */
  getUnresolvedContainers(): DockerContainer[] {
    return this.getTrackedContainers().filter(
      (container) =>
        !(container.retained && container.retentionConfirmed && container.status === "stopped"),
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
  async cleanupAll(options: { includeRetained?: boolean } = {}): Promise<DockerCleanupResult> {
    const active = this.getTrackedContainers();
    const outcomes = await Promise.all(
      active.map(async (c) => {
        if (c.retained && options.includeRetained !== true) {
          return {
            taskId: c.taskId,
            removed: false,
            retained: c.retentionConfirmed === true,
          };
        }
        // Shutdown is already in its forced phase. `rm -f` both terminates and
        // removes without spending the entire bound on Docker's stop grace.
        const removed = await this.forceRemoveContainer(c.containerId);
        return { taskId: c.taskId, removed, retained: false };
      }),
    );
    return {
      removedTaskIds: outcomes.filter((outcome) => outcome.removed).map(({ taskId }) => taskId),
      failedTaskIds: outcomes
        .filter((outcome) => !outcome.removed && !outcome.retained)
        .map(({ taskId }) => taskId),
      ...(outcomes.some((outcome) => outcome.retained)
        ? {
            retainedTaskIds: outcomes
              .filter((outcome) => outcome.retained)
              .map(({ taskId }) => taskId),
          }
        : {}),
    };
  }

  /**
   * Build the `docker create` argument list.
   */
  private buildCreateArgs(
    taskId: string,
    worktreePath: string,
    runtimeLogDir: string,
    containerRuntimeLogDir: string,
    hostGitRoot: string,
    containerGitDir: string,
    containerName?: string,
  ): string[] {
    const args = ["create"];

    // Container name for easy identification
    args.push("--name", containerName ?? `quack-${taskId}-${randomUUID()}`);

    // Resource limits
    args.push("--memory", `${this.config.resourceLimits.memoryMb}m`);
    args.push("--cpus", String(this.config.resourceLimits.cpus));
    if (this.config.resourceLimits.storageMb) {
      args.push("--storage-opt", `size=${this.config.resourceLimits.storageMb}M`);
    }

    // Network mode
    args.push("--network", this.config.networkMode);

    // Volume mounts
    // A task-specific Git worktree is the only writable source tree. The
    // authoritative checkout is never mounted into the container.
    const normalizedWorktree = resolveThroughExistingAncestor(worktreePath).replace(/\\/g, "/");
    args.push("-v", `${normalizedWorktree}:/workspace:rw`);
    args.push("-v", `${hostGitRoot.replace(/\\/g, "/")}:/quack-git:rw`);

    if (this.runtimeRoot) {
      args.push("-v", `${this.runtimeRoot.replace(/\\/g, "/")}:/quack-runtime:ro`);
    }

    // The runtime output leaf is part of the disposable worktree already
    // mounted above. Revalidate it, but never add a second RW bind from the
    // authoritative host log/control tree.
    this.assertRuntimeLogDirSafe(runtimeLogDir, worktreePath);

    // .quack/prep → read-only
    const prepDir = resolvePrepStorageDirSync(this.projectRoot).replace(/\\/g, "/");
    args.push("-v", `${prepDir}:/workspace/.quack/prep:ro`);

    // Adapter policy is authoritative monitor input, not task output. Overlay
    // each policy file read-only on top of the writable worktree mount.
    for (const policy of this.authoritativePolicyMounts()) {
      args.push("-v", `${policy.source.replace(/\\/g, "/")}:${policy.destination}:ro`);
    }

    // Additional configured volumes
    this.assertSafeConfiguredVolumes(worktreePath);
    for (const vol of this.config.volumes ?? []) {
      args.push("-v", this.safeConfiguredVolume(vol, worktreePath).argument);
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
    args.push("--label", `quack.runtimeLogPath=${containerRuntimeLogDir}`);
    args.push("--label", `quack.gitDir=${containerGitDir}`);

    // Image
    args.push(this.config.image);

    // Keep container running (sleep) so we can docker exec into it
    args.push("sleep", "infinity");

    return args;
  }
}
