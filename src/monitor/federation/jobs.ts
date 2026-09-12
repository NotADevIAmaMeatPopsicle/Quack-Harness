// ─── Federation Job Helpers ────────────────────────────────────────
// Pure functions over FederatedJobRecord: id construction, queue sort,
// priority normalization, dependency-blocker extraction, queue-record
// factory.

import { federationNow } from "./lease.js";
import type { FederatedJobRecord, JobProvenance } from "./types.js";

export function federatedJobId(taskId: string): string {
  return `fed-${taskId.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function federatedSessionId(jobId: string): string {
  return `federation-${jobId}`;
}

export function sortFederatedQueue(jobs: FederatedJobRecord[]): FederatedJobRecord[] {
  return [...jobs].sort((a, b) => {
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt);
  });
}

export function federatedDependencyBlockers(record: FederatedJobRecord): string[] {
  const prefix = "blocked_by_unresolved:";
  if (record.status !== "blocked") return [];
  if (record.error?.startsWith(prefix)) {
    return record.error
      .slice(prefix.length)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  const preserved = record.decision.dependencyBlockers;
  return Array.isArray(preserved)
    ? preserved.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

export function normalizeFederatedPriority(value: number | string | undefined): {
  priority?: number;
  priorityLabel?: string;
} {
  if (typeof value === "number") return { priority: value };
  if (!value) return {};
  const label = value.trim().toUpperCase();
  const match = label.match(/^P([0-4])(?:\b|-|_)/) ?? label.match(/^P([0-4])$/);
  if (match) {
    const rankByPriority: Record<string, number> = {
      "0": 1000,
      "1": 800,
      "2": 600,
      "3": 400,
      "4": 200,
    };
    return { priority: rankByPriority[match[1] ?? "4"] ?? 0, priorityLabel: label };
  }
  const numeric = Number.parseInt(label, 10);
  return {
    priority: Number.isFinite(numeric) ? numeric : 0,
    priorityLabel: label,
  };
}

/**
 * TASK-1323: the ONE constructor for `FederatedJobRecord`. Every
 * creation path in the codebase goes through here (the queue wrapper
 * below, the legacy direct-assign route, the external-completion
 * importer, fix orchestration), which is what makes the required
 * `provenance` a real compile-time guarantee rather than a convention —
 * QPI-047 was one anonymous record costing three lanes hours. `extra`
 * deliberately CANNOT override the core identity fields or provenance.
 */
export function mintFederatedJobRecord(input: {
  /** Optional only for legacy fixture/import compatibility; production callers pass it. */
  projectId?: string;
  taskId: string;
  jobType: FederatedJobRecord["jobType"];
  requiredCapabilities: string[];
  provenance: JobProvenance;
  status: FederatedJobRecord["status"];
  /** Pre-minted id when the caller needs it before record creation. */
  jobId?: string;
  correlationId?: string;
  extra?: Omit<
    Partial<FederatedJobRecord>,
    | "jobId"
    | "projectId"
    | "taskId"
    | "jobType"
    | "status"
    | "correlationId"
    | "requiredCapabilities"
    | "provenance"
    | "createdAt"
    | "updatedAt"
  >;
}): FederatedJobRecord {
  const now = federationNow();
  const jobId = input.jobId ?? federatedJobId(input.taskId);
  return {
    decision: {},
    ...(input.extra ?? {}),
    projectId: input.projectId,
    jobId,
    taskId: input.taskId,
    jobType: input.jobType,
    status: input.status,
    correlationId: input.correlationId ?? jobId,
    requiredCapabilities: input.requiredCapabilities,
    provenance: input.provenance,
    createdAt: now,
    updatedAt: now,
  };
}

export function queueFederatedJobRecord(input: {
  /** Optional only for legacy fixture/import compatibility; production callers pass it. */
  projectId?: string;
  taskId: string;
  jobType: FederatedJobRecord["jobType"];
  requiredCapabilities: string[];
  /**
   * TASK-1323: REQUIRED, deliberately without a default. Every mint
   * site must declare how the job entered the system — this signature
   * is the compile-time guarantee that anonymous creation is
   * unrepresentable (QPI-047: one missing field cost three lanes hours).
   */
  provenance: JobProvenance;
  correlationId?: string;
  parentJobId?: string;
  preferredHostId?: string;
  priority?: number | string;
  leaseTtlMs?: number;
  maxRetries?: number;
  branchName?: string;
  commitSha?: string;
  targetBranch?: string;
  reviewId?: string;
  autoMerge?: boolean;
  /** QPI-048 leg (f): operator decomposition-gate override, carried to
   *  the executing listener's local start. */
  skipDecomposeCheck?: boolean;
  decision?: Record<string, unknown>;
}): FederatedJobRecord {
  const priority = normalizeFederatedPriority(input.priority);
  const record = mintFederatedJobRecord({
    projectId: input.projectId,
    taskId: input.taskId,
    jobType: input.jobType,
    requiredCapabilities: input.requiredCapabilities,
    provenance: input.provenance,
    status: "queued",
    correlationId: input.correlationId,
    extra: {
      parentJobId: input.parentJobId,
      preferredHostId: input.preferredHostId,
      priority: priority.priority,
      priorityLabel: priority.priorityLabel,
      leaseTtlMs: input.leaseTtlMs,
      retryCount: 0,
      maxRetries: Math.max(0, input.maxRetries ?? 2),
      branchName: input.branchName,
      commitSha: input.commitSha,
      targetBranch: input.targetBranch,
      reviewId: input.reviewId,
      autoMerge: input.autoMerge,
      skipDecomposeCheck: input.skipDecomposeCheck,
      mergeStatus: input.autoMerge ? "not_requested" : undefined,
      decision: input.decision ?? {
        reason: input.preferredHostId
          ? `Queued for preferred host ${input.preferredHostId}.`
          : "Queued for swarm scheduler assignment.",
      },
      nextAction: "schedule",
    },
  });
  // queuedAt matches createdAt exactly, as it always has.
  return { ...record, queuedAt: record.createdAt };
}
