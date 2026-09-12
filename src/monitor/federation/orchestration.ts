import * as fsPromises from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { loadAdapter, type ProjectAdapter } from "../../core/adapter-loader.js";
import { resolvePullRequestRepository } from "../../dispatcher/pr-creator.js";
import type { EventWriter } from "../event-emitter.js";
import {
  recordVerification,
  type RecordVerificationResult,
  type VerificationProjectionPersistenceStage,
} from "../verification-store.js";
import { readLatestByTaskIndex, type PersistedReviewBundle } from "../../review/docs-gate.js";
import { runVerifyWorkflow } from "../../workflows/verify-orchestrator.js";
import { broadcastWorkerRefreshCommand } from "./host.js";
import { federatedSessionId, queueFederatedJobRecord } from "./jobs.js";
import { federationNow } from "./lease.js";
import { terminalFederatedStatus } from "./status.js";
import { buildFederationClaimantIndex, releaseFederatedDependencyBlocks } from "./scheduling.js";
import {
  duplicateClaimantRefusalForIndex,
  type DuplicateClaimantIndex,
} from "../../core/duplicate-claimants.js";
import {
  runTrustedGitResult,
  type TrustedGitExecutionOptions,
  type TrustedGitHubRepository,
  type TrustedGitResult,
} from "../../worker/trusted-executable.js";
import {
  currentFederatedLockProcessIdentity,
  FederatedJobLockCompletedActionError,
  FederatedJobLockBusyError,
  federationDir,
  listFederatedJobs,
  loadFederatedJob,
  probeFederatedLockProcessIdentity,
  saveFederatedJob,
  updateFederatedJob,
  updateFederatedJobWithPostPersistEffect,
  withFederatedJobLock,
  type FederatedJobProcessIdentity,
} from "./store.js";
import type {
  FederatedCompletionOptions,
  FederatedJobRecord,
  FederatedMergeBinding,
  FederatedOrchestrationResult,
  FederationProjectContext,
} from "./types.js";

const FEDERATED_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/iu;
const FEDERATED_PUBLICATION_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FEDERATED_GIT_TIMEOUT_MS = 30_000;
const FEDERATED_GIT_MAX_BUFFER = 1024 * 1024;
const FEDERATED_MERGE_LOCK_STALE_MS = 10 * 60 * 1000;
const FEDERATED_MERGE_ADMISSION_LOCK_ID = "__federated-merge-admission__";
const FEDERATED_VERIFICATION_PROJECTION_LOCK_ID = "__federated-verification-projection__";
const FEDERATED_MERGE_OWNER_PREFIX = "merge.lock.owner.";
const FEDERATED_MERGE_RELEASE_PREFIX = "merge.lock.release.";
const FEDERATED_MERGE_RELEASE_QUARANTINE_PREFIX = "merge.lock.release-quarantine.";
const FEDERATED_MERGE_RECLAIM_QUARANTINE_PREFIX = "merge.lock.reclaim-quarantine.";
const FEDERATED_MERGE_FS_RETRY_MS = 10;
const FEDERATED_MERGE_FS_RETRY_TIMEOUT_MS = 1_000;
const FEDERATED_MERGE_ARTIFACT_SCAN_LIMIT = 16;
const FEDERATED_COMPLETION_EFFECT_DECISION_KEY = "federatedCompletionEffect";

interface FederatedMergeLockRuntime {
  linkPath: (source: string, destination: string) => Promise<void>;
  renamePath: (source: string, destination: string) => Promise<void>;
  unlinkPath: (target: string) => Promise<void>;
  syncDirectory: (directory: string) => Promise<void>;
  syncPublishedReleaseFile: (filePath: string) => Promise<void>;
  retryMs: number;
  retryTimeoutMs: number;
  afterSnapshotReadForTest?: (target: string) => void | Promise<void>;
}

let federatedMergeLockRuntimeForTests: Partial<FederatedMergeLockRuntime> | undefined;
const pendingProcessLocalMergeReleases = new Map<string, { jobId: string; ownerToken: string }>();
const federatedMergeOwnerScanCursors = new Map<string, string>();

/** @internal Deterministic filesystem-failure seam for merge-lock regressions. */
export function setFederatedMergeLockRuntimeForTests(
  runtime: Partial<FederatedMergeLockRuntime> | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Federation merge lock test runtime is unavailable outside tests");
  }
  federatedMergeLockRuntimeForTests = runtime ? { ...runtime } : undefined;
  if (!runtime) {
    pendingProcessLocalMergeReleases.clear();
    federatedMergeOwnerScanCursors.clear();
  }
}

function federatedMergeLockRuntime(): FederatedMergeLockRuntime {
  return {
    linkPath: federatedMergeLockRuntimeForTests?.linkPath ?? fsPromises.link,
    renamePath: federatedMergeLockRuntimeForTests?.renamePath ?? fsPromises.rename,
    unlinkPath: federatedMergeLockRuntimeForTests?.unlinkPath ?? fsPromises.unlink,
    syncDirectory:
      federatedMergeLockRuntimeForTests?.syncDirectory ?? syncFederatedMergeDirectoryBestEffort,
    syncPublishedReleaseFile:
      federatedMergeLockRuntimeForTests?.syncPublishedReleaseFile ??
      syncFederatedMergePublishedFile,
    retryMs: federatedMergeLockRuntimeForTests?.retryMs ?? FEDERATED_MERGE_FS_RETRY_MS,
    retryTimeoutMs:
      federatedMergeLockRuntimeForTests?.retryTimeoutMs ?? FEDERATED_MERGE_FS_RETRY_TIMEOUT_MS,
    afterSnapshotReadForTest: federatedMergeLockRuntimeForTests?.afterSnapshotReadForTest,
  };
}

function isFederatedMergeProcessIdentity(value: unknown): value is FederatedJobProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<FederatedJobProcessIdentity>;
  return (
    typeof identity.bootId === "string" &&
    identity.bootId.length > 0 &&
    typeof identity.startedAt === "string" &&
    identity.startedAt.length > 0
  );
}

export interface FederatedMergeBoundaryInput {
  projectRoot: string;
  taskId: string;
  sourceBranch: string;
  sourceCommitSha: string;
  targetBranch: string;
}

export interface FederatedMergeExecutionInput extends FederatedMergeBoundaryInput {
  binding: FederatedMergeBinding;
}

export type FederatedMergeResult =
  | { ok: true; commitSha: string; commands: number }
  | { ok: false; error: string; commands: number };

export interface FederatedMergeBoundary {
  seal: (input: FederatedMergeBoundaryInput) => Promise<FederatedMergeBinding>;
  merge: (input: FederatedMergeExecutionInput) => Promise<FederatedMergeResult>;
}

export interface FederationOrchestrationDeps {
  createWriter: (
    p: FederationProjectContext,
    workflowId: string,
    taskId: string,
    title: string,
  ) => EventWriter;
  /** Explicit publication seam used by deterministic route tests. */
  mergeBoundary?: FederatedMergeBoundary;
  /** Explicit notification seam used by deterministic concurrency tests. */
  broadcastRefresh?: typeof broadcastWorkerRefreshCommand;
  /** Explicit verification seam used to prove cancellation interleavings. */
  verifyWorkflow?: typeof runVerifyWorkflow;
  /** Internal deterministic seam for partial verified/dependency persistence. */
  releaseDependencyBlocks?: typeof releaseFederatedDependencyBlocks;
  /** Internal deterministic crash seam after a journaled local effect. */
  afterCompletionEffectForTest?: (
    stage:
      | "fix_intent_persisted"
      | "fix_parent_persisted"
      | "fix_child_persisted"
      | "verification_intent_persisted"
      | "verification_parent_persisted"
      | "verification_row_persisted"
      | "verification_status_persisted"
      | "verification_projection_persisted"
      | "verification_dependencies_persisted"
      | "verification_effects_persisted",
  ) => void | Promise<void>;
  /** Internal deterministic seam for concurrent verified projection writers. */
  afterVerificationProjectionReadForTest?: (taskId: string) => void | Promise<void>;
  /** Internal deterministic crash seam for verified projection publication. */
  afterVerificationProjectionPersistenceStageForTest?: (
    stage: VerificationProjectionPersistenceStage,
    taskId: string,
  ) => void | Promise<void>;
}

interface FederatedCompletionIntentBase {
  version: 1;
  effectId: string;
  parentJobId: string;
  taskId: string;
  correlationId: string;
  expectedUpdatedAt: string;
  expectedStatus: FederatedJobRecord["status"];
  parentRecord: FederatedJobRecord;
}

interface FederatedFixCompletionIntent extends FederatedCompletionIntentBase {
  kind: "fix";
  childRecord: FederatedJobRecord;
}

interface FederatedVerifiedCompletionIntent extends FederatedCompletionIntentBase {
  kind: "verified";
  verification: {
    commitSha?: string;
    criteriaChecked: number;
    criteriaPassed: number;
    reviewId?: string;
    workflowId: string;
    verifiedAt: string;
    updatedAt: string;
  };
}

type FederatedCompletionIntent = FederatedFixCompletionIntent | FederatedVerifiedCompletionIntent;

function completionIntentPath(projectRoot: string, jobId: string): string {
  const digest = createHash("sha256").update(jobId, "utf-8").digest("hex");
  return path.join(federationDir(projectRoot), `.completion-effect-${digest}.intent`);
}

