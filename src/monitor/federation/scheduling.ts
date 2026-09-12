import { parsePrepGateResult } from "../prep-job-result.js";
import type { EventWriter } from "../event-emitter.js";
import { routeFederatedJob } from "../../federation/job-router.js";
import type { BlockReasonCode } from "../../workflow/workflow-state-types.js";
import { resolveFederatedTaskEventDetails, sessionTitleForFederatedTask } from "./events.js";
import { defaultFederatedHosts, federatedHostEventDetailsFromHost } from "./host.js";
import { federatedDependencyBlockers, federatedSessionId, sortFederatedQueue } from "./jobs.js";
import { createFederatedLease, federationNow, leaseExpired } from "./lease.js";
import { ReadinessService } from "../readiness-service.js";
import { federatedJobHoldsWorkerAttachment, holdsWorkerAttachment } from "./status.js";
import { releasedPauseNeedsRecovery } from "./pause-resume.js";
import {
  listFederatedJobs,
  updateFederatedJobWithPostPersistEffect,
  updateFederatedJob,
  updateFederatedJobExclusive,
} from "./store.js";
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
  canDispatch?: (project: FederationProjectContext) => boolean;
}

export interface FederatedDependencyReleaseOptions {
  /** Internal deterministic seam after stale discovery but before the fenced reread. */
  afterCandidateDiscoveredForTest?: (job: FederatedJobRecord) => void | Promise<void>;
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
  options: FederatedDependencyReleaseOptions = {},
): Promise<FederatedJobRecord[]> {
  if (!p.projectRoot) return [];

  const normalizedCompletedTaskId = normalizeClaimantTaskId(completedTaskId);

  const released: FederatedJobRecord[] = [];
  for (const job of await listFederatedJobs(p.projectRoot)) {
    if (
      !federatedDependencyBlockers(job)
        .map(normalizeClaimantTaskId)
        .includes(normalizedCompletedTaskId)
    ) {
      continue;
    }
    await options.afterCandidateDiscoveredForTest?.(job);

    let releasedByThisTransition = false;
    const result = await updateFederatedJobExclusive(p.projectRoot, job.jobId, async (current) => {
      // The directory listing is discovery only. Re-read and decide under the
      // per-job fence so a concurrent cancel/claim can never be overwritten by
      // a stale blocked snapshot.
      if (
        !isDependencyCompletionReleaseCandidate(current) ||
        (current.projectId !== undefined && current.projectId !== p.projectId)
      )
        return undefined;
      const blockers = federatedDependencyBlockers(current);
      if (!blockers.map(normalizeClaimantTaskId).includes(normalizedCompletedTaskId)) {
        return undefined;
      }

      const freshIndex = await buildFederationClaimantIndex(p);
      // A supplied unavailable scan remains a barrier, but a prior successful
      // scan never substitutes for current declarations inside this job fence.
      const index = claimantIndex?.status === "unavailable" ? claimantIndex : freshIndex;
      const dependencyFailure = duplicateIntegrityFailure(index, [normalizedCompletedTaskId]);
      const gate =
        dependencyFailure ?? (await evaluateFederatedSchedulingGate(p, current, {}, index));
      const now = federationNow();
      if (!gate.ok) {
        return {
          ...current,
          blockReasonCode: gate.blockReasonCode,
          error: gate.error,
          nextAction: gate.nextAction,
          retryable: gate.retryable,
          decision: {
            ...current.decision,
            dependencyBlockers: blockers,
          },
          updatedAt: now,
        };
      }

      releasedByThisTransition = true;
      return {
        ...current,
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
          ...current.decision,
          dependencyBlockers: undefined,
          reason: `Dependency ${completedTaskId} verified; job released for scheduling.`,
          unblockedBy: completedTaskId,
        },
      };
    });
    if (releasedByThisTransition && result.record) released.push(result.record);
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
    let prepContractValid = true;
    if (currentPrep) {
      try {
        parsePrepGateResult(currentPrep);
      } catch {
        prepContractValid = false;
      }
    }
    const prepPasses =
      prepContractValid &&
      currentPrep !== null &&
      state?.hasStalePrep !== true &&
      currentPrep.schemaValid &&
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
    if (!prepContractValid)
      return {
        ok: false,
        blockReasonCode: "pending_manual_handoff",
        error: "preflight_gate_invalid",
        nextAction: "reprep",
        retryable: true,
      };
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
    if (
      prep &&
      (!prep.schemaValid ||
        !prep.depthReady ||
        prep.depthScore < 4.7 ||
        prep.outcome === "rejected")
    ) {
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

function isUnstartedFederatedSchedulingBlock(job: FederatedJobRecord): boolean {
  if (
    job.status !== "blocked" ||
    job.hostId ||
    job.lease ||
    job.remoteSessionId ||
    job.assignedAt ||
    job.pendingGate ||
    job.pause ||
    job.completedAt ||
    job.canceledBy ||
    job.verificationWorkflowId ||
    job.mergeBinding ||
    (job.evidence?.length ?? 0) > 0
  )
    return false;
  return true;
}

/** Only machine-produced pre-start blockers can self-heal. */
export function isRecoverableFederatedSchedulingBlock(job: FederatedJobRecord): boolean {
  if (!isUnstartedFederatedSchedulingBlock(job)) return false;
  if (job.blockReasonCode === "pending_manual_handoff" && job.retryable === true) {
    return (
      (job.error === "preflight_gate_missing" && job.nextAction === "prep_or_preflight") ||
      (["preflight_gate_stale", "preflight_gate_invalid"].includes(job.error ?? "") &&
        job.nextAction === "reprep") ||
      (/^preflight_gate_failed:(?:[0-4]\.[0-9]|5\.0)$/.test(job.error ?? "") &&
        ["enrich_and_reprep", "decompose"].includes(job.nextAction ?? "")) ||
      ((job.error ?? "").startsWith("blocked_by_unresolved:") &&
        job.nextAction === "wait_for_dependencies")
    );
  }
  if (job.blockReasonCode === "host_unhealthy")
    return (
      job.error === "host_unhealthy" &&
      job.retryable === true &&
      job.nextAction === "wait_for_listener"
    );
  return (
    job.blockReasonCode === "pending_remote_listener" &&
    ((job.retryable === true &&
      job.nextAction === "wait_for_listener" &&
      ["preferred_host_unavailable", "host_unhealthy"].includes(job.error ?? "")) ||
      (job.error === "no_capable_listener" && job.decision.schedulerBlock === "listener"))
  );
}

/** Completion replay also owns legacy dependency records predating scheduler tuples.
 * This is deliberately narrower than allowing arbitrary blocked records at a tick.
 */
function isDependencyCompletionReleaseCandidate(job: FederatedJobRecord): boolean {
  if (!isUnstartedFederatedSchedulingBlock(job) || federatedDependencyBlockers(job).length === 0)
    return false;
  if (isRecoverableFederatedSchedulingBlock(job)) return true;
  // Older dependency writers emitted this machine-owned tuple without retryable.
  // Completion replay still rechecks current declarations and readiness under the
  // job fence; generic scheduler ticks must not infer retry permission from it.
  if (
    job.blockReasonCode === "pending_manual_handoff" &&
    job.retryable === undefined &&
    job.nextAction === "wait_for_dependencies" &&
    (job.error ?? "").startsWith("blocked_by_unresolved:")
  )
    return true;
  // A prior strict claimant refusal retains dependency identity. The same
  // completion effect may retry it after the current declarations are repaired.
  if (
    job.blockReasonCode === "pending_manual_handoff" &&
    job.nextAction === "resolve_duplicate_claimants" &&
    /^duplicate_claimants(?:_unavailable)?:/.test(job.error ?? "")
  )
    return true;
  return (
    job.blockReasonCode === undefined &&
    job.retryable !== false &&
    (job.error === undefined || job.error.startsWith("blocked_by_unresolved:")) &&
    (job.nextAction === undefined ||
      job.nextAction === "schedule" ||
      job.nextAction === "wait_for_dependencies")
  );
}

export async function recheckRecoverableFederatedBlocks(
  p: FederationProjectContext,
  options: {
    taskId?: string;
    scanTaskClaimants?: DuplicateClaimantScanProducer;
    afterCandidateDiscoveredForTest?: (job: FederatedJobRecord) => Promise<void>;
  } = {},
): Promise<FederatedJobRecord[]> {
  if (!p.projectRoot) return [];
  const changed: FederatedJobRecord[] = [];
  for (const discovered of await listFederatedJobs(p.projectRoot)) {
    if (
      !isRecoverableFederatedSchedulingBlock(discovered) ||
      (options.taskId &&
        normalizeClaimantTaskId(discovered.taskId) !== normalizeClaimantTaskId(options.taskId))
    )
      continue;
    await options.afterCandidateDiscoveredForTest?.(discovered);
    const result = await updateFederatedJobExclusive(
      p.projectRoot,
      discovered.jobId,
      async (current) => {
        if (
          !isRecoverableFederatedSchedulingBlock(current) ||
          (current.projectId !== undefined && current.projectId !== p.projectId)
        )
          return undefined;
        const index = await buildFederationClaimantIndex(p, options.scanTaskClaimants);
        // Automatic recovery has no operator bypass flags: current identity,
        // dependencies, source hash and full readiness must all pass again.
        const gate = await evaluateFederatedSchedulingGate(p, current, {}, index);
        if (!gate.ok) {
          if (
            current.error === gate.error &&
            current.blockReasonCode === gate.blockReasonCode &&
            current.nextAction === gate.nextAction &&
            current.retryable === gate.retryable
          )
            return undefined;
          return {
            ...current,
            error: gate.error,
            blockReasonCode: gate.blockReasonCode,
            nextAction: gate.nextAction,
            retryable: gate.retryable,
            updatedAt: federationNow(),
          };
        }
        const route = routeFederatedJob({
          taskId: current.taskId,
          jobType: current.jobType,
          requiredCapabilities: current.requiredCapabilities,
          preferredHostId: current.preferredHostId,
          hosts: await defaultFederatedHosts(p.projectRoot!),
        });
        if (!route.ok && route.error !== "host_at_capacity") {
          const nextAction = route.retryable ? "wait_for_listener" : "manual_handoff";
          if (
            current.error === route.error &&
            current.blockReasonCode === route.blockReasonCode &&
            current.nextAction === nextAction
          )
            return undefined;
          return {
            ...current,
            error: route.error,
            blockReasonCode: route.blockReasonCode,
            retryable: route.retryable,
            nextAction,
            decision: { ...route.fallback, schedulerBlock: "listener" },
            updatedAt: federationNow(),
          };
        }
        const now = federationNow();
        return {
          ...current,
          status: "queued",
          error: undefined,
          blockReasonCode: undefined,
          retryable: undefined,
          hostId: undefined,
          lease: undefined,
          queuedAt: now,
          updatedAt: now,
          nextAction: "schedule_after_prerequisites_ready",
          decision: {
            ...current.decision,
            dependencyBlockers: undefined,
            reason: "Current task identity, readiness and prerequisites passed automatic recheck.",
          },
        };
      },
    );
    if (result.changed && result.record) changed.push(result.record);
  }
  return changed;
}

export async function assignFederatedJob(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  deps: FederationSchedulingDeps,
  options: FederatedSchedulingOptions = {},
  claimantIndex?: DuplicateClaimantIndex,
): Promise<FederatedJobRecord> {
  if (!p.projectRoot) return record;
  const result = await updateFederatedJobWithPostPersistEffect(
    p.projectRoot,
    record.jobId,
    async (current) => {
      if (
        current.status !== "queued" ||
        (current.projectId !== undefined && current.projectId !== p.projectId) ||
        deps.canDispatch?.(p) === false
      )
        return undefined;
      // Ordinary queued assignments share the strict tick inventory. Newly
      // recovered blockers are separately rescanned inside their own job fence.
      const index =
        claimantIndex ?? (await buildFederationClaimantIndex(p, deps.scanTaskClaimants));
      return prepareFederatedAssignment(p, current, deps, options, index);
    },
  );
  if (!result.record) throw new Error("Federated job disappeared before assignment");
  return result.record;
}

async function prepareFederatedAssignment(
  p: FederationProjectContext,
  record: FederatedJobRecord,
  deps: FederationSchedulingDeps,
  options: FederatedSchedulingOptions = {},
  claimantIndex?: DuplicateClaimantIndex,
): Promise<{ record: FederatedJobRecord; effect: () => Promise<void> } | undefined> {
  if (!p.projectRoot) return undefined;

  const gate = await evaluateFederatedSchedulingGate(p, record, options, claimantIndex);
  if (!gate.ok) {
    const blocked: FederatedJobRecord = {
      ...record,
      status: "blocked",
      retryable: gate.retryable,
      blockReasonCode: gate.blockReasonCode,
      error: gate.error,
      nextAction: gate.nextAction,
      decision: { ...record.decision, schedulerBlock: "readiness" },
      updatedAt: federationNow(),
    };
    return { record: blocked, effect: () => Promise.resolve() };
  }

  const routedHosts = await defaultFederatedHosts(p.projectRoot);
  const route = routeFederatedJob({
    taskId: record.taskId,
    jobType: record.jobType,
    requiredCapabilities: record.requiredCapabilities,
    preferredHostId: options.preferredHostId ?? record.preferredHostId,
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
      return { record: waiting, effect: () => Promise.resolve() };
    }
    const blocked: FederatedJobRecord = {
      ...record,
      status: "blocked",
      retryable: route.retryable,
      blockReasonCode: route.blockReasonCode,
      error: route.error,
      decision: { ...route.fallback, schedulerBlock: "listener" },
      nextAction: route.retryable ? "wait_for_listener" : "manual_handoff",
      updatedAt: now,
    };
    return { record: blocked, effect: () => Promise.resolve() };
  }

  if (deps.canDispatch?.(p) === false) return undefined;
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
  return {
    record: assigned,
    effect: async () => {
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
    },
  };
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
  const nowMs = Date.parse(now);
  const recovered: FederatedJobRecord[] = [];
  for (const snapshot of await listFederatedJobs(p.projectRoot)) {
    // The listing is only a candidate set.  Re-read and re-check under the
    // per-job lock so an ack/start/renewal that wins the race cannot be
    // overwritten by this older snapshot.
    const result = await updateFederatedJob(p.projectRoot, snapshot.jobId, (job) => {
      if (releasedPauseNeedsRecovery(job, nowMs)) {
        return {
          ...job,
          status: "blocked",
          lease: undefined,
          staleAt: now,
          retryable: false,
          blockReasonCode: "pending_manual_handoff",
          error: "released_pause_original_host_unavailable",
          nextAction: "recover_paused_worktree_on_original_host",
          pause: job.pause
            ? {
                ...job.pause,
                state: "manual_recovery",
                recoveryReason:
                  "Released pause or resume claim expired; worktree transfer requires explicit operator recovery.",
              }
            : undefined,
          decision: {
            ...job.decision,
            staleRecoveryMode: "manual_recovery",
            staleRecoveryReason:
              "Released pause expired without a completed resume handshake; automatic reassignment is unsafe.",
            staleRecoveryRecoveredFromStatus: job.status,
          },
          updatedAt: now,
        };
      }
      // Attached/claimed pauses stay in ordinary stale-lease recovery.
      if (!federatedJobHoldsWorkerAttachment(job) || !leaseExpired(job, nowMs)) return undefined;
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
      return {
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
    });
    if (result.changed && result.record) recovered.push(result.record);
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
  await recheckRecoverableFederatedBlocks(p, { scanTaskClaimants: deps.scanTaskClaimants });
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
  if (
    !(await listFederatedJobs(p.projectRoot)).some(
      (job) => job.status === "queued" || isRecoverableFederatedSchedulingBlock(job),
    )
  )
    return undefined;
  return runSwarmSchedulerTick(p, options, deps);
}
