import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";

export const DECOMPOSITION_ADMISSION_HASH_ENV = "QUACK_DECOMPOSITION_ADMISSION_HASH";
export const DECOMPOSITION_ADMISSION_MARKER_ENV = "QUACK_DECOMPOSITION_ADMISSION_MARKER";
export const DECOMPOSITION_ADMISSION_TOKEN_ENV = "QUACK_DECOMPOSITION_ADMISSION_TOKEN";

const ADMISSION_DIRECTORY = "decomposition-admissions";
const MARKER_VERSION = 1;
const MAX_MARKER_AGE_MS = 60 * 60_000;
const TASK_ID_PATTERN = /^(?:TASK-\d+|SAURUS-REM-\d{3})(?:-[A-Z]+)?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKER_NAME_PATTERN =
  /^(?:marker|dispatch-(?:TASK-\d+|SAURUS-REM-\d{3})(?:-[A-Z]+)?-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const ADMISSION_SCOPE_PATTERN =
  /^dispatch-(?:TASK-\d+|SAURUS-REM-\d{3})(?:-[A-Z]+)?-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface AdmissionMarker {
  version: 1;
  taskId: string;
  contentHash: string;
  token: string;
  createdAt: number;
}

export interface CreatedDecompositionDispatchAdmission {
  environment: Record<string, string>;
  /** Host-only mount metadata. Never spread this path into the child environment. */
  hostDirectory: string;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function decompositionDispatchAdmissionDirectory(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  return path.join(root, ".quack", ADMISSION_DIRECTORY);
}

function assertDirectoryChainSync(projectRoot: string, directory: string): void {
  const realRoot = fsSync.realpathSync(projectRoot);
  let current = path.resolve(projectRoot);
  for (const component of [".quack", ADMISSION_DIRECTORY]) {
    current = path.join(current, component);
    const stat = fsSync.lstatSync(current);
    const realCurrent = fsSync.realpathSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isContained(realRoot, realCurrent)) {
      throw new Error("Decomposition dispatch admission directory is unsafe.");
    }
  }
  if (path.resolve(current) !== path.resolve(directory)) {
    throw new Error("Decomposition dispatch admission directory is not canonical.");
  }
}

function flushDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fsSync.openSync(directory, "r");
    fsSync.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
  }
}

export function ensureDecompositionDispatchAdmissionDirectory(projectRoot: string): string {
  const directory = decompositionDispatchAdmissionDirectory(projectRoot);
  for (const candidate of [path.join(path.resolve(projectRoot), ".quack"), directory]) {
    try {
      fsSync.mkdirSync(candidate, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fsSync.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Decomposition dispatch admission directory is unsafe.");
    }
  }
  assertDirectoryChainSync(projectRoot, directory);
  return directory;
}

/** Create the second, one-use proof that distinguishes a managed child from an ordinary CLI. */
export function createDecompositionDispatchAdmissionMarker(input: {
  projectRoot: string;
  taskId: string;
  contentHash: string;
  /** Isolate a Docker child to one exact marker directory. */
  isolatedDirectory?: boolean;
}): CreatedDecompositionDispatchAdmission {
  if (!TASK_ID_PATTERN.test(input.taskId) || !HASH_PATTERN.test(input.contentHash)) {
    throw new Error("Invalid decomposition dispatch admission identity.");
  }
  const directory = ensureDecompositionDispatchAdmissionDirectory(input.projectRoot);

  const dispatchPrefix = `dispatch-${input.taskId}-`;
  const outstandingAdmission = fsSync
    .readdirSync(directory)
    .find(
      (name) =>
        name.startsWith(dispatchPrefix) &&
        (ADMISSION_SCOPE_PATTERN.test(name) || MARKER_NAME_PATTERN.test(name)),
    );
  if (outstandingAdmission) {
    throw new Error(
      `A decomposition dispatch admission scope remains unresolved for ${input.taskId}: ${outstandingAdmission}`,
    );
  }

  const token = crypto.randomUUID();
  const dispatchId = crypto.randomUUID();
  const hostDirectory = input.isolatedDirectory
    ? path.join(directory, `dispatch-${input.taskId}-${dispatchId}`)
    : directory;
  let isolatedScopeCreated = false;
  if (input.isolatedDirectory) {
    fsSync.mkdirSync(hostDirectory, { mode: 0o700 });
    isolatedScopeCreated = true;
    const stat = fsSync.lstatSync(hostDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Decomposition dispatch admission scope is unsafe.");
    }
  }
  const markerName = input.isolatedDirectory
    ? "marker.json"
    : `dispatch-${input.taskId}-${dispatchId}.json`;
  const markerPath = path.join(hostDirectory, markerName);
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const marker: AdmissionMarker = {
    version: MARKER_VERSION,
    taskId: input.taskId,
    contentHash: input.contentHash,
    token,
    createdAt: Date.now(),
  };
  let descriptor: number | undefined;
  try {
    descriptor = fsSync.openSync(temporaryPath, "wx", 0o600);
    fsSync.writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, "utf-8");
    fsSync.fsyncSync(descriptor);
    fsSync.closeSync(descriptor);
    descriptor = undefined;
    fsSync.renameSync(temporaryPath, markerPath);
    flushDirectorySync(hostDirectory);
    if (input.isolatedDirectory) flushDirectorySync(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsSync.closeSync(descriptor);
      } catch {
        // Preserve the publication error.
      }
    }
    try {
      fsSync.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    try {
      if (isolatedScopeCreated) {
        removeDecompositionDispatchAdmissionScope(input.projectRoot, hostDirectory);
      } else {
        fsSync.unlinkSync(markerPath);
        flushDirectorySync(directory);
      }
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "Admission marker publication and cleanup both failed.",
          { cause: error },
        );
      }
    }
    throw error;
  }

  return {
    environment: {
      [DECOMPOSITION_ADMISSION_HASH_ENV]: input.contentHash,
      [DECOMPOSITION_ADMISSION_MARKER_ENV]: markerName,
      [DECOMPOSITION_ADMISSION_TOKEN_ENV]: token,
    },
    hostDirectory,
  };
}

