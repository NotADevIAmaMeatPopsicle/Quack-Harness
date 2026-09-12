import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";

import { withFederatedJobLock } from "./store.js";

const DEFAULT_STALE_MS = 30_000;
const OFFLINE_REQUEST_SUFFIX = ".reclaim-request.offline.json";
const OFFLINE_RECEIPT_SUFFIX = ".reclaim-request.offline.delete-authorized.json";
const OFFLINE_QUARANTINE_PREFIX = ".offline-recovery-quarantine.";
const OFFLINE_PUBLISH_PREFIX = ".offline-recovery-publish.";
const OFFLINE_DIRECTORY_REMOVE_RETRY_MS = 10;
const OFFLINE_DIRECTORY_REMOVE_TIMEOUT_MS = 1_000;
const OFFLINE_RECOVERY_CLAIM_JOB_ID = "quack-internal-offline-recovery-claim";
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_TEXT}$`, "iu");

interface PhysicalIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

interface LegacyTarget {
  kind: "legacy-empty-file";
  layout: "file";
  lock: PhysicalIdentity;
  contentSha256: string;
}

interface V1LockRecord {
  version: 1;
  ownerToken: string;
  host: string;
  pid: number;
  acquiredAt: string;
}

interface V1Target {
  kind: "v1-file" | "v1-directory";
  layout: "file" | "directory";
  lock: PhysicalIdentity;
  owner?: PhysicalIdentity;
  contentSha256: string;
  record: V1LockRecord;
}

type RecoverableTarget = LegacyTarget | V1Target;

interface OfflineRecoveryIntent {
  version: 1;
  kind: "offline-federation-lock-recovery";
  requestToken: string;
  jobId: string;
  projectRoot: string;
  lockPath: string;
  host: string;
  createdAt: string;
  staleMs: number;
  fingerprint: string;
  target: RecoverableTarget;
}

interface OfflineDeleteReceipt {
  version: 1;
  kind: "offline-federation-lock-delete-authorized";
  requestToken: string;
  jobId: string;
  projectRoot: string;
  lockPath: string;
  host: string;
  fingerprint: string;
  targetKind: RecoverableTarget["kind"];
  authorizedAt: string;
}

export type OfflineFederatedLockRecoveryStage =
  | "target_inspected"
  | "intent_staged"
  | "request_published"
  | "peer_receipt_observed"
  | "canonical_verified"
  | "quarantine_linked"
  | "directory_quarantine_moved"
  | "displaced_quarantine_snapshot"
  | "displaced_quarantine_reinspected"
  | "lock_quarantined"
  | "receipt_staged"
  | "delete_authorized"
  | "directory_owner_removed"
  | "quarantine_removed"
  | "request_removed"
  | "receipt_removed";

export interface OfflineFederatedLockRecoveryOptions {
  projectRoot: string;
  jobId: string;
  staleMs?: number;
  apply?: boolean;
  /** Explicit operator attestation that every Quack process sharing the project is stopped. */
  confirmOffline?: boolean;
  /** Exact fingerprint printed by the dry run. */
  expectedFingerprint?: string;
  /** @internal Deterministic clock seam. */
  nowForTest?: () => number;
  /** @internal Crash-boundary seam. */
  afterStageForTest?: (stage: OfflineFederatedLockRecoveryStage) => void | Promise<void>;
}

export type OfflineFederatedLockRecoveryResult =
  | {
      status: "eligible";
      applied: false;
      jobId: string;
      kind: RecoverableTarget["kind"];
      fingerprint: string;
      ageMs: number;
      lockPath: string;
    }
  | {
      status: "recovered";
      applied: true;
      jobId: string;
      kind: RecoverableTarget["kind"];
      fingerprint: string;
      lockPath: string;
      resumed: boolean;
    }
  | {
      status: "staging-cleaned";
      applied: true;
      jobId: string;
      fingerprint: string;
      lockPath: string;
      removedArtifacts: number;
    }
  | {
      status: "absent" | "refused";
      applied: false;
      jobId: string;
      lockPath: string;
      reason: string;
    };

type RecoveredOfflineFederatedLock = Extract<
  OfflineFederatedLockRecoveryResult,
  { status: "recovered" }
>;

interface RecoveryPaths {
  projectRoot: string;
  jobsDir: string;
  lockPath: string;
}

interface ExistingTransaction {
  intent?: { path: string; value: OfflineRecoveryIntent; identity: PhysicalIdentity };
  receipt?: { path: string; value: OfflineDeleteReceipt; identity: PhysicalIdentity };
  quarantinePath?: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function physicalIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>): PhysicalIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mtimeMs: Number(stat.mtimeMs),
    size: Number(stat.size),
  };
}

function hasUsableIdentity(identity: PhysicalIdentity): boolean {
  return (
    Number.isFinite(identity.dev) &&
    Number.isFinite(identity.ino) &&
    identity.ino > 0 &&
    Number.isFinite(identity.mtimeMs) &&
    Number.isFinite(identity.size) &&
    identity.size >= 0
  );
}

function sameIdentity(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function sameInode(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestTokenForFingerprint(fingerprint: string): string {
  const digest = sha256(`quack-federation-offline-lock-recovery/request-token\0${fingerprint}`);
  const variant = (8 + (Number.parseInt(digest[16] ?? "0", 16) & 0x3)).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function targetFingerprint(
  scope: Pick<RecoveryPaths, "projectRoot" | "lockPath">,
  jobId: string,
  target: RecoverableTarget,
): string {
  return sha256(
    JSON.stringify({
      protocol: "quack-federation-offline-lock-recovery/v1",
      projectRoot: scope.projectRoot,
      lockPath: scope.lockPath,
      jobId,
      targetKind: target.kind,
      target,
    }),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usesCaseInsensitiveArtifactNames(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

function isV1Record(value: unknown): value is V1LockRecord {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["acquiredAt", "host", "ownerToken", "pid", "version"].join("\0")) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.ownerToken === "string" &&
    UUID.test(value.ownerToken) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    value.host.length <= 255 &&
    Number.isInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt))
  );
}

function isPhysicalIdentity(value: unknown): value is PhysicalIdentity {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.dev === "number" &&
    typeof value.ino === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.size === "number" &&
    hasUsableIdentity(value as unknown as PhysicalIdentity)
  );
}

function isRecoverableTarget(value: unknown): value is RecoverableTarget {
  if (!isPlainObject(value) || !isPhysicalIdentity(value.lock)) return false;
  if (value.kind === "legacy-empty-file") {
    return (
      value.layout === "file" &&
      value.lock.size === 0 &&
      typeof value.contentSha256 === "string" &&
      value.contentSha256 === sha256(Buffer.alloc(0))
    );
  }
  if (value.kind !== "v1-file" && value.kind !== "v1-directory") return false;
  if (value.layout !== (value.kind === "v1-file" ? "file" : "directory")) return false;
  if (typeof value.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentSha256)) {
    return false;
  }
  if (!isV1Record(value.record)) return false;
  return value.kind === "v1-file" ? value.owner === undefined : isPhysicalIdentity(value.owner);
}

function isIntent(value: unknown): value is OfflineRecoveryIntent {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    value.kind === "offline-federation-lock-recovery" &&
    typeof value.requestToken === "string" &&
    UUID.test(value.requestToken) &&
    typeof value.jobId === "string" &&
    SAFE_JOB_ID.test(value.jobId) &&
    typeof value.projectRoot === "string" &&
    path.isAbsolute(value.projectRoot) &&
    typeof value.lockPath === "string" &&
    path.isAbsolute(value.lockPath) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.staleMs === "number" &&
    Number.isInteger(value.staleMs) &&
    value.staleMs > 0 &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.fingerprint) &&
    isRecoverableTarget(value.target) &&
    targetFingerprint(
      { projectRoot: value.projectRoot, lockPath: value.lockPath },
      value.jobId,
      value.target,
    ) === value.fingerprint
  );
}

function isReceipt(value: unknown): value is OfflineDeleteReceipt {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    value.kind === "offline-federation-lock-delete-authorized" &&
    typeof value.requestToken === "string" &&
    UUID.test(value.requestToken) &&
    typeof value.jobId === "string" &&
    SAFE_JOB_ID.test(value.jobId) &&
    typeof value.projectRoot === "string" &&
    path.isAbsolute(value.projectRoot) &&
    typeof value.lockPath === "string" &&
    path.isAbsolute(value.lockPath) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.fingerprint) &&
    ["legacy-empty-file", "v1-file", "v1-directory"].includes(value.targetKind as string) &&
    typeof value.authorizedAt === "string" &&
    Number.isFinite(Date.parse(value.authorizedAt))
  );
}

async function readStableFile(
  filePath: string,
): Promise<{ bytes: Buffer; identity: PhysicalIdentity } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    handle = await fs.open(filePath, "r");
    const bytes = await handle.readFile();
    const held = await handle.stat();
    const after = await fs.lstat(filePath);
    if (
      !held.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      held.dev !== after.dev ||
      held.ino !== after.ino
    ) {
      return undefined;
    }
    const identity = physicalIdentity(held);
    if (!hasUsableIdentity(identity) || identity.size !== bytes.length) return undefined;
    return { bytes, identity };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function stableRegularFileIdentity(filePath: string): Promise<PhysicalIdentity | undefined> {
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    const after = await fs.lstat(filePath);
    const beforeIdentity = physicalIdentity(before);
    const afterIdentity = physicalIdentity(after);
    if (!sameIdentity(beforeIdentity, afterIdentity) || !hasUsableIdentity(afterIdentity)) {
      return undefined;
    }
    return afterIdentity;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonArtifact(
  filePath: string,
): Promise<{ value: unknown; identity: PhysicalIdentity } | undefined> {
  const stable = await readStableFile(filePath);
  if (!stable) return undefined;
  try {
    return {
      value: JSON.parse(stable.bytes.toString("utf8")) as unknown,
      identity: stable.identity,
    };
  } catch {
    return undefined;
  }
}

async function resolveRecoveryPaths(projectRoot: string, jobId: string): Promise<RecoveryPaths> {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error("Federation job id contains unsafe path characters");
  }
  const canonicalRoot = await fs.realpath(path.resolve(projectRoot));
  let cursor = canonicalRoot;
  for (const segment of [".quack", "federation", "jobs"]) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Federation recovery path is not a physical directory: ${cursor}`);
    }
  }
  const lockPath = path.join(cursor, `${jobId}.lock`);
  if (path.dirname(lockPath) !== cursor) {
    throw new Error("Federation lock path escaped its jobs directory");
  }
  return { projectRoot: canonicalRoot, jobsDir: cursor, lockPath };
}

