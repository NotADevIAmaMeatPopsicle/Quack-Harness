import type { EventWriter } from "../event-emitter.js";
import { routeFederatedJob } from "../../federation/job-router.js";
import type { BlockReasonCode } from "../../workflow/workflow-state-types.js";
import { resolveFederatedTaskEventDetails, sessionTitleForFederatedTask } from "./events.js";
import { defaultFederatedHosts, federatedHostEventDetailsFromHost } from "./host.js";
import { federatedDependencyBlockers, federatedSessionId, sortFederatedQueue } from "./jobs.js";
import { createFederatedLease, federationNow, leaseExpired } from "./lease.js";
import { ReadinessService } from "../readiness-service.js";
import { holdsWorkerAttachment } from "./status.js";
import { listFederatedJobs, saveFederatedJob } from "./store.js";
import { listTaskClaimantDeclarations } from "../../core/task-file-resolver.js";
import type {
  FederatedJobRecord,
  FederatedRuntimeStatus,
  FederatedSchedulingOptions,
  FederationProjectContext,
} from "./types.js";
import {
  buildStrictDuplicateClaimantIndex,
  duplicateClaimantRefusalForIndex,
  normalizeClaimantTaskId,
  type DuplicateClaimantIndex,
  type DuplicateClaimantScanProducer,
} from "../../core/duplicate-claimants.js";

export interface FederationSchedulingDeps {
  createWriter: (
    p: FederationProjectContext,
    workflowId: string,
    taskId: string,
    title: string,
  ) => EventWriter;
  reconcileJobs?: (
    p: FederationProjectContext,
    claimantIndex?: DuplicateClaimantIndex,
  ) => Promise<FederatedJobRecord[]>;
  scanTaskClaimants?: DuplicateClaimantScanProducer;
}

export async function buildFederationClaimantIndex(
  p: FederationProjectContext,
  producer?: DuplicateClaimantScanProducer,
): Promise<DuplicateClaimantIndex> {
  if (!p.taskService) return buildStrictDuplicateClaimantIndex();
  const taskDir = p.taskService.getTaskDirectory();
  return buildStrictDuplicateClaimantIndex(
    producer ?? (() => listTaskClaimantDeclarations(taskDir)),
  );
}

function duplicateIntegrityFailure(
  index: DuplicateClaimantIndex,
  taskIds: readonly string[],
):
  | {
      ok: false;
      blockReasonCode: BlockReasonCode;
      error: string;
      nextAction: string;
      retryable: boolean;
    }
  | undefined {
  for (const taskId of taskIds) {
    const refusal = duplicateClaimantRefusalForIndex(index, taskId);
    if (!refusal) continue;
    return {
      ok: false,
      blockReasonCode: "pending_manual_handoff",
      error:
        index.status === "unavailable"
          ? `duplicate_claimants_unavailable:${index.reason}`
          : `duplicate_claimants:${refusal.taskId}:${refusal.claimants.join(",")}`,
      nextAction: "resolve_duplicate_claimants",
      retryable: index.status === "unavailable",
    };
  }
  return undefined;
}

