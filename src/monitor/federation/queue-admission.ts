import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  normalizeClaimantTaskId,
  duplicateClaimantRefusalForIndex,
} from "../../core/duplicate-claimants.js";
import {
  buildFederationClaimantIndex,
  isRecoverableFederatedSchedulingBlock,
} from "./scheduling.js";
import { queueFederatedJobRecord } from "./jobs.js";
import {
  listFederatedJobs,
  loadFederatedJob,
  saveFederatedJob,
  withFederatedJobLock,
  withOwnerFencedFileLock,
} from "./store.js";
import type { FederatedJobRecord, FederationProjectContext } from "./types.js";

type QueueInput = Parameters<typeof queueFederatedJobRecord>[0];
type QueueAdmission =
  | { ok: true; record: FederatedJobRecord; created: boolean }
  | {
      ok: false;
      error: string;
      message: string;
      jobIds?: string[];
      taskId?: string;
      claimants?: string[];
    };

function executionIntent(job: FederatedJobRecord): string {
  return JSON.stringify({
    capabilities: [...new Set(job.requiredCapabilities)].sort(),
    parentJobId: job.parentJobId ?? null,
    preferredHostId: job.preferredHostId ?? null,
    priority: job.priority ?? 0,
    leaseTtlMs: job.leaseTtlMs ?? null,
    maxRetries: job.maxRetries ?? 2,
    branchName: job.branchName ?? null,
    commitSha: job.commitSha ?? null,
    targetBranch: job.targetBranch ?? null,
    reviewId: job.reviewId ?? null,
    autoMerge: job.autoMerge === true,
    skipDecomposeCheck: job.skipDecomposeCheck === true,
  });
}

function unfinished(job: FederatedJobRecord): boolean {
  return !["completed", "failed", "rejected", "canceled"].includes(job.status);
}

/** Serialize repeated enqueue for one canonical project/task/type using the existing lock protocol. */
export async function admitFederatedQueueRecord(
  p: FederationProjectContext,
  input: QueueInput,
): Promise<QueueAdmission> {
  if (!p.projectRoot || input.projectId !== p.projectId)
    throw new Error("Queue admission requires a canonical project");
  const root = p.projectRoot;
  const taskId = normalizeClaimantTaskId(input.taskId);
  const key = createHash("sha256")
    .update(JSON.stringify([p.projectId, taskId, input.jobType]))
    .digest("hex");
  return withOwnerFencedFileLock(
    path.join(root, ".quack", "federation", "queue-admission", `${key}.lock`),
    root,
    async (): Promise<QueueAdmission> => {
      const refusal = duplicateClaimantRefusalForIndex(
        await buildFederationClaimantIndex(p),
        taskId,
      );
      if (refusal) return { ok: false, ...refusal };
      const proposed = queueFederatedJobRecord({ ...input, taskId });
      // Discovery is protected against other enqueue callers; the existing job
      // fence below orders this decision against cancel/assignment/recovery.
      const candidates = (await listFederatedJobs(root)).filter(
        (job) =>
          normalizeClaimantTaskId(job.taskId) === taskId &&
          job.jobType === input.jobType &&
          unfinished(job),
      );
      if (candidates.length > 1)
        return {
          ok: false,
          error: "federated_queue_conflict",
          message: "Multiple unfinished jobs require reconciliation before enqueue.",
          jobIds: candidates.map((job) => job.jobId),
        };
      const candidate = candidates[0];
      if (candidate) {
        const existing = await withFederatedJobLock(
          root,
          candidate.jobId,
          async (): Promise<QueueAdmission | undefined> => {
            const current = await loadFederatedJob(root, candidate.jobId);
            if (!current || !unfinished(current)) return undefined;
            if (
              current.projectId !== p.projectId ||
              executionIntent(current) !== executionIntent(proposed) ||
              (current.status === "blocked" && !isRecoverableFederatedSchedulingBlock(current))
            )
              return {
                ok: false,
                error: "federated_queue_conflict",
                message: "An unfinished job has different intent or requires manual recovery.",
                jobIds: [current.jobId],
              };
            return { ok: true, created: false, record: current };
          },
        );
        if (existing) return existing;
      }
      await saveFederatedJob(root, proposed);
      return { ok: true, created: true, record: proposed };
    },
  );
}