async function assertCanonicalArtifactSpelling(paths: RecoveryPaths): Promise<void> {
  if (!usesCaseInsensitiveArtifactNames()) return;
  const base = path.basename(paths.lockPath);
  const prefixes = [
    `${base}.reclaim-request.`,
    `${base}.release`,
    `${base}.owner.`,
    `${base}.publish.`,
    `${base}${OFFLINE_QUARANTINE_PREFIX}`,
    `${base}${OFFLINE_PUBLISH_PREFIX}`,
  ];
  const lowerBase = base.toLowerCase();
  const lowerPrefixes = prefixes.map((prefix) => prefix.toLowerCase());
  for (const name of await fs.readdir(paths.jobsDir)) {
    const lowerName = name.toLowerCase();
    const aliasesLock = lowerName === lowerBase && name !== base;
    const aliasIndex = lowerPrefixes.findIndex((prefix) => lowerName.startsWith(prefix));
    const aliasesControl = aliasIndex >= 0 && !name.startsWith(prefixes[aliasIndex]);
    if (aliasesLock || aliasesControl) {
      throw new Error(`Federation lock/control artifact has non-canonical casing: ${name}`);
    }
  }
}

async function inspectTargetAt(
  targetPath: string,
): Promise<{ target?: RecoverableTarget; reason?: string }> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reason: "lock is absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { reason: "lock is a symbolic link" };
  if (stat.isFile()) {
    const stable = await readStableFile(targetPath);
    if (!stable) return { reason: "lock identity changed while it was inspected" };
    if (stable.bytes.length === 0) {
      return {
        target: {
          kind: "legacy-empty-file",
          layout: "file",
          lock: stable.identity,
          contentSha256: sha256(stable.bytes),
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stable.bytes.toString("utf8")) as unknown;
    } catch {
      return { reason: "nonempty legacy or malformed lock evidence is not recoverable" };
    }
    if (!isV1Record(parsed)) {
      return { reason: "only an exact v1 record or zero-byte legacy file is recoverable" };
    }
    return {
      target: {
        kind: "v1-file",
        layout: "file",
        lock: stable.identity,
        contentSha256: sha256(stable.bytes),
        record: parsed,
      },
    };
  }
  if (!stat.isDirectory()) return { reason: "lock has an unsupported filesystem type" };

  const entries = await fs.readdir(targetPath);
  if (entries.length !== 1) {
    return { reason: "v1 lock directory must contain exactly one owner record" };
  }
  const ownerName = entries[0] ?? "";
  const ownerMatch = /^owner-([0-9a-f-]{36})\.json$/iu.exec(ownerName);
  if (!ownerMatch || !UUID.test(ownerMatch[1] ?? "")) {
    return { reason: "v1 lock directory has an invalid owner entry" };
  }
  const ownerPath = path.join(targetPath, ownerName);
  const stable = await readStableFile(ownerPath);
  if (!stable) return { reason: "v1 owner identity changed while it was inspected" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stable.bytes.toString("utf8")) as unknown;
  } catch {
    return { reason: "v1 owner record is malformed" };
  }
  if (
    !isV1Record(parsed) ||
    parsed.ownerToken.toLowerCase() !== (ownerMatch[1] ?? "").toLowerCase()
  ) {
    return { reason: "v1 owner record does not match its filename" };
  }
  const finalLock = await fs.lstat(targetPath);
  const lockIdentity = physicalIdentity(finalLock);
  if (
    finalLock.isSymbolicLink() ||
    !finalLock.isDirectory() ||
    finalLock.dev !== stat.dev ||
    finalLock.ino !== stat.ino ||
    !hasUsableIdentity(lockIdentity)
  ) {
    return { reason: "v1 lock directory identity changed while it was inspected" };
  }
  return {
    target: {
      kind: "v1-directory",
      layout: "directory",
      lock: lockIdentity,
      owner: stable.identity,
      contentSha256: sha256(stable.bytes),
      record: parsed,
    },
  };
}

function targetMtime(target: RecoverableTarget): number {
  return target.kind === "v1-directory" ? target.owner!.mtimeMs : target.lock.mtimeMs;
}

