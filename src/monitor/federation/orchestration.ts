import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type { EventWriter } from "../event-emitter.js";
import { recordVerification } from "../verification-store.js";
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
import { listFederatedJobs, saveFederatedJob } from "./store.js";
import type {
  FederatedCompletionOptions,
  FederatedJobRecord,
  FederatedOrchestrationResult,
  FederationProjectContext,
} from "./types.js";

export interface FederationOrchestrationDeps {
  createWriter: (
    p: FederationProjectContext,
    workflowId: string,
    taskId: string,
    title: string,
  ) => EventWriter;
}

export function shouldReconcileFederatedJob(record: FederatedJobRecord): boolean {
  if (record.status === "canceled" || record.status === "failed" || record.status === "rejected") {
    return false;
  }
  return (
    (record.status === "blocked" || record.status === "completed") &&
    (record.blockReasonCode === "review_linkage_required" ||
      record.nextAction === "record_merge_ready_review" ||
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
  if (strictIndex.status === "unavailable") return [];
  const reconciled: FederatedJobRecord[] = [];
  for (const job of await listFederatedJobs(p.projectRoot)) {
    if (!shouldReconcileFederatedJob(job)) continue;
    const result = await reconcileFederatedJob(p, job, {}, deps, strictIndex);
    reconciled.push(result.job);
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
  claimantIndex?: DuplicateClaimantIndex;
}): Promise<Awaited<ReturnType<typeof recordVerification>>> {
  const claimantIndex = input.claimantIndex ?? (await buildFederationClaimantIndex(input.p));
  const result = await recordVerification(
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
      verifiedAt: federationNow().split("T")[0],
    },
    { syncToPeers: false },
    claimantIndex,
  );
  if (result.applied) {
    await releaseFederatedDependencyBlocks(input.p, input.taskId, claimantIndex);
  }
  return result;
}

export function assertSafeGitRef(value: string, label: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`${label} contains unsafe characters.`);
  }
}

function gitOutput(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

function isBranchLockedInAnotherWorktree(message: string, targetBranch: string): boolean {
  return (
    message.includes(`'${targetBranch}' is already used by worktree`) ||
    message.includes(`"${targetBranch}" is already used by worktree`)
  );
}

function performFederatedSquashMergeInDetachedWorktree(input: {
  projectRoot: string;
  taskId: string;
  branchName: string;
  targetBranch: string;
  commands: number;
}):
  | { ok: true; commitSha: string; commands: number }
  | { ok: false; error: string; commands: number } {
  const worktreePath = path.join(
    tmpdir(),
    `quack-fed-merge-${input.taskId.toLowerCase()}-${Date.now()}`,
  );
  let commands = input.commands;

  try {
    gitOutput(input.projectRoot, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      `origin/${input.targetBranch}`,
    ]);
    commands += 1;
    const sourceRef = resolveMergeSourceRef(input.projectRoot, input.branchName);
    gitOutput(worktreePath, ["merge", "--squash", sourceRef]);
    commands += 1;
    const status = gitOutput(worktreePath, ["status", "--porcelain"]);
    if (!status) {
      return { ok: false, error: "merge_produced_no_changes", commands };
    }
    gitOutput(worktreePath, [
      "commit",
      "-m",
      `feat(${input.taskId.toLowerCase()}): merge federated work`,
    ]);
    commands += 1;
    const commitSha = gitOutput(worktreePath, ["rev-parse", "HEAD"]);
    gitOutput(worktreePath, ["push", "origin", `HEAD:${input.targetBranch}`]);
    commands += 1;
    return { ok: true, commitSha, commands };
  } catch (err: unknown) {
    try {
      gitOutput(worktreePath, ["reset", "--hard", "HEAD"]);
    } catch {
      // Best effort only.
    }
    return {
      ok: false,
      error: gitErrorMessage(err),
      commands,
    };
  } finally {
    try {
      gitOutput(input.projectRoot, ["worktree", "remove", worktreePath, "--force"]);
    } catch {
      // Best effort cleanup only.
    }
  }
}

function federationMergeLockPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "federation", "merge.lock");
}

