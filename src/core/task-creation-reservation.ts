import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildStrictTaskClaimantIndex, normalizeClaimantTaskId } from "./duplicate-claimants.js";
import { listTaskClaimantDeclarations } from "./task-file-resolver.js";

export const TASK_CREATION_LOCK_FILE = ".task-creation.lock";
export const TASK_CREATION_LOCK_OWNER_FILE = "owner.json";
const TASK_CREATION_RECLAIM_REQUEST_PREFIX = `${TASK_CREATION_LOCK_FILE}.reclaim-request-`;
const TASK_CREATION_RECLAIM_QUARANTINE_PREFIX = `${TASK_CREATION_LOCK_FILE}.reclaim-quarantine-`;
const TASK_CREATION_RELEASE_TOMBSTONE_PREFIX = `${TASK_CREATION_LOCK_FILE}.release-`;
const TASK_CREATION_ACQUIRE_STAGING_PREFIX = `${TASK_CREATION_LOCK_FILE}.acquire-`;

export interface TaskCreationProvenance {
  creator:
    | "planner"
    | "validation-intake"
    | "judge-follow-up"
    | "decompose"
    | "dispatch-admission"
    | "task-mutation"
    | "task-watcher";
  requestedIds?: readonly string[];
}

export interface TaskCreationLockOptions {
  retryMs: number;
  timeoutMs: number;
  staleMs: number;
}

export interface TaskCreationReservationOptions extends Partial<TaskCreationLockOptions> {
  /** Observe cleanup failure without allowing it to mask operation outcome. */
  onReleaseError?: (error: unknown) => void;
}

const RESERVATION_RELEASE_ERROR = Symbol("taskCreationReservationReleaseError");
const RESERVATION_RELEASE_ERROR_PROPERTY = "reservationReleaseError";

export function getTaskCreationReservationReleaseError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as {
    [RESERVATION_RELEASE_ERROR]?: unknown;
    reservationReleaseError?: unknown;
  };
  return record[RESERVATION_RELEASE_ERROR] ?? record.reservationReleaseError;
}

const DEFAULT_LOCK_OPTIONS: TaskCreationLockOptions = {
  retryMs: 20,
  timeoutMs: 15_000,
  staleMs: 5 * 60_000,
};

interface TaskCreationLockRecord {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
  creator: TaskCreationProvenance["creator"];
  requestedIds: string[];
}

