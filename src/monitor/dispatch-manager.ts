import {
  buildClaudeChildEnvironment,
  selectClaudeApiKey,
  sanitizeClaudeDiagnostic,
} from "../sdk/claude-auth.js";
import {
  DispatchObservationStore,
  dispatchObservationIdentity,
  sameDispatchObservationIdentity,
  type DispatchObservationIdentity,
  type DispatchTerminalObservation,
} from "./dispatch-observation-store.js";
// ─── Dispatch Manager ──────────────────────────────────────────────
// Manages child processes for task dispatch. Spawns `node dist/index.js
// run TASK-NNN` as a subprocess so the Agent SDK can create its own
// Claude Code session (avoiding the nested session blocker).
//
// Uses git worktrees for branch isolation: each dispatched task runs in
// its own worktree so branch switches don't affect the main working
// directory. Legacy adapters may fall back to the shared working directory
// only when worktree initialization is explicitly disabled.
//
// The dispatch writes JSONL events to .quack/logs/ — the monitor's
// existing chokidar watcher picks them up and streams via SSE.

import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AdapterFreshnessMetadata,
  BranchCleanupOwnerOverride,
  BranchCleanupPolicyConfig,
  IsolationConfig,
} from "../core/types.js";
import { resolvePrepStorageDirSync } from "../core/prep-storage.js";
import {
  computeAdapterBundleMetadata,
  loadAdapter,
  TRUSTED_LOCAL_READ_REMOTES_ENV,
} from "../core/adapter-loader.js";
import { AdapterConfigSchema } from "../core/adapter-schema.js";
import {
  assertBranchDeletionAllowed,
  DEFAULT_PROTECTED_BRANCHES,
} from "../judgment/producers/branch-mutation.js";

/** Tier-S companion FILES the worktree refresh copies + hashes (TASK-1313). */
const MACHINERY_ASSET_FILES = [
  "adapter.json",
  "conventions.md",
  "judge-criteria.md",
  "verify.js",
] as const;
import {
  assertTrustedManagedDockerImage,
  DockerManager,
  TRUSTED_MANAGED_DOCKER_IMAGES_ENV,
  type DockerContainer,
  type DockerStopResult,
} from "../dispatcher/docker-manager.js";
import {
  DockerRuntimeBridge,
  inspectValidatedDockerPendingArchive,
  inspectValidatedDockerResumeArchive,
  isValidatedDockerResumeArchive,
  type DockerPausedRuntimeBinding,
  type DockerResumeSourceBinding,
} from "../dispatcher/docker-runtime-bridge.js";
import {
  clearDockerPublicationRecovery,
  findDockerPublicationRecovery,
  readDockerPublicationRecovery,
  type DockerPublicationJournal,
} from "../dispatcher/docker-publication-recovery.js";
import { appendDispatchChildExit } from "./child-exit-log.js";
import { cleanupWorktreeContainers } from "../dispatcher/docker-cleanup.js";
import {
  removeWorktree as lifecycleRemoveWorktree,
  prepareWorktreeFrontendDeps,
} from "../dispatcher/worktree-lifecycle.js";
import { WORKTREE_INIT_FRESH_ENV } from "../dispatcher/worktree-init.js";
import { runTrustedGitSync } from "../dispatcher/trusted-git.js";
import { isRateLimitError, parseRetryAfter, type KeyManager } from "../dispatcher/key-manager.js";
import {
  archivePausedRunState,
  PausedRunRefusalError,
  resolvePausedRunState,
} from "../dispatcher/paused-run-state.js";
import type { JobProvenance } from "./federation/types.js";
import { readSpecStaleMarker, recoveryAdviceFor } from "../core/spec-identity.js";
import {
  assertUncontestedClaimant,
  type DuplicateClaimantCheck,
} from "../core/duplicate-claimants.js";
import {
  inspectCodexDeniedPathQuarantine,
  inspectCodexDeniedPathQuarantineSync,
  recoverCodexDeniedPathQuarantine,
} from "../worker/codex-denied-path-guard.js";
import {
  createDecompositionDispatchAdmissionMarker,
  ensureDecompositionDispatchAdmissionDirectory,
  removeDecompositionDispatchAdmissionScope,
  revokeDecompositionDispatchAdmission,
  type CreatedDecompositionDispatchAdmission,
} from "../preflight/decomposition-dispatch-admission.js";
import {
  type DecompositionDispatchAdmission,
  withDecompositionAdmissionFence,
} from "../preflight/decomposition-transaction-journal.js";
import {
  cleanupTrustedNodeLaunch,
  confirmWindowsNodeLaunchAlreadyExited,
  spawnTrustedNode,
  terminateWindowsNodeJob,
  type TrustedNodeLaunch,
} from "./trusted-node-launch.js";
import { resolveWindowsTaskkillPath } from "../worker/codex-process-containment.js";

const CODEX_DENIED_QUARANTINE_DIRECTORY = /^\.quack-codex-denied-[A-Za-z0-9_-]+$/;
const OPERATOR_STOP_BARRIER_VERSION = 1;

interface OperatorStopBarrierRecord {
  version: typeof OPERATOR_STOP_BARRIER_VERSION;
  token: string;
  taskId: string;
  executionRoot: string;
  pid: number;
  createdAt: string;
}

function normalizeExecutionRoot(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Canonicalize an existing path, or its nearest existing ancestor plus suffix. */
function canonicalizePotentialPathSync(value: string): string {
  const absolute = path.resolve(value);
  const suffix: string[] = [];
  let candidate = absolute;
  while (candidate.length > 0) {
    try {
      fs.lstatSync(candidate);
      const canonical = fs.realpathSync(candidate);
      return path.normalize(path.join(canonical, ...suffix));
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (pathsEqualForDispatch(parent, candidate)) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
  throw new Error(`Unable to canonicalize path: ${value}`);
}

function pathsEqualForDispatch(left: string, right: string): boolean {
  return normalizeExecutionRoot(left) === normalizeExecutionRoot(right);
}

function dispatchChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== TRUSTED_MANAGED_DOCKER_IMAGES_ENV,
    ),
  );
}

class OrphanedQuarantineRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanedQuarantineRefusalError";
  }
}

class InvalidDispatchGitReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDispatchGitReferenceError";
  }
}

export interface DispatchJob {
  taskId: string;
  sessionId: string;
  pid: number;
  startedAt: string;
  /** Recorded only after child stdio and owned exit work have settled. */
  completedAt?: string;
  /** Exact trusted same-lease API-key retry, never inferred from task recency. */
  replacementSessionId?: string;
  /** Keeps the in-memory terminal attempt visible if durable observation fails. */
  observationPersistenceError?: string;
  status: "running" | "completed" | "failed" | "stopped" | "awaiting_approval";
  exitCode?: number;
  output: string[];
  worktreePath?: string;
  /** QPI-043: the signal that terminated the child, when it was killed
   *  rather than exiting on its own. Absent for a normal exit. */
  killedBySignal?: string;
  /**
   * Set before stop() signals the child. The exit/error callbacks use this
   * intent marker to distinguish an operator stop from an external kill.
   */
  operatorStopRequestedAt?: string;
  /** True while host-side termination/recovery still blocks a replacement. */
  operatorStopCleanupPending?: boolean;
  /**
   * True only after the dispatch process and its descendants are known to
   * be dead. Orphaned denied-path state must not be restored before this.
   */
  operatorStopTreeTerminated?: boolean;
  /** Detached process group owned by a worktree child on POSIX. */
  operatorStopProcessGroupId?: number;
  /** Actual host directory in which the mutable worker ran. */
  executionRoot?: string;
  /** Durable marker identity retained until cleanup is positively confirmed. */
  operatorStopBarrierPath?: string;
  operatorStopBarrierToken?: string;
  /**
   * TASK-1332 (QPI-045, round-2 R2-5): this run REFUSED to consume an
   * artifact whose spec contract had moved, rather than crashing. The
   * job still reads `failed` because the child exited non-zero and the
   * status union is consumed in many places, but a refusal must not be
   * triaged as a crash. Stale artifacts recover by replan; contested
   * ownership recovers by removing or renaming the extra claimant file.
   * Decided from a durable on-disk marker, not a lifecycle callback.
   */
  specStale?: { verdict: string; reason: string; refusedAt: string };
  branchName?: string;
  commitSha?: string;
  containerId?: string;
  /** Which API key ID was used for this dispatch (e.g. "key-1", "key-2") */
  keyId?: string;
  /** Set when an operator or shutdown path requested termination. */
  stopRequestedAt?: string;
  /** Branch/status that existed before a degraded shared-checkout run started. */
  sharedCheckoutOriginalBranch?: string;
  sharedCheckoutOriginalStatus?: string;
  /** UUID-backed durable checkout lease; callbacks must CAS against this value. */
  sharedCheckoutOwnershipId?: string;
  /** UUID-backed durable lease for this task's isolated worktree. */
  worktreeOwnershipId?: string;
  /** Docker-only trusted host archive imported after the agent exits. */
  runtimeLogDir?: string;
  /** Durable host-publication journal retained until every required step completes. */
  publicationRecoveryPath?: string;
  federatedJobId?: string;
  federatedHostId?: string;
  federatedHostAlias?: string;
  federatedHostEndpoint?: string;
  federatedLeaseId?: string;
  /** TASK-1323: how this dispatch entered the system (channel + identity + origin). */
  provenance?: JobProvenance;
}

export type ApprovalGate = "blueprint" | "judge";
export type DecidedApprovalState = "approved" | "rejected";

export type ApprovalDecisionConflictReason =
  | "decision_in_flight"
  | "dispatch_running"
  | "cleanup_live"
  | "operator_stopped"
  | "operator_stop_barrier"
  | "exit_unproven"
  | "approval_missing"
  | "approval_not_pending"
  | "approval_run_mismatch"
  | "other_gate_pending";

export interface SharedCheckoutShutdownSurvivor {
  taskId: string;
  sessionId: string;
  ownershipId?: string;
  processId?: number;
  status: DispatchJob["status"];
  reconciliationToken?: string;
}

export interface WorktreeShutdownSurvivor {
  version: 1 | 2;
  taskId: string;
  sessionId: string;
  /** UUID-backed generation used for every marker compare-and-swap. */
  ownershipId?: string;
  worktreePath: string;
  processId?: number;
  strategy: "posix-process-group" | "windows-process-tree" | "docker-container";
  state?: "acquired" | "running" | "stopping" | "survivor";
  recordedAt: string;
  /** Opaque identity required before durable evidence can be cleared. */
  reconciliationToken?: string;
}

export interface DispatchShutdownOptions {
  /** Time allowed for a POSIX process group to exit after SIGTERM. */
  gracefulTimeoutMs?: number;
  /** Time allowed for a forced process-tree termination to be confirmed. */
  forceTimeoutMs?: number;
}

export interface DispatchShutdownResult {
  requested: string[];
  exited: string[];
  escalated: string[];
  timedOut: string[];
  /**
   * Positive proof that every timed-out non-Docker child has an exact durable
   * ownership marker. Omission is not proof and must never authorize a hard
   * process exit.
   */
  durableAccountingComplete?: boolean;
}

export interface SharedCheckoutOccupant {
  taskId: string;
  status: DispatchJob["status"];
}

interface DurableSharedCheckoutPause {
  version: 1;
  taskId: string;
  sessionId: string;
  /** Unique ownership generation; session IDs are not collision-safe CAS keys. */
  ownershipId?: string;
  startedAt: string;
  pausedAt: string;
  /** Absent on legacy markers, where awaiting_approval is implied. */
  status?: "running" | "awaiting_approval" | "stopped" | "failed";
  /** Root PID/process-group ID for a running shared-checkout child. */
  processId?: number;
  /** Windows root exit alone cannot prove that descendants stopped. */
  processTreeStatus?: "unconfirmed" | "confirmed-stopped";
  /** Guards operator reconciliation from clearing a newer ownership record. */
  reconciliationToken?: string;
  /** Git state that must be restored before shared-checkout ownership is released. */
  originalBranch?: string;
  originalStatus?: string;
  /** Successful exit recorded for this ownership generation, pending tree confirmation. */
  successfulExitAt?: string;
}

interface SharedCheckoutBaseline {
  originalBranch?: string;
  originalStatus?: string;
}

interface DockerPausedRunPointer {
  version: 1;
  taskId: string;
  archiveName: string;
  dispatchSessionId: string;
  ownershipId: string;
  approvedGate: "blueprint" | "judge";
  provenance: JobProvenance;
  parentTaskId?: string;
  sharedBranchName?: string;
  recordedAt: string;
}

const SHARED_CHECKOUT_PAUSE_VERSION = 1;

/** Typed refusal raised while degraded shared-checkout ownership is occupied. */
export class DegradedSharedCheckoutBusyError extends Error {
  readonly occupants: SharedCheckoutOccupant[];
  readonly hasApprovalPause: boolean;
  readonly hasUnresolvedOccupant: boolean;

  constructor(taskId: string, jobs: readonly SharedCheckoutOccupant[]) {
    const occupants = jobs.map((job) => ({ taskId: job.taskId, status: job.status }));
    const occupantSummary = occupants
      .map((occupant) => `${occupant.taskId} (${occupant.status})`)
      .join(", ");
    const hasApprovalPause = occupants.some((occupant) => occupant.status === "awaiting_approval");
    const hasUnresolvedOccupant = occupants.some((occupant) => occupant.status !== "running");
    const recovery = hasApprovalPause
      ? "Resolve and resume the approval-paused task before starting another task."
      : hasUnresolvedOccupant
        ? "Resume or explicitly override the interrupted task before reusing the shared checkout."
        : "Wait for running tasks to finish, or restart the monitor to retry worktree creation.";
    super(
      `Worktree isolation is degraded (creation failed). Cannot dispatch ${taskId} while the shared directory is occupied by ${occupantSummary}. ${recovery}`,
    );
    this.name = "DegradedSharedCheckoutBusyError";
    this.occupants = occupants;
    this.hasApprovalPause = hasApprovalPause;
    this.hasUnresolvedOccupant = hasUnresolvedOccupant;
  }
}

/**
 * A deliberate refusal to change a human-gate decision because the live or
 * durable dispatch lifecycle conflicts with that request. Route handlers map
 * only this typed pre-mutation refusal to HTTP 409; malformed files and I/O
 * failures remain server errors.
 */
export class ApprovalDecisionConflictError extends Error {
  readonly code = "approval_decision_conflict";

  constructor(
    readonly reason: ApprovalDecisionConflictReason,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalDecisionConflictError";
  }
}

interface ApprovalPauseResolution {
  readonly taskId: string;
  readonly gate: ApprovalGate;
  readonly expectedState: DecidedApprovalState;
  /** Exact exited pause to release, absent when the monitor has no live job. */
  readonly job?: DispatchJob;
}

export interface ApprovalPauseDecisionResult<T> {
  decision: T;
  released: boolean;
}

export interface ApprovalPauseDecisionOptions {
  /** Re-plan may repeat an existing rejection to regenerate preflight evidence. */
  allowAlreadyRejected?: boolean;
}

export interface StartOptions {
  skipGate?: boolean;
  skipDepthOnly?: boolean;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  resume?: boolean;
  parentTaskId?: string;
  sharedBranchName?: string;
  /** Judge feedback to inject as retry context (used by force-retry) */
  judgeFeedback?: string;
  /** Reuse existing worktree if present (used by revision dispatch) */
  reuseWorktree?: boolean;
  /** Force clean start: delete existing branch + checkpoint regardless of state */
  forceClean?: boolean;
  /**
   * TASK-1326 (QPI-042): proceed even though this task is paused at a
   * human gate, archiving the paused run's state first. An EXPLICIT
   * operator decision — never inferred from request shape or a header
   * (the TASK-1323 F1 lesson).
   */
  overridePausedRun?: boolean;
  /**
   * TASK-1333: the stale judge record and checkpoint were already moved into
   * a recoverable archive, so an in-memory `awaiting_approval` job may be
   * replaced without setting `resume` (which would reuse the stale worktree).
   * Internal to the judge recycle route.
   */
  replaceArchivedJudgeRun?: boolean;
  /** Federated scheduler job id when a listener starts local work for a leased job. */
  federatedJobId?: string;
  /** Federated worker/listener host id for worker provenance. */
  federatedHostId?: string;
  /** Human label for the worker host, if known. */
  federatedHostAlias?: string;
  /** Base URL or endpoint label for the worker host, if known. */
  federatedHostEndpoint?: string;
  /** Active lease id assigned by the headnode scheduler. */
  federatedLeaseId?: string;
  /** TASK-1323: entry provenance, stamped by the calling surface (HTTP
   *  routes derive it from route + request shape). When a caller fails
   *  to stamp it, `start()` falls back to an api-direct record with the
   *  marker principal `unattributed-local-start` — every current caller
   *  is an HTTP handler or a queue item enqueued by one, so the channel
   *  is honest and the principal flags the imprecision. */
  provenance?: JobProvenance;
  /** Prebuilt async claimant result for the synchronous start seam. */
  duplicateClaimantCheck?: DuplicateClaimantCheck;
  /** Exact task bytes admitted under the decomposition reservation. */
  admittedTaskContentHash?: string;
  /** Exact monitor-owned Docker runtime archive to seed for this resume. */
  dockerResumeStateDir?: string;
}

export type DispatchEventCallback = (
  stage:
    | "container_created"
    | "container_stopped"
    | "container_error"
    | "worktree_failed"
    // QPI-043: how the dispatch child STOPPED (exit code and, crucially,
    // the SIGNAL). Reported through this typed lifecycle callback so it
    // reaches the durable event log; the in-memory job record does not
    // survive a monitor restart, which is exactly how the first attempt
    // at this instrumentation was lost.
    | "dispatch_child_exit"
    // TASK-1313 S5 (round-2 F7): the stale-branch deletion guard fires
    // BEFORE any event session exists, so its refusal reports through
    // this typed lifecycle callback rather than a premature session.
    | "branch_guard_refusal"
    // TASK-1326: an operator overrode a gate pause and the prior run's
    // branch/checkpoint/pend were archived. Durable by the same
    // reasoning as dispatch_child_exit — an archive nobody can find is
    // a deletion with extra steps.
    | "paused_run_archived"
    | "prep_job_completed"
    | "prep_failed",
  taskId: string,
  payload: Record<string, unknown>,
) => void;

export interface ManagedWorktreeRecord {
  taskId: string;
  path: string;
  rootKind: "quack" | "hermes" | "claude";
  exists: boolean;
  registered: boolean;
  branchName?: string;
  owner?: string;
  ownerProvenance: string[];
  allowedPrefix?: string;
  protectedOwner: boolean;
  requiresOwnerOverride: boolean;
  lastModifiedAt?: string;
  ageMs: number;
  jobStatus?: DispatchJob["status"];
  activeJob: boolean;
  dirty: boolean;
  evidenceFiles: string[];
  pruneEligible: boolean;
  skipReasons: string[];
}

export interface ManagedWorktreeCleanupResult {
  checkedAt: string;
  dryRun: boolean;
  maxAgeMs: number;
  policy: ResolvedWorktreeCleanupPolicy;
  scanned: number;
  pruneEligible: number;
  candidates: ManagedWorktreeRecord[];
  pruned: string[];
  retained: ManagedWorktreeRecord[];
}

/** Default max runtime before watchdog kills a stuck dispatch (2 hours) */
const DEFAULT_WATCHDOG_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_BRANCH_RETENTION_DAYS = 1;
const DEFAULT_ALLOWED_BRANCH_PREFIXES = ["quack/TASK-"];
const DEFAULT_PROTECTED_OWNERS = ["contributor"];
const DEFAULT_PROTECTED_PATTERNS = ["contributor/**", "*/contributor/**"];

type ManagedWorktreeRootKind = ManagedWorktreeRecord["rootKind"];

interface ManagedWorktreeRoot {
  kind: ManagedWorktreeRootKind;
  root: string;
}

interface ResolvedWorktreeCleanupPolicy {
  enabled: boolean;
  retentionDays: number;
  allowedPrefixes: string[];
  protectedOwners: string[];
  protectedPatterns: string[];
  requireOwnerOverride: boolean;
}

function pathExistsViaLstat(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown";
  return hash.length > 19 ? `${hash.slice(0, 19)}...` : hash;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(value: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(value));
}

function normalizeOwner(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function allowedPrefixForBranch(
  branch: string | undefined,
  allowedPrefixes: string[],
): string | undefined {
  if (!branch) return undefined;
  return allowedPrefixes.find((prefix) => branch.startsWith(prefix));
}

function isSafeDockerBranchName(value: string): boolean {
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);
  return (
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || forbidden.has(character);
    })
  );
}