export async function readFederatedMergeLock(
  projectRoot: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsPromises.readFile(federationMergeLockPath(projectRoot), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function acquireFederatedMergeLock(
  projectRoot: string,
  jobId: string,
  taskId: string,
): Promise<boolean> {
  await fsPromises.mkdir(path.dirname(federationMergeLockPath(projectRoot)), { recursive: true });
  try {
    await fsPromises.writeFile(
      federationMergeLockPath(projectRoot),
      JSON.stringify(
        {
          jobId,
          taskId,
          acquiredAt: federationNow(),
        },
        null,
        2,
      ),
      { encoding: "utf-8", flag: "wx" },
    );
    return true;
  } catch {
    return false;
  }
}

async function releaseFederatedMergeLock(projectRoot: string, jobId: string): Promise<void> {
  const lock = await readFederatedMergeLock(projectRoot);
  if (lock?.jobId !== jobId) return;
  try {
    await fsPromises.unlink(federationMergeLockPath(projectRoot));
  } catch {
    // Best-effort cleanup; a future merge attempt can report the stale lock.
  }
}

function resolveMergeSourceRef(projectRoot: string, branchName: string): string {
  assertSafeGitRef(branchName, "branchName");
  try {
    gitOutput(projectRoot, ["rev-parse", "--verify", branchName]);
    return branchName;
  } catch {
    const remoteRef = branchName.startsWith("origin/") ? branchName : `origin/${branchName}`;
    assertSafeGitRef(remoteRef, "remote branchName");
    gitOutput(projectRoot, ["rev-parse", "--verify", remoteRef]);
    return remoteRef;
  }
}

function performFederatedSquashMerge(input: {
  projectRoot: string;
  taskId: string;
  branchName: string;
  targetBranch: string;
}):
  | { ok: true; commitSha: string; commands: number }
  | { ok: false; error: string; commands: number } {
  const targetBranch = input.targetBranch || "dev";
  assertSafeGitRef(targetBranch, "targetBranch");
  let commands = 0;
  try {
    gitOutput(input.projectRoot, ["fetch", "origin"]);
    commands += 1;
    const sourceRef = resolveMergeSourceRef(input.projectRoot, input.branchName);
    try {
      gitOutput(input.projectRoot, ["checkout", targetBranch]);
      commands += 1;
    } catch (err: unknown) {
      const message = gitErrorMessage(err);
      if (isBranchLockedInAnotherWorktree(message, targetBranch)) {
        return performFederatedSquashMergeInDetachedWorktree({
          projectRoot: input.projectRoot,
          taskId: input.taskId,
          branchName: input.branchName,
          targetBranch,
          commands,
        });
      }
      return { ok: false, error: message, commands };
    }
    gitOutput(input.projectRoot, ["pull", "--ff-only", "origin", targetBranch]);
    commands += 1;
    gitOutput(input.projectRoot, ["merge", "--squash", sourceRef]);
    commands += 1;
    const status = gitOutput(input.projectRoot, ["status", "--porcelain"]);
    if (!status) {
      return { ok: false, error: "merge_produced_no_changes", commands };
    }
    gitOutput(input.projectRoot, [
      "commit",
      "-m",
      `feat(${input.taskId.toLowerCase()}): merge federated work`,
    ]);
    commands += 1;
    const commitSha = gitOutput(input.projectRoot, ["rev-parse", "HEAD"]);
    gitOutput(input.projectRoot, ["push", "origin", targetBranch]);
    commands += 1;
    return { ok: true, commitSha, commands };
  } catch (err: unknown) {
    try {
      gitOutput(input.projectRoot, ["merge", "--abort"]);
    } catch {
      // Squash merge may fail before MERGE_HEAD exists; ignore abort failures.
    }
    const message = gitErrorMessage(err);
    return { ok: false, error: message, commands };
  }
}

export async function orchestrateFederatedCompletion(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  options: FederatedCompletionOptions,
  deps: FederationOrchestrationDeps,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedOrchestrationResult> {
  if (!options.autoVerify) {
    return { job: record };
  }
  if (!p.projectRoot) {
    return { job: record };
  }

  const strictIndex = claimantIndex ?? (await buildFederationClaimantIndex(p));
  if (strictIndex.status === "unavailable") {
    const unavailable: FederatedJobRecord = {
      ...record,
      status: terminalFederatedStatus(record.status) ? record.status : "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: `duplicate_claimants_unavailable:${strictIndex.reason}`,
      nextAction: "restore_duplicate_claimant_scan",
      updatedAt: federationNow(),
    };
    await saveFederatedJob(p.projectRoot, unavailable);
    return { job: unavailable };
  }
  const claimantRefusal = duplicateClaimantRefusalForIndex(strictIndex, record.taskId);
  if (claimantRefusal) {
    const refused: FederatedJobRecord = {
      ...record,
      status: terminalFederatedStatus(record.status) ? record.status : "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: `duplicate_claimants:${claimantRefusal.taskId}:${claimantRefusal.claimants.join(",")}`,
      nextAction: "resolve_duplicate_claimants",
      updatedAt: federationNow(),
    };
    await saveFederatedJob(p.projectRoot, refused);
    return { job: refused };
  }
  if (!p.taskService) {
    return { job: record };
  }

  const task = await p.taskService.getTask(record.taskId);
  if (!task) {
    const blocked: FederatedJobRecord = {
      ...record,
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: "task_not_found_for_completion_orchestrator",
      nextAction: "fix_task_spec",
      updatedAt: federationNow(),
    };
    await saveFederatedJob(p.projectRoot, blocked);
    return { job: blocked };
  }

  const reviewId =
    options.verification?.reviewId ??
    record.reviewId ??
    (await latestReviewIdForTask(p.projectRoot, record.taskId));
  const workerAlreadyMerged =
    options.workerCompletion?.autoMerged === true &&
    (options.workerCompletion?.verified === true ||
      options.workerCompletion?.verificationVerdict === "VERIFIED");
  const verification = await runVerifyWorkflow({
    projectRoot: p.projectRoot,
    task,
    projectId: p.projectId,
    workflowId: options.workerCompletion?.verificationWorkflowId ?? record.verificationWorkflowId,
    reviewId,
    requireReview: workerAlreadyMerged ? false : (options.verification?.requireReview ?? true),
    phaseResults: options.verification?.phaseResults,
    criteriaChecked: options.verification?.criteriaChecked,
    criteriaPassed: options.verification?.criteriaPassed,
    notes: "Federated post-task orchestrator",
  });

  let updated: FederatedJobRecord = {
    ...record,
    reviewId,
    verificationWorkflowId: verification.record.workflowId,
    completedAt: record.completedAt ?? federationNow(),
    updatedAt: federationNow(),
  };

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

  if (verification.verdict === "BLOCKED") {
    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: verification.record.blockReasonCode ?? "review_linkage_required",
      error: "verification_blocked",
      nextAction: "record_merge_ready_review",
      mergeStatus: options.autoMerge ? "blocked" : updated.mergeStatus,
    };
    await saveFederatedJob(p.projectRoot, updated);
    return { job: updated, verification };
  }

  if (verification.verdict === "FAILED") {
    const retryCount = updated.retryCount ?? 0;
    const maxRetries = Math.max(0, options.maxFixAttempts ?? updated.maxRetries ?? 2);
    if (
      (updated.fixJobIds ?? []).length > 0 &&
      updated.error === "verification_failed_fix_queued"
    ) {
      await saveFederatedJob(p.projectRoot, updated);
      return { job: updated, verification };
    }
    if (retryCount < maxRetries) {
      const refusal = duplicateClaimantRefusalForIndex(strictIndex, updated.taskId);
      if (refusal) {
        updated = {
          ...updated,
          status: "blocked",
          blockReasonCode: "pending_manual_handoff",
          error: `duplicate_claimants:${refusal.taskId}:${refusal.claimants.join(",")}`,
          nextAction: "resolve_duplicate_claimants",
        };
        await saveFederatedJob(p.projectRoot, updated);
        return { job: updated, verification };
      }
      const nextRetryCount = retryCount + 1;
      const fixJob = queueFederatedJobRecord({
        taskId: updated.taskId,
        jobType: "fix",
        requiredCapabilities: ["fix"],
        // TASK-1323 (Design 6): a NEW record gets its own channel while
        // inheriting the parent's identity fields; a legacy parent
        // without provenance yields channel + lineage alone.
        provenance: {
          ...(updated.provenance ?? {}),
          channel: "fix-orchestration",
          parentJobId: updated.jobId,
        },
        correlationId: `${updated.correlationId}:fix:${nextRetryCount}`,
        parentJobId: updated.jobId,
        branchName: options.branchName ?? updated.branchName,
        commitSha: options.commitSha ?? updated.commitSha,
        targetBranch: options.targetBranch ?? updated.targetBranch,
        reviewId,
        maxRetries: 0,
        decision: {
          reason: "Verification failed; queued bounded federated fix job.",
          verificationWorkflowId: verification.record.workflowId,
        },
      });
      await saveFederatedJob(p.projectRoot, fixJob);
      updated = {
        ...updated,
        status: "blocked",
        retryCount: nextRetryCount,
        fixJobIds: [...(updated.fixJobIds ?? []), fixJob.jobId],
        blockReasonCode: "pending_manual_handoff",
        error: "verification_failed_fix_queued",
        nextAction: "run_fix_job",
      };
      await saveFederatedJob(p.projectRoot, updated);
      return { job: updated, verification, fixJob };
    }

    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: "workflow_attempts_exhausted",
      error: "verification_failed_fix_budget_exhausted",
      nextAction: "manual_handoff",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return { job: updated, verification };
  }

  updated = {
    ...updated,
    status: "completed",
    blockReasonCode: undefined,
    error: undefined,
    nextAction: options.autoMerge ? "merge_gate" : "admin_review_merge",
  };
  const verificationRecord = await recordFederatedVerifiedTask({
    p,
    taskId: updated.taskId,
    commitSha: options.commitSha ?? updated.commitSha,
    criteriaChecked: options.verification?.criteriaChecked ?? task.successCriteria.length,
    criteriaPassed: options.verification?.criteriaPassed ?? task.successCriteria.length,
    reviewId,
    workflowId: verification.record.workflowId,
    claimantIndex: strictIndex,
  });
  if (!verificationRecord.applied && verificationRecord.refusal) {
    updated = {
      ...updated,
      status: "completed",
      blockReasonCode: "pending_manual_handoff",
      error: `duplicate_claimants:${verificationRecord.refusal.taskId}:${verificationRecord.refusal.claimants.join(",")}`,
      nextAction: "resolve_duplicate_claimants",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return { job: updated, verification };
  }

  if (workerAlreadyMerged) {
    const targetBranch =
      options.workerCompletion?.mergeTargetBranch ??
      options.targetBranch ??
      updated.targetBranch ??
      "dev";
    const commandCount = await broadcastWorkerRefreshCommand(
      p.projectRoot,
      updated.taskId,
      targetBranch,
      p.projectId,
    );
    updated = {
      ...updated,
      status: "completed",
      targetBranch,
      mergeStatus: "merged",
      mergeCommitSha:
        options.workerCompletion?.mergeCommitSha ?? options.commitSha ?? updated.commitSha,
      pullCommandBroadcastAt: federationNow(),
      nextAction: commandCount > 0 ? "hosts_pull_dev" : "merged_no_registered_hosts",
      updatedAt: federationNow(),
    };
    await saveFederatedJob(p.projectRoot, updated);
    writer.emit("auto_merge_complete", {
      taskId: updated.taskId,
      targetBranch,
      strategy: "worker-reported",
      mergeCommitSha: updated.mergeCommitSha,
    });
    writer.emit("federated_job_status", {
      jobId: updated.jobId,
      taskId: updated.taskId,
      hostId: updated.hostId,
      status: "completed",
      workflowState: "merged",
      correlationId: updated.correlationId,
      remoteSessionId: updated.remoteSessionId,
      message: `Worker already merged ${updated.branchName ?? updated.taskId} to ${targetBranch}; refresh command broadcast to ${commandCount} hosts.`,
      evidenceCount: updated.evidence?.length ?? 0,
    });
    return {
      job: updated,
      verification,
      merge: { ok: true, commitSha: updated.mergeCommitSha, commands: commandCount },
    };
  }

  if (!options.autoMerge) {
    await saveFederatedJob(p.projectRoot, updated);
    return { job: updated, verification };
  }

  if (updated.mergeStatus === "merged") {
    await saveFederatedJob(p.projectRoot, updated);
    return {
      job: updated,
      verification,
      merge: { ok: true, commitSha: updated.mergeCommitSha, commands: 0 },
    };
  }

  const review = await loadReviewBundle(p.projectRoot, reviewId);
  if (!review?.gate.mergeReady) {
    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: "review_linkage_required",
      error: "merge_gate_not_ready",
      mergeStatus: "blocked",
      nextAction: "record_merge_ready_review",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_gate_not_ready", commands: 0 },
    };
  }

  const branchName = options.branchName ?? updated.branchName;
  const targetBranch = options.targetBranch ?? updated.targetBranch ?? "dev";
  if (!branchName) {
    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: "merge_branch_missing",
      mergeStatus: "blocked",
      nextAction: "provide_worker_branch",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_branch_missing", commands: 0 },
    };
  }

  const lockAcquired = await acquireFederatedMergeLock(
    p.projectRoot,
    updated.jobId,
    updated.taskId,
  );
  if (!lockAcquired) {
    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: "merge_lane_busy",
      mergeStatus: "blocked",
      mergeError: "merge_lane_busy",
      nextAction: "retry_merge_after_lane_idle",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return {
      job: updated,
      verification,
      merge: { ok: false, error: "merge_lane_busy", commands: 0 },
    };
  }

  const merge = performFederatedSquashMerge({
    projectRoot: p.projectRoot,
    taskId: updated.taskId,
    branchName,
    targetBranch,
  });
  await releaseFederatedMergeLock(p.projectRoot, updated.jobId);
  if (!merge.ok) {
    updated = {
      ...updated,
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: merge.error,
      mergeStatus: "failed",
      mergeError: merge.error,
      nextAction: "manual_merge_recovery",
    };
    await saveFederatedJob(p.projectRoot, updated);
    return { job: updated, verification, merge };
  }

  const commandCount = await broadcastWorkerRefreshCommand(
    p.projectRoot,
    updated.taskId,
    targetBranch,
    p.projectId,
  );
  updated = {
    ...updated,
    status: "completed",
    mergeStatus: "merged",
    mergeCommitSha: merge.commitSha,
    pullCommandBroadcastAt: federationNow(),
    nextAction: commandCount > 0 ? "hosts_pull_dev" : "merged_no_registered_hosts",
    updatedAt: federationNow(),
  };
  await saveFederatedJob(p.projectRoot, updated);
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
  return { job: updated, verification, merge };
}