function localReservationArtifactId(): string {
  const hostFingerprint = crypto
    .createHash("sha256")
    .update(os.hostname())
    .digest("hex")
    .slice(0, 16);
  return `${hostFingerprint}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
}

export interface TaskCreationConflict {
  taskId: string;
  claimants: string[];
}

export class TaskCreationIdentityConflictError extends Error {
  readonly code = "task_identity_conflict";

  constructor(public readonly conflicts: TaskCreationConflict[]) {
    super(
      `Task creation refused because declared ids already have owners: ${conflicts
        .map((conflict) => `${conflict.taskId} (${conflict.claimants.join(", ")})`)
        .join("; ")}`,
    );
    this.name = "TaskCreationIdentityConflictError";
  }
}

export class TaskCreationScanUnavailableError extends Error {
  readonly code = "task_claimant_scan_unavailable";

  constructor(public readonly reason: string) {
    super(`Task creation refused: claimant scan unavailable: ${reason}`);
    this.name = "TaskCreationScanUnavailableError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockRecord(lockPath: string): Promise<TaskCreationLockRecord> {
  const stat = await fs.lstat(lockPath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Task-creation reservation has an unsafe file type: ${lockPath}`);
  }
  const recordPath = stat.isDirectory()
    ? path.join(lockPath, TASK_CREATION_LOCK_OWNER_FILE)
    : lockPath;
  return JSON.parse(await fs.readFile(recordPath, "utf-8")) as TaskCreationLockRecord;
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  const stat = await fs.lstat(lockPath);
  const current = await readLockRecord(lockPath);
  if (current.token !== token) {
    throw new Error(`Task-creation reservation ownership changed before release: ${lockPath}`);
  }
  const hostFingerprint = crypto
    .createHash("sha256")
    .update(os.hostname())
    .digest("hex")
    .slice(0, 16);
  const releasePath = path.join(
    path.dirname(lockPath),
    `${TASK_CREATION_RELEASE_TOMBSTONE_PREFIX}${hostFingerprint}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
  );
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await fs.rename(lockPath, releasePath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code ?? "")) {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  const moved = await readLockRecord(releasePath);
  if (moved.token !== token) {
    throw new Error(
      `Task-creation reservation ownership changed during atomic release: ${releasePath}`,
    );
  }
  if (stat.isDirectory()) {
    await fs.unlink(path.join(releasePath, TASK_CREATION_LOCK_OWNER_FILE));
    await removeEmptyDirectoryWithRetry(releasePath);
  } else {
    await fs.unlink(releasePath);
  }
}

async function reclaimableLockRecord(
  lockPath: string,
  staleMs: number,
): Promise<TaskCreationLockRecord | null> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs < staleMs) return null;

    const record = await readLockRecord(lockPath);
    if (
      typeof record.token !== "string" ||
      record.token.length === 0 ||
      typeof record.hostname !== "string" ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid)
    ) {
      return null;
    }
    if (record.hostname !== os.hostname() || isProcessAlive(record.pid)) return null;
    return record;
  } catch (err: unknown) {
    // Missing, unreadable, and malformed ownership evidence is never safe to
    // steal. In particular, another process may still be publishing it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || err instanceof SyntaxError) {
      return null;
    }
    return null;
  }
}

async function reclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const directory = path.dirname(lockPath);
  const requestId = localReservationArtifactId();
  const requestPath = path.join(directory, `${TASK_CREATION_RECLAIM_REQUEST_PREFIX}${requestId}`);
  const quarantinePath = path.join(
    directory,
    `${TASK_CREATION_RECLAIM_QUARANTINE_PREFIX}${requestId}`,
  );
  await fs.mkdir(requestPath);
  try {
    // Publishing the request before observing ownership prevents a new owner
    // from entering while one or more contenders move the stale lock aside.
    // Every acquirer checks these immutable, uniquely named request markers
    // both before and after publishing its own lock directory.
    const observed = await reclaimableLockRecord(lockPath, staleMs);
    if (!observed) return false;
    try {
      await fs.rename(lockPath, quarantinePath);
    } catch (error) {
      if (
        ["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        return false;
      }
      throw error;
    }

    let moved: TaskCreationLockRecord;
    try {
      moved = await readLockRecord(quarantinePath);
    } catch (error) {
      const quarantineStillExists = await pathExists(quarantinePath);
      if (!quarantineStillExists) return false;

      // Never interpret missing/malformed ownership evidence inside a moved
      // quarantine as successful reclamation. Preserve it at the canonical
      // lock name so every contender remains fail closed until an operator or
      // a later identity-verified recovery can resolve it.
      if (!(await pathExists(lockPath))) {
        try {
          await fs.rename(quarantinePath, lockPath);
        } catch (restoreError) {
          throw new Error(
            `Task-creation reservation lost ownership evidence during stale reclaim and could not be restored from ${quarantinePath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            { cause: restoreError },
          );
        }
      }
      throw new Error(
        `Task-creation reservation lost ownership evidence during stale reclaim: ${lockPath}`,
        { cause: error },
      );
    }
    if (moved.token !== observed.token) {
      // Another contender won the stale rename and a not-yet-admitted owner
      // briefly published behind it. The request markers keep that owner from
      // entering its callback, so restore its exact directory before leaving.
      try {
        await fs.rename(quarantinePath, lockPath);
      } catch (error) {
        throw new Error(
          `Task-creation reservation changed during stale reclaim and could not be restored from ${quarantinePath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return false;
    }
    await removeOwnedLock(quarantinePath, observed.token).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return true;
  } finally {
    await fs.rmdir(requestPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function reservationArtifactOwner(
  name: string,
  prefix: string,
): {
  hostFingerprint: string;
  pid: number;
  createdAt: number;
} | null {
  if (!name.startsWith(prefix)) return null;
  const match = /^([0-9a-f]{16})-(\d+)-(\d+)-[0-9a-f-]{36}$/.exec(name.slice(prefix.length));
  if (!match) return null;
  return {
    hostFingerprint: match[1],
    pid: Number(match[2]),
    createdAt: Number(match[3]),
  };
}

async function listReservationArtifacts(taskDir: string, prefix: string): Promise<string[]> {
  return (await fs.readdir(taskDir))
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => path.join(taskDir, name));
}

function isDeadLocalArtifact(name: string, prefix: string, staleMs: number): boolean {
  const owner = reservationArtifactOwner(name, prefix);
  if (!owner || !Number.isInteger(owner.pid) || !Number.isFinite(owner.createdAt)) return false;
  const localFingerprint = crypto
    .createHash("sha256")
    .update(os.hostname())
    .digest("hex")
    .slice(0, 16);
  return (
    owner.hostFingerprint === localFingerprint &&
    Date.now() - owner.createdAt >= staleMs &&
    !isProcessAlive(owner.pid)
  );
}

async function reconcileInterruptedReclaims(
  taskDir: string,
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  let progressed = false;
  for (const requestPath of await listReservationArtifacts(
    taskDir,
    TASK_CREATION_RECLAIM_REQUEST_PREFIX,
  )) {
    const name = path.basename(requestPath);
    if (!isDeadLocalArtifact(name, TASK_CREATION_RECLAIM_REQUEST_PREFIX, staleMs)) continue;
    const stat = await fs.lstat(requestPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    await fs.rmdir(requestPath);
    progressed = true;
  }

  for (const quarantinePath of await listReservationArtifacts(
    taskDir,
    TASK_CREATION_RECLAIM_QUARANTINE_PREFIX,
  )) {
    const name = path.basename(quarantinePath);
    const requestPath = path.join(
      taskDir,
      `${TASK_CREATION_RECLAIM_REQUEST_PREFIX}${name.slice(TASK_CREATION_RECLAIM_QUARANTINE_PREFIX.length)}`,
    );
    // The reclaimer that owns this quarantine is still inside its atomic
    // observe/move/verify sequence. Other waiters must not restore or delete
    // its path; they simply keep admission closed until its request vanishes.
    if (await pathExists(requestPath)) continue;
    const reclaimed = await reclaimableLockRecord(quarantinePath, staleMs);
    if (reclaimed && isDeadLocalArtifact(name, TASK_CREATION_RECLAIM_QUARANTINE_PREFIX, staleMs)) {
      await removeOwnedLock(quarantinePath, reclaimed.token);
      progressed = true;
      continue;
    }
    if (!(await pathExists(lockPath))) {
      // A live/fresh owner may have been moved by a reclaimer that crashed
      // after rename but before its token comparison. Restore it atomically.
      try {
        await fs.rename(quarantinePath, lockPath);
        progressed = true;
        continue;
      } catch (error) {
        if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
      }
    }
  }
  return progressed;
}

async function hasReclaimArtifacts(taskDir: string): Promise<boolean> {
  return (
    (await listReservationArtifacts(taskDir, TASK_CREATION_RECLAIM_REQUEST_PREFIX)).length > 0 ||
    (await listReservationArtifacts(taskDir, TASK_CREATION_RECLAIM_QUARANTINE_PREFIX)).length > 0
  );
}

async function cleanupStaleReleaseTombstones(taskDir: string, staleMs: number): Promise<void> {
  for (const releasePath of await listReservationArtifacts(
    taskDir,
    TASK_CREATION_RELEASE_TOMBSTONE_PREFIX,
  )) {
    if (
      !isDeadLocalArtifact(
        path.basename(releasePath),
        TASK_CREATION_RELEASE_TOMBSTONE_PREFIX,
        staleMs,
      )
    ) {
      continue;
    }
    try {
      const record = await readLockRecord(releasePath);
      await removeOwnedReleaseTombstone(releasePath, record.token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const stat = await fs.lstat(releasePath);
          if (stat.isDirectory() && (await fs.readdir(releasePath)).length === 0) {
            await removeEmptyDirectoryWithRetry(releasePath);
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            // Preserve any non-empty or otherwise unverifiable tombstone.
          }
        }
      } else {
        // A malformed tombstone is evidence, but it does not own the live
        // reservation name and therefore must not wedge future admissions.
      }
    }
  }
}

async function cleanupStaleAcquireStaging(taskDir: string, staleMs: number): Promise<void> {
  for (const stagingPath of await listReservationArtifacts(
    taskDir,
    TASK_CREATION_ACQUIRE_STAGING_PREFIX,
  )) {
    const name = path.basename(stagingPath);
    const artifactOwner = reservationArtifactOwner(name, TASK_CREATION_ACQUIRE_STAGING_PREFIX);
    if (
      !artifactOwner ||
      !isDeadLocalArtifact(name, TASK_CREATION_ACQUIRE_STAGING_PREFIX, staleMs)
    ) {
      continue;
    }
    try {
      const stat = await fs.lstat(stagingPath);
      const record = await readLockRecord(stagingPath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        record.hostname !== os.hostname() ||
        record.pid !== artifactOwner.pid ||
        typeof record.token !== "string" ||
        record.token.length === 0
      ) {
        continue;
      }
      await fs.unlink(stagingPath);
    } catch {
      // A malformed or unreadable staging artifact does not own the live lock
      // name. Preserve it as evidence rather than guessing at its ownership.
    }
  }
}

async function removeOwnedReleaseTombstone(releasePath: string, token: string): Promise<void> {
  const stat = await fs.lstat(releasePath);
  const current = await readLockRecord(releasePath);
  if (current.token !== token) {
    throw new Error(`Task-creation release tombstone ownership changed: ${releasePath}`);
  }
  if (stat.isDirectory()) {
    await fs.unlink(path.join(releasePath, TASK_CREATION_LOCK_OWNER_FILE));
    await removeEmptyDirectoryWithRetry(releasePath);
  } else {
    await fs.unlink(releasePath);
  }
}

async function removeEmptyDirectoryWithRetry(directory: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await fs.rmdir(directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTEMPTY"].includes(code ?? "")) {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function acquireTaskCreationReservation(
  taskDir: string,
  provenance: TaskCreationProvenance,
  options: TaskCreationLockOptions,
): Promise<() => Promise<void>> {
  await fs.mkdir(taskDir, { recursive: true });
  const lockPath = path.join(taskDir, TASK_CREATION_LOCK_FILE);
  const startedAt = Date.now();

  for (;;) {
    await cleanupStaleReleaseTombstones(taskDir, options.staleMs);
    await cleanupStaleAcquireStaging(taskDir, options.staleMs);
    await reconcileInterruptedReclaims(taskDir, lockPath, options.staleMs);
    if (await hasReclaimArtifacts(taskDir)) {
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting for task-creation reservation: ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, options.retryMs));
      continue;
    }
    const token = crypto.randomUUID();
    const stagingPath = path.join(
      taskDir,
      `${TASK_CREATION_ACQUIRE_STAGING_PREFIX}${localReservationArtifactId()}`,
    );
    try {
      const record: TaskCreationLockRecord = {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        creator: provenance.creator,
        requestedIds: (provenance.requestedIds ?? []).map(normalizeClaimantTaskId),
      };
      let stagingPublished = false;
      let publicationFailed = false;
      let publicationError: unknown;
      try {
        // Fully publish immutable ownership bytes under a unique sibling name,
        // then use a hard-link as the no-replace acquisition CAS. Unlike
        // mkdir-then-owner.json, the canonical lock name is never observable
        // without complete ownership evidence. A same-directory hard link is
        // also portable across the project filesystem and cannot overwrite an
        // existing live or malformed reservation.
        const handle = await fs.open(stagingPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.link(stagingPath, lockPath);
        stagingPublished = true;
      } catch (error) {
        publicationFailed = true;
        publicationError = error;
      }
      let stagingCleanupError: unknown;
      try {
        await fs.unlink(stagingPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          stagingCleanupError = cleanupError;
        }
      }
      if (stagingCleanupError) {
        if (stagingPublished) {
          await removeOwnedLock(lockPath, token).catch(() => undefined);
        }
        throw stagingCleanupError instanceof Error
          ? stagingCleanupError
          : new Error("Failed to clean up task-creation reservation staging state.");
      }
      if (publicationFailed) throw publicationError;

      if (await hasReclaimArtifacts(taskDir)) {
        await removeOwnedLock(lockPath, token);
        continue;
      }

      return async () => {
        try {
          await removeOwnedLock(lockPath, token);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      };
    } catch (err: unknown) {
      if (!["EEXIST", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw err;
      }

      if (await reclaimStaleLock(lockPath, options.staleMs)) continue;
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting for task-creation reservation: ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, options.retryMs));
    }
  }
}

/**
 * Serialize every task-spec creator in one task directory. The callback must
 * perform its strict claimant scan and final write while the reservation is
 * held so no second process can pass the same ownership check concurrently.
 */
export async function withTaskCreationReservation<T>(
  taskDir: string,
  provenance: TaskCreationProvenance,
  operation: () => Promise<T>,
  options: TaskCreationReservationOptions = {},
): Promise<T> {
  const { onReleaseError, ...lockOptions } = options;
  const release = await acquireTaskCreationReservation(taskDir, provenance, {
    ...DEFAULT_LOCK_OPTIONS,
    ...lockOptions,
  });
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await release();
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (releaseFailed) {
    let observerError: unknown;
    try {
      onReleaseError?.(releaseError);
    } catch (error) {
      observerError = error;
    }
    // A cleanup failure must never replace the operation's original
    // exception. Attach cleanup evidence to that same object so callers do
    // not lose either identity or the reason a stale lock may remain.
    if (operationFailed) {
      const cleanupEvidence = observerError
        ? new AggregateError([releaseError, observerError], "Reservation cleanup reporting failed")
        : releaseError;
      if (typeof operationError === "object" && operationError !== null) {
        Object.defineProperty(operationError, RESERVATION_RELEASE_ERROR, {
          value: cleanupEvidence,
          configurable: true,
        });
        Object.defineProperty(operationError, RESERVATION_RELEASE_ERROR_PROPERTY, {
          value: cleanupEvidence,
          configurable: true,
          enumerable: true,
        });
      } else {
        throw new AggregateError(
          [operationError, cleanupEvidence],
          "Task creation operation and reservation cleanup both failed",
          { cause: operationError },
        );
      }
    } else if (!onReleaseError) {
      throw releaseError;
    } else if (observerError) {
      throw new AggregateError(
        [releaseError, observerError],
        "Reservation cleanup and cleanup reporting failed",
      );
    }
  }

  if (operationFailed) throw operationError;
  return result as T;
}

/** Strictly read every currently parseable declared-id owner. */
export async function readTaskCreationClaimants(taskDir: string): Promise<Map<string, string[]>> {
  const index = await buildStrictTaskClaimantIndex(() => listTaskClaimantDeclarations(taskDir));
  if (index.status === "unavailable") {
    throw new TaskCreationScanUnavailableError(index.reason);
  }
  return index.claimants;
}

/**
 * Refuse planned declarations that already have another filename owner. This
 * deliberately retains the owner filenames for caller-visible provenance.
 */
export function assertTaskCreationIdsAvailable(
  claimantsById: ReadonlyMap<string, readonly string[]>,
  planned: readonly { taskId: string; fileName: string }[],
): void {
  const conflicts: TaskCreationConflict[] = [];
  for (const candidate of planned) {
    const taskId = normalizeClaimantTaskId(candidate.taskId);
    const claimants = (claimantsById.get(taskId) ?? [])
      .filter((fileName) => fileName !== candidate.fileName)
      .sort((a, b) => a.localeCompare(b));
    if (claimants.length > 0) conflicts.push({ taskId, claimants });
  }
  if (conflicts.length > 0) throw new TaskCreationIdentityConflictError(conflicts);
}