export function assertDecompositionDispatchAdmissionScope(
  projectRoot: string,
  scopeDirectory: string,
): string {
  const admissionRoot = ensureDecompositionDispatchAdmissionDirectory(projectRoot);
  const resolvedScope = path.resolve(scopeDirectory);
  if (
    path.dirname(resolvedScope) !== path.resolve(admissionRoot) ||
    !ADMISSION_SCOPE_PATTERN.test(path.basename(resolvedScope))
  ) {
    throw new Error("Docker admission scope is not a canonical per-dispatch directory.");
  }
  const stat = fsSync.lstatSync(resolvedScope);
  const realRoot = fsSync.realpathSync(admissionRoot);
  const realScope = fsSync.realpathSync(resolvedScope);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isContained(realRoot, realScope) ||
    path.dirname(realScope) !== realRoot
  ) {
    throw new Error("Docker admission scope is unsafe.");
  }
  return realScope;
}

export function removeDecompositionDispatchAdmissionScope(
  projectRoot: string,
  scopeDirectory: string,
): void {
  const realScope = assertDecompositionDispatchAdmissionScope(projectRoot, scopeDirectory);
  for (const name of fsSync.readdirSync(realScope)) {
    const candidate = path.join(realScope, name);
    const stat = fsSync.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("Docker admission scope contains unsafe residual state.");
    }
    if (
      name !== "marker.json" &&
      !name.startsWith("marker.json.tmp-") &&
      !name.startsWith("marker.json.consumed-")
    ) {
      throw new Error("Docker admission scope contains unrecognized residual state.");
    }
    fsSync.unlinkSync(candidate);
  }
  fsSync.rmdirSync(realScope);
  flushDirectorySync(path.dirname(realScope));
}

async function flushDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isExactMarker(value: unknown): value is AdmissionMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "contentHash,createdAt,taskId,token,version" &&
    record.version === MARKER_VERSION &&
    typeof record.taskId === "string" &&
    TASK_ID_PATTERN.test(record.taskId) &&
    typeof record.contentHash === "string" &&
    HASH_PATTERN.test(record.contentHash) &&
    typeof record.token === "string" &&
    UUID_PATTERN.test(record.token) &&
    typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.createdAt)
  );
}

/**
 * Revoke a capability that was published but never transferred to a child.
 * The exact token and inode are claimed before invalidation so this helper
 * cannot remove a replacement marker created by another dispatch.
 */