function deterministicFixJobId(
  parentJobId: string,
  retryCount: number,
  workflowId: string,
): string {
  const digest = createHash("sha256")
    .update(`${parentJobId}\0fix\0${retryCount}\0${workflowId}`, "utf-8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(
    17,
    20,
  )}-${digest.slice(20, 32)}`;
}

function isFederatedJobShape(value: unknown): value is FederatedJobRecord {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Partial<FederatedJobRecord>;
  return (
    typeof job.jobId === "string" &&
    job.jobId.length > 0 &&
    typeof job.taskId === "string" &&
    job.taskId.length > 0 &&
    typeof job.correlationId === "string" &&
    job.correlationId.length > 0 &&
    typeof job.status === "string" &&
    typeof job.updatedAt === "string"
  );
}

function isCompletionIntent(value: unknown): value is FederatedCompletionIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Partial<FederatedCompletionIntent>;
  if (
    intent.version !== 1 ||
    typeof intent.effectId !== "string" ||
    intent.effectId.length === 0 ||
    (intent.kind !== "fix" && intent.kind !== "verified") ||
    typeof intent.parentJobId !== "string" ||
    typeof intent.taskId !== "string" ||
    typeof intent.correlationId !== "string" ||
    typeof intent.expectedUpdatedAt !== "string" ||
    typeof intent.expectedStatus !== "string" ||
    !isFederatedJobShape(intent.parentRecord) ||
    intent.parentRecord.jobId !== intent.parentJobId ||
    intent.parentRecord.taskId !== intent.taskId ||
    intent.parentRecord.correlationId !== intent.correlationId ||
    !hasCompletionEffectMarker(intent.parentRecord, {
      effectId: intent.effectId,
      kind: intent.kind,
    })
  ) {
    return false;
  }
  if (intent.kind === "fix") {
    const fixIntent = intent as Partial<FederatedFixCompletionIntent>;
    return (
      isFederatedJobShape(fixIntent.childRecord) &&
      fixIntent.childRecord.parentJobId === intent.parentJobId &&
      intent.parentRecord.fixJobIds?.includes(fixIntent.childRecord.jobId) === true
    );
  }
  const verification = (intent as Partial<FederatedVerifiedCompletionIntent>).verification;
  return Boolean(
    verification &&
    typeof verification.criteriaChecked === "number" &&
    Number.isFinite(verification.criteriaChecked) &&
    typeof verification.criteriaPassed === "number" &&
    Number.isFinite(verification.criteriaPassed) &&
    typeof verification.workflowId === "string" &&
    verification.workflowId.length > 0 &&
    typeof verification.verifiedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(verification.verifiedAt) &&
    typeof verification.updatedAt === "string" &&
    Number.isFinite(Date.parse(verification.updatedAt)),
  );
}

function completionEffectMarker(
  effectId: string,
  kind: FederatedCompletionIntent["kind"],
): { version: 1; effectId: string; kind: FederatedCompletionIntent["kind"] } {
  return { version: 1, effectId, kind };
}

function withCompletionEffectMarker(
  record: FederatedJobRecord,
  effectId: string,
  kind: FederatedCompletionIntent["kind"],
): FederatedJobRecord {
  return {
    ...record,
    decision: {
      ...record.decision,
      [FEDERATED_COMPLETION_EFFECT_DECISION_KEY]: completionEffectMarker(effectId, kind),
    },
  };
}

function hasCompletionEffectMarker(
  record: FederatedJobRecord,
  intent: Pick<FederatedCompletionIntent, "effectId" | "kind">,
): boolean {
  const marker = record.decision[FEDERATED_COMPLETION_EFFECT_DECISION_KEY];
  if (typeof marker !== "object" || marker === null) return false;
  const candidate = marker as { version?: unknown; effectId?: unknown; kind?: unknown };
  return (
    candidate.version === 1 &&
    candidate.effectId === intent.effectId &&
    candidate.kind === intent.kind
  );
}

async function readCompletionIntent(
  projectRoot: string,
  jobId: string,
): Promise<FederatedCompletionIntent | undefined> {
  const target = completionIntentPath(projectRoot, jobId);
  try {
    const value: unknown = JSON.parse(await fsPromises.readFile(target, "utf-8"));
    if (!isCompletionIntent(value) || value.parentJobId !== jobId) {
      throw new Error(`Federation completion intent is malformed: ${target}`);
    }
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function publishCompletionIntent(
  projectRoot: string,
  intent: FederatedCompletionIntent,
): Promise<void> {
  const dir = federationDir(projectRoot);
  const target = completionIntentPath(projectRoot, intent.parentJobId);
  const serialized = `${JSON.stringify(intent)}\n`;
  await fsPromises.mkdir(dir, { recursive: true });
  try {
    const existing = await fsPromises.readFile(target, "utf-8");
    if (existing !== serialized) {
      throw new Error(
        `A different federation completion intent already exists for ${intent.parentJobId}`,
      );
    }
    const existingHandle = await fsPromises.open(target, "r+");
    try {
      await existingHandle.sync();
    } finally {
      await existingHandle.close();
    }
    await syncFederatedMergeDirectoryBestEffort(dir);
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staging = `${target}.publish.${process.pid}.${randomUUID()}`;
  const handle = await fsPromises.open(staging, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await fsPromises.link(staging, target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fsPromises.readFile(target, "utf-8");
      if (existing !== serialized) throw error;
    }
    // A directory fsync is unavailable through Node on Windows. Reopen the
    // published link itself and flush it before any parent transition can be
    // admitted; a failure leaves the intent in place or the old parent state
    // eligible to recreate it on replay.
    const publishedHandle = await fsPromises.open(target, "r+");
    try {
      await publishedHandle.sync();
    } finally {
      await publishedHandle.close();
    }
    await syncFederatedMergeDirectoryBestEffort(dir);
  } finally {
    await fsPromises.unlink(staging).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function retireCompletionIntent(projectRoot: string, jobId: string): Promise<void> {
  const target = completionIntentPath(projectRoot, jobId);
  try {
    await fsPromises.unlink(target);
    await syncFederatedMergeDirectoryBestEffort(path.dirname(target));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sameCompletionParentState(
  current: FederatedJobRecord,
  intent: FederatedCompletionIntent,
): boolean {
  const expected = intent.parentRecord;
  return (
    current.jobId === expected.jobId &&
    current.taskId === expected.taskId &&
    current.correlationId === expected.correlationId &&
    current.status === expected.status &&
    current.updatedAt === expected.updatedAt &&
    current.error === expected.error &&
    current.nextAction === expected.nextAction &&
    current.verificationWorkflowId === expected.verificationWorkflowId &&
    JSON.stringify(current.fixJobIds ?? []) === JSON.stringify(expected.fixJobIds ?? []) &&
    hasCompletionEffectMarker(current, intent)
  );
}

function completionIntentCanAdvance(
  current: FederatedJobRecord,
  intent: FederatedCompletionIntent,
): boolean {
  return (
    current.jobId === intent.parentJobId &&
    current.taskId === intent.taskId &&
    current.correlationId === intent.correlationId &&
    current.status === intent.expectedStatus &&
    current.updatedAt === intent.expectedUpdatedAt
  );
}

function completionIntentWasCanceled(status: FederatedJobRecord["status"]): boolean {
  return status === "canceled" || status === "failed" || status === "rejected";
}

async function persistFixChildIntent(
  projectRoot: string,
  intent: FederatedFixCompletionIntent,
  cancel: boolean,
  materializeCanceledChild = false,
): Promise<FederatedJobRecord | undefined> {
  const existing = await loadFederatedJob(projectRoot, intent.childRecord.jobId);
  if (existing) {
    if (
      existing.parentJobId !== intent.parentJobId ||
      existing.taskId !== intent.childRecord.taskId ||
      existing.correlationId !== intent.childRecord.correlationId ||
      existing.jobType !== "fix"
    ) {
      throw new Error(`Federation fix intent child identity changed: ${intent.childRecord.jobId}`);
    }
    if (!cancel || terminalFederatedStatus(existing.status)) return existing;
    const canceled = await updateFederatedJob(projectRoot, existing.jobId, (current) => {
      if (
        current.parentJobId !== intent.parentJobId ||
        current.taskId !== intent.childRecord.taskId ||
        current.correlationId !== intent.childRecord.correlationId ||
        terminalFederatedStatus(current.status)
      ) {
        return undefined;
      }
      return {
        ...current,
        status: "canceled",
        error: "parent_completion_canceled",
        nextAction: "none",
        updatedAt: federationNow(),
      };
    });
    return canceled.record ?? existing;
  }
  if (cancel) {
    if (!materializeCanceledChild) return undefined;
    const canceledChild: FederatedJobRecord = {
      ...intent.childRecord,
      status: "canceled",
      error: "parent_completion_canceled",
      nextAction: "none",
      updatedAt: federationNow(),
    };
    await saveFederatedJob(projectRoot, canceledChild);
    return canceledChild;
  }
  await saveFederatedJob(projectRoot, intent.childRecord);
  return intent.childRecord;
}

class CompletionIntentVerificationPendingError extends Error {}

export class CompletionIntentVerificationConflictError extends Error {}

async function applyCompletionIntentEffect(
  p: FederationProjectContext & { projectRoot: string },
  intent: FederatedCompletionIntent,
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<{ fixJob?: FederatedJobRecord }> {
  if (intent.kind === "fix") {
    await deps.afterCompletionEffectForTest?.("fix_parent_persisted");
    const fixJob = await persistFixChildIntent(p.projectRoot, intent, false);
    await deps.afterCompletionEffectForTest?.("fix_child_persisted");
    return { fixJob };
  }
  await deps.afterCompletionEffectForTest?.("verification_parent_persisted");
  const index = claimantIndex ?? (await buildFederationClaimantIndex(p));
  let result: Awaited<ReturnType<typeof recordFederatedVerifiedTask>>;
  try {
    result = await recordFederatedVerifiedTask({
      p,
      taskId: intent.taskId,
      commitSha: intent.verification.commitSha,
      criteriaChecked: intent.verification.criteriaChecked,
      criteriaPassed: intent.verification.criteriaPassed,
      reviewId: intent.verification.reviewId,
      workflowId: intent.verification.workflowId,
      verifiedAt: intent.verification.verifiedAt,
      updatedAt: intent.verification.updatedAt,
      claimantIndex: index,
      releaseDependencies: deps.releaseDependencyBlocks,
      afterVerificationEffectForTest: deps.afterCompletionEffectForTest,
      afterProjectionReadForTest: deps.afterVerificationProjectionReadForTest,
      afterProjectionPersistenceStageForTest:
        deps.afterVerificationProjectionPersistenceStageForTest,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      // Historical intents may predate the canonical evidence schema. Keep
      // their exact parent/intent bytes for explicit repair, while containing
      // this job's invalid proof so unrelated jobs can still reconcile.
      throw new CompletionIntentVerificationConflictError(
        `completion_intent_verification_conflict:invalid_verification_evidence job=${intent.parentJobId} task=${intent.taskId} effect=${intent.effectId}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (result.convergenceReason === "claimant-index-unavailable") {
    throw new CompletionIntentVerificationPendingError(
      `completion_intent_verification_pending:${result.convergenceReason ?? result.skippedReason ?? "not-converged"}`,
    );
  }
  if (!result.applied && result.skippedReason !== "identical") {
    throw new CompletionIntentVerificationConflictError(
      `completion_intent_verification_conflict:${result.skippedReason}`,
    );
  }
  if (!result.converged) {
    throw new CompletionIntentVerificationPendingError(
      `completion_intent_verification_pending:${result.convergenceReason ?? "not-converged"}`,
    );
  }
  await deps.afterCompletionEffectForTest?.("verification_effects_persisted");
  return {};
}

