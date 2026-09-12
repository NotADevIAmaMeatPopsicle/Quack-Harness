// ─── Federation Job Store ──────────────────────────────────────────
// File-backed ledger of FederatedJobRecord under
// `<projectRoot>/.quack/federation/jobs/`. Each job is `<jobId>.json`;
// `records.jsonl` is an append-only audit trail.

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

import { resolveWindowsPowerShellPath } from "../../worker/codex-process-containment.js";
import type { FederatedJobRecord } from "./types.js";

const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 500;
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = LOCK_RETRY_MS * LOCK_ATTEMPTS;
const LOCK_OWNER_PREFIX = "owner-";
const LOCK_OWNER_SUFFIX = ".json";
const LOCK_RECLAIM_FILE = "reclaim.json";
const LOCK_OWNER_ARTIFACT_PREFIX = ".owner.";
const LOCK_RECLAIM_REQUEST_PREFIX = ".reclaim-request.";
const LOCK_RECLAIM_QUARANTINE_PREFIX = ".reclaim-quarantine.";
const LOCK_RELEASE_PREFIX = ".release.";
const LOCK_RELEASE_QUARANTINE_PREFIX = ".release-quarantine.";
const LOCK_PUBLISH_PREFIX = ".publish.";
const LOCK_RENAME_RETRY_TIMEOUT_MS = 1_000;
const LOCK_CRASH_ARTIFACT_SCAN_LIMIT = 16;
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;
const PROCESS_IDENTITY_COMMAND_MAX_BUFFER = 16 * 1024;
const execFileAsync = promisify(execFile);

interface ProcessIdentityCommandOptions {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
}

type ProcessIdentityCommandRunner = (
  executable: string,
  args: string[],
  options: ProcessIdentityCommandOptions,
) => Promise<{ stdout: string }>;

export interface FederatedJobProcessIdentity {
  bootId: string;
  startedAt: string;
}

export type FederatedJobProcessProbe =
  | { state: "alive"; identity: FederatedJobProcessIdentity }
  | { state: "dead" }
  | { state: "unknown" };

interface FederatedJobLockRecordV1 {
  version: 1;
  ownerToken: string;
  host: string;
  pid: number;
  acquiredAt: string;
}

interface FederatedJobLockRecordV2 {
  version: 2;
  ownerToken: string;
  host: string;
  pid: number;
  acquiredAt: string;
  processIdentity: FederatedJobProcessIdentity;
  ownerArtifact?: string;
}

type FederatedJobLockRecord = FederatedJobLockRecordV1 | FederatedJobLockRecordV2;

interface FederatedJobReclaimRecord {
  version: 2;
  kind: "reclaim";
  requestToken: string;
  observedOwnerToken: string;
  observedOwnerVersion: 1 | 2 | "legacy-file";
  observedLayout: "file" | "directory" | "legacy-file";
  observedProcessIdentity?: FederatedJobProcessIdentity;
  observedOwnerArtifact?: string;
  observedFileIdentity?: { dev: number; ino: number };
  observedOwnerFileIdentity?: { dev: number; ino: number };
  observedLegacy?: FederatedJobLegacyFileIdentity;
  host: string;
  pid: number;
  requestedAt: string;
  processIdentity: FederatedJobProcessIdentity;
}

interface FederatedJobLegacyFileIdentity {
  size: 0;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface FederatedJobLockOptions {
  /** Internal deterministic-test seam; production callers use the defaults. */
  retryMs?: number;
  /** Independent acquisition deadline; it is never inferred from stale age. */
  waitTimeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  /** Internal deterministic-test seam for proving dead-owner reclamation. */
  processIsAlive?: (pid: number) => boolean | undefined;
  /** Internal deterministic-test seam for PID-incarnation checks. */
  processIdentityProbeForTest?: (pid: number) => Promise<FederatedJobProcessProbe>;
  /** Internal deterministic-test seam for the current process incarnation. */
  currentProcessIdentityForTest?: FederatedJobProcessIdentity;
  /** Internal deterministic-test seam for retrying the production identity cache. */
  cacheCurrentProcessIdentityForTest?: boolean;
  /** Internal deterministic-test seam for exercising platform-specific process probes. */
  platformForTest?: NodeJS.Platform;
  /** Internal deterministic-test seam for platform process-identity commands. */
  processIdentityCommandForTest?: ProcessIdentityCommandRunner;
  /** Internal deterministic-test seam for cross-host fail-closed coverage. */
  localHost?: string;
  /** Internal deterministic-test seam exercised after heartbeat shutdown. */
  beforeReleaseForTest?: (lock: { lockPath: string; ownerToken: string }) => void | Promise<void>;
  /** Internal deterministic-test seam for post-publication handle failures. */
  openOwnerHandleForTest?: (
    ownerPath: string,
  ) => Promise<Awaited<ReturnType<typeof fsPromises.open>>>;
  /** Internal deterministic-test seam for Windows rename contention. */
  renamePathForTest?: (source: string, destination: string) => Promise<void>;
  /** Internal deterministic-test seam for atomic no-replace publication. */
  linkPathForTest?: (source: string, destination: string) => Promise<void>;
  /** Internal deterministic-test seam for Windows unlink contention. */
  unlinkPathForTest?: (target: string) => Promise<void>;
  /** Internal deterministic-test seam for post-link directory-sync failures. */
  syncDirectoryForTest?: (directory: string) => Promise<void>;
  /** Internal deterministic-test seam for release-marker file flush failures. */
  syncPublishedReleaseFileForTest?: (filePath: string) => Promise<void>;
  /** Internal deterministic-test seam after snapshot bytes are read. */
  afterSnapshotReadForTest?: (target: string, layout: "file" | "directory") => void | Promise<void>;
  /** Internal deterministic-test seam for bounded crash-artifact scans. */
  onCrashArtifactExaminedForTest?: (target: string) => void;
  renameRetryTimeoutMs?: number;
  /** Observe durable post-action cleanup lag without changing the action result. */
  onReleaseError?: (error: unknown) => void;
}

interface ResolvedFederatedJobLockOptions {
  retryMs: number;
  waitTimeoutMs: number;
  staleMs: number;
  heartbeatMs: number;
  processIsAlive: (pid: number) => boolean | undefined;
  processIdentityProbe: (pid: number) => Promise<FederatedJobProcessProbe>;
  currentProcessIdentity?: FederatedJobProcessIdentity;
  cacheCurrentProcessIdentityGlobally: boolean;
  processProbeCache: Map<string, Promise<FederatedJobProcessProbe>>;
  localHost: string;
  beforeReleaseForTest?: FederatedJobLockOptions["beforeReleaseForTest"];
  openOwnerHandle: (ownerPath: string) => Promise<Awaited<ReturnType<typeof fsPromises.open>>>;
  renamePath: (source: string, destination: string) => Promise<void>;
  linkPath: (source: string, destination: string) => Promise<void>;
  unlinkPath: (target: string) => Promise<void>;
  syncDirectory: (directory: string) => Promise<void>;
  syncPublishedReleaseFile: (filePath: string) => Promise<void>;
  afterSnapshotReadForTest?: FederatedJobLockOptions["afterSnapshotReadForTest"];
  onCrashArtifactExaminedForTest?: FederatedJobLockOptions["onCrashArtifactExaminedForTest"];
  renameRetryTimeoutMs: number;
  onReleaseError?: FederatedJobLockOptions["onReleaseError"];
}

interface FederatedJobLockLease {
  lockPath: string;
  ownerPath: string;
  ownerToken: string;
  record: FederatedJobLockRecordV2;
  ownerHandle: Awaited<ReturnType<typeof fsPromises.open>>;
}

interface FederatedJobLockSnapshot {
  record: FederatedJobLockRecord;
  ownerPath: string;
  mtimeMs: number;
  layout: "file" | "directory";
  fileIdentity: { dev: number; ino: number };
  ownerFileIdentity?: { dev: number; ino: number };
}

let lockOptionsForTests: FederatedJobLockOptions | undefined;
let currentProcessIdentityPromise: Promise<FederatedJobProcessIdentity> | undefined;
const pendingProcessLocalReleases = new Map<string, FederatedJobLockRecordV2>();
const crashArtifactScanCursors = new Map<string, string>();

export type FederatedJobPersistenceStage =
  | "record_file_synced"
  | "record_published"
  | "record_published_file_synced"
  | "record_directory_synced"
  | "record_durability_acknowledged"
  | "audit_file_synced"
  | "audit_directory_synced"
  | "audit_durability_acknowledged";

let afterFederatedJobPersistenceStageForTest:
  | ((stage: FederatedJobPersistenceStage, target: string) => void | Promise<void>)
  | undefined;

/** @internal Deterministic durability/crash seam for job-ledger regressions. */
export function setFederatedJobPersistenceHookForTests(
  hook: ((stage: FederatedJobPersistenceStage, target: string) => void | Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Federation job persistence test hook is unavailable outside tests");
  }
  afterFederatedJobPersistenceStageForTest = hook;
}

/** @internal Test-only timing/runtime override for route-level contention coverage. */
export function setFederatedJobLockOptionsForTests(
  options: FederatedJobLockOptions | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Federation job lock test options are unavailable outside tests");
  }
  lockOptionsForTests = options ? { ...options } : undefined;
  if (!options) {
    pendingProcessLocalReleases.clear();
    crashArtifactScanCursors.clear();
    currentProcessIdentityPromise = undefined;
  }
}

export class FederatedJobLockBusyError extends Error {
  readonly code = "federated_job_lock_busy";
  readonly retryable = true;

  constructor(public readonly jobId: string) {
    super(`Timed out acquiring federation job lock for ${jobId}`);
    this.name = "FederatedJobLockBusyError";
  }
}

export class FederatedJobLockCompletedActionError extends Error {
  readonly code = "federated_job_lock_release_failed";
  readonly actionCompleted = true;

  constructor(
    public readonly result: unknown,
    cause: unknown,
  ) {
    super("Federation job update completed, but its lock release could not be made recoverable", {
      cause,
    });
    this.name = "FederatedJobLockCompletedActionError";
  }
}

function processIdentityEquals(
  left: FederatedJobProcessIdentity | undefined,
  right: FederatedJobProcessIdentity | undefined,
): boolean {
  return Boolean(
    left && right && left.bootId === right.bootId && left.startedAt === right.startedAt,
  );
}

function isProcessIdentity(value: unknown): value is FederatedJobProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<FederatedJobProcessIdentity>;
  return (
    typeof identity.bootId === "string" &&
    identity.bootId.length > 0 &&
    identity.bootId.length <= 256 &&
    typeof identity.startedAt === "string" &&
    identity.startedAt.length > 0 &&
    identity.startedAt.length <= 256
  );
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

const runProcessIdentityCommand: ProcessIdentityCommandRunner = async (
  executable,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(executable, args, options);
  return { stdout };
};