export async function releaseFederatedDependencyBlocks(
  p: FederationProjectContext,
  completedTaskId: string,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedJobRecord[]> {
  if (!p.projectRoot) return [];

  const index = claimantIndex ?? (await buildFederationClaimantIndex(p));
  const normalizedCompletedTaskId = normalizeClaimantTaskId(completedTaskId);

  const released: FederatedJobRecord[] = [];
  const now = federationNow();
  for (const job of await listFederatedJobs(p.projectRoot)) {
    const blockers = federatedDependencyBlockers(job);
    if (!blockers.map(normalizeClaimantTaskId).includes(normalizedCompletedTaskId)) continue;

    const dependencyFailure = duplicateIntegrityFailure(index, [normalizedCompletedTaskId]);
    const gate = dependencyFailure ?? (await evaluateFederatedSchedulingGate(p, job, {}, index));
    if (!gate.ok) {
      const updated: FederatedJobRecord = {
        ...job,
        blockReasonCode: gate.blockReasonCode,
        error: gate.error,
        nextAction: gate.nextAction,
        retryable: gate.retryable,
        decision: {
          ...job.decision,
          dependencyBlockers: blockers,
        },
        updatedAt: now,
      };
      await saveFederatedJob(p.projectRoot, updated);
      continue;
    }

    const updated: FederatedJobRecord = {
      ...job,
      status: "queued",
      hostId: undefined,
      lease: undefined,
      blockReasonCode: undefined,
      error: undefined,
      retryable: undefined,
      nextAction: "schedule_after_dependency_verified",
      queuedAt: now,
      updatedAt: now,
      decision: {
        ...job.decision,
        dependencyBlockers: undefined,
        reason: `Dependency ${completedTaskId} verified; job released for scheduling.`,
        unblockedBy: completedTaskId,
      },
    };
    await saveFederatedJob(p.projectRoot, updated);
    released.push(updated);
  }

  return released;
}

export function federatedStatusTransitionFreedCapacity(
  previousStatus: FederatedRuntimeStatus,
  nextStatus: FederatedRuntimeStatus,
): boolean {
  // TASK-1329: keyed on ATTACHMENT, not assignability. `running` ->
  // `awaiting_approval` does not free anything: the listener is still bound and
  // still holds the slot. Reading it as freed would tick the scheduler into a
  // slot that is not actually available, which is the same over-assignment
  // failure as the host load count.
  return (
    previousStatus !== "queued" &&
    holdsWorkerAttachment(previousStatus) &&
    !holdsWorkerAttachment(nextStatus)
  );
}

export async function hasQueuedFederatedJobs(projectRoot: string): Promise<boolean> {
  return (await listFederatedJobs(projectRoot)).some((job) => job.status === "queued");
}

export async function getFederatedDependencyStatus(
  p: FederationProjectContext,
  taskId: string,
): Promise<string | undefined> {
  const normalizedTaskId = normalizeClaimantTaskId(taskId);
  const dbStatus = p.db.getStatus(normalizedTaskId)?.status;
  if (dbStatus) return dbStatus;
  const task = await p.taskService?.getTask(normalizedTaskId);
  return task?.status;
}

async function resolveFederatedDependencyState(
  p: FederationProjectContext,
  rawDependencyIds: readonly string[],
): Promise<{ unresolved: string[]; satisfiers: string[] }> {
  const taskList = p.taskService ? (await p.taskService.listTasks()).tasks : [];
  const summaries = new Map(taskList.map((task) => [normalizeClaimantTaskId(task.id), task]));
  const knownTaskIds = new Set(summaries.keys());
  const statusRows = typeof p.db.getAllStatuses === "function" ? p.db.getAllStatuses() : [];
  for (const row of statusRows) {
    knownTaskIds.add(normalizeClaimantTaskId(row.task_id));
  }
  const unresolved: string[] = [];
  const satisfiers: string[] = [];

  for (const rawDependencyId of rawDependencyIds) {
    const dependencyId = normalizeClaimantTaskId(rawDependencyId);
    const dependencyStatus = await getFederatedDependencyStatus(p, dependencyId);
    if (dependencyStatus === "COMPLETE" || dependencyStatus === "VERIFIED") {
      satisfiers.push(dependencyId);
      continue;
    }

    const prefix = `${dependencyId}-`;
    const subtasks = [...knownTaskIds].filter((id) => id.startsWith(prefix));
    if (subtasks.length > 0) {
      const incomplete: string[] = [];
      for (const subtaskId of subtasks) {
        const status = await getFederatedDependencyStatus(p, subtaskId);
        if (status !== "COMPLETE" && status !== "VERIFIED") incomplete.push(subtaskId);
      }
      if (incomplete.length === 0) {
        satisfiers.push(...subtasks);
      } else {
        unresolved.push(...incomplete);
      }
      continue;
    }

    unresolved.push(dependencyId);
  }

  return {
    unresolved: [...new Set(unresolved)],
    satisfiers: [...new Set(satisfiers)],
  };
}

export async function evaluateFederatedSchedulingGate(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  options: FederatedSchedulingOptions,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<
  | { ok: true }
  | {
      ok: false;
      blockReasonCode: BlockReasonCode;
      error: string;
      nextAction: string;
      retryable: boolean;
    }
> {
  if (!p.projectRoot) return { ok: true };
  const index = claimantIndex ?? (await buildFederationClaimantIndex(p));
  const targetFailure = duplicateIntegrityFailure(index, [record.taskId]);
  if (targetFailure) return targetFailure;
  if (!p.taskService) {
    return (
      duplicateIntegrityFailure(index, [record.taskId]) ?? {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error:
          "duplicate_claimants_unavailable:TaskService is unavailable for duplicate claimant scan.",
        nextAction: "restore_task_service",
        retryable: true,
      }
    );
  }
  const task = await p.taskService.getTask(normalizeClaimantTaskId(record.taskId));
  if (!task) {
    return {
      ok: false,
      blockReasonCode: "pending_manual_handoff",
      error: "task_not_found",
      nextAction: "fix_task_spec",
      retryable: false,
    };
  }

  if (task.blockedBy.length > 0) {
    const dependencyState = await resolveFederatedDependencyState(p, task.blockedBy);
    const dependencyFailure = duplicateIntegrityFailure(index, dependencyState.satisfiers);
    if (dependencyFailure) return dependencyFailure;
    const unresolved = dependencyState.unresolved;
    if (unresolved.length > 0 && !options.bypassDependencyGate) {
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: `blocked_by_unresolved:${unresolved.join(",")}`,
        nextAction: "wait_for_dependencies",
        retryable: true,
      };
    }
  }

  if (record.jobType === "dispatch" && !options.allowLowPreflight) {
    const readiness = new ReadinessService({
      projectRoot: p.projectRoot,
      taskService: p.taskService,
      prepCache: p.prepCache,
      db: p.db,
    });
    const state = await readiness.resolveCurrent(record.taskId);
    const preflight = state?.preflight ?? null;
    // QPI-051 (live on the 2026-08-10 1282 wave): the deterministic prep
    // is the ADMISSION authority. A preflight's embedded gate block can
    // misrepresent — score 0 assembled under readiness-shadow
    // `safety_stop`, or a gateSkipped run — and its DB snapshot copy
    // outlives on-disk artifact removal, so a poisoned block would
    // otherwise refuse a legitimately prepped task forever (three
    // federation jobs piled blocked on `preflight_gate_failed:0.0`
    // against a 4.9 prep). A CURRENT passing prep therefore admits even
    // when the preflight gate section reads failed; a passing preflight
    // still admits on its own (the designed rescue for stale prep).
    const currentPrep = state?.prep ?? null;
    const prepPasses =
      currentPrep !== null &&
      state?.hasStalePrep !== true &&
      currentPrep.depthReady &&
      currentPrep.depthScore >= 4.7 &&
      currentPrep.outcome !== "rejected";
    if (preflight && preflight.gate.gateSkipped !== true) {
      if (preflight.gate.ready && preflight.gate.score >= 4.7) {
        return { ok: true };
      }
      if (prepPasses) {
        return { ok: true };
      }
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: `preflight_gate_failed:${preflight.gate.score.toFixed(1)}`,
        nextAction: preflight.complexity.recommendDecomposition ? "decompose" : "enrich_and_reprep",
        retryable: true,
      };
    }
    // gateSkipped preflights carry no admission verdict — fall through
    // to the prep-side evaluation exactly like an absent preflight.

    const prep = state?.prep ?? null;
    if (state?.hasStalePrep) {
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: "preflight_gate_stale",
        nextAction: "reprep",
        retryable: true,
      };
    }
    if (!prep && !options.allowMissingPreflight) {
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: "preflight_gate_missing",
        nextAction: "prep_or_preflight",
        retryable: true,
      };
    }
    if (prep && (!prep.depthReady || prep.depthScore < 4.7 || prep.outcome === "rejected")) {
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: `preflight_gate_failed:${prep.depthScore.toFixed(1)}`,
        nextAction: prep.recommendDecomposition ? "decompose" : "enrich_and_reprep",
        retryable: true,
      };
    }
  }

  return { ok: true };
}