function targetMatches(left: RecoverableTarget, right: RecoverableTarget): boolean {
  return (
    left.kind === right.kind &&
    left.layout === right.layout &&
    sameIdentity(left.lock, right.lock) &&
    ((left.kind !== "v1-directory" && right.kind !== "v1-directory") ||
      (left.kind === "v1-directory" &&
        right.kind === "v1-directory" &&
        sameIdentity(left.owner!, right.owner!))) &&
    left.contentSha256 === right.contentSha256 &&
    (left.kind === "legacy-empty-file" ||
      (right.kind !== "legacy-empty-file" &&
        JSON.stringify(left.record) === JSON.stringify(right.record)))
  );
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  // Node cannot open Windows directories for fsync. The durable file intent
  // and receipt are flushed directly there, matching the main lock protocol.
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      !["EINVAL", "EPERM", "ENOTSUP", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncQuarantinedTarget(
  paths: RecoveryPaths,
  quarantinePath: string,
  target: RecoverableTarget,
): Promise<void> {
  if (target.layout === "file") {
    await syncFile(quarantinePath);
  } else {
    const entries = await fs.readdir(quarantinePath);
    if (entries.length !== 1) {
      throw new Error("Quarantined lock changed before its deletion receipt was made durable");
    }
    await syncFile(path.join(quarantinePath, entries[0]));
    await syncDirectoryIfSupported(quarantinePath);
  }
  await syncDirectoryIfSupported(paths.jobsDir);
}

type QuarantineCaptureResult =
  | "captured"
  | "peer-progress"
  | "preexisting-mismatch"
  | "replacement-restored";

const quarantineTransitions = new Map<string, Promise<void>>();
const completedRecoveryWitnesses = new Map<string, string>();

function recoveryWitnessKey(paths: RecoveryPaths): string {
  return usesCaseInsensitiveArtifactNames() ? paths.lockPath.toLowerCase() : paths.lockPath;
}

function recordCompletedRecovery(paths: RecoveryPaths, fingerprint: string): void {
  const key = recoveryWitnessKey(paths);
  completedRecoveryWitnesses.set(key, fingerprint);
  const expiry = setTimeout(() => {
    if (completedRecoveryWitnesses.get(key) === fingerprint) {
      completedRecoveryWitnesses.delete(key);
    }
  }, 60_000);
  expiry.unref();
}

function hasCompletedRecoveryWitness(paths: RecoveryPaths, fingerprint: string): boolean {
  return completedRecoveryWitnesses.get(recoveryWitnessKey(paths)) === fingerprint;
}

async function finishObservedPeerCompletion(
  paths: RecoveryPaths,
  intent: NonNullable<ExistingTransaction["intent"]>,
  receipt: ExistingTransaction["receipt"],
  options: OfflineFederatedLockRecoveryOptions,
): Promise<RecoveredOfflineFederatedLock> {
  await cleanupPublishStaging(paths, intent.value.requestToken);
  if (receipt) {
    await unlinkExactIfPresent(receipt.path, receipt.identity);
    recordCompletedRecovery(paths, intent.value.fingerprint);
    await options.afterStageForTest?.("receipt_removed");
  } else {
    recordCompletedRecovery(paths, intent.value.fingerprint);
  }
  return {
    status: "recovered",
    applied: true,
    jobId: options.jobId,
    kind: intent.value.target.kind,
    fingerprint: intent.value.fingerprint,
    lockPath: paths.lockPath,
    resumed: true,
  };
}

async function withSerializedQuarantineTransition<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = usesCaseInsensitiveArtifactNames() ? lockPath.toLowerCase() : lockPath;
  const previous = quarantineTransitions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  quarantineTransitions.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (quarantineTransitions.get(key) === current) quarantineTransitions.delete(key);
  }
}

async function removeUnexpectedFileCapture(
  quarantinePath: string,
  createdIdentity: PhysicalIdentity,
): Promise<void> {
  await unlinkExactIfPresent(quarantinePath, createdIdentity);
}

async function restoreUnexpectedDirectoryCapture(
  paths: RecoveryPaths,
  quarantinePath: string,
): Promise<boolean> {
  const observed = await fs.lstat(quarantinePath);
  const expected = physicalIdentity(observed);
  if (!observed.isDirectory() || observed.isSymbolicLink() || !hasUsableIdentity(expected)) {
    throw new Error("Unexpected directory quarantine cannot be safely rolled back");
  }
  const expectedEntries = (await fs.readdir(quarantinePath)).sort();
  const deadline = Date.now() + OFFLINE_DIRECTORY_REMOVE_TIMEOUT_MS;
  for (;;) {
    const current = await fs.lstat(quarantinePath);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(physicalIdentity(current), expected) ||
      JSON.stringify((await fs.readdir(quarantinePath)).sort()) !== JSON.stringify(expectedEntries)
    ) {
      throw new Error("Unexpected directory quarantine changed before rollback");
    }
    if (await pathExists(paths.lockPath)) return false;
    try {
      await fs.rename(quarantinePath, paths.lockPath);
      const restored = await fs.lstat(paths.lockPath);
      if (
        !restored.isDirectory() ||
        restored.isSymbolicLink() ||
        !sameIdentity(physicalIdentity(restored), expected) ||
        JSON.stringify((await fs.readdir(paths.lockPath)).sort()) !==
          JSON.stringify(expectedEntries)
      ) {
        throw new Error("Unexpected directory quarantine rollback lost its inode binding");
      }
      await syncDirectoryIfSupported(paths.jobsDir);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && (await pathExists(paths.lockPath))) {
        const restored = await fs.lstat(paths.lockPath);
        return (
          restored.isDirectory() &&
          !restored.isSymbolicLink() &&
          sameIdentity(physicalIdentity(restored), expected) &&
          JSON.stringify((await fs.readdir(paths.lockPath)).sort()) ===
            JSON.stringify(expectedEntries)
        );
      }
      if (
        !["EPERM", "EACCES", "EBUSY", "EEXIST", "ENOTEMPTY"].includes(code ?? "") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      if (await pathExists(paths.lockPath)) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, OFFLINE_DIRECTORY_REMOVE_RETRY_MS));
    }
  }
}

async function quarantineExactTarget(
  paths: RecoveryPaths,
  quarantinePath: string,
  target: RecoverableTarget,
  afterStageForTest?: OfflineFederatedLockRecoveryOptions["afterStageForTest"],
): Promise<QuarantineCaptureResult> {
  if (!(await inspectExactTarget(paths.lockPath, target))) {
    return (await pathExists(paths.lockPath)) ? "preexisting-mismatch" : "peer-progress";
  }
  await afterStageForTest?.("canonical_verified");

  if (target.layout === "file") {
    let linkedHere = false;
    let linkedIdentity: PhysicalIdentity | undefined;
    try {
      await fs.link(paths.lockPath, quarantinePath);
      linkedHere = true;
      const linked = await fs.lstat(quarantinePath);
      linkedIdentity = physicalIdentity(linked);
      if (linked.isSymbolicLink() || !linked.isFile() || !hasUsableIdentity(linkedIdentity)) {
        throw new Error("Created file quarantine has an unsafe filesystem identity");
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "peer-progress";
      if (
        code !== "EEXIST" &&
        !(["EPERM", "EACCES"].includes(code ?? "") && (await pathExists(quarantinePath)))
      ) {
        throw error;
      }
    }
    if (!(await inspectExactTarget(quarantinePath, target))) {
      if (linkedHere && linkedIdentity) {
        await removeUnexpectedFileCapture(quarantinePath, linkedIdentity);
      }
      return linkedHere ? "replacement-restored" : "peer-progress";
    }
    await syncQuarantinedTarget(paths, quarantinePath, target);
    if (linkedHere) await afterStageForTest?.("quarantine_linked");
    if (!(await inspectExactTarget(paths.lockPath, target))) {
      if (await pathExists(paths.lockPath)) {
        if (linkedHere && linkedIdentity) {
          await removeUnexpectedFileCapture(quarantinePath, linkedIdentity);
        }
        return linkedHere ? "replacement-restored" : "peer-progress";
      }
      return "peer-progress";
    }
    try {
      await unlinkExact(paths.lockPath, target.lock);
    } catch (error: unknown) {
      if (
        linkedHere &&
        (await pathExists(paths.lockPath)) &&
        !(await inspectExactTarget(paths.lockPath, target))
      ) {
        if (linkedIdentity) await removeUnexpectedFileCapture(quarantinePath, linkedIdentity);
        return "replacement-restored";
      }
      throw error;
    }
    return linkedHere ? "captured" : "peer-progress";
  }

  if (await pathExists(quarantinePath)) return "peer-progress";
  let movedHere = false;
  try {
    await fs.rename(paths.lockPath, quarantinePath);
    movedHere = true;
    await afterStageForTest?.("directory_quarantine_moved");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "")) {
      throw error;
    }
  }
  if (await inspectExactTarget(quarantinePath, target)) {
    return movedHere ? "captured" : "peer-progress";
  }
  if (!movedHere) return "peer-progress";
  if (await restoreUnexpectedDirectoryCapture(paths, quarantinePath)) {
    return "replacement-restored";
  }
  throw new Error(
    "Replacement directory was quarantined and could not be restored without overwriting canonical evidence",
  );
}

