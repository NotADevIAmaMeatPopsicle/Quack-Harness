import {
  buildClaudeChildEnvironment,
  inspectClaudeAuth,
  ClaudeAuthConfigurationError,
  isClaudeCredentialEnvironmentName,
  type selectClaudeApiKey,
} from "../sdk/claude-auth.js";
// ─── Docker Manager ────────────────────────────────────────────────
// Manages Docker container lifecycle for task isolation.
// Uses child_process.execFile to call Docker CLI — no Docker SDK dependency.
// Provides the same spawn interface as the worktree path so the
// dispatch manager can branch between isolation methods transparently.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import type { DockerIsolationConfig } from "../core/types.js";
import { resolvePrepStorageDirSync } from "../core/prep-storage.js";
import {
  buildTrustedGitEnvironment,
  resolveTrustedExecutable,
  runTrustedGitSync,
} from "../worker/trusted-executable.js";
import {
  assertDecompositionDispatchAdmissionScope,
  removeDecompositionDispatchAdmissionScope,
} from "../preflight/decomposition-dispatch-admission.js";
import { resolveTrustedDockerExecutable, trustedDockerEnvironment } from "./docker-cleanup.js";
import {
  inspectValidatedDockerResumeArchive,
  seedDockerResumeState,
  type DockerResumeGitBinding,
  type DockerResumeSourceBinding,
} from "./docker-runtime-bridge.js";

const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_CLEANUP_TIMEOUT_MS = 5_000;
const DOCKER_SETUP_TIMEOUT_MS = 15 * 60_000;
const UNCERTAIN_CREATE_WINDOW_MS = DOCKER_COMMAND_TIMEOUT_MS;
const UNCERTAIN_CREATE_PROBE_INTERVAL_MS = 250;
const MAX_PRIVATE_GIT_OBJECT_FILES = 100_000;
const MAX_PRIVATE_GIT_COMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_PRIVATE_GIT_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_PRIVATE_GIT_INFLATED_BYTES = 512 * 1024 * 1024;
const MAX_PRIVATE_GIT_REV_LIST_BYTES = 8 * 1024 * 1024;
const PRIVATE_GIT_COMMAND_TIMEOUT_MS = 60_000;

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

function isSafeGitRef(value: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);
  return (
    value.length <= 500 &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || forbidden.has(character);
    })
  );
}

function readTrustedTextFile(filePath: string, maxBytes: number): string {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`Git metadata has an untrusted identity: ${path.basename(filePath)}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (before.ino !== 0 && opened.ino !== before.ino) ||
      (before.dev !== 0 && opened.dev !== before.dev)
    ) {
      throw new Error(`Git metadata changed identity: ${path.basename(filePath)}`);
    }
    const value = fs.readFileSync(fd, "utf-8");
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.nlink !== 1 ||
      (opened.ino !== 0 && after.ino !== opened.ino) ||
      (opened.dev !== 0 && after.dev !== opened.dev)
    ) {
      throw new Error(`Git metadata changed while reading: ${path.basename(filePath)}`);
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function readTrustedBinaryFile(filePath: string, maxBytes: number): Buffer {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`Git object has an untrusted identity: ${path.basename(filePath)}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (before.ino !== 0 && opened.ino !== before.ino) ||
      (before.dev !== 0 && opened.dev !== before.dev)
    ) {
      throw new Error(`Git object changed identity: ${path.basename(filePath)}`);
    }
    const value = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.nlink !== 1 ||
      (opened.ino !== 0 && after.ino !== opened.ino) ||
      (opened.dev !== 0 && after.dev !== opened.dev)
    ) {
      throw new Error(`Git object changed while reading: ${path.basename(filePath)}`);
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
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

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_PREP_DIRECTORY = "/workspace/.quack/prep";
const CONTAINER_ADMISSION_DIRECTORY = "/workspace/.quack/decomposition-admissions";
export const TRUSTED_MANAGED_DOCKER_IMAGES_ENV = "QUACK_TRUSTED_MANAGED_DOCKER_IMAGES";
const PROTECTED_CONTAINER_MOUNTS = [
  CONTAINER_WORKSPACE,
  CONTAINER_PREP_DIRECTORY,
  CONTAINER_ADMISSION_DIRECTORY,
] as const;

interface ValidatedConfiguredVolume {
  argument: string;
}

function loadTrustedManagedDockerImages(): ReadonlySet<string> {
  const raw = process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
  if (!raw) return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${TRUSTED_MANAGED_DOCKER_IMAGES_ENV} must be a JSON array of immutable Docker image references.`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(
      `${TRUSTED_MANAGED_DOCKER_IMAGES_ENV} must be a JSON array of immutable Docker image references.`,
    );
  }
  return new Set(parsed);
}

function isImmutableDockerImageReference(image: string): boolean {
  return /^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image);
}

function isManagedDockerOperatorEnvironmentName(name: string): boolean {
  return name.toUpperCase() === TRUSTED_MANAGED_DOCKER_IMAGES_ENV;
}

/**
 * Managed Docker admission mounts a one-use dispatch capability before the
 * Quack child can consume it. Therefore the image itself is an explicit
 * operator trust boundary: a malicious allowlisted image can inspect that
 * capability and any credentials intentionally passed to the container.
 */
export function assertTrustedManagedDockerImage(
  image: string,
  trustedImages: ReadonlySet<string> = loadTrustedManagedDockerImages(),
): void {
  if (!isImmutableDockerImageReference(image)) {
    throw new Error("Managed Docker dispatch requires an immutable sha256 digest-pinned image.");
  }
  if (!trustedImages.has(image)) {
    throw new Error(
      `Managed Docker image is not present in the operator-owned ${TRUSTED_MANAGED_DOCKER_IMAGES_ENV} allowlist: ${image}`,
    );
  }
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function pathsOverlap(root: string, candidate: string): boolean {
  return isPathContainedBy(root, candidate) || isPathContainedBy(candidate, root);
}

function isPosixPathContainedBy(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return (
    relative === "" ||
    (!path.posix.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"))
  );
}

function posixPathsOverlap(left: string, right: string): boolean {
  return isPosixPathContainedBy(left, right) || isPosixPathContainedBy(right, left);
}

function dockerConfirmedContainerAbsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bno such container\b/i.test(message);
}

function validateConfiguredBindSource(projectRoot: string, source: string): string {
  if (!path.isAbsolute(source)) {
    throw new Error("Docker configured volume source must be an absolute host path.");
  }

  const resolvedRoot = path.resolve(projectRoot);
  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedRoot) || !fs.existsSync(resolvedSource)) {
    throw new Error("Docker configured volume source and project root must already exist.");
  }
  if (!isPathContainedBy(resolvedRoot, resolvedSource)) {
    throw new Error("Docker configured volume source must stay inside the project root.");
  }
  const privateRuntimeRoot = path.resolve(resolvedRoot, ".quack");
  if (pathsOverlap(resolvedSource, privateRuntimeRoot)) {
    throw new Error(
      "Docker configured volume source must not expose the project root or private .quack runtime state.",
    );
  }

  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Docker project root must be a real directory for configured volumes.");
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  let cursor = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedSource);
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Docker configured volume source traverses a symbolic link: ${cursor}`);
    }
    if (cursor !== resolvedSource && !stat.isDirectory()) {
      throw new Error(`Docker configured volume source has a non-directory component: ${cursor}`);
    }
  }

  const sourceStat = fs.lstatSync(resolvedSource);
  if (
    (!sourceStat.isDirectory() && !sourceStat.isFile()) ||
    sourceStat.isSymbolicLink() ||
    (sourceStat.isFile() && sourceStat.nlink !== 1)
  ) {
    throw new Error(
      "Docker configured volume source must be a real directory or single-link file.",
    );
  }
  const realSource = fs.realpathSync(resolvedSource);
  if (!isPathContainedBy(realRoot, realSource)) {
    throw new Error("Docker configured volume source escapes the real project root.");
  }
  return realSource;
}

function validatePrepMountSource(projectRoot: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPrep = path.resolve(resolvePrepStorageDirSync(projectRoot));
  const allowed = [
    path.resolve(resolvedRoot, ".quack", "prep"),
    path.resolve(resolvedRoot, ".quack", "runtime-prep"),
  ];
  if (!allowed.some((candidate) => candidate === resolvedPrep)) {
    throw new Error("Docker prep storage must resolve to a project-local .quack prep directory.");
  }
  const admissionRoot = path.resolve(resolvedRoot, ".quack", "decomposition-admissions");
  if (pathsOverlap(resolvedPrep, admissionRoot)) {
    throw new Error("Docker prep storage overlaps the private admission marker directory.");
  }
  if (!fs.existsSync(resolvedRoot)) return resolvedPrep;
  ensureSafeDockerDirectoryWithin(resolvedRoot, resolvedPrep, resolvedPrep, "Docker prep storage");
  const realRoot = fs.realpathSync(resolvedRoot);
  const realPrep = fs.realpathSync(resolvedPrep);
  if (!isPathContainedBy(realRoot, realPrep)) {
    throw new Error("Docker prep storage escapes the real project root.");
  }
  return realPrep;
}