export async function assignFederatedJob(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  deps: FederationSchedulingDeps,
  options: FederatedSchedulingOptions = {},
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedJobRecord> {
  if (!p.projectRoot) return record;

  const gate = await evaluateFederatedSchedulingGate(p, record, options, claimantIndex);
  if (!gate.ok) {
    const blocked: FederatedJobRecord = {
      ...record,
      status: "blocked",
      retryable: gate.retryable,
      blockReasonCode: gate.blockReasonCode,
      error: gate.error,
      nextAction: gate.nextAction,
      updatedAt: federationNow(),
    };
    await saveFederatedJob(p.projectRoot, blocked);
    return blocked;
  }

  const routedHosts = await defaultFederatedHosts(p.projectRoot);
  const route = routeFederatedJob({
    taskId: record.taskId,
    jobType: record.jobType,
    requiredCapabilities: record.requiredCapabilities,
    preferredHostId: options.preferredHostId,
    hosts: routedHosts,
  });
  const now = federationNow();

  if (!route.ok) {
    if (route.error === "host_at_capacity") {
      const waiting: FederatedJobRecord = {
        ...record,
        status: "queued",
        retryable: true,
        blockReasonCode: undefined,
        error: undefined,
        decision: route.fallback,
        nextAction: "wait_for_capacity",
        updatedAt: now,
      };
      await saveFederatedJob(p.projectRoot, waiting);
      return waiting;
    }
    const blocked: FederatedJobRecord = {
      ...record,
      status: "blocked",
      retryable: route.retryable,
      blockReasonCode: route.blockReasonCode,
      error: route.error,
      decision: route.fallback,
      nextAction: route.retryable ? "wait_for_listener" : "manual_handoff",
      updatedAt: now,
    };
    await saveFederatedJob(p.projectRoot, blocked);
    return blocked;
  }

  const assigned: FederatedJobRecord = {
    ...record,
    status: "assigned",
    requiredCapabilities: route.requiredCapabilities,
    hostId: route.host.id,
    fallbackUsed: route.fallbackUsed,
    retryable: undefined,
    blockReasonCode: undefined,
    error: undefined,
    decision: route.decision,
    lease: createFederatedLease(
      record.jobId,
      route.host.id,
      now,
      options.leaseTtlMs ?? record.leaseTtlMs,
    ),
    nextAction: `run_${record.jobType}`,
    assignedAt: now,
    updatedAt: now,
  };
  await saveFederatedJob(p.projectRoot, assigned);

  const taskDetails = await resolveFederatedTaskEventDetails(p, assigned.taskId);
  const taskTitle = sessionTitleForFederatedTask(taskDetails);
  const writer = deps.createWriter(
    p,
    federatedSessionId(record.jobId),
    assigned.taskId,
    taskTitle ?? assigned.taskId,
  );
  writer.recordSession("active", {
    outcome: "federated_job_assigned",
    title: taskTitle,
  });
  writer.emit("federated_job_assigned", {
    jobId: assigned.jobId,
    taskId: assigned.taskId,
    taskTitle: taskDetails.taskTitle,
    hostId: assigned.hostId ?? route.host.id,
    ...federatedHostEventDetailsFromHost(route.host),
    correlationId: assigned.correlationId,
    fallbackUsed: route.fallbackUsed,
    requiredCapabilities: assigned.requiredCapabilities,
  });
  return assigned;
}

function staleLeaseCanAutoRetry(job: FederatedJobRecord): boolean {
  if (job.status !== "assigned") return false;
  if (job.remoteSessionId) return false;
  if ((job.eventCount ?? 0) > 0) return false;
  if ((job.evidence?.length ?? 0) > 0) return false;
  if (job.lastEventAt || job.lastEventStage) return false;
  return true;
}

export async function recoverStaleFederatedLeases(
  p: FederationProjectContext,
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedJobRecord[]> {
  if (!p.projectRoot) return [];
  const index = claimantIndex ?? (await buildFederationClaimantIndex(p));
  const now = federationNow();
  const recovered: FederatedJobRecord[] = [];
  for (const job of await listFederatedJobs(p.projectRoot)) {
    // TASK-1329 R1-6: paused jobs MUST stay in the stale-lease sweep. They are
    // attached, so if the host holding one genuinely dies, this is the only path
    // that reclaims it. Filtering on the scheduler's active set here would leave
    // a paused job unreclaimable forever.
    if (!holdsWorkerAttachment(job.status) || !leaseExpired(job)) continue;
    const retryCount = (job.retryCount ?? 0) + 1;
    const retryBudgetAvailable = retryCount <= (job.maxRetries ?? 2);
    const canAutoRetry = retryBudgetAvailable && staleLeaseCanAutoRetry(job);
    const integrityFailure = canAutoRetry
      ? duplicateIntegrityFailure(index, [job.taskId])
      : undefined;
    const admittedAutoRetry = canAutoRetry && !integrityFailure;
    const requiresManualRecovery = !admittedAutoRetry;
    const staleRecoveryReason = integrityFailure
      ? `Lease expired before worker activity was observed, but requeue was refused: ${integrityFailure.error}`
      : requiresManualRecovery
        ? retryBudgetAvailable
          ? "Lease expired after worker activity was observed; blocked for manual recovery to avoid duplicate execution."
          : "Lease expired after retry budget was exhausted; manual recovery is required."
        : "Lease expired before worker activity was observed; job requeued for scheduler retry.";
    const updated: FederatedJobRecord = {
      ...job,
      status: admittedAutoRetry ? "queued" : "blocked",
      hostId: admittedAutoRetry ? undefined : job.hostId,
      lease: undefined,
      staleAt: now,
      retryCount,
      retryable: integrityFailure?.retryable ?? admittedAutoRetry,
      blockReasonCode: admittedAutoRetry ? undefined : "pending_manual_handoff",
      error: admittedAutoRetry
        ? undefined
        : integrityFailure
          ? integrityFailure.error
          : retryBudgetAvailable
            ? "lease_expired_after_worker_activity"
            : "lease_expired_retry_budget_exhausted",
      nextAction: admittedAutoRetry
        ? "reschedule_after_stale_lease"
        : integrityFailure
          ? integrityFailure.nextAction
          : retryBudgetAvailable
            ? "investigate_stale_worker"
            : "manual_handoff",
      decision: {
        ...job.decision,
        staleRecoveryMode: admittedAutoRetry ? "auto_retry" : "manual_recovery",
        staleRecoveryReason,
        staleRecoveryRecoveredFromStatus: job.status,
      },
      updatedAt: now,
    };
    await saveFederatedJob(p.projectRoot, updated);
    recovered.push(updated);
  }
  return recovered;
}

export async function runSwarmSchedulerTick(
  p: FederationProjectContext,
  options: FederatedSchedulingOptions = {},
  deps: FederationSchedulingDeps,
): Promise<{
  recovered: FederatedJobRecord[];
  reconciled: FederatedJobRecord[];
  assigned: FederatedJobRecord[];
  blocked: FederatedJobRecord[];
  queuedRemaining: number;
  unavailable?: string;
}> {
  if (!p.projectRoot) {
    return { recovered: [], reconciled: [], assigned: [], blocked: [], queuedRemaining: 0 };
  }
  const claimantIndex = await buildFederationClaimantIndex(p, deps.scanTaskClaimants);
  const recovered = await recoverStaleFederatedLeases(p, claimantIndex);
  const reconciled =
    claimantIndex.status === "scanned" && deps.reconcileJobs
      ? await deps.reconcileJobs(p, claimantIndex)
      : [];
  const jobs = sortFederatedQueue(
    (await listFederatedJobs(p.projectRoot)).filter((job) => job.status === "queued"),
  );
  const assigned: FederatedJobRecord[] = [];
  const blocked: FederatedJobRecord[] = recovered.filter((job) => job.status === "blocked");

  for (const job of jobs) {
    const updated = await assignFederatedJob(
      p,
      job,
      deps,
      {
        ...options,
        leaseTtlMs: options.leaseTtlMs ?? job.leaseTtlMs,
      },
      claimantIndex,
    );
    if (updated.status === "assigned") assigned.push(updated);
    if (updated.status === "blocked") blocked.push(updated);
  }

  const queuedRemaining = (await listFederatedJobs(p.projectRoot)).filter(
    (job) => job.status === "queued",
  ).length;
  return {
    recovered,
    reconciled,
    assigned,
    blocked,
    queuedRemaining,
    ...(claimantIndex.status === "unavailable" ? { unavailable: claimantIndex.reason } : {}),
  };
}

export async function maybeRunSwarmSchedulerRefill(
  p: FederationProjectContext,
  options: FederatedSchedulingOptions = {},
  deps: FederationSchedulingDeps,
): Promise<Awaited<ReturnType<typeof runSwarmSchedulerTick>> | undefined> {
  if (!p.projectRoot) return undefined;
  if (!(await hasQueuedFederatedJobs(p.projectRoot))) return undefined;
  return runSwarmSchedulerTick(p, options, deps);
}