async function reconcileCompletionIntent(
  p: FederationProjectContext & { projectRoot: string },
  intent: FederatedCompletionIntent,
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedOrchestrationResult> {
  let fixJob: FederatedJobRecord | undefined;
  const result = await updateFederatedJobWithPostPersistEffect(
    p.projectRoot,
    intent.parentJobId,
    (current) => {
      if (
        current.jobId !== intent.parentJobId ||
        current.taskId !== intent.taskId ||
        current.correlationId !== intent.correlationId
      ) {
        throw new Error(
          `Federation completion intent parent identity changed: ${intent.parentJobId}`,
        );
      }
      if (completionIntentWasCanceled(current.status)) {
        const parentTransitionCommitted =
          hasCompletionEffectMarker(current, intent) ||
          (intent.kind === "fix" &&
            current.fixJobIds?.includes(intent.childRecord.jobId) === true) ||
          (intent.kind === "verified" && verifiedEffectMatchesIntent(p, intent));
        const canceledRecord =
          parentTransitionCommitted &&
          intent.kind === "fix" &&
          current.fixJobIds?.includes(intent.childRecord.jobId) !== true
            ? {
                ...current,
                fixJobIds: [...(current.fixJobIds ?? []), intent.childRecord.jobId],
              }
            : current;
        return {
          record: canceledRecord,
          effect: async () => {
            if (intent.kind === "fix") {
              fixJob = await persistFixChildIntent(
                p.projectRoot,
                intent,
                true,
                parentTransitionCommitted,
              );
            } else if (parentTransitionCommitted) {
              await applyCompletionIntentEffect(p, intent, deps, claimantIndex);
            }
            await retireCompletionIntent(p.projectRoot, intent.parentJobId);
          },
        };
      }
      const intended = sameCompletionParentState(current, intent);
      if (!intended && !completionIntentCanAdvance(current, intent)) {
        throw new Error(`Federation completion intent parent state changed: ${intent.parentJobId}`);
      }
      return {
        record: intended ? current : intent.parentRecord,
        effect: async () => {
          const effect = await applyCompletionIntentEffect(p, intent, deps, claimantIndex);
          fixJob = effect.fixJob;
          await retireCompletionIntent(p.projectRoot, intent.parentJobId);
        },
      };
    },
  );
  return { job: result.record ?? intent.parentRecord, ...(fixJob ? { fixJob } : {}) };
}

export function shouldReconcileFederatedJob(record: FederatedJobRecord): boolean {
  if (record.status === "canceled" || record.status === "failed" || record.status === "rejected") {
    return false;
  }
  return (
    (record.status === "blocked" || record.status === "completed") &&
    (record.blockReasonCode === "review_linkage_required" ||
      record.nextAction === "record_merge_ready_review" ||
      record.nextAction === "broadcast_worker_refresh" ||
      (record.nextAction === "merge_gate" &&
        record.autoMerge === true &&
        Boolean(record.branchName) &&
        Boolean(record.targetBranch) &&
        Boolean(record.commitSha && FEDERATED_COMMIT_PATTERN.test(record.commitSha))) ||
      record.error === "merge_gate_not_ready")
  );
}

export async function reconcileFederatedJob(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  options: Partial<FederatedCompletionOptions> = {},
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedOrchestrationResult> {
  return orchestrateFederatedCompletion(
    p,
    record,
    {
      autoVerify: options.autoVerify ?? true,
      autoMerge: options.autoMerge ?? record.autoMerge === true,
      targetBranch: options.targetBranch ?? record.targetBranch,
      branchName: options.branchName ?? record.branchName,
      commitSha: options.commitSha ?? record.commitSha,
      verification: options.verification ?? {
        reviewId: record.reviewId,
        requireReview: true,
      },
      maxFixAttempts: options.maxFixAttempts ?? record.maxRetries,
    },
    deps,
    claimantIndex,
  );
}

export async function reconcileFederatedJobs(
  p: FederationProjectContext,
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedJobRecord[]> {
  if (!p.projectRoot) return [];
  const strictIndex = claimantIndex ?? (await buildFederationClaimantIndex(p));
  const reconciled: FederatedJobRecord[] = [];
  for (const job of await listFederatedJobs(p.projectRoot)) {
    const pendingCompletion = await readCompletionIntent(p.projectRoot, job.jobId);
    if (!pendingCompletion && !shouldReconcileFederatedJob(job)) continue;
    // Completion intents carry enough durable identity to reconcile terminal
    // cancellation and exact already-recorded effects. Ordinary orchestration
    // remains fail-closed while the independent claimant scan is unavailable.
    if (strictIndex.status === "unavailable" && !pendingCompletion) continue;
    try {
      const result = await reconcileFederatedJob(p, job, {}, deps, strictIndex);
      reconciled.push(result.job);
    } catch (error: unknown) {
      // A concurrent cancellation or completion transition owns this job's
      // short ledger fence. Leave it untouched and continue reconciling the
      // rest of the queue; the next pass can retry this job.
      if (error instanceof FederatedJobLockBusyError) continue;
      // A durable verification intent that cannot currently converge belongs
      // to this job alone. Keep the intent for a later/operator-assisted pass
      // without allowing it to starve unrelated jobs in the same sweep.
      if (
        error instanceof CompletionIntentVerificationPendingError ||
        error instanceof CompletionIntentVerificationConflictError
      ) {
        continue;
      }
      if (
        strictIndex.status === "unavailable" &&
        error instanceof Error &&
        (error.message.includes("claimant-index-unavailable") ||
          error.message.startsWith("duplicate_claimants_unavailable:"))
      ) {
        continue;
      }
      throw error;
    }
  }
  return reconciled;
}

export async function latestReviewIdForTask(
  projectRoot: string,
  taskId: string,
): Promise<string | undefined> {
  const latestByTask = await readLatestByTaskIndex(projectRoot);
  return latestByTask[taskId];
}

export async function loadReviewBundle(
  projectRoot: string,
  reviewId: string | undefined,
): Promise<PersistedReviewBundle | undefined> {
  if (!reviewId) return undefined;
  try {
    const raw = await fsPromises.readFile(
      path.join(projectRoot, ".quack", "reviews", `${reviewId}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as PersistedReviewBundle;
  } catch {
    return undefined;
  }
}

export async function recordFederatedVerifiedTask(input: {
  p: FederationProjectContext;
  taskId: string;
  commitSha?: string;
  criteriaChecked: number;
  criteriaPassed: number;
  reviewId?: string;
  workflowId: string;
  verifiedAt?: string;
  updatedAt?: string;
  claimantIndex?: DuplicateClaimantIndex;
  releaseDependencies?: typeof releaseFederatedDependencyBlocks;
  afterVerificationEffectForTest?: (
    stage:
      | "verification_row_persisted"
      | "verification_status_persisted"
      | "verification_projection_persisted"
      | "verification_dependencies_persisted",
  ) => void | Promise<void>;
  afterProjectionReadForTest?: (taskId: string) => void | Promise<void>;
  afterProjectionPersistenceStageForTest?: (
    stage: VerificationProjectionPersistenceStage,
    taskId: string,
  ) => void | Promise<void>;
}): Promise<
  RecordVerificationResult & {
    converged: boolean;
    convergenceReason?: NonNullable<RecordVerificationResult["skippedReason"]>;
  }
> {
  const claimantIndex = input.claimantIndex ?? (await buildFederationClaimantIndex(input.p));
  const record = () =>
    recordVerification(
      input.p,
      {
        taskId: input.taskId,
        verdict: "VERIFIED",
        commitSha: input.commitSha ?? "unknown",
        method: "federated-orchestrator",
        criteriaChecked: input.criteriaChecked,
        criteriaPassed: input.criteriaPassed,
        reviewId: input.reviewId,
        workflowId: input.workflowId,
        verifiedAt: input.verifiedAt ?? federationNow().split("T")[0],
        updatedAt: input.updatedAt,
      },
      {
        syncToPeers: false,
        replayIdenticalEffects: true,
        afterLocalEffectForTest: input.afterVerificationEffectForTest,
        afterProjectionReadForTest: input.afterProjectionReadForTest,
        afterProjectionPersistenceStageForTest: input.afterProjectionPersistenceStageForTest,
      },
      claimantIndex,
    );
  // Parent jobs each have their own lifecycle fence. The projection is one
  // project-wide resource, so it needs an independent cross-process fence;
  // otherwise two valid parent completions can both read the old JSON and the
  // later write can erase its peer. Release this fence before dependency jobs
  // are touched so lock ordering remains parent -> projection -> dependent.
  const result = input.p.projectRoot
    ? await withFederatedJobLock(
        input.p.projectRoot,
        FEDERATED_VERIFICATION_PROJECTION_LOCK_ID,
        record,
      )
    : await record();
  const claimantRefusal = duplicateClaimantRefusalForIndex(claimantIndex, input.taskId);
  const convergenceReason = claimantRefusal
    ? claimantIndex.status === "unavailable"
      ? ("claimant-index-unavailable" as const)
      : ("duplicate-claimants" as const)
    : result.applied || result.skippedReason === "identical"
      ? undefined
      : result.skippedReason;
  const converged = convergenceReason === undefined;
  if (converged) {
    await (input.releaseDependencies ?? releaseFederatedDependencyBlocks)(
      input.p,
      input.taskId,
      claimantIndex,
    );
    await input.afterVerificationEffectForTest?.("verification_dependencies_persisted");
  }
  return {
    ...result,
    ...(result.refusal || claimantRefusal ? { refusal: result.refusal ?? claimantRefusal } : {}),
    converged,
    ...(convergenceReason ? { convergenceReason } : {}),
  };
}

function verifiedEffectMatchesIntent(
  p: FederationProjectContext,
  intent: FederatedVerifiedCompletionIntent,
): boolean {
  const row = p.db.getVerified(intent.taskId);
  const expectedCommit = intent.verification.commitSha ?? "unknown";
  const expectedNotes = [
    `workflowId=${intent.verification.workflowId}`,
    ...(intent.verification.reviewId ? [`reviewId=${intent.verification.reviewId}`] : []),
  ].join("; ");
  return Boolean(
    row &&
    row.task_id === intent.taskId &&
    row.verdict === "VERIFIED" &&
    row.method === "federated-orchestrator" &&
    row.commit_sha === expectedCommit &&
    row.criteria_checked === intent.verification.criteriaChecked &&
    row.criteria_passed === intent.verification.criteriaPassed &&
    row.verified_at === intent.verification.verifiedAt &&
    (row.updated_at ?? row.verified_at) === intent.verification.updatedAt &&
    (row.notes ?? "") === expectedNotes,
  );
}

export function assertSafeGitRef(value: string, label: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`${label} contains unsafe characters.`);
  }
}

function gitErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8").trim();
  }
  return String(err);
}

interface FederatedMergeRuntime {
  loadAdapter: (projectRoot: string) => Promise<ProjectAdapter>;
  resolveRepository: (adapter: ProjectAdapter) => Promise<TrustedGitHubRepository>;
  runGit: (
    projectRoot: string,
    args: readonly string[],
    options: TrustedGitExecutionOptions,
  ) => Promise<TrustedGitResult>;
  createWorktreePath: (input: FederatedMergeBoundaryInput) => string;
}

const defaultFederatedMergeRuntime: FederatedMergeRuntime = {
  loadAdapter,
  resolveRepository: resolvePullRequestRepository,
  runGit: runTrustedGitResult,
  createWorktreePath: (input) =>
    path.join(
      tmpdir(),
      `quack-fed-merge-${input.taskId.toLowerCase().replace(/[^a-z0-9_-]/gu, "-")}-${randomUUID()}`,
    ),
};

function sameRepository(left: TrustedGitHubRepository, right: TrustedGitHubRepository): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function trustedGitOptions(
  adapter: ProjectAdapter,
  expectedRepository?: TrustedGitHubRepository,
): TrustedGitExecutionOptions {
  return {
    timeoutMs: FEDERATED_GIT_TIMEOUT_MS,
    maxBuffer: FEDERATED_GIT_MAX_BUFFER,
    trustedBoundaryRoot: adapter.projectRoot,
    ...(adapter.trustedLocalReadRemotePaths
      ? { trustedLocalReadRemotePaths: adapter.trustedLocalReadRemotePaths }
      : {}),
    ...(expectedRepository ? { expectedRepository } : {}),
  };
}

function assertValidMergeBinding(binding: FederatedMergeBinding): void {
  assertSafeGitRef(binding.sourceBranch, "sourceBranch");
  assertSafeGitRef(binding.targetBranch, "targetBranch");
  if (!FEDERATED_COMMIT_PATTERN.test(binding.sourceCommitSha)) {
    throw new Error("Federation auto-merge requires one full source commit SHA.");
  }
  if (
    binding.version !== 1 ||
    !binding.repository.host ||
    !binding.repository.owner ||
    !binding.repository.repo ||
    !FEDERATED_PUBLICATION_NONCE_PATTERN.test(binding.publicationNonce) ||
    !Number.isFinite(Date.parse(binding.sealedAt))
  ) {
    throw new Error("Federation auto-merge binding is malformed.");
  }
}

function assertSameMergeIdentity(
  expected: FederatedMergeBinding,
  observed: FederatedMergeBinding,
): void {
  assertValidMergeBinding(expected);
  assertValidMergeBinding(observed);
  if (
    expected.sourceBranch !== observed.sourceBranch ||
    expected.sourceCommitSha.toLowerCase() !== observed.sourceCommitSha.toLowerCase() ||
    expected.targetBranch !== observed.targetBranch ||
    expected.publicationNonce !== observed.publicationNonce ||
    !sameRepository(expected.repository, observed.repository)
  ) {
    throw new Error("Federation auto-merge identity changed after it was sealed.");
  }
}

function federatedMergeIdentityConflict(
  record: FederatedJobRecord,
  sourceBranch: string,
  sourceCommitSha: string,
  targetBranch: string,
): string | undefined {
  if (record.branchName && record.branchName !== sourceBranch) return "source_branch_changed";
  if (record.commitSha && record.commitSha.toLowerCase() !== sourceCommitSha.toLowerCase()) {
    return "source_commit_changed";
  }
  if (record.targetBranch && record.targetBranch !== targetBranch) return "target_branch_changed";
  if (record.mergeBinding) {
    try {
      assertSameMergeIdentity(record.mergeBinding, {
        ...record.mergeBinding,
        sourceBranch,
        sourceCommitSha: sourceCommitSha.toLowerCase(),
        targetBranch,
      });
    } catch (error: unknown) {
      return gitErrorMessage(error);
    }
  }
  return undefined;
}

async function runFederatedGit(
  runtime: FederatedMergeRuntime,
  adapter: ProjectAdapter,
  projectRoot: string,
  args: readonly string[],
  expectedRepository?: TrustedGitHubRepository,
): Promise<TrustedGitResult> {
  return runtime.runGit(projectRoot, args, trustedGitOptions(adapter, expectedRepository));
}

/** Resolve and attest the exact remote source branch before any merge mutation. */
export async function sealFederatedMergeBinding(
  input: FederatedMergeBoundaryInput,
  runtime: FederatedMergeRuntime = defaultFederatedMergeRuntime,
): Promise<FederatedMergeBinding> {
  assertSafeGitRef(input.sourceBranch, "sourceBranch");
  assertSafeGitRef(input.targetBranch, "targetBranch");
  if (!FEDERATED_COMMIT_PATTERN.test(input.sourceCommitSha)) {
    throw new Error("Federation auto-merge requires one full source commit SHA.");
  }
  const adapter = await runtime.loadAdapter(input.projectRoot);
  const repository = await runtime.resolveRepository(adapter);
  const remoteRef = `refs/remotes/origin/${input.sourceBranch}`;
  const fetch = await runFederatedGit(runtime, adapter, input.projectRoot, [
    "fetch",
    "origin",
    `refs/heads/${input.sourceBranch}:${remoteRef}`,
  ]);
  if (fetch.exitCode !== 0) {
    throw new Error(fetch.stderr.trim() || "Failed to fetch the federated source branch.");
  }
  const source = await runFederatedGit(runtime, adapter, input.projectRoot, [
    "rev-parse",
    "--verify",
    remoteRef,
  ]);
  const observedSource = source.stdout.trim();
  if (
    source.exitCode !== 0 ||
    !FEDERATED_COMMIT_PATTERN.test(observedSource) ||
    observedSource.toLowerCase() !== input.sourceCommitSha.toLowerCase()
  ) {
    throw new Error("Federated source branch no longer matches the reported commit.");
  }
  return {
    version: 1,
    repository,
    sourceBranch: input.sourceBranch,
    sourceCommitSha: input.sourceCommitSha.toLowerCase(),
    targetBranch: input.targetBranch,
    publicationNonce: randomUUID(),
    sealedAt: federationNow(),
  };
}

/** Squash one sealed source commit in a detached worktree and publish one exact OID. */
export async function executeFederatedSquashMerge(
  input: FederatedMergeExecutionInput,
  runtime: FederatedMergeRuntime = defaultFederatedMergeRuntime,
): Promise<FederatedMergeResult> {
  assertValidMergeBinding(input.binding);
  const requested: FederatedMergeBinding = {
    version: 1,
    repository: input.binding.repository,
    sourceBranch: input.sourceBranch,
    sourceCommitSha: input.sourceCommitSha.toLowerCase(),
    targetBranch: input.targetBranch,
    publicationNonce: input.binding.publicationNonce,
    sealedAt: input.binding.sealedAt,
  };
  assertSameMergeIdentity(input.binding, requested);

  const adapter = await runtime.loadAdapter(input.projectRoot);
  const currentRepository = await runtime.resolveRepository(adapter);
  if (!sameRepository(input.binding.repository, currentRepository)) {
    return {
      ok: false,
      error: "Federation repository changed after merge was sealed.",
      commands: 0,
    };
  }

  const worktreePath = runtime.createWorktreePath(input);
  const remoteSourceRef = `refs/remotes/origin/${input.sourceBranch}`;
  const remoteTargetRef = `refs/remotes/origin/${input.targetBranch}`;
  let commands = 0;
  let worktreeAdded = false;
  try {
    const targetFetch = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "fetch",
      "origin",
      `refs/heads/${input.targetBranch}:${remoteTargetRef}`,
    ]);
    commands += 1;
    if (targetFetch.exitCode !== 0) {
      return {
        ok: false,
        error: targetFetch.stderr.trim() || `Failed to fetch ${input.targetBranch}.`,
        commands,
      };
    }
    const target = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "rev-parse",
      "--verify",
      remoteTargetRef,
    ]);
    const targetCommitSha = target.stdout.trim();
    if (target.exitCode !== 0 || !FEDERATED_COMMIT_PATTERN.test(targetCommitSha)) {
      return {
        ok: false,
        error: `Failed to seal the current ${input.targetBranch} commit.`,
        commands,
      };
    }
    const priorPublication = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "-c",
      "trailer.separators=:",
      "log",
      "--fixed-strings",
      `--grep=Quack-Federated-Publication: ${input.binding.publicationNonce}`,
      "--max-count=2",
      "--format=%H%x1f%(trailers:key=Quack-Federated-Source,valueonly)%x1f%(trailers:key=Quack-Federated-Publication,valueonly)%x1e",
      remoteTargetRef,
    ]);
    if (priorPublication.exitCode !== 0) {
      return {
        ok: false,
        error: priorPublication.stderr.trim() || "Failed to inspect prior merge publications.",
        commands,
      };
    }
    const receiptCandidates = priorPublication.stdout
      .split("\x1e")
      .map((entry) => entry.split("\x1f", 3))
      .filter(([commitSha]) => FEDERATED_COMMIT_PATTERN.test(commitSha?.trim() ?? ""));
    const receipt = receiptCandidates.find(
      ([, sourceTrailers, publicationTrailers]) =>
        sourceTrailers
          ?.split(/\r?\n/u)
          .some(
            (line) => line.trim().toLowerCase() === input.binding.sourceCommitSha.toLowerCase(),
          ) &&
        publicationTrailers
          ?.split(/\r?\n/u)
          .some((line) => line.trim() === input.binding.publicationNonce),
    );
    if (receipt?.[0]) {
      return { ok: true, commitSha: receipt[0].trim().toLowerCase(), commands };
    }
    if (receiptCandidates.length > 0) {
      return {
        ok: false,
        error: "Federated publication receipt does not match the sealed source commit.",
        commands,
      };
    }

    const sourceFetch = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "fetch",
      "origin",
      `refs/heads/${input.sourceBranch}:${remoteSourceRef}`,
    ]);
    commands += 1;
    if (sourceFetch.exitCode !== 0) {
      return {
        ok: false,
        error: sourceFetch.stderr.trim() || `Failed to fetch ${input.sourceBranch}.`,
        commands,
      };
    }
    const source = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "rev-parse",
      "--verify",
      remoteSourceRef,
    ]);
    const observedSource = source.stdout.trim();
    if (
      source.exitCode !== 0 ||
      !FEDERATED_COMMIT_PATTERN.test(observedSource) ||
      observedSource.toLowerCase() !== input.binding.sourceCommitSha.toLowerCase()
    ) {
      return {
        ok: false,
        error: "Federated source branch changed after merge was sealed.",
        commands,
      };
    }

    const add = await runFederatedGit(runtime, adapter, input.projectRoot, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      remoteTargetRef,
    ]);
    commands += 1;
    if (add.exitCode !== 0) {
      return {
        ok: false,
        error: add.stderr.trim() || "Failed to create merge worktree.",
        commands,
      };
    }
    worktreeAdded = true;

    const merge = await runFederatedGit(runtime, adapter, worktreePath, [
      "merge",
      "--squash",
      input.binding.sourceCommitSha,
    ]);
    commands += 1;
    if (merge.exitCode !== 0) {
      return {
        ok: false,
        error: merge.stderr.trim() || "Federated squash merge failed.",
        commands,
      };
    }
    const status = await runFederatedGit(runtime, adapter, worktreePath, ["status", "--porcelain"]);
    if (status.exitCode !== 0 || !status.stdout.trim()) {
      return { ok: false, error: "merge_produced_no_changes", commands };
    }
    const commit = await runFederatedGit(runtime, adapter, worktreePath, [
      "commit",
      "-m",
      [
        `feat(${input.taskId.toLowerCase()}): merge federated work`,
        "",
        `Quack-Federated-Source: ${input.binding.sourceCommitSha}`,
        `Quack-Federated-Publication: ${input.binding.publicationNonce}`,
      ].join("\n"),
    ]);
    commands += 1;
    if (commit.exitCode !== 0) {
      return {
        ok: false,
        error: commit.stderr.trim() || "Federated merge commit failed.",
        commands,
      };
    }
    const head = await runFederatedGit(runtime, adapter, worktreePath, ["rev-parse", "HEAD"]);
    const mergeCommitSha = head.stdout.trim();
    if (head.exitCode !== 0 || !FEDERATED_COMMIT_PATTERN.test(mergeCommitSha)) {
      return { ok: false, error: "Failed to seal the federated merge commit.", commands };
    }
    const repositoryBeforePush = await runtime.resolveRepository(adapter);
    if (!sameRepository(input.binding.repository, repositoryBeforePush)) {
      return {
        ok: false,
        error: "Federation repository changed before merge publication.",
        commands,
      };
    }
    const push = await runFederatedGit(
      runtime,
      adapter,
      worktreePath,
      [
        "push",
        `--force-with-lease=refs/heads/${input.targetBranch}:${targetCommitSha.toLowerCase()}`,
        "origin",
        `${mergeCommitSha}:refs/heads/${input.targetBranch}`,
      ],
      input.binding.repository,
    );
    commands += 1;
    if (push.exitCode !== 0) {
      return { ok: false, error: push.stderr.trim() || "Federated merge push failed.", commands };
    }
    return { ok: true, commitSha: mergeCommitSha.toLowerCase(), commands };
  } catch (error: unknown) {
    return { ok: false, error: gitErrorMessage(error), commands };
  } finally {
    if (worktreeAdded) {
      await runFederatedGit(runtime, adapter, input.projectRoot, [
        "worktree",
        "remove",
        worktreePath,
        "--force",
      ]).catch(() => undefined);
    }
  }
}

const defaultFederatedMergeBoundary: FederatedMergeBoundary = {
  seal: (input) => sealFederatedMergeBinding(input),
  merge: (input) => executeFederatedSquashMerge(input),
};

function federationMergeLockPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "merge.lock");
}

function federationMergeReclaimLockPath(projectRoot: string): string {
  return `${federationMergeLockPath(projectRoot)}.reclaim`;
}

interface FederatedMergeLockRecord {
  version: 2;
  jobId: string;
  taskId: string;
  ownerToken: string;
  host: string;
  processId: number;
  processIdentity: FederatedJobProcessIdentity;
  ownerArtifact: string;
  acquiredAt: string;
}

function isFederatedMergeLockRecord(value: unknown): value is FederatedMergeLockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FederatedMergeLockRecord>;
  return (
    record.version === 2 &&
    typeof record.jobId === "string" &&
    record.jobId.length > 0 &&
    typeof record.taskId === "string" &&
    record.taskId.length > 0 &&
    typeof record.ownerToken === "string" &&
    /^[0-9a-f-]{36}$/iu.test(record.ownerToken) &&
    typeof record.host === "string" &&
    record.host.length > 0 &&
    Number.isInteger(record.processId) &&
    (record.processId ?? 0) > 0 &&
    isFederatedMergeProcessIdentity(record.processIdentity) &&
    typeof record.ownerArtifact === "string" &&
    record.ownerArtifact.startsWith(FEDERATED_MERGE_OWNER_PREFIX) &&
    path.basename(record.ownerArtifact) === record.ownerArtifact &&
    typeof record.acquiredAt === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt))
  );
}

function exactFederatedMergeOwner(
  expected: FederatedMergeLockRecord,
  observed: unknown,
): observed is FederatedMergeLockRecord {
  return (
    isFederatedMergeLockRecord(observed) &&
    observed.jobId === expected.jobId &&
    observed.taskId === expected.taskId &&
    observed.ownerToken === expected.ownerToken &&
    observed.host.toLowerCase() === expected.host.toLowerCase() &&
    observed.processId === expected.processId &&
    observed.ownerArtifact === expected.ownerArtifact &&
    observed.processIdentity.bootId === expected.processIdentity.bootId &&
    observed.processIdentity.startedAt === expected.processIdentity.startedAt
  );
}

async function samePhysicalMergeFile(left: string, right: string): Promise<boolean> {
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

interface FederatedMergeFileIdentity {
  dev: number;
  ino: number;
}

async function federatedMergeFileIdentity(
  target: string,
): Promise<FederatedMergeFileIdentity | undefined> {
  try {
    const stat = await fsPromises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function matchesFederatedMergeFileIdentity(
  target: string,
  expected: FederatedMergeFileIdentity,
): Promise<boolean> {
  const observed = await federatedMergeFileIdentity(target);
  return Boolean(observed && observed.dev === expected.dev && observed.ino === expected.ino);
}

async function syncFederatedMergeDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fsPromises.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (
      !["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
    // Windows commonly refuses directory handles; the owner file itself is synced.
  }
}

async function syncFederatedMergePublishedFile(filePath: string): Promise<void> {
  const handle = await fsPromises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isTransientFederatedMergeFsError(error: unknown): boolean {
  return ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function retryFederatedMergeFsOperation(
  operation: () => Promise<void>,
  stillAuthorized: () => Promise<boolean>,
): Promise<void> {
  const runtime = federatedMergeLockRuntime();
  const deadline = Date.now() + runtime.retryTimeoutMs;
  for (;;) {
    if (!(await stillAuthorized())) {
      const error = new Error("Federation merge lock ownership changed during cleanup");
      (error as NodeJS.ErrnoException).code = "ESTALE";
      throw error;
    }
    try {
      await operation();
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!isTransientFederatedMergeFsError(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, runtime.retryMs));
    }
  }
}

async function readFederatedMergeRecordAt(
  target: string,
): Promise<FederatedMergeLockRecord | undefined> {
  return (await readFederatedMergeRecordSnapshotAt(target))?.record;
}

async function readFederatedMergeRecordSnapshotAt(
  target: string,
): Promise<
  { record: FederatedMergeLockRecord; fileIdentity: FederatedMergeFileIdentity } | undefined
> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await fsPromises.open(target, "r");
    const raw = await handle.readFile("utf-8");
    const stat = await handle.stat();
    const pathStat = await fsPromises.lstat(target);
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return isFederatedMergeLockRecord(parsed)
      ? {
          record: parsed,
          fileIdentity: { dev: Number(stat.dev), ino: Number(stat.ino) },
        }
      : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function federatedMergePathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function quarantineExactFederatedMergeOwner(
  lockPath: string,
  expected: FederatedMergeLockRecord,
  proofPath: string,
): Promise<string> {
  const runtime = federatedMergeLockRuntime();
  const quarantinePath = path.join(
    path.dirname(lockPath),
    `${FEDERATED_MERGE_RELEASE_QUARANTINE_PREFIX}${expected.ownerToken}`,
  );
  if (await federatedMergePathExists(quarantinePath)) {
    const quarantined = await readFederatedMergeRecordAt(quarantinePath);
    if (
      quarantined &&
      exactFederatedMergeOwner(expected, quarantined) &&
      (await samePhysicalMergeFile(quarantinePath, proofPath))
    ) {
      if (await samePhysicalMergeFile(lockPath, proofPath)) {
        await retryFederatedMergeFsOperation(
          () => runtime.unlinkPath(lockPath),
          async () =>
            !(await federatedMergePathExists(lockPath)) ||
            (await samePhysicalMergeFile(lockPath, proofPath)),
        );
      }
      return quarantinePath;
    }
    throw new Error("Federation merge release quarantine identity is ambiguous");
  }
  await retryFederatedMergeFsOperation(
    () => runtime.renamePath(lockPath, quarantinePath),
    async () => {
      if (await samePhysicalMergeFile(lockPath, proofPath)) return true;
      const current = await readFederatedMergeRecordAt(lockPath);
      if (!current) return !(await federatedMergePathExists(lockPath));
      return (
        exactFederatedMergeOwner(expected, current) &&
        (await samePhysicalMergeFile(lockPath, proofPath))
      );
    },
  );
  const quarantined = await readFederatedMergeRecordAt(quarantinePath);
  if (
    !quarantined ||
    !exactFederatedMergeOwner(expected, quarantined) ||
    !(await samePhysicalMergeFile(quarantinePath, proofPath))
  ) {
    if (
      !(await federatedMergePathExists(lockPath)) &&
      (await federatedMergePathExists(quarantinePath))
    ) {
      try {
        await runtime.linkPath(quarantinePath, lockPath);
      } catch {
        // Preserve both paths as fail-closed evidence if restoration cannot be proven.
      }
    }
    throw new Error("Federation merge lock changed while entering release quarantine");
  }
  return quarantinePath;
}

async function writeSyncedFederatedMergeOwner(
  ownerPath: string,
  owner: FederatedMergeLockRecord,
): Promise<void> {
  const handle = await fsPromises.open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeFederatedMergeArtifact(target: string): Promise<void> {
  const runtime = federatedMergeLockRuntime();
  await retryFederatedMergeFsOperation(
    () => runtime.unlinkPath(target),
    () => Promise.resolve(true),
  );
}

async function listFederatedMergeArtifacts(lockPath: string, prefix: string): Promise<string[]> {
  try {
    return (await fsPromises.readdir(path.dirname(lockPath)))
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .map((entry) => path.join(path.dirname(lockPath), entry));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function reconcileFederatedMergeReclaimQuarantines(lockPath: string): Promise<boolean> {
  const quarantines = await listFederatedMergeArtifacts(
    lockPath,
    FEDERATED_MERGE_RECLAIM_QUARANTINE_PREFIX,
  );
  if (quarantines.length === 0) return true;

  // A quarantine means the preceding admission ended between rename and
  // deletion. Restore its exact inode to canonical (without replacement) and
  // require a fresh acquisition attempt to authorize any later reclamation.
  const quarantinePath = quarantines[0];
  const identity = await federatedMergeFileIdentity(quarantinePath);
  if (!identity) return false;
  const runtime = federatedMergeLockRuntime();
  if (await federatedMergePathExists(lockPath)) {
    if (!(await samePhysicalMergeFile(quarantinePath, lockPath))) return false;
  } else {
    try {
      await runtime.linkPath(quarantinePath, lockPath);
      await runtime.syncDirectory(path.dirname(lockPath));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await samePhysicalMergeFile(quarantinePath, lockPath))) return false;
  }
  await retryFederatedMergeFsOperation(
    () => runtime.unlinkPath(quarantinePath),
    () => matchesFederatedMergeFileIdentity(quarantinePath, identity),
  );
  // Even after successful restoration, this caller must not reuse the stale
  // authorization that preceded the crash/move.
  return false;
}

async function retireFederatedMergeReleaseIntent(
  lockPath: string,
  releasePath: string,
  owner: FederatedMergeLockRecord,
  ownerPath: string,
  releaseIdentity: FederatedMergeFileIdentity,
): Promise<void> {
  if (!(await matchesFederatedMergeFileIdentity(ownerPath, releaseIdentity))) {
    // The authenticated owner inode is already gone. A same-name replacement
    // is not authorized by this release and must survive intact.
    await removeFederatedMergeArtifact(releasePath);
    return;
  }
  if (await samePhysicalMergeFile(ownerPath, lockPath)) return;

  // The sidecar is no longer authoritative once the release fence is gone.
  // Move only the inode proven by the release hard link to an unpredictable
  // retired name before deleting it, so a same-name replacement survives.
  const retiredPath = `${ownerPath}.retired.${randomUUID()}`;
  const runtime = federatedMergeLockRuntime();
  try {
    await retryFederatedMergeFsOperation(
      () => runtime.renamePath(ownerPath, retiredPath),
      () => matchesFederatedMergeFileIdentity(ownerPath, releaseIdentity),
    );
  } catch (error: unknown) {
    if (
      (await federatedMergePathExists(ownerPath)) &&
      !(await matchesFederatedMergeFileIdentity(ownerPath, releaseIdentity))
    ) {
      await removeFederatedMergeArtifact(releasePath);
      return;
    }
    throw error;
  }
  if (!(await matchesFederatedMergeFileIdentity(retiredPath, releaseIdentity))) {
    if (!(await federatedMergePathExists(ownerPath))) {
      await runtime.linkPath(retiredPath, ownerPath);
    }
    if (!(await samePhysicalMergeFile(retiredPath, ownerPath))) {
      throw new Error("Federation merge owner changed while retiring release evidence");
    }
    await retryFederatedMergeFsOperation(
      () => runtime.unlinkPath(retiredPath),
      () => samePhysicalMergeFile(retiredPath, ownerPath),
    );
    await removeFederatedMergeArtifact(releasePath);
    return;
  }
  await retryFederatedMergeFsOperation(
    () => runtime.unlinkPath(retiredPath),
    () => matchesFederatedMergeFileIdentity(retiredPath, releaseIdentity),
  );
  await removeFederatedMergeArtifact(releasePath);
}

async function completeFederatedMergeReleaseIntent(
  lockPath: string,
  releasePath: string,
): Promise<boolean> {
  const releaseSnapshot = await readFederatedMergeRecordSnapshotAt(releasePath);
  const owner = releaseSnapshot?.record;
  if (!owner || !releaseSnapshot || !path.basename(releasePath).endsWith(owner.ownerToken)) {
    return false;
  }
  const ownerPath = path.join(path.dirname(lockPath), owner.ownerArtifact);
  const quarantinePath = path.join(
    path.dirname(lockPath),
    `${FEDERATED_MERGE_RELEASE_QUARANTINE_PREFIX}${owner.ownerToken}`,
  );
  const hasProvenance =
    (await samePhysicalMergeFile(releasePath, ownerPath)) ||
    (await samePhysicalMergeFile(releasePath, lockPath)) ||
    (await samePhysicalMergeFile(releasePath, quarantinePath));
  if (!hasProvenance) return false;

  const canonicalIsProvenOwner = await samePhysicalMergeFile(releasePath, lockPath);
  const current = await readFederatedMergeRecordAt(lockPath);
  if (canonicalIsProvenOwner) {
    try {
      await quarantineExactFederatedMergeOwner(lockPath, owner, releasePath);
    } catch (error: unknown) {
      if (isTransientFederatedMergeFsError(error)) return false;
      throw error;
    }
  } else if (current && exactFederatedMergeOwner(owner, current)) {
    // Matching JSON copied onto a different inode is not ownership evidence.
    // The authenticated release may retire only the old linked inode; the
    // replacement canonical remains authoritative for a later admission.
    await retireFederatedMergeReleaseIntent(
      lockPath,
      releasePath,
      owner,
      ownerPath,
      releaseSnapshot.fileIdentity,
    );
    await federatedMergeLockRuntime().syncDirectory(path.dirname(lockPath));
    return true;
  } else if (await federatedMergePathExists(lockPath)) {
    // A replacement owner won. The old intent may retire only its own inode.
    if (!(await samePhysicalMergeFile(releasePath, quarantinePath))) {
      await retireFederatedMergeReleaseIntent(
        lockPath,
        releasePath,
        owner,
        ownerPath,
        releaseSnapshot.fileIdentity,
      );
      await federatedMergeLockRuntime().syncDirectory(path.dirname(lockPath));
      return true;
    }
  }

  if (await federatedMergePathExists(quarantinePath)) {
    if (!(await samePhysicalMergeFile(releasePath, quarantinePath))) return false;
    const runtime = federatedMergeLockRuntime();
    await retryFederatedMergeFsOperation(
      () => runtime.unlinkPath(quarantinePath),
      async () =>
        !(await federatedMergePathExists(quarantinePath)) ||
        (await samePhysicalMergeFile(releasePath, quarantinePath)),
    );
  }
  await retireFederatedMergeReleaseIntent(
    lockPath,
    releasePath,
    owner,
    ownerPath,
    releaseSnapshot.fileIdentity,
  );
  await federatedMergeLockRuntime().syncDirectory(path.dirname(lockPath));
  return true;
}

async function reconcileFederatedMergeReleaseIntents(lockPath: string): Promise<boolean> {
  const releases = await listFederatedMergeArtifacts(lockPath, FEDERATED_MERGE_RELEASE_PREFIX);
  for (const releasePath of releases) {
    if (!(await completeFederatedMergeReleaseIntent(lockPath, releasePath))) return false;
  }
  return true;
}

async function scavengeFederatedMergeOwnerArtifacts(lockPath: string): Promise<void> {
  const owners = await listFederatedMergeArtifacts(lockPath, FEDERATED_MERGE_OWNER_PREFIX);
  if (owners.length === 0) {
    federatedMergeOwnerScanCursors.delete(lockPath);
    return;
  }
  const previous = federatedMergeOwnerScanCursors.get(lockPath);
  let start = previous ? owners.findIndex((owner) => owner.localeCompare(previous) > 0) : 0;
  if (start < 0) start = 0;
  const examined = Math.min(FEDERATED_MERGE_ARTIFACT_SCAN_LIMIT, owners.length);
  const batch = Array.from(
    { length: examined },
    (_, index) => owners[(start + index) % owners.length],
  );
  federatedMergeOwnerScanCursors.set(lockPath, batch.at(-1)!);
  for (const ownerPath of batch) {
    if (await samePhysicalMergeFile(ownerPath, lockPath)) continue;
    const owner = await readFederatedMergeRecordAt(ownerPath);
    if (!owner || owner.ownerArtifact !== path.basename(ownerPath)) {
      await removeFederatedMergeArtifact(ownerPath);
      continue;
    }
    const projectRoot = path.resolve(path.dirname(lockPath), "..", "..");
    const probe = await probeFederatedLockProcessIdentity(projectRoot, owner.processId);
    if (
      probe.state === "dead" ||
      (probe.state === "alive" &&
        (probe.identity.bootId !== owner.processIdentity.bootId ||
          probe.identity.startedAt !== owner.processIdentity.startedAt))
    ) {
      await removeFederatedMergeArtifact(ownerPath);
    }
  }
}

export async function readFederatedMergeLock(
  projectRoot: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsPromises.readFile(federationMergeLockPath(projectRoot), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireFederatedMergeLock(
  projectRoot: string,
  jobId: string,
  taskId: string,
): Promise<string | undefined> {
  return withFederatedJobLock(projectRoot, FEDERATED_MERGE_ADMISSION_LOCK_ID, () =>
    acquireFederatedMergeLockUnserialized(projectRoot, jobId, taskId),
  );
}

async function acquireFederatedMergeLockUnserialized(
  projectRoot: string,
  jobId: string,
  taskId: string,
): Promise<string | undefined> {
  const lockPath = federationMergeLockPath(projectRoot);
  const reclaimLockPath = federationMergeReclaimLockPath(projectRoot);
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  if (!(await reconcileFederatedMergeReclaimQuarantines(lockPath))) return undefined;
  const pendingLocalRelease = pendingProcessLocalMergeReleases.get(lockPath);
  if (pendingLocalRelease) {
    try {
      const release = await releaseFederatedMergeLockUnserialized(
        projectRoot,
        pendingLocalRelease.jobId,
        pendingLocalRelease.ownerToken,
      );
      if (release.pending) return undefined;
      await federatedMergeLockRuntime().syncDirectory(path.dirname(lockPath));
      pendingProcessLocalMergeReleases.delete(lockPath);
    } catch {
      return undefined;
    }
  }
  if (!(await reconcileFederatedMergeReleaseIntents(lockPath))) return undefined;
  await scavengeFederatedMergeOwnerArtifacts(lockPath);

  const ownerToken = randomUUID();
  const processIdentity = await currentFederatedLockProcessIdentity(projectRoot);
  const ownerArtifact = `${FEDERATED_MERGE_OWNER_PREFIX}${ownerToken}`;
  const ownerPath = path.join(path.dirname(lockPath), ownerArtifact);
  const owner: FederatedMergeLockRecord = {
    version: 2,
    jobId,
    taskId,
    ownerToken,
    host: hostname(),
    processId: process.pid,
    processIdentity,
    ownerArtifact,
    acquiredAt: federationNow(),
  };
  let ownerPrepared = false;
  let ownerPublished = false;
  const prepareOwner = async (): Promise<void> => {
    if (ownerPrepared) return;
    await writeSyncedFederatedMergeOwner(ownerPath, owner);
    ownerPrepared = true;
  };
  const publishOwnerNoReplace = async (target: string): Promise<boolean> => {
    await prepareOwner();
    const runtime = federatedMergeLockRuntime();
    const deadline = Date.now() + runtime.retryTimeoutMs;
    for (;;) {
      try {
        await runtime.linkPath(ownerPath, target);
        break;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        if (!isTransientFederatedMergeFsError(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, runtime.retryMs));
      }
    }
    if (target === lockPath) ownerPublished = true;
    try {
      await runtime.syncDirectory(path.dirname(lockPath));
    } catch (syncError: unknown) {
      if (target !== lockPath) throw syncError;
      try {
        await releaseFederatedMergeLockUnserialized(projectRoot, jobId, ownerToken);
      } catch (releaseError: unknown) {
        throw new AggregateError(
          [syncError, releaseError],
          "Federation merge lock publication could not be made recoverable",
          { cause: syncError },
        );
      }
      throw syncError;
    }
    return true;
  };
  const readSnapshot = async (
    target: string,
  ): Promise<
    | {
        raw: string;
        record?: Record<string, unknown>;
        mtimeMs: number;
        fileIdentity?: FederatedMergeFileIdentity;
      }
    | undefined
  > => {
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    try {
      handle = await fsPromises.open(target, "r");
      const raw = await handle.readFile("utf-8");
      await federatedMergeLockRuntime().afterSnapshotReadForTest?.(target);
      const stat = await handle.stat();
      const pathStat = await fsPromises.lstat(target);
      if (
        !stat.isFile() ||
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        stat.dev !== pathStat.dev ||
        stat.ino !== pathStat.ino
      ) {
        return undefined;
      }
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      return {
        raw,
        record: parsed,
        mtimeMs: stat.mtimeMs,
        fileIdentity: { dev: Number(stat.dev), ino: Number(stat.ino) },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  };
  const snapshotIsStale = async (snapshot: {
    record?: Record<string, unknown>;
    mtimeMs: number;
  }): Promise<boolean> => {
    const acquiredAt =
      typeof snapshot.record?.acquiredAt === "string"
        ? Date.parse(snapshot.record.acquiredAt)
        : Number.NaN;
    const observedAt = Number.isFinite(acquiredAt) ? acquiredAt : snapshot.mtimeMs;
    if (Date.now() - observedAt <= FEDERATED_MERGE_LOCK_STALE_MS) return false;
    const ownerPid = snapshot.record?.processId;
    if (!Number.isInteger(ownerPid) || (ownerPid as number) <= 0) return false;
    const ownerHost = snapshot.record?.host;
    if (
      typeof ownerHost === "string" &&
      ownerHost.length > 0 &&
      ownerHost.toLowerCase() !== hostname().toLowerCase()
    ) {
      return false;
    }
    const probe = await probeFederatedLockProcessIdentity(projectRoot, ownerPid as number);
    if (probe.state === "dead") return true;
    const recordedIdentity = snapshot.record?.processIdentity;
    return Boolean(
      probe.state === "alive" &&
      isFederatedMergeProcessIdentity(recordedIdentity) &&
      (probe.identity.bootId !== recordedIdentity.bootId ||
        probe.identity.startedAt !== recordedIdentity.startedAt),
    );
  };
  const reclaimGuardPaths = async (): Promise<string[]> => {
    const prefix = path.basename(reclaimLockPath);
    try {
      return (await fsPromises.readdir(path.dirname(lockPath)))
        .filter((entry) => entry === prefix || entry.startsWith(`${prefix}.takeover.`))
        .map((entry) => path.join(path.dirname(lockPath), entry));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const retireStaleSnapshot = async (
    target: string,
    observed: {
      raw: string;
      record?: Record<string, unknown>;
      mtimeMs: number;
      fileIdentity?: FederatedMergeFileIdentity;
    },
  ): Promise<boolean> => {
    if (!observed.fileIdentity) return false;
    const runtime = federatedMergeLockRuntime();
    const quarantinePath = path.join(
      path.dirname(lockPath),
      `${FEDERATED_MERGE_RECLAIM_QUARANTINE_PREFIX}${randomUUID()}`,
    );
    try {
      await retryFederatedMergeFsOperation(
        () => runtime.renamePath(target, quarantinePath),
        async () => {
          const latest = await readSnapshot(target);
          return Boolean(
            latest &&
            latest.raw === observed.raw &&
            latest.fileIdentity?.dev === observed.fileIdentity?.dev &&
            latest.fileIdentity?.ino === observed.fileIdentity?.ino &&
            (await snapshotIsStale(latest)),
          );
        },
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESTALE") return false;
      throw error;
    }

    if (!(await matchesFederatedMergeFileIdentity(quarantinePath, observed.fileIdentity))) {
      // A byte-identical replacement won after authorization. Restore exactly
      // the inode that was moved and refuse this admission attempt.
      if (!(await federatedMergePathExists(target))) {
        try {
          await runtime.linkPath(quarantinePath, target);
          await runtime.syncDirectory(path.dirname(target));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (await samePhysicalMergeFile(quarantinePath, target)) {
        const movedIdentity = await federatedMergeFileIdentity(quarantinePath);
        if (movedIdentity) {
          await retryFederatedMergeFsOperation(
            () => runtime.unlinkPath(quarantinePath),
            () => matchesFederatedMergeFileIdentity(quarantinePath, movedIdentity),
          );
        }
      }
      return false;
    }

    await retryFederatedMergeFsOperation(
      () => runtime.unlinkPath(quarantinePath),
      () => matchesFederatedMergeFileIdentity(quarantinePath, observed.fileIdentity!),
    );
    return true;
  };

  try {
    const existingGuards = await reclaimGuardPaths();
    if (existingGuards.length > 0) {
      if (existingGuards.length !== 1) return undefined;
      const guardPath = existingGuards[0];
      const guard = await readSnapshot(guardPath);
      if (!guard || !(await snapshotIsStale(guard))) return undefined;
      if (!(await retireStaleSnapshot(guardPath, guard))) return undefined;
    }

    if (await publishOwnerNoReplace(lockPath)) {
      ownerPublished = true;
      return ownerToken;
    }

    const observed = await readSnapshot(lockPath);
    if (!observed || !(await snapshotIsStale(observed))) return undefined;
    if (!(await retireStaleSnapshot(lockPath, observed))) return undefined;
    if (!(await publishOwnerNoReplace(lockPath))) return undefined;
    ownerPublished = true;
    return ownerToken;
  } finally {
    if (!ownerPublished && ownerPrepared) {
      await removeFederatedMergeArtifact(ownerPath);
    }
  }
}

async function releaseFederatedMergeLockUnserialized(
  projectRoot: string,
  jobId: string,
  ownerToken: string,
): Promise<{ pending: boolean; error?: unknown }> {
  const lockPath = federationMergeLockPath(projectRoot);
  const lock = await readFederatedMergeRecordAt(lockPath);
  if (!lock) {
    if (await federatedMergePathExists(lockPath)) {
      throw new Error("Federation merge lock is unreadable or malformed during release");
    }
    return { pending: false };
  }
  if (lock.jobId !== jobId || lock.ownerToken !== ownerToken) {
    return { pending: false };
  }
  const ownerPath = path.join(path.dirname(lockPath), lock.ownerArtifact);
  if (!(await samePhysicalMergeFile(lockPath, ownerPath))) {
    throw new Error("Federation merge lock owner provenance is missing");
  }
  const releasePath = path.join(
    path.dirname(lockPath),
    `${FEDERATED_MERGE_RELEASE_PREFIX}${ownerToken}`,
  );
  const runtime = federatedMergeLockRuntime();
  let releasePublished = false;
  let releasePublicationDurable = false;
  try {
    const deadline = Date.now() + runtime.retryTimeoutMs;
    for (;;) {
      try {
        await runtime.linkPath(ownerPath, releasePath);
        releasePublished = true;
        break;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          releasePublished = await samePhysicalMergeFile(ownerPath, releasePath);
          if (!releasePublished) throw error;
          break;
        }
        if (!isTransientFederatedMergeFsError(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, runtime.retryMs));
      }
    }
    await runtime.syncPublishedReleaseFile(releasePath);
    // Node cannot fsync a Windows directory. The published release file's
    // FlushFileBuffers boundary is authoritative there; POSIX additionally
    // requires the directory sync before the marker is called durable.
    if (process.platform === "win32") releasePublicationDurable = true;
    await runtime.syncDirectory(path.dirname(lockPath));
    if (process.platform !== "win32") releasePublicationDurable = true;
    if (await completeFederatedMergeReleaseIntent(lockPath, releasePath)) {
      pendingProcessLocalMergeReleases.delete(lockPath);
      return { pending: false };
    }
    return {
      pending: true,
      error: new Error(`Federation merge lock release remains durably pending: ${lockPath}`),
    };
  } catch (error: unknown) {
    if (releasePublished && !releasePublicationDurable) {
      pendingProcessLocalMergeReleases.set(lockPath, { jobId, ownerToken });
      throw error;
    }
    if (releasePublished) {
      pendingProcessLocalMergeReleases.set(lockPath, { jobId, ownerToken });
    }
    if (releasePublished && (await samePhysicalMergeFile(releasePath, ownerPath))) {
      return { pending: true, error };
    }
    if (!releasePublished) {
      pendingProcessLocalMergeReleases.set(lockPath, { jobId, ownerToken });
    }
    throw error;
  }
}

type FederatedMergeLaneRun<T> = { acquired: false } | { acquired: true; value: T };

async function withFederatedMergeLane<T>(
  projectRoot: string,
  jobId: string,
  taskId: string,
  action: (ownerToken: string) => Promise<T>,
): Promise<FederatedMergeLaneRun<T>> {
  try {
    return await withFederatedJobLock(
      projectRoot,
      FEDERATED_MERGE_ADMISSION_LOCK_ID,
      async () => {
        const ownerToken = await acquireFederatedMergeLockUnserialized(projectRoot, jobId, taskId);
        if (!ownerToken) return { acquired: false } as const;
        let actionCompleted = false;
        let value: T | undefined;
        let actionError: unknown;
        try {
          value = await action(ownerToken);
          actionCompleted = true;
        } catch (error: unknown) {
          actionError = error;
        }
        let release: { pending: boolean; error?: unknown } | undefined;
        let releaseError: unknown;
        try {
          release = await releaseFederatedMergeLockUnserialized(projectRoot, jobId, ownerToken);
        } catch (error: unknown) {
          releaseError = error;
        }
        const releaseAdvisory = releaseError ?? release?.error;
        if (!actionCompleted) {
          if (releaseAdvisory && typeof actionError === "object" && actionError !== null) {
            try {
              Object.defineProperty(actionError, "federatedMergeLockReleaseError", {
                value: releaseAdvisory,
                configurable: true,
                enumerable: true,
              });
            } catch {
              // Preserve the action's original failure when it is non-extensible.
            }
          }
          throw actionError;
        }
        if (releaseError) {
          throw new FederatedJobLockCompletedActionError({ acquired: true, value }, releaseError);
        }
        if (releaseAdvisory) {
          console.warn(
            release?.pending
              ? `[federation] Merge lock release for ${jobId} is durably pending and will be reconciled before the next publication.`
              : `[federation] Merge lock release for ${jobId} required fallback cleanup: ${gitErrorMessage(releaseAdvisory)}`,
          );
        }
        return { acquired: true, value: value as T } as const;
      },
      { retryMs: 1, waitTimeoutMs: 1 },
    );
  } catch (error: unknown) {
    if (
      error instanceof FederatedJobLockBusyError &&
      error.jobId === FEDERATED_MERGE_ADMISSION_LOCK_ID
    ) {
      return { acquired: false };
    }
    throw error;
  }
}

async function recordFederatedWorkerRefreshOutcome(
  projectRoot: string,
  jobId: string,
  expectedMergeCommitSha: string | undefined,
  expectedBinding: FederatedMergeBinding | undefined,
  outcome:
    | { ok: true; commandCount: number; completedAt: string }
    | { ok: false; error: string; failedAt: string },
): Promise<FederatedJobRecord | undefined> {
  const result = await updateFederatedJob(projectRoot, jobId, (current) => {
    if (
      current.status !== "completed" ||
      current.mergeStatus !== "merged" ||
      current.nextAction !== "broadcast_worker_refresh"
    ) {
      return undefined;
    }
    if (
      expectedMergeCommitSha &&
      current.mergeCommitSha?.toLowerCase() !== expectedMergeCommitSha.toLowerCase()
    ) {
      return undefined;
    }
    if (expectedBinding) {
      if (!current.mergeBinding) return undefined;
      try {
        assertSameMergeIdentity(expectedBinding, current.mergeBinding);
      } catch {
        return undefined;
      }
    }
    if (outcome.ok) {
      return {
        ...current,
        error: undefined,
        pullCommandBroadcastAt: outcome.completedAt,
        nextAction: outcome.commandCount > 0 ? "hosts_pull_dev" : "merged_no_registered_hosts",
        updatedAt: outcome.completedAt,
      };
    }
    return {
      ...current,
      error: `worker_refresh_pending:${outcome.error}`,
      nextAction: "broadcast_worker_refresh",
      updatedAt: outcome.failedAt,
    };
  });
  return result.record;
}

function matchesFederatedCompletionSnapshot(
  current: FederatedJobRecord,
  expected: FederatedJobRecord,
): boolean {
  return (
    current.jobId === expected.jobId &&
    current.taskId === expected.taskId &&
    current.correlationId === expected.correlationId &&
    current.status === expected.status &&
    current.updatedAt === expected.updatedAt &&
    current.nextAction === expected.nextAction &&
    current.mergeStatus === expected.mergeStatus &&
    current.branchName === expected.branchName &&
    current.commitSha?.toLowerCase() === expected.commitSha?.toLowerCase() &&
    current.targetBranch === expected.targetBranch &&
    current.reviewId === expected.reviewId
  );
}

function isFederatedPublicationRecovery(record: FederatedJobRecord): boolean {
  return (
    (record.status === "completed" || record.status === "blocked") &&
    (record.mergeStatus === "publishing" ||
      (record.mergeStatus === "merged" && record.mergeBinding !== undefined))
  );
}

async function recoverFederatedPublication(
  p: FederationProjectContext & { projectRoot: string },
  record: FederatedJobRecord,
  deps: FederationOrchestrationDeps,
): Promise<FederatedOrchestrationResult> {
  const binding = record.mergeBinding;
  if (!binding) {
    return {
      job: record,
      merge: { ok: false, error: "merge_recovery_binding_missing", commands: 0 },
    };
  }
  try {
    assertValidMergeBinding(binding);
    if (
      record.branchName !== binding.sourceBranch ||
      record.commitSha?.toLowerCase() !== binding.sourceCommitSha.toLowerCase() ||
      record.targetBranch !== binding.targetBranch
    ) {
      throw new Error("Federation publication recovery identity does not match its durable job.");
    }
  } catch (error: unknown) {
    const message = `merge_recovery_refused:${gitErrorMessage(error)}`;
    const refused = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (current.mergeStatus !== "publishing") return undefined;
      return {
        ...current,
        error: message,
        nextAction: "manual_merge_recovery",
        updatedAt: federationNow(),
      };
    });
    return {
      job: refused.record ?? record,
      merge: { ok: false, error: message, commands: 0 },
    };
  }

  const mergeBoundary = deps.mergeBoundary ?? defaultFederatedMergeBoundary;
  const broadcastRefresh = deps.broadcastRefresh ?? broadcastWorkerRefreshCommand;
  const mergeLane = await withFederatedMergeLane(
    p.projectRoot,
    record.jobId,
    record.taskId,
    async (): Promise<{ job: FederatedJobRecord; merge: FederatedMergeResult }> => {
      let current = record;
      let merge: FederatedMergeResult;
      const durable = await loadFederatedJob(p.projectRoot, record.jobId);
      if (!durable?.mergeBinding) {
        return {
          job: durable ?? record,
          merge: { ok: false, error: "merge_recovery_binding_missing", commands: 0 },
        };
      }
      try {
        assertSameMergeIdentity(binding, durable.mergeBinding);
      } catch (error: unknown) {
        return {
          job: durable,
          merge: {
            ok: false,
            error: `merge_recovery_refused:${gitErrorMessage(error)}`,
            commands: 0,
          },
        };
      }
      if (durable.mergeStatus === "merged") {
        if (!durable.mergeCommitSha || !FEDERATED_COMMIT_PATTERN.test(durable.mergeCommitSha)) {
          return {
            job: durable,
            merge: { ok: false, error: "merge_recovery_receipt_missing", commands: 0 },
          };
        }
        current = durable;
        merge = { ok: true, commitSha: durable.mergeCommitSha, commands: 0 };
      } else {
        if (
          durable.mergeStatus !== "publishing" ||
          durable.nextAction !== "merge_gate" ||
          (durable.status !== "completed" && durable.status !== "blocked")
        ) {
          return {
            job: durable,
            merge: { ok: false, error: "merge_recovery_state_changed", commands: 0 },
          };
        }
        merge = await mergeBoundary.merge({
          projectRoot: p.projectRoot,
          taskId: durable.taskId,
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        });
        if (!merge.ok) {
          const mergeFailure = merge;
          const pending = await updateFederatedJob(p.projectRoot, record.jobId, (latest) => {
            if (
              latest.mergeStatus !== "publishing" ||
              latest.nextAction !== "merge_gate" ||
              !latest.mergeBinding
            ) {
              return undefined;
            }
            try {
              assertSameMergeIdentity(binding, latest.mergeBinding);
            } catch {
              return undefined;
            }
            return {
              ...latest,
              error: `publication_recovery_pending:${mergeFailure.error}`,
              updatedAt: federationNow(),
            };
          });
          return { job: pending.record ?? durable, merge };
        }
        const completedMerge = merge;
        let receiptRefusal: string | undefined;
        const receipt = await updateFederatedJob(p.projectRoot, record.jobId, (latest) => {
          if (
            latest.mergeStatus !== "publishing" ||
            latest.nextAction !== "merge_gate" ||
            (latest.status !== "completed" && latest.status !== "blocked") ||
            !latest.mergeBinding
          ) {
            receiptRefusal = "publication_state_changed";
            return undefined;
          }
          try {
            assertSameMergeIdentity(binding, latest.mergeBinding);
          } catch (error: unknown) {
            receiptRefusal = gitErrorMessage(error);
            return undefined;
          }
          return {
            ...latest,
            status: "completed",
            blockReasonCode: undefined,
            error: undefined,
            mergeStatus: "merged",
            mergeCommitSha: completedMerge.commitSha,
            mergeError: undefined,
            nextAction: "broadcast_worker_refresh",
            updatedAt: federationNow(),
          };
        });
        if (!receipt.changed || !receipt.record) {
          current = receipt.record ?? durable;
          if (
            current.mergeStatus !== "merged" ||
            current.mergeCommitSha?.toLowerCase() !== completedMerge.commitSha.toLowerCase()
          ) {
            return {
              job: current,
              merge: {
                ok: false,
                error: `merge_receipt_refused:${receiptRefusal ?? "job_missing"}`,
                commands: merge.commands,
              },
            };
          }
        } else {
          current = receipt.record;
        }
      }
      return { job: current, merge };
    },
  );
  if (!mergeLane.acquired) {
    return {
      job: (await loadFederatedJob(p.projectRoot, record.jobId)) ?? record,
      merge: { ok: false, error: "merge_lane_busy", commands: 0 },
    };
  }
  const { job: laneCurrent, merge } = mergeLane.value;
  let current = laneCurrent;

  if (merge.ok && current.nextAction === "broadcast_worker_refresh") {
    try {
      const commandCount = await broadcastRefresh(
        p.projectRoot,
        current.taskId,
        binding.targetBranch,
        p.projectId,
      );
      current =
        (await recordFederatedWorkerRefreshOutcome(
          p.projectRoot,
          current.jobId,
          current.mergeCommitSha,
          binding,
          { ok: true, commandCount, completedAt: federationNow() },
        )) ?? current;
    } catch (error: unknown) {
      current =
        (await recordFederatedWorkerRefreshOutcome(
          p.projectRoot,
          current.jobId,
          current.mergeCommitSha,
          binding,
          { ok: false, error: gitErrorMessage(error), failedAt: federationNow() },
        )) ?? current;
    }
  }

  return { job: current, merge };
}

export async function orchestrateFederatedCompletion(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  options: FederatedCompletionOptions,
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedOrchestrationResult> {
  if (!p.projectRoot) {
    return { job: record };
  }
  const projectRoot = p.projectRoot;
  const pendingCompletion = await readCompletionIntent(projectRoot, record.jobId);
  if (pendingCompletion) {
    return reconcileCompletionIntent(
      p as FederationProjectContext & { projectRoot: string },
      pendingCompletion,
      deps,
      claimantIndex,
    );
  }
  if (record.status === "canceled" || record.status === "failed" || record.status === "rejected") {
    return { job: record };
  }
  if (isFederatedPublicationRecovery(record)) {
    return recoverFederatedPublication(
      p as FederationProjectContext & { projectRoot: string },
      record,
      deps,
    );
  }
  if (record.mergeStatus === "merged") {
    return {
      job: record,
      merge: { ok: false, error: "merged_job_missing_publication_binding", commands: 0 },
    };
  }
  const workerAlreadyMerged =
    options.workerCompletion?.autoMerged === true &&
    (options.workerCompletion?.verified === true ||
      options.workerCompletion?.verificationVerdict === "VERIFIED");
  if (workerAlreadyMerged) {
    const reason = "worker_side_auto_merge_requires_manual_reconciliation";
    const refused = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (
        current.status === "canceled" ||
        current.status === "failed" ||
        current.status === "rejected" ||
        current.mergeStatus === "publishing" ||
        current.mergeStatus === "merged"
      ) {
        return undefined;
      }
      return {
        ...current,
        status: "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: reason,
        mergeStatus: "failed",
        mergeError: reason,
        nextAction: "manual_merge_recovery",
        updatedAt: federationNow(),
      };
    });
    return {
      job: refused.record ?? record,
      merge: { ok: false, error: reason, commands: 0 },
    };
  }
  if (!options.autoVerify) {
    return { job: record };
  }
  const broadcastRefresh = deps.broadcastRefresh ?? broadcastWorkerRefreshCommand;

  const strictIndex = claimantIndex ?? (await buildFederationClaimantIndex(p));
  if (strictIndex.status === "unavailable") {
    const unavailable = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
      return {
        ...current,
        status: terminalFederatedStatus(current.status) ? current.status : "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: `duplicate_claimants_unavailable:${strictIndex.reason}`,
        nextAction: "restore_duplicate_claimant_scan",
        updatedAt: federationNow(),
      };
    });
    return { job: unavailable.record ?? record };
  }
  const claimantRefusal = duplicateClaimantRefusalForIndex(strictIndex, record.taskId);
  if (claimantRefusal) {
    const refused = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
      return {
        ...current,
        status: terminalFederatedStatus(current.status) ? current.status : "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: `duplicate_claimants:${claimantRefusal.taskId}:${claimantRefusal.claimants.join(",")}`,
        nextAction: "resolve_duplicate_claimants",
        updatedAt: federationNow(),
      };
    });
    return { job: refused.record ?? record };
  }
  if (!p.taskService) {
    return { job: record };
  }

  const task = await p.taskService.getTask(record.taskId);
  if (!task) {
    const blocked = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
      return {
        ...current,
        status: "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: "task_not_found_for_completion_orchestrator",
        nextAction: "fix_task_spec",
        updatedAt: federationNow(),
      };
    });
    return { job: blocked.record ?? record };
  }

  const reviewId =
    options.verification?.reviewId ??
    record.reviewId ??
    (await latestReviewIdForTask(p.projectRoot, record.taskId));
  const verifyWorkflow = deps.verifyWorkflow ?? runVerifyWorkflow;
  const verification = await verifyWorkflow({
    projectRoot: p.projectRoot,
    task,
    projectId: p.projectId,
    workflowId: options.workerCompletion?.verificationWorkflowId ?? record.verificationWorkflowId,
    reviewId,
    requireReview: options.verification?.requireReview ?? true,
    phaseResults: options.verification?.phaseResults,
    criteriaChecked: options.verification?.criteriaChecked,
    criteriaPassed: options.verification?.criteriaPassed,
    notes: "Federated post-task orchestrator",
  });

  const withVerificationMetadata = (current: FederatedJobRecord): FederatedJobRecord => ({
    ...current,
    reviewId,
    verificationWorkflowId: verification.record.workflowId,
    completedAt: current.completedAt ?? federationNow(),
    updatedAt: federationNow(),
  });
  const emitVerificationResult = (): EventWriter => {
    const writer = deps.createWriter(
      p,
      federatedSessionId(record.jobId),
      record.taskId,
      record.taskId,
    );
    writer.emit("lifecycle_verify_result", {
      taskId: record.taskId,
      workflowId: verification.record.workflowId,
      projectId: p.projectId,
      verified: verification.verdict === "VERIFIED",
      verdict: verification.verdict,
      blockReasonCode: verification.record.blockReasonCode,
      findings:
        verification.record.attempts.at(-1)?.phaseResults.map((phase) => ({
          criterion: phase.name,
          status: phase.status === "passed" ? "pass" : phase.status === "failed" ? "fail" : "warn",
          evidence: phase.summary ?? phase.name,
        })) ?? [],
    });
    return writer;
  };

  let updated: FederatedJobRecord;

  if (verification.verdict === "BLOCKED") {
    const blocked = await updateFederatedJob(p.projectRoot, record.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
      const next = withVerificationMetadata(current);
      return {
        ...next,
        status: "blocked",
        blockReasonCode: verification.record.blockReasonCode ?? "review_linkage_required",
        error: "verification_blocked",
        nextAction: "record_merge_ready_review",
        mergeStatus: options.autoMerge ? "blocked" : next.mergeStatus,
      };
    });
    if (!blocked.changed || !blocked.record) return { job: blocked.record ?? record, verification };
    updated = blocked.record;
    emitVerificationResult();
    return { job: updated, verification };
  }

  if (verification.verdict === "FAILED") {
    let fixJob: FederatedJobRecord | undefined;
    const failed = await updateFederatedJobWithPostPersistEffect(
      p.projectRoot,
      record.jobId,
      async (current) => {
        if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
        const next = withVerificationMetadata(current);
        const retryCount = next.retryCount ?? 0;
        const maxRetries = Math.max(0, options.maxFixAttempts ?? next.maxRetries ?? 2);
        if ((next.fixJobIds ?? []).length > 0 && next.error === "verification_failed_fix_queued") {
          return { record: next, effect: () => Promise.resolve(undefined) };
        }
        if (retryCount < maxRetries) {
          const refusal = duplicateClaimantRefusalForIndex(strictIndex, next.taskId);
          if (refusal) {
            return {
              record: {
                ...next,
                status: "blocked",
                blockReasonCode: "pending_manual_handoff",
                error: `duplicate_claimants:${refusal.taskId}:${refusal.claimants.join(",")}`,
                nextAction: "resolve_duplicate_claimants",
              },
              effect: () => Promise.resolve(undefined),
            };
          }
          const nextRetryCount = retryCount + 1;
          const admittedFixJob: FederatedJobRecord = {
            ...queueFederatedJobRecord({
              projectId: current.projectId ?? p.projectId,
              taskId: next.taskId,
              jobType: "fix",
              requiredCapabilities: ["fix"],
              // TASK-1323 (Design 6): a NEW record gets its own channel while
              // inheriting the parent's identity fields; a legacy parent
              // without provenance yields channel + lineage alone.
              provenance: {
                ...(next.provenance ?? {}),
                channel: "fix-orchestration",
                parentJobId: next.jobId,
              },
              correlationId: `${next.correlationId}:fix:${nextRetryCount}`,
              parentJobId: next.jobId,
              branchName: options.branchName ?? next.branchName,
              commitSha: options.commitSha ?? next.commitSha,
              targetBranch: options.targetBranch ?? next.targetBranch,
              reviewId,
              maxRetries: 0,
              decision: {
                reason: "Verification failed; queued bounded federated fix job.",
                verificationWorkflowId: verification.record.workflowId,
              },
            }),
            jobId: deterministicFixJobId(
              next.jobId,
              nextRetryCount,
              verification.record.workflowId,
            ),
          };
          const effectId = randomUUID();
          const parentRecord = withCompletionEffectMarker(
            {
              ...next,
              status: "blocked",
              retryCount: nextRetryCount,
              fixJobIds: [...(next.fixJobIds ?? []), admittedFixJob.jobId],
              blockReasonCode: "pending_manual_handoff",
              error: "verification_failed_fix_queued",
              nextAction: "run_fix_job",
            },
            effectId,
            "fix",
          );
          const intent: FederatedFixCompletionIntent = {
            version: 1,
            kind: "fix",
            effectId,
            parentJobId: current.jobId,
            taskId: current.taskId,
            correlationId: current.correlationId,
            expectedUpdatedAt: current.updatedAt,
            expectedStatus: current.status,
            parentRecord,
            childRecord: admittedFixJob,
          };
          await publishCompletionIntent(projectRoot, intent);
          await deps.afterCompletionEffectForTest?.("fix_intent_persisted");
          return {
            record: parentRecord,
            effect: async () => {
              const effect = await applyCompletionIntentEffect(
                p as FederationProjectContext & { projectRoot: string },
                intent,
                deps,
                strictIndex,
              );
              fixJob = effect.fixJob;
              await retireCompletionIntent(projectRoot, current.jobId);
            },
          };
        }

        return {
          record: {
            ...next,
            status: "blocked",
            blockReasonCode: "workflow_attempts_exhausted",
            error: "verification_failed_fix_budget_exhausted",
            nextAction: "manual_handoff",
          },
          effect: () => Promise.resolve(undefined),
        };
      },
    );
    if (!failed.changed || !failed.record) return { job: failed.record ?? record, verification };
    updated = failed.record;
    emitVerificationResult();
    return { job: updated, verification, ...(fixJob ? { fixJob } : {}) };
  }

  const verified = await updateFederatedJobWithPostPersistEffect(
    p.projectRoot,
    record.jobId,
    async (current) => {
      if (!matchesFederatedCompletionSnapshot(current, record)) return undefined;
      const next = withVerificationMetadata(current);
      const effectId = randomUUID();
      const parentRecord = withCompletionEffectMarker(
        {
          ...next,
          status: "completed",
          blockReasonCode: undefined,
          error: undefined,
          nextAction: options.autoMerge ? "merge_gate" : "admin_review_merge",
        },
        effectId,
        "verified",
      );
      const intent: FederatedVerifiedCompletionIntent = {
        version: 1,
        kind: "verified",
        effectId,
        parentJobId: current.jobId,
        taskId: current.taskId,
        correlationId: current.correlationId,
        expectedUpdatedAt: current.updatedAt,
        expectedStatus: current.status,
        parentRecord,
        verification: {
          commitSha: options.commitSha ?? next.commitSha,
          criteriaChecked: options.verification?.criteriaChecked ?? task.successCriteria.length,
          criteriaPassed: options.verification?.criteriaPassed ?? task.successCriteria.length,
          reviewId,
          workflowId: verification.record.workflowId,
          verifiedAt: next.updatedAt.split("T")[0],
          updatedAt: next.updatedAt,
        },
      };
      await publishCompletionIntent(projectRoot, intent);
      await deps.afterCompletionEffectForTest?.("verification_intent_persisted");
      return {
        record: parentRecord,
        effect: async () => {
          await applyCompletionIntentEffect(
            p as FederationProjectContext & { projectRoot: string },
            intent,
            deps,
            strictIndex,
          );
          await retireCompletionIntent(projectRoot, current.jobId);
        },
      };
    },
  );
  if (!verified.changed || !verified.record)
    return { job: verified.record ?? record, verification };
  updated = verified.record;
  const writer = emitVerificationResult();

  if (!options.autoMerge) return { job: updated, verification };

  if (updated.mergeStatus === "merged") {
    if (updated.nextAction === "broadcast_worker_refresh") {
      try {
        const commandCount = await broadcastRefresh(
          p.projectRoot,
          updated.taskId,
          updated.targetBranch ?? "dev",
          p.projectId,
        );
        updated =
          (await recordFederatedWorkerRefreshOutcome(
            p.projectRoot,
            updated.jobId,
            updated.mergeCommitSha,
            updated.mergeBinding,
            { ok: true, commandCount, completedAt: federationNow() },
          )) ?? updated;
      } catch (error: unknown) {
        updated =
          (await recordFederatedWorkerRefreshOutcome(
            p.projectRoot,
            updated.jobId,
            updated.mergeCommitSha,
            updated.mergeBinding,
            { ok: false, error: gitErrorMessage(error), failedAt: federationNow() },
          )) ?? updated;
      }
    }
    return {
      job: updated,
      verification,
      merge: { ok: true, commitSha: updated.mergeCommitSha, commands: 0 },
    };
  }

  const review = await loadReviewBundle(p.projectRoot, reviewId);
  if (!review?.gate.mergeReady) {
    const blocked = await updateFederatedJob(p.projectRoot, updated.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, updated)) return undefined;
      return {
        ...current,
        status: "blocked",
        blockReasonCode: "review_linkage_required",
        error: "merge_gate_not_ready",
        mergeStatus: "blocked",
        nextAction: "record_merge_ready_review",
        updatedAt: federationNow(),
      };
    });
    if (!blocked.changed || !blocked.record)
      return { job: blocked.record ?? updated, verification };
    updated = blocked.record;
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_gate_not_ready", commands: 0 },
    };
  }

  const branchName = options.branchName ?? updated.branchName;
  const targetBranch = options.targetBranch ?? updated.targetBranch ?? "dev";
  const sourceCommitSha =
    options.commitSha ?? updated.commitSha ?? updated.mergeBinding?.sourceCommitSha;
  if (!branchName) {
    const blocked = await updateFederatedJob(p.projectRoot, updated.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, updated)) return undefined;
      return {
        ...current,
        status: "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: "merge_branch_missing",
        mergeStatus: "blocked",
        nextAction: "provide_worker_branch",
        updatedAt: federationNow(),
      };
    });
    if (!blocked.changed || !blocked.record)
      return { job: blocked.record ?? updated, verification };
    updated = blocked.record;
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_branch_missing", commands: 0 },
    };
  }

  if (!sourceCommitSha || !FEDERATED_COMMIT_PATTERN.test(sourceCommitSha)) {
    const blocked = await updateFederatedJob(p.projectRoot, updated.jobId, (current) => {
      if (!matchesFederatedCompletionSnapshot(current, updated)) return undefined;
      return {
        ...current,
        status: "blocked",
        blockReasonCode: "pending_manual_handoff",
        error: "merge_commit_missing_or_invalid",
        mergeStatus: "blocked",
        mergeError: "merge_commit_missing_or_invalid",
        nextAction: "provide_exact_worker_commit",
        updatedAt: federationNow(),
      };
    });
    if (!blocked.changed || !blocked.record)
      return { job: blocked.record ?? updated, verification };
    updated = blocked.record;
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_commit_missing_or_invalid", commands: 0 },
    };
  }

  let prepublicationRefusal: string | undefined;
  const prepublication = await updateFederatedJob(p.projectRoot, updated.jobId, (current) => {
    if (current.mergeStatus === "merged") {
      prepublicationRefusal = "already_merged";
      return undefined;
    }
    if (!matchesFederatedCompletionSnapshot(current, updated)) {
      prepublicationRefusal = `job_state_changed:${current.status}`;
      return undefined;
    }
    if (current.status !== "completed" && current.status !== "blocked") {
      prepublicationRefusal = `job_status_changed:${current.status}`;
      return undefined;
    }
    const conflict = federatedMergeIdentityConflict(
      current,
      branchName,
      sourceCommitSha,
      targetBranch,
    );
    if (conflict) {
      prepublicationRefusal = conflict;
      return undefined;
    }
    return {
      ...current,
      status: "completed",
      reviewId: updated.reviewId,
      verificationWorkflowId: updated.verificationWorkflowId,
      completedAt: current.completedAt ?? updated.completedAt,
      branchName,
      commitSha: sourceCommitSha.toLowerCase(),
      targetBranch,
      autoMerge: true,
      blockReasonCode: undefined,
      error: undefined,
      mergeStatus: current.mergeStatus === "publishing" ? "publishing" : "not_requested",
      mergeError: undefined,
      nextAction: "merge_gate",
      updatedAt: federationNow(),
    };
  });
  if (!prepublication.changed || !prepublication.record) {
    const current = prepublication.record ?? updated;
    if (prepublicationRefusal === "already_merged" && current.mergeStatus === "merged") {
      return {
        job: current,
        verification,
        merge: { ok: true, commitSha: current.mergeCommitSha, commands: 0 },
      };
    }
    return {
      job: current,
      verification,
      merge: {
        ok: false,
        error: `merge_prepublication_refused:${prepublicationRefusal ?? "job_missing"}`,
        commands: 0,
      },
    };
  }
  updated = prepublication.record;

  const requestedMergeIdentity: FederatedMergeBoundaryInput = {
    projectRoot: p.projectRoot,
    taskId: updated.taskId,
    sourceBranch: branchName,
    sourceCommitSha: sourceCommitSha.toLowerCase(),
    targetBranch,
  };
  const mergeBoundary = deps.mergeBoundary ?? defaultFederatedMergeBoundary;
  type MergeLaneOutcome =
    | { kind: "return"; result: FederatedOrchestrationResult }
    | {
        kind: "published";
        job: FederatedJobRecord;
        merge: Extract<FederatedMergeResult, { ok: true }>;
      };
  const stopMergeLane = (result: FederatedOrchestrationResult): MergeLaneOutcome => ({
    kind: "return",
    result,
  });
  const mergeLane = await withFederatedMergeLane(
    p.projectRoot,
    updated.jobId,
    updated.taskId,
    async (): Promise<MergeLaneOutcome> => {
      let merge: FederatedMergeResult | undefined;
      try {
        const durable = await loadFederatedJob(projectRoot, updated.jobId);
        if (durable?.mergeStatus === "merged") {
          if (!durable.mergeBinding) {
            return stopMergeLane({
              job: durable,
              verification,
              merge: { ok: false, error: "merged_job_missing_publication_binding", commands: 0 },
            });
          }
          try {
            assertSameMergeIdentity(durable.mergeBinding, {
              ...durable.mergeBinding,
              sourceBranch: branchName,
              sourceCommitSha: sourceCommitSha.toLowerCase(),
              targetBranch,
            });
          } catch (error: unknown) {
            return stopMergeLane({
              job: durable,
              verification,
              merge: {
                ok: false,
                error: `merge_binding_refused:${gitErrorMessage(error)}`,
                commands: 0,
              },
            });
          }
          return stopMergeLane({
            job: durable,
            verification,
            merge: { ok: true, commitSha: durable.mergeCommitSha, commands: 0 },
          });
        }

        let mergeBinding = durable?.mergeBinding ?? updated.mergeBinding;
        try {
          const durableConflict = durable
            ? federatedMergeIdentityConflict(durable, branchName, sourceCommitSha, targetBranch)
            : undefined;
          if (durableConflict) throw new Error(durableConflict);
          if (mergeBinding) {
            assertSameMergeIdentity(mergeBinding, {
              ...mergeBinding,
              sourceBranch: branchName,
              sourceCommitSha: sourceCommitSha.toLowerCase(),
              targetBranch,
            });
          } else {
            const observed = await mergeBoundary.seal(requestedMergeIdentity);
            assertValidMergeBinding(observed);
            assertSameMergeIdentity(observed, {
              ...observed,
              sourceBranch: branchName,
              sourceCommitSha: sourceCommitSha.toLowerCase(),
              targetBranch,
            });
            mergeBinding = observed;
          }
        } catch (error: unknown) {
          const message = `merge_binding_refused:${gitErrorMessage(error)}`;
          const refusal = await updateFederatedJob(projectRoot, updated.jobId, (current) => {
            if (current.mergeStatus === "merged") return undefined;
            if (current.status !== "completed" && current.status !== "blocked") return undefined;
            return {
              ...current,
              status: "blocked",
              blockReasonCode: "pending_manual_handoff",
              error: message,
              mergeStatus: "failed",
              mergeError: message,
              nextAction: "manual_merge_recovery",
              updatedAt: federationNow(),
            };
          });
          updated = refusal.record ?? updated;
          return stopMergeLane({
            job: updated,
            verification,
            merge: { ok: false, error: message, commands: 0 },
          });
        }

        // Persist the exact publication identity while owning the merge lane and
        // before the first repository mutation. A monitor restart reuses this
        // immutable capability instead of resolving mutable branch names again.
        if (!mergeBinding) {
          throw new Error("Federation merge binding was not produced by the sealing boundary.");
        }
        const bindingForAdmission = mergeBinding;
        let admissionRefusal: string | undefined;
        const admission = await updateFederatedJob(projectRoot, updated.jobId, (current) => {
          if (current.mergeStatus === "merged") {
            admissionRefusal = "already_merged";
            return undefined;
          }
          if (current.status !== "completed" && current.status !== "blocked") {
            admissionRefusal = `job_status_changed:${current.status}`;
            return undefined;
          }
          const conflict = federatedMergeIdentityConflict(
            current,
            branchName,
            sourceCommitSha,
            targetBranch,
          );
          if (conflict) {
            admissionRefusal = conflict;
            return undefined;
          }
          if (current.mergeBinding) {
            try {
              assertSameMergeIdentity(current.mergeBinding, bindingForAdmission);
            } catch (error: unknown) {
              admissionRefusal = gitErrorMessage(error);
              return undefined;
            }
          }
          return {
            ...current,
            status: "completed",
            reviewId: updated.reviewId,
            verificationWorkflowId: updated.verificationWorkflowId,
            completedAt: current.completedAt ?? updated.completedAt,
            branchName,
            commitSha: sourceCommitSha.toLowerCase(),
            targetBranch,
            mergeBinding: bindingForAdmission,
            blockReasonCode: undefined,
            error: undefined,
            mergeStatus: "publishing",
            mergeError: undefined,
            nextAction: "merge_gate",
            updatedAt: federationNow(),
          };
        });
        if (!admission.changed || !admission.record) {
          const current = admission.record ?? durable ?? updated;
          if (admissionRefusal === "already_merged" && current.mergeStatus === "merged") {
            return stopMergeLane({
              job: current,
              verification,
              merge: { ok: true, commitSha: current.mergeCommitSha, commands: 0 },
            });
          }
          return stopMergeLane({
            job: current,
            verification,
            merge: {
              ok: false,
              error: `merge_admission_refused:${admissionRefusal ?? "job_missing"}`,
              commands: 0,
            },
          });
        }
        updated = admission.record;
        mergeBinding = updated.mergeBinding;
        if (!mergeBinding) {
          throw new Error("Federation merge binding disappeared during atomic admission.");
        }

        merge = await mergeBoundary.merge({
          ...requestedMergeIdentity,
          binding: mergeBinding,
        });
      } catch (error: unknown) {
        merge = { ok: false, error: gitErrorMessage(error), commands: 0 };
      }
      if (!merge || !merge.ok) {
        const error = merge?.error ?? "federation_merge_failed_without_result";
        const failure = await updateFederatedJob(projectRoot, updated.jobId, (current) => {
          if (current.mergeStatus === "merged") return undefined;
          if (current.mergeStatus !== "publishing" || current.nextAction !== "merge_gate") {
            return undefined;
          }
          const binding = updated.mergeBinding;
          if (
            !binding ||
            federatedMergeIdentityConflict(
              current,
              binding.sourceBranch,
              binding.sourceCommitSha,
              binding.targetBranch,
            )
          ) {
            return undefined;
          }
          if (!current.mergeBinding) return undefined;
          try {
            assertSameMergeIdentity(binding, current.mergeBinding);
          } catch {
            return undefined;
          }
          return {
            ...current,
            error: `publication_recovery_pending:${error}`,
            mergeError: error,
            updatedAt: federationNow(),
          };
        });
        updated = failure.record ?? updated;
        return stopMergeLane({
          job: updated,
          verification,
          merge: merge ?? { ok: false, error, commands: 0 },
        });
      }

      // Record successful publication before any notification work. The exact
      // nonce in the merge commit also lets a retry recover a push that completed
      // immediately before this state write.
      let publicationReceiptRefusal: string | undefined;
      const publicationReceipt = await updateFederatedJob(projectRoot, updated.jobId, (current) => {
        if (current.mergeStatus === "merged") return undefined;
        if (current.status !== "completed" && current.status !== "blocked") {
          publicationReceiptRefusal = `job_status_changed:${current.status}`;
          return undefined;
        }
        const binding = updated.mergeBinding;
        if (
          !binding ||
          federatedMergeIdentityConflict(
            current,
            binding.sourceBranch,
            binding.sourceCommitSha,
            binding.targetBranch,
          )
        ) {
          publicationReceiptRefusal = "merge_binding_changed";
          return undefined;
        }
        if (!current.mergeBinding) {
          publicationReceiptRefusal = "merge_binding_missing";
          return undefined;
        }
        try {
          assertSameMergeIdentity(binding, current.mergeBinding);
        } catch (error: unknown) {
          publicationReceiptRefusal = gitErrorMessage(error);
          return undefined;
        }
        return {
          ...current,
          status: "completed",
          blockReasonCode: undefined,
          error: undefined,
          mergeStatus: "merged",
          mergeCommitSha: merge.commitSha,
          mergeError: undefined,
          nextAction: "broadcast_worker_refresh",
          updatedAt: federationNow(),
        };
      });
      if (!publicationReceipt.changed || !publicationReceipt.record) {
        const current = publicationReceipt.record ?? updated;
        if (current.mergeStatus !== "merged") {
          return stopMergeLane({
            job: current,
            verification,
            merge: {
              ok: false,
              error: `merge_receipt_refused:${publicationReceiptRefusal ?? "job_missing"}`,
              commands: merge.commands,
            },
          });
        }
      }
      updated = publicationReceipt.record ?? updated;
      return { kind: "published", job: updated, merge };
    },
  );
  if (!mergeLane.acquired) {
    const current = (await loadFederatedJob(p.projectRoot, updated.jobId)) ?? updated;
    return {
      job: current,
      verification,
      merge: { ok: false, error: "merge_lane_busy", commands: 0 },
    };
  }
  if (mergeLane.value.kind === "return") return mergeLane.value.result;
  updated = mergeLane.value.job;
  const successfulMerge = mergeLane.value.merge;

  let commandCount = 0;
  try {
    commandCount = await broadcastRefresh(p.projectRoot, updated.taskId, targetBranch, p.projectId);
    updated =
      (await recordFederatedWorkerRefreshOutcome(
        p.projectRoot,
        updated.jobId,
        updated.mergeCommitSha,
        updated.mergeBinding,
        { ok: true, commandCount, completedAt: federationNow() },
      )) ?? updated;
  } catch (error: unknown) {
    updated =
      (await recordFederatedWorkerRefreshOutcome(
        p.projectRoot,
        updated.jobId,
        updated.mergeCommitSha,
        updated.mergeBinding,
        { ok: false, error: gitErrorMessage(error), failedAt: federationNow() },
      )) ?? updated;
  }
  writer.emit("auto_merge_complete", {
    taskId: updated.taskId,
    targetBranch,
    strategy: "squash",
  });
  writer.emit("federated_job_status", {
    jobId: updated.jobId,
    taskId: updated.taskId,
    hostId: updated.hostId,
    status: "completed",
    workflowState: "merged",
    correlationId: updated.correlationId,
    remoteSessionId: updated.remoteSessionId,
    message: `Merged ${branchName} to ${targetBranch}; refresh command broadcast to ${commandCount} hosts.`,
    evidenceCount: updated.evidence?.length ?? 0,
  });
  return {
    job: updated,
    verification,
    merge: {
      ok: true,
      commitSha: updated.mergeCommitSha,
      commands: successfulMerge?.commands ?? 0,
    },
  };
}