async function unlinkExact(filePath: string, expected: PhysicalIdentity): Promise<boolean> {
  const deadline = Date.now() + OFFLINE_DIRECTORY_REMOVE_TIMEOUT_MS;
  for (;;) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const observed = physicalIdentity(stat);
    if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(observed, expected)) {
      throw new Error(`Offline recovery artifact identity changed before cleanup: ${filePath}`);
    }
    try {
      await fs.unlink(filePath);
      await syncDirectoryIfSupported(path.dirname(filePath));
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, OFFLINE_DIRECTORY_REMOVE_RETRY_MS));
    }
  }
}

async function unlinkExactIfPresent(
  filePath: string,
  expected: PhysicalIdentity,
): Promise<boolean> {
  try {
    return await unlinkExact(filePath, expected);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

interface PublishedArtifact<T> {
  value: T;
  identity: PhysicalIdentity;
  created: boolean;
}

async function publishJsonSingleton<T>(
  paths: RecoveryPaths,
  filePath: string,
  candidate: T,
  artifactKind: "intent" | "receipt",
  isValue: (value: unknown) => value is T,
  compatible: (value: T) => boolean,
  afterStageForTest?: OfflineFederatedLockRecoveryOptions["afterStageForTest"],
): Promise<PublishedArtifact<T>> {
  const existing = await readJsonArtifact(filePath);
  if (existing) {
    if (!isValue(existing.value) || !compatible(existing.value)) {
      throw new Error(`Conflicting offline recovery ${artifactKind} already exists`);
    }
    return { value: existing.value, identity: existing.identity, created: false };
  }
  if (await pathExists(filePath)) {
    throw new Error(`Malformed offline recovery ${artifactKind} already exists`);
  }

  const requestToken =
    isPlainObject(candidate) && typeof candidate.requestToken === "string"
      ? candidate.requestToken
      : "unknown";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const winnerBeforeStage = await readJsonArtifact(filePath);
    if (winnerBeforeStage) {
      if (!isValue(winnerBeforeStage.value) || !compatible(winnerBeforeStage.value)) {
        throw new Error(`Conflicting offline recovery ${artifactKind} already exists`);
      }
      return {
        value: winnerBeforeStage.value,
        identity: winnerBeforeStage.identity,
        created: false,
      };
    }
    if (await pathExists(filePath)) {
      throw new Error(`Malformed offline recovery ${artifactKind} already exists`);
    }
    const stagingPath = `${paths.lockPath}${OFFLINE_PUBLISH_PREFIX}${artifactKind}.${requestToken}.${randomUUID()}.json`;
    let stagingIdentity: PhysicalIdentity | undefined;
    let linked = false;
    try {
      const handle = await fs.open(stagingPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(candidate)}\n`, "utf8");
        await handle.sync();
        stagingIdentity = physicalIdentity(await handle.stat());
      } finally {
        await handle.close();
      }
      if (!stagingIdentity || !hasUsableIdentity(stagingIdentity)) {
        throw new Error(`Offline recovery ${artifactKind} staging identity is unavailable`);
      }
      await afterStageForTest?.(artifactKind === "intent" ? "intent_staged" : "receipt_staged");
      try {
        await fs.link(stagingPath, filePath);
        linked = true;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (
          code !== "EEXIST" &&
          !(["EPERM", "EACCES"].includes(code ?? "") && (await pathExists(filePath)))
        ) {
          throw error;
        }
      }
      const published = await readJsonArtifact(filePath);
      if (!published) {
        if (!(await pathExists(filePath))) continue;
        throw new Error(`Malformed offline recovery ${artifactKind} won publication`);
      }
      if (!isValue(published.value) || !compatible(published.value)) {
        throw new Error(`Conflicting offline recovery ${artifactKind} won publication`);
      }
      await syncFile(filePath);
      await syncDirectoryIfSupported(paths.jobsDir);
      return {
        value: published.value,
        identity: published.identity,
        created: linked,
      };
    } finally {
      if (stagingIdentity) await unlinkExactIfPresent(stagingPath, stagingIdentity);
    }
  }
  throw new Error(`Offline recovery ${artifactKind} publication did not converge`);
}

function artifactPaths(
  lockPath: string,
  token: string,
): {
  intentPath: string;
  receiptPath: string;
  quarantinePath: string;
} {
  return {
    intentPath: `${lockPath}${OFFLINE_REQUEST_SUFFIX}`,
    receiptPath: `${lockPath}${OFFLINE_RECEIPT_SUFFIX}`,
    quarantinePath: `${lockPath}${OFFLINE_QUARANTINE_PREFIX}${token}`,
  };
}

async function listPublishStaging(paths: RecoveryPaths): Promise<string[]> {
  const prefix = `${path.basename(paths.lockPath)}${OFFLINE_PUBLISH_PREFIX}`;
  return (await fs.readdir(paths.jobsDir)).filter((name) => name.startsWith(prefix)).sort();
}

async function cleanupPublishStaging(paths: RecoveryPaths, requestToken: string): Promise<number> {
  const prefix = `${path.basename(paths.lockPath)}${OFFLINE_PUBLISH_PREFIX}`;
  const stagingName = new RegExp(
    `^(intent|receipt)\\.(${UUID_TEXT})\\.(${UUID_TEXT})\\.json$`,
    "iu",
  );
  const candidates: Array<{ path: string; identity: PhysicalIdentity }> = [];
  for (const name of await listPublishStaging(paths)) {
    const stagingPath = path.join(paths.jobsDir, name);
    const match = stagingName.exec(name.slice(prefix.length));
    if (!match || match[2]?.toLowerCase() !== requestToken.toLowerCase()) {
      throw new Error(`Mismatched offline recovery publication staging artifact: ${stagingPath}`);
    }
    const identity = await stableRegularFileIdentity(stagingPath);
    if (!identity) {
      if (!(await pathExists(stagingPath))) continue;
      throw new Error(`Unsafe offline recovery publication staging artifact: ${stagingPath}`);
    }
    candidates.push({ path: stagingPath, identity });
  }
  let removed = 0;
  for (const candidate of candidates) {
    if (await unlinkExactIfPresent(candidate.path, candidate.identity)) removed += 1;
  }
  return removed;
}

async function listRelevantArtifacts(lockPath: string): Promise<string[]> {
  const directory = path.dirname(lockPath);
  const base = path.basename(lockPath);
  return (await fs.readdir(directory))
    .filter(
      (name) =>
        name.startsWith(`${base}.reclaim-request.`) ||
        name.startsWith(`${base}.release`) ||
        name.startsWith(`${base}.owner.`) ||
        name.startsWith(`${base}.publish.`) ||
        name.startsWith(`${base}.offline-recovery-quarantine.`),
    )
    .sort();
}

async function findTransaction(paths: RecoveryPaths, jobId: string): Promise<ExistingTransaction> {
  const { lockPath } = paths;
  const artifacts = await listRelevantArtifacts(lockPath);
  if (artifacts.length === 0) return {};

  let intent: ExistingTransaction["intent"];
  let receipt: ExistingTransaction["receipt"];
  let quarantinePath: string | undefined;
  for (const name of artifacts) {
    const filePath = path.join(path.dirname(lockPath), name);
    if (name.includes(OFFLINE_QUARANTINE_PREFIX)) {
      if (quarantinePath)
        throw new Error("Multiple offline lock quarantines require manual review");
      quarantinePath = filePath;
      continue;
    }
    const parsed = await readJsonArtifact(filePath);
    if (!parsed) throw new Error(`Unknown or malformed lock control artifact: ${filePath}`);
    if (isIntent(parsed.value)) {
      if (intent) throw new Error("Multiple offline lock recovery requests require manual review");
      intent = { path: filePath, value: parsed.value, identity: parsed.identity };
      continue;
    }
    if (isReceipt(parsed.value)) {
      if (receipt) throw new Error("Multiple offline lock recovery receipts require manual review");
      receipt = { path: filePath, value: parsed.value, identity: parsed.identity };
      continue;
    }
    throw new Error(`Unrelated lock control artifact blocks offline recovery: ${filePath}`);
  }

  const token = intent?.value.requestToken ?? receipt?.value.requestToken;
  if (!token) throw new Error("Offline lock quarantine has no durable recovery request");
  const expected = artifactPaths(lockPath, token);
  if (
    (intent &&
      (intent.path !== expected.intentPath ||
        intent.value.jobId !== jobId ||
        intent.value.projectRoot !== paths.projectRoot ||
        intent.value.lockPath !== paths.lockPath)) ||
    (receipt &&
      (receipt.path !== expected.receiptPath ||
        receipt.value.jobId !== jobId ||
        receipt.value.projectRoot !== paths.projectRoot ||
        receipt.value.lockPath !== paths.lockPath)) ||
    (quarantinePath && quarantinePath !== expected.quarantinePath) ||
    (intent &&
      receipt &&
      (intent.value.requestToken !== receipt.value.requestToken ||
        intent.value.fingerprint !== receipt.value.fingerprint ||
        intent.value.target.kind !== receipt.value.targetKind))
  ) {
    throw new Error("Offline lock recovery artifacts do not describe one exact transaction");
  }
  return { intent, receipt, quarantinePath };
}

function verifyEligibleTarget(
  target: RecoverableTarget,
  staleMs: number,
  now: number,
): { ageMs: number; reason?: string } {
  const ageMs = now - targetMtime(target);
  if (!Number.isFinite(ageMs) || ageMs <= staleMs) {
    return { ageMs, reason: `lock is fresh (age ${Math.max(0, Math.floor(ageMs))} ms)` };
  }
  if (
    target.kind !== "legacy-empty-file" &&
    target.record.host.toLowerCase() !== hostname().toLowerCase()
  ) {
    return { ageMs, reason: "v1 lock belongs to a different host" };
  }
  return { ageMs };
}

async function inspectExactTarget(
  targetPath: string,
  expected: RecoverableTarget,
): Promise<boolean> {
  const observed = await inspectTargetAt(targetPath);
  return Boolean(observed.target && targetMatches(observed.target, expected));
}

async function isExactEmptyDirectoryQuarantine(
  quarantinePath: string,
  target: RecoverableTarget,
): Promise<boolean> {
  if (target.kind !== "v1-directory") return false;
  try {
    const stat = await fs.lstat(quarantinePath);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      sameInode(physicalIdentity(stat), target.lock) &&
      (await fs.readdir(quarantinePath)).length === 0
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeExactEmptyDirectory(
  quarantinePath: string,
  expected: PhysicalIdentity,
): Promise<void> {
  const deadline = Date.now() + OFFLINE_DIRECTORY_REMOVE_TIMEOUT_MS;
  for (;;) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(quarantinePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameInode(physicalIdentity(stat), expected) ||
      (await fs.readdir(quarantinePath)).length !== 0
    ) {
      throw new Error("Offline lock quarantine directory changed before bounded removal");
    }
    try {
      await fs.rmdir(quarantinePath);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (
        !["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(code ?? "") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, OFFLINE_DIRECTORY_REMOVE_RETRY_MS));
    }
  }
}

async function removeExactQuarantine(
  quarantinePath: string,
  target: RecoverableTarget,
  afterStageForTest?: OfflineFederatedLockRecoveryOptions["afterStageForTest"],
): Promise<void> {
  const exactTarget = await inspectExactTarget(quarantinePath, target);
  const resumableEmptyDirectory = await isExactEmptyDirectoryQuarantine(quarantinePath, target);
  if (!exactTarget && !resumableEmptyDirectory) {
    if (!(await pathExists(quarantinePath))) return;
    throw new Error("Offline lock quarantine identity or contents changed before deletion");
  }
  if (target.layout === "file") {
    await unlinkExactIfPresent(quarantinePath, target.lock);
  } else {
    if (!resumableEmptyDirectory) {
      let entries: string[];
      try {
        entries = await fs.readdir(quarantinePath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (entries.length !== 1) {
        throw new Error("Offline lock quarantine gained unexpected directory entries");
      }
      const ownerPath = path.join(quarantinePath, entries[0]);
      try {
        const ownerStat = await fs.lstat(ownerPath);
        if (!target.owner || !sameIdentity(physicalIdentity(ownerStat), target.owner)) {
          throw new Error("Offline lock quarantine owner inode changed before deletion");
        }
        await fs.unlink(ownerPath);
        await afterStageForTest?.("directory_owner_removed");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await removeExactEmptyDirectory(quarantinePath, target.lock);
  }
  await syncDirectoryIfSupported(path.dirname(quarantinePath));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pendingTransactionStateError(
  paths: RecoveryPaths,
  transaction: ExistingTransaction,
): Promise<string | undefined> {
  const token = transaction.intent?.value.requestToken ?? transaction.receipt?.value.requestToken;
  if (!token) return "Offline recovery transaction has no durable identity";
  const expected = artifactPaths(paths.lockPath, token);
  const canonicalExists = await pathExists(paths.lockPath);
  const quarantineExists = await pathExists(expected.quarantinePath);
  const target = transaction.intent?.value.target;
  if (!target && quarantineExists) {
    return "Receipt-only recovery has unexpected remaining quarantine evidence";
  }
  const exactQuarantine = Boolean(
    target &&
    quarantineExists &&
    ((await inspectExactTarget(expected.quarantinePath, target)) ||
      (transaction.receipt &&
        (await isExactEmptyDirectoryQuarantine(expected.quarantinePath, target)))),
  );
  const resumableDisplacedDirectory = Boolean(
    target?.layout === "directory" &&
    quarantineExists &&
    !canonicalExists &&
    !transaction.receipt &&
    !exactQuarantine,
  );
  if (canonicalExists && quarantineExists && !exactQuarantine) {
    return "Both canonical and quarantined lock evidence exist; recovery is ambiguous";
  }
  if (transaction.receipt && canonicalExists && !quarantineExists) {
    return "Delete authorization exists while the canonical lock is present";
  }
  if (
    target &&
    canonicalExists &&
    !quarantineExists &&
    !(await inspectExactTarget(paths.lockPath, target))
  ) {
    return "Canonical lock no longer matches the authorized inode and contents";
  }
  if (target && quarantineExists && !exactQuarantine && !resumableDisplacedDirectory) {
    return "Quarantined lock no longer matches the authorized inode and contents";
  }
  if (!canonicalExists && !quarantineExists && !transaction.receipt) {
    return "Recovery request lost both canonical and quarantined evidence before deletion";
  }
  return undefined;
}

function receiptMatchesIntent(
  receipt: OfflineDeleteReceipt,
  intent: OfflineRecoveryIntent,
): boolean {
  return (
    receipt.requestToken === intent.requestToken &&
    receipt.jobId === intent.jobId &&
    receipt.projectRoot === intent.projectRoot &&
    receipt.lockPath === intent.lockPath &&
    receipt.host.toLowerCase() === intent.host.toLowerCase() &&
    receipt.fingerprint === intent.fingerprint &&
    receipt.targetKind === intent.target.kind
  );
}

async function loadReceiptForIntent(
  receiptPath: string,
  intent: OfflineRecoveryIntent,
): Promise<ExistingTransaction["receipt"]> {
  const parsed = await readJsonArtifact(receiptPath);
  if (!parsed) {
    if (await pathExists(receiptPath)) {
      throw new Error("Offline recovery receipt is malformed");
    }
    return undefined;
  }
  if (!isReceipt(parsed.value) || !receiptMatchesIntent(parsed.value, intent)) {
    throw new Error("Offline recovery receipt does not match its durable intent");
  }
  return { path: receiptPath, value: parsed.value, identity: parsed.identity };
}

async function finishTransaction(
  paths: RecoveryPaths,
  transaction: Required<Pick<ExistingTransaction, "intent">> & ExistingTransaction,
  options: OfflineFederatedLockRecoveryOptions,
): Promise<RecoveredOfflineFederatedLock> {
  const { intent } = transaction;
  const expectedPaths = artifactPaths(paths.lockPath, intent.value.requestToken);
  const fingerprint = intent.value.fingerprint;
  if (!options.confirmOffline || options.expectedFingerprint !== fingerprint) {
    throw new Error(
      "Apply requires --confirm-offline and --expected-fingerprint from the exact dry-run inspection",
    );
  }
  if (intent.value.host.toLowerCase() !== hostname().toLowerCase()) {
    throw new Error("Offline recovery request was created on a different host");
  }

  let receipt =
    transaction.receipt ?? (await loadReceiptForIntent(expectedPaths.receiptPath, intent.value));
  let canonicalExists = await pathExists(paths.lockPath);
  let quarantineExists = await pathExists(expectedPaths.quarantinePath);
  let intentExists = await pathExists(intent.path);
  let quarantineSynced = false;
  let canonicalReplacementPresent = false;
  let peerCompletionObserved = false;
  const exactInitialQuarantine = Boolean(
    quarantineExists &&
    (await inspectExactTarget(expectedPaths.quarantinePath, intent.value.target)),
  );
  const partialInitialDirectory = Boolean(
    quarantineExists &&
    receipt &&
    (await isExactEmptyDirectoryQuarantine(expectedPaths.quarantinePath, intent.value.target)),
  );
  if (
    intent.value.target.layout === "directory" &&
    quarantineExists &&
    !canonicalExists &&
    !receipt &&
    !exactInitialQuarantine &&
    !partialInitialDirectory
  ) {
    await options.afterStageForTest?.("displaced_quarantine_snapshot");
    const resolution = await withSerializedQuarantineTransition(paths.lockPath, async () => {
      let refreshedReceipt = await loadReceiptForIntent(expectedPaths.receiptPath, intent.value);
      const currentCanonicalExists = await pathExists(paths.lockPath);
      const currentQuarantineExists = await pathExists(expectedPaths.quarantinePath);
      if (!currentQuarantineExists) {
        refreshedReceipt ??= await loadReceiptForIntent(expectedPaths.receiptPath, intent.value);
        const currentIntentExists = await pathExists(intent.path);
        if (refreshedReceipt) {
          return {
            state: "peer-progress" as const,
            receipt: refreshedReceipt,
            canonicalExists: currentCanonicalExists,
            quarantineExists: false,
            intentExists: currentIntentExists,
          };
        }
        if (!currentCanonicalExists && !currentIntentExists) {
          return {
            state: "peer-completed" as const,
            receipt: refreshedReceipt,
            canonicalExists: false,
            quarantineExists: false,
            intentExists: false,
          };
        }
        throw new Error(
          "Quarantined directory disappeared without complete peer recovery evidence",
        );
      }
      const exactQuarantine = await inspectExactTarget(
        expectedPaths.quarantinePath,
        intent.value.target,
      );
      const exactReceiptAuthorizedEmpty = Boolean(
        refreshedReceipt &&
        (await isExactEmptyDirectoryQuarantine(expectedPaths.quarantinePath, intent.value.target)),
      );
      if (refreshedReceipt) {
        if (!exactQuarantine && !exactReceiptAuthorizedEmpty) {
          throw new Error(
            "Delete authorization exists for a quarantine with changed identity or contents",
          );
        }
        return {
          state: "peer-progress" as const,
          receipt: refreshedReceipt,
          canonicalExists: currentCanonicalExists,
          quarantineExists: true,
          intentExists: await pathExists(intent.path),
        };
      }
      if (exactQuarantine) {
        return {
          state: "peer-progress" as const,
          receipt: undefined,
          canonicalExists: currentCanonicalExists,
          quarantineExists: true,
          intentExists: await pathExists(intent.path),
        };
      }
      await options.afterStageForTest?.("displaced_quarantine_reinspected");
      refreshedReceipt ??= await loadReceiptForIntent(expectedPaths.receiptPath, intent.value);
      if (refreshedReceipt) {
        const nowExactQuarantine = await inspectExactTarget(
          expectedPaths.quarantinePath,
          intent.value.target,
        );
        const nowExactReceiptAuthorizedEmpty = await isExactEmptyDirectoryQuarantine(
          expectedPaths.quarantinePath,
          intent.value.target,
        );
        if (!nowExactQuarantine && !nowExactReceiptAuthorizedEmpty) {
          throw new Error(
            "Delete authorization exists for a quarantine with changed identity or contents",
          );
        }
        return {
          state: "peer-progress" as const,
          receipt: refreshedReceipt,
          canonicalExists: await pathExists(paths.lockPath),
          quarantineExists: true,
          intentExists: await pathExists(intent.path),
        };
      }
      if (currentCanonicalExists) {
        throw new Error(
          "Captured replacement directory cannot be restored over canonical evidence",
        );
      }
      const restored = await restoreUnexpectedDirectoryCapture(paths, expectedPaths.quarantinePath);
      return {
        state: restored ? ("restored" as const) : ("conflict" as const),
        receipt: undefined,
        canonicalExists: restored,
        quarantineExists: !restored,
        intentExists: await pathExists(intent.path),
      };
    });
    receipt ??= resolution.receipt;
    canonicalExists = resolution.canonicalExists;
    quarantineExists = resolution.quarantineExists;
    intentExists = resolution.intentExists;
    peerCompletionObserved = resolution.state === "peer-completed";
    if (resolution.state === "restored") {
      await unlinkExactIfPresent(intent.path, intent.identity);
      throw new Error(
        "Canonical lock changed during quarantine; captured replacement evidence was restored",
      );
    }
    if (resolution.state === "conflict") {
      throw new Error(
        "Captured replacement directory could not be restored without overwriting canonical evidence",
      );
    }
  }
  if (!intentExists && !canonicalExists && !quarantineExists) {
    if (receipt || peerCompletionObserved || hasCompletedRecoveryWitness(paths, fingerprint)) {
      return finishObservedPeerCompletion(paths, intent, receipt, options);
    }
    throw new Error("Recovery transaction evidence disappeared without a completion receipt");
  }
  if (!intentExists) {
    throw new Error("Offline recovery intent disappeared before the transaction completed");
  }
  if (canonicalExists && quarantineExists) {
    const exactQuarantine =
      (await inspectExactTarget(expectedPaths.quarantinePath, intent.value.target)) ||
      Boolean(
        receipt &&
        (await isExactEmptyDirectoryQuarantine(expectedPaths.quarantinePath, intent.value.target)),
      );
    if (!exactQuarantine) {
      throw new Error(
        "Both canonical and quarantined lock evidence exist; refusing ambiguous recovery",
      );
    }
    canonicalReplacementPresent = !(await inspectExactTarget(paths.lockPath, intent.value.target));
  }
  if (receipt && canonicalExists && !quarantineExists) {
    throw new Error("Delete authorization exists while the canonical lock is present");
  }

  if (canonicalExists && !canonicalReplacementPresent) {
    const eligibility = verifyEligibleTarget(
      intent.value.target,
      intent.value.staleMs,
      (options.nowForTest ?? Date.now)(),
    );
    if (eligibility.reason) throw new Error(eligibility.reason);
    const capture = await withSerializedQuarantineTransition(paths.lockPath, () =>
      quarantineExactTarget(
        paths,
        expectedPaths.quarantinePath,
        intent.value.target,
        options.afterStageForTest,
      ),
    );
    if (capture === "preexisting-mismatch") {
      throw new Error("Canonical lock no longer matches the authorized inode and contents");
    }
    if (capture === "replacement-restored") {
      await unlinkExactIfPresent(intent.path, intent.identity);
      throw new Error(
        "Canonical lock changed after validation; replacement evidence was preserved",
      );
    }
    const exactQuarantine = await inspectExactTarget(
      expectedPaths.quarantinePath,
      intent.value.target,
    );
    receipt ??= await loadReceiptForIntent(expectedPaths.receiptPath, intent.value);
    const exactPartialDirectory = Boolean(
      receipt &&
      (await isExactEmptyDirectoryQuarantine(expectedPaths.quarantinePath, intent.value.target)),
    );
    if (!exactQuarantine && !exactPartialDirectory) {
      if (
        !(await pathExists(paths.lockPath)) &&
        !(await pathExists(expectedPaths.quarantinePath)) &&
        !(await pathExists(intent.path)) &&
        !receipt
      ) {
        return {
          status: "recovered",
          applied: true,
          jobId: options.jobId,
          kind: intent.value.target.kind,
          fingerprint,
          lockPath: paths.lockPath,
          resumed: true,
        };
      }
      throw new Error("Quarantined lock does not retain the authorized inode and contents");
    }
    if (capture === "captured") {
      await syncQuarantinedTarget(paths, expectedPaths.quarantinePath, intent.value.target);
      quarantineSynced = true;
      await options.afterStageForTest?.("lock_quarantined");
    }
  } else if (!quarantineExists && !receipt) {
    throw new Error(
      "Recovery request lost both canonical and quarantined evidence before deletion",
    );
  }

  receipt ??= await loadReceiptForIntent(expectedPaths.receiptPath, intent.value);
  if (
    !(await pathExists(paths.lockPath)) &&
    !(await pathExists(expectedPaths.quarantinePath)) &&
    !(await pathExists(intent.path))
  ) {
    if (!receipt && !peerCompletionObserved && !hasCompletedRecoveryWitness(paths, fingerprint)) {
      throw new Error("Recovery transaction evidence disappeared without a completion receipt");
    }
    return finishObservedPeerCompletion(paths, intent, receipt, options);
  }
  if (!receipt) {
    if (!(await inspectExactTarget(expectedPaths.quarantinePath, intent.value.target))) {
      throw new Error("Quarantined lock no longer matches the authorized inode and contents");
    }
    if (!quarantineSynced) {
      await syncQuarantinedTarget(paths, expectedPaths.quarantinePath, intent.value.target);
    }
    const receiptValue: OfflineDeleteReceipt = {
      version: 1,
      kind: "offline-federation-lock-delete-authorized",
      requestToken: intent.value.requestToken,
      jobId: intent.value.jobId,
      projectRoot: intent.value.projectRoot,
      lockPath: intent.value.lockPath,
      host: hostname(),
      fingerprint,
      targetKind: intent.value.target.kind,
      authorizedAt: new Date((options.nowForTest ?? Date.now)()).toISOString(),
    };
    const published = await publishJsonSingleton(
      paths,
      expectedPaths.receiptPath,
      receiptValue,
      "receipt",
      isReceipt,
      (existing) =>
        existing.requestToken === intent.value.requestToken &&
        existing.jobId === intent.value.jobId &&
        existing.projectRoot === intent.value.projectRoot &&
        existing.lockPath === intent.value.lockPath &&
        existing.host.toLowerCase() === intent.value.host.toLowerCase() &&
        existing.fingerprint === fingerprint &&
        existing.targetKind === intent.value.target.kind,
      options.afterStageForTest,
    );
    receipt = {
      path: expectedPaths.receiptPath,
      value: published.value,
      identity: published.identity,
    };
    await options.afterStageForTest?.("delete_authorized");
  }

  if (await pathExists(expectedPaths.quarantinePath)) {
    const removeQuarantine = () =>
      removeExactQuarantine(
        expectedPaths.quarantinePath,
        intent.value.target,
        options.afterStageForTest,
      );
    if (intent.value.target.layout === "directory") {
      await withSerializedQuarantineTransition(paths.lockPath, removeQuarantine);
    } else {
      await removeQuarantine();
    }
    await options.afterStageForTest?.("quarantine_removed");
  }
  if (
    (await pathExists(paths.lockPath)) &&
    (!canonicalReplacementPresent ||
      (await inspectExactTarget(paths.lockPath, intent.value.target)))
  ) {
    throw new Error("Canonical lock reappeared before offline recovery cleanup");
  }

  await unlinkExactIfPresent(intent.path, intent.identity);
  await options.afterStageForTest?.("request_removed");
  recordCompletedRecovery(paths, fingerprint);
  await unlinkExactIfPresent(receipt.path, receipt.identity);
  await options.afterStageForTest?.("receipt_removed");
  return {
    status: "recovered",
    applied: true,
    jobId: options.jobId,
    kind: intent.value.target.kind,
    fingerprint,
    lockPath: paths.lockPath,
    resumed: true,
  };
}

async function repairFederatedJobLockOfflineResolved(
  options: OfflineFederatedLockRecoveryOptions,
  paths: RecoveryPaths,
  staleMs: number,
): Promise<OfflineFederatedLockRecoveryResult> {
  let transaction: ExistingTransaction;
  try {
    await assertCanonicalArtifactSpelling(paths);
    transaction = await findTransaction(paths, options.jobId);
  } catch (error: unknown) {
    return {
      status: "refused",
      applied: false,
      jobId: options.jobId,
      lockPath: paths.lockPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (transaction.receipt && !transaction.intent) {
    const stateError = await pendingTransactionStateError(paths, transaction);
    if (stateError) {
      return {
        status: "refused",
        applied: false,
        jobId: options.jobId,
        lockPath: paths.lockPath,
        reason: stateError,
      };
    }
    if (
      !options.apply ||
      !options.confirmOffline ||
      options.expectedFingerprint !== transaction.receipt.value.fingerprint
    ) {
      return {
        status: "eligible",
        applied: false,
        jobId: options.jobId,
        kind: transaction.receipt.value.targetKind,
        fingerprint: transaction.receipt.value.fingerprint,
        ageMs: 0,
        lockPath: paths.lockPath,
      };
    }
    if (transaction.receipt.value.host.toLowerCase() !== hostname().toLowerCase()) {
      return {
        status: "refused",
        applied: false,
        jobId: options.jobId,
        lockPath: paths.lockPath,
        reason: "Offline recovery receipt was created on a different host",
      };
    }
    await cleanupPublishStaging(paths, transaction.receipt.value.requestToken);
    recordCompletedRecovery(paths, transaction.receipt.value.fingerprint);
    await unlinkExact(transaction.receipt.path, transaction.receipt.identity);
    await options.afterStageForTest?.("receipt_removed");
    return {
      status: "recovered",
      applied: true,
      jobId: options.jobId,
      kind: transaction.receipt.value.targetKind,
      fingerprint: transaction.receipt.value.fingerprint,
      lockPath: paths.lockPath,
      resumed: true,
    };
  }

  if (transaction.intent) {
    const stateError = await pendingTransactionStateError(paths, transaction);
    if (stateError) {
      return {
        status: "refused",
        applied: false,
        jobId: options.jobId,
        lockPath: paths.lockPath,
        reason: stateError,
      };
    }
    if (!options.apply) {
      return {
        status: "eligible",
        applied: false,
        jobId: options.jobId,
        kind: transaction.intent.value.target.kind,
        fingerprint: transaction.intent.value.fingerprint,
        ageMs: Math.max(
          0,
          (options.nowForTest ?? Date.now)() - targetMtime(transaction.intent.value.target),
        ),
        lockPath: paths.lockPath,
      };
    }
    try {
      if (
        options.confirmOffline &&
        options.expectedFingerprint === transaction.intent.value.fingerprint &&
        transaction.intent.value.host.toLowerCase() === hostname().toLowerCase()
      ) {
        await cleanupPublishStaging(paths, transaction.intent.value.requestToken);
      }
      return await finishTransaction(
        paths,
        { ...transaction, intent: transaction.intent },
        options,
      );
    } catch (error: unknown) {
      return {
        status: "refused",
        applied: false,
        jobId: options.jobId,
        lockPath: paths.lockPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const inspection = await inspectTargetAt(paths.lockPath);
  if (!inspection.target) {
    const staging = await listPublishStaging(paths);
    if (inspection.reason === "lock is absent" && staging.length > 0) {
      if (
        !options.apply ||
        !options.confirmOffline ||
        typeof options.expectedFingerprint !== "string" ||
        !SHA256.test(options.expectedFingerprint)
      ) {
        return {
          status: "refused",
          applied: false,
          jobId: options.jobId,
          lockPath: paths.lockPath,
          reason:
            "Orphaned offline recovery publication staging exists; authorized apply with the original exact fingerprint is required",
        };
      }
      try {
        const removedArtifacts = await cleanupPublishStaging(
          paths,
          requestTokenForFingerprint(options.expectedFingerprint),
        );
        if (removedArtifacts > 0) {
          return {
            status: "staging-cleaned",
            applied: true,
            jobId: options.jobId,
            fingerprint: options.expectedFingerprint,
            lockPath: paths.lockPath,
            removedArtifacts,
          };
        }
      } catch (error: unknown) {
        return {
          status: "refused",
          applied: false,
          jobId: options.jobId,
          lockPath: paths.lockPath,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      status: inspection.reason === "lock is absent" ? "absent" : "refused",
      applied: false,
      jobId: options.jobId,
      lockPath: paths.lockPath,
      reason: inspection.reason ?? "lock is not recoverable",
    };
  }
  const now = (options.nowForTest ?? Date.now)();
  const eligibility = verifyEligibleTarget(inspection.target, staleMs, now);
  if (eligibility.reason) {
    return {
      status: "refused",
      applied: false,
      jobId: options.jobId,
      lockPath: paths.lockPath,
      reason: eligibility.reason,
    };
  }
  const fingerprint = targetFingerprint(paths, options.jobId, inspection.target);
  await options.afterStageForTest?.("target_inspected");
  if (!options.apply) {
    return {
      status: "eligible",
      applied: false,
      jobId: options.jobId,
      kind: inspection.target.kind,
      fingerprint,
      ageMs: eligibility.ageMs,
      lockPath: paths.lockPath,
    };
  }
  if (!options.confirmOffline || options.expectedFingerprint !== fingerprint) {
    throw new Error(
      "Apply requires --confirm-offline and --expected-fingerprint from the exact dry-run inspection",
    );
  }

  const requestToken = requestTokenForFingerprint(fingerprint);
  await cleanupPublishStaging(paths, requestToken);
  const transactionPaths = artifactPaths(paths.lockPath, requestToken);
  const intent: OfflineRecoveryIntent = {
    version: 1,
    kind: "offline-federation-lock-recovery",
    requestToken,
    jobId: options.jobId,
    projectRoot: paths.projectRoot,
    lockPath: paths.lockPath,
    host: hostname(),
    createdAt: new Date(now).toISOString(),
    staleMs,
    fingerprint,
    target: inspection.target,
  };
  const published = await publishJsonSingleton(
    paths,
    transactionPaths.intentPath,
    intent,
    "intent",
    isIntent,
    (existing) =>
      existing.jobId === intent.jobId &&
      existing.projectRoot === intent.projectRoot &&
      existing.lockPath === intent.lockPath &&
      existing.host.toLowerCase() === intent.host.toLowerCase() &&
      existing.fingerprint === intent.fingerprint &&
      targetMatches(existing.target, intent.target),
    options.afterStageForTest,
  );
  await options.afterStageForTest?.("request_published");
  const winningPaths = artifactPaths(paths.lockPath, published.value.requestToken);
  const peerReceipt = await loadReceiptForIntent(winningPaths.receiptPath, published.value);
  if (peerReceipt) await options.afterStageForTest?.("peer_receipt_observed");
  if (
    published.created &&
    !(await pathExists(paths.lockPath)) &&
    !(await pathExists(winningPaths.quarantinePath)) &&
    !peerReceipt
  ) {
    await unlinkExactIfPresent(transactionPaths.intentPath, published.identity);
    return {
      status: "recovered",
      applied: true,
      jobId: options.jobId,
      kind: inspection.target.kind,
      fingerprint,
      lockPath: paths.lockPath,
      resumed: true,
    };
  }
  const result = await finishTransaction(
    paths,
    {
      intent: {
        path: transactionPaths.intentPath,
        value: published.value,
        identity: published.identity,
      },
      quarantinePath: undefined,
      receipt: peerReceipt,
    },
    options,
  );
  return { ...result, resumed: false };
}

/**
 * Inspect or explicitly recover one stale pre-v2 federation lock while every
 * Quack process sharing the project is stopped. Online acquisition never
 * consumes these operator-only intents; their standard reclaim-request prefix
 * instead keeps normal lock acquisition fail closed after a crash.
 */
export async function repairFederatedJobLockOffline(
  options: OfflineFederatedLockRecoveryOptions,
): Promise<OfflineFederatedLockRecoveryResult> {
  if (
    process.env.NODE_ENV !== "test" &&
    (options.nowForTest !== undefined || options.afterStageForTest !== undefined)
  ) {
    throw new Error("Offline federation lock recovery test seams are unavailable outside tests");
  }
  if (options.jobId.toLowerCase() === OFFLINE_RECOVERY_CLAIM_JOB_ID) {
    throw new Error("Federation job id is reserved for offline recovery serialization");
  }
  const staleMs = positiveInteger(options.staleMs, DEFAULT_STALE_MS, "staleMs");
  const paths = await resolveRecoveryPaths(options.projectRoot, options.jobId);
  if (!options.apply) {
    return repairFederatedJobLockOfflineResolved(options, paths, staleMs);
  }
  return withFederatedJobLock(paths.projectRoot, OFFLINE_RECOVERY_CLAIM_JOB_ID, async () => {
    const admittedPaths = await resolveRecoveryPaths(paths.projectRoot, options.jobId);
    return repairFederatedJobLockOfflineResolved(options, admittedPaths, staleMs);
  });
}