function validateConfiguredVolume(projectRoot: string, volume: string): ValidatedConfiguredVolume {
  if (volume.trim() !== volume || /[\0\r\n]/.test(volume)) {
    throw new Error("Docker configured volume has unsafe whitespace or control characters.");
  }

  // Parse from the container destination so a Windows drive colon remains
  // part of the host source (for example C:\\repo\\cache:/cache:ro).
  const match = /^(.+):(\/[^:]*)(?::([^:]+))?$/.exec(volume);
  if (!match) {
    throw new Error(
      "Docker configured volumes must use absolute-host-path:absolute-container-path:ro.",
    );
  }
  const [, source, rawDestination, rawOptions] = match;
  const destination = path.posix.normalize(rawDestination);
  const canonicalRawDestination =
    rawDestination.length > 1 ? rawDestination.replace(/\/$/, "") : rawDestination;
  if (
    !path.posix.isAbsolute(rawDestination) ||
    destination !== canonicalRawDestination ||
    rawDestination.includes("\\")
  ) {
    throw new Error(
      "Docker configured volume destination must be a canonical absolute POSIX path.",
    );
  }
  if (
    PROTECTED_CONTAINER_MOUNTS.some((protectedPath) =>
      posixPathsOverlap(protectedPath, destination),
    )
  ) {
    throw new Error(
      `Docker configured volume destination overlaps a protected mount: ${destination}`,
    );
  }

  const options = rawOptions?.split(",") ?? [];
  if (options.length !== 1 || options[0] !== "ro") {
    throw new Error(
      "Docker configured bind volumes must use exactly the non-mutating 'ro' option.",
    );
  }

  const realSource = validateConfiguredBindSource(projectRoot, source);
  return {
    argument: `${realSource.replace(/\\/g, "/")}:${destination}:${options.join(",")}`,
  };
}