function deadOrUnknownProcess(
  pid: number,
  isAlive: (pid: number) => boolean | undefined,
): FederatedJobProcessProbe {
  try {
    return isAlive(pid) === false ? { state: "dead" } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

async function probeLinuxProcessIdentity(pid: number): Promise<FederatedJobProcessProbe> {
  try {
    const [bootId, stat] = await Promise.all([
      fsPromises.readFile("/proc/sys/kernel/random/boot_id", "utf-8"),
      fsPromises.readFile(`/proc/${pid}/stat`, "utf-8"),
    ]);
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return { state: "unknown" };
    // The suffix begins at proc(5) field 3; starttime is field 22.
    const fields = stat
      .slice(closeParen + 1)
      .trim()
      .split(/\s+/u);
    const startedAt = fields[19];
    const normalizedBootId = bootId.trim();
    if (!startedAt || !/^\d+$/u.test(startedAt) || !normalizedBootId) {
      return { state: "unknown" };
    }
    return {
      state: "alive",
      identity: { bootId: normalizedBootId, startedAt },
    };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") {
      return processIsAlive(pid) === false ? { state: "dead" } : { state: "unknown" };
    }
    return { state: "unknown" };
  }
}

async function probeWindowsProcessIdentity(
  pid: number,
  trustedBoundaryRoot: string,
): Promise<FederatedJobProcessProbe> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return { state: "unknown" };
  let powershell: string;
  try {
    powershell = resolveWindowsPowerShellPath(process.env, trustedBoundaryRoot);
  } catch {
    return { state: "unknown" };
  }
  const modulePath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$os=CimCmdlets\\Get-CimInstance -ClassName Win32_OperatingSystem",
    "try {$p=Microsoft.PowerShell.Management\\Get-Process -Id ([int]$env:QUACK_LOCK_PID) -ErrorAction Stop} catch {exit 3}",
    "$boot=$os.LastBootUpTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "$started=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "[Console]::Out.Write($boot+'|'+$started)",
  ].join(";");
  try {
    const { stdout } = await execFileAsync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: path.win32.parse(systemRoot).root,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PSModulePath: modulePath,
          QUACK_LOCK_PID: String(pid),
        },
        windowsHide: true,
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      },
    );
    const [bootId, startedAt, extra] = stdout.trim().split("|");
    if (extra !== undefined || !bootId || !startedAt || !/^\d+$/u.test(bootId + startedAt)) {
      return { state: "unknown" };
    }
    return { state: "alive", identity: { bootId, startedAt } };
  } catch {
    return processIsAlive(pid) === false ? { state: "dead" } : { state: "unknown" };
  }
}

const DARWIN_BOOT_SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DARWIN_PROCESS_START_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/u;
const DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function normalizeDarwinProcessStart(value: string): string | undefined {
  const match = DARWIN_PROCESS_START_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const month = DARWIN_MONTHS.indexOf(match[2] as (typeof DARWIN_MONTHS)[number]);
  const day = Number(match[3].trim());
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (month < 0 || year < 1970) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    DARWIN_WEEKDAYS[parsed.getUTCDay()] !== match[1]
  ) {
    return undefined;
  }
  return parsed.toISOString();
}

async function probeDarwinProcessIdentity(
  pid: number,
  runCommand: ProcessIdentityCommandRunner,
  isAlive: (pid: number) => boolean | undefined,
): Promise<FederatedJobProcessProbe> {
  const commandOptions: ProcessIdentityCommandOptions = {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    maxBuffer: PROCESS_IDENTITY_COMMAND_MAX_BUFFER,
    shell: false,
    timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  };
  try {
    const [bootSession, processStart] = await Promise.all([
      runCommand("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], commandOptions),
      runCommand("/bin/ps", ["-o", "lstart=", "-p", String(pid)], commandOptions),
    ]);
    const bootId = bootSession.stdout.trim();
    const startedAt = normalizeDarwinProcessStart(processStart.stdout);
    if (!DARWIN_BOOT_SESSION_UUID_PATTERN.test(bootId) || !startedAt) {
      return { state: "unknown" };
    }
    return {
      state: "alive",
      identity: { bootId: bootId.toLowerCase(), startedAt },
    };
  } catch {
    return deadOrUnknownProcess(pid, isAlive);
  }
}

async function probeProcessIdentity(
  pid: number,
  trustedBoundaryRoot: string,
  platform: NodeJS.Platform = process.platform,
  runCommand: ProcessIdentityCommandRunner = runProcessIdentityCommand,
  isAlive: (pid: number) => boolean | undefined = processIsAlive,
): Promise<FederatedJobProcessProbe> {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unknown" };
  if (platform === "linux") return probeLinuxProcessIdentity(pid);
  if (platform === "win32") return probeWindowsProcessIdentity(pid, trustedBoundaryRoot);
  if (platform === "darwin") return probeDarwinProcessIdentity(pid, runCommand, isAlive);
  return deadOrUnknownProcess(pid, isAlive);
}

async function resolveCurrentProcessIdentity(
  options: ResolvedFederatedJobLockOptions,
): Promise<FederatedJobProcessIdentity> {
  if (options.currentProcessIdentity) return options.currentProcessIdentity;
  const resolveIdentity = async (): Promise<FederatedJobProcessIdentity> => {
    const probe = await options.processIdentityProbe(process.pid);
    if (probe.state !== "alive") {
      throw new Error("Unable to establish the federation lock process incarnation");
    }
    return probe.identity;
  };
  if (!options.cacheCurrentProcessIdentityGlobally) return resolveIdentity();
  if (!currentProcessIdentityPromise) {
    const attempt = resolveIdentity();
    currentProcessIdentityPromise = attempt;
    void attempt.catch(() => {
      if (currentProcessIdentityPromise === attempt) currentProcessIdentityPromise = undefined;
    });
  }
  return currentProcessIdentityPromise;
}

/** @internal Shared process-incarnation evidence for federation filesystem leases. */
export async function currentFederatedLockProcessIdentity(
  projectRoot: string,
): Promise<FederatedJobProcessIdentity> {
  return resolveCurrentProcessIdentity(resolveLockOptions({}, projectRoot));
}

/** @internal Shared process-incarnation probe for federation filesystem leases. */
export async function probeFederatedLockProcessIdentity(
  projectRoot: string,
  pid: number,
): Promise<FederatedJobProcessProbe> {
  return resolveLockOptions({}, projectRoot).processIdentityProbe(pid);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function resolveLockOptions(
  options: FederatedJobLockOptions = {},
  trustedBoundaryRoot: string,
): ResolvedFederatedJobLockOptions {
  const combined = { ...lockOptionsForTests, ...options };
  const resolvedProcessIsAlive = combined.processIsAlive ?? processIsAlive;
  const staleMs = positiveInteger(combined.staleMs, STALE_LOCK_MS, "staleMs");
  const heartbeatMs = positiveInteger(
    combined.heartbeatMs,
    Math.max(1, Math.floor(staleMs / 3)),
    "heartbeatMs",
  );
  if (heartbeatMs >= staleMs) {
    throw new Error("heartbeatMs must be shorter than staleMs");
  }
  return {
    retryMs: positiveInteger(combined.retryMs, LOCK_RETRY_MS, "retryMs"),
    waitTimeoutMs: positiveInteger(combined.waitTimeoutMs, LOCK_WAIT_TIMEOUT_MS, "waitTimeoutMs"),
    staleMs,
    heartbeatMs,
    processIsAlive: resolvedProcessIsAlive,
    processIdentityProbe:
      combined.processIdentityProbeForTest ??
      ((pid) =>
        probeProcessIdentity(
          pid,
          trustedBoundaryRoot,
          combined.platformForTest ?? process.platform,
          combined.processIdentityCommandForTest ?? runProcessIdentityCommand,
          resolvedProcessIsAlive,
        )),
    currentProcessIdentity: combined.currentProcessIdentityForTest,
    cacheCurrentProcessIdentityGlobally:
      combined.cacheCurrentProcessIdentityForTest ?? !combined.processIdentityProbeForTest,
    processProbeCache: new Map(),
    localHost: combined.localHost ?? hostname(),
    beforeReleaseForTest: combined.beforeReleaseForTest,
    openOwnerHandle:
      combined.openOwnerHandleForTest ?? ((ownerPath) => fsPromises.open(ownerPath, "r+")),
    renamePath: combined.renamePathForTest ?? fsPromises.rename,
    linkPath: combined.linkPathForTest ?? fsPromises.link,
    unlinkPath: combined.unlinkPathForTest ?? fsPromises.unlink,
    syncDirectory: combined.syncDirectoryForTest ?? syncDirectoryBestEffort,
    syncPublishedReleaseFile: combined.syncPublishedReleaseFileForTest ?? syncPublishedFile,
    afterSnapshotReadForTest: combined.afterSnapshotReadForTest,
    onCrashArtifactExaminedForTest: combined.onCrashArtifactExaminedForTest,
    renameRetryTimeoutMs: positiveInteger(
      combined.renameRetryTimeoutMs,
      LOCK_RENAME_RETRY_TIMEOUT_MS,
      "renameRetryTimeoutMs",
    ),
    onReleaseError: combined.onReleaseError,
  };
}

function ownerFileName(ownerToken: string): string {
  return `${LOCK_OWNER_PREFIX}${ownerToken}${LOCK_OWNER_SUFFIX}`;
}

function isLockRecord(value: unknown): value is FederatedJobLockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FederatedJobLockRecord>;
  const common =
    (record.version === 1 || record.version === 2) &&
    typeof record.ownerToken === "string" &&
    /^[0-9a-f-]{36}$/iu.test(record.ownerToken) &&
    typeof record.host === "string" &&
    record.host.length > 0 &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.acquiredAt === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt));
  if (!common) return false;
  if (record.version === 1) return true;
  const v2 = record as Partial<FederatedJobLockRecordV2>;
  return (
    isProcessIdentity(v2.processIdentity) &&
    (v2.ownerArtifact === undefined ||
      (typeof v2.ownerArtifact === "string" &&
        path.basename(v2.ownerArtifact) === v2.ownerArtifact &&
        v2.ownerArtifact.includes(LOCK_OWNER_ARTIFACT_PREFIX)))
  );
}

function hasExactOwnerArtifactForLock(
  lockPath: string,
  record: FederatedJobLockRecord,
): record is FederatedJobLockRecordV2 & { ownerArtifact: string } {
  if (record.version !== 2 || typeof record.ownerArtifact !== "string") return false;
  const expectedPrefix = `${path.basename(lockPath)}${LOCK_OWNER_ARTIFACT_PREFIX}`;
  return (
    path.basename(record.ownerArtifact) === record.ownerArtifact &&
    record.ownerArtifact.startsWith(expectedPrefix) &&
    record.ownerArtifact.endsWith(`-${record.ownerToken}`)
  );
}