export class DispatchManager {
  private jobs = new Map<string, DispatchJob>();
  private observationProjectId?: string;
  private observationStore?: DispatchObservationStore;
  private readonly observationCandidates = new WeakSet<DispatchJob>();
  private readonly persistedObservations = new WeakSet<DispatchJob>();
  private readonly observationChildren = new WeakMap<DispatchJob, ChildProcess>();
  private readonly observationExitHandlers = new WeakMap<DispatchJob, number>();
  private readonly observationStarts = new WeakSet<DispatchJob>();
  private processes = new Map<string, ChildProcess>();
  private nodeLaunches = new Map<string, TrustedNodeLaunch>();
  /** Child handles remain live through `close`, after `exit` has fired. */
  private liveProcesses = new Set<ChildProcess>();
  /** Async exit handlers may outlive both `exit` and `close`. */
  private pendingExitHandlers = new Set<Promise<void>>();
  private idleWaiters = new Set<() => void>();
  /** Blocks same-task admission until a stopped child's recovery pass finishes. */
  private operatorStopCleanupPending = new Map<string, DispatchJob>();
  /** Serializes a durable human-gate decision with release of its exact paused run. */
  private approvalPauseResolutions = new Map<string, ApprovalPauseResolution>();
  /** Deduplicates exit-handler and drain-retry recovery for the same stopped run. */
  private operatorStopRecoveryInFlight = new Map<string, Promise<boolean>>();
  /** Keeps an exited rate-limited run cancellable until replacement admission commits. */
  private rateLimitRetryPending = new Set<string>();
  private dockerManager: DockerManager | null = null;
  /** Startup ownership scan shared by availability checks and first admission. */
  private dockerReconciliationPromise: Promise<void> | null = null;
  /** Reconciliation and create form one admission transaction per manager. */
  private dockerAdmissionTail: Promise<void> = Promise.resolve();
  private dockerRegisteredProjectRoots: readonly string[] = [];
  private onEvent?: DispatchEventCallback;
  private keyManager?: KeyManager;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private terminalDrainStarted = false;
  private stopEscalationTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; processGroupId?: number }
  >();
  /**
   * POSIX groups that survived the bounded TERM/KILL sequence. Their numeric
   * IDs are evidence only: after the child handle is gone the ID can be
   * recycled, so these entries block admission but are never signalled again.
   */
  private unconfirmedProcessGroups = new Map<string, number>();
  /** Windows taskkill /T completions are the tree-level exit evidence. */
  private confirmedWindowsTreeKills = new Map<string, string>();
  /** Unreadable survivor records are a global recovery barrier. */
  private unreadableWorktreeSurvivorMarkers = new Set<string>();
  /** Never retry a Windows numeric PID after one tree-kill attempt. */
  private attemptedWindowsTreeKills = new WeakSet<ChildProcess>();
  /** Docker creation is asynchronous and must participate in shutdown. */
  private pendingDockerStarts = new Map<string, Promise<void>>();
  /** Worktree leases acquired before setup but not yet transferred to a child. */
  private pendingWorktreeOwnerships = new Map<string, WorktreeShutdownSurvivor>();
  /** Once shutdown begins this manager must never spawn or retry another child. */
  private shutdownInProgress = false;
  /** Set to true when worktree creation fails — blocks parallel dispatch */
  private worktreeDegraded = false;

  /** Bind only the canonical project resolved by server/registry initialization. */
  setObservationProjectId(projectId: string): void {
    if (
      !projectId ||
      projectId.length > 512 ||
      (this.observationProjectId && this.observationProjectId !== projectId)
    ) {
      throw new Error("Dispatch observation project identity cannot change");
    }
    this.observationProjectId = projectId;
    this.observationStore ??= new DispatchObservationStore(this.projectRoot, projectId);
  }

  private recordTerminalObservation(job: DispatchJob): void {
    if (
      !this.observationCandidates.has(job) ||
      this.persistedObservations.has(job) ||
      !["completed", "failed", "stopped"].includes(job.status) ||
      this.observationChildren.has(job) ||
      this.observationStarts.has(job) ||
      (this.observationExitHandlers.get(job) ?? 0) > 0 ||
      job.operatorStopCleanupPending === true ||
      this.operatorStopCleanupPending.get(job.taskId) === job
    )
      return;
    // The observation clock is completion, never task start or cleanup time.
    job.completedAt ??= new Date(Math.max(Date.now(), Date.parse(job.startedAt))).toISOString();
    const identity = this.observationProjectId
      ? dispatchObservationIdentity(this.observationProjectId, job)
      : undefined;
    if (!identity || !this.observationStore) return;
    try {
      this.observationStore.write(identity, job, job.completedAt, job.replacementSessionId);
      this.persistedObservations.add(job);
      delete job.observationPersistenceError;
    } catch (error) {
      job.observationPersistenceError = sanitizeClaudeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 2048);
    }
  }

  private recordAuthRetryReplacement(previous: DispatchJob, replacement: DispatchJob): void {
    if (!this.observationProjectId) return;
    const oldIdentity = dispatchObservationIdentity(this.observationProjectId, previous);
    const newIdentity = dispatchObservationIdentity(this.observationProjectId, replacement);
    if (
      oldIdentity &&
      newIdentity &&
      previous.sessionId !== replacement.sessionId &&
      sameDispatchObservationIdentity(
        { ...oldIdentity, sessionId: newIdentity.sessionId },
        newIdentity,
      )
    ) {
      previous.replacementSessionId = replacement.sessionId;
    }
  }

  private trackExitHandler(handler: Promise<void>, job: DispatchJob): void {
    this.pendingExitHandlers.add(handler);
    this.observationExitHandlers.set(job, (this.observationExitHandlers.get(job) ?? 0) + 1);
    void handler.finally(() => {
      this.pendingExitHandlers.delete(handler);
      this.observationExitHandlers.set(job, (this.observationExitHandlers.get(job) ?? 1) - 1);
      this.recordTerminalObservation(job);
      this.notifyIdleWaiters();
    });
  }

  private trackChildClose(child: ChildProcess, job: DispatchJob): void {
    this.liveProcesses.add(child);
    this.observationCandidates.add(job);
    this.observationChildren.set(job, child);
    child.once("close", () => {
      this.liveProcesses.delete(child);
      this.observationChildren.delete(job);
      this.recordTerminalObservation(job);
      this.notifyIdleWaiters();
    });
  }

  private emitEventBestEffort(
    stage: Parameters<DispatchEventCallback>[0],
    taskId: string,
    payload: Record<string, unknown>,
    job?: DispatchJob,
  ): void {
    try {
      this.onEvent?.(stage, taskId, payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      job?.output.push(`[events] ${stage} observer failed: ${detail}`);
    }
  }

  private notifyIdleWaiters(): void {
    if (this.hasLiveProcesses()) return;
    for (const waiter of [...this.idleWaiters]) waiter();
  }

  /** Where the durable event jsonl files live (QPI-043 exit facts). */
  private readonly logDir: string;
  /** Trusted adapter identity used to reject container-chosen event projects. */
  private readonly projectName: string;
  /** Trusted task branch prefix used to pre-admit a private Docker ref. */
  private readonly branchPrefix: string;

  constructor(
    private readonly projectRoot: string,
    private readonly quackBin: string,
    private readonly isolationConfig?: IsolationConfig,
    keyManager?: KeyManager,
    logDir?: string,
    private readonly claimantResolver?: (taskId: string) => Promise<DuplicateClaimantCheck>,
    /**
     * Operator-owned authorization for exact local bare repositories that
     * may be used as read-only Git transports. This value must come from the
     * runtime adapter object, never from repository-controlled adapter.json.
     */
    private readonly trustedLocalReadRemotePaths?: readonly string[],
    private readonly decompositionAdmissionFence?: (
      taskId: string,
      operation: (admission: DecompositionDispatchAdmission) => DispatchJob,
    ) => Promise<DispatchJob>,
  ) {
    this.logDir = logDir ?? path.join(projectRoot, ".quack", "logs");
    this.projectName = path.basename(path.resolve(projectRoot));
    this.branchPrefix = "quack/";
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".quack", "adapter.json"), "utf-8"),
      ) as unknown;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (parsed.success) {
        this.projectName = parsed.data.project.name;
        this.branchPrefix = parsed.data.git.branchPrefix;
      }
    } catch {
      // A missing/invalid adapter will be rejected by the child loader. The
      // basename remains a deterministic host-known identity for diagnostics.
    }
    if (isolationConfig?.method === "docker" && isolationConfig.docker) {
      this.dockerManager = new DockerManager(
        projectRoot,
        isolationConfig.docker,
        path.join(this.logDir, "docker-create-uncertainty"),
        {
          logDir: this.logDir,
          runtimeRoot: path.resolve(path.dirname(this.quackBin), ".."),
        },
      );
    }
    this.keyManager = keyManager;
  }

  private async restartWithFreshDecompositionAdmission(
    taskId: string,
    operation: (admission: DecompositionDispatchAdmission) => DispatchJob,
  ): Promise<DispatchJob> {
    if (this.decompositionAdmissionFence) {
      return this.decompositionAdmissionFence(taskId, operation);
    }
    const adapter = await loadAdapter(this.projectRoot);
    return withDecompositionAdmissionFence(adapter, taskId, operation);
  }

  private sharedCheckoutPausePath(): string {
    return path.join(this.logDir, "shared-checkout-pause.json");
  }

  private sharedCheckoutMutationLockPath(): string {
    return path.join(this.logDir, "shared-checkout-pause.lock");
  }

  /**
   * Serialize shared-checkout marker mutations across monitor processes. A
   * pre-existing lock is never expired by age: after a crash its provenance
   * cannot be proved, so shared-checkout admission must remain fail-closed
   * until an operator inspects and removes it.
   */
  private withSharedCheckoutMutationLock<T>(operation: () => T): T {
    const lockPath = this.sharedCheckoutMutationLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf-8", flag: "wx" },
      );
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "EEXIST") {
        throw new Error(
          "Shared-checkout ownership is locked by another monitor or an unverified stale lock; " +
            "inspect the checkout before removing shared-checkout-pause.lock.",
        );
      }
      throw error;
    }

    try {
      return operation();
    } finally {
      try {
        fs.rmSync(lockPath);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `[dispatch] Could not release shared-checkout ownership lock (${detail}); admission remains blocked.`,
        );
      }
    }
  }

  private worktreeSurvivorPath(taskId: string): string {
    const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.logDir, "worktree-survivors", `${safeTaskId}.json`);
  }

  private withWorktreeMarkerLock<T>(taskId: string, operation: () => T): T {
    const markerPath = this.worktreeSurvivorPath(taskId);
    const lockPath = `${markerPath}.lock`;
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf-8", flag: "wx" },
      );
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "EEXIST") {
        throw new Error(
          `Worktree ownership for ${taskId} is locked by another monitor or an unverified stale lock`,
        );
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      try {
        fs.rmSync(lockPath);
      } catch {
        // A retained lock is deliberately admission-blocking.
      }
    }
  }

  private acquireWorktreeOwnership(
    taskId: string,
    sessionId: string,
    worktreePath: string,
  ): WorktreeShutdownSurvivor {
    return this.withWorktreeMarkerLock(taskId, () => {
      const markerPath = this.worktreeSurvivorPath(taskId);
      if (fs.existsSync(markerPath)) {
        throw new Error(
          `Cannot mutate ${worktreePath}: prior worktree ownership has not been reconciled.`,
        );
      }
      const marker: WorktreeShutdownSurvivor = {
        version: 2,
        taskId,
        sessionId,
        ownershipId: randomUUID(),
        worktreePath,
        strategy: process.platform === "win32" ? "windows-process-tree" : "posix-process-group",
        state: "acquired",
        recordedAt: new Date().toISOString(),
        reconciliationToken: randomUUID(),
      };
      fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
      return marker;
    });
  }

  private updateWorktreeOwnership(
    job: DispatchJob,
    state: "running" | "stopping" | "survivor",
    processId = job.pid,
  ): boolean {
    if (!job.worktreePath || !job.worktreeOwnershipId) return false;
    try {
      return this.withWorktreeMarkerLock(job.taskId, () => {
        const markerPath = this.worktreeSurvivorPath(job.taskId);
        const marker = this.parseWorktreeSurvivor(markerPath);
        if (
          !marker ||
          marker.taskId !== job.taskId ||
          marker.sessionId !== job.sessionId ||
          marker.ownershipId !== job.worktreeOwnershipId ||
          marker.worktreePath !== job.worktreePath
        ) {
          return false;
        }
        const updated: WorktreeShutdownSurvivor = {
          ...marker,
          version: 2,
          strategy: job.containerId
            ? "docker-container"
            : process.platform === "win32"
              ? "windows-process-tree"
              : "posix-process-group",
          state,
          ...(processId > 0 ? { processId } : {}),
          recordedAt: new Date().toISOString(),
        };
        const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
        fs.renameSync(temporaryPath, markerPath);
        return true;
      });
    } catch {
      return false;
    }
  }

  private hasExactWorktreeOwnership(job: DispatchJob): boolean {
    if (!job.worktreePath || !job.worktreeOwnershipId) return false;
    try {
      return this.withWorktreeMarkerLock(job.taskId, () => {
        const marker = this.parseWorktreeSurvivor(this.worktreeSurvivorPath(job.taskId));
        return Boolean(
          marker &&
          marker.taskId === job.taskId &&
          marker.sessionId === job.sessionId &&
          marker.ownershipId === job.worktreeOwnershipId &&
          marker.worktreePath === job.worktreePath &&
          marker.strategy === "docker-container" &&
          marker.state === "stopping",
        );
      });
    } catch {
      return false;
    }
  }

  private parseWorktreeSurvivor(markerPath: string): WorktreeShutdownSurvivor | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        ![1, 2].includes(Number((parsed as { version?: unknown }).version)) ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        typeof (parsed as { sessionId?: unknown }).sessionId !== "string" ||
        ((parsed as { ownershipId?: unknown }).ownershipId !== undefined &&
          (typeof (parsed as { ownershipId?: unknown }).ownershipId !== "string" ||
            !(parsed as { ownershipId: string }).ownershipId)) ||
        typeof (parsed as { worktreePath?: unknown }).worktreePath !== "string" ||
        ((parsed as { processId?: unknown }).processId !== undefined &&
          (!Number.isSafeInteger((parsed as { processId?: unknown }).processId) ||
            Number((parsed as { processId?: unknown }).processId) <= 0)) ||
        !["posix-process-group", "windows-process-tree", "docker-container"].includes(
          String((parsed as { strategy?: unknown }).strategy),
        ) ||
        typeof (parsed as { recordedAt?: unknown }).recordedAt !== "string" ||
        ((parsed as { state?: unknown }).state !== undefined &&
          !["acquired", "running", "stopping", "survivor"].includes(
            String((parsed as { state?: unknown }).state),
          )) ||
        ((parsed as { reconciliationToken?: unknown }).reconciliationToken !== undefined &&
          (typeof (parsed as { reconciliationToken?: unknown }).reconciliationToken !== "string" ||
            !(parsed as { reconciliationToken: string }).reconciliationToken))
      ) {
        return undefined;
      }
      return parsed as WorktreeShutdownSurvivor;
    } catch {
      return undefined;
    }
  }

  /** Add UUID/token identity to legacy markers without ever clearing them. */
  private migrateLegacyWorktreeSurvivor(
    markerPath: string,
    marker: WorktreeShutdownSurvivor,
  ): WorktreeShutdownSurvivor | undefined {
    if (marker.version === 2 && marker.ownershipId && marker.reconciliationToken) return marker;
    const lockPath = `${markerPath}.lock`;
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf-8", flag: "wx" },
      );
    } catch {
      // Migration is best-effort, but the legacy marker is still durable
      // survivor evidence. Keep exposing it while another reconciler holds
      // the lock instead of making the preserved worktree appear safe.
      return marker;
    }
    try {
      const current = this.parseWorktreeSurvivor(markerPath);
      if (!current) return undefined;
      if (current.version === 2 && current.ownershipId && current.reconciliationToken) {
        return current;
      }
      const migrated: WorktreeShutdownSurvivor = {
        ...current,
        version: 2,
        ownershipId: current.ownershipId ?? randomUUID(),
        reconciliationToken: current.reconciliationToken ?? randomUUID(),
        state: current.state ?? "survivor",
      };
      fs.writeFileSync(markerPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf-8");
      return migrated;
    } catch {
      return undefined;
    } finally {
      try {
        fs.rmSync(lockPath);
      } catch {
        // A retained lock is deliberately admission-blocking.
      }
    }
  }

  private readWorktreeShutdownSurvivors(): WorktreeShutdownSurvivor[] {
    const directory = path.join(this.logDir, "worktree-survivors");
    const survivors: WorktreeShutdownSurvivor[] = [];
    const unreadable = new Set<string>();
    if (fs.existsSync(directory)) {
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json.lock")) {
            unreadable.add(entry.name);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const markerPath = path.join(directory, entry.name);
          const parsed = this.parseWorktreeSurvivor(markerPath);
          if (!parsed || this.worktreeSurvivorPath(parsed.taskId) !== markerPath) {
            unreadable.add(entry.name);
            continue;
          }
          const marker = this.migrateLegacyWorktreeSurvivor(markerPath, parsed);
          if (!marker) {
            unreadable.add(entry.name);
            continue;
          }
          survivors.push(marker);
        }
      } catch {
        unreadable.add("unreadable-survivor-directory");
      }
    }
    this.unreadableWorktreeSurvivorMarkers = unreadable;
    return survivors;
  }

  private persistWorktreeSurvivor(job: DispatchJob, processId: number): void {
    if (!job.worktreePath || job.containerId) return;
    if (!this.updateWorktreeOwnership(job, "survivor", processId)) {
      throw new Error("worktree ownership changed before survivor evidence could be recorded");
    }
  }

  private clearWorktreeSurvivor(job: DispatchJob, treeAbsenceConfirmed = false): boolean {
    if (!job.worktreePath || !job.worktreeOwnershipId) return true;
    try {
      return this.withWorktreeMarkerLock(job.taskId, () => {
        const markerPath = this.worktreeSurvivorPath(job.taskId);
        // A prior recovery attempt may have removed the exact ownership
        // marker before a later, independent cleanup step failed. Once tree
        // absence has been proven, an already-absent marker is an idempotent
        // success rather than a reason to strand the task forever.
        if (treeAbsenceConfirmed && !fs.existsSync(markerPath)) return true;
        const marker = this.parseWorktreeSurvivor(markerPath);
        if (
          !marker ||
          marker.taskId !== job.taskId ||
          marker.sessionId !== job.sessionId ||
          marker.ownershipId !== job.worktreeOwnershipId ||
          marker.worktreePath !== job.worktreePath
        ) {
          return false;
        }
        if (!treeAbsenceConfirmed) {
          if (this.unconfirmedProcessGroups.has(job.taskId)) return false;
          if (!marker.processId) return false;
          if (marker.strategy === "windows-process-tree") {
            if (!this.hasConfirmedWindowsTreeKill(job)) return false;
          } else if (this.processGroupExists(marker.processId)) {
            return false;
          }
        }
        fs.rmSync(markerPath);
        return !fs.existsSync(markerPath);
      });
    } catch {
      return false;
    }
  }

  private assertWorktreeHasNoLiveSurvivor(
    taskId: string,
    worktreePath: string,
    ownershipId?: string,
  ): void {
    const markerPath = this.worktreeSurvivorPath(taskId);
    if (!fs.existsSync(markerPath)) return;
    const parsed = this.parseWorktreeSurvivor(markerPath);
    const marker = parsed ? this.migrateLegacyWorktreeSurvivor(markerPath, parsed) : undefined;
    if (!marker || marker.taskId !== taskId || marker.worktreePath !== worktreePath) {
      throw new Error(
        `Cannot replace ${worktreePath}: shutdown survivor evidence is unreadable or locked.`,
      );
    }

    if (ownershipId && marker.ownershipId === ownershipId) return;

    const mayBeLive =
      marker.strategy === "posix-process-group"
        ? process.platform === "win32" ||
          !marker.processId ||
          this.processGroupExists(marker.processId)
        : true;
    if (mayBeLive) {
      throw new Error(
        `Cannot replace ${worktreePath}: prior process tree ${marker.processId ?? "unknown"} has not been confirmed stopped.`,
      );
    }
    throw new Error(
      `Cannot replace ${worktreePath}: prior ownership must be cleared with its reconciliation token.`,
    );
  }

  /**
   * Reconstruct markers written before this release (and close the small crash
   * window between the durable child-exit event and marker creation). A pending
   * approval counts only when a later dispatch_child_exit event proves that run
   * used projectRoot rather than an isolated worktree.
   */
  private inferSharedCheckoutPause(): DurableSharedCheckoutPause | undefined {
    const approvalDir = path.join(this.logDir, "approvals");
    if (!fs.existsSync(approvalDir) || !fs.existsSync(this.logDir)) return undefined;

    const taskIds = new Set<string>();
    try {
      for (const entry of fs.readdirSync(approvalDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const base = entry.name.slice(0, -".json".length);
        const taskId = base.endsWith("-judge") ? base.slice(0, -"-judge".length) : base;
        if (/^[A-Za-z0-9._-]+$/.test(taskId)) taskIds.add(taskId);
      }
    } catch {
      return undefined;
    }

    const candidates = new Map<string, { pausedAt: string; eventAt: string; sessionId: string }>();
    for (const taskId of taskIds) {
      const paused = resolvePausedRunState(this.logDir, taskId);
      if (!paused) continue;
      candidates.set(taskId, {
        pausedAt: paused.createdAt,
        eventAt: "",
        sessionId: paused.sessionId ?? "recovered",
      });
    }
    if (candidates.size === 0) return undefined;

    let eventFiles: fs.Dirent[];
    try {
      eventFiles = fs
        .readdirSync(this.logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^events-.+\.jsonl$/.test(entry.name));
    } catch {
      return undefined;
    }

    for (const entry of eventFiles) {
      const sessionId = entry.name.slice("events-".length, -".jsonl".length);
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(this.logDir, entry.name), "utf-8").split("\n");
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            stage?: unknown;
            timestamp?: unknown;
            payload?: {
              taskId?: unknown;
              worktreePath?: unknown;
              isolation?: unknown;
              killed?: unknown;
              at?: unknown;
            };
          };
          const isolation = event.payload?.isolation;
          // New events carry an explicit discriminator. Legacy null-worktree
          // evidence is ambiguous between Docker and shared fallback, so fail
          // closed and preserve it as possible shared-checkout ownership.
          const usedSharedCheckout =
            isolation === "shared-checkout" ||
            (isolation === undefined && event.payload?.worktreePath === null);
          if (
            event.stage !== "dispatch_child_exit" ||
            typeof event.payload?.taskId !== "string" ||
            !usedSharedCheckout ||
            event.payload.killed === true
          ) {
            continue;
          }
          const candidate = candidates.get(event.payload.taskId);
          if (!candidate) continue;
          const eventAt =
            typeof event.payload.at === "string"
              ? event.payload.at
              : typeof event.timestamp === "string"
                ? event.timestamp
                : "";
          const pausedMs = new Date(candidate.pausedAt).getTime();
          const eventMs = new Date(eventAt).getTime();
          if (
            !eventAt ||
            (!Number.isNaN(pausedMs) && (Number.isNaN(eventMs) || eventMs < pausedMs)) ||
            (candidate.eventAt && candidate.eventAt >= eventAt)
          ) {
            continue;
          }
          candidate.eventAt = eventAt;
          candidate.sessionId = sessionId;
        } catch {
          // Ignore malformed historical event lines.
        }
      }
    }

    const recovered = [...candidates.entries()]
      .filter(([, candidate]) => candidate.eventAt)
      .sort(([, left], [, right]) => right.eventAt.localeCompare(left.eventAt))[0];
    if (!recovered) return undefined;
    const [taskId, evidence] = recovered;
    return {
      version: SHARED_CHECKOUT_PAUSE_VERSION,
      taskId,
      sessionId: evidence.sessionId,
      ownershipId: randomUUID(),
      startedAt: evidence.pausedAt,
      pausedAt: evidence.eventAt,
      status: "awaiting_approval",
      ...(process.platform === "win32"
        ? { processTreeStatus: "unconfirmed" as const, reconciliationToken: randomUUID() }
        : {}),
    };
  }

  /**
   * Read the durable owner of an approval-paused shared checkout. An invalid
   * marker fails closed: a restart must never interpret unreadable ownership
   * evidence as permission to reuse the checkout.
   */
  private readSharedCheckoutPause(
    ignoreMutationLock = false,
  ): DurableSharedCheckoutPause | undefined {
    const markerPath = this.sharedCheckoutPausePath();
    if (!ignoreMutationLock && fs.existsSync(this.sharedCheckoutMutationLockPath())) {
      return {
        version: SHARED_CHECKOUT_PAUSE_VERSION,
        taskId: "unknown-shared-checkout-owner",
        sessionId: "unknown",
        startedAt: "unknown",
        pausedAt: "unknown",
        status: "stopped",
      };
    }
    if (!fs.existsSync(markerPath)) {
      const recovered = this.inferSharedCheckoutPause();
      if (!recovered) return undefined;
      try {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, `${JSON.stringify(recovered, null, 2)}\n`, {
          encoding: "utf-8",
          flag: "wx",
        });
      } catch {
        // Never return our losing generation after a concurrent create. Read
        // the durable winner so every caller observes the same ownership ID.
        return (
          this.readSharedCheckoutPause(true) ?? {
            version: SHARED_CHECKOUT_PAUSE_VERSION,
            taskId: "unknown-shared-checkout-owner",
            sessionId: "unknown",
            startedAt: "unknown",
            pausedAt: "unknown",
          }
        );
      }
      return recovered;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== SHARED_CHECKOUT_PAUSE_VERSION ||
        typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
        typeof (parsed as { sessionId?: unknown }).sessionId !== "string" ||
        typeof (parsed as { startedAt?: unknown }).startedAt !== "string" ||
        typeof (parsed as { pausedAt?: unknown }).pausedAt !== "string" ||
        ((parsed as { status?: unknown }).status !== undefined &&
          !["running", "awaiting_approval", "stopped", "failed"].includes(
            String((parsed as { status?: unknown }).status),
          )) ||
        ((parsed as { processId?: unknown }).processId !== undefined &&
          (!Number.isSafeInteger((parsed as { processId?: unknown }).processId) ||
            Number((parsed as { processId?: unknown }).processId) <= 0)) ||
        ((parsed as { processTreeStatus?: unknown }).processTreeStatus !== undefined &&
          !["unconfirmed", "confirmed-stopped"].includes(
            String((parsed as { processTreeStatus?: unknown }).processTreeStatus),
          )) ||
        ((parsed as { reconciliationToken?: unknown }).reconciliationToken !== undefined &&
          typeof (parsed as { reconciliationToken?: unknown }).reconciliationToken !== "string") ||
        ((parsed as { originalBranch?: unknown }).originalBranch !== undefined &&
          typeof (parsed as { originalBranch?: unknown }).originalBranch !== "string") ||
        ((parsed as { originalStatus?: unknown }).originalStatus !== undefined &&
          typeof (parsed as { originalStatus?: unknown }).originalStatus !== "string") ||
        ((parsed as { successfulExitAt?: unknown }).successfulExitAt !== undefined &&
          (typeof (parsed as { successfulExitAt?: unknown }).successfulExitAt !== "string" ||
            !Number.isFinite(
              Date.parse(String((parsed as { successfulExitAt?: unknown }).successfulExitAt)),
            )))
      ) {
        throw new Error("invalid marker shape");
      }
      return parsed as DurableSharedCheckoutPause;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[dispatch] Shared-checkout pause marker is unreadable (${detail}); admission remains blocked.`,
      );
      return {
        version: SHARED_CHECKOUT_PAUSE_VERSION,
        taskId: "unknown-shared-checkout-owner",
        sessionId: "unknown",
        startedAt: "unknown",
        pausedAt: "unknown",
      };
    }
  }

  /** Migrate legacy or crash-stuck ownership evidence to a tokened recovery form. */
  private ensureSharedCheckoutRecoveryMetadata(): DurableSharedCheckoutPause | undefined {
    const marker = this.readSharedCheckoutPause();
    const needsTreeRecoveryMetadata =
      marker !== undefined &&
      (marker.processTreeStatus === "unconfirmed" ||
        (marker.processTreeStatus === undefined &&
          (process.platform === "win32" || marker.status === "running")));
    if (
      !marker ||
      (!needsTreeRecoveryMetadata && marker.ownershipId) ||
      (marker.ownershipId &&
        marker.processTreeStatus === "unconfirmed" &&
        marker.reconciliationToken)
    ) {
      return marker;
    }
    try {
      return this.withSharedCheckoutMutationLock(() => {
        const current = this.readSharedCheckoutPause(true);
        if (!current) return undefined;
        const currentNeedsTreeMetadata =
          current.processTreeStatus === "unconfirmed" ||
          (current.processTreeStatus === undefined &&
            (process.platform === "win32" || current.status === "running"));
        if (
          current.ownershipId &&
          (!currentNeedsTreeMetadata ||
            (current.processTreeStatus === "unconfirmed" && current.reconciliationToken))
        ) {
          return current;
        }
        const migrated: DurableSharedCheckoutPause = {
          ...current,
          ownershipId: current.ownershipId ?? randomUUID(),
          ...(currentNeedsTreeMetadata
            ? {
                processTreeStatus: "unconfirmed" as const,
                reconciliationToken: current.reconciliationToken ?? randomUUID(),
              }
            : {}),
        };
        fs.writeFileSync(
          this.sharedCheckoutPausePath(),
          `${JSON.stringify(migrated, null, 2)}\n`,
          "utf-8",
        );
        return migrated;
      });
    } catch {
      // Migration is best-effort, but the pre-migration marker is still
      // durable ownership evidence. Keep exposing it so a contended or
      // unverifiable lock cannot make the shared checkout appear vacant.
      return marker;
    }
  }

  private persistSharedCheckoutPause(
    job: DispatchJob,
    status: "running" | "awaiting_approval" | "stopped" | "failed" = "awaiting_approval",
    allowOwnershipTransfer = false,
    successfulExit = false,
  ): void {
    this.withSharedCheckoutMutationLock(() => {
      const markerPath = this.sharedCheckoutPausePath();
      const existing = this.readSharedCheckoutPause(true);
      if (existing && existing.taskId !== job.taskId) {
        throw new DegradedSharedCheckoutBusyError(job.taskId, [
          {
            taskId: existing.taskId,
            status: existing.status ?? "awaiting_approval",
          },
        ]);
      }
      const exactOwner =
        existing?.ownershipId !== undefined &&
        existing.sessionId === job.sessionId &&
        job.sharedCheckoutOwnershipId === existing.ownershipId;
      if (existing && !exactOwner) {
        if (!allowOwnershipTransfer || this.durableSharedOwnerMayBeLive(existing)) {
          throw new DegradedSharedCheckoutBusyError(job.taskId, [
            {
              taskId: existing.taskId,
              status: existing.status ?? "awaiting_approval",
            },
          ]);
        }
      }

      const ownershipId = exactOwner && existing?.ownershipId ? existing.ownershipId : randomUUID();
      job.sharedCheckoutOwnershipId = ownershipId;

      const record: DurableSharedCheckoutPause = {
        version: SHARED_CHECKOUT_PAUSE_VERSION,
        taskId: job.taskId,
        sessionId: job.sessionId,
        ownershipId,
        startedAt: job.startedAt,
        pausedAt: new Date().toISOString(),
        status,
        ...(successfulExit &&
        exactOwner &&
        status === "stopped" &&
        job.status === "completed" &&
        job.exitCode === 0 &&
        !job.killedBySignal &&
        !job.stopRequestedAt &&
        !job.operatorStopRequestedAt
          ? { successfulExitAt: job.completedAt ?? new Date().toISOString() }
          : {}),
        ...(status === "running" && job.pid > 0 ? { processId: job.pid } : {}),
        ...(process.platform === "win32"
          ? {
              ...(job.pid > 0
                ? { processId: job.pid }
                : exactOwner && existing?.processId
                  ? { processId: existing.processId }
                  : {}),
              processTreeStatus: this.hasConfirmedWindowsTreeKill(job)
                ? ("confirmed-stopped" as const)
                : ("unconfirmed" as const),
              reconciliationToken:
                exactOwner && existing?.reconciliationToken
                  ? existing.reconciliationToken
                  : randomUUID(),
            }
          : exactOwner && existing?.processTreeStatus
            ? {
                processId: existing.processId,
                processTreeStatus: existing.processTreeStatus,
                reconciliationToken: existing.reconciliationToken,
              }
            : {}),
        ...(job.sharedCheckoutOriginalBranch !== undefined
          ? { originalBranch: job.sharedCheckoutOriginalBranch }
          : {}),
        ...(job.sharedCheckoutOriginalStatus !== undefined
          ? { originalStatus: job.sharedCheckoutOriginalStatus }
          : {}),
      };
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      if (!existing) {
        try {
          fs.writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf-8",
            flag: "wx",
          });
        } catch (error: unknown) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "";
          if (code === "EEXIST") {
            const winner = this.readSharedCheckoutPause(true);
            throw new DegradedSharedCheckoutBusyError(job.taskId, [
              {
                taskId: winner?.taskId ?? "unknown-shared-checkout-owner",
                status: winner?.status ?? "stopped",
              },
            ]);
          }
          throw error;
        }
      } else {
        // Updates are permitted only for the owner/session validated above.
        // A truncated write still fails closed because the reader treats an
        // unreadable marker as unknown ownership.
        fs.writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
      }
    });
  }

  private preserveInterruptedSharedCheckout(
    job: DispatchJob,
    status: "running" | "stopped" | "failed",
    successfulExit = false,
  ): void {
    if (job.worktreePath || job.containerId) return;
    try {
      this.persistSharedCheckoutPause(job, status, false, successfulExit);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(
        `[dispatch] Could not persist interrupted shared-checkout ownership (${detail}); ` +
          `this monitor will continue blocking admission while it remains online.`,
      );
    }
  }

  private clearSharedCheckoutPause(job: DispatchJob): void {
    try {
      this.withSharedCheckoutMutationLock(() => {
        const marker = this.readSharedCheckoutPause(true);
        if (
          !marker ||
          marker.taskId !== job.taskId ||
          !job.sharedCheckoutOwnershipId ||
          marker.ownershipId !== job.sharedCheckoutOwnershipId
        ) {
          return;
        }
        fs.rmSync(this.sharedCheckoutPausePath());
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[dispatch] Could not clear the shared-checkout pause marker for ${job.taskId} (${detail}).`,
      );
    }
  }

  /**
   * Restore the checkout and release its durable owner as one serialized
   * mutation. Holding the ownership lock across the synchronous Git restore
   * prevents another monitor from transferring the same-task marker and
   * spawning into projectRoot before the old owner finishes restoration.
   */
  private restoreAndReleaseSharedCheckout(job: DispatchJob): boolean {
    try {
      return this.withSharedCheckoutMutationLock(() => {
        const marker = this.readSharedCheckoutPause(true);
        if (
          !marker ||
          marker.taskId !== job.taskId ||
          !job.sharedCheckoutOwnershipId ||
          marker.ownershipId !== job.sharedCheckoutOwnershipId
        ) {
          job.output.push(
            "[dispatch] Shared-checkout ownership changed before restore; ownership remains blocked.",
          );
          return false;
        }
        if (!this.restoreSharedCheckout(job)) return false;
        fs.rmSync(this.sharedCheckoutPausePath());
        return true;
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(
        `[dispatch] Shared-checkout restore/release could not be serialized (${detail}); ownership remains blocked.`,
      );
      return false;
    }
  }

  private durableSharedOwnerMayBeLive(marker: DurableSharedCheckoutPause): boolean {
    // A still-running marker may belong to an old monitor whose exit callback
    // is restoring the checkout. Root/group absence (or a tree confirmation)
    // cannot authorize an automatic cross-process handoff before that
    // serialized restore releases ownership.
    if (marker.status === "running") return true;
    if (marker.processTreeStatus === "unconfirmed") return true;
    if (marker.processTreeStatus === "confirmed-stopped") return false;
    // Legacy Windows markers never carried tree-level evidence. Root-PID
    // absence is insufficient because taskkill /T is the only proof available
    // here that descendants cannot still mutate the shared checkout.
    if (process.platform === "win32") return true;
    if (!marker.processId) return false;
    return this.processGroupExists(marker.processId);
  }

  /**
   * A successful degraded run releases projectRoot only after the checkout is
   * observably back on the exact branch and dirty-state baseline recorded
   * before the first shared child was spawned. Missing legacy evidence fails
   * closed for Git repositories; a non-Git project needs no branch restore.
   */
  private restoreSharedCheckout(job: DispatchJob): boolean {
    const currentBranch = this.gitOutput(this.projectRoot, ["branch", "--show-current"]);
    const isGitRepository = currentBranch !== undefined;
    if (!isGitRepository) return true;

    const originalBranch = job.sharedCheckoutOriginalBranch;
    const originalStatus = job.sharedCheckoutOriginalStatus;
    if (!originalBranch || originalStatus === undefined) {
      job.output.push(
        "[dispatch] Shared-checkout restore could not be verified because the original Git state is missing; ownership remains blocked.",
      );
      return false;
    }

    try {
      runTrustedGitSync(["checkout", originalBranch], this.projectRoot, {
        timeoutMs: 15_000,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(
        `[dispatch] Shared-checkout branch restore failed (${detail}); ownership remains blocked.`,
      );
      return false;
    }

    const restoredBranch = this.gitOutput(this.projectRoot, ["branch", "--show-current"]);
    const restoredStatus = this.gitOutput(this.projectRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (restoredBranch !== originalBranch || restoredStatus !== originalStatus) {
      job.output.push(
        "[dispatch] Shared-checkout Git state did not match its original baseline after restore; ownership remains blocked.",
      );
      return false;
    }
    return true;
  }

  private assertSharedCheckoutAvailable(taskId: string, allowSameTaskRecovery: boolean): void {
    const occupants = this.getSharedCheckoutOccupants().filter(
      (job) => !(allowSameTaskRecovery && job.taskId === taskId),
    );
    if (occupants.length > 0) {
      throw new DegradedSharedCheckoutBusyError(taskId, occupants);
    }
  }

  private shouldCleanupDockerForWorktree(): boolean {
    return this.isolationConfig?.dockerCleanup !== false;
  }

  private assertValidGitBranchName(branch: string, context: string): void {
    if (!branch || branch !== branch.trim() || branch.startsWith("-")) {
      throw new InvalidDispatchGitReferenceError(`${context} is not a safe Git branch name`);
    }
    try {
      runTrustedGitSync(["check-ref-format", "--branch", branch], this.projectRoot, {
        timeoutMs: 10_000,
        errorContext: `Invalid ${context}`,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InvalidDispatchGitReferenceError(detail);
    }
  }

  private readWorktreeGitConfiguration(taskId: string): {
    baseBranch: string;
    staleBranch: string;
    configuredProtected?: string[];
  } {
    if (!taskId || taskId === "." || taskId === ".." || /[\\/\0]/u.test(taskId)) {
      throw new InvalidDispatchGitReferenceError(
        `Task id ${JSON.stringify(taskId)} is not a safe worktree path segment`,
      );
    }
    let branchPrefix = "quack/";
    let baseBranch = "main";
    let configuredProtected: string[] | undefined;
    const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
    if (fs.existsSync(adapterPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(adapterPath, "utf-8"));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new InvalidDispatchGitReferenceError(
          `Cannot read adapter Git configuration: ${detail}`,
        );
      }
      const git =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { git?: unknown }).git
          : undefined;
      if (git !== undefined && (typeof git !== "object" || git === null || Array.isArray(git))) {
        throw new InvalidDispatchGitReferenceError("Adapter git configuration must be an object");
      }
      const values = git as
        | { baseBranch?: unknown; branchPrefix?: unknown; protectedBranches?: unknown }
        | undefined;
      if (values?.baseBranch !== undefined) {
        if (typeof values.baseBranch !== "string") {
          throw new InvalidDispatchGitReferenceError("Adapter git.baseBranch must be a string");
        }
        baseBranch = values.baseBranch;
      }
      if (values?.branchPrefix !== undefined) {
        if (typeof values.branchPrefix !== "string") {
          throw new InvalidDispatchGitReferenceError("Adapter git.branchPrefix must be a string");
        }
        branchPrefix = values.branchPrefix;
      }
      if (values?.protectedBranches !== undefined) {
        if (
          !Array.isArray(values.protectedBranches) ||
          values.protectedBranches.some((value) => typeof value !== "string")
        ) {
          throw new InvalidDispatchGitReferenceError(
            "Adapter git.protectedBranches must contain only strings",
          );
        }
        configuredProtected = values.protectedBranches as string[];
      }
    }

    const staleBranch = `${branchPrefix}${taskId}`;
    this.assertValidGitBranchName(baseBranch, "adapter git.baseBranch");
    this.assertValidGitBranchName(staleBranch, "task branch");
    for (const protectedBranch of configuredProtected ?? []) {
      this.assertValidGitBranchName(protectedBranch, "adapter git.protectedBranches entry");
    }
    const protectedSet = [
      ...new Set([...(configuredProtected ?? DEFAULT_PROTECTED_BRANCHES), baseBranch]),
    ];
    const collision = assertBranchDeletionAllowed(staleBranch, protectedSet);
    if (!collision.allowed) {
      const reason =
        `Task branch ${staleBranch} collides with a protected/base branch; ` +
        "refusing dispatch before worktree or branch mutation";
      this.onEvent?.("branch_guard_refusal", taskId, {
        branch: staleBranch,
        reason: collision.reason ?? reason,
        site: "task_branch_admission",
      });
      throw new InvalidDispatchGitReferenceError(reason);
    }
    return { baseBranch, staleBranch, configuredProtected };
  }

  /**
   * Worktree init defaults to auto-discovery when omitted. An explicit empty
   * array is the only opt-out. If the adapter exists but cannot be read or its
   * value is malformed, fail closed and assume initialization would run.
   */
  private worktreeInitializationActive(): boolean {
    const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
    if (!fs.existsSync(adapterPath)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as {
        dispatch?: { worktreeInit?: unknown };
      };
      const configured = raw.dispatch?.worktreeInit;
      return !Array.isArray(configured) || configured.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Legacy dependency junctions are incompatible with initialization-owned or
   * guard-protected node_modules trees. In those modes the worktree must own a
   * real dependency directory instead of sharing the mutable parent copy.
   */
  private sharedFrontendDependenciesAllowed(): boolean {
    if (this.worktreeInitializationActive()) return false;
    const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
    if (!fs.existsSync(adapterPath)) return true;
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as {
        sandbox?: { deniedPaths?: unknown; disposablePaths?: unknown };
      };
      if (
        raw.sandbox &&
        ((raw.sandbox.deniedPaths !== undefined && !Array.isArray(raw.sandbox.deniedPaths)) ||
          (raw.sandbox.disposablePaths !== undefined &&
            !Array.isArray(raw.sandbox.disposablePaths)))
      ) {
        return false;
      }
      const policyPaths: string[] = [];
      for (const configuredPaths of [raw.sandbox?.deniedPaths, raw.sandbox?.disposablePaths]) {
        if (!Array.isArray(configuredPaths)) continue;
        for (const value of configuredPaths) {
          if (typeof value !== "string") return false;
          policyPaths.push(value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""));
        }
      }
      const dependencyRoots = ["frontend/node_modules", "frontends/_app_/node_modules"];
      return !policyPaths.some((value) => {
        const staticPrefix = value.split("*", 1)[0]?.replace(/\/+$/, "") ?? "";
        // A leading wildcard may cover either legacy or multi-frontend roots;
        // fail closed rather than manufacture an external-write alias.
        if (!staticPrefix) return value.includes("*");
        if (/^frontends\/[^/]+\/node_modules(?:\/|$)/u.test(staticPrefix)) return true;
        return dependencyRoots.some(
          (root) =>
            root === staticPrefix ||
            root.startsWith(`${staticPrefix}/`) ||
            staticPrefix.startsWith(`${root}/`),
        );
      });
    } catch {
      return false;
    }
  }

  private cleanupDockerForWorktree(worktreePath: string): boolean {
    if (!this.shouldCleanupDockerForWorktree()) return false;
    return cleanupWorktreeContainers(worktreePath, {
      info: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
    });
  }

  private operatorStopBarrierDirectory(): string {
    return path.join(this.projectRoot, ".quack", "operator-stop-barriers");
  }

  private operatorStopFallbackBarrierDirectory(): string {
    const canonicalProjectRoot = canonicalizePotentialPathSync(this.projectRoot);
    const projectHash = createHash("sha256")
      .update(normalizeExecutionRoot(canonicalProjectRoot))
      .digest("hex")
      .slice(0, 16);
    const safeProjectName = path.basename(canonicalProjectRoot).replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(
      path.dirname(canonicalProjectRoot),
      `.quack-operator-stop-barriers-${safeProjectName}-${projectHash}`,
    );
  }

  private operatorStopBarrierDirectories(): string[] {
    return [
      this.operatorStopBarrierDirectory(),
      this.operatorStopFallbackBarrierDirectory(),
    ].filter(
      (directory, index, all) =>
        all.findIndex((candidate) => pathsEqualForDispatch(candidate, directory)) === index,
    );
  }

  private operatorStopBarrierPath(
    directory: string,
    taskId: string,
    executionRoot: string,
  ): string {
    const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const rootHash = createHash("sha256")
      .update(normalizeExecutionRoot(executionRoot))
      .digest("hex")
      .slice(0, 16);
    return path.join(directory, `${safeTaskId}-${rootHash}.json`);
  }

  private prepareOperatorStopBarrierDirectory(directory: string): void {
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`barrier directory is not a real directory: ${directory}`);
      }
    } else {
      fs.mkdirSync(directory, { recursive: true });
    }

    const canonicalDirectory = fs.realpathSync(directory);
    const canonicalProjectRoot = canonicalizePotentialPathSync(this.projectRoot);
    const primaryRoot = path.join(canonicalProjectRoot, ".quack");
    const fallbackParent = path.dirname(canonicalProjectRoot);
    const validLocation =
      pathsEqualForDispatch(path.dirname(canonicalDirectory), primaryRoot) ||
      pathsEqualForDispatch(path.dirname(canonicalDirectory), fallbackParent);
    if (!validLocation) {
      throw new Error(`barrier directory resolves outside its approved parent: ${directory}`);
    }
  }

  private persistOperatorStopBarrier(job: DispatchJob): boolean {
    const requestedRoot = job.executionRoot ?? this.projectRoot;
    const failures: string[] = [];
    try {
      const executionRoot = canonicalizePotentialPathSync(requestedRoot);
      const sharedExecutionRoot = pathsEqualForDispatch(
        executionRoot,
        canonicalizePotentialPathSync(this.projectRoot),
      );
      // A shared-root worker can modify projectRoot/.quack, so a marker there
      // is not durable against the very process it is meant to fence. For
      // shared execution the sibling store is authoritative, not a fallback.
      const directories = sharedExecutionRoot
        ? [this.operatorStopFallbackBarrierDirectory()]
        : this.operatorStopBarrierDirectories();
      for (const [index, directory] of directories.entries()) {
        try {
          this.prepareOperatorStopBarrierDirectory(directory);
          const markerPath = this.operatorStopBarrierPath(directory, job.taskId, executionRoot);
          if (fs.existsSync(markerPath)) {
            const existing = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
            if (
              typeof existing !== "object" ||
              existing === null ||
              (existing as { version?: unknown }).version !== OPERATOR_STOP_BARRIER_VERSION ||
              typeof (existing as { token?: unknown }).token !== "string" ||
              (existing as { taskId?: unknown }).taskId !== job.taskId ||
              typeof (existing as { executionRoot?: unknown }).executionRoot !== "string" ||
              !pathsEqualForDispatch(
                canonicalizePotentialPathSync(
                  (existing as { executionRoot: string }).executionRoot,
                ),
                executionRoot,
              ) ||
              (existing as { pid?: unknown }).pid !== job.pid ||
              (existing as { createdAt?: unknown }).createdAt !== job.operatorStopRequestedAt
            ) {
              throw new Error(
                `existing barrier is invalid or belongs to another run: ${markerPath}`,
              );
            }
            job.operatorStopBarrierPath = markerPath;
            job.operatorStopBarrierToken = (existing as { token: string }).token;
            return true;
          }
          const token = randomUUID();
          const record: OperatorStopBarrierRecord = {
            version: OPERATOR_STOP_BARRIER_VERSION,
            token,
            taskId: job.taskId,
            executionRoot,
            pid: job.pid,
            createdAt: job.operatorStopRequestedAt ?? new Date().toISOString(),
          };
          // Exclusive creation matters more than rename atomicity here. A partial
          // record is deliberately fail-closed on restart, while rename() could
          // replace another monitor's valid barrier on POSIX.
          fs.writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
          });
          job.operatorStopBarrierPath = markerPath;
          job.operatorStopBarrierToken = token;
          if (sharedExecutionRoot) {
            job.output.push(
              `[dispatch] Shared-root stop barrier stored outside the worker-writable project at ${markerPath}.`,
            );
          } else if (index > 0) {
            job.output.push(
              `[dispatch] Primary stop-barrier storage was unavailable; using durable fallback ${markerPath}.`,
            );
          }
          return true;
        } catch (error: unknown) {
          failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    job.output.push(
      `[dispatch] Stop refused because no durable operator-stop recovery barrier could be written ` +
        `(${failures.join("; ")}).`,
    );
    return false;
  }

  private clearOperatorStopBarrier(job: DispatchJob): boolean {
    if (!job.operatorStopBarrierPath || !job.operatorStopBarrierToken) return true;
    try {
      const parsed = JSON.parse(fs.readFileSync(job.operatorStopBarrierPath, "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== OPERATOR_STOP_BARRIER_VERSION ||
        (parsed as { token?: unknown }).token !== job.operatorStopBarrierToken ||
        (parsed as { taskId?: unknown }).taskId !== job.taskId ||
        typeof (parsed as { executionRoot?: unknown }).executionRoot !== "string" ||
        !pathsEqualForDispatch(
          canonicalizePotentialPathSync((parsed as { executionRoot: string }).executionRoot),
          canonicalizePotentialPathSync(job.executionRoot ?? this.projectRoot),
        ) ||
        (parsed as { pid?: unknown }).pid !== job.pid
      ) {
        throw new Error("barrier ownership or run identity changed");
      }
      fs.rmSync(job.operatorStopBarrierPath);
      try {
        fs.rmdirSync(path.dirname(job.operatorStopBarrierPath));
      } catch {
        // A non-empty shared barrier directory is expected when other stopped
        // runs still need recovery. Failure to remove the empty shell is safe.
      }
      job.operatorStopBarrierPath = undefined;
      job.operatorStopBarrierToken = undefined;
      return true;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(
        `[dispatch] Operator-stop barrier could not be cleared (${detail}); restart remains blocked.`,
      );
      return false;
    }
  }

  private readOperatorStopBarriers(): {
    records: Array<OperatorStopBarrierRecord & { markerPath: string }>;
    invalid: string[];
  } {
    const records: Array<OperatorStopBarrierRecord & { markerPath: string }> = [];
    const invalid: string[] = [];
    for (const directory of this.operatorStopBarrierDirectories()) {
      if (!fs.existsSync(directory)) continue;
      let entries: fs.Dirent[];
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("barrier path is not a real directory");
        }
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error: unknown) {
        invalid.push(`${directory} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      for (const entry of entries) {
        const markerPath = path.join(directory, entry.name);
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          invalid.push(markerPath);
          continue;
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            (parsed as { version?: unknown }).version !== OPERATOR_STOP_BARRIER_VERSION ||
            typeof (parsed as { token?: unknown }).token !== "string" ||
            typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
            typeof (parsed as { executionRoot?: unknown }).executionRoot !== "string" ||
            typeof (parsed as { pid?: unknown }).pid !== "number" ||
            typeof (parsed as { createdAt?: unknown }).createdAt !== "string"
          ) {
            throw new Error("invalid shape");
          }
          const record = parsed as OperatorStopBarrierRecord;
          records.push({
            ...record,
            executionRoot: canonicalizePotentialPathSync(record.executionRoot),
            markerPath,
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          invalid.push(`${markerPath} (${detail})`);
        }
      }
    }
    return { records, invalid };
  }

  private assertNoDurableOperatorStopBarrier(taskId: string): void {
    const barriers = this.readOperatorStopBarriers();
    if (barriers.invalid.length > 0) {
      throw new Error(
        `Cannot start ${taskId}: invalid operator-stop recovery evidence must be resolved manually: ` +
          barriers.invalid.join("; "),
      );
    }
    const sharedRoot = normalizeExecutionRoot(canonicalizePotentialPathSync(this.projectRoot));
    const expectedWorktree = normalizeExecutionRoot(
      canonicalizePotentialPathSync(path.join(this.managedWorktreesRoot(), taskId)),
    );
    const blocking = barriers.records.find((record) => {
      const recordRoot = normalizeExecutionRoot(record.executionRoot);
      return (
        record.taskId === taskId || recordRoot === sharedRoot || recordRoot === expectedWorktree
      );
    });
    if (blocking) {
      throw new Error(
        `Cannot start ${taskId}: operator-stop cleanup remains unconfirmed for ` +
          `${blocking.taskId} at ${blocking.executionRoot}. Verify process/container absence and ` +
          `protected-path recovery, then explicitly clear ${blocking.markerPath}.`,
      );
    }
  }

  private managedWorktreeRecoverySkipReasons(taskId: string, worktreePath: string): string[] {
    const reasons: string[] = [];
    const job = this.jobs.get(taskId);
    if (this.operatorStopCleanupPending.has(taskId) || job?.operatorStopCleanupPending === true) {
      reasons.push("operator_stop_cleanup_pending");
    }

    const barriers = this.readOperatorStopBarriers();
    if (barriers.invalid.length > 0) {
      reasons.push("invalid_operator_stop_barrier");
    } else {
      try {
        const sharedRoot = normalizeExecutionRoot(canonicalizePotentialPathSync(this.projectRoot));
        const candidateRoot = normalizeExecutionRoot(canonicalizePotentialPathSync(worktreePath));
        if (
          barriers.records.some((record) => {
            const recordRoot = normalizeExecutionRoot(record.executionRoot);
            return (
              record.taskId === taskId || recordRoot === sharedRoot || recordRoot === candidateRoot
            );
          })
        ) {
          reasons.push("operator_stop_barrier");
        }
      } catch {
        reasons.push("recovery_state_unverifiable");
      }
    }

    try {
      this.assertNoOrphanedQuarantineBeforeWorktreeMutation(taskId, worktreePath);
    } catch {
      reasons.push("denied_path_quarantine");
    }

    return [...new Set(reasons)];
  }

  private createJunction(targetPath: string, junctionPath: string): void {
    if (pathExistsViaLstat(junctionPath)) return;
    fs.symlinkSync(targetPath, junctionPath, "junction");
  }

  private managedWorktreesRoot(): string {
    return path.join(this.projectRoot, ".quack", "worktrees");
  }

  private managedWorktreeRoots(): ManagedWorktreeRoot[] {
    return [
      { kind: "quack", root: this.managedWorktreesRoot() },
      { kind: "hermes", root: path.join(this.projectRoot, ".hermes-worktrees") },
      { kind: "claude", root: path.join(this.projectRoot, ".claude", "worktrees") },
    ];
  }

  private prepareDockerAdmittedBranch(
    taskId: string,
    worktreePath: string,
    options?: StartOptions,
  ): { branch: string; head: string } {
    if (Boolean(options?.parentTaskId) !== Boolean(options?.sharedBranchName)) {
      throw new Error(
        `Docker decomposition for ${taskId} requires paired parentTaskId and sharedBranchName before worktree mutation`,
      );
    }
    if (
      options?.parentTaskId &&
      options.sharedBranchName !== `${this.branchPrefix}${options.parentTaskId}`
    ) {
      throw new Error(
        `Docker decomposition for ${taskId} requires the host-derived parent branch ${this.branchPrefix}${options.parentTaskId}`,
      );
    }
    const branch = options?.sharedBranchName ?? `${this.branchPrefix}${taskId}`;
    if (!isSafeDockerBranchName(branch)) {
      throw new Error(`Docker dispatch ${taskId} received an unsafe admitted branch name`);
    }
    const fullRef = `refs/heads/${branch}`;
    const git = (cwd: string, args: string[]): string =>
      runTrustedGitSync(args, cwd, {
        timeoutMs: 15_000,
        maxBuffer: 1024 * 1024,
        trustedBoundaryRoot: this.projectRoot,
        ...(this.trustedLocalReadRemotePaths
          ? { trustedLocalReadRemotePaths: this.trustedLocalReadRemotePaths }
          : {}),
      }).trim();

    if (options?.resume || options?.reuseWorktree) {
      const head = git(this.projectRoot, ["rev-parse", "--verify", fullRef]);
      return { branch, head };
    }

    if (options?.sharedBranchName) {
      const head = git(this.projectRoot, ["rev-parse", "--verify", fullRef]);
      // Keep the linked worktree detached: only the host-owned ref is
      // authoritative, while the container receives a same-named private ref.
      git(worktreePath, ["reset", "--hard", head]);
      return { branch, head };
    }

    const head = git(worktreePath, ["rev-parse", "HEAD"]);
    const objectFormat = git(this.projectRoot, ["rev-parse", "--show-object-format"]);
    const zero = "0".repeat(objectFormat === "sha256" ? 64 : 40);
    git(this.projectRoot, ["update-ref", fullRef, head, zero]);
    return { branch, head };
  }

  private readBranchCleanupPolicy(): ResolvedWorktreeCleanupPolicy {
    const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
    let config: BranchCleanupPolicyConfig | undefined;
    let branchRetentionDays: number | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as unknown;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (parsed.success) {
        config = parsed.data.git.branchCleanup;
        branchRetentionDays = parsed.data.git.branchRetentionDays;
      }
    } catch {
      // Missing or invalid adapter config falls back to conservative policy.
    }

    return {
      enabled: config?.enabled ?? true,
      retentionDays: config?.retentionDays ?? branchRetentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS,
      allowedPrefixes: config?.allowedPrefixes ?? DEFAULT_ALLOWED_BRANCH_PREFIXES,
      protectedOwners: (config?.protectedOwners ?? DEFAULT_PROTECTED_OWNERS).map((owner) =>
        owner.toLowerCase(),
      ),
      protectedPatterns: config?.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS,
      requireOwnerOverride: config?.requireOwnerOverride ?? true,
    };
  }

  private resolveWorktreeOwner(
    kind: ManagedWorktreeRootKind,
    taskId: string,
    branchName: string | undefined,
    policy: ResolvedWorktreeCleanupPolicy,
  ): { owner?: string; provenance: string[]; allowedPrefix?: string } {
    const subject = branchName ?? taskId;
    const lower = subject.toLowerCase();
    const provenance: string[] = [];
    const branchAllowedPrefix = allowedPrefixForBranch(branchName, policy.allowedPrefixes);
    const taskAllowedPrefix = branchName
      ? undefined
      : this.inferAllowedPrefixForUnregisteredWorktree(kind, taskId, policy.allowedPrefixes);

    if (branchAllowedPrefix) provenance.push(`allowedPrefix:${branchAllowedPrefix}`);
    if (taskAllowedPrefix) provenance.push(`inferredPrefix:${taskAllowedPrefix}`);

    const protectedPattern =
      matchesPattern(subject, policy.protectedPatterns) ??
      matchesPattern(taskId, policy.protectedPatterns);
    if (protectedPattern) {
      provenance.push(`protectedPattern:${protectedPattern}`);
      return {
        owner: lower.includes("contributor")
          ? "contributor"
          : normalizeOwner(lower.split(/[/-]/)[0]),
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (lower.match(/(^|[/_-])(contributor)([/_-]|$)/)) {
      provenance.push("name:contributor");
      return {
        owner: "contributor",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("echo/task-") || kind === "hermes") {
      provenance.push(kind === "hermes" ? "root:.hermes-worktrees" : "prefix:echo/TASK-");
      return {
        owner: "hermes",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("codex/") || kind === "claude") {
      provenance.push(kind === "claude" ? "root:.claude/worktrees" : "prefix:codex/");
      return {
        owner: kind === "claude" ? "claude" : "codex",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("quack/task-") || kind === "quack") {
      provenance.push(kind === "quack" ? "root:.quack/worktrees" : "prefix:quack/TASK-");
      return {
        owner: "quack",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    return {
      provenance,
      allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
    };
  }

  private inferAllowedPrefixForUnregisteredWorktree(
    kind: ManagedWorktreeRootKind,
    taskId: string,
    allowedPrefixes: string[],
  ): string | undefined {
    if (!/^TASK-\d+/i.test(taskId)) return undefined;
    if (kind === "quack" && allowedPrefixes.includes("quack/TASK-")) return "quack/TASK-";
    if (kind === "hermes" && allowedPrefixes.includes("echo/TASK-")) return "echo/TASK-";
    return undefined;
  }

  private readRegisteredWorktreePaths(): Set<string> {
    try {
      const output = runTrustedGitSync(["worktree", "list", "--porcelain"], this.projectRoot, {
        timeoutMs: 10_000,
      });
      const paths = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry));
      return new Set(paths);
    } catch {
      return new Set<string>();
    }
  }

  listManagedWorktrees(
    maxAgeMs = 24 * 60 * 60 * 1000,
    nowMs = Date.now(),
  ): ManagedWorktreeRecord[] {
    const policy = this.readBranchCleanupPolicy();
    const registeredPaths = this.readRegisteredWorktreePaths();
    const records: ManagedWorktreeRecord[] = [];

    for (const { kind, root } of this.managedWorktreeRoots()) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        const worktreePath = path.join(root, taskId);
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(worktreePath);
        } catch {
          stat = undefined;
        }
        const ageMs = stat ? Math.max(0, nowMs - stat.mtimeMs) : Number.POSITIVE_INFINITY;
        const registered = registeredPaths.has(path.resolve(worktreePath));
        const job = kind === "quack" ? this.jobs.get(taskId) : undefined;
        const activeJob = job?.status === "running" || job?.status === "awaiting_approval";
        const branchName = registered
          ? this.gitOutput(worktreePath, ["branch", "--show-current"]) || undefined
          : undefined;
        const statusOutput = registered
          ? this.gitOutput(worktreePath, ["status", "--short"])
          : undefined;
        const unpushedCommits = registered
          ? Number(
              this.gitOutput(worktreePath, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) ||
                "0",
            )
          : 0;
        const dirty = typeof statusOutput === "string" && statusOutput.trim().length > 0;
        const evidenceFiles = [
          "PROGRESS.md",
          "claude-progress.txt",
          "HERMES_HANDOFF.md",
          "HANDOFF.md",
        ].filter((fileName) => fs.existsSync(path.join(worktreePath, fileName)));
        if (fs.existsSync(this.worktreeSurvivorPath(taskId))) {
          evidenceFiles.push("shutdown-survivor");
        }
        const ownership = this.resolveWorktreeOwner(kind, taskId, branchName, policy);
        const protectedOwner = ownership.owner
          ? policy.protectedOwners.includes(ownership.owner)
          : false;
        const requiresOwnerOverride = protectedOwner && policy.requireOwnerOverride;
        const skipReasons: string[] = [];
        if (!policy.enabled) skipReasons.push("cleanup_disabled");
        if (!ownership.allowedPrefix) skipReasons.push("disallowed_prefix");
        if (requiresOwnerOverride) skipReasons.push("protected_owner");
        if (activeJob) skipReasons.push("active_job");
        if (ageMs < maxAgeMs) skipReasons.push("fresh");
        if (evidenceFiles.length > 0) skipReasons.push("evidence_files_present");
        if (dirty) skipReasons.push("dirty_git_state");
        if (unpushedCommits > 0) skipReasons.push("unpushed_commits");
        if (registered && statusOutput === undefined) skipReasons.push("git_status_unavailable");
        if ((kind === "hermes" || kind === "claude") && branchName) {
          skipReasons.push("active_git_branch");
        }
        for (const reason of this.managedWorktreeRecoverySkipReasons(taskId, worktreePath)) {
          if (!skipReasons.includes(reason)) skipReasons.push(reason);
        }
        const pruneEligible = skipReasons.length === 0;

        records.push({
          taskId,
          path: worktreePath,
          rootKind: kind,
          exists: fs.existsSync(worktreePath),
          registered,
          branchName,
          owner: ownership.owner,
          ownerProvenance: ownership.provenance,
          allowedPrefix: ownership.allowedPrefix,
          protectedOwner,
          requiresOwnerOverride,
          lastModifiedAt: stat?.mtime.toISOString(),
          ageMs,
          jobStatus: job?.status,
          activeJob,
          dirty,
          evidenceFiles,
          pruneEligible,
          skipReasons,
        });
      }
    }

    return records.sort((a, b) => a.path.localeCompare(b.path));
  }

  pruneManagedWorktrees(options?: {
    dryRun?: boolean;
    maxAgeMs?: number;
    nowMs?: number;
    ownerOverride?: BranchCleanupOwnerOverride;
  }): ManagedWorktreeCleanupResult {
    const checkedAt = new Date().toISOString();
    const dryRun = options?.dryRun !== false;
    const maxAgeMs = options?.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const policy = this.readBranchCleanupPolicy();
    const records = this.listManagedWorktrees(maxAgeMs, options?.nowMs);
    const overrideOwner = normalizeOwner(options?.ownerOverride?.owner);
    const overrideReason = options?.ownerOverride?.reason.trim();
    const candidates = records.filter((record) => {
      if (record.pruneEligible) return true;
      if (!record.requiresOwnerOverride || !record.owner || !overrideReason) return false;
      if (overrideOwner !== record.owner) return false;
      const remainingSkips = record.skipReasons.filter((reason) => reason !== "protected_owner");
      return remainingSkips.length === 0;
    });
    const pruned: string[] = [];

    if (!dryRun) {
      for (const record of candidates) {
        try {
          const recoveryReasons = this.managedWorktreeRecoverySkipReasons(
            record.taskId,
            record.path,
          );
          if (recoveryReasons.length > 0) {
            record.skipReasons.push(...recoveryReasons);
            record.skipReasons = [...new Set(record.skipReasons)];
            record.pruneEligible = false;
            continue;
          }
          if (!this.cleanupDockerForWorktree(record.path)) {
            record.skipReasons.push("docker_cleanup_unverified");
            record.pruneEligible = false;
            continue;
          }
          // Cleanup and deletion are synchronous within one monitor, but a
          // second monitor may have written recovery evidence while Docker was
          // being inspected. Re-read the durable fences immediately before
          // the destructive worktree operation.
          const postDockerRecoveryReasons = this.managedWorktreeRecoverySkipReasons(
            record.taskId,
            record.path,
          );
          if (postDockerRecoveryReasons.length > 0) {
            record.skipReasons.push(...postDockerRecoveryReasons);
            record.skipReasons = [...new Set(record.skipReasons)];
            record.pruneEligible = false;
            continue;
          }
          this.unlinkJunctions(record.path);
          if (record.registered) {
            runTrustedGitSync(["worktree", "remove", "--force", record.path], this.projectRoot, {
              timeoutMs: 30_000,
            });
          } else if (this.isolationConfig?.method !== "docker") {
            fs.rmSync(record.path, { recursive: true, force: true });
          }
          if (fs.existsSync(record.path) && this.isolationConfig?.method !== "docker") {
            fs.rmSync(record.path, { recursive: true, force: true });
          }
          if (!fs.existsSync(record.path)) pruned.push(record.path);
        } catch {
          // Leave failures in retained[] for operator follow-up.
        }
      }
      try {
        runTrustedGitSync(["worktree", "prune"], this.projectRoot, { timeoutMs: 30_000 });
      } catch {
        // Best effort only.
      }
    }

    const retained = dryRun ? records : records.filter((record) => !pruned.includes(record.path));
    return {
      checkedAt,
      dryRun,
      maxAgeMs,
      policy,
      scanned: records.length,
      pruneEligible: candidates.length,
      candidates,
      pruned,
      retained,
    };
  }

  /**
   * Set a callback for container lifecycle events (used by monitor SSE).
   */
  setEventCallback(cb: DispatchEventCallback): void {
    this.onEvent = cb;
  }

  /** Permanently close dispatch admission before terminal server draining. */
  beginTerminalDrain(): void {
    this.terminalDrainStarted = true;
  }

  private assertDispatchAdmissionOpen(): void {
    if (this.terminalDrainStarted) {
      throw new Error("Dispatch admission is closed because the monitor is shutting down.");
    }
  }

  /**
   * Check Docker availability. Call on startup when isolation.method is "docker".
   * Throws if Docker daemon is not reachable.
   */
  async checkDockerAvailability(registeredProjectRoots?: readonly string[]): Promise<string> {
    if (!this.dockerManager) {
      throw new Error("Docker isolation is not configured");
    }
    if (registeredProjectRoots) {
      this.dockerRegisteredProjectRoots = [...registeredProjectRoots];
    }
    const version = await this.dockerManager.checkDocker();
    await this.ensureDockerOwnershipReconciled();
    return version;
  }

  /** Update the daemon-wide project-root snapshot before the next admission. */
  setDockerRegisteredProjectRoots(registeredProjectRoots: readonly string[]): void {
    this.dockerRegisteredProjectRoots = [
      ...new Set(registeredProjectRoots.map((root) => path.resolve(root))),
    ];
  }

  private ensureDockerOwnershipReconciled(): Promise<void> {
    if (!this.dockerManager) return Promise.resolve();
    if (!this.dockerReconciliationPromise) {
      const dockerManager = this.dockerManager;
      const reconciliation = dockerManager
        .reconcileExistingContainers(this.dockerRegisteredProjectRoots)
        .then((result) => {
          if (result.ambiguousContainerIds.length > 0) {
            throw new Error(
              "Docker ownership reconciliation found ambiguous Quack containers: " +
                result.ambiguousContainerIds.join(", "),
            );
          }
          if (result.failedTaskIds.length > 0) {
            throw new Error(
              "Docker ownership reconciliation could not remove prior containers for: " +
                result.failedTaskIds.join(", "),
            );
          }
          this.releaseAbsentDockerWorktreeOwnership();
        });
      const sharedReconciliation = reconciliation.finally(() => {
        if (this.dockerReconciliationPromise === sharedReconciliation) {
          this.dockerReconciliationPromise = null;
        }
      });
      this.dockerReconciliationPromise = sharedReconciliation;
    }
    return this.dockerReconciliationPromise;
  }

  private releaseAbsentDockerWorktreeOwnership(): void {
    if (!this.dockerManager) return;
    for (const marker of this.readWorktreeShutdownSurvivors()) {
      if (marker.strategy !== "docker-container" || this.getDockerContainer(marker.taskId)) {
        continue;
      }
      this.clearWorktreeSurvivor(
        {
          taskId: marker.taskId,
          sessionId: marker.sessionId,
          worktreeOwnershipId: marker.ownershipId,
          worktreePath: marker.worktreePath,
          pid: marker.processId ?? 0,
          startedAt: marker.recordedAt,
          status: "stopped",
          output: [],
        },
        true,
      );
    }
  }

  /**
   * Keep shutdown compatible with narrow test/embedding adapters that predate
   * the unresolved-container distinction. Production DockerManager exposes
   * the stronger method; the fallback still treats every tracked container as
   * unresolved and therefore fails closed.
   */
  private getDockerUnresolvedContainers(): DockerContainer[] {
    if (!this.dockerManager) return [];
    const manager = this.dockerManager as DockerManager & {
      getUnresolvedContainers?: () => DockerContainer[];
    };
    return typeof manager.getUnresolvedContainers === "function"
      ? manager.getUnresolvedContainers()
      : manager.getTrackedContainers();
  }

  private getDockerContainer(taskId: string): DockerContainer | undefined {
    if (!this.dockerManager) return undefined;
    const manager = this.dockerManager as DockerManager & {
      getContainer?: (candidateTaskId: string) => DockerContainer | undefined;
    };
    return typeof manager.getContainer === "function"
      ? manager.getContainer(taskId)
      : manager.getTrackedContainers().find((container) => container.taskId === taskId);
  }

  private serializeDockerAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.dockerAdmissionTail.then(operation, operation);
    this.dockerAdmissionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Remove junction symlinks inside a worktree's .quack/ directory
   * BEFORE any recursive directory removal. On Windows, rmSync with
   * recursive:true follows junctions and deletes the target contents.
   * Unlinking first prevents wiping shared log/prep directories.
   */
  private unlinkJunctions(worktreePath: string): void {
    const wtQuack = path.join(worktreePath, ".quack");
    for (const name of ["logs", "prep"]) {
      const junctionPath = path.join(wtQuack, name);
      try {
        const stat = fs.lstatSync(junctionPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(junctionPath);
        }
      } catch {
        // junction doesn't exist or already removed — fine
      }
    }
  }

  private readAdapterBundle(adapterPath: string): string | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as unknown;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      return computeAdapterBundleMetadata(parsed.data).sharedHash;
    } catch {
      return undefined;
    }
  }

  private copyAdapterAsset(mainQuack: string, wtQuack: string, fileName: string): void {
    const source = path.join(mainQuack, fileName);
    const target = path.join(wtQuack, fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
  }

  private ensureWorktreeAdapterFreshness(worktreePath: string): AdapterFreshnessMetadata {
    const mainQuack = path.join(this.projectRoot, ".quack");
    const wtQuack = path.join(worktreePath, ".quack");
    const mainAdapter = path.join(mainQuack, "adapter.json");
    const wtAdapter = path.join(wtQuack, "adapter.json");
    const authoritativeHash = this.readAdapterBundle(mainAdapter);

    if (!authoritativeHash) {
      return {
        status: "unknown",
        reason: "authoritative adapter bundle is unavailable or invalid",
      };
    }

    fs.mkdirSync(wtQuack, { recursive: true });
    const localHash = this.readAdapterBundle(wtAdapter);
    // TASK-1313 (round-1 F10): the refresh decision is driven by a
    // SEPARATE machinery-asset hash over the Tier-S companion files —
    // the federation-facing sharedHash (normalized adapter.json only)
    // keeps its external comparison semantics untouched. This closes
    // the companion-file gap: a conventions.md/judge-criteria.md/
    // verify.js drift now triggers a re-copy even when adapter.json is
    // unchanged. (Tier-S DIRECTORIES stay residual here; the worktree
    // copies are seeded at creation and validated by the S3 barrier.)
    const machineryHash = (quackDir: string): string => {
      const hash = createHash("sha256");
      for (const fileName of MACHINERY_ASSET_FILES) {
        const filePath = path.join(quackDir, fileName);
        try {
          hash.update(fileName);
          hash.update(fs.readFileSync(filePath));
        } catch {
          hash.update(`${fileName}:absent`);
        }
      }
      return hash.digest("hex");
    };
    // Round-2 F5: the machinery-hash recopy is gated on an opted-in
    // safetyFloor mode — non-opted adapters keep exactly the pre-1313
    // freshness behavior (adapter.json bundle hash only, 3-file copy).
    const machineryModesActive = ((): boolean => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(mainQuack, "adapter.json"), "utf-8")) as {
          judgment?: { safetyFloor?: Record<string, { mode?: string }> };
        };
        const floor = raw.judgment?.safetyFloor;
        if (!floor) return false;
        return Object.values(floor).some(
          (entry) => entry && entry.mode !== undefined && entry.mode !== "off",
        );
      } catch {
        return false;
      }
    })();
    if (
      localHash === authoritativeHash &&
      (!machineryModesActive || machineryHash(wtQuack) === machineryHash(mainQuack))
    ) {
      return { status: "fresh", localHash, authoritativeHash };
    }

    const filesToCopy = machineryModesActive
      ? MACHINERY_ASSET_FILES
      : (["adapter.json", "conventions.md", "judge-criteria.md"] as const);
    for (const fileName of filesToCopy) {
      this.copyAdapterAsset(mainQuack, wtQuack, fileName);
    }

    const refreshedHash = this.readAdapterBundle(wtAdapter);
    if (refreshedHash === authoritativeHash) {
      return {
        status: "refreshed",
        localHash: refreshedHash,
        authoritativeHash,
        reason: localHash
          ? `refreshed stale worktree adapter bundle from ${shortHash(localHash)} to ${shortHash(authoritativeHash)}`
          : "restored missing worktree adapter bundle from authoritative project adapter",
      };
    }

    return {
      status: "stale",
      localHash: refreshedHash ?? localHash,
      authoritativeHash,
      reason:
        "worktree adapter bundle could not be refreshed to match the authoritative project adapter",
    };
  }

  /**
   * Create an isolated git worktree for a task dispatch.
   * Returns the worktree path, or undefined if worktree creation fails
   * (falls back to shared working directory).
   */
  private createWorktree(
    taskId: string,
    options?: {
      preserveTaskBranch?: boolean;
      ownershipId?: string;
      linkRuntimeDirectories?: boolean;
    },
  ): string | undefined {
    const ownershipId = options?.ownershipId;
    const linkRuntimeDirectories = options?.linkRuntimeDirectories ?? true;
    const { baseBranch, staleBranch, configuredProtected } =
      this.readWorktreeGitConfiguration(taskId);
    const worktreeBase = path.join(this.projectRoot, ".quack", "worktrees");
    const worktreePath = path.join(worktreeBase, taskId);

    // This guard intentionally sits outside the fallback catch below. A known
    // survivor is not a worktree-creation failure and must never downgrade
    // into the shared project checkout.
    this.assertWorktreeHasNoLiveSurvivor(taskId, worktreePath, ownershipId);

    try {
      // This check is intentionally durable rather than relying on the
      // in-memory stop barrier. After a monitor restart, createWorktree()
      // would otherwise delete the exact stale worktree whose sibling still
      // holds its denied-path originals. Fully validated quarantines for a
      // different sibling worktree are the only candidates safe to ignore.
      this.assertNoOrphanedQuarantineBeforeWorktreeMutation(taskId, worktreePath);
      fs.mkdirSync(worktreeBase, { recursive: true });

      // Clean up stale worktree from a previous failed run.
      // Route through lifecycleRemoveWorktree so any leftover Docker
      // compose services from a previously-crashed dispatch are torn down
      // before the worktree directory is removed.
      if (fs.existsSync(worktreePath)) {
        this.unlinkJunctions(worktreePath);
        const dockerCleanup = this.shouldCleanupDockerForWorktree();
        lifecycleRemoveWorktree(worktreePath, taskId, this.projectRoot, dockerCleanup);
        // A Docker task can create arbitrary descendants. Never use a recursive
        // filesystem fallback that might traverse a hostile reparse point.
        if (fs.existsSync(worktreePath) && this.isolationConfig?.method !== "docker") {
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          } catch {
            // ignore — best effort
          }
          try {
            runTrustedGitSync(["worktree", "prune"], this.projectRoot, {
              timeoutMs: 30_000,
            });
          } catch {
            // ignore prune failures
          }
        }
      }

      // Delete stale task branch from a previous dispatch (Pattern 22 fix).
      // When a dispatch is killed or fails, the branch retains stale commits.
      // createWorktree() is only called for fresh dispatches (not revision/resume),
      // so deleting the branch here ensures the dispatcher creates a clean one.
      // Adapter branch inputs were validated before any worktree mutation.
      // Centralized deletion guard (TASK-1312): this raw `branch -D` is one
      // of the four deletion sites and must never touch a protected branch.
      const protectedSet = [
        ...new Set([...(configuredProtected ?? DEFAULT_PROTECTED_BRANCHES), baseBranch]),
      ];
      const staleGuard = assertBranchDeletionAllowed(staleBranch, protectedSet);
      if (options?.preserveTaskBranch) {
        try {
          runTrustedGitSync(
            ["show-ref", "--verify", "--quiet", `refs/heads/${staleBranch}`],
            this.projectRoot,
            {
              timeoutMs: 10_000,
            },
          );
        } catch {
          throw new Error(
            `Cannot resume ${taskId}: preserved branch ${staleBranch} does not exist`,
          );
        }
      } else if (!staleGuard.allowed) {
        console.warn(
          `[dispatch] ${staleGuard.reason ?? "protected branch"} — skipping stale-branch cleanup`,
        );
        this.onEvent?.("branch_guard_refusal", taskId, {
          branch: staleBranch,
          reason: staleGuard.reason ?? "protected branch",
          site: "stale_branch_cleanup",
        });
      } else {
        try {
          runTrustedGitSync(
            ["show-ref", "--verify", "--quiet", `refs/heads/${staleBranch}`],
            this.projectRoot,
            { timeoutMs: 10_000 },
          );
          // Branch exists — delete it so the dispatcher creates a fresh one
          runTrustedGitSync(["branch", "-D", "--", staleBranch], this.projectRoot, {
            timeoutMs: 10_000,
          });
          console.log(`[dispatch] Deleted stale branch ${staleBranch} for clean re-dispatch`);
        } catch {
          // Branch doesn't exist — nothing to clean
        }
      }

      const baseRef = `refs/remotes/origin/${baseBranch}`;
      try {
        runTrustedGitSync(
          ["fetch", "origin", `refs/heads/${baseBranch}:${baseRef}`],
          this.projectRoot,
          {
            timeoutMs: 60_000,
            ...(this.trustedLocalReadRemotePaths
              ? { trustedLocalReadRemotePaths: this.trustedLocalReadRemotePaths }
              : {}),
          },
        );
        runTrustedGitSync(["show-ref", "--verify", "--quiet", baseRef], this.projectRoot, {
          timeoutMs: 10_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to refresh ${baseRef} before worktree creation: ${msg}`);
      }

      // Fresh runs start detached from the remote base so the dispatcher can
      // create a clean task branch. Resume runs must instead restore the
      // preserved task branch before the dispatcher skips its completed branch
      // stage; otherwise later stages review the untouched base checkout.
      // A short, validated local branch name makes `git worktree add` attach
      // HEAD to that branch. Passing refs/heads/<name> is interpreted as a
      // generic commit-ish and silently creates a detached worktree.
      const worktreeRef = options?.preserveTaskBranch ? staleBranch : baseRef;
      runTrustedGitSync(
        [
          "worktree",
          "add",
          ...(options?.preserveTaskBranch ? [] : ["--detach"]),
          worktreePath,
          worktreeRef,
        ],
        this.projectRoot,
        { timeoutMs: 60_000, errorContext: `Failed to create worktree for ${taskId}` },
      );

      // Create junctions for gitignored .quack subdirectories so that
      // events written in the worktree reach the monitor's log watcher.
      const mainQuack = path.join(this.projectRoot, ".quack");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      if (linkRuntimeDirectories) {
        // Junction: worktree/.quack/logs → main/.quack/logs
        const mainLogs = path.join(mainQuack, "logs");
        const wtLogs = path.join(wtQuack, "logs");
        fs.mkdirSync(mainLogs, { recursive: true });
        this.createJunction(mainLogs, wtLogs);

        // Junction: worktree/.quack/prep → main/.quack/prep
        const mainPrep = resolvePrepStorageDirSync(this.projectRoot);
        const wtPrep = path.join(wtQuack, "prep");
        if (fs.existsSync(mainPrep)) {
          try {
            this.createJunction(mainPrep, wtPrep);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[dispatch] prep junction setup failed for ${taskId}: ${msg}`);
          }
        }
      }

      this.ensureWorktreeAdapterFreshness(worktreePath);

      // Legacy adapters that explicitly disable initialization can reuse the
      // parent's frontend dependencies. Initialization-owned or guard-protected
      // dependency trees must stay real and isolated inside the worktree.
      if (this.sharedFrontendDependenciesAllowed()) {
        prepareWorktreeFrontendDeps(worktreePath, this.projectRoot, taskId);
      }

      if (this.worktreeDegraded) {
        console.log("[dispatch] Worktree isolation recovered; parallel dispatch re-enabled.");
      }
      this.worktreeDegraded = false;
      return worktreePath;
    } catch (err) {
      // A quarantine refusal is not a worktree-creation failure and must
      // never enter the fallback cleanup below: that cleanup is exactly the
      // destructive operation this preflight exists to prevent.
      if (
        err instanceof OrphanedQuarantineRefusalError ||
        err instanceof InvalidDispatchGitReferenceError
      ) {
        throw err;
      }
      // Worktree creation failed — set degraded flag and emit event
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] Worktree creation failed for ${taskId}: ${msg}`);
      console.error(
        "[dispatch] Worktree isolation degraded — parallel dispatch blocked until restart",
      );
      this.worktreeDegraded = true;

      // Emit event so dashboard/SSE can surface the failure
      this.onEvent?.("worktree_failed", taskId, {
        error: msg,
        fallback: "shared_directory",
      });

      // Clean up partial worktree
      try {
        if (fs.existsSync(worktreePath) && this.isolationConfig?.method !== "docker") {
          this.unlinkJunctions(worktreePath);
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        runTrustedGitSync(["worktree", "prune"], this.projectRoot, {
          timeoutMs: 30_000,
        });
      } catch {
        // ignore cleanup failures
      }

      return undefined;
    }
  }

  private assertNoOrphanedQuarantineBeforeWorktreeMutation(
    taskId: string,
    worktreePath: string,
  ): void {
    let canonicalWorktreePath: string;
    try {
      canonicalWorktreePath = canonicalizePotentialPathSync(worktreePath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new OrphanedQuarantineRefusalError(
        `Cannot safely start ${taskId}: unable to canonicalize execution root ${worktreePath} (${detail}).`,
      );
    }
    const worktreeParent = path.dirname(canonicalWorktreePath);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreeParent, { withFileTypes: true });
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") return;
      const detail = error instanceof Error ? error.message : String(error);
      throw new OrphanedQuarantineRefusalError(
        `Cannot safely start ${taskId}: unable to inspect the worktree quarantine directory ` +
          `${worktreeParent} (${detail}).`,
      );
    }

    const blocking: string[] = [];
    for (const entry of entries) {
      if (!CODEX_DENIED_QUARANTINE_DIRECTORY.test(entry.name)) continue;
      const quarantineRoot = path.join(worktreeParent, entry.name);
      if (!entry.isDirectory()) {
        blocking.push(`${quarantineRoot} (prefixed entry is not a directory)`);
        continue;
      }
      const inspection = inspectCodexDeniedPathQuarantineSync(
        canonicalWorktreePath,
        quarantineRoot,
      );
      if (inspection.status !== "other_project") {
        blocking.push(`${quarantineRoot} (${inspection.reason ?? inspection.status})`);
      }
    }

    if (blocking.length > 0) {
      throw new OrphanedQuarantineRefusalError(
        `Cannot safely start ${taskId}: unresolved Codex denied-path quarantine evidence ` +
          `must be recovered or explicitly preserved before this execution root can be reused: ` +
          blocking.join("; "),
      );
    }
  }

  /**
   * Remove a git worktree after the task dispatch finishes.
   * Delegates docker cleanup + git worktree remove to worktree-lifecycle.ts.
   * Keeps a fallback fs.rmSync for ordinary worktree mode only. Docker
   * worktrees may contain hostile links and are preserved if Git cannot remove
   * them without traversing descendants.
   */
  private removeWorktree(worktreePath: string): boolean {
    const dockerCleanup = this.shouldCleanupDockerForWorktree();
    if (dockerCleanup && !this.cleanupDockerForWorktree(worktreePath)) {
      console.error(`[dispatch] Preserving ${worktreePath}: Docker cleanup could not be confirmed`);
      return false;
    }
    this.unlinkJunctions(worktreePath);
    // Docker absence was already proved above, before changing any worktree
    // evidence. The lifecycle helper now performs only the Git removal.
    lifecycleRemoveWorktree(
      worktreePath,
      this.getTaskIdFromPath(worktreePath),
      this.projectRoot,
      false,
    );
    // Fallback: if git worktree remove failed, try direct filesystem removal
    if (fs.existsSync(worktreePath) && this.isolationConfig?.method !== "docker") {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore — best effort
      }
      try {
        runTrustedGitSync(["worktree", "prune"], this.projectRoot, {
          timeoutMs: 30_000,
        });
      } catch {
        // ignore prune failures
      }
    }
    return !fs.existsSync(worktreePath);
  }

  /**
   * Extract task ID from a worktree path (e.g. .quack/worktrees/TASK-826 -> TASK-826).
   */
  private getTaskIdFromPath(worktreePath: string): string {
    return path.basename(path.normalize(worktreePath));
  }

  /**
   * Check if a pending judge approval file exists for the given task,
   * created during or after the given timestamp. Used by the exit handler
   * to detect awaiting_judge_approval exits vs. regular failures.
   */
  /**
   * Is EITHER human gate pending for this dispatch?
   *
   * QPI-041: this used to check only `<taskId>-judge.json`, so a run that
   * paused at the BLUEPRINT gate was not recognised as paused. It exited
   * non-zero (correctly, it had not finished), the parent recorded
   * `failed`, and federation reported "local dispatch failed" with
   * `nextAction: investigate_failed_worker`.
   *
   * In loop mode the brief gate is the FIRST gate every run reaches, so
   * the un-handled case was the common one, and the consequence was not
   * cosmetic: the operator re-POSTed what looked dead, and the re-POST
   * destroyed the paused run's checkpoint (QPI-042).
   */
  private isApprovalPending(
    taskId: string,
    afterTimestamp: string,
    runtimeLogDir = this.logDir,
  ): boolean {
    return (
      this.isGateApprovalPending(`${taskId}.json`, afterTimestamp, runtimeLogDir) ||
      this.isGateApprovalPending(`${taskId}-judge.json`, afterTimestamp, runtimeLogDir)
    );
  }

  private dockerPausePointerPath(taskId: string): string {
    return path.join(
      this.logDir,
      "docker-pauses",
      `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
    );
  }

  private withDockerPausePointerLock<T>(taskId: string, operation: () => T): T {
    const pointerPath = this.dockerPausePointerPath(taskId);
    const lockPath = `${pointerPath}.lock`;
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf-8", flag: "wx" },
      );
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "EEXIST") {
        throw new Error(`Docker pause ownership for ${taskId} is locked or unreconciled`);
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      try {
        fs.rmSync(lockPath);
      } catch {
        // A retained lock deliberately keeps resume fail-closed.
      }
    }
  }

  private readDockerPausePointer(taskId: string): DockerPausedRunPointer | undefined {
    const pointerPath = this.dockerPausePointerPath(taskId);
    try {
      const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf-8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        (parsed as { taskId?: unknown }).taskId !== taskId ||
        typeof (parsed as { archiveName?: unknown }).archiveName !== "string" ||
        path.basename((parsed as { archiveName: string }).archiveName) !==
          (parsed as { archiveName: string }).archiveName ||
        typeof (parsed as { dispatchSessionId?: unknown }).dispatchSessionId !== "string" ||
        typeof (parsed as { ownershipId?: unknown }).ownershipId !== "string" ||
        !["blueprint", "judge"].includes(
          String((parsed as { approvedGate?: unknown }).approvedGate),
        ) ||
        typeof (parsed as { provenance?: unknown }).provenance !== "object" ||
        (parsed as { provenance?: unknown }).provenance === null ||
        Boolean((parsed as { parentTaskId?: unknown }).parentTaskId) !==
          Boolean((parsed as { sharedBranchName?: unknown }).sharedBranchName) ||
        ((parsed as { parentTaskId?: unknown }).parentTaskId !== undefined &&
          typeof (parsed as { parentTaskId?: unknown }).parentTaskId !== "string") ||
        ((parsed as { sharedBranchName?: unknown }).sharedBranchName !== undefined &&
          (typeof (parsed as { sharedBranchName?: unknown }).sharedBranchName !== "string" ||
            !isSafeDockerBranchName(
              String((parsed as { sharedBranchName?: unknown }).sharedBranchName),
            ))) ||
        typeof (parsed as { recordedAt?: unknown }).recordedAt !== "string" ||
        !Number.isFinite(Date.parse((parsed as { recordedAt: string }).recordedAt))
      ) {
        throw new Error("invalid pointer schema");
      }
      return parsed as DockerPausedRunPointer;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") return undefined;
      throw new Error(
        `Docker pause ownership for ${taskId} is unreadable; explicit reconciliation is required`,
      );
    }
  }

  private dockerBindingMatchesPointer(
    pointer: DockerPausedRunPointer,
    binding: DockerResumeSourceBinding,
  ): boolean {
    return (
      pointer.archiveName === binding.archiveName &&
      pointer.dispatchSessionId === binding.dispatchSessionId &&
      pointer.ownershipId === binding.ownershipId &&
      pointer.approvedGate === binding.approvedGate &&
      pointer.parentTaskId === binding.parentTaskId &&
      pointer.sharedBranchName === binding.sharedBranchName
    );
  }

  private writeDockerPausePointer(
    job: DispatchJob,
    binding: DockerPausedRuntimeBinding,
    resumedFrom?: DockerResumeSourceBinding,
  ): void {
    if (
      job.sessionId !== binding.dispatchSessionId ||
      job.worktreeOwnershipId !== binding.ownershipId ||
      JSON.stringify(
        job.provenance ?? {
          channel: "api-direct",
          principal: "unattributed-local-start",
        },
      ) !== JSON.stringify(binding.provenance)
    ) {
      throw new Error(
        `Docker pause archive does not match the active host ownership for ${job.taskId}`,
      );
    }
    this.withDockerPausePointerLock(job.taskId, () => {
      const existing = this.readDockerPausePointer(job.taskId);
      if (
        existing &&
        !this.dockerBindingMatchesPointer(existing, binding) &&
        (!resumedFrom || !this.dockerBindingMatchesPointer(existing, resumedFrom))
      ) {
        throw new Error(`Docker pause ownership changed before ${job.taskId} could be recorded`);
      }
      const pointer: DockerPausedRunPointer = {
        version: 1,
        taskId: job.taskId,
        archiveName: binding.archiveName,
        dispatchSessionId: binding.dispatchSessionId,
        ownershipId: binding.ownershipId,
        approvedGate: binding.approvedGate,
        provenance: binding.provenance,
        ...(binding.parentTaskId ? { parentTaskId: binding.parentTaskId } : {}),
        ...(binding.sharedBranchName ? { sharedBranchName: binding.sharedBranchName } : {}),
        recordedAt: new Date().toISOString(),
      };
      const pointerPath = this.dockerPausePointerPath(job.taskId);
      const temporary = `${pointerPath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf-8");
      fs.renameSync(temporary, pointerPath);
    });
  }

  private clearDockerPausePointer(taskId: string, expected: DockerResumeSourceBinding): boolean {
    try {
      return this.withDockerPausePointerLock(taskId, () => {
        const pointer = this.readDockerPausePointer(taskId);
        if (!pointer || !this.dockerBindingMatchesPointer(pointer, expected)) return false;
        fs.rmSync(this.dockerPausePointerPath(taskId));
        return !fs.existsSync(this.dockerPausePointerPath(taskId));
      });
    } catch {
      return false;
    }
  }

  private inspectDockerPausePointer(
    taskId: string,
  ):
    | { logDir: string; binding: DockerPausedRuntimeBinding | DockerResumeSourceBinding }
    | undefined {
    const pointer = this.readDockerPausePointer(taskId);
    if (!pointer) return undefined;
    const candidate = path.join(this.logDir, "docker-import", pointer.archiveName);
    if (!this.isSafeDockerRuntimeLogTree(candidate)) {
      throw new Error(`Docker pause archive for ${taskId} is outside the trusted import tree`);
    }
    let binding: DockerPausedRuntimeBinding | DockerResumeSourceBinding;
    try {
      binding = inspectValidatedDockerPendingArchive(candidate, taskId);
    } catch {
      binding = inspectValidatedDockerResumeArchive(candidate, taskId);
    }
    if (!this.dockerBindingMatchesPointer(pointer, binding)) {
      throw new Error(`Docker pause pointer for ${taskId} does not match its sealed archive`);
    }
    return { logDir: candidate, binding };
  }

  /** Exact monitor-owned runtime archive for approval/read/resume routes. */
  getDockerPausedRuntimeDir(taskId: string): string | undefined {
    // In-memory runtimeLogDir may belong to a later failed publication or
    // retry attempt. Only the CAS-protected pause pointer identifies the
    // operator-approved archive that is eligible for control writes/resume.
    return this.inspectDockerPausePointer(taskId)?.logDir;
  }

  private resolvePausedRuntime(taskId: string): {
    logDir: string;
    paused: NonNullable<ReturnType<typeof resolvePausedRunState>>;
  } | null {
    const exactDockerRuntime = this.inspectDockerPausePointer(taskId)?.logDir;
    const candidates = [...(exactDockerRuntime ? [exactDockerRuntime] : []), this.logDir];
    for (const runtimeLogDir of candidates) {
      if (runtimeLogDir !== this.logDir && !this.isSafeDockerRuntimeLogTree(runtimeLogDir)) {
        continue;
      }
      const paused = resolvePausedRunState(runtimeLogDir, taskId);
      if (paused) return { logDir: runtimeLogDir, paused };
    }
    return null;
  }

  private resolveDockerResumeRuntime(taskId: string): string | undefined {
    const selected = this.inspectDockerPausePointer(taskId);
    if (!selected) return undefined;
    if (!isValidatedDockerResumeArchive(selected.logDir, taskId)) {
      throw new Error(`Docker pause for ${taskId} has not received a valid operator decision`);
    }
    return selected.logDir;
  }

  private dockerPublicationRecoveryRoot(): string {
    return path.join(this.logDir, "docker-publications");
  }

  private assertPublicationSourceOwnership(journal: DockerPublicationJournal): void {
    if (!journal.sourceResume) return;
    const pointer = this.readDockerPausePointer(journal.taskId);
    if (pointer && !this.dockerBindingMatchesPointer(pointer, journal.sourceResume)) {
      throw new Error(
        `Docker publication recovery for ${journal.taskId} no longer owns its exact approval pause`,
      );
    }
  }

  private finalizeDockerPublicationRecovery(
    job: DispatchJob,
    recoveryPath: string,
    journal: DockerPublicationJournal,
  ): void {
    this.assertPublicationSourceOwnership(journal);
    const pointer = journal.sourceResume ? this.readDockerPausePointer(job.taskId) : undefined;
    if (
      journal.sourceResume &&
      pointer &&
      !this.clearDockerPausePointer(job.taskId, journal.sourceResume)
    ) {
      throw new Error("Published Docker result could not release its exact approval pointer");
    }
    if (journal.sourceResume && !this.dockerManager?.releaseSealedResumeRef(journal.sourceResume)) {
      throw new Error("Published Docker result could not release its sealed approval ref");
    }
    if (!this.dockerManager?.releaseSealedPublicationRef(journal.gitState)) {
      throw new Error("Published Docker result could not release its sealed publication ref");
    }
    if (!journal.preserveWorktree) {
      if (
        fs.existsSync(this.worktreeSurvivorPath(job.taskId)) &&
        !this.clearWorktreeSurvivor(job, true)
      ) {
        throw new Error("Published Docker result could not release its exact worktree ownership");
      }
      if (fs.existsSync(journal.worktreePath)) {
        this.removeWorktree(journal.worktreePath);
        if (fs.existsSync(journal.worktreePath)) {
          throw new Error("Published Docker result worktree could not be removed safely");
        }
      }
    } else {
      job.output.push(
        "[docker-publish] Worktree retained with the intentionally retained container; explicit cleanup is required.",
      );
    }
    if (!clearDockerPublicationRecovery(recoveryPath, journal.publicationId)) {
      throw new Error("Completed Docker publication journal could not be cleared");
    }
    delete job.publicationRecoveryPath;
  }

  private startDockerPublicationRecovery(
    taskId: string,
    recoveryPath: string,
    journal: DockerPublicationJournal,
    options?: StartOptions,
  ): DispatchJob {
    if (journal.taskId !== taskId) {
      throw new Error("Docker publication recovery belongs to a different task");
    }
    this.assertPublicationSourceOwnership(journal);
    if (
      options?.dockerResumeStateDir &&
      journal.sourceResume &&
      path.basename(options.dockerResumeStateDir) !== journal.sourceResume.archiveName
    ) {
      throw new Error("Docker publication retry does not match the selected approval archive");
    }
    const job: DispatchJob = {
      taskId,
      sessionId: journal.worktreeSessionId,
      pid: 0,
      startedAt: new Date().toISOString(),
      status: "running",
      output: ["[docker-publish] Resuming exact host publication recovery."],
      worktreePath: journal.worktreePath,
      worktreeOwnershipId: journal.worktreeOwnershipId,
      publicationRecoveryPath: recoveryPath,
      provenance: options?.provenance,
    };
    this.jobs.set(taskId, job);
    void (async () => {
      try {
        const { resumeDockerPromotedResult } =
          await import("../dispatcher/docker-host-publication.js");
        const publication = await resumeDockerPromotedResult(this.projectRoot, recoveryPath);
        if (publication.prUrl) job.output.push(`[docker-publish] PR ${publication.prUrl}`);
        if (publication.autoMerged) {
          job.output.push(
            `[docker-publish] auto-merged${publication.mergeCommitSha ? ` ${publication.mergeCommitSha}` : ""}`,
          );
        }
        job.output.push(...publication.warnings.map((warning) => `[docker-publish] ${warning}`));
        const completed = readDockerPublicationRecovery(recoveryPath);
        this.finalizeDockerPublicationRecovery(job, recoveryPath, completed);
        job.status = "completed";
        job.exitCode = 0;
      } catch (error: unknown) {
        job.status = "failed";
        job.exitCode = 1;
        job.output.push(
          `[docker-publish] ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.jobs.set(taskId, job);
    })();
    return job;
  }

  private assertDockerResumeSelection(
    taskId: string,
    selectedDir: string,
  ): DockerResumeSourceBinding {
    const selected = this.inspectDockerPausePointer(taskId);
    if (!selected) {
      throw new Error(
        `Cannot resume Docker dispatch ${taskId}: no exact paused-run ownership exists.`,
      );
    }
    if (
      path.resolve(selected.logDir) !== path.resolve(selectedDir) ||
      !isValidatedDockerResumeArchive(selected.logDir, taskId)
    ) {
      throw new Error(
        `Cannot resume Docker dispatch ${taskId}: the selected archive is not the exact approved paused run.`,
      );
    }
    return inspectValidatedDockerResumeArchive(selected.logDir, taskId);
  }

  private isSafeDockerRuntimeLogTree(runtimeLogDir: string, worktreePath?: string): boolean {
    const trustedImportRoot = path.resolve(this.logDir, "docker-import");
    const untrustedOutputRoot = worktreePath
      ? path.resolve(worktreePath, ".quack", "docker-runtime")
      : undefined;
    const candidate = path.resolve(runtimeLogDir);
    const under = (root: string): boolean => {
      const relative = path.relative(root, candidate);
      return Boolean(
        relative && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`),
      );
    };
    if (!under(trustedImportRoot) && (!untrustedOutputRoot || !under(untrustedOutputRoot))) {
      return false;
    }
    const pending = [candidate];
    try {
      while (pending.length > 0) {
        const current = pending.pop()!;
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return false;
        if (stat.isFile()) {
          if (stat.nlink !== 1) return false;
          continue;
        }
        if (!stat.isDirectory()) return false;
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy container-authored runtime artifacts into a fresh monitor-owned tree.
   * The agent process has exited before this is called. Every source entry is
   * lstat-checked and hard links/reparse points are rejected, so host-side
   * control writers never open paths in the child-writable worktree tree.
   */
  private archiveDockerRuntimeLogs(job: DispatchJob, sourceDir: string): string {
    if (!job.worktreePath || !this.isSafeDockerRuntimeLogTree(sourceDir, job.worktreePath)) {
      throw new Error("Docker runtime output contains an untrusted link or changed identity");
    }
    const archiveRoot = path.join(this.logDir, "docker-import");
    fs.mkdirSync(archiveRoot, { recursive: true });
    const rootStat = fs.lstatSync(archiveRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Docker runtime archive root is not a trusted directory");
    }
    const safeTaskId = job.taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    const ownership = (job.worktreeOwnershipId ?? randomUUID()).replace(/[^A-Za-z0-9._-]/g, "_");
    const destination = path.join(archiveRoot, `${safeTaskId}-${ownership}`);
    fs.mkdirSync(destination, { recursive: false });
    const pending: Array<{ source: string; destination: string }> = [
      { source: sourceDir, destination },
    ];
    let files = 0;
    let bytes = 0;
    try {
      while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current.source, { withFileTypes: true })) {
          const source = path.join(current.source, entry.name);
          const target = path.join(current.destination, entry.name);
          const stat = fs.lstatSync(source);
          if (
            stat.isSymbolicLink() ||
            stat.isFile() !== entry.isFile() ||
            stat.isDirectory() !== entry.isDirectory()
          ) {
            throw new Error(`untrusted runtime entry: ${entry.name}`);
          }
          if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: false });
            pending.push({ source, destination: target });
            continue;
          }
          if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error(`untrusted runtime file identity: ${entry.name}`);
          }
          files += 1;
          bytes += stat.size;
          if (files > 10_000 || bytes > 100 * 1024 * 1024) {
            throw new Error("Docker runtime output exceeds the safe import limit");
          }
          const sourceFd = fs.openSync(
            source,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
          );
          let targetFd: number | undefined;
          try {
            const opened = fs.fstatSync(sourceFd);
            if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size) {
              throw new Error(`untrusted runtime file identity: ${entry.name}`);
            }
            targetFd = fs.openSync(
              target,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
              opened.mode & 0o666,
            );
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let position = 0;
            for (;;) {
              const read = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
              if (read === 0) break;
              let written = 0;
              while (written < read) {
                written += fs.writeSync(targetFd, buffer, written, read - written);
              }
              position += read;
            }
            const after = fs.fstatSync(sourceFd);
            if (
              after.dev !== opened.dev ||
              after.ino !== opened.ino ||
              after.nlink !== 1 ||
              after.size !== opened.size ||
              position !== opened.size
            ) {
              throw new Error(`runtime file changed while importing: ${entry.name}`);
            }
          } finally {
            if (targetFd !== undefined) fs.closeSync(targetFd);
            fs.closeSync(sourceFd);
          }
          const copied = fs.lstatSync(target);
          if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) {
            throw new Error(`untrusted copied runtime file identity: ${entry.name}`);
          }
        }
      }
      return destination;
    } catch (error) {
      // Destination is monitor-created and contains regular files/directories
      // only, so recursive cleanup cannot traverse an attacker-created link.
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * TASK-1332 (QPI-045): a spec-staleness REFUSAL exits non-zero, so
   * without this it is indistinguishable from a crash — the exact
   * misclassification QPI-041 made about a pause. Decided from DISK and
   * scoped to THIS run, so an older refusal never explains a later exit.
   *
   * Round 3 (R3-3): shared by the worktree AND docker exit handlers. The
   * first cut lived inline in the worktree handler only, so every Docker
   * dispatch lost the classification entirely.
   */
  private classifySpecStaleExit(
    job: DispatchJob,
    taskId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    runtimeLogDir = this.logDir,
  ): void {
    if (code === 0 || signal) return;
    const stale = readSpecStaleMarker(runtimeLogDir, taskId, job.startedAt);
    if (!stale) return;
    job.specStale = {
      verdict: stale.verdict,
      reason: stale.reason,
      refusedAt: stale.refusedAt,
    };
    // Round 4 (R4-1): the advice FOLLOWS THE VERDICT. This line used to
    // hardcode replan, which contradicted the refusal's own message and,
    // for a `diverged` verdict, sent the operator at the one action that
    // provably reproduces the refusal.
    job.output.push(
      `[dispatch] REFUSED, not crashed: ${stale.reason} ` +
        `Nothing was deleted; the approval record, checkpoint and worktree are ` +
        `intact. ${recoveryAdviceFor(stale.verdict)}`,
    );
  }

  private isGateApprovalPending(
    fileName: string,
    afterTimestamp: string,
    runtimeLogDir = this.logDir,
  ): boolean {
    try {
      // Round-2 F3 (partial): this read hardcoded `.quack/logs` while the
      // class already carries the resolved log dir, so on a custom
      // `logging.dir` a real pause was classified as a FAILED exit —
      // QPI-041's symptom, from a different cause. The wider
      // logging.dir threading (resolveTaskRuntimeLogDir, the approve
      // routes) stays with QPI-044; this one line is inside the pause
      // path this task owns.
      const approvalPath = path.join(runtimeLogDir, "approvals", fileName);
      if (!fs.existsSync(approvalPath)) return false;
      const data = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as {
        state?: string;
        createdAt?: string;
      };
      // Must be pending AND created during this dispatch (not a stale file)
      return (
        data.state === "pending" &&
        !!data.createdAt &&
        new Date(data.createdAt).getTime() >= new Date(afterTimestamp).getTime()
      );
    } catch {
      return false;
    }
  }

  /**
   * Refresh the main working tree after a squash merge lands on the
   * checked-out branch. Without this, new files from the merge exist
   * in git history but not on disk (Pattern 17: Stale Working Tree).
   *
   * Uses `git checkout HEAD -- .` to update the working tree from the
   * latest commit without changing branches. This is safe — it only
   * updates tracked files to match HEAD, preserving untracked files.
   */
  private refreshMainWorkingTree(): void {
    try {
      // Pull the latest commits that were pushed from the worktree
      runTrustedGitSync(["pull", "--ff-only"], this.projectRoot, {
        timeoutMs: 15_000,
      });
    } catch {
      // Pull may fail if no remote configured or conflicts — that's ok,
      // the checkout below will still refresh from whatever HEAD is.
    }

    try {
      runTrustedGitSync(["checkout", "HEAD", "--", "."], this.projectRoot, {
        timeoutMs: 15_000,
      });
    } catch {
      // Best-effort — don't fail the job over a refresh failure
    }
  }

  private gitOutput(cwd: string | undefined, args: string[]): string | undefined {
    if (!cwd) return undefined;
    try {
      return runTrustedGitSync(args, cwd, {
        timeoutMs: 10_000,
        trustedBoundaryRoot: this.projectRoot,
      }).trim();
    } catch {
      return undefined;
    }
  }

  private inferBranchNameFromOutput(job: DispatchJob): string | undefined {
    for (const line of [...job.output].reverse()) {
      const match = line.match(/^\s*(?:Branch|Branch preserved):\s+(\S+)/);
      if (match?.[1]) return match[1];
    }
    return undefined;
  }

  private captureGitMetadata(job: DispatchJob, worktreePath?: string): void {
    let branchName =
      job.branchName ??
      this.gitOutput(worktreePath, ["branch", "--show-current"]) ??
      this.inferBranchNameFromOutput(job);
    if (branchName) {
      try {
        this.assertValidGitBranchName(branchName, "captured branch");
      } catch {
        branchName = undefined;
      }
    }

    const commitSha =
      job.commitSha ??
      this.gitOutput(worktreePath, ["rev-parse", "HEAD"]) ??
      (branchName
        ? this.gitOutput(this.projectRoot, [
            "rev-parse",
            "--verify",
            `refs/heads/${branchName}^{commit}`,
          ])
        : undefined);

    if (branchName) job.branchName = branchName;
    if (commitSha) job.commitSha = commitSha;
  }

  private processExists(pid: number | undefined): boolean | undefined {
    if (!pid || pid <= 0) return undefined;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      return code === "EPERM" ? true : false;
    }
  }

  /**
   * Stop a worktree dispatch as one process tree. Windows worktree children
   * run in a non-breakaway Job Object whose stop controller proves zero active
   * processes. POSIX worktree children use a dedicated process group and are
   * confirmed stopped only after that owned group no longer exists.
   */
  private terminateOperatorProcessTree(
    child: ChildProcess,
    launch?: TrustedNodeLaunch,
  ): {
    confirmed: boolean;
    processGroupId?: number;
    warning?: string;
  } {
    const pid = child.pid;
    if (!pid || pid <= 0) {
      child.kill("SIGKILL");
      return {
        confirmed: false,
        warning: "child pid was unavailable; descendant termination could not be confirmed",
      };
    }

    if (process.platform === "win32") {
      if (!launch?.windowsJob) {
        child.kill("SIGKILL");
        return {
          confirmed: false,
          warning: "the dispatch has no Windows Job Object; descendant termination is unconfirmed",
        };
      }
      const result = terminateWindowsNodeJob(launch.windowsJob);
      if (!result.confirmed && confirmWindowsNodeLaunchAlreadyExited(launch)) {
        return {
          confirmed: true,
          warning:
            "the dispatch completed while stop was opening its Job Object; trusted exit evidence proves the wrapper and payload are absent",
        };
      }
      if (!result.confirmed) child.kill("SIGKILL");
      return result;
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "ESRCH") return { confirmed: true, processGroupId: pid };
      child.kill("SIGKILL");
      const detail = err instanceof Error ? err.message : String(err);
      return {
        confirmed: false,
        processGroupId: pid,
        warning: `process-group termination failed; descendant termination is unconfirmed (${detail})`,
      };
    }

    if (this.posixProcessGroupIsAbsent(pid)) return { confirmed: true, processGroupId: pid };
    return {
      confirmed: false,
      processGroupId: pid,
      warning: "POSIX process group termination is awaiting child close confirmation",
    };
  }

  private posixProcessGroupIsAbsent(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      return code === "ESRCH";
    }
  }

  private retryPendingOperatorStop(job: DispatchJob): boolean {
    if (!job.operatorStopTreeTerminated) {
      const child = this.processes.get(job.taskId);
      if (child) {
        const termination = this.terminateOperatorProcessTree(
          child,
          this.nodeLaunches.get(job.taskId),
        );
        job.operatorStopTreeTerminated = termination.confirmed;
        job.operatorStopProcessGroupId = termination.processGroupId;
        if (termination.warning) {
          job.output.push(`[dispatch] Operator-stop termination warning: ${termination.warning}`);
        }
      } else if (
        process.platform !== "win32" &&
        job.operatorStopProcessGroupId !== undefined &&
        this.posixProcessGroupIsAbsent(job.operatorStopProcessGroupId)
      ) {
        job.operatorStopTreeTerminated = true;
      }
    }

    if (!job.operatorStopTreeTerminated) return false;
    if (!this.processes.has(job.taskId)) {
      const recovery = this.completeOperatorStopRecovery(job)
        .then(() => undefined)
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.quarantineRecoveryWarning(job, `operator-stop recovery retry failed (${detail})`);
        });
      this.trackExitHandler(recovery, job);
    }
    return true;
  }

  private quarantineRecoveryWarning(job: DispatchJob, message: string): void {
    const line = `[quarantine] Recovery warning: ${message}; evidence preserved`;
    job.output.push(line);
    console.warn(`[dispatch] ${job.taskId}: ${line}`);
  }

  /**
   * Recover only exact quarantine siblings of this exact worktree. The
   * recovery helper independently validates the canonical root and complete
   * manifest before changing either the worktree or the evidence directory.
   */
  private async recoverStoppedWorktreeQuarantines(
    job: DispatchJob,
    executionRoot: string,
  ): Promise<{ safeToRestart: boolean }> {
    let canonicalExecutionRoot: string;
    try {
      canonicalExecutionRoot = canonicalizePotentialPathSync(executionRoot);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.quarantineRecoveryWarning(
        job,
        `could not canonicalize exact execution root ${executionRoot} (${detail})`,
      );
      return { safeToRestart: false };
    }
    const worktreeParent = path.dirname(canonicalExecutionRoot);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreeParent, { withFileTypes: true });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.quarantineRecoveryWarning(
        job,
        `could not scan exact worktree parent ${worktreeParent} (${detail})`,
      );
      return { safeToRestart: false };
    }

    const validForProject: string[] = [];
    let invalidForProject = false;
    for (const entry of entries) {
      if (!CODEX_DENIED_QUARANTINE_DIRECTORY.test(entry.name)) continue;
      const quarantineRoot = path.join(worktreeParent, entry.name);
      if (!entry.isDirectory()) {
        invalidForProject = true;
        this.quarantineRecoveryWarning(
          job,
          `${quarantineRoot} has the quarantine prefix but is not a directory`,
        );
        continue;
      }

      const inspection = await inspectCodexDeniedPathQuarantine(
        canonicalExecutionRoot,
        quarantineRoot,
      );
      if (inspection.status === "valid_for_project") {
        validForProject.push(quarantineRoot);
      } else if (inspection.status === "other_project") {
        this.quarantineRecoveryWarning(
          job,
          `${quarantineRoot} belongs to another project${
            inspection.projectRoot ? ` (${inspection.projectRoot})` : ""
          }`,
        );
      } else {
        invalidForProject = true;
        this.quarantineRecoveryWarning(
          job,
          `${quarantineRoot} could not be safely attributed or validated (${inspection.reason ?? "unknown manifest error"})`,
        );
      }
    }

    if (validForProject.length > 1) {
      this.quarantineRecoveryWarning(
        job,
        `multiple valid quarantines target ${canonicalExecutionRoot}: ${validForProject.join(", ")}. ` +
          "Resolve the generations manually before retrying the task",
      );
      return { safeToRestart: false };
    }

    // A malformed or unattributable sibling may be a damaged generation for
    // this exact worktree. Do not mutate the one valid generation while that
    // ambiguity exists: doing so could restore the wrong bytes and destroy the
    // only usable evidence for the real generation.
    if (invalidForProject) {
      this.quarantineRecoveryWarning(
        job,
        `ambiguous quarantine evidence targets ${canonicalExecutionRoot}; no generation was recovered`,
      );
      return { safeToRestart: false };
    }

    if (validForProject.length === 1) {
      const quarantineRoot = validForProject[0];
      try {
        const result = await recoverCodexDeniedPathQuarantine(
          canonicalExecutionRoot,
          quarantineRoot,
          { reclaimRecoveryLockForPid: job.pid },
        );
        job.output.push(
          `[quarantine] Recovered ${quarantineRoot}; restored protected bytes` +
            ` and removed ${result.violations.length} replacement ` +
            `entr${result.violations.length === 1 ? "y" : "ies"}`,
        );
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.quarantineRecoveryWarning(
          job,
          `${quarantineRoot} recovery failed (${detail}). ` +
            "Inspect this path and recover it before retrying the task",
        );
        return { safeToRestart: false };
      }
    }

    return { safeToRestart: true };
  }

  private completeOperatorStopRecovery(job: DispatchJob): Promise<boolean> {
    const existing = this.operatorStopRecoveryInFlight.get(job.taskId);
    if (existing) return existing;

    const recovery = (async (): Promise<boolean> => {
      if (this.jobs.get(job.taskId) !== job || !job.operatorStopTreeTerminated) return false;
      if (!job.executionRoot) {
        this.quarantineRecoveryWarning(job, "the dispatch execution root is unavailable");
        return false;
      }

      let sharedExecutionRoot = false;
      try {
        sharedExecutionRoot = pathsEqualForDispatch(
          canonicalizePotentialPathSync(job.executionRoot),
          canonicalizePotentialPathSync(this.projectRoot),
        );
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.quarantineRecoveryWarning(
          job,
          `the dispatch execution root could not be canonicalized (${detail})`,
        );
        return false;
      }

      if (sharedExecutionRoot) {
        this.quarantineRecoveryWarning(
          job,
          "the stopped run used the shared project directory; container and protected-path state require explicit manual verification",
        );
        return false;
      }
      if (!this.cleanupDockerForWorktree(job.executionRoot)) {
        this.quarantineRecoveryWarning(
          job,
          "worktree container cleanup was disabled or could not be confirmed",
        );
        return false;
      }

      const quarantineRecovery = await this.recoverStoppedWorktreeQuarantines(
        job,
        job.executionRoot,
      );
      if (!quarantineRecovery.safeToRestart) return false;
      if (job.worktreePath && fs.existsSync(job.worktreePath)) {
        this.captureGitMetadata(job, job.worktreePath);
      }
      if (job.worktreePath && !this.clearWorktreeSurvivor(job, true)) {
        this.quarantineRecoveryWarning(
          job,
          "durable worktree ownership changed before it could be released",
        );
        return false;
      }
      if (!this.clearOperatorStopBarrier(job)) return false;

      if (this.operatorStopCleanupPending.get(job.taskId) === job) {
        this.operatorStopCleanupPending.delete(job.taskId);
      }
      job.operatorStopCleanupPending = false;
      job.output.push("[dispatch] Operator-stop cleanup complete; task may be started again.");
      return true;
    })();
    this.operatorStopRecoveryInFlight.set(job.taskId, recovery);
    const clearRecovery = (): void => {
      if (this.operatorStopRecoveryInFlight.get(job.taskId) === recovery) {
        this.operatorStopRecoveryInFlight.delete(job.taskId);
      }
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }

  private reconcileRunningJobs(): void {
    for (const [taskId, job] of this.jobs) {
      if (job.status !== "running") continue;

      const child = this.processes.get(taskId);
      if (!child && job.stopRequestedAt && this.hasLiveStopProcessGroup(taskId)) {
        continue;
      }
      const childExitCode = child?.exitCode;
      const childSignalCode = child?.signalCode;
      if (childExitCode !== null && childExitCode !== undefined) {
        if (child) this.retainLingeringProcessGroup(taskId, child, job);
        job.exitCode = childExitCode;
        job.status = job.stopRequestedAt
          ? this.hasLiveStopProcessGroup(taskId)
            ? "running"
            : "stopped"
          : childExitCode === 0
            ? "completed"
            : "failed";
        if (job.status !== "completed") {
          this.preserveInterruptedSharedCheckout(
            job,
            job.status === "running" ? "running" : job.stopRequestedAt ? "stopped" : "failed",
          );
        }
        this.clearStopEscalation(taskId);
        this.captureGitMetadata(job, job.worktreePath);
        this.processes.delete(taskId);
        continue;
      }
      if (childSignalCode) {
        if (child) this.retainLingeringProcessGroup(taskId, child, job);
        job.exitCode = job.exitCode ?? 1;
        job.status =
          job.stopRequestedAt && this.hasLiveStopProcessGroup(taskId)
            ? "running"
            : job.stopRequestedAt
              ? "stopped"
              : "failed";
        this.preserveInterruptedSharedCheckout(
          job,
          job.status === "running" ? "running" : job.stopRequestedAt ? "stopped" : "failed",
        );
        job.output.push(
          `[dispatch] Child process exited by signal ${childSignalCode}; marking job failed.`,
        );
        this.captureGitMetadata(job, job.worktreePath);
        this.clearStopEscalation(taskId);
        this.processes.delete(taskId);
        continue;
      }

      const alive = this.processExists(job.pid);
      if (alive === false) {
        if (child) this.retainLingeringProcessGroup(taskId, child, job);
        job.exitCode = job.exitCode ?? 1;
        job.status =
          job.stopRequestedAt && this.hasLiveStopProcessGroup(taskId)
            ? "running"
            : job.stopRequestedAt
              ? "stopped"
              : "failed";
        this.preserveInterruptedSharedCheckout(
          job,
          job.status === "running" ? "running" : job.stopRequestedAt ? "stopped" : "failed",
        );
        job.output.push(
          `[dispatch] Child process pid ${job.pid} is no longer alive; marking job failed and preserving worktree.`,
        );
        this.captureGitMetadata(job, job.worktreePath);
        this.clearStopEscalation(taskId);
        this.processes.delete(taskId);
      }
    }
  }

  /**
   * Start dispatching a task. Returns the job info immediately.
   * Branches between Docker and worktree isolation based on config.
   */
  start(
    taskId: string,
    options?: StartOptions,
    claimantCheck?: DuplicateClaimantCheck,
  ): DispatchJob {
    this.assertDispatchAdmissionOpen();
    if (this.approvalPauseResolutions.has(taskId)) {
      throw new Error(`Cannot start ${taskId}: an approval decision is being persisted.`);
    }
    const sharedRoot = normalizeExecutionRoot(this.projectRoot);
    if (this.operatorStopCleanupPending.has(taskId)) {
      throw new Error(
        `Task ${taskId} is still completing operator-stop cleanup; retry after cleanup finishes.`,
      );
    }
    const sharedCleanup = [...this.operatorStopCleanupPending.values()].find(
      (pendingJob) =>
        pendingJob.executionRoot !== undefined &&
        normalizeExecutionRoot(pendingJob.executionRoot) === sharedRoot,
    );
    if (sharedCleanup) {
      throw new Error(
        `Cannot start ${taskId}: ${sharedCleanup.taskId} still has unconfirmed cleanup in the ` +
          "shared project directory. Resolve its preserved quarantine/process evidence first.",
      );
    }
    this.assertNoDurableOperatorStopBarrier(taskId);
    // Prevent double-dispatch
    const existing = this.getActiveJob(taskId);
    let deleteAwaitingApproval = false;
    if (existing) {
      // Allow resume of tasks awaiting judge approval — the worktree has
      // agent commits that must be preserved for the post-judge session.
      if (
        existing.status === "awaiting_approval" &&
        (options?.resume || options?.replaceArchivedJudgeRun || options?.overridePausedRun)
      ) {
        deleteAwaitingApproval = true;
      } else if (existing.status === "awaiting_approval") {
        // QPI-045 addendum: this covers BOTH gates (blueprint pend since
        // QPI-041 widened the pause detection), so the message must not
        // claim "judge" — that mislabel sent an operator hunting the
        // wrong gate during the TASK-1273 recycle.
        throw new Error(
          `Task ${taskId} is awaiting human approval at a gate. ` +
            `Approve or reject via the dashboard, or stop the task first.`,
        );
      } else {
        throw new Error(`Task ${taskId} is already running (pid ${existing.pid})`);
      }
    }

    // Block parallel dispatch when worktree isolation is degraded.
    // Without worktrees, all tasks share the same git directory — parallel
    // dispatches would race on branch checkouts and contaminate each other.
    if (this.worktreeDegraded) {
      this.assertSharedCheckoutAvailable(
        taskId,
        deleteAwaitingApproval || options?.resume === true || options?.overridePausedRun === true,
      );
    }

    // ── TASK-1326 (QPI-042): the DURABLE half of the pause guard ──────
    // The in-memory check above is the same protection read from
    // `this.jobs`, and a monitor restart empties that map (QPI-047) —
    // the very restart that makes the queue look dead and invites the
    // re-POST. This check reads the approval records from DISK, and it
    // MUST stay ahead of startWorktree/startDocker: createWorktree()
    // removes the worktree and force-deletes the task branch, so by the
    // time the child dispatcher could object, the paused judge-gate
    // run's committed work is already gone.
    // Round-2 F1: `resume` does NOT bypass. Every legitimate resume
    // flow decides the pend FIRST — blueprint/judge approve set the
    // state, reject and loop-revise delete the record, replan rejects it
    // — so by the time they call start() there is no pending record and
    // this check is a no-op for them. A generic `/resume` or
    // `quack run --resume` against a STILL-PENDING gate is not those
    // flows: it is the clobber, wearing resume's clothes, and it can
    // reach createWorktree() (and its `branch -D`) whenever the worktree
    // is gone. Only the explicit override proceeds.
    const pausedRuntime = this.resolvePausedRuntime(taskId);
    const paused = pausedRuntime?.paused;
    const pausedDockerBinding =
      pausedRuntime &&
      this.isSafeDockerRuntimeLogTree(pausedRuntime.logDir) &&
      path.resolve(pausedRuntime.logDir) !== path.resolve(this.logDir)
        ? inspectValidatedDockerPendingArchive(pausedRuntime.logDir, taskId)
        : undefined;
    if (paused && !options?.overridePausedRun) {
      throw new PausedRunRefusalError(taskId, paused);
    }

    // Claimant admission is still side-effect free, so preserve its established
    // precedence ahead of restart-recovery checks. The active/degraded/paused
    // guards above remain authoritative, while a contested resume cannot be
    // misreported as a Windows tree-recovery problem.
    assertUncontestedClaimant(claimantCheck ?? options?.duplicateClaimantCheck);

    const durableSharedPause =
      this.isolationConfig?.method === "docker"
        ? undefined
        : this.ensureSharedCheckoutRecoveryMetadata();
    const priorJob = this.jobs.get(taskId);
    if (durableSharedPause && this.durableSharedOwnerMayBeLive(durableSharedPause)) {
      throw new DegradedSharedCheckoutBusyError(taskId, [
        {
          taskId: durableSharedPause.taskId,
          status: durableSharedPause.status ?? "awaiting_approval",
        },
      ]);
    }
    const durableSharedStatus =
      durableSharedPause?.status === "running"
        ? "stopped"
        : (durableSharedPause?.status ?? "awaiting_approval");
    const inMemorySharedRecovery =
      this.isolationConfig?.method !== "docker" &&
      priorJob !== undefined &&
      priorJob.worktreePath === undefined &&
      priorJob.status !== "completed";
    const windowsSharedTreeConfirmed =
      (priorJob !== undefined && this.hasConfirmedWindowsTreeKill(priorJob)) ||
      durableSharedPause?.processTreeStatus === "confirmed-stopped";
    if (process.platform === "win32" && inMemorySharedRecovery && !windowsSharedTreeConfirmed) {
      throw new DegradedSharedCheckoutBusyError(taskId, [
        { taskId, status: priorJob?.status ?? "stopped" },
      ]);
    }
    const recoverSharedCheckout =
      durableSharedPause?.taskId === taskId ||
      (deleteAwaitingApproval && existing?.worktreePath === undefined) ||
      inMemorySharedRecovery;
    const sharedCheckoutBaseline: SharedCheckoutBaseline | undefined = recoverSharedCheckout
      ? {
          originalBranch:
            durableSharedPause?.taskId === taskId
              ? durableSharedPause.originalBranch
              : priorJob?.sharedCheckoutOriginalBranch,
          originalStatus:
            durableSharedPause?.taskId === taskId
              ? durableSharedPause.originalStatus
              : priorJob?.sharedCheckoutOriginalStatus,
        }
      : undefined;
    if (recoverSharedCheckout && options?.resume !== true && options?.overridePausedRun !== true) {
      throw new DegradedSharedCheckoutBusyError(taskId, [{ taskId, status: durableSharedStatus }]);
    }

    assertUncontestedClaimant(claimantCheck ?? options?.duplicateClaimantCheck);

    if (paused) {
      // Fail-closed by design: archivePausedRunState throws rather
      // than let an override proceed over unarchived state.
      const archived = archivePausedRunState(
        this.projectRoot,
        pausedRuntime?.logDir ?? this.logDir,
        taskId,
        paused,
      );
      this.onEvent?.("paused_run_archived", taskId, {
        taskId,
        gate: paused.gate,
        pendOpenedAt: paused.createdAt,
        ...archived,
      });
      console.log(
        `[dispatch] ${taskId}: operator override of a ${paused.gate}-gate pause; archived ` +
          [archived.branchRef, archived.checkpointPath, archived.approvalPath]
            .filter(Boolean)
            .join(", "),
      );
      if (pausedDockerBinding && !this.clearDockerPausePointer(taskId, pausedDockerBinding)) {
        throw new Error(
          `Docker pause for ${taskId} was archived, but its exact ownership pointer could not be released`,
        );
      }
      if (pausedDockerBinding && !this.dockerManager?.releaseSealedResumeRef(pausedDockerBinding)) {
        console.warn(
          `[dispatch] ${taskId}: archived pause retained its hidden Docker recovery ref`,
        );
      }
    }

    const publicationRecovery =
      this.isolationConfig?.method === "docker"
        ? findDockerPublicationRecovery(this.dockerPublicationRecoveryRoot(), taskId)
        : undefined;
    if (publicationRecovery) {
      if (options?.resume !== true) {
        throw new Error(
          `Task ${taskId} has an incomplete Docker host publication. Resume it before starting a new run.`,
        );
      }
      return this.startDockerPublicationRecovery(
        taskId,
        publicationRecovery.path,
        publicationRecovery.journal,
        options,
      );
    }

    // Release the in-memory guard only after the durable pause state has
    // either been decided by a legitimate resume/recycle flow or archived by
    // an explicit override. In particular, an archive failure must leave the
    // awaiting_approval job visible and its worktree protected.
    if (deleteAwaitingApproval) {
      this.jobs.delete(taskId);
    }

    // TASK-1323: no dispatch proceeds without provenance. Callers stamp
    // the real channel; this fallback only marks a path that forgot.
    const selectedDockerRuntime =
      options?.resume && this.isolationConfig?.method === "docker"
        ? (options.dockerResumeStateDir ?? this.resolveDockerResumeRuntime(taskId))
        : undefined;
    const selectedDockerBinding = selectedDockerRuntime
      ? this.assertDockerResumeSelection(taskId, selectedDockerRuntime)
      : undefined;
    if (
      selectedDockerBinding &&
      ((options?.parentTaskId !== undefined &&
        options.parentTaskId !== selectedDockerBinding.parentTaskId) ||
        (options?.sharedBranchName !== undefined &&
          options.sharedBranchName !== selectedDockerBinding.sharedBranchName))
    ) {
      throw new Error(`Cannot resume Docker dispatch ${taskId}: decomposition identity changed.`);
    }
    const effectiveOptions: StartOptions = {
      ...(options ?? {}),
      ...(selectedDockerRuntime ? { dockerResumeStateDir: selectedDockerRuntime } : {}),
      ...(selectedDockerBinding?.parentTaskId
        ? { parentTaskId: selectedDockerBinding.parentTaskId }
        : {}),
      ...(selectedDockerBinding?.sharedBranchName
        ? { sharedBranchName: selectedDockerBinding.sharedBranchName }
        : {}),
      provenance: options?.provenance ?? {
        channel: "api-direct",
        principal: "unattributed-local-start",
      },
    };

    if (this.isolationConfig?.method === "docker" && this.dockerManager && !recoverSharedCheckout) {
      return this.startDocker(taskId, effectiveOptions);
    }
    return this.startWorktree(
      taskId,
      effectiveOptions,
      recoverSharedCheckout,
      sharedCheckoutBaseline,
    );
  }

  /**
   * Start a task dispatch using git worktree isolation.
   * Falls back to the shared working directory only for adapters that
   * explicitly disable worktree initialization.
   */
  private startWorktree(
    taskId: string,
    options?: StartOptions,
    recoverSharedCheckout = false,
    sharedCheckoutBaseline?: SharedCheckoutBaseline,
  ): DispatchJob {
    try {
      return this.startWorktreeInternal(
        taskId,
        options,
        recoverSharedCheckout,
        sharedCheckoutBaseline,
      );
    } catch (error) {
      const pending = this.pendingWorktreeOwnerships.get(taskId);
      if (pending) {
        const child = this.processes.get(taskId);
        const job = this.jobs.get(taskId);
        if (child && job) {
          this.updateWorktreeOwnership(job, "stopping", child.pid ?? job.pid);
          try {
            this.signalProcessTree(taskId, child, "SIGKILL", 1_000);
          } catch {
            // The durable marker remains the recovery barrier.
          }
        } else {
          this.clearWorktreeSurvivor(
            {
              taskId,
              sessionId: pending.sessionId,
              worktreeOwnershipId: pending.ownershipId,
              worktreePath: pending.worktreePath,
              pid: 0,
              startedAt: pending.recordedAt,
              status: "failed",
              output: [],
            },
            true,
          );
        }
        this.pendingWorktreeOwnerships.delete(taskId);
      }
      throw error;
    }
  }

  private startWorktreeInternal(
    taskId: string,
    options?: StartOptions,
    recoverSharedCheckout = false,
    sharedCheckoutBaseline?: SharedCheckoutBaseline,
  ): DispatchJob {
    this.assertDispatchAdmissionOpen();
    const sessionId = `quack-${taskId}-${randomUUID()}`;
    // Validate the derived task branch even when an existing worktree is
    // reused. Reuse/resume must never turn a protected branch into task state.
    this.readWorktreeGitConfiguration(taskId);
    const expectedWorktreePath = path.join(this.projectRoot, ".quack", "worktrees", taskId);
    // Run this before both fresh creation and reuse/resume. The latter does
    // not call createWorktree() when the directory already exists, and a
    // restarted monitor has no in-memory stop barrier to protect it.
    this.assertNoOrphanedQuarantineBeforeWorktreeMutation(taskId, this.projectRoot);
    this.assertNoOrphanedQuarantineBeforeWorktreeMutation(taskId, expectedWorktreePath);
    let worktreeOwnership = recoverSharedCheckout
      ? undefined
      : this.acquireWorktreeOwnership(taskId, sessionId, expectedWorktreePath);
    if (worktreeOwnership) this.pendingWorktreeOwnerships.set(taskId, worktreeOwnership);

    // Reuse existing worktree for revision or resume dispatches
    // (preserves prior branch + committed changes from stalled runs)
    let worktreePath: string | undefined;
    let freshIsolatedWorktree = false;
    const shouldReuse = options?.reuseWorktree || options?.resume;
    if (recoverSharedCheckout) {
      worktreePath = undefined;
    } else if (shouldReuse) {
      const existing = expectedWorktreePath;
      if (fs.existsSync(existing)) {
        this.assertWorktreeHasNoLiveSurvivor(taskId, existing, worktreeOwnership?.ownershipId);
        // Verify the worktree has commits from the prior run
        try {
          const commits = runTrustedGitSync(["log", "--oneline", "-10"], existing, {
            timeoutMs: 5_000,
            trustedBoundaryRoot: this.projectRoot,
          }).trim();
          const count = commits ? commits.split("\n").length : 0;
          console.log(
            `[dispatch] Reusing existing worktree for ${taskId} (${count} commits found)`,
          );
        } catch {
          console.log(`[dispatch] Reusing existing worktree for ${taskId} (commit check skipped)`);
        }
        worktreePath = existing;
      } else {
        worktreePath = this.createWorktree(taskId, {
          preserveTaskBranch: true,
          ownershipId: worktreeOwnership?.ownershipId,
        });
      }
    } else {
      worktreePath = this.createWorktree(taskId, {
        ownershipId: worktreeOwnership?.ownershipId,
      });
      freshIsolatedWorktree = worktreePath !== undefined;
    }
    if (!worktreePath && this.worktreeInitializationActive()) {
      throw new Error(
        `Cannot dispatch ${taskId}: worktree isolation failed and dependency initialization ` +
          "is active; refusing to run initialization in the shared project checkout. " +
          "Repair worktree creation or explicitly set dispatch.worktreeInit to [] to opt out.",
      );
    }

    // A monitor restart loses process-local jobs and the degraded flag. If
    // worktree creation now fails again, re-check durable shared-checkout
    // ownership before a child can enter projectRoot and touch its branch or
    // dirty files.
    if (!worktreePath) {
      if (worktreeOwnership) {
        this.clearWorktreeSurvivor(
          {
            taskId,
            sessionId,
            worktreeOwnershipId: worktreeOwnership.ownershipId,
            worktreePath: worktreeOwnership.worktreePath,
            pid: 0,
            startedAt: worktreeOwnership.recordedAt,
            status: "failed",
            output: [],
          },
          true,
        );
        this.pendingWorktreeOwnerships.delete(taskId);
        worktreeOwnership = undefined;
      }
      this.assertSharedCheckoutAvailable(
        taskId,
        options?.resume === true || options?.overridePausedRun === true,
      );
    }
    const workDir = worktreePath ?? this.projectRoot;
    const adapterFreshness = worktreePath
      ? this.ensureWorktreeAdapterFreshness(worktreePath)
      : undefined;
    if (adapterFreshness?.status === "stale") {
      throw new Error(
        `Blocked ${taskId}: stale worktree adapter bundle ` +
          `(local ${shortHash(adapterFreshness.localHash)}, authoritative ${shortHash(adapterFreshness.authoritativeHash)})`,
      );
    }

    // A first degraded run records its pristine checkout baseline. Recovery
    // must reuse that durable baseline rather than treating the task branch
    // left by the interrupted run as the branch to restore.
    let originalBranch = sharedCheckoutBaseline?.originalBranch;
    let originalStatus = sharedCheckoutBaseline?.originalStatus;
    if (!worktreePath) {
      if (!recoverSharedCheckout) {
        originalBranch = this.gitOutput(this.projectRoot, ["branch", "--show-current"]);
        originalStatus = this.gitOutput(this.projectRoot, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]);
      }
      const isGitCheckout =
        fs.existsSync(path.join(this.projectRoot, ".git")) ||
        this.gitOutput(this.projectRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
      if (isGitCheckout && (!originalBranch || originalStatus === undefined)) {
        throw new Error(
          `Cannot dispatch ${taskId} in the shared checkout because its Git restoration baseline could not be verified. Repair worktree isolation before retrying.`,
        );
      }
      if (originalStatus !== undefined && originalStatus.length > 0) {
        throw new Error(
          `Cannot dispatch ${taskId} in the shared checkout because it was already dirty. Restore a clean checkout or repair worktree isolation before retrying.`,
        );
      }
    }

    const args = ["run", taskId, "--project", workDir];

    if (options?.skipGate) args.push("--skip-gate");
    if (options?.skipDepthOnly) args.push("--skip-depth-only");
    if (options?.resume) args.push("--resume");
    if (options?.forceClean) args.push("--force-clean");
    // TASK-1326: the override decision was made HERE, at the seam that
    // archived the prior run. The child must inherit it or the
    // dispatcher-side guard would refuse the very dispatch the operator
    // just authorized.
    if (options?.overridePausedRun) args.push("--override-paused-run");
    if (options?.model) args.push("--model", options.model);
    if (options?.maxTurns) args.push("--max-turns", String(options.maxTurns));
    if (options?.maxBudget) args.push("--max-budget", String(options.maxBudget));

    // Write judge feedback to a temp file if provided (for force-retry)
    const childEnv: Record<string, string> = {
      [WORKTREE_INIT_FRESH_ENV]: freshIsolatedWorktree ? "1" : "0",
    };
    let decompositionAdmission: CreatedDecompositionDispatchAdmission | undefined;
    if (this.trustedLocalReadRemotePaths?.length) {
      // loadAdapter deliberately scopes operator authorization to one exact
      // project root. A managed worktree is a distinct canonical root, so the
      // child must receive a freshly bound envelope instead of inheriting the
      // parent-root envelope (which correctly fails its exact-root check).
      // The paths originated outside the repository and were already accepted
      // by the trusted fetch that created this worktree.
      childEnv[TRUSTED_LOCAL_READ_REMOTES_ENV] = JSON.stringify({
        projectRoot: fs.realpathSync(workDir),
        paths: [...this.trustedLocalReadRemotePaths],
      });
    }
    if (options?.judgeFeedback) {
      const feedbackDir = path.join(workDir, ".quack", "logs");
      fs.mkdirSync(feedbackDir, { recursive: true });
      const feedbackPath = path.join(feedbackDir, `retry-feedback-${taskId}.md`);
      fs.writeFileSync(feedbackPath, options.judgeFeedback, "utf-8");
      childEnv.QUACK_RETRY_FEEDBACK = feedbackPath;
    }
    if (options?.federatedJobId) childEnv.QUACK_FEDERATED_JOB_ID = options.federatedJobId;
    if (options?.federatedHostId) childEnv.QUACK_FEDERATED_HOST_ID = options.federatedHostId;
    if (options?.federatedHostAlias)
      childEnv.QUACK_FEDERATED_HOST_ALIAS = options.federatedHostAlias;
    if (options?.federatedHostEndpoint)
      childEnv.QUACK_FEDERATED_HOST_ENDPOINT = options.federatedHostEndpoint;
    if (options?.federatedLeaseId) childEnv.QUACK_FEDERATED_LEASE_ID = options.federatedLeaseId;
    if (options?.provenance) childEnv.QUACK_PROVENANCE = JSON.stringify(options.provenance);

    // The configured KeyManager is the authority for explicit API selection.
    const selectedClaudeKey = this.keyManager ? selectClaudeApiKey(this.keyManager) : undefined;
    if (selectedClaudeKey) childEnv.QUACK_SELECTED_KEY_ID = selectedClaudeKey.keyId;

    // Track which key was selected for this dispatch (for rate limit handling + per-key cost)
    const selectedKeyId = childEnv.QUACK_SELECTED_KEY_ID;
    const startedAt = new Date().toISOString();
    const job: DispatchJob = {
      taskId,
      sessionId,
      pid: 0,
      startedAt,
      status: "running",
      output: [],
      worktreePath,
      executionRoot: workDir,
      keyId: selectedKeyId,
      sharedCheckoutOriginalBranch: originalBranch,
      sharedCheckoutOriginalStatus: originalStatus,
      worktreeOwnershipId: worktreeOwnership?.ownershipId,
      federatedJobId: options?.federatedJobId,
      federatedHostId: options?.federatedHostId,
      federatedHostAlias: options?.federatedHostAlias,
      federatedHostEndpoint: options?.federatedHostEndpoint,
      federatedLeaseId: options?.federatedLeaseId,
      provenance: options?.provenance,
    };
    // A hard monitor/process loss has no exit callback. Record shared-checkout
    // ownership before spawning so a new monitor cannot mistake a potentially
    // dirty in-flight checkout for a free fallback directory.
    if (!worktreePath) {
      // Admission already consumed any prior session's recovery evidence.
      // Clear it before writing the new ownership generation so a same-
      // millisecond session ID collision cannot mark the new tree confirmed.
      if (process.platform === "win32") this.confirmedWindowsTreeKills.delete(taskId);
      this.persistSharedCheckoutPause(job, "running", recoverSharedCheckout);
    }

    let launch: TrustedNodeLaunch;
    try {
      // A task-level PID confirmation belongs to an older session. Clear it
      // before every new child, including isolated worktrees.
      if (process.platform === "win32") this.confirmedWindowsTreeKills.delete(taskId);
      if (options?.admittedTaskContentHash) {
        decompositionAdmission = createDecompositionDispatchAdmissionMarker({
          projectRoot: workDir,
          taskId,
          contentHash: options.admittedTaskContentHash,
        });
        Object.assign(childEnv, decompositionAdmission.environment);
      }
      launch = spawnTrustedNode({
        projectRoot: this.projectRoot,
        scriptPath: this.quackBin,
        args,
        cwd: workDir,
        env: buildClaudeChildEnvironment(
          {
            ...dispatchChildEnvironment(),
            [TRUSTED_LOCAL_READ_REMOTES_ENV]: undefined,
            // Clear CLAUDECODE env var so the Agent SDK doesn't detect nesting
            CLAUDECODE: undefined,
            CLAUDE_CODE: undefined,
            // This capability is injected only for a Docker child. Never let an
            // inherited parent value redirect ordinary worktree control files.
            QUACK_DOCKER_RUNTIME_LOG_DIR: undefined,
            QUACK_DOCKER_EVENT_SESSION_ID: undefined,
            QUACK_DOCKER_HOST_PROMOTION: undefined,
            QUACK_DOCKER_ADMITTED_BRANCH: undefined,
            QUACK_DOCKER_PARENT_TASK_ID: undefined,
            QUACK_DOCKER_SHARED_BRANCH: undefined,
            ...childEnv,
            // Host-generated identity, never inherited from the parent or task.
            QUACK_MONITOR_EVENT_SESSION_ID: sessionId,
          },
          selectedClaudeKey,
          true,
        ),
      });
    } catch (error) {
      if (!worktreePath) {
        this.persistSharedCheckoutPause(job, "failed");
      }
      if (decompositionAdmission) {
        try {
          revokeDecompositionDispatchAdmission(workDir, decompositionAdmission);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Dispatch launch and decomposition admission revocation both failed for ${taskId}.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    const child = launch.child;
    this.trackChildClose(child, job);
    job.pid = launch.processId;
    this.jobs.set(taskId, job);
    this.processes.set(taskId, child);
    this.nodeLaunches.set(taskId, launch);
    if (worktreePath) {
      if (!this.updateWorktreeOwnership(job, "running", job.pid)) {
        throw new Error(
          `Cannot start ${taskId}: durable worktree ownership changed before child registration`,
        );
      }
      this.pendingWorktreeOwnerships.delete(taskId);
    }
    if (!worktreePath) {
      try {
        this.persistSharedCheckoutPause(job, "running");
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        job.output.push(
          `[dispatch] Could not add process identity to shared-checkout ownership (${detail}); ` +
            `restart recovery will remain fail-closed.`,
        );
      }
    }
    if (adapterFreshness) {
      job.output.push(
        `[adapter-freshness] ${adapterFreshness.status}` +
          ` local=${shortHash(adapterFreshness.localHash)} authoritative=${shortHash(adapterFreshness.authoritativeHash)}` +
          (adapterFreshness.reason ? ` (${adapterFreshness.reason})` : ""),
      );
    }

    let admissionRevocationBarrierPersisted = false;
    const revokeUnconsumedAdmission = (): void => {
      if (!decompositionAdmission) return;
      try {
        revokeDecompositionDispatchAdmission(workDir, decompositionAdmission);
        decompositionAdmission = undefined;
        if (admissionRevocationBarrierPersisted && this.clearOperatorStopBarrier(job)) {
          this.operatorStopCleanupPending.delete(taskId);
          job.operatorStopCleanupPending = false;
          job.operatorStopRequestedAt = undefined;
          admissionRevocationBarrierPersisted = false;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        job.output.push(
          `[dispatch] Unconsumed decomposition admission could not be revoked (${detail}); ` +
            "same-task restart remains blocked.",
        );
        job.operatorStopRequestedAt ??= new Date().toISOString();
        job.operatorStopCleanupPending = true;
        this.operatorStopCleanupPending.set(taskId, job);
        admissionRevocationBarrierPersisted =
          admissionRevocationBarrierPersisted || this.persistOperatorStopBarrier(job);
      }
    };

    this.captureProcessOutput(child, job);

    child.on("exit", (code, signal) => {
      const exitHandler = (async () => {
        revokeUnconsumedAdmission();
        const operatorStopRequested = Boolean(job.operatorStopRequestedAt);
        let stopRequested = operatorStopRequested || this.shutdownInProgress;
        const lingeringTree = this.retainLingeringProcessGroup(taskId, child, job);
        if (lingeringTree) stopRequested = true;
        this.clearStopEscalation(taskId);
        if (!operatorStopRequested) {
          job.exitCode = code ?? 1;
        }
        // QPI-043: the SIGNAL was being discarded. Node delivers
        // `(code, signal)`, and a process killed by a signal arrives as
        // `code: null, signal: "SIGKILL"`, so `code ?? 1` recorded a
        // SIGKILLed child as a plain exit-1 failure. A child killed from
        // OUTSIDE (the OOM killer, an operator, a supervisor) was
        // therefore indistinguishable from one that failed on its own,
        // and it wrote no stderr because it never ran another line.
        //
        // That is precisely the shape that made TASK-1273 round 2 look
        // like it vanished for no reason. Recording the signal does not
        // prevent the kill; it makes the difference between "it crashed"
        // and "something killed it" READABLE, which is the whole reason
        // that investigation cost two lanes an evening.
        // The exit facts must land ON DISK, not just in process memory.
        //
        // Round 3 proved the in-memory job is not enough: `this.jobs` is
        // a Map, so a monitor restart or a fresh dispatch for the same
        // task erases the record. Round 4 then proved the lifecycle
        // callback is not enough either: every server wiring site is a
        // bare sse.broadcast, so an event routed through `this.onEvent`
        // reaches connected dashboards and NOTHING else — the "durable"
        // event never touched disk, which is why run 4 produced zero
        // exit evidence. The write now goes through the session event
        // writer into the child session's own events jsonl; the callback
        // is only the fallback when that write fails.
        let exitFactsDurable = false;
        try {
          appendDispatchChildExit({
            logDir: this.logDir,
            taskId,
            jobSessionId: sessionId,
            exactSession: true,
            jobStartedAt: job.startedAt,
            exitCode: code,
            signal: signal ?? null,
            worktreePath: worktreePath ?? null,
            operatorRequested: operatorStopRequested,
          });
          exitFactsDurable = true;
        } catch {
          // Instrumentation must never take down the exit handler — an
          // uncaught throw here would kill the monitor via the
          // process-level uncaughtException handler.
        }
        if (!exitFactsDurable) {
          this.onEvent?.("dispatch_child_exit", taskId, {
            exitCode: code,
            signal: signal ?? null,
            killed: Boolean(signal),
            worktreePath: worktreePath ?? null,
            operatorRequested: operatorStopRequested,
            at: new Date().toISOString(),
          });
        }

        if (signal) {
          job.killedBySignal = signal;
        }
        if (this.processes.get(taskId) === child) {
          this.processes.delete(taskId);
        }
        if (this.nodeLaunches.get(taskId) === launch) {
          this.nodeLaunches.delete(taskId);
          cleanupTrustedNodeLaunch(launch);
        }

        // stop() records intent before sending SIGTERM. Keep that terminal
        // state authoritative when Node delivers the later exit callback;
        // this is an expected operator action, not a crash or an OOM signal.
        if (operatorStopRequested) {
          job.status = "stopped";
          job.output.push(
            `[dispatch] Operator-requested stop confirmed${signal ? ` (${signal})` : ""}.`,
          );
          if (
            !job.operatorStopTreeTerminated &&
            process.platform !== "win32" &&
            job.operatorStopProcessGroupId !== undefined &&
            this.posixProcessGroupIsAbsent(job.operatorStopProcessGroupId)
          ) {
            job.operatorStopTreeTerminated = true;
          }
          // The admission barrier below normally prevents a replacement here.
          // Keep this identity check as defense in depth against direct state
          // mutation or a future alternate start path.
          if (this.jobs.get(taskId) === job) {
            if (!job.operatorStopTreeTerminated) {
              this.quarantineRecoveryWarning(
                job,
                "dispatch process-tree termination could not be confirmed",
              );
            } else {
              await this.completeOperatorStopRecovery(job);
            }
          }
          return;
        }

        if (signal) {
          job.output.push(
            `[dispatch] Child terminated by signal ${signal} (not a self-exit). ` +
              `If this is SIGKILL with no other output, suspect the OOM killer: ` +
              `check \`dmesg -T | grep -i "killed process"\` around ${new Date().toISOString()}.`,
          );
        }

        // Detect a pending human gate: the subprocess exits non-zero when
        // it pauses for approval. Keep the job alive so the
        // double-dispatch guard blocks fresh dispatches and the worktree
        // (with agent commits) is preserved for the resume.
        //
        // QPI-041: this now covers the BLUEPRINT gate as well as the judge
        // gate. A signal-killed child is never a pause, so it is excluded.
        if (
          !stopRequested &&
          code !== 0 &&
          !signal &&
          this.isApprovalPending(taskId, job.startedAt)
        ) {
          if (!worktreePath) {
            try {
              this.persistSharedCheckoutPause(job);
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              job.output.push(
                `[dispatch] Could not persist shared-checkout pause ownership (${detail}); ` +
                  `this monitor will continue blocking admission while it remains online.`,
              );
            }
          }
          job.status = "awaiting_approval";
          job.output.push(
            `[dispatch] Task awaiting human approval — worktree preserved at ${worktreePath ?? "shared directory"}`,
          );
          if (worktreePath && !this.clearWorktreeSurvivor(job)) {
            job.output.push(
              "[dispatch] Worktree process-tree absence is unconfirmed; durable ownership remains blocked.",
            );
          }
          return;
        }

        this.classifySpecStaleExit(job, taskId, code, signal);

        job.status = stopRequested
          ? this.hasLiveStopProcessGroup(taskId)
            ? "running"
            : "stopped"
          : code === 0
            ? "completed"
            : "failed";
        this.captureGitMetadata(job, worktreePath);

        // Detect rate limit errors and trigger key rotation + re-dispatch
        if (
          !stopRequested &&
          code !== 0 &&
          this.keyManager &&
          selectedKeyId &&
          isRateLimitError(code, job.output)
        ) {
          const retryAfterMs = parseRetryAfter(job.output);
          this.keyManager.markRateLimited(selectedKeyId, retryAfterMs);
          job.output.push(
            `[key-rotation] Key ${selectedKeyId} rate-limited, cooldown ${retryAfterMs ?? this.keyManager.getCooldownMs()}ms`,
          );

          // Attempt re-dispatch with a different key if available
          if (this.keyManager.hasAvailableKeys()) {
            this.rateLimitRetryPending.add(taskId);
            try {
              const claimantCheck = this.claimantResolver
                ? await this.claimantResolver(taskId)
                : undefined;
              if (
                this.shutdownInProgress ||
                job.stopRequestedAt ||
                job.operatorStopRequestedAt ||
                this.jobs.get(taskId) !== job
              ) {
                job.status = "stopped";
                job.output.push(
                  "[key-rotation] Re-dispatch cancelled because shutdown is in progress; worktree preserved.",
                );
                this.jobs.set(taskId, job);
                return;
              }
              assertUncontestedClaimant(claimantCheck);
              job.output.push(`[key-rotation] Re-dispatching ${taskId} with next available key`);
              if (worktreePath) {
                if (!this.removeWorktree(worktreePath)) {
                  job.output.push(
                    `[worktree] Re-dispatch refused because cleanup could not be confirmed; preserved ${worktreePath}`,
                  );
                  job.status = "failed";
                  this.jobs.set(taskId, job);
                  return;
                }
              }
              if (
                this.shutdownInProgress ||
                job.stopRequestedAt ||
                job.operatorStopRequestedAt ||
                this.jobs.get(taskId) !== job
              ) {
                job.status = "stopped";
                job.output.push(
                  "[key-rotation] Re-dispatch cancelled because shutdown is in progress; worktree preserved.",
                );
                this.jobs.set(taskId, job);
                return;
              }
              const replacement = await this.restartWithFreshDecompositionAdmission(
                taskId,
                (admission) => {
                  if (
                    this.shutdownInProgress ||
                    job.stopRequestedAt ||
                    job.operatorStopRequestedAt ||
                    this.jobs.get(taskId) !== job ||
                    !this.rateLimitRetryPending.has(taskId)
                  ) {
                    throw new Error("Rate-limit re-dispatch was cancelled before admission.");
                  }
                  this.rateLimitRetryPending.delete(taskId);
                  this.jobs.delete(taskId);
                  return this.start(
                    taskId,
                    {
                      ...options,
                      duplicateClaimantCheck: claimantCheck,
                      admittedTaskContentHash: admission.contentHash,
                    },
                    claimantCheck,
                  );
                },
              );
              this.recordAuthRetryReplacement(job, replacement);
            } catch (err) {
              if (this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt) {
                job.status = "stopped";
                if (!job.output.some((line) => line.includes("Re-dispatch cancelled"))) {
                  job.output.push(
                    "[key-rotation] Re-dispatch cancelled because shutdown is in progress; worktree preserved.",
                  );
                }
                this.jobs.set(taskId, job);
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              job.output.push(`[key-rotation] Re-dispatch failed: ${msg}`);
              job.status = "failed";
              this.jobs.set(taskId, job);
            } finally {
              this.rateLimitRetryPending.delete(taskId);
            }
            return; // Skip normal cleanup — re-dispatch handles it
          } else {
            job.output.push("[key-rotation] No available keys for re-dispatch");
          }
        }

        if (!worktreePath && job.status !== "completed") {
          this.preserveInterruptedSharedCheckout(
            job,
            job.status === "running" ? "running" : stopRequested ? "stopped" : "failed",
          );
        }

        if (worktreePath) {
          const ownershipReleased = this.clearWorktreeSurvivor(job);
          if (!ownershipReleased) {
            job.output.push(
              "[dispatch] Worktree process-tree absence is unconfirmed; preserving the worktree and durable ownership evidence.",
            );
          }
          // After successful dispatch with auto-merge, the target branch
          // may have new commits from the squash merge. If the main working
          // directory has that branch checked out, its index is stale —
          // new files exist in git history but not on disk (Pattern 17).
          // Refresh the main working tree to match HEAD.
          if (code === 0 && !stopRequested && ownershipReleased) {
            const sharedOccupants = this.getSharedCheckoutOccupants();
            if (sharedOccupants.length === 0) {
              this.refreshMainWorkingTree();
            } else {
              job.output.push(
                `[worktree] Skipped main checkout refresh while shared checkout is owned by ` +
                  sharedOccupants
                    .map((occupant) => `${occupant.taskId} (${occupant.status})`)
                    .join(", ") +
                  ".",
              );
            }
            // Only clean up worktree on success — on failure, preserve the
            // worktree and branch so work is recoverable for manual merge
            // or /fix-task. Lost branches on auto-merge failure is a data
            // loss bug (discovered 2026-03-29).
            if (!this.removeWorktree(worktreePath)) {
              job.output.push(
                `[worktree] Preserved ${worktreePath} because Docker cleanup could not be confirmed`,
              );
            }
          } else {
            this.cleanupDockerForWorktree(worktreePath);
            job.output.push(
              `[worktree] Preserved ${worktreePath} — ${stopRequested ? "stop requested" : "dispatch failed"}, branch retained for recovery`,
            );
          }
        } else if (code === 0 && !stopRequested) {
          if (process.platform === "win32" && !this.hasConfirmedWindowsTreeKill(job)) {
            job.output.push(
              "[dispatch] Shared-checkout root exited, but descendant termination is unconfirmed on Windows; ownership remains blocked pending reconciliation.",
            );
            this.preserveInterruptedSharedCheckout(job, "stopped", exitFactsDurable && !signal);
          } else if (!this.restoreAndReleaseSharedCheckout(job)) {
            job.status = "failed";
            this.preserveInterruptedSharedCheckout(job, "failed");
          }
        }
      })()
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (job.operatorStopRequestedAt) {
            job.status = "stopped";
            job.output.push(`[exit-handler] Operator-stop cleanup warning: ${message}`);
          } else {
            job.status = "failed";
            job.output.push(`[exit-handler] ${message}`);
          }
          if (this.jobs.get(taskId) === job) {
            this.jobs.set(taskId, job);
          }
        })
        .finally(() => {
          // completeOperatorStopRecovery owns barrier and admission cleanup.
        });
      this.trackExitHandler(exitHandler, job);
    });

    child.on("error", (err) => {
      revokeUnconsumedAdmission();
      if (job.operatorStopRequestedAt) {
        job.status = "stopped";
        job.output.push(`[dispatch] Operator-requested stop observed child error: ${err.message}`);
        if (this.processes.get(taskId) === child) {
          this.processes.delete(taskId);
        }
        if (this.nodeLaunches.get(taskId) === launch) {
          this.nodeLaunches.delete(taskId);
          cleanupTrustedNodeLaunch(launch);
        }
        return;
      }
      job.status = "failed";
      job.output.push(`[error] ${err.message}`);
      if (this.processes.get(taskId) === child) {
        this.processes.delete(taskId);
      }
      if (this.nodeLaunches.get(taskId) === launch) {
        this.nodeLaunches.delete(taskId);
        cleanupTrustedNodeLaunch(launch);
      }

      // ChildProcess can emit `error` when a signal could not be delivered,
      // not only when spawn failed. An error therefore is not proof that a
      // child with a PID has exited. Keep it tracked and keep the checkout
      // occupied until an exit event or the lifecycle reconciler proves it is
      // gone.
      const started = child.pid !== undefined;
      const exitConfirmed =
        !started ||
        (child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined) ||
        this.processExists(child.pid) === false;
      if (!exitConfirmed) {
        job.output.push(
          "[dispatch] Child exit is not confirmed; preserving process tracking and recovery state.",
        );
        return;
      }

      let stopRequested = Boolean(job.stopRequestedAt) || this.shutdownInProgress;
      const lingeringTree = started && this.retainLingeringProcessGroup(taskId, child, job);
      if (lingeringTree) {
        stopRequested = true;
      }
      this.clearStopEscalation(taskId);
      job.status = stopRequested
        ? this.hasLiveStopProcessGroup(taskId)
          ? "running"
          : "stopped"
        : "failed";
      this.processes.delete(taskId);
      if (started) {
        this.preserveInterruptedSharedCheckout(
          job,
          job.status === "running" ? "running" : stopRequested ? "stopped" : "failed",
        );
      }

      // A true spawn failure cannot have modified the checkout. Once a child
      // obtained a PID, preserve its worktree because it may contain partial
      // work even if the process disappeared before the exit event arrived.
      if (worktreePath) {
        if (!this.removeWorktree(worktreePath)) {
          job.output.push(
            `[worktree] Preserved ${worktreePath} because cleanup could not be confirmed`,
          );
        }
      }
    });

    this.jobs.set(taskId, job);
    this.processes.set(taskId, child);
    this.nodeLaunches.set(taskId, launch);

    return job;
  }

  /**
   * Start a task dispatch using Docker container isolation.
   * Creates a container, then runs the agent inside it via `docker exec`.
   */
  private emitDockerEventSafely(
    stage: "container_created" | "container_stopped" | "container_error",
    taskId: string,
    payload: Record<string, unknown>,
    job: DispatchJob,
  ): void {
    try {
      this.onEvent?.(stage, taskId, payload);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(`[docker-event] ${stage} callback failed: ${detail}`);
    }
  }

  private async finalizeDockerContainer(
    job: DispatchJob,
    container: DockerContainer,
    options: { failed: boolean; force: boolean; deferWorktreeRelease?: boolean },
  ): Promise<DockerStopResult> {
    if (job.worktreePath && !this.updateWorktreeOwnership(job, "stopping", job.pid)) {
      job.output.push(
        `[docker-cleanup] Worktree ownership changed before container shutdown; promotion is blocked.`,
      );
    }
    let result: DockerStopResult = { removed: false, retained: false };
    try {
      if (options.force) {
        result = {
          removed: await this.dockerManager!.forceRemoveContainer(container.containerId),
          retained: false,
        };
      } else {
        const stopped = await this.dockerManager!.stopContainer(
          container.containerId,
          options.failed,
        );
        result = stopped ?? { removed: true, retained: false };
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      job.output.push(`[docker-cleanup] ${detail}`);
    }

    if (result.removed) {
      if (!options.deferWorktreeRelease && !this.clearWorktreeSurvivor(job, true)) {
        job.output.push(
          `[docker-cleanup] Container ${container.containerId} was removed, but its worktree ownership marker could not be cleared.`,
        );
      }
    } else if (result.retained) {
      job.output.push(
        `[docker-cleanup] Container ${container.containerId} and worktree retained by cleanup policy; explicit cleanup is required before same-task reuse.`,
      );
    } else {
      this.updateWorktreeOwnership(job, "survivor", job.pid);
      job.output.push(
        `[docker-cleanup] Could not confirm cleanup of container ${container.containerId}; Docker admission remains blocked.`,
      );
    }
    return result;
  }

  private startDocker(taskId: string, options?: StartOptions): DispatchJob {
    this.assertDispatchAdmissionOpen();
    if (options?.admittedTaskContentHash) {
      // Validate the operator-selected immutable image before publishing the
      // one-use child capability.
      assertTrustedManagedDockerImage(this.isolationConfig!.docker!.image);
    }
    if (Boolean(options?.parentTaskId) !== Boolean(options?.sharedBranchName)) {
      throw new Error(
        `Docker decomposition for ${taskId} requires paired parentTaskId and sharedBranchName before admission`,
      );
    }
    if (
      options?.parentTaskId &&
      options.sharedBranchName !== `${this.branchPrefix}${options.parentTaskId}`
    ) {
      throw new Error(
        `Docker decomposition for ${taskId} requires the host-derived parent branch ${this.branchPrefix}${options.parentTaskId}`,
      );
    }
    const requestedBranch = options?.sharedBranchName ?? `${this.branchPrefix}${taskId}`;
    if (!isSafeDockerBranchName(requestedBranch)) {
      throw new Error(`Docker dispatch ${taskId} received an unsafe admitted branch name`);
    }
    if (options?.resume && !options.dockerResumeStateDir) {
      throw new Error(
        `Cannot resume Docker dispatch ${taskId}: no exact validated runtime archive was selected.`,
      );
    }
    if (options?.resume && options.dockerResumeStateDir) {
      this.assertDockerResumeSelection(taskId, options.dockerResumeStateDir);
    }
    const sessionId = `quack-${taskId}-${randomUUID()}`;
    const expectedWorktreePath = path.join(this.projectRoot, ".quack", "worktrees", taskId);
    const worktreeOwnership = this.acquireWorktreeOwnership(
      taskId,
      sessionId,
      expectedWorktreePath,
    );
    this.pendingWorktreeOwnerships.set(taskId, worktreeOwnership);
    let worktreePath: string | undefined;
    let admittedBranch: { branch: string; head: string };
    try {
      const shouldReuse = options?.reuseWorktree || options?.resume;
      if (shouldReuse && fs.existsSync(expectedWorktreePath)) {
        this.assertWorktreeHasNoLiveSurvivor(
          taskId,
          expectedWorktreePath,
          worktreeOwnership.ownershipId,
        );
        worktreePath = expectedWorktreePath;
      } else {
        worktreePath = this.createWorktree(taskId, {
          ownershipId: worktreeOwnership.ownershipId,
          linkRuntimeDirectories: false,
        });
      }
      if (!worktreePath) {
        throw new Error(
          `Docker dispatch ${taskId} requires a task-specific worktree; shared-checkout fallback is disabled`,
        );
      }
      admittedBranch = this.prepareDockerAdmittedBranch(taskId, worktreePath, options);
    } catch (error) {
      this.clearWorktreeSurvivor(
        {
          taskId,
          sessionId,
          worktreeOwnershipId: worktreeOwnership.ownershipId,
          worktreePath: expectedWorktreePath,
          pid: 0,
          startedAt: worktreeOwnership.recordedAt,
          status: "failed",
          output: [],
        },
        true,
      );
      this.pendingWorktreeOwnerships.delete(taskId);
      throw error;
    }

    ensureDecompositionDispatchAdmissionDirectory(this.projectRoot);
    let decompositionAdmission = options?.admittedTaskContentHash
      ? createDecompositionDispatchAdmissionMarker({
          projectRoot: this.projectRoot,
          taskId,
          contentHash: options.admittedTaskContentHash,
          isolatedDirectory: true,
        })
      : undefined;
    const settleDecompositionAdmission = (): void => {
      if (!decompositionAdmission) return;
      const admission = decompositionAdmission;
      const revoked = revokeDecompositionDispatchAdmission(this.projectRoot, admission);
      if (!revoked) {
        removeDecompositionDispatchAdmissionScope(this.projectRoot, admission.hostDirectory);
      }
      decompositionAdmission = undefined;
    };

    const job: DispatchJob = {
      taskId,
      sessionId,
      pid: 0,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      worktreePath,
      worktreeOwnershipId: worktreeOwnership.ownershipId,
      federatedJobId: options?.federatedJobId,
      federatedHostId: options?.federatedHostId,
      federatedHostAlias: options?.federatedHostAlias,
      federatedHostEndpoint: options?.federatedHostEndpoint,
      federatedLeaseId: options?.federatedLeaseId,
      provenance: options?.provenance,
    };

    this.jobs.set(taskId, job);

    // Treat reconciliation + create as one serialized admission transaction.
    // A second task must not rescan or classify the first task's live
    // container while that first admission is still being established.
    const dockerMgr = this.dockerManager!;
    let createdContainer: DockerContainer | undefined;
    let runtimeBridge: DockerRuntimeBridge | undefined;
    const admittedContainer = this.serializeDockerAdmission(async () => {
      if (this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt) {
        throw new Error(`Cannot start ${taskId}: dispatch manager shutdown is in progress.`);
      }
      await this.ensureDockerOwnershipReconciled();
      if (this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt) {
        throw new Error(`Cannot start ${taskId}: dispatch manager shutdown is in progress.`);
      }
      return dockerMgr.createContainer(taskId, worktreePath, {
        eventSessionId: sessionId,
        authoritativeBranch: admittedBranch.branch,
        authoritativeHead: admittedBranch.head,
        ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
        ...(options?.sharedBranchName ? { sharedBranchName: options.sharedBranchName } : {}),
        ...(options?.dockerResumeStateDir ? { resumeStateDir: options.dockerResumeStateDir } : {}),
        ...(decompositionAdmission
          ? { admissionScopeDirectory: decompositionAdmission.hostDirectory }
          : {}),
      });
    });
    this.observationCandidates.add(job);
    this.observationStarts.add(job);
    const startupPromise = admittedContainer
      .then(async (containerInfo) => {
        createdContainer = containerInfo;
        job.containerId = containerInfo.containerId;
        if (!this.updateWorktreeOwnership(job, "running", 0)) {
          throw new Error(
            `Cannot start ${taskId}: durable worktree ownership changed during container creation`,
          );
        }
        this.pendingWorktreeOwnerships.delete(taskId);

        runtimeBridge = new DockerRuntimeBridge({
          sourceDir: containerInfo.runtimeLogDir,
          archiveRoot: path.join(this.logDir, "docker-import"),
          taskId,
          dispatchSessionId: sessionId,
          ownershipId: worktreeOwnership.ownershipId!,
          startedAt: job.startedAt,
          provenance: options?.provenance ?? {
            channel: "api-direct",
            principal: "unattributed-local-start",
          },
          expectedProject: this.projectName,
          ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
          ...(options?.sharedBranchName ? { sharedBranchName: options.sharedBranchName } : {}),
          ...(containerInfo.resumeSource ? { resumeSource: containerInfo.resumeSource } : {}),
        });
        job.runtimeLogDir = runtimeBridge.archiveDir;
        runtimeBridge.start();

        // Container creation is asynchronous. A shutdown can begin after
        // startDocker() returns but before the exec child exists; never spawn a
        // late child after the shutdown snapshot has already been taken.
        if (this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt) {
          job.status = "stopped";
          job.output.push("[dispatch] Stop requested before container agent startup.");
          const cleanup = await this.finalizeDockerContainer(job, containerInfo, {
            failed: true,
            force: true,
            deferWorktreeRelease: true,
          });
          if (!cleanup.removed) {
            throw new Error(`Container ${containerInfo.containerId} survived stop cleanup`);
          }
          runtimeBridge.sealAndImport();
          runtimeBridge.emitTrustedTerminal({ outcome: "stopped" });
          this.clearWorktreeSurvivor(job, true);
          settleDecompositionAdmission();
          return;
        }

        // Emit container_created event
        this.emitDockerEventSafely(
          "container_created",
          taskId,
          {
            containerId: containerInfo.containerId,
            image: containerInfo.image,
            resourceLimits: this.isolationConfig?.docker?.resourceLimits ?? {},
          },
          job,
        );

        // Build the agent command to run inside the container
        const containerQuackBin =
          typeof dockerMgr.containerPathForHost === "function"
            ? dockerMgr.containerPathForHost(this.quackBin)
            : this.quackBin;
        const agentCmd = ["node", containerQuackBin, "run", taskId, "--project", "/workspace"];
        if (options?.skipGate) agentCmd.push("--skip-gate");
        if (options?.skipDepthOnly) agentCmd.push("--skip-depth-only");
        if (options?.resume) agentCmd.push("--resume");
        // TASK-1326: the docker child inherits the override too.
        if (options?.overridePausedRun) agentCmd.push("--override-paused-run");
        if (options?.model) agentCmd.push("--model", options.model);
        if (options?.maxTurns) agentCmd.push("--max-turns", String(options.maxTurns));
        if (options?.maxBudget) agentCmd.push("--max-budget", String(options.maxBudget));

        const env: Record<string, string> = { ...decompositionAdmission?.environment };
        // Clear nesting detection vars
        env.CLAUDECODE = "";
        env.CLAUDE_CODE = "";
        env.QUACK_DOCKER_RUNTIME_LOG_DIR = containerInfo.logsVolume;
        if (options?.federatedJobId) env.QUACK_FEDERATED_JOB_ID = options.federatedJobId;
        if (options?.federatedHostId) env.QUACK_FEDERATED_HOST_ID = options.federatedHostId;
        if (options?.federatedHostAlias)
          env.QUACK_FEDERATED_HOST_ALIAS = options.federatedHostAlias;
        if (options?.federatedHostEndpoint)
          env.QUACK_FEDERATED_HOST_ENDPOINT = options.federatedHostEndpoint;
        if (options?.federatedLeaseId) env.QUACK_FEDERATED_LEASE_ID = options.federatedLeaseId;
        if (options?.provenance) env.QUACK_PROVENANCE = JSON.stringify(options.provenance);

        const selectedClaudeKey = this.keyManager ? selectClaudeApiKey(this.keyManager) : undefined;
        if (selectedClaudeKey) env.QUACK_SELECTED_KEY_ID = selectedClaudeKey.keyId;

        // Track which key was selected for this Docker dispatch
        const dockerKeyId = env.QUACK_SELECTED_KEY_ID;
        if (dockerKeyId) {
          job.keyId = dockerKeyId;
        }

        if (process.platform === "win32") this.confirmedWindowsTreeKills.delete(taskId);
        const child = dockerMgr.execAgent(
          containerInfo.containerId,
          agentCmd,
          env,
          selectedClaudeKey,
        );
        this.trackChildClose(child, job);
        job.pid = child.pid ?? 0;

        this.captureProcessOutput(child, job);
        this.processes.set(taskId, child);

        let cleanupPromise: Promise<DockerStopResult> | undefined;
        const cleanupOnce = (failed: boolean, force: boolean): Promise<DockerStopResult> => {
          cleanupPromise ??= this.finalizeDockerContainer(job, containerInfo, {
            failed,
            force,
            deferWorktreeRelease: true,
          });
          return cleanupPromise;
        };

        child.on("exit", (code, signal) => {
          const exitHandler = (async () => {
            settleDecompositionAdmission();
            let claimantCheck: DuplicateClaimantCheck | undefined;
            let retry = false;
            let cleanup: DockerStopResult = { removed: false, retained: false };
            const stopRequested =
              Boolean(job.stopRequestedAt || job.operatorStopRequestedAt) ||
              this.shutdownInProgress;
            try {
              this.clearStopEscalation(taskId);
              job.exitCode = code ?? 1;
              try {
                appendDispatchChildExit({
                  // Container output is untrusted. Durable monitor-authored
                  // exit evidence stays in the host-owned control log tree.
                  logDir: this.logDir,
                  taskId,
                  jobSessionId: sessionId,
                  exactSession: true,
                  jobStartedAt: job.startedAt,
                  exitCode: code,
                  signal: signal ?? null,
                  worktreePath: worktreePath ?? null,
                });
              } catch {
                try {
                  this.onEvent?.("dispatch_child_exit", taskId, {
                    exitCode: code,
                    signal: signal ?? null,
                    killed: Boolean(signal),
                    worktreePath: worktreePath ?? null,
                    isolation: "docker",
                    at: new Date().toISOString(),
                  });
                } catch {
                  // Cleanup below is authoritative even when instrumentation fails.
                }
              }
              if (signal) {
                job.killedBySignal = signal;
                job.output.push(`[dispatch] Child terminated by signal ${signal}.`);
              }
              job.status = stopRequested ? "stopped" : code === 0 ? "completed" : "failed";

              if (
                !stopRequested &&
                code !== 0 &&
                this.keyManager &&
                dockerKeyId &&
                isRateLimitError(code, job.output)
              ) {
                const retryAfterMs = parseRetryAfter(job.output);
                this.keyManager.markRateLimited(dockerKeyId, retryAfterMs);
                job.output.push(
                  `[key-rotation] Key ${dockerKeyId} rate-limited, cooldown ${retryAfterMs ?? this.keyManager.getCooldownMs()}ms`,
                );
                if (this.keyManager.hasAvailableKeys()) {
                  claimantCheck = this.claimantResolver
                    ? await this.claimantResolver(taskId)
                    : undefined;
                  assertUncontestedClaimant(claimantCheck);
                  retry =
                    !this.shutdownInProgress &&
                    !job.stopRequestedAt &&
                    !job.operatorStopRequestedAt;
                }
              }
            } catch (error: unknown) {
              const detail = error instanceof Error ? error.message : String(error);
              job.status = "failed";
              job.output.push(`[exit-handler] ${detail}`);
              retry = false;
            } finally {
              this.emitDockerEventSafely(
                "container_stopped",
                taskId,
                {
                  containerId: containerInfo.containerId,
                  reason: retry
                    ? "rate-limited, re-dispatching with new key"
                    : code === 0
                      ? "completed"
                      : "agent exited with error",
                  exitCode: code,
                },
                job,
              );
              this.processes.delete(taskId);
              cleanup = await cleanupOnce(code !== 0, retry);
              if (cleanup.removed || cleanup.retained) {
                try {
                  // A docker-exec child may leave background descendants. Read
                  // its bind tree only after container stop/removal proves no
                  // untrusted process can race the validating bridge.
                  job.runtimeLogDir = runtimeBridge!.sealAndImport();
                  const approvalPending =
                    !stopRequested &&
                    code !== 0 &&
                    !signal &&
                    this.isApprovalPending(taskId, job.startedAt, job.runtimeLogDir);
                  if (approvalPending) {
                    const gitState = dockerMgr.sealPrivateGitForResume(
                      containerInfo,
                      worktreeOwnership.ownershipId!,
                    );
                    runtimeBridge!.recordGitResumeState(gitState);
                    const pending = inspectValidatedDockerPendingArchive(job.runtimeLogDir, taskId);
                    this.writeDockerPausePointer(job, pending, containerInfo.resumeSource);
                    if (
                      containerInfo.resumeSource &&
                      !dockerMgr.releaseSealedResumeRef(containerInfo.resumeSource)
                    ) {
                      job.output.push(
                        "[docker-resume] Prior sealed Git ref was retained for explicit recovery.",
                      );
                    }
                    job.status = "awaiting_approval";
                  }
                  this.classifySpecStaleExit(job, taskId, code, signal ?? null, job.runtimeLogDir);
                  if (!this.hasExactWorktreeOwnership(job)) {
                    job.status = "failed";
                    retry = false;
                    job.output.push(
                      "[docker-output] Refused unsafe runtime output: Docker result promotion refused because worktree ownership changed",
                    );
                  } else {
                    const results = await dockerMgr.extractResults(containerInfo);
                    if (results.diff) {
                      job.output.push(
                        `[docker-results] branch=${results.branch}, diff=${results.diff.length} bytes`,
                      );
                    }
                    if (job.status === "completed" && !retry) {
                      if (
                        containerInfo.resumeSource?.approvedDiffHash &&
                        createHash("sha256").update(results.diff, "utf-8").digest("hex") !==
                          containerInfo.resumeSource.approvedDiffHash
                      ) {
                        job.status = "failed";
                        retry = false;
                        job.output.push(
                          "[docker-output] Refused unsafe runtime output: resumed Git result differs from the exact judge-approved diff",
                        );
                      }
                    }
                    if (job.status === "completed" && !retry) {
                      const gitState = dockerMgr.preparePrivateGitForPublication(
                        containerInfo,
                        worktreeOwnership.ownershipId!,
                      );
                      job.publicationRecoveryPath = path.join(
                        this.dockerPublicationRecoveryRoot(),
                        `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}-${worktreeOwnership.ownershipId!}.json`,
                      );
                      const { initializeDockerPublicationRecovery, publishDockerPromotedResult } =
                        await import("../dispatcher/docker-host-publication.js");
                      const publicationOptions = {
                        ...(options?.sharedBranchName
                          ? {
                              parentTaskId: options.parentTaskId,
                              sharedBranchName: options.sharedBranchName,
                            }
                          : {}),
                        recovery: {
                          rootDir: this.dockerPublicationRecoveryRoot(),
                          publicationId: worktreeOwnership.ownershipId!,
                          gitState,
                          worktreePath,
                          worktreeSessionId: sessionId,
                          worktreeOwnershipId: worktreeOwnership.ownershipId!,
                          preserveWorktree: cleanup.retained,
                          ...(containerInfo.resumeSource
                            ? { sourceResume: containerInfo.resumeSource }
                            : {}),
                        },
                      };
                      await initializeDockerPublicationRecovery(
                        taskId,
                        this.projectRoot,
                        results.branch,
                        publicationOptions,
                      );
                      dockerMgr.sealPreparedPublicationRef(gitState);
                      const publication = await publishDockerPromotedResult(
                        taskId,
                        this.projectRoot,
                        results.branch,
                        publicationOptions,
                      );
                      job.publicationRecoveryPath = publication.recoveryPath;
                      if (publication.prUrl) {
                        job.output.push(`[docker-publish] PR ${publication.prUrl}`);
                      }
                      if (publication.autoMerged) {
                        job.output.push(
                          `[docker-publish] auto-merged${publication.mergeCommitSha ? ` ${publication.mergeCommitSha}` : ""}`,
                        );
                      }
                      job.output.push(
                        ...publication.warnings.map((warning) => `[docker-publish] ${warning}`),
                      );
                      if (!publication.recoveryPath) {
                        job.status = "failed";
                        retry = false;
                        job.output.push(
                          "[docker-output] Refused unsafe runtime output: Docker publication completed without durable recovery identity",
                        );
                      } else {
                        const completed = readDockerPublicationRecovery(publication.recoveryPath);
                        this.finalizeDockerPublicationRecovery(
                          job,
                          publication.recoveryPath,
                          completed,
                        );
                      }
                    }
                  }
                } catch (error: unknown) {
                  const detail = error instanceof Error ? error.message : String(error);
                  job.status = "failed";
                  retry = false;
                  job.output.push(`[docker-output] Refused unsafe runtime output: ${detail}`);
                }
              } else {
                job.status = "failed";
                retry = false;
                runtimeBridge?.abort(
                  `Container ${containerInfo.containerId} cleanup was not confirmed`,
                );
              }
              this.captureGitMetadata(job, worktreePath);
              if (cleanup.removed && !job.publicationRecoveryPath) {
                this.clearWorktreeSurvivor(job, true);
              }
              runtimeBridge?.emitTrustedTerminal({
                outcome:
                  job.status === "completed"
                    ? "approved"
                    : job.status === "awaiting_approval"
                      ? "awaiting_approval"
                      : job.specStale
                        ? "spec_changed"
                        : stopRequested
                          ? "stopped"
                          : "error",
                ...(job.status === "failed"
                  ? { error: job.output.at(-1) ?? "Docker dispatch failed" }
                  : {}),
              });
              if (
                cleanup.removed &&
                job.status === "completed" &&
                !retry &&
                worktreePath &&
                fs.existsSync(worktreePath)
              ) {
                this.removeWorktree(worktreePath);
              } else if (worktreePath) {
                job.output.push(
                  `[worktree] Preserved ${worktreePath} — ${cleanup.retained ? "container retained by policy" : "dispatch requires recovery"}`,
                );
              }
              this.jobs.set(taskId, job);
            }

            if (
              retry &&
              cleanup.removed &&
              !this.shutdownInProgress &&
              !job.stopRequestedAt &&
              !job.operatorStopRequestedAt
            ) {
              try {
                const replacement = await this.restartWithFreshDecompositionAdmission(
                  taskId,
                  (admission) => {
                    if (
                      this.shutdownInProgress ||
                      job.stopRequestedAt ||
                      job.operatorStopRequestedAt ||
                      this.jobs.get(taskId) !== job
                    ) {
                      throw new Error(
                        "Docker rate-limit re-dispatch was cancelled before admission.",
                      );
                    }
                    this.jobs.delete(taskId);
                    return this.start(
                      taskId,
                      {
                        ...options,
                        reuseWorktree: true,
                        duplicateClaimantCheck: claimantCheck,
                        admittedTaskContentHash: admission.contentHash,
                      },
                      claimantCheck,
                    );
                  },
                );
                this.recordAuthRetryReplacement(job, replacement);
              } catch (error: unknown) {
                const detail = error instanceof Error ? error.message : String(error);
                job.status = "failed";
                job.output.push(`[key-rotation] Re-dispatch failed: ${detail}`);
                this.jobs.set(taskId, job);
              }
            }
          })().catch(async (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            job.status = "failed";
            job.output.push(`[exit-handler] ${detail}`);
            await cleanupOnce(true, true);
          });
          this.trackExitHandler(exitHandler, job);
        });

        child.on("error", (err) => {
          const errorHandler = (async () => {
            settleDecompositionAdmission();
            this.clearStopEscalation(taskId);
            job.output.push(`[error] ${err.message}`);
            this.emitDockerEventSafely(
              "container_error",
              taskId,
              { containerId: containerInfo.containerId, error: err.message },
              job,
            );
            job.status =
              this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt
                ? "stopped"
                : "failed";
            const cleanup = await cleanupOnce(true, true);
            if (cleanup.removed || cleanup.retained) {
              try {
                job.runtimeLogDir = runtimeBridge!.sealAndImport();
              } catch (error: unknown) {
                job.output.push(
                  `[docker-output] Refused unsafe runtime output: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              runtimeBridge?.emitTrustedTerminal({
                outcome: job.status === "stopped" ? "stopped" : "error",
                error: err.message,
              });
            } else {
              runtimeBridge?.abort(
                `Container ${containerInfo.containerId} cleanup was not confirmed`,
              );
            }
            if (cleanup.removed) {
              this.processes.delete(taskId);
              this.clearWorktreeSurvivor(job, true);
            }
          })().catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            job.status = "failed";
            job.output.push(`[exit-handler] ${detail}`);
          });
          this.trackExitHandler(errorHandler, job);
        });
      })
      .catch(async (err: unknown) => {
        try {
          settleDecompositionAdmission();
        } catch (cleanupError: unknown) {
          const detail =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          job.output.push(`[docker-admission] Admission cleanup failed: ${detail}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        try {
          job.status =
            this.shutdownInProgress || job.stopRequestedAt || job.operatorStopRequestedAt
              ? "stopped"
              : "failed";
          job.output.push(`[docker-error] ${msg}`);
          this.emitDockerEventSafely(
            "container_error",
            taskId,
            { containerId: job.containerId ?? "", error: msg },
            job,
          );
        } finally {
          const ownedContainer = createdContainer ?? this.getDockerContainer(taskId);
          if (ownedContainer) {
            const cleanup = await this.finalizeDockerContainer(job, ownedContainer, {
              failed: true,
              force: true,
              deferWorktreeRelease: true,
            });
            if (cleanup.removed || cleanup.retained) {
              try {
                job.runtimeLogDir = runtimeBridge?.sealAndImport() ?? job.runtimeLogDir;
              } catch (error: unknown) {
                job.output.push(
                  `[docker-output] Refused unsafe runtime output: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            } else {
              runtimeBridge?.abort(
                `Container ${ownedContainer.containerId} cleanup was not confirmed`,
              );
            }
            if (cleanup.removed) {
              this.processes.delete(taskId);
              this.clearWorktreeSurvivor(job, true);
            }
          } else {
            this.clearWorktreeSurvivor(job, true);
          }
          this.pendingWorktreeOwnerships.delete(taskId);
        }
      })
      .finally(() => {
        if (this.pendingDockerStarts.get(taskId) === startupPromise) {
          this.pendingDockerStarts.delete(taskId);
        }
        this.observationStarts.delete(job);
        this.recordTerminalObservation(job);
      });
    this.pendingDockerStarts.set(taskId, startupPromise);

    return job;
  }

  /**
   * Capture stdout/stderr from a child process into the job output buffer.
   */
  private captureProcessOutput(child: ChildProcess, job: DispatchJob): void {
    child.stdout?.on("data", (data: Buffer) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        job.output.push(...lines);
        if (job.output.length > 200) {
          job.output.splice(0, job.output.length - 200);
        }
      } catch (err) {
        console.error("[dispatch] stdout capture error (non-fatal):", err);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        job.output.push(...lines.map((l) => `[stderr] ${l}`));
        if (job.output.length > 200) {
          job.output.splice(0, job.output.length - 200);
        }
      } catch (err) {
        console.error("[dispatch] stderr capture error (non-fatal):", err);
      }
    });
  }

  /**
   * An approval pause is observed only after the dispatcher process exits, so
   * its original ChildProcess handle is no longer available. Persist the same
   * recovery barrier before changing state, clean up independently observable
   * containers, and leave recovery blocked because detached descendants cannot
   * be disproved from a stale pid.
   */
  private stopAwaitingApprovalJob(job: DispatchJob): boolean {
    job.executionRoot ??= job.worktreePath ?? this.projectRoot;
    job.operatorStopRequestedAt = new Date().toISOString();
    job.operatorStopCleanupPending = true;
    if (!this.persistOperatorStopBarrier(job)) {
      job.operatorStopRequestedAt = undefined;
      job.operatorStopCleanupPending = false;
      return false;
    }

    job.status = "stopped";
    job.operatorStopTreeTerminated = false;
    this.operatorStopCleanupPending.set(job.taskId, job);
    if (job.worktreePath) {
      job.output.push(
        `[worktree] Preserved ${job.worktreePath} — task stopped, branch retained for recovery`,
      );
    }
    this.quarantineRecoveryWarning(
      job,
      "the approval subprocess had already exited before stop; detached descendants cannot be excluded",
    );

    let sharedExecutionRoot = true;
    try {
      sharedExecutionRoot = pathsEqualForDispatch(
        canonicalizePotentialPathSync(job.executionRoot),
        canonicalizePotentialPathSync(this.projectRoot),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.quarantineRecoveryWarning(
        job,
        `the approval execution root could not be canonicalized (${detail})`,
      );
    }

    if (sharedExecutionRoot) {
      this.quarantineRecoveryWarning(
        job,
        "the paused run used the shared project directory; container and protected-path state " +
          "require explicit manual verification",
      );
    } else if (!this.cleanupDockerForWorktree(job.executionRoot)) {
      this.quarantineRecoveryWarning(
        job,
        "worktree container cleanup was disabled or could not be confirmed",
      );
    }

    if (job.containerId) {
      if (this.dockerManager) {
        const cleanup = this.dockerManager
          .stopContainer(job.containerId, true)
          .then(() => {
            job.output.push(
              "[docker] Approval-pause container stop returned without an independently verified " +
                "termination result; recovery remains blocked.",
            );
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            job.output.push(
              `[docker] Approval-pause container stop failed (${detail}); recovery remains blocked.`,
            );
          });
        this.trackExitHandler(cleanup, job);
      } else {
        this.quarantineRecoveryWarning(
          job,
          `container ${job.containerId} is recorded but no Docker manager is available to stop it`,
        );
      }
    }

    // The stop request was durably fenced, but the original subprocess handle
    // is already gone. Without containment evidence we cannot prove that it
    // left no detached descendants behind, so callers must not report a
    // confirmed stop.
    return false;
  }

  /**
   * Stop a running dispatch and its owned process tree.
   *
   * Returns true only when process-tree termination is positively confirmed.
   * A false result may still mean the stop request was accepted and durably
   * fenced; callers must inspect the job's recovery state and must not reopen
   * admission or report successful cleanup.
   */
  stop(taskId: string): boolean {
    if (this.approvalPauseResolutions.has(taskId)) return false;
    const job = this.jobs.get(taskId);
    const pendingStop = this.operatorStopCleanupPending.get(taskId);
    if (pendingStop) return this.retryPendingOperatorStop(pendingStop);

    const child = this.processes.get(taskId);

    // The normal approval state has no live ChildProcess handle because it is
    // entered from that child's exit callback. If a handle is unexpectedly
    // still present, fall through to the ordinary process-tree stop path.
    if (job?.status === "awaiting_approval" && !child) {
      return this.stopAwaitingApprovalJob(job);
    }

    if (!child) {
      if (job && this.rateLimitRetryPending.has(taskId)) {
        job.operatorStopRequestedAt ??= new Date().toISOString();
        job.status = "stopped";
        job.output.push("[dispatch] Pending rate-limit re-dispatch cancelled by operator.");
        this.rateLimitRetryPending.delete(taskId);
        return true;
      }
      if (
        job?.status === "running" &&
        this.isolationConfig?.method === "docker" &&
        this.dockerManager
      ) {
        job.operatorStopRequestedAt = new Date().toISOString();
        job.operatorStopCleanupPending = true;
        if (!this.persistOperatorStopBarrier(job)) {
          job.operatorStopRequestedAt = undefined;
          job.operatorStopCleanupPending = false;
          return false;
        }
        job.status = "stopped";
        job.output.push(
          "[docker] Stop requested during container creation; agent launch cancelled. " +
            "Same-task restart remains blocked until container absence can be proven.",
        );
        this.operatorStopCleanupPending.set(taskId, job);
        return false;
      }
      return false;
    }

    // Record the operator's intent before kill(). The exit callback runs
    // asynchronously and must see this marker before it handles SIGTERM.
    if (job) {
      job.operatorStopRequestedAt = new Date().toISOString();
      job.operatorStopCleanupPending = true;
      if (!this.persistOperatorStopBarrier(job)) {
        job.operatorStopRequestedAt = undefined;
        job.operatorStopCleanupPending = false;
        return false;
      }
      job.status = "stopped";

      // Preserve worktree on manual stop — work may be partially done.
      // The branch and commits remain available for /fix-task or manual recovery.
      if (job.worktreePath) {
        job.output.push(
          `[worktree] Preserved ${job.worktreePath} — task stopped, branch retained for recovery`,
        );
      } else {
        this.preserveInterruptedSharedCheckout(job, "stopped");
      }
    }

    let terminationConfirmed = false;
    if (job && !job.containerId) {
      this.operatorStopCleanupPending.set(taskId, job);
      job.operatorStopCleanupPending = true;
      const termination = this.terminateOperatorProcessTree(child, this.nodeLaunches.get(taskId));
      job.operatorStopTreeTerminated = termination.confirmed;
      terminationConfirmed = termination.confirmed;
      job.operatorStopProcessGroupId = termination.processGroupId;
      if (termination.warning) {
        job.output.push(`[dispatch] Operator-stop termination warning: ${termination.warning}`);
      }
    } else {
      // Docker owns the agent descendants. Stop the exec client immediately,
      // then request container cleanup below; admission remains fail-closed
      // because DockerManager's current API cannot prove termination.
      if (job) this.operatorStopCleanupPending.set(taskId, job);
      child.kill("SIGTERM");
      if (this.processes.get(taskId) === child) {
        this.processes.delete(taskId);
      }
    }

    // Clean up Docker container if one was created
    if (job?.containerId && this.dockerManager) {
      const cleanup = this.dockerManager
        .stopContainer(job.containerId, true)
        .then(() => {
          job.output.push(
            "[docker] Container stop returned without an independently verified " +
              "termination result; same-task restart remains blocked.",
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          job.output.push(
            `[docker] Container stop failed (${message}); same-task restart remains blocked.`,
          );
        });
      this.trackExitHandler(cleanup, job);
    }

    return terminationConfirmed;
  }

  /**
   * Get all jobs (active + completed).
   */
  getAllJobs(): DispatchJob[] {
    this.reconcileRunningJobs();
    return Array.from(this.jobs.values());
  }

  /**
   * Get active (running) jobs.
   */
  /**
   * Whether worktree isolation has failed and dispatch is in degraded mode.
   * When true, only one task can run at a time (shared directory fallback).
   */
  isWorktreeDegraded(): boolean {
    return this.worktreeDegraded;
  }

  getActiveJobs(): DispatchJob[] {
    this.reconcileRunningJobs();
    return Array.from(this.jobs.values()).filter((j) => j.status === "running");
  }

  /**
   * Jobs that still own the shared project checkout while worktree isolation
   * is degraded. Approval-paused jobs have no live child process, but they
   * intentionally preserve the shared checkout and must still block admission.
   */
  getSharedCheckoutOccupants(): DispatchJob[] {
    this.reconcileRunningJobs();
    const occupants =
      this.isolationConfig?.method === "docker"
        ? []
        : Array.from(this.jobs.values()).filter(
            (job) => !job.worktreePath && job.status !== "completed",
          );
    const durablePause = this.ensureSharedCheckoutRecoveryMetadata();
    if (durablePause && !occupants.some((job) => job.taskId === durablePause.taskId)) {
      // A durable `running` marker without its original in-memory child is a
      // crash/restart recovery record, not evidence that the process is live.
      const recoveredStatus =
        durablePause.status === "running" && !this.durableSharedOwnerMayBeLive(durablePause)
          ? "stopped"
          : (durablePause.status ?? "awaiting_approval");
      occupants.push({
        taskId: durablePause.taskId,
        sessionId: durablePause.sessionId,
        pid: 0,
        startedAt: durablePause.startedAt,
        status: recoveredStatus,
        output: [
          `[dispatch] Restored shared-checkout pause ownership recorded ${durablePause.pausedAt}.`,
        ],
        sharedCheckoutOwnershipId: durablePause.ownershipId,
      });
    }
    return occupants;
  }

  /** Return durable shared-checkout tree evidence needed for explicit recovery. */
  getSharedCheckoutShutdownSurvivor(): SharedCheckoutShutdownSurvivor | undefined {
    const marker = this.ensureSharedCheckoutRecoveryMetadata();
    if (
      !marker ||
      (marker.processTreeStatus !== "unconfirmed" &&
        !(marker.status === "running" && marker.processTreeStatus === undefined) &&
        !(process.platform === "win32" && marker.processTreeStatus === undefined))
    ) {
      return undefined;
    }
    return {
      taskId: marker.taskId,
      sessionId: marker.sessionId,
      ownershipId: marker.ownershipId,
      processId: marker.processId,
      status: marker.status ?? "awaiting_approval",
      reconciliationToken: marker.reconciliationToken,
    };
  }

  /**
   * Mark a Windows shared-checkout tree stopped only after independent
   * operator verification. Session and token checks prevent stale recovery
   * requests from releasing a newer owner.
   */
  private completedSharedCheckoutOwner(
    marker: DurableSharedCheckoutPause,
  ): DispatchJob | undefined {
    if (
      marker.status !== "stopped" ||
      !marker.ownershipId ||
      !marker.successfulExitAt ||
      !/^[A-Za-z0-9._-]+$/.test(marker.sessionId) ||
      resolvePausedRunState(this.logDir, marker.taskId)
    )
      return undefined;
    const started = Date.parse(marker.startedAt);
    const completed = Date.parse(marker.successfulExitAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started)
      return undefined;
    const current = this.jobs.get(marker.taskId);
    if (
      current &&
      (current.sessionId !== marker.sessionId ||
        current.sharedCheckoutOwnershipId !== marker.ownershipId ||
        current.worktreePath ||
        current.containerId ||
        current.status !== "completed" ||
        current.exitCode !== 0 ||
        current.killedBySignal ||
        current.stopRequestedAt ||
        current.operatorStopRequestedAt ||
        (this.observationExitHandlers.get(current) ?? 0) > 0)
    )
      return undefined;
    try {
      const eventPath = path.join(this.logDir, `events-${marker.sessionId}.jsonl`);
      const stat = fs.lstatSync(eventPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined;
      const events = fs
        .readFileSync(eventPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map(
          (line) =>
            JSON.parse(line) as {
              stage?: string;
              taskId?: string;
              sessionId?: string;
              payload?: {
                taskId?: string;
                exitCode?: number;
                signal?: unknown;
                killed?: boolean;
                operatorRequested?: boolean;
                worktreePath?: unknown;
                at?: string;
              };
            },
        );
      const exits = events.filter((event) => event?.stage === "dispatch_child_exit");
      if (exits.length !== 1) return undefined;
      const event = exits[0];
      const payload = event.payload;
      const at = Date.parse(payload?.at ?? "");
      if (
        event.taskId !== marker.taskId ||
        event.sessionId !== marker.sessionId ||
        payload?.taskId !== marker.taskId ||
        payload.exitCode !== 0 ||
        payload.signal !== null ||
        payload.killed !== false ||
        payload.operatorRequested !== false ||
        payload.worktreePath !== null ||
        !Number.isFinite(at) ||
        at < started ||
        at > completed
      )
        return undefined;
    } catch {
      return undefined;
    }
    return {
      taskId: marker.taskId,
      sessionId: marker.sessionId,
      pid: marker.processId ?? 0,
      startedAt: marker.startedAt,
      completedAt: marker.successfulExitAt,
      status: "completed",
      exitCode: 0,
      output: current?.output ?? [],
      sharedCheckoutOwnershipId: marker.ownershipId,
      sharedCheckoutOriginalBranch: marker.originalBranch,
      sharedCheckoutOriginalStatus: marker.originalStatus,
    };
  }

  reconcileSharedCheckoutShutdownSurvivor(
    taskId: string,
    sessionId: string,
    ownershipId: string,
    reconciliationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    if (!processTreeConfirmedStopped || this.processes.has(taskId)) return false;
    const activeOwner = this.jobs.get(taskId);
    if (activeOwner && (this.observationExitHandlers.get(activeOwner) ?? 0) > 0) return false;
    try {
      return this.withSharedCheckoutMutationLock(() => {
        const marker = this.readSharedCheckoutPause(true);
        if (
          !marker ||
          marker.taskId !== taskId ||
          marker.sessionId !== sessionId ||
          marker.ownershipId !== ownershipId ||
          !marker.reconciliationToken ||
          marker.reconciliationToken !== reconciliationToken
        ) {
          return false;
        }
        const completedOwner = this.completedSharedCheckoutOwner(marker);
        if (marker.processTreeStatus === "confirmed-stopped" && !completedOwner) return false;
        const reconciled: DurableSharedCheckoutPause = {
          ...marker,
          pausedAt: new Date().toISOString(),
          status: marker.status === "running" ? "stopped" : marker.status,
          processTreeStatus: "confirmed-stopped",
        };
        fs.writeFileSync(
          this.sharedCheckoutPausePath(),
          `${JSON.stringify(reconciled, null, 2)}\n`,
          "utf-8",
        );
        if (completedOwner) {
          // The ownership lock is already held. Do not acquire it again through
          // restoreAndReleaseSharedCheckout; restore and release are one mutation.
          if (!this.restoreSharedCheckout(completedOwner)) return false;
          fs.rmSync(this.sharedCheckoutPausePath());
        }
        if (process.platform === "win32") {
          this.confirmedWindowsTreeKills.set(taskId, marker.sessionId);
        }
        this.unconfirmedProcessGroups.delete(taskId);
        const job = this.jobs.get(taskId);
        if (job?.stopRequestedAt && job.status === "running") {
          job.status = "stopped";
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  /** List durable worktree process-tree evidence without deleting any worktree. */
  getWorktreeShutdownSurvivors(): WorktreeShutdownSurvivor[] {
    const survivors = this.readWorktreeShutdownSurvivors();
    const unresolved: WorktreeShutdownSurvivor[] = [];
    for (const marker of survivors) {
      if (
        marker.strategy === "posix-process-group" &&
        process.platform !== "win32" &&
        marker.processId &&
        !this.unconfirmedProcessGroups.has(marker.taskId) &&
        !this.processGroupExists(marker.processId)
      ) {
        const cleared = this.clearWorktreeSurvivor(
          {
            taskId: marker.taskId,
            sessionId: marker.sessionId,
            worktreeOwnershipId: marker.ownershipId,
            worktreePath: marker.worktreePath,
            pid: marker.processId,
            startedAt: marker.recordedAt,
            status: "stopped",
            output: [],
          },
          false,
        );
        if (!cleared) {
          unresolved.push(marker);
        }
      } else {
        unresolved.push(marker);
      }
    }
    return unresolved.map((marker) => ({ ...marker }));
  }

  /** Clear durable worktree ownership only after exact tokened attestation. */
  reconcileWorktreeShutdownSurvivor(
    taskId: string,
    sessionId: string,
    ownershipId: string,
    reconciliationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    if (!processTreeConfirmedStopped || this.processes.has(taskId)) return false;
    try {
      return this.withWorktreeMarkerLock(taskId, () => {
        const markerPath = this.worktreeSurvivorPath(taskId);
        const marker = this.parseWorktreeSurvivor(markerPath);
        if (
          !marker ||
          marker.taskId !== taskId ||
          marker.sessionId !== sessionId ||
          !marker.ownershipId ||
          marker.ownershipId !== ownershipId ||
          !marker.reconciliationToken ||
          marker.reconciliationToken !== reconciliationToken ||
          marker.strategy === "docker-container" ||
          (marker.strategy === "posix-process-group" &&
            process.platform !== "win32" &&
            marker.processId !== undefined &&
            this.processGroupExists(marker.processId))
        ) {
          return false;
        }
        fs.rmSync(markerPath);
        const removed = !fs.existsSync(markerPath);
        if (removed) {
          this.unconfirmedProcessGroups.delete(taskId);
          const job = this.jobs.get(taskId);
          if (job?.stopRequestedAt && job.status === "running") {
            job.status = "stopped";
          }
        }
        return removed;
      });
    } catch {
      return false;
    }
  }

  /**
   * Get the active job for a specific task, if any.
   */
  getActiveJob(taskId: string): DispatchJob | undefined {
    this.reconcileRunningJobs();
    const job = this.jobs.get(taskId);
    if (!job) return undefined;
    // Include awaiting_approval: the worktree has agent commits that
    // must not be destroyed by a fresh createWorktree() call.
    return job.status === "running" || job.status === "awaiting_approval" ? job : undefined;
  }

  /**
   * Persist a human-gate decision and release its exact in-memory pause as one
   * fail-consistent manager operation. Blueprint and judge decision routes
   * share this reservation, including after a monitor restart when no job is
   * in memory, so conflicting approve/reject requests cannot both mutate one
   * pending gate.
   *
   * Every fallible lifecycle check happens before `persistDecision` is called.
   * A reservation then prevents start()/stop() from replacing or fencing the
   * job while the durable write is in flight. Once that callback resolves, the
   * compare-and-release path is synchronous and non-throwing. A failed write
   * drops the reservation and leaves the awaiting job untouched.
   *
   * No `stop()` call, process signal, worktree cleanup, checkpoint mutation, or
   * operator-stop barrier is performed here. `released` is false when there was
   * no in-memory approval pause (for example after a monitor restart).
   */
  async resolveApprovalPauseDecision<T>(
    taskId: string,
    gate: ApprovalGate,
    expectedState: DecidedApprovalState,
    persistDecision: () => Promise<T>,
    logDir = this.logDir,
    options?: ApprovalPauseDecisionOptions,
  ): Promise<ApprovalPauseDecisionResult<T>> {
    const resolution = this.prepareApprovalPauseResolution(
      taskId,
      gate,
      expectedState,
      logDir,
      options,
    );

    try {
      const decision = await persistDecision();
      const current = this.approvalPauseResolutions.get(taskId);
      const released =
        resolution.job !== undefined &&
        current === resolution &&
        resolution.taskId === taskId &&
        resolution.gate === gate &&
        resolution.expectedState === expectedState &&
        this.jobs.get(taskId) === resolution.job &&
        resolution.job.status === "awaiting_approval";
      if (released) this.jobs.delete(taskId);
      if (current === resolution) this.approvalPauseResolutions.delete(taskId);
      return { decision, released };
    } catch (error: unknown) {
      if (this.approvalPauseResolutions.get(taskId) === resolution) {
        this.approvalPauseResolutions.delete(taskId);
      }
      throw error;
    }
  }

  private prepareApprovalPauseResolution(
    taskId: string,
    gate: ApprovalGate,
    expectedState: DecidedApprovalState,
    logDir: string,
    options?: ApprovalPauseDecisionOptions,
  ): ApprovalPauseResolution {
    if (this.approvalPauseResolutions.has(taskId)) {
      throw new ApprovalDecisionConflictError(
        "decision_in_flight",
        `Cannot resolve ${taskId}'s approval pause: a decision is already in flight.`,
      );
    }
    const currentJob = this.jobs.get(taskId);
    if (currentJob?.status === "running") {
      throw new ApprovalDecisionConflictError(
        "dispatch_running",
        `Cannot resolve ${taskId}'s approval pause while its dispatch process is still running.`,
      );
    }
    if (
      this.processes.has(taskId) ||
      this.nodeLaunches.has(taskId) ||
      currentJob?.operatorStopCleanupPending === true ||
      this.operatorStopCleanupPending.has(taskId)
    ) {
      throw new ApprovalDecisionConflictError(
        "cleanup_live",
        `Cannot resolve ${taskId}'s approval pause while dispatch process or cleanup state remains live.`,
      );
    }
    if (currentJob?.status === "stopped") {
      throw new ApprovalDecisionConflictError(
        "operator_stopped",
        `Cannot resolve ${taskId}'s approval pause after an operator stop; complete recovery before deciding the gate.`,
      );
    }

    // An operator stop is durably fenced because the monitor can restart while
    // process-tree cleanup is still unproven. Validate that same barrier here,
    // before the approval writer runs, instead of deciding the gate and only
    // discovering the barrier when the route attempts its replacement start.
    try {
      this.assertNoDurableOperatorStopBarrier(taskId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApprovalDecisionConflictError(
        "operator_stop_barrier",
        `Cannot resolve ${taskId}'s approval pause while durable operator-stop recovery remains blocked: ${detail}`,
      );
    }
    const job = currentJob?.status === "awaiting_approval" ? currentJob : undefined;

    if (
      job &&
      (typeof job.exitCode !== "number" ||
        !Number.isInteger(job.exitCode) ||
        job.exitCode === 0 ||
        job.killedBySignal)
    ) {
      throw new ApprovalDecisionConflictError(
        "exit_unproven",
        `Cannot release ${taskId}'s approval pause because an ordinary non-zero child exit is not proven.`,
      );
    }

    const approvalName = gate === "judge" ? `${taskId}-judge.json` : `${taskId}.json`;
    const approvalPath = path.join(logDir, "approvals", approvalName);
    let approval: {
      taskId?: unknown;
      state?: unknown;
      createdAt?: unknown;
    };
    try {
      approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as typeof approval;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") {
        throw new ApprovalDecisionConflictError(
          "approval_missing",
          `Cannot resolve ${taskId}'s approval pause: the ${gate} approval record does not exist.`,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot resolve ${taskId}'s approval pause: the ${gate} pending record is unreadable (${detail}).`,
      );
    }

    const createdAt =
      typeof approval.createdAt === "string" ? new Date(approval.createdAt).getTime() : Number.NaN;
    const startedAt = job ? new Date(job.startedAt).getTime() : undefined;
    const repeatedReplan =
      !job &&
      gate === "blueprint" &&
      expectedState === "rejected" &&
      options?.allowAlreadyRejected === true &&
      approval.state === "rejected";
    if (approval.taskId !== taskId || !Number.isFinite(createdAt)) {
      throw new Error(
        `Cannot resolve ${taskId}'s approval pause: the ${gate} approval record is malformed.`,
      );
    }
    if (approval.state !== "pending" && !repeatedReplan) {
      throw new ApprovalDecisionConflictError(
        "approval_not_pending",
        `Cannot resolve ${taskId}'s approval pause: the ${gate} approval record is not pending.`,
      );
    }
    if (job && (startedAt === undefined || !Number.isFinite(startedAt))) {
      throw new Error(
        `Cannot resolve ${taskId}'s approval pause: the in-memory dispatch start time is malformed.`,
      );
    }
    if (job && createdAt < startedAt!) {
      throw new ApprovalDecisionConflictError(
        "approval_run_mismatch",
        `Cannot resolve ${taskId}'s approval pause: the ${gate} pending record does not match this run.`,
      );
    }

    // An awaiting job does not currently carry its gate as an in-memory
    // field. Refuse to release it if the other gate still has a run-scoped
    // pending record: the decided record above could otherwise be unrelated
    // to the gate that actually paused this child.
    const otherApprovalName = gate === "judge" ? `${taskId}.json` : `${taskId}-judge.json`;
    const otherApprovalPath = path.join(logDir, "approvals", otherApprovalName);
    if (fs.existsSync(otherApprovalPath)) {
      let other: { state?: unknown; createdAt?: unknown };
      try {
        other = JSON.parse(fs.readFileSync(otherApprovalPath, "utf-8")) as typeof other;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot release ${taskId}'s approval pause: the other gate record is unreadable (${detail}).`,
        );
      }
      const otherCreatedAt =
        typeof other.createdAt === "string" ? new Date(other.createdAt).getTime() : Number.NaN;
      if (
        other.state === "pending" &&
        (!job ||
          !Number.isFinite(otherCreatedAt) ||
          startedAt === undefined ||
          otherCreatedAt >= startedAt)
      ) {
        throw new ApprovalDecisionConflictError(
          "other_gate_pending",
          `Cannot release ${taskId}'s approval pause: the other human gate remains pending for this run.`,
        );
      }
    }

    const resolution: ApprovalPauseResolution = Object.freeze({
      taskId,
      gate,
      expectedState,
      ...(job ? { job } : {}),
    });
    this.approvalPauseResolutions.set(taskId, resolution);
    return resolution;
  }

  /**
   * Get job by task ID (any status).
   */
  getJob(taskId: string): DispatchJob | undefined {
    return this.jobs.get(taskId);
  }

  /** Read-only observation; never restore historical attempts into admission state. */
  getDispatchObservation(identity: DispatchObservationIdentity):
    | {
        identity: DispatchObservationIdentity;
        job: DispatchJob | DispatchTerminalObservation["job"];
        settled: boolean;
        source: "memory" | "durable";
      }
    | undefined {
    if (
      !this.observationProjectId ||
      identity.projectId !== this.observationProjectId ||
      !this.observationStore
    ) {
      throw new Error("Dispatch observation project identity is unavailable");
    }
    const job = this.jobs.get(identity.taskId);
    const current = job ? dispatchObservationIdentity(this.observationProjectId, job) : undefined;
    if (job && current && sameDispatchObservationIdentity(current, identity)) {
      if (job.observationPersistenceError)
        throw new Error(
          `Durable dispatch observation unavailable: ${job.observationPersistenceError}`,
        );
      return {
        identity: { ...identity },
        job: { ...job, output: [...job.output] },
        settled: Boolean(job.completedAt),
        source: "memory",
      };
    }
    const stored = this.observationStore.read(identity);
    return stored
      ? { identity: stored.identity, job: stored.job, settled: true, source: "durable" }
      : undefined;
  }

  /** Whether a dispatch child, its stdio handles, or its async exit cleanup is still live. */
  hasLiveProcesses(): boolean {
    return (
      this.liveProcesses.size > 0 ||
      this.processes.size > 0 ||
      this.nodeLaunches.size > 0 ||
      this.pendingExitHandlers.size > 0
    );
  }

  /** Whether an accepted operator stop still has unproven recovery cleanup. */
  hasPendingOperatorStopCleanup(taskId?: string): boolean {
    if (taskId) {
      return (
        this.operatorStopCleanupPending.has(taskId) ||
        this.jobs.get(taskId)?.operatorStopCleanupPending === true
      );
    }
    return (
      this.operatorStopCleanupPending.size > 0 ||
      [...this.jobs.values()].some((job) => job.operatorStopCleanupPending === true)
    );
  }

  /** Wait for child close and exit cleanup, returning false instead of hanging forever. */
  waitForIdle(timeoutMs = 15_000): Promise<boolean> {
    if (!this.hasLiveProcesses()) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = (): void => finish(true);
      this.idleWaiters.add(onIdle);
      const timer = setTimeout(() => finish(false), timeoutMs);

      // Avoid missing a close or handler completion between the initial check
      // and waiter registration.
      if (!this.hasLiveProcesses()) finish(true);
    });
  }

  /**
   * Clean up completed/failed jobs older than the given age.
   */
  cleanup(maxAgeMs = 3600000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [taskId, job] of this.jobs) {
      // Retry a failed diagnostic write, retaining the original completion time.
      this.recordTerminalObservation(job);
      // Don't clean up awaiting_approval jobs — worktree has agent commits
      const ownsInterruptedSharedCheckout =
        this.isolationConfig?.method !== "docker" &&
        !job.worktreePath &&
        job.status !== "completed";
      if (
        job.status !== "running" &&
        job.status !== "awaiting_approval" &&
        job.operatorStopCleanupPending !== true &&
        !this.operatorStopCleanupPending.has(taskId) &&
        !ownsInterruptedSharedCheckout &&
        !job.observationPersistenceError &&
        job.completedAt !== undefined &&
        new Date(job.completedAt).getTime() < cutoff
      ) {
        this.jobs.delete(taskId);
      }
    }
  }

  /**
   * Start a watchdog timer that kills dispatch processes running longer than
   * the given timeout. Checks every 60 seconds. Prevents hung dispatches
   * from consuming resources indefinitely (e.g. when the SDK async generator
   * fails to signal completion).
   */
  startWatchdog(timeoutMs = DEFAULT_WATCHDOG_TIMEOUT_MS): void {
    if (this.watchdogTimer) return; // Already running
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [taskId, job] of this.jobs) {
        if (job.status !== "running") continue;
        const elapsed = now - new Date(job.startedAt).getTime();
        if (elapsed > timeoutMs) {
          job.output.push(
            `[watchdog] Stopping stuck dispatch after ${Math.round(elapsed / 60000)}min`,
          );
          // A watchdog stop has the same safety requirements as an operator
          // stop: terminate the owned tree, recover only validated quarantine
          // state, and keep same-task admission blocked until that completes.
          if (!this.stop(taskId)) {
            job.output.push(
              "[watchdog] Stop requested, but durable process-tree termination remains unconfirmed.",
            );
          }
        }
      }
    }, 60_000);
    this.watchdogTimer.unref(); // Don't keep the process alive
  }

  /**
   * Stop the watchdog timer.
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private processGroupExists(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      return code === "EPERM";
    }
  }

  private hasConfirmedWindowsTreeKill(job: DispatchJob): boolean {
    return this.confirmedWindowsTreeKills.get(job.taskId) === job.sessionId;
  }

  private hasLiveStopProcessGroup(taskId: string): boolean {
    if (this.unconfirmedProcessGroups.has(taskId)) return true;
    const pending = this.stopEscalationTimers.get(taskId);
    return Boolean(pending?.processGroupId && this.processGroupExists(pending.processGroupId));
  }

  /**
   * A detached POSIX root can exit while one of its descendants keeps the
   * process group (and checkout) alive. Register that group before exposing a
   * terminal job state so cleanup or another dispatch cannot race the orphan.
   */
  private retainLingeringProcessGroup(
    taskId: string,
    child: ChildProcess,
    job: DispatchJob,
  ): boolean {
    if (job.containerId || !child.pid || process.platform === "win32") return false;
    if (!this.processGroupExists(child.pid)) return false;

    if (!job.stopRequestedAt) {
      job.stopRequestedAt = new Date().toISOString();
      job.output.push(
        `[dispatch] Root process exited while process group ${child.pid} remained alive; ` +
          `preserving recovery state for explicit reconciliation.`,
      );
    }
    // Once the root exits, its numeric process-group id is no longer tied to
    // this ChildProcess identity. Cancel any delayed escalation before it can
    // signal a subsequently recycled PGID, and retain durable evidence instead.
    this.retainUnconfirmedProcessGroup(taskId, child.pid);
    return true;
  }

  private clearStopEscalation(taskId: string, force = false): void {
    const pending = this.stopEscalationTimers.get(taskId);
    if (!pending) return;
    if (!force && pending.processGroupId && this.processGroupExists(pending.processGroupId)) {
      return;
    }
    clearTimeout(pending.timer);
    this.stopEscalationTimers.delete(taskId);
  }

  /**
   * Keep a timed-out POSIX group visible to admission/resume until an operator
   * reconciles its durable evidence. Never signal or poll the numeric ID from
   * this point onward because the original process group is no longer bound to
   * a live ChildProcess handle and the OS may recycle the ID.
   */
  private retainUnconfirmedProcessGroup(taskId: string, processGroupId: number): void {
    this.clearStopEscalation(taskId, true);
    if (this.unconfirmedProcessGroups.get(taskId) === processGroupId) return;
    this.unconfirmedProcessGroups.set(taskId, processGroupId);
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.stopRequestedAt ??= new Date().toISOString();
    if (job.worktreePath) {
      this.updateWorktreeOwnership(job, "stopping", processGroupId);
      try {
        this.persistWorktreeSurvivor(job, processGroupId);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        job.output.push(
          `[dispatch] Could not persist worktree survivor evidence (${detail}); in-process admission remains blocked.`,
        );
      }
    } else if (this.isolationConfig?.method !== "docker") {
      this.preserveInterruptedSharedCheckout(job, "running");
    }
  }

  private isPosixRootIdentityLive(taskId: string, child: ChildProcess): boolean {
    return (
      this.processes.get(taskId) === child && child.exitCode == null && child.signalCode == null
    );
  }

  private scheduleForcedTreeTermination(
    taskId: string,
    child: ChildProcess,
    delayMs: number,
  ): void {
    if (this.unconfirmedProcessGroups.has(taskId)) return;
    this.clearStopEscalation(taskId, true);
    const job = this.jobs.get(taskId);
    const processGroupId =
      process.platform !== "win32" && !job?.containerId && child.pid ? child.pid : undefined;
    const timer = setTimeout(() => {
      if (processGroupId && !this.isPosixRootIdentityLive(taskId, child)) {
        this.retainUnconfirmedProcessGroup(taskId, processGroupId);
        return;
      }
      const stillPresent = processGroupId
        ? this.processGroupExists(processGroupId)
        : this.processes.get(taskId) === child;
      if (stillPresent) {
        try {
          if (processGroupId) {
            process.kill(-processGroupId, "SIGKILL");
          } else {
            this.signalProcessTree(taskId, child, "SIGKILL", 1_000);
          }
        } catch {
          // Retain lifecycle evidence; bounded shutdown reports a survivor.
        }
      }
      if (!processGroupId) {
        this.clearStopEscalation(taskId, true);
        return;
      }

      // SIGKILL delivery is asynchronous. Keep the group registered as active
      // until its absence is observable so admission cannot race the kill.
      const deadline = Date.now() + 1_000;
      const confirmExit = (): void => {
        if (!this.processGroupExists(processGroupId)) {
          this.clearStopEscalation(taskId, true);
          const currentJob = this.jobs.get(taskId);
          if (currentJob?.stopRequestedAt && currentJob.status === "running") {
            currentJob.status = "stopped";
            this.preserveInterruptedSharedCheckout(currentJob, "stopped");
          }
          if (currentJob) this.clearWorktreeSurvivor(currentJob);
          return;
        }
        if (Date.now() >= deadline) {
          const currentJob = this.jobs.get(taskId);
          currentJob?.output.push(
            `[dispatch] Process group ${processGroupId} did not exit after forced termination; admission remains blocked pending explicit reconciliation.`,
          );
          this.retainUnconfirmedProcessGroup(taskId, processGroupId);
          return;
        }
        const confirmationTimer = setTimeout(confirmExit, 25);
        confirmationTimer.unref();
        this.stopEscalationTimers.set(taskId, {
          timer: confirmationTimer,
          processGroupId,
        });
      };
      confirmExit();
    }, delayMs);
    timer.unref();
    this.stopEscalationTimers.set(taskId, { timer, processGroupId });
  }

  private signalProcessTree(
    taskId: string,
    child: ChildProcess,
    signal: NodeJS.Signals,
    windowsTimeoutMs: number,
  ): void {
    const job = this.jobs.get(taskId);
    const unconfirmedProcessGroupId = this.unconfirmedProcessGroups.get(taskId);
    if (unconfirmedProcessGroupId !== undefined) {
      throw new Error(
        `Refusing to re-signal unconfirmed process group for ${taskId}; its numeric ID may have been recycled`,
      );
    }
    if (process.platform === "win32") {
      const launch = this.nodeLaunches.get(taskId);
      if (launch?.windowsJob) {
        const result = terminateWindowsNodeJob(launch.windowsJob);
        if (!result.confirmed && !confirmWindowsNodeLaunchAlreadyExited(launch)) {
          throw new Error(result.warning ?? `Windows process-tree shutdown failed for ${taskId}`);
        }
        if (job) this.confirmedWindowsTreeKills.set(taskId, job.sessionId);
        return;
      }
      if (!child.pid) {
        child.kill(signal);
        return;
      }
      if (this.attemptedWindowsTreeKills.has(child)) {
        throw new Error(
          `Refusing to retry Windows process-tree shutdown for ${taskId}; its numeric PID may have been recycled`,
        );
      }
      this.attemptedWindowsTreeKills.add(child);
      const taskkillPath = resolveWindowsTaskkillPath(process.env, this.projectRoot);
      const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.WINDIR;
      execFileSync(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], {
        cwd: path.dirname(taskkillPath),
        env: {
          PATH: path.dirname(taskkillPath),
          ...(systemRoot ? { SYSTEMROOT: systemRoot, WINDIR: systemRoot } : {}),
        },
        stdio: "ignore",
        windowsHide: true,
        timeout: Math.max(1, windowsTimeoutMs),
      });
      if (job) this.confirmedWindowsTreeKills.set(taskId, job.sessionId);
    } else if (!job?.containerId && child.pid) {
      if (!this.isPosixRootIdentityLive(taskId, child)) {
        this.retainUnconfirmedProcessGroup(taskId, child.pid);
        throw new Error(
          `Refusing to signal process group for ${taskId} after its root identity was lost`,
        );
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Compatibility for a child created before process-group isolation was
        // enabled, or for platforms that reject negative group PIDs.
        child.kill(signal);
      }
    } else {
      child.kill(signal);
    }
  }

  /**
   * Stop dispatch children without deleting their worktrees. Every tracked
   * process, pending Docker admission, and durable survivor participates in a
   * bounded shutdown so fleet admission cannot reopen early.
   */
  async shutdownAll(options: DispatchShutdownOptions = {}): Promise<DispatchShutdownResult> {
    this.shutdownInProgress = true;
    const gracefulTimeoutMs = Math.max(0, options.gracefulTimeoutMs ?? 1_000);
    const forceTimeoutMs = Math.max(0, options.forceTimeoutMs ?? 1_000);
    const tracked = Array.from(this.processes, ([taskId, child]) => ({
      taskId,
      child,
      job: this.jobs.get(taskId),
    }));
    const pendingDockerStarts = Array.from(this.pendingDockerStarts, ([taskId, promise]) => ({
      taskId,
      promise,
    }));
    const trackedDockerTasks = this.getDockerUnresolvedContainers().map(
      (container) => container.taskId,
    );
    const pendingProcessGroups = Array.from(this.stopEscalationTimers, ([taskId, pending]) => ({
      taskId,
      processGroupId: pending.processGroupId,
    })).filter(
      (entry): entry is { taskId: string; processGroupId: number } =>
        entry.processGroupId !== undefined,
    );
    const unconfirmedProcessGroups = Array.from(
      this.unconfirmedProcessGroups,
      ([taskId, processGroupId]) => ({ taskId, processGroupId }),
    );
    const trackedIds = new Set(tracked.map(({ taskId }) => taskId));
    const retainedProcessGroupTasks = new Set([
      ...pendingProcessGroups.map(({ taskId }) => taskId),
      ...unconfirmedProcessGroups.map(({ taskId }) => taskId),
    ]);
    const pendingRecoveryJobs = Array.from(
      new Map(
        [
          ...this.operatorStopCleanupPending.values(),
          ...Array.from(this.jobs.values()).filter(
            (job) => job.operatorStopCleanupPending === true,
          ),
        ].map((job) => [job.taskId, job] as const),
      ).values(),
    ).filter((job) => !trackedIds.has(job.taskId));
    const pendingWithoutChild = Array.from(this.jobs.values()).filter(
      (job) =>
        !trackedIds.has(job.taskId) &&
        !pendingRecoveryJobs.some((pending) => pending.taskId === job.taskId) &&
        (job.status === "awaiting_approval" ||
          (job.status === "running" && !retainedProcessGroupTasks.has(job.taskId))),
    );
    const requested = Array.from(
      new Set([
        ...tracked.map(({ taskId }) => taskId),
        ...pendingWithoutChild.map((job) => job.taskId),
        ...pendingDockerStarts.map(({ taskId }) => taskId),
        ...pendingProcessGroups.map(({ taskId }) => taskId),
        ...unconfirmedProcessGroups.map(({ taskId }) => taskId),
        ...trackedDockerTasks,
        ...pendingRecoveryJobs.map((job) => job.taskId),
      ]),
    );
    this.dockerManager?.abortPendingCommands();
    const escalated: string[] = [];
    const stopRequestedAt = new Date().toISOString();
    for (const entry of tracked) {
      if (entry.job) {
        entry.job.stopRequestedAt = stopRequestedAt;
        if (entry.job.worktreePath) {
          this.updateWorktreeOwnership(entry.job, "stopping", entry.child.pid ?? entry.job.pid);
        }
      }
      this.clearStopEscalation(entry.taskId, true);
    }
    for (const entry of pendingProcessGroups) {
      this.clearStopEscalation(entry.taskId, true);
    }
    const recoveryAttempts: Promise<boolean>[] = [];
    for (const job of pendingRecoveryJobs) {
      this.retryPendingOperatorStop(job);
      const recovery = this.operatorStopRecoveryInFlight.get(job.taskId);
      if (recovery) recoveryAttempts.push(recovery);
    }

    // Approval-paused jobs have no child handle. Their durable ownership
    // records continue protecting recoverable work across restart.
    for (const job of pendingWithoutChild) {
      if (job.status === "running" || job.status === "awaiting_approval") {
        job.stopRequestedAt = stopRequestedAt;
        job.status = "stopped";
        if (job.worktreePath) {
          job.output.push(
            `[worktree] Preserved ${job.worktreePath} — task stopped, branch retained for recovery`,
          );
        } else if (this.isolationConfig?.method !== "docker") {
          this.preserveInterruptedSharedCheckout(job, "stopped");
        }
      }
    }

    const usesPosixGroup = (entry: (typeof tracked)[number]): boolean =>
      process.platform !== "win32" && !entry.job?.containerId;
    const hasExited = (entry: (typeof tracked)[number]): boolean => {
      const childExited = entry.child.exitCode !== null || entry.child.signalCode !== null;
      const lifecycleRecorded = this.processes.get(entry.taskId) !== entry.child;
      if (!entry.child.pid) return lifecycleRecorded;
      if (process.platform === "win32" && !entry.job?.containerId) {
        return (
          childExited &&
          lifecycleRecorded &&
          entry.job !== undefined &&
          this.hasConfirmedWindowsTreeKill(entry.job)
        );
      }
      if (!usesPosixGroup(entry)) return childExited && lifecycleRecorded;
      try {
        process.kill(-entry.child.pid, 0);
        return false;
      } catch (error: unknown) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        return code === "ESRCH" && childExited && lifecycleRecorded;
      }
    };
    const waitForExit = async (
      entries: Array<(typeof tracked)[number]>,
      timeoutMs: number,
    ): Promise<Array<(typeof tracked)[number]>> => {
      const deadline = Date.now() + timeoutMs;
      let remaining = entries.filter((entry) => !hasExited(entry));
      while (remaining.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        remaining = entries.filter((entry) => !hasExited(entry));
      }
      return remaining;
    };
    const signalTrackedTree = (entry: (typeof tracked)[number], signal: NodeJS.Signals): void => {
      try {
        this.signalProcessTree(entry.taskId, entry.child, signal, forceTimeoutMs);
      } catch {
        // A concurrent natural exit is handled by the evidence check below.
      }
    };

    const settledDockerStarts = new Set<string>();
    const pendingDockerWait = (async (): Promise<string[]> => {
      if (pendingDockerStarts.length === 0) return [];
      const allSettled = Promise.all(
        pendingDockerStarts.map(({ taskId, promise }) =>
          promise.finally(() => {
            settledDockerStarts.add(taskId);
          }),
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          allSettled,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, gracefulTimeoutMs + forceTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return pendingDockerStarts
        .filter(({ taskId }) => !settledDockerStarts.has(taskId))
        .map(({ taskId }) => taskId);
    })();
    // A timer-only PGID has outlived the root ChildProcess identity that made
    // the number trustworthy. Never signal or poll it during shutdown: retain
    // it as unresolved evidence for tokened operator reconciliation. Entries
    // still backed by a tracked child are handled by signalTrackedTree below.
    const unboundPendingProcessGroups = pendingProcessGroups.filter((entry) => {
      const trackedEntry = tracked.find(
        (candidate) =>
          candidate.taskId === entry.taskId && candidate.child.pid === entry.processGroupId,
      );
      return !trackedEntry || !this.isPosixRootIdentityLive(entry.taskId, trackedEntry.child);
    });
    for (const entry of unboundPendingProcessGroups) {
      this.retainUnconfirmedProcessGroup(entry.taskId, entry.processGroupId);
    }
    const pendingGroupWait = Promise.resolve(
      unboundPendingProcessGroups.map(({ taskId }) => taskId),
    );

    const pendingRecoveryWait = (async (): Promise<string[]> => {
      if (recoveryAttempts.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled(recoveryAttempts),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, gracefulTimeoutMs + forceTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return pendingRecoveryJobs
        .filter((job) => this.hasPendingOperatorStopCleanup(job.taskId))
        .map((job) => job.taskId);
    })();

    let remaining = tracked;
    if (process.platform === "win32") {
      for (const entry of remaining) {
        escalated.push(entry.taskId);
        signalTrackedTree(entry, "SIGKILL");
      }
    } else {
      for (const entry of remaining) signalTrackedTree(entry, "SIGTERM");
      remaining = await waitForExit(remaining, gracefulTimeoutMs);
      for (const entry of remaining) {
        escalated.push(entry.taskId);
        signalTrackedTree(entry, "SIGKILL");
      }
    }

    remaining = await waitForExit(remaining, forceTimeoutMs);
    const pendingDockerTimedOut = await pendingDockerWait;
    const pendingGroupTimedOut = await pendingGroupWait;
    const pendingRecoveryTimedOut = await pendingRecoveryWait;
    let dockerCleanupTimedOut: string[] = [];
    let dockerCleanupRemoved: string[] = [];
    if (this.dockerManager) {
      const cleanupTaskIds = Array.from(
        new Set([
          ...trackedDockerTasks,
          ...pendingDockerStarts.map(({ taskId }) => taskId),
          ...this.getDockerUnresolvedContainers().map((container) => container.taskId),
        ]),
      );
      const cleanup = this.dockerManager.cleanupAll().then(
        (result) => ({ kind: "complete" as const, result }),
        () => ({ kind: "failed" as const }),
      );
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cleanupOutcome = await Promise.race([
          cleanup,
          new Promise<{ kind: "timeout" }>((resolve) => {
            cleanupTimer = setTimeout(() => resolve({ kind: "timeout" }), forceTimeoutMs);
          }),
        ]);
        dockerCleanupTimedOut =
          cleanupOutcome.kind === "complete" ? cleanupOutcome.result.failedTaskIds : cleanupTaskIds;
        dockerCleanupRemoved =
          cleanupOutcome.kind === "complete" ? cleanupOutcome.result.removedTaskIds : [];
        if (cleanupOutcome.kind === "timeout") this.dockerManager.abortPendingCommands();
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }

    const timedOut = Array.from(
      new Set([
        ...remaining.map(({ taskId }) => taskId),
        ...pendingDockerTimedOut,
        ...pendingGroupTimedOut,
        ...this.unconfirmedProcessGroups.keys(),
        ...pendingRecoveryTimedOut,
        ...dockerCleanupTimedOut,
      ]),
    );
    const timedOutSet = new Set(timedOut);
    for (const taskId of dockerCleanupRemoved) {
      const job = this.jobs.get(taskId);
      if (job) this.clearWorktreeSurvivor(job, true);
    }
    for (const taskId of timedOutSet) {
      const job = this.jobs.get(taskId);
      if (!job || job.containerId) continue;
      const processId =
        tracked.find((entry) => entry.taskId === taskId)?.child.pid ??
        pendingProcessGroups.find((entry) => entry.taskId === taskId)?.processGroupId ??
        unconfirmedProcessGroups.find((entry) => entry.taskId === taskId)?.processGroupId;
      if (!processId) continue;
      try {
        if (job.worktreePath) this.persistWorktreeSurvivor(job, processId);
        else this.persistSharedCheckoutPause(job, "running");
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        job.output.push(
          `[dispatch] Could not persist shutdown survivor evidence (${detail}); in-process admission remains blocked.`,
        );
      }
    }
    const exited = requested.filter((taskId) => !timedOutSet.has(taskId));
    for (const taskId of exited) {
      const job = this.jobs.get(taskId);
      const trackedEntry = tracked.find((entry) => entry.taskId === taskId);
      if (trackedEntry && hasExited(trackedEntry)) {
        this.unconfirmedProcessGroups.delete(taskId);
      }
      if (job) this.clearWorktreeSurvivor(job);
    }
    for (const { taskId, processGroupId } of pendingProcessGroups) {
      if (timedOutSet.has(taskId)) {
        const trackedEntry = tracked.find(
          (entry) => entry.taskId === taskId && entry.child.pid === processGroupId,
        );
        // A still-live tracked root keeps the PGID bound to the original
        // ChildProcess identity, so a later bounded shutdown may safely retry
        // it. Promote only timer-only evidence to the no-re-signal state.
        if (!trackedEntry || !this.isPosixRootIdentityLive(taskId, trackedEntry.child)) {
          this.retainUnconfirmedProcessGroup(taskId, processGroupId);
        }
        const job = this.jobs.get(taskId);
        if (job) this.preserveInterruptedSharedCheckout(job, "running");
        continue;
      }
      const job = this.jobs.get(taskId);
      if (job?.stopRequestedAt && job.status === "running") {
        job.status = "stopped";
        this.preserveInterruptedSharedCheckout(job, "stopped");
      }
    }

    const worktreeSurvivors = this.readWorktreeShutdownSurvivors();
    const sharedCheckoutSurvivor = this.readSharedCheckoutPause();
    const durableAccountingComplete = timedOut.every((taskId) => {
      const job = this.jobs.get(taskId);
      // Docker and pending-create recovery has separate accounting which this
      // result does not yet attest. Refuse to authorize a hard parent exit.
      if (!job || job.containerId) return false;
      if (job.worktreePath) {
        if (!job.worktreeOwnershipId) return false;
        return worktreeSurvivors.some(
          (marker) =>
            marker.taskId === job.taskId &&
            marker.sessionId === job.sessionId &&
            marker.ownershipId === job.worktreeOwnershipId &&
            marker.worktreePath === job.worktreePath &&
            marker.state === "survivor" &&
            Number.isSafeInteger(marker.processId) &&
            Number(marker.processId) > 0,
        );
      }
      if (!job.sharedCheckoutOwnershipId) return false;
      return Boolean(
        sharedCheckoutSurvivor &&
        sharedCheckoutSurvivor.taskId === job.taskId &&
        sharedCheckoutSurvivor.sessionId === job.sessionId &&
        sharedCheckoutSurvivor.ownershipId === job.sharedCheckoutOwnershipId &&
        sharedCheckoutSurvivor.status === "running" &&
        Number.isSafeInteger(sharedCheckoutSurvivor.processId) &&
        Number(sharedCheckoutSurvivor.processId) > 0,
      );
    });

    return { requested, exited, escalated, timedOut, durableAccountingComplete };
  }

  /** Check whether every tracked shutdown resource has confirmed its exit. */
  canResumeAfterShutdown(): boolean {
    this.reconcileRunningJobs();
    const hasLiveGroup = Array.from(this.stopEscalationTimers.values()).some(
      ({ processGroupId }) => processGroupId && this.processGroupExists(processGroupId),
    );
    const hasUnconfirmedProcessGroup = this.unconfirmedProcessGroups.size > 0;
    const hasActiveContainer = this.getDockerUnresolvedContainers().length > 0;
    const sharedCheckoutOwner =
      this.isolationConfig?.method === "docker" ? undefined : this.readSharedCheckoutPause();
    const hasUnconfirmedSharedCheckoutTree =
      sharedCheckoutOwner !== undefined && this.durableSharedOwnerMayBeLive(sharedCheckoutOwner);
    const hasWorktreeSurvivor =
      this.getWorktreeShutdownSurvivors().length > 0 ||
      this.unreadableWorktreeSurvivorMarkers.size > 0;
    if (
      this.processes.size > 0 ||
      this.nodeLaunches.size > 0 ||
      this.pendingDockerStarts.size > 0 ||
      this.pendingExitHandlers.size > 0 ||
      this.hasPendingOperatorStopCleanup() ||
      hasLiveGroup ||
      hasUnconfirmedProcessGroup ||
      hasActiveContainer ||
      hasUnconfirmedSharedCheckoutTree ||
      hasWorktreeSurvivor
    ) {
      return false;
    }
    return true;
  }

  /** Re-open a manager after an operator explicitly resumes a stopped fleet. */
  resumeAfterShutdown(): boolean {
    if (!this.canResumeAfterShutdown()) return false;
    this.shutdownInProgress = false;
    return true;
  }

  /**
   * Stop all running processes through the same fail-closed tree/recovery
   * barrier as an individual operator stop.
   */
  killAll(): boolean {
    const activeTaskIds = new Set<string>([
      ...this.processes.keys(),
      ...this.operatorStopCleanupPending.keys(),
    ]);
    for (const [taskId, job] of this.jobs) {
      if (
        job.status === "running" ||
        job.status === "awaiting_approval" ||
        job.operatorStopCleanupPending === true
      ) {
        activeTaskIds.add(taskId);
      }
    }
    let allStopped = true;
    for (const taskId of activeTaskIds) {
      try {
        if (!this.stop(taskId)) allStopped = false;
      } catch {
        allStopped = false;
      }
    }
    return allStopped;
  }

  /**
   * Get active Docker containers (delegates to DockerManager).
   */
  getActiveContainers(): DockerContainer[] {
    return this.dockerManager?.getActiveContainers() ?? [];
  }

  /**
   * Clean up all Docker containers (for emergency stop).
   * No-op if Docker isolation is not active.
   */
  async cleanupAllContainers(): Promise<{
    removedTaskIds: string[];
    failedTaskIds: string[];
  }> {
    if (!this.dockerManager) return { removedTaskIds: [], failedTaskIds: [] };
    await this.ensureDockerOwnershipReconciled();
    const result = await this.dockerManager.cleanupAll({ includeRetained: true });
    this.releaseAbsentDockerWorktreeOwnership();
    return { removedTaskIds: result.removedTaskIds, failedTaskIds: result.failedTaskIds };
  }
}