export function revokeDecompositionDispatchAdmission(
  projectRoot: string,
  admission: CreatedDecompositionDispatchAdmission,
): boolean {
  const markerName = admission.environment[DECOMPOSITION_ADMISSION_MARKER_ENV];
  const contentHash = admission.environment[DECOMPOSITION_ADMISSION_HASH_ENV];
  const token = admission.environment[DECOMPOSITION_ADMISSION_TOKEN_ENV];
  if (
    !markerName ||
    !contentHash ||
    !token ||
    !MARKER_NAME_PATTERN.test(markerName) ||
    !HASH_PATTERN.test(contentHash) ||
    !UUID_PATTERN.test(token)
  ) {
    throw new Error("Cannot revoke a malformed decomposition dispatch admission.");
  }

  const admissionRoot = ensureDecompositionDispatchAdmissionDirectory(projectRoot);
  const isolated = markerName === "marker.json";
  const hostDirectory = isolated
    ? assertDecompositionDispatchAdmissionScope(projectRoot, admission.hostDirectory)
    : path.resolve(admission.hostDirectory);
  if (!isolated && hostDirectory !== path.resolve(admissionRoot)) {
    throw new Error("Cannot revoke an admission outside the canonical admission directory.");
  }

  const markerPath = path.join(hostDirectory, markerName);
  let markerStat: fsSync.BigIntStats;
  try {
    markerStat = fsSync.lstatSync(markerPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.nlink !== 1n) {
    throw new Error("Cannot revoke an unsafe decomposition dispatch admission marker.");
  }
  const parsed = JSON.parse(fsSync.readFileSync(markerPath, "utf-8")) as unknown;
  if (!isExactMarker(parsed) || parsed.contentHash !== contentHash || parsed.token !== token) {
    throw new Error("Decomposition dispatch admission ownership changed before revocation.");
  }

  const revokedPath = `${markerPath}.consumed-${process.pid}-${crypto.randomUUID()}`;
  fsSync.renameSync(markerPath, revokedPath);
  flushDirectorySync(hostDirectory);
  const revokedStat = fsSync.lstatSync(revokedPath, { bigint: true });
  if (revokedStat.dev !== markerStat.dev || revokedStat.ino !== markerStat.ino) {
    throw new Error("Decomposition dispatch admission changed during revocation.");
  }
  const descriptor = fsSync.openSync(revokedPath, "r+");
  try {
    fsSync.ftruncateSync(descriptor, 0);
    fsSync.writeFileSync(descriptor, '{"revoked":true}\n', "utf-8");
    fsSync.fsyncSync(descriptor);
  } finally {
    fsSync.closeSync(descriptor);
  }
  flushDirectorySync(hostDirectory);
  fsSync.unlinkSync(revokedPath);
  flushDirectorySync(hostDirectory);
  if (isolated) {
    fsSync.rmdirSync(hostDirectory);
    flushDirectorySync(admissionRoot);
  }
  return true;
}

/** Consume a monitor-created admission marker exactly once. Partial env state is not trusted. */
export async function consumeDecompositionDispatchAdmission(
  adapter: ProjectAdapter,
  taskId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const contentHash = environment[DECOMPOSITION_ADMISSION_HASH_ENV];
  const markerName = environment[DECOMPOSITION_ADMISSION_MARKER_ENV];
  const token = environment[DECOMPOSITION_ADMISSION_TOKEN_ENV];
  // These values are a one-use capability, not ordinary child configuration.
  // Remove even partial or malformed input before any await or validation so
  // worker/tool subprocesses cannot inherit enough material to replay it.
  delete environment[DECOMPOSITION_ADMISSION_HASH_ENV];
  delete environment[DECOMPOSITION_ADMISSION_MARKER_ENV];
  delete environment[DECOMPOSITION_ADMISSION_TOKEN_ENV];
  if (!contentHash || !markerName || !token) return undefined;
  if (!HASH_PATTERN.test(contentHash) || !MARKER_NAME_PATTERN.test(markerName)) {
    throw new Error("Malformed managed decomposition dispatch admission.");
  }

  const expectedDirectory = decompositionDispatchAdmissionDirectory(adapter.projectRoot);
  const [realRoot, realDirectory, directoryStat] = await Promise.all([
    fs.realpath(adapter.projectRoot),
    fs.realpath(expectedDirectory),
    fs.lstat(expectedDirectory),
  ]);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    !isContained(realRoot, realDirectory)
  ) {
    throw new Error("Managed decomposition dispatch admission directory is unsafe.");
  }

  const markerPath = path.join(expectedDirectory, markerName);
  const markerStat = await fs.lstat(markerPath, { bigint: true });
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.nlink !== 1n) {
    throw new Error("Managed decomposition dispatch admission marker is unsafe.");
  }
  const raw = await fs.readFile(markerPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Managed decomposition dispatch admission marker is malformed.", {
      cause: error,
    });
  }
  if (
    !isExactMarker(parsed) ||
    parsed.taskId !== taskId ||
    parsed.contentHash !== contentHash ||
    parsed.token !== token ||
    Date.now() - parsed.createdAt < 0 ||
    Date.now() - parsed.createdAt > MAX_MARKER_AGE_MS
  ) {
    throw new Error("Managed decomposition dispatch admission marker does not match this task.");
  }
  // Rename is the one-use claim: concurrent consumers cannot both acquire the
  // same path. Persist an invalid tombstone before deletion, so a crash that
  // resurrects directory metadata still cannot resurrect a valid capability.
  const consumedPath = `${markerPath}.consumed-${process.pid}-${crypto.randomUUID()}`;
  await fs.rename(markerPath, consumedPath);
  // Persist the one-use namespace claim before any later fallible work. If a
  // crash follows, the original environment path must not reappear valid.
  await flushDirectory(expectedDirectory);
  const consumedStat = await fs.lstat(consumedPath, { bigint: true });
  if (consumedStat.dev !== markerStat.dev || consumedStat.ino !== markerStat.ino) {
    throw new Error("Managed decomposition dispatch admission marker changed during consumption.");
  }
  const handle = await fs.open(consumedPath, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile('{"consumed":true}\n', "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await flushDirectory(expectedDirectory);
  await fs.unlink(consumedPath);
  await flushDirectory(expectedDirectory);
  return contentHash;
}