function isReclaimRecord(value: unknown): value is FederatedJobReclaimRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FederatedJobReclaimRecord>;
  const ownerVersionValid = [1, 2, "legacy-file"].includes(record.observedOwnerVersion ?? "");
  const legacyValid =
    record.observedOwnerVersion !== "legacy-file" || isLegacyFileIdentity(record.observedLegacy);
  const ownerIdentityValid =
    record.observedOwnerVersion !== 2 || isProcessIdentity(record.observedProcessIdentity);
  const ownerArtifactValid =
    record.observedOwnerArtifact === undefined ||
    (typeof record.observedOwnerArtifact === "string" &&
      path.basename(record.observedOwnerArtifact) === record.observedOwnerArtifact &&
      record.observedOwnerArtifact.includes(LOCK_OWNER_ARTIFACT_PREFIX));
  const observedFileIdentityValid =
    record.observedFileIdentity === undefined ||
    (typeof record.observedFileIdentity === "object" &&
      record.observedFileIdentity !== null &&
      typeof record.observedFileIdentity.dev === "number" &&
      Number.isFinite(record.observedFileIdentity.dev) &&
      typeof record.observedFileIdentity.ino === "number" &&
      Number.isFinite(record.observedFileIdentity.ino));
  const observedOwnerFileIdentityValid =
    record.observedOwnerFileIdentity === undefined ||
    (typeof record.observedOwnerFileIdentity === "object" &&
      record.observedOwnerFileIdentity !== null &&
      typeof record.observedOwnerFileIdentity.dev === "number" &&
      Number.isFinite(record.observedOwnerFileIdentity.dev) &&
      typeof record.observedOwnerFileIdentity.ino === "number" &&
      Number.isFinite(record.observedOwnerFileIdentity.ino));
  return (
    record.version === 2 &&
    record.kind === "reclaim" &&
    typeof record.requestToken === "string" &&
    /^[0-9a-f-]{36}$/iu.test(record.requestToken) &&
    typeof record.observedOwnerToken === "string" &&
    (record.observedOwnerVersion === "legacy-file" ||
      /^[0-9a-f-]{36}$/iu.test(record.observedOwnerToken)) &&
    ownerVersionValid &&
    legacyValid &&
    ownerIdentityValid &&
    ownerArtifactValid &&
    observedFileIdentityValid &&
    observedOwnerFileIdentityValid &&
    (record.observedLayout !== "directory" || record.observedOwnerFileIdentity !== undefined) &&
    ["file", "directory", "legacy-file"].includes(record.observedLayout ?? "") &&
    (record.observedOwnerVersion === "legacy-file"
      ? record.observedLayout === "legacy-file"
      : record.observedLayout !== "legacy-file") &&
    typeof record.host === "string" &&
    record.host.length > 0 &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.requestedAt === "string" &&
    Number.isFinite(Date.parse(record.requestedAt)) &&
    isProcessIdentity(record.processIdentity)
  );
}

function isLegacyFileIdentity(value: unknown): value is FederatedJobLegacyFileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<FederatedJobLegacyFileIdentity>;
  return (
    identity.size === 0 &&
    typeof identity.mtimeMs === "number" &&
    Number.isFinite(identity.mtimeMs) &&
    typeof identity.dev === "number" &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === "number" &&
    Number.isFinite(identity.ino)
  );
}

function processIdentityHash(identity: FederatedJobProcessIdentity): string {
  return createHash("sha256")
    .update(`${identity.bootId}\0${identity.startedAt}`)
    .digest("hex")
    .slice(0, 16);
}

function artifactId(
  options: ResolvedFederatedJobLockOptions,
  identity: FederatedJobProcessIdentity,
): string {
  const hostHash = createHash("sha256").update(options.localHost).digest("hex").slice(0, 16);
  return `${hostHash}-${process.pid}-${Date.now()}-${processIdentityHash(identity)}-${randomUUID()}`;
}

function siblingArtifactPrefix(lockPath: string, suffix: string): string {
  return `${path.basename(lockPath)}${suffix}`;
}