function ensureSafeDockerDirectoryWithin(
  projectRoot: string,
  directory: string,
  allowedRoot: string,
  label: string,
): void {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedAllowedRoot = path.resolve(allowedRoot);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedAllowedRoot, resolvedDirectory);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay within its dedicated runtime tree.`);
  }

  // Unit callers may build arguments for a synthetic root. A real dispatch
  // always has an existing project root; validate and create each runtime
  // component there without following a repository-controlled redirect.
  if (!fs.existsSync(resolvedRoot)) return;
  const realRoot = fs.realpathSync(resolvedRoot);
  const allowedRelative = path.relative(resolvedRoot, resolvedAllowedRoot);
  if (
    path.isAbsolute(allowedRelative) ||
    allowedRelative === ".." ||
    allowedRelative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside the project root.`);
  }
  let cursor = resolvedRoot;
  const components = [
    ...(allowedRelative === "" ? [] : allowedRelative.split(path.sep)),
    ...(relative === "" ? [] : relative.split(path.sep)),
  ];
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      fs.mkdirSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} component is not a regular directory: ${cursor}`);
    }
    const realCursor = fs.realpathSync(cursor);
    if (!isPathContainedBy(realRoot, realCursor)) {
      throw new Error(`${label} escapes the real project root: ${cursor}`);
    }
  }
}

function ensureSafeDockerRuntimeDirectory(projectRoot: string, directory: string): void {
  ensureSafeDockerDirectoryWithin(
    projectRoot,
    directory,
    path.resolve(projectRoot, ".quack", "logs"),
    "Docker logging directory",
  );
}

function assertSafeWritableLogTree(projectRoot: string, logsDirectory: string): void {
  if (!fs.existsSync(projectRoot) || !fs.existsSync(logsDirectory)) return;
  const realRoot = fs.realpathSync(projectRoot);
  const pending = [logsDirectory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        throw new Error(`Docker writable log tree contains a symbolic link: ${entry}`);
      }
      if (stat.isDirectory()) {
        const realEntry = fs.realpathSync(entry);
        if (!isPathContainedBy(realRoot, realEntry)) {
          throw new Error(`Docker writable log tree escapes the real project root: ${entry}`);
        }
        pending.push(entry);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(
          `Docker writable log tree contains a non-regular or hard-linked file: ${entry}`,
        );
      }
    }
  }
}

function assertLogsDoNotOverlapProtectedRuntimeDirectories(
  projectRoot: string,
  logsDirectory: string,
): void {
  const resolvedPrep = path.resolve(resolvePrepStorageDirSync(projectRoot));
  const protectedDirectories = [
    path.resolve(projectRoot, ".quack", "prep"),
    path.resolve(projectRoot, ".quack", "runtime-prep"),
    resolvedPrep,
    path.resolve(projectRoot, ".quack", "decomposition-admissions"),
  ];
  const conflict = protectedDirectories.find((directory) => pathsOverlap(directory, logsDirectory));
  if (conflict) {
    throw new Error(`Docker logging directory overlaps a protected runtime directory: ${conflict}`);
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
  /** Container-private gitdir inside the disposable task worktree. */
  gitDir: string;
  /** Host path for the container-private gitdir. Never authoritative. */
  privateGitDir?: string;
  /** Read-only authoritative object store used only as a Git alternate. */
  gitObjectsDir?: string;
  /** Read-only .git overlay hiding the authoritative worktree pointer. */
  dotGitOverlay?: string;
  /** Exact authoritative ref/head captured before the untrusted run. */
  authoritativeRef?: string;
  authoritativeHead?: string;
  /** Exact authoritative linked-worktree admin directory hidden from Docker. */
  authoritativeWorktreeGitDir?: string;
  /** Host-assigned event identity; repository configuration cannot replace it. */
  eventSessionId?: string;
  /** Exact sealed archive lineage used to seed this execution attempt. */
  resumeSource?: DockerResumeSourceBinding;
  parentTaskId?: string;
  sharedBranchName?: string;
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

interface ValidatedPrivateGitObject {
  objectId: string;
  source: string;
  compressedDigest: string;
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

interface PrivateGitLayout {
  hostGitRoot: string;
  hostObjectsDir: string;
  hostPrivateGitDir: string;
  containerGitDir: string;
  dotGitOverlay: string;
  authoritativeRef: string;
  authoritativeHead: string;
  authoritativeWorktreeGitDir: string;
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
  private readonly dockerExecutable: string;
  private readonly dockerEnvironment: NodeJS.ProcessEnv;
  private readonly logsDirectory: string;
  private readonly containerLogsDirectory: string;
  private readonly admissionScopes = new Map<string, string>();
  private readonly trustedManagedDockerImages: ReadonlySet<string>;

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
    const defaultLogDir = path.resolve(projectRoot, ".quack", "logs");
    const resolvedThird = stateRoot ? path.resolve(stateRoot) : undefined;
    // The pre-reliability constructor used its third argument as logging.dir.
    // Preserve that source-compatible form only for paths inside .quack/logs;
    // all other third arguments are durable Docker ownership state roots.
    const legacyLogDir =
      options.logDir === undefined &&
      resolvedThird !== undefined &&
      isSameOrDescendant(resolvedThird, defaultLogDir) &&
      path.basename(resolvedThird) !== "docker-create-uncertainty"
        ? resolvedThird
        : undefined;
    this.uncertaintyDir =
      legacyLogDir !== undefined
        ? path.join(legacyLogDir, "docker-create-uncertainty")
        : (resolvedThird ?? path.join(defaultLogDir, "docker-create-uncertainty"));
    this.retentionDir = path.join(this.uncertaintyDir, "retained");
    this.hostLogDir = path.resolve(options.logDir ?? legacyLogDir ?? defaultLogDir);
    this.trustedManagedDockerImages = loadTrustedManagedDockerImages();
    this.dockerExecutable = resolveTrustedDockerExecutable([projectRoot, process.cwd()]);
    this.dockerEnvironment = trustedDockerEnvironment(this.dockerExecutable);
    this.logsDirectory = this.hostLogDir;
    assertLogsDoNotOverlapProtectedRuntimeDirectories(projectRoot, this.logsDirectory);
    ensureSafeDockerRuntimeDirectory(projectRoot, this.logsDirectory);
    assertSafeWritableLogTree(projectRoot, this.logsDirectory);
    const relativeLogsDirectory = path.relative(path.resolve(projectRoot), this.logsDirectory);
    this.containerLogsDirectory = path.posix.join(
      CONTAINER_WORKSPACE,
      relativeLogsDirectory.replace(/\\/g, "/"),
    );
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
    this.validateMountConfiguration();
    this.assertSafeLogDir();
    this.assertSafeConfiguredVolumes();
    this.refreshCreateUncertainty();
    this.refreshRetentionMarkers();
  }

  /** Validate the current adapter image before publishing a managed admission. */
  assertManagedAdmissionImageTrusted(): void {
    assertTrustedManagedDockerImage(this.config.image, this.trustedManagedDockerImages);
  }

  /** Translate a trusted host runtime entry point to its read-only container mount. */
  containerPathForHost(hostPath: string): string {
    const resolved = resolveThroughExistingAncestor(path.resolve(hostPath));
    if (this.runtimeRoot && isSameOrDescendant(resolved, this.runtimeRoot)) {
      const relative = path.relative(this.runtimeRoot, resolved);
      return path.posix.join("/quack-runtime", relative.replace(/\\/g, "/"));
    }
    const realProjectRoot = resolveThroughExistingAncestor(this.projectRoot);
    if (isSameOrDescendant(resolved, realProjectRoot)) {
      const relative = path.relative(realProjectRoot, resolved);
      return path.posix.join(CONTAINER_WORKSPACE, relative.replace(/\\/g, "/"));
    }
    throw new Error("Quack runtime entry point is outside trusted Docker runtime mounts");
  }

  private assertSafeLogDir(): void {
    const resolvedRoot = path.resolve(this.projectRoot);
    const dedicatedLogDir = path.join(resolvedRoot, ".quack", "logs");
    const canonicalPrep = path.join(resolvedRoot, ".quack", "prep");
    const protectedPrep = path.resolve(resolvePrepStorageDirSync(resolvedRoot));
    if (!isSameOrDescendant(this.hostLogDir, dedicatedLogDir)) {
      throw new Error("Docker logging.dir must remain inside the dedicated .quack/logs directory");
    }
    if (
      isSameOrDescendant(this.hostLogDir, canonicalPrep) ||
      isSameOrDescendant(this.hostLogDir, protectedPrep)
    ) {
      throw new Error("Docker logging.dir must not overlap the protected .quack/prep tree");
    }

    this.assertNoPathAliases(resolvedRoot, this.hostLogDir, "Docker logging.dir");
    const realRoot = resolveThroughExistingAncestor(resolvedRoot);
    const realLogDir = resolveThroughExistingAncestor(this.hostLogDir);
    const realDedicatedLogDir = resolveThroughExistingAncestor(dedicatedLogDir);
    if (
      !isSameOrDescendant(realLogDir, realRoot) ||
      !isSameOrDescendant(realLogDir, realDedicatedLogDir)
    ) {
      throw new Error("Docker logging.dir resolves outside the dedicated .quack/logs directory");
    }
    if (fs.existsSync(this.hostLogDir)) {
      const stat = fs.lstatSync(this.hostLogDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Docker logging.dir is not a regular directory");
      }
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

    const inputRelative = path.posix.relative("/quack-inputs", destination);
    if (
      !inputRelative ||
      path.posix.isAbsolute(inputRelative) ||
      inputRelative === ".." ||
      inputRelative.startsWith("../")
    ) {
      throw new Error(
        `Docker volume destination ${destination} must be inside the inert /quack-inputs namespace`,
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
    if (worktreePath) this.assertReadOnlyBindTreeSafe(mountSource, realRoot);
    return {
      destination,
      argument: `${realSource.replace(/\\/g, "/")}:${destination}:${options}`,
    };
  }

  private assertSafeConfiguredVolumes(worktreePath?: string): void {
    for (const volume of this.config.volumes ?? []) this.safeConfiguredVolume(volume, worktreePath);
  }

  private projectGitOutput(args: string[]): string {
    return runTrustedGitSync(args, this.projectRoot, {
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  }

  private readSafeCoreGitConfig(
    key: "core.autocrlf" | "core.eol" | "core.safecrlf",
    allowed: readonly string[],
  ): string | undefined {
    try {
      const value = this.projectGitOutput(["config", "--get", key]).toLowerCase();
      return allowed.includes(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private assertSealedResumeRef(binding: DockerResumeSourceBinding): void {
    const current = this.projectGitOutput(["rev-parse", "--verify", binding.gitState.sealedRef]);
    if (current !== binding.gitState.candidateHead) {
      throw new Error("Docker sealed recovery ref changed before resume");
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
      if (entries > 100_000)
        throw new Error("Docker bind source exceeds the safe validation limit");
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    }
  }

  private assertNoPathAliases(root: string, candidate: string, description: string): void {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!isSameOrDescendant(resolvedCandidate, resolvedRoot)) {
      throw new Error(`${description} is outside its trusted root`);
    }
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    let cursor = resolvedRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error: unknown) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`${description} contains an untrusted symlink or junction: ${cursor}`);
      }
    }
  }

  private resolveLooseRef(hostGitRoot: string, refName: string): string {
    if (!refName.startsWith("refs/heads/") || !isSafeGitRef(refName)) {
      throw new Error("Docker dispatch worktree HEAD is not a safe local branch ref");
    }
    const loosePath = path.join(hostGitRoot, ...refName.split("/"));
    if (fs.existsSync(loosePath)) {
      const stat = fs.lstatSync(loosePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("Docker dispatch branch ref has an untrusted identity");
      }
      const value = fs.readFileSync(loosePath, "utf-8").trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value;
    }
    const packedRefs = path.join(hostGitRoot, "packed-refs");
    if (fs.existsSync(packedRefs)) {
      const stat = fs.lstatSync(packedRefs);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("Docker dispatch packed refs have an untrusted identity");
      }
      for (const line of fs.readFileSync(packedRefs, "utf-8").split(/\r?\n/)) {
        const match = /^([a-f0-9]{40,64})\s+(.+)$/.exec(line);
        if (match?.[2] === refName) return match[1];
      }
    }
    throw new Error(`Docker dispatch could not resolve authoritative branch ${refName}`);
  }

  private resolveAuthoritativeGitRoot(): string {
    const projectGitPath = path.join(this.projectRoot, ".git");
    const projectGitStat = fs.lstatSync(projectGitPath);
    if (projectGitStat.isDirectory() && !projectGitStat.isSymbolicLink()) {
      return fs.realpathSync.native(projectGitPath);
    }
    if (projectGitStat.isFile() && !projectGitStat.isSymbolicLink()) {
      const projectGitFile = readTrustedTextFile(projectGitPath, 4_096).trim();
      const projectGitMatch = /^gitdir:\s*(.+)$/i.exec(projectGitFile);
      if (!projectGitMatch) throw new Error("Project .git file has an invalid worktree target");
      const projectAdminDir = fs.realpathSync.native(
        path.resolve(this.projectRoot, projectGitMatch[1].trim()),
      );
      const commonDirFile = path.join(projectAdminDir, "commondir");
      return fs.realpathSync.native(
        fs.existsSync(commonDirFile)
          ? path.resolve(projectAdminDir, readTrustedTextFile(commonDirFile, 4_096).trim())
          : projectAdminDir,
      );
    }
    throw new Error("Project Git metadata has an untrusted identity");
  }

  private preparePrivateGit(
    worktreePath: string,
    token: string,
    authoritativeRefOverride?: string,
    authoritativeHeadOverride?: string,
    privateHeadOverride?: string,
  ): PrivateGitLayout {
    const hostGitRoot = this.resolveAuthoritativeGitRoot();
    const dotGitPath = path.join(worktreePath, ".git");
    const dotGit = fs.readFileSync(dotGitPath, "utf-8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
    if (!match) throw new Error("Docker dispatch requires a linked Git worktree");
    const worktreeGitDir = fs.realpathSync.native(path.resolve(worktreePath, match[1].trim()));
    const worktreeAdminRoot = path.join(hostGitRoot, "worktrees");
    if (!isSameOrDescendant(worktreeGitDir, worktreeAdminRoot)) {
      throw new Error("Docker worktree git metadata resolves outside the authoritative repository");
    }
    let authoritativeRef: string;
    let authoritativeHead: string;
    if (authoritativeRefOverride) {
      const normalized = authoritativeRefOverride.startsWith("refs/heads/")
        ? authoritativeRefOverride
        : `refs/heads/${authoritativeRefOverride}`;
      if (!isSafeGitRef(normalized) || !normalized.startsWith("refs/heads/")) {
        throw new Error("Docker dispatch received an invalid admitted task branch");
      }
      authoritativeRef = normalized;
      authoritativeHead = this.resolveLooseRef(hostGitRoot, authoritativeRef);
      if (
        authoritativeHeadOverride &&
        authoritativeHead.toLowerCase() !== authoritativeHeadOverride.toLowerCase()
      ) {
        throw new Error("Docker admitted task branch changed before private Git setup");
      }
    } else {
      const headPath = path.join(worktreeGitDir, "HEAD");
      const headStat = fs.lstatSync(headPath);
      if (!headStat.isFile() || headStat.isSymbolicLink() || headStat.nlink !== 1) {
        throw new Error("Docker worktree HEAD has an untrusted identity");
      }
      const headValue = fs.readFileSync(headPath, "utf-8").trim();
      const symbolic = /^ref:\s*(refs\/heads\/.+)$/.exec(headValue);
      authoritativeRef = symbolic?.[1] ?? "HEAD";
      authoritativeHead = symbolic ? this.resolveLooseRef(hostGitRoot, symbolic[1]) : headValue;
    }
    if (!/^[a-f0-9]{40,64}$/i.test(authoritativeHead)) {
      throw new Error("Docker worktree HEAD does not resolve to a commit object");
    }
    const privateHead = privateHeadOverride ?? authoritativeHead;
    if (
      !/^[a-f0-9]{40,64}$/i.test(privateHead) ||
      privateHead.length !== authoritativeHead.length
    ) {
      throw new Error("Docker resume private Git head is invalid");
    }

    const safeToken = token.replace(/[^A-Za-z0-9._-]/g, "_");
    const autoCrlf = this.readSafeCoreGitConfig("core.autocrlf", ["true", "false", "input"]);
    const coreEol = this.readSafeCoreGitConfig("core.eol", ["native", "lf", "crlf"]);
    const safeCrlf = this.readSafeCoreGitConfig("core.safecrlf", ["true", "false", "warn"]);
    const privateRoot = path.join(worktreePath, ".quack", "docker-git");
    fs.mkdirSync(privateRoot, { recursive: true });
    this.assertNoPathAliases(worktreePath, privateRoot, "Docker private Git root");
    const hostPrivateGitDir = path.join(privateRoot, safeToken);
    fs.mkdirSync(path.join(hostPrivateGitDir, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(hostPrivateGitDir, "objects", "pack"), { recursive: true });
    fs.mkdirSync(path.join(hostPrivateGitDir, "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(hostPrivateGitDir, "info"), { recursive: true });
    fs.writeFileSync(
      path.join(hostPrivateGitDir, "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = false",
        "\tbare = false",
        "\tlogallrefupdates = true",
        ...(autoCrlf ? [`\tautocrlf = ${autoCrlf}`] : []),
        ...(coreEol ? [`\teol = ${coreEol}`] : []),
        ...(safeCrlf ? [`\tsafecrlf = ${safeCrlf}`] : []),
        "[gc]",
        "\tauto = 0",
        "[safe]",
        "\tdirectory = /workspace",
        "[user]",
        "\tname = Quack Docker Worker",
        "\temail = quack-docker@localhost.invalid",
        "",
      ].join("\n"),
      { encoding: "utf-8", flag: "wx" },
    );
    const privateRef =
      authoritativeRef === "HEAD" ? `refs/heads/quack-private/${safeToken}` : authoritativeRef;
    const privateRefPath = path.join(hostPrivateGitDir, ...privateRef.split("/"));
    fs.mkdirSync(path.dirname(privateRefPath), { recursive: true });
    fs.writeFileSync(path.join(hostPrivateGitDir, "HEAD"), `ref: ${privateRef}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.writeFileSync(privateRefPath, `${privateHead}\n`, { encoding: "utf-8", flag: "wx" });
    fs.writeFileSync(
      path.join(hostPrivateGitDir, "objects", "info", "alternates"),
      "/quack-git-objects\n",
      { encoding: "utf-8", flag: "wx" },
    );
    fs.writeFileSync(
      path.join(hostPrivateGitDir, "info", "exclude"),
      ".quack/docker-git/\n.quack/docker-runtime/\n",
      { encoding: "utf-8", flag: "wx" },
    );

    const hostObjectsDir = fs.realpathSync.native(path.join(hostGitRoot, "objects"));
    this.runTrustedPrivateGit(
      hostPrivateGitDir,
      worktreePath,
      ["read-tree", privateHead],
      hostObjectsDir,
    );

    const containerGitDir = path.posix.join("/workspace/.quack/docker-git", safeToken);
    const overlayRoot = path.join(this.uncertaintyDir, "git-overlays");
    fs.mkdirSync(overlayRoot, { recursive: true });
    const dotGitOverlay = path.join(overlayRoot, `${safeToken}.git`);
    fs.writeFileSync(dotGitOverlay, `gitdir: ${containerGitDir}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    return {
      hostGitRoot,
      hostObjectsDir,
      hostPrivateGitDir,
      containerGitDir,
      dotGitOverlay,
      authoritativeRef,
      authoritativeHead,
      authoritativeWorktreeGitDir: worktreeGitDir,
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
      mounts.push({ source: realSource, destination: `/workspace/.quack/${fileName}` });
    }
    return mounts;
  }

  private validateMountConfiguration(): ValidatedConfiguredVolume[] {
    assertLogsDoNotOverlapProtectedRuntimeDirectories(this.projectRoot, this.logsDirectory);
    ensureSafeDockerRuntimeDirectory(this.projectRoot, this.logsDirectory);
    assertSafeWritableLogTree(this.projectRoot, this.logsDirectory);
    return (this.config.volumes ?? []).map((volume) =>
      validateConfiguredVolume(this.projectRoot, volume),
    );
  }

  private uncertaintyPath(containerName: string): string {
    return path.join(this.uncertaintyDir, `${containerName.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private createRuntimeLogDir(
    taskId: string,
    worktreePath: string,
  ): { hostPath: string; containerPath: string } {
    const base = path.join(worktreePath, ".quack", "docker-runtime");
    const realWorktree = resolveThroughExistingAncestor(worktreePath);
    const prospectiveBase = resolveThroughExistingAncestor(base);
    if (!isSameOrDescendant(prospectiveBase, realWorktree)) {
      throw new Error("Docker dispatch log root resolves outside the task worktree");
    }
    fs.mkdirSync(base, { recursive: true });
    this.assertNoPathAliases(realWorktree, base, "Docker dispatch log root");
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
    return { hostPath: realRuntimeLogDir, containerPath: path.posix.join("/workspace", relative) };
  }

  private assertRuntimeLogDirSafe(runtimeLogDir: string, worktreePath: string): string {
    const realWorktree = resolveThroughExistingAncestor(worktreePath);
    this.assertNoPathAliases(realWorktree, runtimeLogDir, "Docker dispatch log directory");
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
        // Keep the original unconfirmed marker as durable fail-closed evidence.
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
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        const outcome = await this.removeContainerOnce(marker.containerName);
        if (outcome === "removed") {
          resolved = this.clearCreateUncertainty(marker);
          break;
        }
        if (outcome === "unconfirmed") break;
        if (Date.now() >= deadline) {
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

  /** Reconcile containers left by a previous monitor before new admission. */
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
      if (
        typeof taskId !== "string" ||
        !taskId ||
        (owner !== undefined && typeof owner !== "string")
      ) {
        ambiguousContainerIds.push(containerId);
        continue;
      }
      if (typeof owner === "string" && owner !== this.projectFingerprint) continue;
      const inspectedId = typeof record.Id === "string" ? record.Id : containerId;
      const inspectedName = typeof record.Name === "string" ? record.Name.replace(/^\//, "") : "";
      if (owner === undefined) {
        const workspaceSource = record.Mounts?.find(
          (mount) => mount.Destination === CONTAINER_WORKSPACE && typeof mount.Source === "string",
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
          workDir: CONTAINER_WORKSPACE,
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
        (mount) => mount.Destination === CONTAINER_WORKSPACE && typeof mount.Source === "string",
      )?.Source;
      const labeledRuntimeLog = labels?.["quack.runtimeLogPath"];
      const labeledGitDir = labels?.["quack.gitDir"];
      const runtimeLogRelative =
        typeof labeledRuntimeLog === "string" &&
        labeledRuntimeLog.startsWith("/workspace/.quack/docker-runtime/")
          ? path.posix.relative(CONTAINER_WORKSPACE, labeledRuntimeLog)
          : undefined;
      const runtimeLogSource =
        typeof workspaceSource === "string" && runtimeLogRelative
          ? path.resolve(workspaceSource, runtimeLogRelative)
          : undefined;
      const info: DockerContainer = {
        containerId: inspectedId || containerId,
        containerName: inspectedName || containerId,
        taskId,
        image: typeof record.Config?.Image === "string" ? record.Config.Image : this.config.image,
        workDir: CONTAINER_WORKSPACE,
        logsVolume:
          typeof labeledRuntimeLog === "string"
            ? labeledRuntimeLog
            : "/workspace/.quack/docker-runtime",
        worktreePath:
          typeof workspaceSource === "string" ? workspaceSource : path.resolve(this.projectRoot),
        runtimeLogDir: typeof runtimeLogSource === "string" ? runtimeLogSource : this.hostLogDir,
        gitDir:
          typeof labeledGitDir === "string" &&
          labeledGitDir.startsWith("/workspace/.quack/docker-git/")
            ? labeledGitDir
            : "/workspace/.quack/docker-git/unresolved",
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

    for (const [taskId, marker] of this.retainedContainers) {
      if (seenRetentionTasks.has(taskId)) continue;
      this.clearRetention(marker);
    }

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

  private execDocker(args: string[], timeout = 120_000) {
    return execFileAsync(this.dockerExecutable, args, {
      cwd: path.dirname(this.dockerExecutable),
      env: this.dockerEnvironment,
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
  }

  private async runDocker(
    args: string[],
    timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    const controller = new AbortController();
    this.pendingCommands.add(controller);
    try {
      const result = await execFileAsync(this.dockerExecutable, args, {
        cwd: path.dirname(this.dockerExecutable),
        env: this.dockerEnvironment,
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
      const { stdout } = await this.execDocker(["info", "--format", "{{.ServerVersion}}"], 30_000);
      return stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Docker is not available: ${msg}`);
    }
  }

  /**
   * Create and start a container for a task dispatch.
   * Mounts project root and prep state read-only. Runtime logs use a
   * container-private tmpfs so repository code never receives a writable
   * handle to the host's authoritative log or control tree.
   */
  async createContainer(
    taskId: string,
    worktreePath: string,
    options: {
      resumeStateDir?: string;
      eventSessionId?: string;
      authoritativeBranch?: string;
      authoritativeHead?: string;
      parentTaskId?: string;
      sharedBranchName?: string;
      admissionScopeDirectory?: string;
    } = {},
  ): Promise<DockerContainer> {
    this.assertSafeLogDir();
    if (Boolean(options.parentTaskId) !== Boolean(options.sharedBranchName)) {
      throw new Error(
        `Docker decomposition for ${taskId} requires paired parentTaskId and sharedBranchName`,
      );
    }

    let ownsAdmissionScope = false;
    try {
      if (options.admissionScopeDirectory) {
        const admissionScope = assertDecompositionDispatchAdmissionScope(
          this.projectRoot,
          options.admissionScopeDirectory,
        );
        if (this.admissionScopes.has(taskId)) {
          throw new Error(`A Docker admission scope remains unresolved for ${taskId}.`);
        }
        this.admissionScopes.set(taskId, admissionScope);
        ownsAdmissionScope = true;
        this.assertManagedAdmissionImageTrusted();
        if (this.config.preInstallCommand) {
          throw new Error(
            "Docker preInstallCommand is not allowed on a managed dispatch container before its one-use admission is consumed.",
          );
        }
      }

      this.validateMountConfiguration();

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
      const existing = this.containers.get(taskId);
      if (existing && existing.status !== "removed") {
        throw new Error(
          `Container cleanup is unresolved for ${taskId} (${existing.containerId}, ${existing.status})`,
        );
      }

      const containerName = `quack-${taskId}-${randomUUID()}`;
      const inspectedResumeSource = options.resumeStateDir
        ? inspectValidatedDockerResumeArchive(options.resumeStateDir, taskId)
        : undefined;
      const resumeSource: DockerResumeSourceBinding | undefined = inspectedResumeSource
        ? {
            archiveName: inspectedResumeSource.archiveName,
            dispatchSessionId: inspectedResumeSource.dispatchSessionId,
            eventSessionId: inspectedResumeSource.eventSessionId,
            ownershipId: inspectedResumeSource.ownershipId,
            approvedGate: inspectedResumeSource.approvedGate,
            gitState: inspectedResumeSource.gitState,
            ...(inspectedResumeSource.approvedDiffHash
              ? { approvedDiffHash: inspectedResumeSource.approvedDiffHash }
              : {}),
            ...(inspectedResumeSource.parentTaskId
              ? { parentTaskId: inspectedResumeSource.parentTaskId }
              : {}),
            ...(inspectedResumeSource.sharedBranchName
              ? { sharedBranchName: inspectedResumeSource.sharedBranchName }
              : {}),
          }
        : undefined;
      if (
        resumeSource &&
        (resumeSource.gitState.authoritativeRef !== `refs/heads/${options.authoritativeBranch}` ||
          resumeSource.gitState.baseHead.toLowerCase() !==
            options.authoritativeHead?.toLowerCase() ||
          resumeSource.parentTaskId !== options.parentTaskId ||
          resumeSource.sharedBranchName !== options.sharedBranchName)
      ) {
        throw new Error(`Docker resume archive for ${taskId} does not match the admitted Git ref`);
      }
      if (resumeSource) this.assertSealedResumeRef(resumeSource);
      const runtimeLog = this.createRuntimeLogDir(taskId, realWorktree);
      const gitMount = this.preparePrivateGit(
        realWorktree,
        containerName,
        options.authoritativeBranch,
        options.authoritativeHead,
        resumeSource?.gitState.candidateHead,
      );
      const runtimeLogDir = runtimeLog.hostPath;
      const info: DockerContainer = {
        containerId: containerName,
        containerName,
        taskId,
        image: this.config.image,
        workDir: CONTAINER_WORKSPACE,
        logsVolume: runtimeLog.containerPath,
        worktreePath: realWorktree,
        runtimeLogDir,
        gitDir: gitMount.containerGitDir,
        privateGitDir: gitMount.hostPrivateGitDir,
        gitObjectsDir: gitMount.hostObjectsDir,
        dotGitOverlay: gitMount.dotGitOverlay,
        authoritativeRef: gitMount.authoritativeRef,
        authoritativeHead: gitMount.authoritativeHead,
        authoritativeWorktreeGitDir: gitMount.authoritativeWorktreeGitDir,
        ...(options.eventSessionId ? { eventSessionId: options.eventSessionId } : {}),
        ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
        ...(options.sharedBranchName ? { sharedBranchName: options.sharedBranchName } : {}),
        startedAt: new Date().toISOString(),
        status: "creating",
      };
      if (resumeSource) info.resumeSource = resumeSource;
      if (resumeSource) {
        const dirty = this.runTrustedPrivateGit(
          gitMount.hostPrivateGitDir,
          realWorktree,
          ["status", "--porcelain", "--untracked-files=all"],
          gitMount.hostObjectsDir,
        );
        if (dirty) {
          throw new Error(
            `Docker resume worktree for ${taskId} no longer matches its sealed commit`,
          );
        }
      }
      this.containers.set(taskId, info);
      let uncertainty: DockerCreateUncertainty;
      try {
        uncertainty = this.persistCreateUncertainty(containerName, taskId);
      } catch (error: unknown) {
        this.containers.delete(taskId);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot create container for ${taskId}: durable create ownership could not be recorded (${detail})`,
        );
      }

      try {
        const admissionScope = options.admissionScopeDirectory
          ? assertDecompositionDispatchAdmissionScope(
              this.projectRoot,
              options.admissionScopeDirectory,
            )
          : undefined;
        const createArgs = this.buildCreateArgs(
          taskId,
          realWorktree,
          runtimeLogDir,
          runtimeLog.containerPath,
          gitMount.hostObjectsDir,
          gitMount.containerGitDir,
          gitMount.dotGitOverlay,
          containerName,
          admissionScope,
        );
        if (options.resumeStateDir) {
          if (!options.eventSessionId) {
            throw new Error(`Docker resume for ${taskId} has no host-assigned event session`);
          }
          const seeded = seedDockerResumeState(
            options.resumeStateDir,
            runtimeLogDir,
            taskId,
            options.eventSessionId,
          );
          if (JSON.stringify(seeded) !== JSON.stringify(info.resumeSource)) {
            throw new Error(`Docker resume archive for ${taskId} changed during container setup`);
          }
        }
        const { stdout } = await this.runDocker(createArgs);
        info.containerId = stdout.trim() || containerName;
        await this.runDocker(["start", info.containerId]);
        info.status = "running";
        if (this.config.preInstallCommand) {
          await this.runDocker(
            ["exec", info.containerId, "sh", "-c", this.config.preInstallCommand],
            DOCKER_SETUP_TIMEOUT_MS,
          );
        }
        if (!this.clearCreateUncertainty(uncertainty)) {
          throw new Error(`could not clear durable create ownership for ${containerName}`);
        }
        return info;
      } catch (error) {
        info.status = "stopped";
        let interrupted = uncertainty;
        try {
          interrupted = this.markCreateInterrupted(uncertainty) ?? uncertainty;
        } catch {
          // The original intent marker remains and keeps admission fail-closed.
        }
        const removed = await this.forceRemoveContainer(info.containerId).catch(() => false);
        if (removed) this.clearCreateUncertainty(interrupted);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create container for ${taskId}: ${detail}`);
      }
    } catch (error) {
      const tracked = this.containers.get(taskId);
      const cleanupProven = !tracked || tracked.status === "removed";
      if (ownsAdmissionScope && cleanupProven) {
        try {
          this.cleanupAdmissionScope(taskId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Docker admission failure and exact-scope revocation both failed for ${taskId}.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  /**
   * Execute a command inside the container. Returns the ChildProcess
   * for stdout/stderr streaming (same interface as worktree spawn).
   */
  execAgent(
    containerId: string,
    command: string[],
    env?: Record<string, string>,
    selected?: ReturnType<typeof selectClaudeApiKey>,
  ): ChildProcess {
    const args = ["exec"];

    const presence = inspectClaudeAuth(process.env, selected?.explicitPool === true);
    if (presence.error) throw new ClaudeAuthConfigurationError(presence.error);
    const admittedEnvironment: NodeJS.ProcessEnv = {};
    for (const name of this.config.envPassthrough) {
      if (!isManagedDockerOperatorEnvironmentName(name))
        admittedEnvironment[name] = process.env[name];
    }
    for (const [name, value] of Object.entries(env ?? {})) {
      if (!isManagedDockerOperatorEnvironmentName(name)) admittedEnvironment[name] = value;
    }
    if (
      !selected &&
      presence.mode !== "cli-managed" &&
      inspectClaudeAuth(admittedEnvironment).mode !== presence.mode
    ) {
      throw new ClaudeAuthConfigurationError(
        "The selected Claude credential family is not admitted by Docker envPassthrough. Configure the intended credential explicitly.",
      );
    }
    const effectiveEnvironment = buildClaudeChildEnvironment(admittedEnvironment, selected, true);
    // Clear the other credential family in the actual docker exec environment,
    // including keys inherited at container creation. Appending explicit child
    // values last prevents passthrough from replacing a rotated API credential.
    for (const name of [...Object.keys(process.env), ...this.config.envPassthrough]) {
      if (isClaudeCredentialEnvironmentName(name) && effectiveEnvironment[name] === undefined)
        effectiveEnvironment[name] = undefined;
    }
    for (const [name, value] of Object.entries(effectiveEnvironment)) {
      args.push("-e", `${name}=${value ?? ""}`);
    }

    // Trusted task-isolation values are appended last so repository-owned
    // passthrough configuration cannot replace them.
    const tracked = Array.from(this.containers.values()).find(
      (container) => container.containerId === containerId,
    );
    if (tracked) {
      args.push(
        "-e",
        `GIT_DIR=${tracked.gitDir}`,
        "-e",
        "GIT_WORK_TREE=/workspace",
        "-e",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES=/quack-git-objects",
        "-e",
        "GIT_CONFIG_NOSYSTEM=1",
        "-e",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "-e",
        "GIT_TERMINAL_PROMPT=0",
        "-e",
        "GIT_OPTIONAL_LOCKS=0",
        "-e",
        `QUACK_DOCKER_RUNTIME_LOG_DIR=${tracked.logsVolume}`,
        ...(tracked.eventSessionId
          ? ["-e", `QUACK_DOCKER_EVENT_SESSION_ID=${tracked.eventSessionId}`]
          : []),
        ...(tracked.authoritativeRef?.startsWith("refs/heads/")
          ? [
              "-e",
              `QUACK_DOCKER_ADMITTED_BRANCH=${tracked.authoritativeRef.slice("refs/heads/".length)}`,
            ]
          : []),
        ...(tracked.parentTaskId
          ? ["-e", `QUACK_DOCKER_PARENT_TASK_ID=${tracked.parentTaskId}`]
          : []),
        ...(tracked.sharedBranchName
          ? ["-e", `QUACK_DOCKER_SHARED_BRANCH=${tracked.sharedBranchName}`]
          : []),
        "-e",
        "QUACK_DOCKER_HOST_PROMOTION=1",
      );
    }

    args.push(containerId, ...command);

    return spawn(this.dockerExecutable, args, {
      cwd: path.dirname(this.dockerExecutable),
      env: this.dockerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
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

    if (stopConfirmed && container) container.status = "stopped";
    if (shouldRemove) {
      return { removed: await this.forceRemoveContainer(containerId), retained: false };
    }
    if (!retention || !stopConfirmed || !this.confirmRetentionStopped(retention)) {
      return { removed: false, retained: false };
    }
    if (container) {
      container.retentionConfirmed = true;
      this.cleanupAdmissionScope(container.taskId);
    }
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
      if (info.containerId === containerId || info.containerName === containerId) {
        info.status = "removed";
        this.containers.delete(taskId);
        this.cleanupAdmissionScope(taskId);
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
   * Run the fixed subset of Git needed to inspect or promote container-private
   * state. The caller cannot inject repository/worktree selectors, PATH is
   * host-resolved, and the sole optional object alternate must be the exact
   * authoritative object directory.
   */
  private runTrustedPrivateGit(
    gitDir: string,
    worktreePath: string,
    args: string[],
    alternates?: string,
  ): string {
    const allowedCommands = new Set([
      "diff",
      "log",
      "merge-base",
      "read-tree",
      "reset",
      "rev-list",
      "rev-parse",
      "status",
      "update-ref",
    ]);
    const command = args[0];
    if (
      !command ||
      !allowedCommands.has(command) ||
      args.some(
        (argument) =>
          argument.includes("\0") ||
          /[\r\n]/u.test(argument) ||
          argument === "-c" ||
          argument.startsWith("--git-dir") ||
          argument.startsWith("--work-tree") ||
          argument.startsWith("--exec"),
      )
    ) {
      throw new Error("Docker private Git invocation is outside the allowlisted operation set");
    }

    const canonicalProjectRoot = fs.realpathSync.native(this.projectRoot);
    const canonicalWorktree = fs.realpathSync.native(worktreePath);
    if (!isSameOrDescendant(canonicalWorktree, canonicalProjectRoot)) {
      throw new Error("Docker private Git worktree is outside the managed project");
    }
    const dotGit = readTrustedTextFile(path.join(canonicalWorktree, ".git"), 4_096).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
    if (!match) throw new Error("Docker private Git requires a linked worktree");
    const authoritativeGitDir = fs.realpathSync.native(
      path.resolve(canonicalWorktree, match[1].trim()),
    );
    const canonicalGitDir = fs.realpathSync.native(gitDir);
    const privateGitRoot = path.join(canonicalWorktree, ".quack", "docker-git");
    const authoritative = comparablePath(canonicalGitDir) === comparablePath(authoritativeGitDir);
    if (authoritative) {
      if (alternates) {
        throw new Error("Authoritative Git execution cannot read container-private alternates");
      }
      return runTrustedGitSync(args, canonicalWorktree, {
        timeoutMs: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        trustedBoundaryRoot: canonicalProjectRoot,
      }).trim();
    }
    const canonicalPrivateRoot = fs.realpathSync.native(privateGitRoot);
    if (
      !isSameOrDescendant(canonicalPrivateRoot, canonicalWorktree) ||
      !isSameOrDescendant(path.resolve(gitDir), privateGitRoot) ||
      !isSameOrDescendant(canonicalGitDir, canonicalPrivateRoot)
    ) {
      throw new Error("Docker private Git directory is outside its managed worktree");
    }

    const authoritativeGitRoot = this.resolveAuthoritativeGitRoot();
    let trustedAlternates: string | undefined;
    if (alternates) {
      trustedAlternates = fs.realpathSync.native(alternates);
      const authoritativeObjects = fs.realpathSync.native(
        path.join(authoritativeGitRoot, "objects"),
      );
      if (comparablePath(trustedAlternates) !== comparablePath(authoritativeObjects)) {
        throw new Error("Docker private Git alternate object directory is not host-authoritative");
      }
    }

    const gitExecutable = resolveTrustedExecutable(
      "git",
      canonicalProjectRoot,
      "Git",
      process.env,
      [
        canonicalProjectRoot,
        path.basename(authoritativeGitRoot).toLowerCase() === ".git"
          ? path.dirname(authoritativeGitRoot)
          : authoritativeGitRoot,
      ],
    );
    const environment = buildTrustedGitEnvironment(gitExecutable);
    if (trustedAlternates) {
      environment.GIT_ALTERNATE_OBJECT_DIRECTORIES = trustedAlternates;
    }
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    return String(
      execFileSync(
        gitExecutable,
        [
          "-c",
          `core.hooksPath=${nullDevice}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          `core.attributesFile=${nullDevice}`,
          "-c",
          `core.excludesFile=${nullDevice}`,
          "-c",
          "credential.helper=",
          "-c",
          "protocol.ext.allow=never",
          `--git-dir=${canonicalGitDir}`,
          `--work-tree=${canonicalWorktree}`,
          ...args,
        ],
        {
          cwd: path.dirname(gitExecutable),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...environment,
            GIT_NO_REPLACE_OBJECTS: "1",
          },
          windowsHide: true,
          timeout: PRIVATE_GIT_COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_PRIVATE_GIT_REV_LIST_BYTES,
        },
      ),
    ).trim();
  }

  private readPrivateHead(container: DockerContainer): string {
    if (!container.privateGitDir || !container.authoritativeRef) {
      throw new Error("Docker result metadata is incomplete");
    }
    this.assertNoPathAliases(
      container.worktreePath,
      container.privateGitDir,
      "Docker private Git directory",
    );
    const headPath = path.join(container.privateGitDir, "HEAD");
    const head = readTrustedTextFile(headPath, 1_024).trim();
    const expected = `ref: ${container.authoritativeRef}`;
    if (head !== expected) {
      throw new Error("Docker private Git HEAD moved away from the admitted task branch");
    }
    const refPath = path.join(container.privateGitDir, ...container.authoritativeRef.split("/"));
    this.assertNoPathAliases(container.privateGitDir, refPath, "Docker private Git branch ref");
    const candidate = readTrustedTextFile(refPath, 1_024).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(candidate)) {
      throw new Error("Docker private Git result is not a valid commit id");
    }
    return candidate;
  }

  private validatePrivateObjectsForInspection(
    container: DockerContainer,
  ): Map<string, ValidatedPrivateGitObject> {
    if (!container.privateGitDir) {
      throw new Error("Docker result object metadata is incomplete");
    }
    const privateObjects = path.join(container.privateGitDir, "objects");
    this.assertNoPathAliases(
      container.privateGitDir,
      privateObjects,
      "Docker private Git object store",
    );
    const sourceRoot = fs.realpathSync.native(privateObjects);
    const validated = new Map<string, ValidatedPrivateGitObject>();
    let files = 0;
    let bytes = 0;
    let inflatedBytes = 0;
    for (const prefixEntry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!prefixEntry.isDirectory() || prefixEntry.isSymbolicLink()) {
        throw new Error(`Docker private Git object entry is not allowlisted: ${prefixEntry.name}`);
      }
      if (prefixEntry.name === "info") {
        const infoPath = path.join(sourceRoot, "info");
        this.assertNoPathAliases(sourceRoot, infoPath, "Docker private Git object info");
        const entries = fs.readdirSync(infoPath);
        if (entries.some((entry) => entry !== "alternates")) {
          throw new Error("Docker private Git object info contains an untrusted entry");
        }
        continue;
      }
      if (prefixEntry.name === "pack") {
        const packPath = path.join(sourceRoot, "pack");
        this.assertNoPathAliases(sourceRoot, packPath, "Docker private Git pack directory");
        if (fs.readdirSync(packPath).length > 0) {
          throw new Error("Docker private Git packed objects are not accepted for promotion");
        }
        continue;
      }
      if (!/^[a-f0-9]{2}$/i.test(prefixEntry.name)) {
        throw new Error(`Docker private Git object entry is not allowlisted: ${prefixEntry.name}`);
      }
      const prefixPath = path.join(sourceRoot, prefixEntry.name);
      for (const objectEntry of fs.readdirSync(prefixPath, { withFileTypes: true })) {
        if (
          !objectEntry.isFile() ||
          objectEntry.isSymbolicLink() ||
          !/^[a-f0-9]{38,62}$/i.test(objectEntry.name)
        ) {
          throw new Error("Docker private Git contains an invalid loose object path");
        }
        const objectId = `${prefixEntry.name}${objectEntry.name}`.toLowerCase();
        const source = path.join(prefixPath, objectEntry.name);
        const stat = fs.lstatSync(source);
        files += 1;
        bytes += stat.size;
        if (
          stat.nlink !== 1 ||
          files > MAX_PRIVATE_GIT_OBJECT_FILES ||
          bytes > MAX_PRIVATE_GIT_COMPRESSED_BYTES
        ) {
          throw new Error("Docker private Git object import exceeds its safety boundary");
        }
        const compressed = Buffer.from(readTrustedBinaryFile(source, MAX_PRIVATE_GIT_OBJECT_BYTES));
        const inflated = inflateSync(compressed, { maxOutputLength: MAX_PRIVATE_GIT_OBJECT_BYTES });
        inflatedBytes += inflated.length;
        if (inflatedBytes > MAX_PRIVATE_GIT_INFLATED_BYTES) {
          throw new Error("Docker private Git decompression exceeds its aggregate safety boundary");
        }
        const nul = inflated.indexOf(0);
        if (nul <= 0) throw new Error("Docker private Git contains a malformed object");
        const header = inflated.subarray(0, nul).toString("ascii");
        const headerMatch = /^(blob|tree|commit|tag) ([0-9]+)$/.exec(header);
        if (!headerMatch || Number(headerMatch[2]) !== inflated.length - nul - 1) {
          throw new Error("Docker private Git contains a malformed object header");
        }
        const algorithm = objectId.length === 64 ? "sha256" : "sha1";
        if (createHash(algorithm).update(inflated).digest("hex") !== objectId) {
          throw new Error("Docker private Git object content does not match its object id");
        }
        if (validated.has(objectId)) {
          throw new Error("Docker private Git contains duplicate loose-object identities");
        }
        validated.set(objectId, {
          objectId,
          source,
          compressedDigest: createHash("sha256").update(compressed).digest("hex"),
        });
      }
    }
    return validated;
  }

  private copyReachablePrivateObjects(
    container: DockerContainer,
    candidateHead: string,
    validated: ReadonlyMap<string, ValidatedPrivateGitObject>,
  ): void {
    if (!container.privateGitDir || !container.gitObjectsDir || !container.authoritativeHead) {
      throw new Error("Docker result object metadata is incomplete");
    }
    const reachableOutput = this.runTrustedPrivateGit(
      container.privateGitDir,
      container.worktreePath,
      [
        "rev-list",
        "--objects",
        "--no-object-names",
        candidateHead,
        "--not",
        container.authoritativeHead,
      ],
      container.gitObjectsDir,
    );
    const reachableObjects = new Set(
      reachableOutput
        .split(/\r?\n/u)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (
      reachableObjects.size > MAX_PRIVATE_GIT_OBJECT_FILES ||
      [...reachableObjects].some((value) => !/^[a-f0-9]{40,64}$/u.test(value))
    ) {
      throw new Error("Docker private Git reachable object set exceeds its safety boundary");
    }
    const targetRoot = fs.realpathSync.native(container.gitObjectsDir);
    for (const object of validated.values()) {
      if (!reachableObjects.has(object.objectId)) continue;
      const compressed = Buffer.from(
        readTrustedBinaryFile(object.source, MAX_PRIVATE_GIT_OBJECT_BYTES),
      );
      if (createHash("sha256").update(compressed).digest("hex") !== object.compressedDigest) {
        throw new Error("Docker private Git object changed after bounded validation");
      }
      const destinationDir = path.join(targetRoot, object.objectId.slice(0, 2));
      const destination = path.join(destinationDir, object.objectId.slice(2));
      fs.mkdirSync(destinationDir, { recursive: true });
      if (!fs.existsSync(destination)) {
        try {
          fs.writeFileSync(destination, compressed, { flag: "wx" });
        } catch (error: unknown) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "";
          if (code !== "EEXIST") throw error;
        }
      }
    }
  }

  private assertPrivateGitTreeSafe(privateGitDir: string): void {
    this.assertNoPathAliases(privateGitDir, privateGitDir, "Docker private Git directory");
    const rootStat = fs.lstatSync(privateGitDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Docker private Git directory has an untrusted identity");
    }
    const pending = [privateGitDir];
    let entries = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        entries += 1;
        if (entries > 200_000) {
          throw new Error("Docker private Git directory exceeds the safe validation limit");
        }
        const candidate = path.join(current, entry.name);
        const relative = path.relative(privateGitDir, candidate).replace(/\\/gu, "/").toLowerCase();
        if (
          relative === "commondir" ||
          relative === "gitdir" ||
          relative === "packed-refs" ||
          relative === "shallow" ||
          relative === "shallow.lock" ||
          relative === "info/grafts" ||
          relative === "info/grafts.lock" ||
          relative === "refs/replace" ||
          relative.startsWith("refs/replace/")
        ) {
          throw new Error(`Docker private Git contains graph-rewriting metadata: ${relative}`);
        }
        const stat = fs.lstatSync(candidate);
        if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
          throw new Error(`Docker private Git contains an untrusted symlink: ${entry.name}`);
        }
        if (entry.isDirectory() && stat.isDirectory()) {
          pending.push(candidate);
        } else if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1) {
          throw new Error(`Docker private Git contains an untrusted entry: ${entry.name}`);
        }
      }
    }
  }

  private preparePrivateGitForInspection(container: DockerContainer): {
    candidateHead: string;
    privateObjects: string;
  } {
    if (!container.privateGitDir || !container.gitObjectsDir) {
      throw new Error("Docker result object metadata is incomplete");
    }
    this.assertPrivateGitTreeSafe(container.privateGitDir);
    const privateConfig = path.join(container.privateGitDir, "config");
    const autoCrlf = this.readSafeCoreGitConfig("core.autocrlf", ["true", "false", "input"]);
    const coreEol = this.readSafeCoreGitConfig("core.eol", ["native", "lf", "crlf"]);
    const safeCrlf = this.readSafeCoreGitConfig("core.safecrlf", ["true", "false", "warn"]);
    fs.rmSync(privateConfig, { force: true });
    fs.writeFileSync(
      privateConfig,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = false",
        "\tbare = false",
        ...(autoCrlf ? [`\tautocrlf = ${autoCrlf}`] : []),
        ...(coreEol ? [`\teol = ${coreEol}`] : []),
        ...(safeCrlf ? [`\tsafecrlf = ${safeCrlf}`] : []),
        "[gc]",
        "\tauto = 0",
        "",
      ].join("\n"),
      { encoding: "utf-8", flag: "wx" },
    );
    fs.rmSync(path.join(container.privateGitDir, "objects", "info", "alternates"), {
      force: true,
    });
    return {
      candidateHead: this.readPrivateHead(container),
      privateObjects: path.join(container.privateGitDir, "objects"),
    };
  }

  private assertAuthoritativeRefUnchanged(container: DockerContainer): void {
    if (
      !container.authoritativeWorktreeGitDir ||
      !container.authoritativeHead ||
      !container.authoritativeRef
    ) {
      throw new Error("Docker result metadata is incomplete");
    }
    const currentHead = this.runTrustedPrivateGit(
      container.authoritativeWorktreeGitDir,
      container.worktreePath,
      ["rev-parse", container.authoritativeRef],
    );
    if (currentHead !== container.authoritativeHead) {
      throw new Error("Authoritative task branch changed during Docker dispatch");
    }
  }

  private assertPrivateWorktreeClean(
    container: DockerContainer,
    candidateHead: string,
    purpose: "resume" | "pause" | "publication",
  ): void {
    if (!container.privateGitDir || !container.gitObjectsDir || !container.authoritativeHead) {
      throw new Error("Docker result metadata is incomplete");
    }
    // Policy names stay protected even when the file did not exist when the
    // container was created. Otherwise an untrusted run could create a new
    // verifier/conventions file and smuggle executable policy into the branch
    // that the trusted host later publishes.
    const protectedFiles = [
      ".quack/adapter.json",
      ".quack/conventions.md",
      ".quack/judge-criteria.md",
      ".quack/verify.js",
    ];
    for (const relativePath of protectedFiles) {
      const committedChange = this.runTrustedPrivateGit(
        container.privateGitDir,
        container.worktreePath,
        [
          "diff",
          "--name-only",
          "--no-ext-diff",
          container.authoritativeHead,
          candidateHead,
          "--",
          relativePath,
        ],
        container.gitObjectsDir,
      );
      if (committedChange) {
        throw new Error(`Docker ${purpose} changed protected policy ${relativePath}`);
      }
    }

    const porcelain = this.runTrustedPrivateGit(
      container.privateGitDir,
      container.worktreePath,
      ["status", "--porcelain", "--untracked-files=all"],
      container.gitObjectsDir,
    );
    const unsafe = porcelain
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        // The trusted runner trims the complete command output, which removes the
        // leading status-space from the first unstaged-only porcelain row.
        const pathOffset = line.length > 2 && line[2] === " " ? 3 : 2;
        const relativePath = line.slice(pathOffset).replace(/\\/g, "/");
        // These paths are overlaid read-only from host-owned sources while
        // Docker runs. Linux may refresh the private index against the
        // overlay's LF representation while the Windows worktree retains
        // CRLF. Their candidate blobs were compared above, so such working
        // tree-only differences cannot enter the promoted commit.
        return (
          !protectedFiles.includes(relativePath) &&
          relativePath !== ".quack/prep" &&
          !relativePath.startsWith(".quack/prep/")
        );
      });
    if (unsafe.length > 0) {
      throw new Error(
        `Docker ${purpose} has uncommitted files and cannot be accepted safely: ${unsafe
          .slice(0, 20)
          .join("\n")}`,
      );
    }
  }

  /**
   * Preserve one stopped private result for an approval resume without
   * publishing it. Objects are content-address verified, then a host-created
   * hidden ref prevents GC until the exact paused-run pointer is consumed.
   */
  sealPrivateGitForResume(container: DockerContainer, ownershipId: string): DockerResumeGitBinding {
    if (
      container.status === "creating" ||
      container.status === "running" ||
      !container.privateGitDir ||
      !container.gitObjectsDir ||
      !container.authoritativeHead ||
      !container.authoritativeRef ||
      !container.authoritativeWorktreeGitDir
    ) {
      throw new Error("Docker private Git cannot be sealed before container exit is confirmed");
    }
    if (!/^[0-9a-f-]{36}$/i.test(ownershipId)) {
      throw new Error("Docker private Git resume ownership is invalid");
    }
    const { candidateHead } = this.preparePrivateGitForInspection(container);
    // Validate every container-authored loose object in-process before Git is
    // allowed to parse any of them.
    const validatedObjects = this.validatePrivateObjectsForInspection(container);
    this.assertPrivateWorktreeClean(container, candidateHead, "pause");
    this.assertAuthoritativeRefUnchanged(container);
    this.runTrustedPrivateGit(
      container.privateGitDir,
      container.worktreePath,
      ["merge-base", "--is-ancestor", container.authoritativeHead, candidateHead],
      container.gitObjectsDir,
    );
    this.copyReachablePrivateObjects(container, candidateHead, validatedObjects);
    const safeTask = container.taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const sealedRef = `refs/quack/docker-resume/${safeTask}/${ownershipId}`;
    const zero = "0".repeat(candidateHead.length);
    this.runTrustedPrivateGit(container.authoritativeWorktreeGitDir, container.worktreePath, [
      "update-ref",
      sealedRef,
      candidateHead,
      zero,
    ]);
    return {
      authoritativeRef: container.authoritativeRef,
      baseHead: container.authoritativeHead,
      candidateHead,
      sealedRef,
    };
  }

  /**
   * Validate and copy a completed container's candidate commit before host
   * publication. This deliberately does not create the sealed ref: callers
   * must persist the complete publication journal first, closing the
   * ref-before-journal crash window.
   */
  preparePrivateGitForPublication(
    container: DockerContainer,
    ownershipId: string,
  ): DockerResumeGitBinding {
    if (
      container.status === "creating" ||
      container.status === "running" ||
      !container.privateGitDir ||
      !container.gitObjectsDir ||
      !container.authoritativeHead ||
      !container.authoritativeRef ||
      !container.authoritativeWorktreeGitDir
    ) {
      throw new Error("Docker private Git cannot be sealed before container exit is confirmed");
    }
    if (!/^[0-9a-f-]{36}$/i.test(ownershipId)) {
      throw new Error("Docker publication ownership is invalid");
    }
    const { candidateHead } = this.preparePrivateGitForInspection(container);
    const validatedObjects = this.validatePrivateObjectsForInspection(container);
    this.assertPrivateWorktreeClean(container, candidateHead, "publication");
    if (candidateHead === container.authoritativeHead) {
      throw new Error("Docker result has no committed change to publish");
    }
    this.assertAuthoritativeRefUnchanged(container);
    this.runTrustedPrivateGit(
      container.privateGitDir,
      container.worktreePath,
      ["merge-base", "--is-ancestor", container.authoritativeHead, candidateHead],
      container.gitObjectsDir,
    );
    this.copyReachablePrivateObjects(container, candidateHead, validatedObjects);
    const safeTask = container.taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const sealedRef = `refs/quack/docker-publication/${safeTask}/${ownershipId}`;
    return {
      authoritativeRef: container.authoritativeRef,
      baseHead: container.authoritativeHead,
      candidateHead,
      sealedRef,
    };
  }

  /** Pin a prepared publication only after its durable journal exists. */
  sealPreparedPublicationRef(binding: DockerResumeGitBinding): DockerResumeGitBinding {
    const candidate = this.projectGitOutput([
      "rev-parse",
      "--verify",
      `${binding.candidateHead}^{commit}`,
    ]);
    if (candidate.toLowerCase() !== binding.candidateHead.toLowerCase()) {
      throw new Error("Prepared Docker publication candidate is not an exact commit");
    }
    this.projectGitOutput([
      "update-ref",
      binding.sealedRef,
      binding.candidateHead,
      "0".repeat(binding.candidateHead.length),
    ]);
    return binding;
  }

  releaseSealedResumeRef(binding: DockerResumeSourceBinding): boolean {
    return this.releaseSealedGitRef(binding.gitState);
  }

  releaseSealedPublicationRef(binding: DockerResumeGitBinding): boolean {
    return this.releaseSealedGitRef(binding);
  }

  private releaseSealedGitRef(binding: DockerResumeGitBinding): boolean {
    try {
      let current: string;
      try {
        current = this.projectGitOutput(["show-ref", "--verify", "--hash", binding.sealedRef]);
      } catch (error: unknown) {
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status?: unknown }).status)
            : undefined;
        // git show-ref returns 1 when the exact ref is absent. Absence is the
        // desired idempotent cleanup state; other failures stay fail-closed.
        return status === 1;
      }
      if (current !== binding.candidateHead) return false;
      this.projectGitOutput(["update-ref", "-d", binding.sealedRef, binding.candidateHead]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inspect a stopped container's private repository. When `promote` is true,
   * verified content-addressed objects are copied and the one admitted task
   * ref is advanced with Git's old-value compare-and-swap. No container can
   * write authoritative refs, config, hooks, indexes, or worktree metadata.
   */
  extractResults(
    containerOrId: string | DockerContainer,
    options: { promote?: boolean } = {},
  ): Promise<{ diff: string; log: string; branch: string }> {
    const tracked =
      typeof containerOrId === "string"
        ? Array.from(this.containers.values()).find(
            (container) => container.containerId === containerOrId,
          )
        : containerOrId;
    if (
      !tracked?.privateGitDir ||
      !tracked.gitObjectsDir ||
      !tracked.authoritativeHead ||
      !tracked.authoritativeRef ||
      !tracked.authoritativeWorktreeGitDir
    ) {
      throw new Error("Docker result extraction requires tracked private Git metadata");
    }
    if (tracked.status === "creating" || tracked.status === "running") {
      throw new Error("Docker results cannot be trusted until the container is stopped");
    }
    const expectedWorktree = path.resolve(this.projectRoot, ".quack", "worktrees", tracked.taskId);
    if (
      comparablePath(fs.realpathSync.native(tracked.worktreePath)) !==
      comparablePath(fs.realpathSync.native(expectedWorktree))
    ) {
      throw new Error("Docker result worktree identity changed before extraction");
    }
    const dotGit = readTrustedTextFile(path.join(tracked.worktreePath, ".git"), 4_096).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
    if (
      !match ||
      comparablePath(
        fs.realpathSync.native(path.resolve(tracked.worktreePath, match[1].trim())),
      ) !== comparablePath(tracked.authoritativeWorktreeGitDir)
    ) {
      throw new Error("Docker result worktree no longer points to its admitted Git metadata");
    }

    // Replace container-controlled config with a fixed non-executable one and
    // remove its alternate pointer before invoking host Git on the private dir.
    const { candidateHead } = this.preparePrivateGitForInspection(tracked);
    const validatedObjects = this.validatePrivateObjectsForInspection(tracked);
    const branch =
      tracked.authoritativeRef === "HEAD"
        ? "HEAD"
        : tracked.authoritativeRef.slice("refs/heads/".length);
    const diff = this.runTrustedPrivateGit(
      tracked.privateGitDir,
      tracked.worktreePath,
      ["diff", "--no-ext-diff", tracked.authoritativeHead, candidateHead],
      tracked.gitObjectsDir,
    );
    const log = this.runTrustedPrivateGit(
      tracked.privateGitDir,
      tracked.worktreePath,
      ["log", "--oneline", "-10", candidateHead],
      tracked.gitObjectsDir,
    );

    if (options.promote) {
      this.assertPrivateWorktreeClean(tracked, candidateHead, "publication");
      if (candidateHead === tracked.authoritativeHead) {
        throw new Error("Docker result has no committed change to promote");
      }
      this.assertAuthoritativeRefUnchanged(tracked);
      this.runTrustedPrivateGit(
        tracked.privateGitDir,
        tracked.worktreePath,
        ["merge-base", "--is-ancestor", tracked.authoritativeHead, candidateHead],
        tracked.gitObjectsDir,
      );
      this.copyReachablePrivateObjects(tracked, candidateHead, validatedObjects);
      this.runTrustedPrivateGit(tracked.authoritativeWorktreeGitDir, tracked.worktreePath, [
        "update-ref",
        tracked.authoritativeRef,
        candidateHead,
        tracked.authoritativeHead,
      ]);
      this.runTrustedPrivateGit(tracked.authoritativeWorktreeGitDir, tracked.worktreePath, [
        "reset",
        "--mixed",
        candidateHead,
      ]);
    }

    return Promise.resolve({ diff, log, branch });
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
      const { stdout } = await this.execDocker(args);
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
    hostGitObjectsDir: string,
    containerGitDir: string,
    dotGitOverlay: string,
    containerName?: string,
    admissionScope?: string,
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

    // The task-specific worktree is the only writable source tree. Git writes
    // go to a disposable private gitdir; authoritative objects are read-only.
    const normalizedWorktree = resolveThroughExistingAncestor(worktreePath).replace(/\\/g, "/");
    args.push("-v", `${normalizedWorktree}:${CONTAINER_WORKSPACE}:rw`);
    args.push("-v", `${hostGitObjectsDir.replace(/\\/g, "/")}:/quack-git-objects:ro`);
    args.push("-v", `${dotGitOverlay.replace(/\\/g, "/")}:/workspace/.git:ro`);

    if (this.runtimeRoot) {
      args.push("-v", `${this.runtimeRoot.replace(/\\/g, "/")}:/quack-runtime:ro`);
    }

    // Runtime output is inside the disposable worktree; never mount the
    // authoritative host log/control tree read-write.
    this.assertRuntimeLogDirSafe(runtimeLogDir, worktreePath);

    // Mount only this dispatch's one-use capability. Sharing the admission
    // root would let one container read or consume another task's marker.
    if (admissionScope) {
      args.push("-v", `${admissionScope.replace(/\\/g, "/")}:${CONTAINER_ADMISSION_DIRECTORY}:rw`);
    }

    // .quack/prep → read-only
    const prepDir = validatePrepMountSource(this.projectRoot).replace(/\\/g, "/");
    args.push("-v", `${prepDir}:${CONTAINER_PREP_DIRECTORY}:ro`);

    // Adapter policy is authoritative monitor input, not task output. Overlay
    // each policy file read-only on top of the writable worktree mount.
    for (const policy of this.authoritativePolicyMounts()) {
      args.push("-v", `${policy.source.replace(/\\/g, "/")}:${policy.destination}:ro`);
    }

    // Additional configured volumes
    this.assertSafeConfiguredVolumes(worktreePath);
    for (const volume of this.config.volumes ?? []) {
      args.push("-v", this.safeConfiguredVolume(volume, worktreePath).argument);
    }

    // Environment variables — passed via --env args (no shell expansion)
    for (const envVar of this.config.envPassthrough) {
      if (
        isManagedDockerOperatorEnvironmentName(envVar) ||
        isClaudeCredentialEnvironmentName(envVar)
      )
        continue;
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

    // Do not allow an image-defined ENTRYPOINT to run before the one-use
    // admission capability is consumed by Quack.
    args.push("--entrypoint", "sleep");

    // Image
    args.push(this.config.image);

    // Keep the container running so the trusted docker exec can start Quack.
    args.push("infinity");

    return args;
  }

  private cleanupAdmissionScope(taskId: string): void {
    const scope = this.admissionScopes.get(taskId);
    if (!scope) return;
    removeDecompositionDispatchAdmissionScope(this.projectRoot, scope);
    this.admissionScopes.delete(taskId);
  }

  private async removeContainerAfterCreateFailure(
    identifier: string,
    ambiguousCreate: boolean,
  ): Promise<void> {
    try {
      await this.execDocker(["rm", "-f", identifier], 30_000);
    } catch (error) {
      if (!ambiguousCreate && dockerConfirmedContainerAbsent(error)) return;
      throw error;
    }
  }
}