function usesCaseInsensitiveArtifactNames(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

async function listSiblingArtifacts(lockPath: string, suffix: string): Promise<string[]> {
  const directory = path.dirname(lockPath);
  const prefix = siblingArtifactPrefix(lockPath, suffix);
  const caseInsensitive = usesCaseInsensitiveArtifactNames();
  const comparisonPrefix = caseInsensitive ? prefix.toLowerCase() : prefix;
  return (await fsPromises.readdir(directory))
    .filter((entry) => (caseInsensitive ? entry.toLowerCase() : entry).startsWith(comparisonPrefix))
    .sort()
    .map((entry) => path.join(directory, entry));
}

async function readJsonFile(
  filePath: string,
): Promise<
  { value: unknown; mtimeMs: number; fileIdentity: { dev: number; ino: number } } | undefined
> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(filePath, "r");
    const raw = await handle.readFile("utf-8");
    const stat = await handle.stat();
    const pathStat = await fsPromises.lstat(filePath);
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      return undefined;
    }
    return {
      value: JSON.parse(raw) as unknown,
      mtimeMs: stat.mtimeMs,
      fileIdentity: { dev: Number(stat.dev), ino: Number(stat.ino) },
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncPersistenceDirectoryIfSupported(directory: string): Promise<boolean> {
  // Node cannot open Windows directories for fsync. Do not represent that
  // no-op as a durability boundary; the Windows protocol instead reopens and
  // flushes the published destination file below.
  if (process.platform === "win32") return false;
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(directory, "r");
    await handle.sync();
    return true;
  } catch (error: unknown) {
    if (
      ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncPublishedFile(filePath: string): Promise<void> {
  const handle = await fsPromises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishRecordNoReplace(
  lockPath: string,
  destination: string,
  value: unknown,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  const stagingPath = `${lockPath}${LOCK_PUBLISH_PREFIX}${randomUUID()}`;
  const handle = await fsPromises.open(stagingPath, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await linkWithRetry(stagingPath, destination, options);
    published = true;
    await options.syncDirectory(path.dirname(destination));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlinkWithRetry(stagingPath, options).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !published) throw error;
      // Once the destination link exists, this uniquely named sibling is an
      // inert duplicate rather than ownership. Never turn a durable marker
      // into an ambiguous operation result solely because temp cleanup lags.
    });
  }
}

async function renameWithRetry(
  source: string,
  destination: string,
  options: ResolvedFederatedJobLockOptions,
  sourceStillOwned?: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + options.renameRetryTimeoutMs;
  for (;;) {
    if (sourceStillOwned && !(await sourceStillOwned())) {
      throw new Error(`Federation job lock ownership changed before rename: ${source}`);
    }
    try {
      await options.renamePath(source, destination);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}

async function linkWithRetry(
  source: string,
  destination: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<void> {
  const deadline = Date.now() + options.renameRetryTimeoutMs;
  for (;;) {
    try {
      await options.linkPath(source, destination);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}

async function unlinkWithRetry(
  target: string,
  options: ResolvedFederatedJobLockOptions,
  targetStillAuthorized?: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + options.renameRetryTimeoutMs;
  for (;;) {
    if (targetStillAuthorized && !(await targetStillAuthorized())) {
      throw new Error(`Federation job lock ownership changed before unlink: ${target}`);
    }
    try {
      await options.unlinkPath(target);
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}

async function readLockSnapshot(lockPath: string): Promise<FederatedJobLockSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    const lockStat = await fsPromises.lstat(lockPath);
    if (lockStat.isSymbolicLink()) return undefined;
    if (lockStat.isFile()) {
      handle = await fsPromises.open(lockPath, "r");
      const raw = await handle.readFile("utf-8");
      await lockOptionsForTests?.afterSnapshotReadForTest?.(lockPath, "file");
      const fileStat = await handle.stat();
      const finalPathStat = await fsPromises.lstat(lockPath);
      if (
        !fileStat.isFile() ||
        finalPathStat.isSymbolicLink() ||
        !finalPathStat.isFile() ||
        fileStat.dev !== finalPathStat.dev ||
        fileStat.ino !== finalPathStat.ino
      ) {
        return undefined;
      }
      const record = JSON.parse(raw) as unknown;
      if (!isLockRecord(record)) return undefined;
      return {
        record,
        ownerPath: lockPath,
        mtimeMs: fileStat.mtimeMs,
        layout: "file",
        fileIdentity: { dev: Number(fileStat.dev), ino: Number(fileStat.ino) },
      };
    }
    if (!lockStat.isDirectory()) return undefined;
    const entries = await fsPromises.readdir(lockPath);
    const ownerEntries = entries.filter(
      (entry) => entry.startsWith(LOCK_OWNER_PREFIX) && entry.endsWith(LOCK_OWNER_SUFFIX),
    );
    if (ownerEntries.length !== 1) return undefined;
    const ownerPath = path.join(lockPath, ownerEntries[0] ?? "");
    handle = await fsPromises.open(ownerPath, "r");
    const raw = await handle.readFile("utf-8");
    await lockOptionsForTests?.afterSnapshotReadForTest?.(ownerPath, "directory");
    const ownerStat = await handle.stat();
    const finalOwnerStat = await fsPromises.lstat(ownerPath);
    const finalLockStat = await fsPromises.lstat(lockPath);
    if (
      !ownerStat.isFile() ||
      finalOwnerStat.isSymbolicLink() ||
      !finalOwnerStat.isFile() ||
      ownerStat.dev !== finalOwnerStat.dev ||
      ownerStat.ino !== finalOwnerStat.ino ||
      !finalLockStat.isDirectory() ||
      finalLockStat.isSymbolicLink() ||
      finalLockStat.dev !== lockStat.dev ||
      finalLockStat.ino !== lockStat.ino
    ) {
      return undefined;
    }
    const record = JSON.parse(raw) as unknown;
    if (!isLockRecord(record) || ownerEntries[0] !== ownerFileName(record.ownerToken)) {
      return undefined;
    }
    return {
      record,
      ownerPath,
      mtimeMs: ownerStat.mtimeMs,
      layout: "directory",
      fileIdentity: { dev: Number(lockStat.dev), ino: Number(lockStat.ino) },
      ownerFileIdentity: { dev: Number(ownerStat.dev), ino: Number(ownerStat.ino) },
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function isProvablyInactiveLocalProcess(
  host: string,
  pid: number,
  processIdentity: FederatedJobProcessIdentity | undefined,
  evidenceMtimeMs: number,
  cacheKey: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  if (
    host.toLowerCase() !== options.localHost.toLowerCase() ||
    Date.now() - evidenceMtimeMs <= options.staleMs
  ) {
    return false;
  }
  const alive = options.processIsAlive(pid);
  if (alive === false) return true;
  if (!processIdentity) return false;
  let probe = options.processProbeCache.get(cacheKey);
  if (!probe) {
    probe = options.processIdentityProbe(pid);
    options.processProbeCache.set(cacheKey, probe);
  }
  const observed = await probe;
  return (
    observed.state === "dead" ||
    (observed.state === "alive" && !processIdentityEquals(observed.identity, processIdentity))
  );
}

async function isProvablyReclaimableOwner(
  snapshot: FederatedJobLockSnapshot,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  return isProvablyInactiveLocalProcess(
    snapshot.record.host,
    snapshot.record.pid,
    snapshot.record.version === 2 ? snapshot.record.processIdentity : undefined,
    snapshot.mtimeMs,
    `${snapshot.record.host}\0${snapshot.record.pid}\0${snapshot.record.ownerToken}\0${
      snapshot.record.version === 2 ? processIdentityHash(snapshot.record.processIdentity) : "v1"
    }`,
    options,
  );
}

async function isInactiveControlRecord(
  record: FederatedJobReclaimRecord,
  mtimeMs: number,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  return isProvablyInactiveLocalProcess(
    record.host,
    record.pid,
    record.processIdentity,
    mtimeMs,
    `${record.host}\0${record.pid}\0${record.requestToken}\0${processIdentityHash(
      record.processIdentity,
    )}`,
    options,
  );
}

async function isInactiveStagingRecord(
  value: unknown,
  mtimeMs: number,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  if (isLockRecord(value) && value.version === 2) {
    return isProvablyInactiveLocalProcess(
      value.host,
      value.pid,
      value.processIdentity,
      mtimeMs,
      `${value.host}\0${value.pid}\0${value.ownerToken}\0${processIdentityHash(
        value.processIdentity,
      )}`,
      options,
    );
  }
  if (isReclaimRecord(value)) return isInactiveControlRecord(value, mtimeMs, options);
  return false;
}

async function removeInertArtifact(
  filePath: string,
  options: ResolvedFederatedJobLockOptions,
  expectedIdentity: { dev: number; ino: number },
): Promise<void> {
  await unlinkWithRetry(filePath, options, () =>
    matchesPhysicalFileIdentity(filePath, expectedIdentity),
  );
}

async function ownerArtifactHasDurableReference(
  lockPath: string,
  ownerPath: string,
  suffixes: readonly string[] = [
    LOCK_RELEASE_PREFIX,
    LOCK_RELEASE_QUARANTINE_PREFIX,
    LOCK_RECLAIM_QUARANTINE_PREFIX,
  ],
): Promise<boolean> {
  for (const suffix of suffixes) {
    for (const artifactPath of await listSiblingArtifacts(lockPath, suffix)) {
      if (await samePhysicalFile(ownerPath, artifactPath)) return true;
    }
  }
  return false;
}

async function scavengeInertCrashArtifacts(
  lockPath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<void> {
  const artifacts = [
    ...(await listSiblingArtifacts(lockPath, LOCK_OWNER_ARTIFACT_PREFIX)).map((filePath) => ({
      filePath,
      kind: "owner" as const,
    })),
    ...(await listSiblingArtifacts(lockPath, LOCK_PUBLISH_PREFIX)).map((filePath) => ({
      filePath,
      kind: "publish" as const,
    })),
  ].sort((left, right) => left.filePath.localeCompare(right.filePath));
  if (artifacts.length === 0) {
    crashArtifactScanCursors.delete(lockPath);
    return;
  }

  const previous = crashArtifactScanCursors.get(lockPath);
  let start = previous
    ? artifacts.findIndex((artifact) => artifact.filePath.localeCompare(previous) > 0)
    : 0;
  if (start < 0) start = 0;
  const examined = Math.min(LOCK_CRASH_ARTIFACT_SCAN_LIMIT, artifacts.length);
  const batch = Array.from(
    { length: examined },
    (_, index) => artifacts[(start + index) % artifacts.length],
  );
  crashArtifactScanCursors.set(lockPath, batch.at(-1)!.filePath);

  // Any authoritative control artifact can still reference an owner inode.
  // Avoid an unbounded nested stat scan: defer owner cleanup until the bounded
  // reconciliation pass has retired every control artifact for this lock.
  const ownerCleanupBlocked = await hasControlRequests(lockPath);
  for (const artifact of batch) {
    options.onCrashArtifactExaminedForTest?.(artifact.filePath);
    const parsed = await readJsonFile(artifact.filePath);
    if (artifact.kind === "publish") {
      if (parsed && (await isInactiveStagingRecord(parsed.value, parsed.mtimeMs, options))) {
        await removeInertArtifact(artifact.filePath, options, parsed.fileIdentity);
      }
      continue;
    }
    const ownerName = path.basename(artifact.filePath);
    const retiredOwner =
      parsed &&
      isLockRecord(parsed.value) &&
      parsed.value.version === 2 &&
      ownerName === `${parsed.value.ownerArtifact}.retired.${parsed.value.ownerToken}`;
    const legacyRetiredOwner =
      parsed &&
      isLockRecord(parsed.value) &&
      parsed.value.version === 2 &&
      ownerName.startsWith(`${parsed.value.ownerArtifact}.retired.`);
    if (
      !parsed ||
      !isLockRecord(parsed.value) ||
      parsed.value.version !== 2 ||
      (parsed.value.ownerArtifact !== ownerName && !legacyRetiredOwner) ||
      !hasExactOwnerArtifactForLock(lockPath, parsed.value) ||
      (await samePhysicalFile(artifact.filePath, lockPath)) ||
      (!retiredOwner &&
        (ownerCleanupBlocked ||
          !(await isInactiveStagingRecord(parsed.value, parsed.mtimeMs, options))))
    ) {
      continue;
    }
    await removeInertArtifact(artifact.filePath, options, parsed.fileIdentity);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function lockRecordMatchesReclaim(
  record: FederatedJobLockRecord,
  request: FederatedJobReclaimRecord,
): boolean {
  return (
    request.observedOwnerVersion !== "legacy-file" &&
    record.ownerToken === request.observedOwnerToken &&
    record.version === request.observedOwnerVersion &&
    (record.version !== 2 ||
      processIdentityEquals(record.processIdentity, request.observedProcessIdentity))
  );
}

function lockSnapshotMatchesReclaim(
  lockPath: string,
  snapshot: FederatedJobLockSnapshot,
  request: FederatedJobReclaimRecord,
): boolean {
  return (
    lockRecordMatchesReclaim(snapshot.record, request) &&
    snapshot.layout === request.observedLayout &&
    request.observedFileIdentity !== undefined &&
    snapshot.fileIdentity.dev === request.observedFileIdentity.dev &&
    snapshot.fileIdentity.ino === request.observedFileIdentity.ino &&
    (snapshot.layout !== "directory" ||
      (snapshot.ownerFileIdentity !== undefined &&
        request.observedOwnerFileIdentity !== undefined &&
        snapshot.ownerFileIdentity.dev === request.observedOwnerFileIdentity.dev &&
        snapshot.ownerFileIdentity.ino === request.observedOwnerFileIdentity.ino)) &&
    (snapshot.record.version !== 2 ||
      (snapshot.layout === "directory" && snapshot.record.ownerArtifact === undefined) ||
      (hasExactOwnerArtifactForLock(lockPath, snapshot.record) &&
        snapshot.record.ownerArtifact === request.observedOwnerArtifact))
  );
}

function legacyIdentityFromStat(
  stat: Awaited<ReturnType<typeof fsPromises.lstat>>,
): FederatedJobLegacyFileIdentity | undefined {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) return undefined;
  return {
    size: 0,
    mtimeMs: Number(stat.mtimeMs),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  };
}

async function readLegacyLockIdentity(
  lockPath: string,
): Promise<FederatedJobLegacyFileIdentity | undefined> {
  try {
    return legacyIdentityFromStat(await fsPromises.lstat(lockPath));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkControlRequest(
  requestPath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<void> {
  await unlinkWithRetry(requestPath, options);
  await options.syncDirectory(path.dirname(requestPath));
}

function reclaimQuarantinePath(lockPath: string, requestPath: string): string | undefined {
  const requestPrefix = siblingArtifactPrefix(lockPath, LOCK_RECLAIM_REQUEST_PREFIX);
  const name = path.basename(requestPath);
  if (!name.startsWith(requestPrefix)) return undefined;
  const id = name.slice(requestPrefix.length);
  if (!id) return undefined;
  return `${lockPath}${LOCK_RECLAIM_QUARANTINE_PREFIX}${id}`;
}

async function removeDirectoryWithRetry(
  directory: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<void> {
  const deadline = Date.now() + options.renameRetryTimeoutMs;
  for (;;) {
    try {
      await fsPromises.rmdir(directory);
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
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}

async function removeQuarantinedLock(
  quarantinePath: string,
  expected: {
    ownerToken: string;
    processIdentity?: FederatedJobProcessIdentity;
    proofPath?: string;
    fileIdentity?: { dev: number; ino: number };
  },
  options: ResolvedFederatedJobLockOptions,
): Promise<void> {
  const stat = await fsPromises.lstat(quarantinePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Federation job lock quarantine has an unsafe type: ${quarantinePath}`);
  }
  if (stat.isFile()) {
    if (
      expected.fileIdentity &&
      (Number(stat.dev) !== expected.fileIdentity.dev ||
        Number(stat.ino) !== expected.fileIdentity.ino)
    ) {
      throw new Error(`Federation job lock quarantine provenance changed: ${quarantinePath}`);
    }
    const parsed = await readJsonFile(quarantinePath);
    if (
      !parsed ||
      !isLockRecord(parsed.value) ||
      parsed.value.ownerToken !== expected.ownerToken ||
      (expected.processIdentity &&
        (parsed.value.version !== 2 ||
          !processIdentityEquals(parsed.value.processIdentity, expected.processIdentity)))
    ) {
      throw new Error(`Federation job lock quarantine ownership changed: ${quarantinePath}`);
    }
    if (expected.proofPath && !(await samePhysicalFile(quarantinePath, expected.proofPath))) {
      throw new Error(`Federation job lock quarantine provenance changed: ${quarantinePath}`);
    }
    await unlinkWithRetry(quarantinePath, options, async () => {
      if (!(await pathExists(quarantinePath))) return true;
      return expected.proofPath
        ? samePhysicalFile(quarantinePath, expected.proofPath)
        : Boolean(
            (await readLockSnapshot(quarantinePath))?.record.ownerToken === expected.ownerToken,
          );
    });
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Federation job lock quarantine has an unsafe type: ${quarantinePath}`);
  }
  if (
    expected.fileIdentity &&
    (Number(stat.dev) !== expected.fileIdentity.dev ||
      Number(stat.ino) !== expected.fileIdentity.ino)
  ) {
    throw new Error(`Federation job lock quarantine provenance changed: ${quarantinePath}`);
  }
  const entries = await fsPromises.readdir(quarantinePath);
  const expectedOwner = ownerFileName(expected.ownerToken);
  const allowed = new Set([expectedOwner, LOCK_RECLAIM_FILE]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error(`Federation job lock quarantine has unexpected evidence: ${quarantinePath}`);
  }
  if (entries.includes(expectedOwner)) {
    const snapshot = await readLockSnapshot(quarantinePath);
    if (
      !snapshot ||
      snapshot.record.ownerToken !== expected.ownerToken ||
      (expected.processIdentity &&
        (snapshot.record.version !== 2 ||
          !processIdentityEquals(snapshot.record.processIdentity, expected.processIdentity)))
    ) {
      throw new Error(`Federation job lock quarantine ownership changed: ${quarantinePath}`);
    }
  }
  for (const entry of entries) {
    await unlinkWithRetry(path.join(quarantinePath, entry), options);
  }
  await removeDirectoryWithRetry(quarantinePath, options);
}

async function samePhysicalFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([
      fsPromises.lstat(left),
      fsPromises.lstat(right),
    ]);
    return (
      leftStat.isFile() &&
      !leftStat.isSymbolicLink() &&
      rightStat.isFile() &&
      !rightStat.isSymbolicLink() &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readPhysicalFileIdentity(
  target: string,
): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const stat = await fsPromises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function matchesPhysicalFileIdentity(
  target: string,
  expected: { dev: number; ino: number },
): Promise<boolean> {
  const observed = await readPhysicalFileIdentity(target);
  return Boolean(observed && observed.dev === expected.dev && observed.ino === expected.ino);
}

async function isPhysicalDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fsPromises.lstat(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function restoreDisplacedQuarantine(
  lockPath: string,
  quarantinePath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<"restored" | "occupied" | "unsafe"> {
  let quarantineStat: Awaited<ReturnType<typeof fsPromises.lstat>>;
  try {
    quarantineStat = await fsPromises.lstat(quarantinePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unsafe";
    throw error;
  }
  if (quarantineStat.isSymbolicLink()) return "unsafe";

  let sourcePath = quarantinePath;
  let directoryOwner: FederatedJobLockRecord | undefined;
  if (quarantineStat.isDirectory()) {
    const snapshot = await readLockSnapshot(quarantinePath);
    if (!snapshot || snapshot.layout !== "directory") return "unsafe";
    sourcePath = snapshot.ownerPath;
    directoryOwner = snapshot.record;
  } else if (!quarantineStat.isFile()) {
    return "unsafe";
  }

  if (await pathExists(lockPath)) {
    if (!(await samePhysicalFile(sourcePath, lockPath))) return "occupied";
  } else {
    try {
      await linkWithRetry(sourcePath, lockPath, options);
      await options.syncDirectory(path.dirname(lockPath));
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(code ?? "") &&
        (await pathExists(lockPath))
      ) {
        return "occupied";
      }
      throw error;
    }
  }

  if (directoryOwner) {
    await removeQuarantinedLock(
      quarantinePath,
      {
        ownerToken: directoryOwner.ownerToken,
        processIdentity: directoryOwner.version === 2 ? directoryOwner.processIdentity : undefined,
        fileIdentity: {
          dev: Number(quarantineStat.dev),
          ino: Number(quarantineStat.ino),
        },
      },
      options,
    );
  } else {
    await unlinkWithRetry(quarantinePath, options, async () => {
      if (!(await pathExists(quarantinePath))) return true;
      return samePhysicalFile(sourcePath, lockPath);
    });
  }
  return "restored";
}

async function clearCanonicalForQuarantineRestore(
  lockPath: string,
  quarantinePath: string,
  options: ResolvedFederatedJobLockOptions,
  mayRemoveRecord: (snapshot: FederatedJobLockSnapshot) => Promise<boolean>,
): Promise<boolean> {
  const displacedPath = `${quarantinePath}.occupant`;
  const clearMoved = async (): Promise<boolean> => {
    const moved = await readLockSnapshot(displacedPath);
    if (moved) {
      if (!(await mayRemoveRecord(moved))) return false;
      await removeQuarantinedLock(
        displacedPath,
        {
          ownerToken: moved.record.ownerToken,
          processIdentity: moved.record.version === 2 ? moved.record.processIdentity : undefined,
          fileIdentity: moved.fileIdentity,
        },
        options,
      );
      return true;
    }
    const legacy = await readLegacyLockIdentity(displacedPath);
    if (legacy) return false;
    return !(await pathExists(displacedPath));
  };

  if (await pathExists(displacedPath)) return clearMoved();

  const current = await readLockSnapshot(lockPath);
  const legacy = current ? undefined : await readLegacyLockIdentity(lockPath);
  if (!current && !legacy) return !(await pathExists(lockPath));
  if (current) {
    if (!(await mayRemoveRecord(current))) return false;
  } else if (legacy) {
    // Empty pre-v2 lock evidence has no owner identity. Even when old, it may
    // still represent an open legacy critical section and cannot be removed.
    return false;
  } else {
    return false;
  }

  try {
    await renameWithRetry(lockPath, displacedPath, options, async () => {
      const latest = await readLockSnapshot(lockPath);
      if (current) {
        return Boolean(
          latest &&
          latest.layout === current.layout &&
          latest.record.ownerToken === current.record.ownerToken &&
          (await mayRemoveRecord(latest)),
        );
      }
      return false;
    });
  } catch (error: unknown) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
  return clearMoved();
}

async function restoreReclaimDisplacedQuarantine(
  lockPath: string,
  quarantinePath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  let restored = await restoreDisplacedQuarantine(lockPath, quarantinePath, options);
  if (restored === "occupied") {
    const cleared = await clearCanonicalForQuarantineRestore(
      lockPath,
      quarantinePath,
      options,
      (snapshot) => isProvablyReclaimableOwner(snapshot, options),
    );
    if (!cleared) return false;
    restored = await restoreDisplacedQuarantine(lockPath, quarantinePath, options);
  }
  return restored === "restored";
}

async function restoreReleaseDisplacedQuarantine(
  lockPath: string,
  quarantinePath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  let restored = await restoreDisplacedQuarantine(lockPath, quarantinePath, options);
  if (restored === "occupied") {
    const ownerPath = hasExactOwnerArtifactForLock(lockPath, owner)
      ? path.join(path.dirname(lockPath), owner.ownerArtifact)
      : undefined;
    const cleared = await clearCanonicalForQuarantineRestore(
      lockPath,
      quarantinePath,
      options,
      async (snapshot) =>
        (ownerPath !== undefined &&
          exactOwnerMatches(owner, snapshot.record) &&
          (await samePhysicalFile(lockPath, ownerPath))) ||
        (await isProvablyReclaimableOwner(snapshot, options)),
    );
    if (!cleared) return false;
    restored = await restoreDisplacedQuarantine(lockPath, quarantinePath, options);
  }
  return restored === "restored";
}

async function completeReclaimRequest(
  lockPath: string,
  requestPath: string,
  request: FederatedJobReclaimRecord,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  const quarantinePath = reclaimQuarantinePath(lockPath, requestPath);
  if (!quarantinePath || !path.basename(requestPath).endsWith(request.requestToken)) return false;
  // Pre-v2 locks carry no PID, host, or process-incarnation evidence. Age is
  // not proof that their still-open critical section ended, so they require
  // explicit out-of-band recovery instead of automatic takeover.
  if (request.observedOwnerVersion === "legacy-file") return false;

  if (await pathExists(quarantinePath)) {
    const moved = await readLockSnapshot(quarantinePath);
    const expectedPartialDirectory =
      !moved &&
      request.observedLayout === "directory" &&
      (await isPhysicalDirectory(quarantinePath));
    if (
      !expectedPartialDirectory &&
      (!moved || !lockSnapshotMatchesReclaim(lockPath, moved, request))
    ) {
      if (!(await restoreReclaimDisplacedQuarantine(lockPath, quarantinePath, options))) {
        return false;
      }
      await unlinkControlRequest(requestPath, options);
      return true;
    }
    await removeQuarantinedLock(
      quarantinePath,
      {
        ownerToken: request.observedOwnerToken,
        processIdentity: request.observedProcessIdentity,
        fileIdentity: request.observedFileIdentity,
      },
      options,
    );
    await unlinkControlRequest(requestPath, options);
    return true;
  }

  const current = await readLockSnapshot(lockPath);
  if (!current) {
    if (!(await pathExists(lockPath))) {
      await unlinkControlRequest(requestPath, options);
    }
    return false;
  }
  if (!lockSnapshotMatchesReclaim(lockPath, current, request)) {
    return false;
  }
  if (!(await isProvablyReclaimableOwner(current, options))) return false;
  if (current.layout === "directory") {
    await publishRecordNoReplace(
      lockPath,
      path.join(lockPath, LOCK_RECLAIM_FILE),
      request,
      options,
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  try {
    await renameWithRetry(lockPath, quarantinePath, options, async () => {
      const latest = await readLockSnapshot(lockPath);
      return Boolean(
        latest &&
        lockSnapshotMatchesReclaim(lockPath, latest, request) &&
        (await isProvablyReclaimableOwner(latest, options)),
      );
    });
  } catch (error: unknown) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }

  const moved = await readLockSnapshot(quarantinePath);
  const expectedPartialDirectory =
    !moved && request.observedLayout === "directory" && (await isPhysicalDirectory(quarantinePath));
  if (
    !expectedPartialDirectory &&
    (!moved || !lockSnapshotMatchesReclaim(lockPath, moved, request))
  ) {
    if (!(await restoreReclaimDisplacedQuarantine(lockPath, quarantinePath, options))) {
      return false;
    }
    await unlinkControlRequest(requestPath, options);
    return true;
  }
  await removeQuarantinedLock(
    quarantinePath,
    {
      ownerToken: request.observedOwnerToken,
      processIdentity: request.observedProcessIdentity,
      fileIdentity: request.observedFileIdentity,
    },
    options,
  );
  await unlinkControlRequest(requestPath, options);
  return true;
}

async function tryReclaimFederatedJobLock(
  lockPath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  const observed = await readLockSnapshot(lockPath);
  if (!observed || !(await isProvablyReclaimableOwner(observed, options))) return false;

  const identity = await resolveCurrentProcessIdentity(options);
  const requestToken = randomUUID();
  const id = artifactId(options, identity);
  const requestPath = `${lockPath}${LOCK_RECLAIM_REQUEST_PREFIX}${id}-${requestToken}`;
  const request: FederatedJobReclaimRecord = {
    version: 2,
    kind: "reclaim",
    requestToken,
    observedOwnerToken: observed.record.ownerToken,
    observedOwnerVersion: observed.record.version,
    observedLayout: observed.layout,
    observedProcessIdentity:
      observed.record.version === 2 ? observed.record.processIdentity : undefined,
    observedOwnerArtifact:
      observed.record.version === 2 ? observed.record.ownerArtifact : undefined,
    observedFileIdentity: observed.fileIdentity,
    observedOwnerFileIdentity: observed.ownerFileIdentity,
    host: options.localHost,
    pid: process.pid,
    requestedAt: new Date().toISOString(),
    processIdentity: identity,
  };
  const published = await publishRecordNoReplace(lockPath, requestPath, request, options);
  if (!published) return false;
  return completeReclaimRequest(lockPath, requestPath, request, options);
}

function exactOwnerMatches(
  expected: FederatedJobLockRecordV2,
  observed: FederatedJobLockRecord,
): boolean {
  return (
    observed.version === 2 &&
    observed.ownerToken === expected.ownerToken &&
    observed.host.toLowerCase() === expected.host.toLowerCase() &&
    observed.pid === expected.pid &&
    observed.acquiredAt === expected.acquiredAt &&
    observed.ownerArtifact === expected.ownerArtifact &&
    processIdentityEquals(observed.processIdentity, expected.processIdentity)
  );
}

function releaseQuarantinePath(lockPath: string, releasePath: string): string | undefined {
  const prefix = siblingArtifactPrefix(lockPath, LOCK_RELEASE_PREFIX);
  const name = path.basename(releasePath);
  if (!name.startsWith(prefix)) return undefined;
  const id = name.slice(prefix.length);
  return id ? `${lockPath}${LOCK_RELEASE_QUARANTINE_PREFIX}${id}` : undefined;
}

async function hasReleaseArtifactProvenance(
  lockPath: string,
  releasePath: string,
  quarantinePath: string,
  owner: FederatedJobLockRecordV2,
): Promise<boolean> {
  if (!hasExactOwnerArtifactForLock(lockPath, owner)) return false;
  const ownerPath = path.join(path.dirname(lockPath), owner.ownerArtifact);
  const retiredPath = retiredOwnerArtifactPath(ownerPath, owner);
  for (const authoritativePath of [ownerPath, retiredPath, lockPath, quarantinePath]) {
    if (await samePhysicalFile(releasePath, authoritativePath)) return true;
  }
  return false;
}

function retiredOwnerArtifactPath(ownerPath: string, owner: FederatedJobLockRecordV2): string {
  return `${ownerPath}.retired.${owner.ownerToken}`;
}

async function retireReleasedOwnerArtifact(
  lockPath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
  expectedIdentity?: { dev: number; ino: number },
  proofPath?: string,
): Promise<boolean> {
  if (!hasExactOwnerArtifactForLock(lockPath, owner)) return false;
  const ownerPath = path.join(path.dirname(lockPath), owner.ownerArtifact);
  const retiredPath = retiredOwnerArtifactPath(ownerPath, owner);
  let snapshot = await readLockSnapshot(ownerPath);
  if (!snapshot && (await pathExists(ownerPath))) return false;
  if (!snapshot) {
    snapshot = await readLockSnapshot(retiredPath);
    if (!snapshot && (await pathExists(retiredPath))) return false;
    if (!snapshot) return true;
  }
  if (
    snapshot?.layout !== "file" ||
    !exactOwnerMatches(owner, snapshot.record) ||
    (expectedIdentity &&
      (snapshot.fileIdentity.dev !== expectedIdentity.dev ||
        snapshot.fileIdentity.ino !== expectedIdentity.ino)) ||
    (await samePhysicalFile(snapshot.ownerPath, lockPath)) ||
    (await ownerArtifactHasDurableReference(lockPath, snapshot.ownerPath, [
      LOCK_RECLAIM_QUARANTINE_PREFIX,
    ])) ||
    // Restore publishes canonical before removing quarantine. If the scan no
    // longer sees quarantine, this ordered recheck sees the restored reference.
    (await samePhysicalFile(snapshot.ownerPath, lockPath)) ||
    (proofPath
      ? !(await matchesPhysicalFileIdentity(proofPath, snapshot.fileIdentity))
      : await ownerArtifactHasDurableReference(lockPath, snapshot.ownerPath))
  ) {
    return false;
  }

  const ownerIdentity = snapshot.fileIdentity;
  if (snapshot.ownerPath === ownerPath) {
    try {
      await renameWithRetry(ownerPath, retiredPath, options, () =>
        matchesPhysicalFileIdentity(ownerPath, ownerIdentity),
      );
    } catch {
      return false;
    }
  }
  if (!(await matchesPhysicalFileIdentity(retiredPath, ownerIdentity))) {
    if (!(await pathExists(ownerPath))) {
      await options.linkPath(retiredPath, ownerPath).catch(() => undefined);
    }
    return false;
  }
  try {
    await unlinkWithRetry(retiredPath, options, () =>
      matchesPhysicalFileIdentity(retiredPath, ownerIdentity),
    );
  } catch {
    return false;
  }
  return !(await pathExists(retiredPath));
}

async function retireReleaseArtifact(
  lockPath: string,
  releasePath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  const release = await readJsonFile(releasePath);
  if (
    !release ||
    !isLockRecord(release.value) ||
    release.value.version !== 2 ||
    !exactOwnerMatches(owner, release.value)
  ) {
    return false;
  }
  const ownerPath = hasExactOwnerArtifactForLock(lockPath, owner)
    ? path.join(path.dirname(lockPath), owner.ownerArtifact)
    : undefined;
  if (ownerPath) {
    if (
      !(await retireReleasedOwnerArtifact(
        lockPath,
        owner,
        options,
        release.fileIdentity,
        releasePath,
      ))
    ) {
      return false;
    }
  }
  await unlinkControlRequest(releasePath, options);
  return true;
}

function processLocalReleaseQuarantinePath(
  lockPath: string,
  owner: FederatedJobLockRecordV2,
): string {
  return `${lockPath}${LOCK_RELEASE_QUARANTINE_PREFIX}local-${processIdentityHash(
    owner.processIdentity,
  )}-${owner.ownerToken}`;
}

async function completeProcessLocalRelease(
  lockPath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  if (!hasExactOwnerArtifactForLock(lockPath, owner)) return false;
  const ownerPath = path.join(path.dirname(lockPath), owner.ownerArtifact);
  const quarantinePath = processLocalReleaseQuarantinePath(lockPath, owner);
  if (await pathExists(quarantinePath)) {
    const moved = await readLockSnapshot(quarantinePath);
    const expectedPartialDirectory =
      !moved && !owner.ownerArtifact && (await isPhysicalDirectory(quarantinePath));
    if (!expectedPartialDirectory && (!moved || !exactOwnerMatches(owner, moved.record))) {
      if (!(await restoreReleaseDisplacedQuarantine(lockPath, quarantinePath, owner, options))) {
        return false;
      }
      return true;
    }
    await removeQuarantinedLock(
      quarantinePath,
      {
        ownerToken: owner.ownerToken,
        processIdentity: owner.processIdentity,
        proofPath: ownerPath,
      },
      options,
    );
    if (!(await retireReleasedOwnerArtifact(lockPath, owner, options, moved?.fileIdentity))) {
      return false;
    }
    await options.syncDirectory(path.dirname(lockPath));
    return true;
  }

  const current = await readLockSnapshot(lockPath);
  if (!current) {
    if (await pathExists(lockPath)) return false;
    if (!(await retireReleasedOwnerArtifact(lockPath, owner, options))) return false;
    await options.syncDirectory(path.dirname(lockPath));
    return true;
  }
  if (!exactOwnerMatches(owner, current.record)) {
    return retireReleasedOwnerArtifact(lockPath, owner, options);
  }
  if (!(await samePhysicalFile(lockPath, ownerPath))) {
    return retireReleasedOwnerArtifact(lockPath, owner, options);
  }

  try {
    await renameWithRetry(lockPath, quarantinePath, options, async () => {
      const observed = await readLockSnapshot(lockPath);
      return Boolean(
        observed &&
        exactOwnerMatches(owner, observed.record) &&
        (await samePhysicalFile(lockPath, ownerPath)),
      );
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const latest = await readLockSnapshot(lockPath);
      if (!latest && !(await pathExists(lockPath))) return false;
      if (latest && !exactOwnerMatches(owner, latest.record)) {
        return true;
      }
      return false;
    }
    throw error;
  }

  const moved = await readLockSnapshot(quarantinePath);
  if (!moved || !exactOwnerMatches(owner, moved.record)) {
    if (!(await restoreReleaseDisplacedQuarantine(lockPath, quarantinePath, owner, options))) {
      return false;
    }
    return true;
  }
  await removeQuarantinedLock(
    quarantinePath,
    {
      ownerToken: owner.ownerToken,
      processIdentity: owner.processIdentity,
      proofPath: ownerPath,
    },
    options,
  );
  if (!(await retireReleasedOwnerArtifact(lockPath, owner, options, moved.fileIdentity))) {
    return false;
  }
  await options.syncDirectory(path.dirname(lockPath));
  return true;
}

async function completeReleaseArtifact(
  lockPath: string,
  releasePath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
): Promise<boolean> {
  if (!path.basename(releasePath).endsWith(owner.ownerToken)) return false;
  if (!hasExactOwnerArtifactForLock(lockPath, owner)) return false;
  const quarantinePath = releaseQuarantinePath(lockPath, releasePath);
  if (!quarantinePath) return false;
  if (!(await hasReleaseArtifactProvenance(lockPath, releasePath, quarantinePath, owner))) {
    return false;
  }

  if (await pathExists(quarantinePath)) {
    const moved = await readLockSnapshot(quarantinePath);
    if (!moved || !exactOwnerMatches(owner, moved.record)) {
      if (!(await restoreReleaseDisplacedQuarantine(lockPath, quarantinePath, owner, options))) {
        return false;
      }
      return retireReleaseArtifact(lockPath, releasePath, owner, options);
    }
    await removeQuarantinedLock(
      quarantinePath,
      {
        ownerToken: owner.ownerToken,
        processIdentity: owner.processIdentity,
        proofPath: releasePath,
      },
      options,
    );
    return retireReleaseArtifact(lockPath, releasePath, owner, options);
  }

  const current = await readLockSnapshot(lockPath);
  if (!current) {
    if (!(await pathExists(lockPath))) {
      return retireReleaseArtifact(lockPath, releasePath, owner, options);
    }
    return false;
  }
  if (!exactOwnerMatches(owner, current.record)) {
    return retireReleaseArtifact(lockPath, releasePath, owner, options);
  }
  if (!(await samePhysicalFile(lockPath, releasePath))) {
    // A byte-identical replacement is not the owner authorized by this
    // hard-linked intent. Retire only the old intent and preserve canonical.
    return retireReleaseArtifact(lockPath, releasePath, owner, options);
  }

  try {
    await renameWithRetry(lockPath, quarantinePath, options, async () => {
      const observed = await readLockSnapshot(lockPath);
      return Boolean(
        observed &&
        exactOwnerMatches(owner, observed.record) &&
        (await samePhysicalFile(lockPath, releasePath)),
      );
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const moved = await readLockSnapshot(quarantinePath);
  const expectedPartialDirectory =
    !moved && !owner.ownerArtifact && (await isPhysicalDirectory(quarantinePath));
  if (!expectedPartialDirectory && (!moved || !exactOwnerMatches(owner, moved.record))) {
    if (!(await restoreReleaseDisplacedQuarantine(lockPath, quarantinePath, owner, options))) {
      return false;
    }
    return retireReleaseArtifact(lockPath, releasePath, owner, options);
  }
  await removeQuarantinedLock(
    quarantinePath,
    {
      ownerToken: owner.ownerToken,
      processIdentity: owner.processIdentity,
      proofPath: releasePath,
    },
    options,
  );
  return retireReleaseArtifact(lockPath, releasePath, owner, options);
}

async function publishAndCompleteRelease(
  lockPath: string,
  owner: FederatedJobLockRecordV2,
  options: ResolvedFederatedJobLockOptions,
): Promise<{ durable: boolean; error?: unknown }> {
  if (!hasExactOwnerArtifactForLock(lockPath, owner)) {
    return { durable: false, error: new Error("Invalid lock owner artifact") };
  }
  const ownerArtifact = path.join(path.dirname(lockPath), owner.ownerArtifact);
  if (
    !(await samePhysicalFile(lockPath, ownerArtifact)) &&
    !(await ownerArtifactHasDurableReference(lockPath, ownerArtifact, [
      LOCK_RECLAIM_QUARANTINE_PREFIX,
    ])) &&
    !(await samePhysicalFile(lockPath, ownerArtifact))
  ) {
    if (!(await pathExists(lockPath))) return { durable: true };
    return {
      durable: true,
      error: new Error("Federation job lock ownership changed before release"),
    };
  }
  const releasePath = `${lockPath}${LOCK_RELEASE_PREFIX}${artifactId(
    options,
    owner.processIdentity,
  )}-${owner.ownerToken}`;
  let published = false;
  let publicationDurable = false;
  try {
    try {
      await linkWithRetry(ownerArtifact, releasePath, options);
      published = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJsonFile(releasePath);
      if (
        !existing ||
        !isLockRecord(existing.value) ||
        !exactOwnerMatches(owner, existing.value) ||
        !(await samePhysicalFile(ownerArtifact, releasePath))
      ) {
        throw error;
      }
      published = true;
    }
    await options.syncPublishedReleaseFile(releasePath);
    // Windows cannot fsync directories through Node. FlushFileBuffers on the
    // published hard-link target is the attainable recovery boundary there;
    // POSIX still requires the containing directory fsync below.
    if (process.platform === "win32") publicationDurable = true;
    await options.syncDirectory(path.dirname(lockPath));
    if (process.platform !== "win32") publicationDurable = true;
    const completed = await completeReleaseArtifact(lockPath, releasePath, owner, options);
    if (!completed) throw new Error(`Federation job lock release remains pending: ${lockPath}`);
    pendingProcessLocalReleases.delete(lockPath);
    return { durable: true };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await pathExists(lockPath))) {
      pendingProcessLocalReleases.delete(lockPath);
      return { durable: true };
    }
    if (published && !publicationDurable) {
      // The hard link may be visible but is not crash-durable until the
      // containing directory sync succeeds. Keep process-local recovery state
      // and force completed callers through CompletedActionError.
      pendingProcessLocalReleases.set(lockPath, owner);
      return { durable: false, error };
    }
    if (!published) {
      pendingProcessLocalReleases.set(lockPath, owner);
      try {
        if (await completeProcessLocalRelease(lockPath, owner, options)) {
          pendingProcessLocalReleases.delete(lockPath);
          return { durable: true };
        }
      } catch (fallbackError: unknown) {
        const current = await readLockSnapshot(lockPath);
        const canonicalExists = await pathExists(lockPath);
        if (current && !exactOwnerMatches(owner, current.record)) {
          return { durable: true, error: fallbackError };
        }
        if (!current && !canonicalExists) {
          return { durable: false, error: fallbackError };
        }
        return {
          durable: false,
          error: new AggregateError(
            [error, fallbackError],
            `Federation job lock release could not be published or completed: ${lockPath}`,
          ),
        };
      }
    }
    return { durable: publicationDurable, error };
  }
}

async function reconcileControlRequests(
  lockPath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<{ blocked: boolean; progressed: boolean }> {
  let blocked = false;
  let progressed = false;

  const pendingRelease = pendingProcessLocalReleases.get(lockPath);
  if (pendingRelease) {
    try {
      if (await completeProcessLocalRelease(lockPath, pendingRelease, options)) {
        pendingProcessLocalReleases.delete(lockPath);
        progressed = true;
      } else {
        blocked = true;
      }
    } catch {
      blocked = true;
    }
  }

  for (const releasePath of await listSiblingArtifacts(lockPath, LOCK_RELEASE_PREFIX)) {
    const parsed = await readJsonFile(releasePath);
    if (!parsed || !isLockRecord(parsed.value) || parsed.value.version !== 2) {
      blocked = true;
      continue;
    }
    try {
      if (await completeReleaseArtifact(lockPath, releasePath, parsed.value, options)) {
        progressed = true;
      } else {
        blocked = true;
      }
    } catch {
      blocked = true;
    }
  }

  for (const quarantinePath of await listSiblingArtifacts(
    lockPath,
    LOCK_RELEASE_QUARANTINE_PREFIX,
  )) {
    const snapshot = await readLockSnapshot(quarantinePath);
    if (
      !snapshot ||
      snapshot.record.version !== 2 ||
      !hasExactOwnerArtifactForLock(lockPath, snapshot.record) ||
      !path.basename(quarantinePath).endsWith(snapshot.record.ownerToken)
    ) {
      blocked = true;
      continue;
    }
    const ownerPath = path.join(path.dirname(lockPath), snapshot.record.ownerArtifact);
    if (!(await samePhysicalFile(quarantinePath, ownerPath))) {
      blocked = true;
      continue;
    }
    try {
      await removeQuarantinedLock(
        quarantinePath,
        {
          ownerToken: snapshot.record.ownerToken,
          processIdentity: snapshot.record.processIdentity,
          proofPath: ownerPath,
        },
        options,
      );
      if (
        await retireReleasedOwnerArtifact(lockPath, snapshot.record, options, snapshot.fileIdentity)
      ) {
        progressed = true;
      } else {
        pendingProcessLocalReleases.set(lockPath, snapshot.record);
        blocked = true;
      }
    } catch {
      blocked = true;
    }
  }

  for (const requestPath of await listSiblingArtifacts(lockPath, LOCK_RECLAIM_REQUEST_PREFIX)) {
    const parsed = await readJsonFile(requestPath);
    if (!parsed || !isReclaimRecord(parsed.value)) {
      blocked = true;
      continue;
    }
    const request = parsed.value;
    // Requester liveness is not authority over the observed owner. Any peer
    // may finish this durable transaction; completeReclaimRequest revalidates
    // the exact owner token, incarnation, layout, and inode before mutation.
    try {
      if (await completeReclaimRequest(lockPath, requestPath, request, options)) {
        progressed = true;
      } else {
        blocked = true;
      }
    } catch {
      blocked = true;
    }
  }

  for (const quarantinePath of await listSiblingArtifacts(
    lockPath,
    LOCK_RECLAIM_QUARANTINE_PREFIX,
  )) {
    const suffix = path
      .basename(quarantinePath)
      .slice(siblingArtifactPrefix(lockPath, LOCK_RECLAIM_QUARANTINE_PREFIX).length);
    if (await pathExists(`${lockPath}${LOCK_RECLAIM_REQUEST_PREFIX}${suffix}`)) continue;
    const snapshot = await readLockSnapshot(quarantinePath);
    if (!snapshot && !(await pathExists(quarantinePath))) continue;
    if (
      !snapshot ||
      snapshot.layout !== "file" ||
      snapshot.record.version !== 2 ||
      !hasExactOwnerArtifactForLock(lockPath, snapshot.record) ||
      suffix.endsWith(".occupant") ||
      !(await samePhysicalFile(
        quarantinePath,
        path.join(path.dirname(lockPath), snapshot.record.ownerArtifact),
      ))
    ) {
      blocked = true;
      continue;
    }
    // A peer can finish and remove a reclaim request while its original caller
    // is paused before rename. That delayed rename may displace a newer owner.
    // Preserve the quarantine as an admission fence and restore the exact owner;
    // age is never authority to discard a possibly active critical section.
    try {
      if (await restoreReclaimDisplacedQuarantine(lockPath, quarantinePath, options)) {
        progressed = true;
      } else {
        blocked = true;
      }
    } catch {
      blocked = true;
    }
  }
  return { blocked, progressed };
}

async function hasControlRequests(lockPath: string): Promise<boolean> {
  return (
    (await listSiblingArtifacts(lockPath, LOCK_RELEASE_PREFIX)).length > 0 ||
    (await listSiblingArtifacts(lockPath, LOCK_RELEASE_QUARANTINE_PREFIX)).length > 0 ||
    (await listSiblingArtifacts(lockPath, LOCK_RECLAIM_REQUEST_PREFIX)).length > 0 ||
    (await listSiblingArtifacts(lockPath, LOCK_RECLAIM_QUARANTINE_PREFIX)).length > 0
  );
}

async function tryAcquireFederatedJobLock(
  lockPath: string,
  options: ResolvedFederatedJobLockOptions,
): Promise<FederatedJobLockLease | undefined> {
  const identity = await resolveCurrentProcessIdentity(options);
  const ownerToken = randomUUID();
  const ownerArtifact = `${path.basename(lockPath)}${LOCK_OWNER_ARTIFACT_PREFIX}${artifactId(
    options,
    identity,
  )}-${ownerToken}`;
  const ownerPath = path.join(path.dirname(lockPath), ownerArtifact);
  const record: FederatedJobLockRecordV2 = {
    version: 2,
    ownerToken,
    host: options.localHost,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    processIdentity: identity,
    ownerArtifact,
  };
  let published = false;
  const ownerHandle = await fsPromises.open(ownerPath, "wx", 0o600);
  try {
    try {
      await ownerHandle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    try {
      await linkWithRetry(ownerPath, lockPath, options);
      published = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EEXIST", "ENOTEMPTY"].includes(code ?? "")) return undefined;
      if (["EPERM", "EACCES"].includes(code ?? "") && (await pathExists(lockPath))) {
        return undefined;
      }
      throw error;
    }
    try {
      await options.syncDirectory(path.dirname(lockPath));
    } catch (syncError: unknown) {
      let release: { durable: boolean; error?: unknown } | undefined;
      let releaseError: unknown;
      try {
        release = await publishAndCompleteRelease(lockPath, record, options);
      } catch (error: unknown) {
        releaseError = error;
      }
      if (releaseError || (release?.error && !release.durable)) {
        throw new AggregateError(
          [syncError, releaseError ?? release?.error],
          `Federation job lock publication could not be made recoverable: ${lockPath}`,
          { cause: syncError },
        );
      }
      throw syncError;
    }

    try {
      return {
        lockPath,
        ownerPath,
        ownerToken,
        record,
        ownerHandle: await options.openOwnerHandle(ownerPath),
      };
    } catch (error: unknown) {
      const current = await readLockSnapshot(lockPath);
      if (
        current &&
        exactOwnerMatches(record, current.record) &&
        (await samePhysicalFile(lockPath, ownerPath))
      ) {
        try {
          const release = await publishAndCompleteRelease(lockPath, record, options);
          if (release.error) {
            if (release.error instanceof Error) throw release.error;
            throw new Error("Federation job lock cleanup failed", { cause: release.error });
          }
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `Failed to open and clean up federation job lock ${lockPath}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  } finally {
    if (!published) {
      await unlinkWithRetry(ownerPath, options).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

async function releaseFederatedJobLock(
  lease: FederatedJobLockLease,
  options: ResolvedFederatedJobLockOptions,
): Promise<{ durable: boolean; error?: unknown }> {
  return publishAndCompleteRelease(lease.lockPath, lease.record, options);
}

async function assertFederatedJobLockOwner(lease: FederatedJobLockLease): Promise<void> {
  const current = await readLockSnapshot(lease.lockPath);
  if (
    current &&
    current.layout === "file" &&
    exactOwnerMatches(lease.record, current.record) &&
    hasExactOwnerArtifactForLock(lease.lockPath, current.record) &&
    (await samePhysicalFile(lease.lockPath, lease.ownerPath))
  ) {
    return;
  }
  throw new Error(`Federation job lock ownership was lost: ${lease.lockPath}`);
}

export function federationDir(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "jobs");
}

export async function saveFederatedJob(
  projectRoot: string,
  record: FederatedJobRecord,
): Promise<void> {
  const dir = federationDir(projectRoot);
  await fsPromises.mkdir(dir, { recursive: true });
  await withFederatedJobLock(projectRoot, record.jobId, async () => {
    await persistFederatedJob(projectRoot, record);
  });
}

async function persistFederatedJob(projectRoot: string, record: FederatedJobRecord): Promise<void> {
  const dir = federationDir(projectRoot);
  const target = path.join(dir, `${record.jobId}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(record, null, 2);
  let renamed = false;
  try {
    const recordHandle = await fsPromises.open(temporary, "wx", 0o600);
    try {
      await recordHandle.writeFile(serialized, "utf-8");
      await recordHandle.sync();
      await afterFederatedJobPersistenceStageForTest?.("record_file_synced", target);
    } finally {
      await recordHandle.close();
    }
    await fsPromises.rename(temporary, target);
    renamed = true;
    await afterFederatedJobPersistenceStageForTest?.("record_published", target);
    // Flush the path that will be used for recovery after publication. On
    // Windows this is the attainable durable boundary (FlushFileBuffers on
    // the published file); directory fsync is unsupported and is never
    // claimed. If this step fails, the completion intent remains for replay.
    await syncPublishedFile(target);
    await afterFederatedJobPersistenceStageForTest?.("record_published_file_synced", target);
    if (await syncPersistenceDirectoryIfSupported(dir)) {
      await afterFederatedJobPersistenceStageForTest?.("record_directory_synced", target);
    }
    await afterFederatedJobPersistenceStageForTest?.("record_durability_acknowledged", target);
  } finally {
    if (!renamed) {
      await fsPromises.unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  const auditPath = path.join(dir, "records.jsonl");
  const auditHandle = await fsPromises.open(auditPath, "a", 0o600);
  try {
    await auditHandle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
    await auditHandle.sync();
    await afterFederatedJobPersistenceStageForTest?.("audit_file_synced", auditPath);
  } finally {
    await auditHandle.close();
  }
  if (await syncPersistenceDirectoryIfSupported(dir)) {
    await afterFederatedJobPersistenceStageForTest?.("audit_directory_synced", auditPath);
  }
  await afterFederatedJobPersistenceStageForTest?.("audit_durability_acknowledged", auditPath);
}

/** Internal federation primitive for owner-fenced, heartbeat-backed critical sections. */
export async function withFederatedJobLock<T>(
  projectRoot: string,
  jobId: string,
  action: () => Promise<T>,
  lockOptions: FederatedJobLockOptions = {},
): Promise<T> {
  return withOwnerFencedFileLock(
    path.join(federationDir(projectRoot), `${jobId}.lock`),
    projectRoot,
    action,
    lockOptions,
    jobId,
  );
}

/**
 * Internal path-based entry to the accepted federation lock protocol. Callers
 * share its owner fencing and crash recovery without requiring a job or Git repo.
 * Existing federation error types retain completed-action/retry semantics.
 */
export async function withOwnerFencedFileLock<T>(
  lockPath: string,
  trustedBoundaryRoot: string,
  action: () => Promise<T>,
  lockOptions: FederatedJobLockOptions = {},
  lockId: string = lockPath,
): Promise<T> {
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  const options = resolveLockOptions(lockOptions, trustedBoundaryRoot);
  const deadline = Date.now() + options.waitTimeoutMs;
  let lease: FederatedJobLockLease | undefined;
  for (;;) {
    const reconciliation = await reconcileControlRequests(lockPath, options);
    if (reconciliation.blocked) {
      if (Date.now() >= deadline) throw new FederatedJobLockBusyError(lockId);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
      );
      continue;
    }
    await scavengeInertCrashArtifacts(lockPath, options);
    lease = await tryAcquireFederatedJobLock(lockPath, options);
    if (lease) {
      // A reclaimer may have published after our pre-acquisition check. No
      // callback is admitted until the exact new owner proves the fence is
      // still clear; otherwise publish a durable release and retry.
      if (!(await hasControlRequests(lockPath))) break;
      await lease.ownerHandle.close();
      const release = await releaseFederatedJobLock(lease, options);
      if (release.error && !release.durable) {
        if (release.error instanceof Error) throw release.error;
        throw new Error("Federation job lock release failed", { cause: release.error });
      }
      lease = undefined;
      continue;
    }
    if (await tryReclaimFederatedJobLock(lockPath, options)) continue;
    if (Date.now() >= deadline) throw new FederatedJobLockBusyError(lockId);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(options.retryMs, Math.max(1, deadline - Date.now()))),
    );
  }

  let heartbeatPending = Promise.resolve();
  const heartbeat = (): void => {
    heartbeatPending = heartbeatPending.then(async () => {
      try {
        const now = new Date();
        await lease.ownerHandle.utimes(now, now);
      } catch {
        // Ownership is authoritatively rechecked after the transition. A
        // transient timestamp failure cannot by itself make an already
        // persisted, still-owner transition ambiguous.
      }
    });
  };
  const heartbeatTimer = setInterval(heartbeat, options.heartbeatMs);
  heartbeatTimer.unref?.();
  let actionCompleted = false;
  let ownershipFenceFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action();
    actionCompleted = true;
  } catch (error: unknown) {
    actionError = error;
  }

  clearInterval(heartbeatTimer);
  const cleanupErrors: unknown[] = [];
  try {
    await heartbeatPending;
    if (actionCompleted) await assertFederatedJobLockOwner(lease);
  } catch (error: unknown) {
    ownershipFenceFailed = actionCompleted;
    cleanupErrors.push(error);
  }
  try {
    await lease.ownerHandle.close();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  try {
    await options.beforeReleaseForTest?.({ lockPath, ownerToken: lease.ownerToken });
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  let release: { durable: boolean; error?: unknown } = { durable: false };
  try {
    release = await releaseFederatedJobLock(lease, options);
    if (release.error) cleanupErrors.push(release.error);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  const combinedCleanupError =
    cleanupErrors.length === 0
      ? undefined
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Federation job lock cleanup failed");
  const cleanupError =
    combinedCleanupError && actionCompleted && (ownershipFenceFailed || !release.durable)
      ? new FederatedJobLockCompletedActionError(result, combinedCleanupError)
      : combinedCleanupError;

  if (cleanupError) {
    try {
      options.onReleaseError?.(cleanupError);
    } catch {
      // Cleanup reporting is advisory. It must not change a completed action
      // or replace the action's original error.
    }
  }
  if (!actionCompleted) {
    if (cleanupError && typeof actionError === "object" && actionError !== null) {
      try {
        Object.defineProperty(actionError, "federatedJobLockReleaseError", {
          value: cleanupError,
          configurable: true,
          enumerable: true,
        });
      } catch {
        // Frozen/non-extensible errors still retain precedence over advisory
        // release diagnostics.
      }
    }
    if (actionError instanceof Error) throw actionError;
    throw new Error("Federation job update failed", { cause: actionError });
  }
  if (cleanupError instanceof FederatedJobLockCompletedActionError) throw cleanupError;
  return result as T;
}

export async function updateFederatedJob(
  projectRoot: string,
  jobId: string,
  update: (record: FederatedJobRecord) => FederatedJobRecord | undefined,
  lockOptions: FederatedJobLockOptions = {},
): Promise<{ record?: FederatedJobRecord; changed: boolean }> {
  return withFederatedJobLock(
    projectRoot,
    jobId,
    async () => {
      const current = await loadFederatedJob(projectRoot, jobId);
      if (!current) return { changed: false };
      const next = update(current);
      if (!next) return { record: current, changed: false };
      await persistFederatedJob(projectRoot, next);
      return { record: next, changed: true };
    },
    lockOptions,
  );
}

/**
 * Run one asynchronous state transition while holding the job's exclusive
 * ledger lock. This is reserved for transitions whose admitted side effect
 * (for example, recording verification or creating a bounded fix job) must be
 * ordered atomically against cancellation of the parent job.
 */
export async function updateFederatedJobExclusive(
  projectRoot: string,
  jobId: string,
  update: (record: FederatedJobRecord) => Promise<FederatedJobRecord | undefined>,
  lockOptions: FederatedJobLockOptions = {},
): Promise<{ record?: FederatedJobRecord; changed: boolean }> {
  return withFederatedJobLock(
    projectRoot,
    jobId,
    async () => {
      const current = await loadFederatedJob(projectRoot, jobId);
      if (!current) return { changed: false };
      const next = await update(current);
      if (!next) return { record: current, changed: false };
      await persistFederatedJob(projectRoot, next);
      return { record: next, changed: true };
    },
    lockOptions,
  );
}

/**
 * Persist the parent transition before running a local, idempotent dependent
 * effect while retaining the parent's exclusive fence. Callers must publish a
 * durable recovery intent before returning a plan. This ordering prevents an
 * externally runnable dependent from existing without its parent reference.
 */
export async function updateFederatedJobWithPostPersistEffect<T>(
  projectRoot: string,
  jobId: string,
  prepare: (record: FederatedJobRecord) =>
    | Promise<
        | {
            record: FederatedJobRecord;
            effect: () => Promise<T>;
          }
        | undefined
      >
    | {
        record: FederatedJobRecord;
        effect: () => Promise<T>;
      }
    | undefined,
  lockOptions: FederatedJobLockOptions = {},
): Promise<{ record?: FederatedJobRecord; changed: boolean; effectResult?: T }> {
  return withFederatedJobLock(
    projectRoot,
    jobId,
    async () => {
      const current = await loadFederatedJob(projectRoot, jobId);
      if (!current) return { changed: false };
      const plan = await prepare(current);
      if (!plan) return { record: current, changed: false };
      await persistFederatedJob(projectRoot, plan.record);
      const effectResult = await plan.effect();
      return { record: plan.record, changed: true, effectResult };
    },
    lockOptions,
  );
}

export async function loadFederatedJob(
  projectRoot: string,
  jobId: string,
): Promise<FederatedJobRecord | undefined> {
  try {
    const raw = await fsPromises.readFile(
      path.join(federationDir(projectRoot), `${jobId}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as FederatedJobRecord;
  } catch {
    return undefined;
  }
}

export async function listFederatedJobs(projectRoot: string): Promise<FederatedJobRecord[]> {
  try {
    const dir = federationDir(projectRoot);
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = await fsPromises.readFile(path.join(dir, entry.name), "utf-8");
            return JSON.parse(raw) as FederatedJobRecord;
          } catch {
            return undefined;
          }
        }),
    );
    return jobs.filter((job): job is FederatedJobRecord => Boolean(job));
  } catch {
    return [];
  }
}
