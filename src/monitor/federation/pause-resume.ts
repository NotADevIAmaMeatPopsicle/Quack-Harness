import { randomUUID } from "node:crypto";

import { createFederatedLease, federationNow } from "./lease.js";
import { updateFederatedJob } from "./store.js";
import type {
  FederatedJobRecord,
  FederatedPauseState,
  FederatedPendingGate,
  FederatedResumeStartGrant,
} from "./types.js";

export const DEFAULT_RELEASED_PAUSE_SWEEP_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RESUME_CLAIM_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_RESUME_START_GRANT_TTL_MS = 5 * 60 * 1000;

export class FederatedPauseTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FederatedPauseTransitionError";
  }
}

export function isLaterFederatedPauseOccurrence(
  pause: FederatedPauseState,
  gate: FederatedPendingGate,
): boolean {
  const resumedAtMs = Date.parse(pause.resumedAt ?? "");
  const openedAtMs = Date.parse(gate.since ?? "");
  return Number.isFinite(resumedAtMs) && Number.isFinite(openedAtMs) && openedAtMs > resumedAtMs;
}

export interface FederatedPauseIdentity {
  projectId?: string;
  jobId: string;
  taskId: string;
  jobType: "dispatch";
  hostId: string;
  sessionId: string;
}

export function transitionFederatedPause(
  job: FederatedJobRecord,
  input: {
    identity: FederatedPauseIdentity;
    gate: FederatedPendingGate;
    now?: string;
  },
): FederatedJobRecord {
  assertPauseIdentity(job, input.identity);
  const reportedOpenedAtMs = Date.parse(input.gate.since ?? "");
  if (!Number.isFinite(reportedOpenedAtMs)) {
    throw new FederatedPauseTransitionError(
      "invalid_federated_pause_occurrence",
      `Pause report for ${job.jobId} requires a valid occurrence timestamp.`,
    );
  }
  if (!job.remoteSessionId || job.remoteSessionId !== input.identity.sessionId) {
    throw new FederatedPauseTransitionError(
      "federated_pause_session_mismatch",
      `Pause report session is not the current worker session for job ${job.jobId}.`,
    );
  }

  const existing = job.pause;
  if (existing) {
    const existingOpenedAtMs = Date.parse(existing.openedAt);
    const sameOccurrence =
      existing.sessionId === input.identity.sessionId &&
      existing.gate === input.gate.stage &&
      Number.isFinite(existingOpenedAtMs) &&
      existingOpenedAtMs === reportedOpenedAtMs;
    if (sameOccurrence) return job;

    const resumedAtMs = Date.parse(existing.resumedAt ?? "");
    const resumedSessionId = existing.startGrant?.resumedSessionId;
    const canAdvanceFromCurrentResume =
      Boolean(existing.startGrant?.consumedAt) &&
      Boolean(resumedSessionId) &&
      resumedSessionId === input.identity.sessionId &&
      Number.isFinite(resumedAtMs) &&
      reportedOpenedAtMs > resumedAtMs;
    if (!canAdvanceFromCurrentResume) {
      throw new FederatedPauseTransitionError(
        "stale_federated_pause_generation",
        `Pause report for ${job.jobId} does not identify a later occurrence from the current resumed session.`,
      );
    }
  }

  const now = input.now ?? federationNow();
  const pause: FederatedPauseState = {
    generation: (existing?.generation ?? 0) + 1,
    state: "attached",
    gate: input.gate.stage,
    sessionId: input.identity.sessionId,
    originalHostId: input.identity.hostId,
    releaseNonce: randomUUID(),
    openedAt: input.gate.since!,
    preparedAt: now,
  };
  return { ...job, pause, updatedAt: now };
}

function assertPauseIdentity(job: FederatedJobRecord, identity: FederatedPauseIdentity): void {
  if (
    job.jobId !== identity.jobId ||
    job.taskId !== identity.taskId ||
    job.jobType !== identity.jobType ||
    job.hostId !== identity.hostId ||
    (job.projectId && identity.projectId && job.projectId !== identity.projectId)
  ) {
    throw new FederatedPauseTransitionError(
      "federated_pause_identity_mismatch",
      `Recovered pause identity does not match federated job ${job.jobId}.`,
    );
  }
  if (job.status !== "awaiting_approval") {
    throw new FederatedPauseTransitionError(
      "federated_pause_not_awaiting_approval",
      `Federated job ${job.jobId} is ${job.status}, not awaiting_approval.`,
    );
  }
}

export async function prepareFederatedPause(
  projectRoot: string,
  input: {
    identity: FederatedPauseIdentity;
    gate: FederatedPendingGate;
    now?: string;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.identity.jobId, (job) => {
    try {
      return transitionFederatedPause(job, input);
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record) {
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.identity.jobId} not found.`,
    );
  }
  return result.record;
}

function assertGeneration(
  job: FederatedJobRecord,
  hostId: string,
  generation: number,
  releaseNonce: string,
): FederatedPauseState {
  const pause = job.pause;
  if (
    !pause ||
    job.hostId !== hostId ||
    pause.generation !== generation ||
    pause.releaseNonce !== releaseNonce ||
    pause.originalHostId !== hostId
  ) {
    throw new FederatedPauseTransitionError(
      "federated_pause_generation_mismatch",
      `Pause generation ${generation} is not current for job ${job.jobId}.`,
    );
  }
  return pause;
}

export async function releaseFederatedPause(
  projectRoot: string,
  input: {
    jobId: string;
    hostId: string;
    generation: number;
    releaseNonce: string;
    now?: string;
    sweepAfterMs?: number;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.jobId, (job) => {
    try {
      const pause = assertGeneration(job, input.hostId, input.generation, input.releaseNonce);
      if (job.status !== "awaiting_approval") {
        throw new FederatedPauseTransitionError(
          "federated_pause_not_awaiting_approval",
          `Federated job ${job.jobId} is ${job.status}, not awaiting_approval.`,
        );
      }
      if (pause.state === "released") return job;
      if (pause.state !== "attached") {
        throw new FederatedPauseTransitionError(
          "federated_pause_not_attached",
          `Pause generation ${pause.generation} is ${pause.state}, not attached.`,
        );
      }
      const now = input.now ?? federationNow();
      return {
        ...job,
        lease: undefined,
        nextAction: `decide_${pause.gate}_gate:${job.taskId}`,
        pause: {
          ...pause,
          state: "released",
          releasedAt: now,
          sweepAfter: new Date(
            Date.parse(now) + (input.sweepAfterMs ?? DEFAULT_RELEASED_PAUSE_SWEEP_MS),
          ).toISOString(),
        },
        updatedAt: now,
      };
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record)
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.jobId} not found.`,
    );
  return result.record;
}

export async function requestFederatedResume(
  projectRoot: string,
  input: {
    jobId: string;
    hostId: string;
    generation: number;
    releaseNonce: string;
    decision: { action: "approved" | "rejected"; reason?: string };
    now?: string;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.jobId, (job) => {
    try {
      const pause = assertGeneration(job, input.hostId, input.generation, input.releaseNonce);
      if (job.status !== "awaiting_approval") {
        throw new FederatedPauseTransitionError(
          "federated_pause_not_awaiting_approval",
          `Federated job ${job.jobId} is ${job.status}.`,
        );
      }
      if (
        pause.state === "resume_requested" &&
        pause.decision?.action === input.decision.action &&
        pause.decision?.reason === input.decision.reason
      )
        return job;
      if (pause.state !== "released") {
        throw new FederatedPauseTransitionError(
          "federated_pause_not_released",
          `Pause generation ${pause.generation} is ${pause.state}, not released.`,
        );
      }
      const now = input.now ?? federationNow();
      return {
        ...job,
        nextAction: `resume_${pause.gate}_decision:${job.taskId}`,
        pause: {
          ...pause,
          state: "resume_requested",
          decision: { ...input.decision, recordedAt: now },
          resumeRequestedAt: now,
        },
        updatedAt: now,
      };
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record)
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.jobId} not found.`,
    );
  return result.record;
}

export async function claimFederatedResume(
  projectRoot: string,
  input: {
    jobId: string;
    hostId: string;
    generation: number;
    releaseNonce: string;
    now?: string;
    claimTtlMs?: number;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.jobId, (job) => {
    try {
      const pause = assertGeneration(job, input.hostId, input.generation, input.releaseNonce);
      if (job.status !== "awaiting_approval" || pause.state !== "resume_requested") {
        throw new FederatedPauseTransitionError(
          "federated_resume_not_claimable",
          `Pause generation ${pause.generation} is ${pause.state}, not resume_requested.`,
        );
      }
      const now = input.now ?? federationNow();
      const claim = {
        token: randomUUID(),
        hostId: input.hostId,
        claimedAt: now,
        expiresAt: new Date(
          Date.parse(now) + (input.claimTtlMs ?? DEFAULT_RESUME_CLAIM_TTL_MS),
        ).toISOString(),
      };
      return {
        ...job,
        lease: createFederatedLease(job.jobId, input.hostId, now, job.leaseTtlMs),
        nextAction: `start_${pause.gate}_resume:${job.taskId}`,
        pause: { ...pause, state: "resume_claimed", claim, startGrant: undefined },
        updatedAt: now,
      };
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record)
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.jobId} not found.`,
    );
  return result.record;
}

export async function acknowledgeFederatedResumeStart(
  projectRoot: string,
  input: {
    projectId: string;
    jobId: string;
    taskId: string;
    jobType: "dispatch";
    hostId: string;
    originalSessionId: string;
    generation: number;
    releaseNonce: string;
    claimToken: string;
    leaseId: string;
    now?: string;
    startGrantTtlMs?: number;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.jobId, (job) => {
    try {
      const pause = job.pause;
      const now = input.now ?? federationNow();
      const nowMs = Date.parse(now);
      const claimExpiresAt = Date.parse(pause?.claim?.expiresAt ?? "");
      const leaseExpiresAt = Date.parse(job.lease?.expiresAt ?? "");
      if (
        !Number.isFinite(nowMs) ||
        job.projectId !== input.projectId ||
        job.jobId !== input.jobId ||
        job.taskId !== input.taskId ||
        job.jobType !== input.jobType ||
        job.status !== "awaiting_approval" ||
        job.hostId !== input.hostId ||
        !pause ||
        pause.generation !== input.generation ||
        pause.originalHostId !== input.hostId ||
        pause.sessionId !== input.originalSessionId ||
        pause.releaseNonce !== input.releaseNonce ||
        pause.claim?.token !== input.claimToken ||
        pause.claim.hostId !== input.hostId ||
        !Number.isFinite(claimExpiresAt) ||
        claimExpiresAt <= nowMs ||
        job.lease?.leaseId !== input.leaseId ||
        job.lease.hostId !== input.hostId ||
        !Number.isFinite(leaseExpiresAt) ||
        leaseExpiresAt <= nowMs ||
        !["resume_claimed", "approved_but_not_started"].includes(pause.state)
      ) {
        throw new FederatedPauseTransitionError(
          "federated_resume_claim_mismatch",
          `Resume claim is not current for job ${job.jobId}.`,
        );
      }
      if (pause.startGrant) {
        if (
          pause.startGrant.projectId !== input.projectId ||
          pause.startGrant.jobId !== input.jobId ||
          pause.startGrant.taskId !== input.taskId ||
          pause.startGrant.jobType !== input.jobType ||
          pause.startGrant.hostId !== input.hostId ||
          pause.startGrant.originalSessionId !== input.originalSessionId ||
          pause.startGrant.generation !== input.generation ||
          pause.startGrant.releaseNonce !== input.releaseNonce ||
          pause.startGrant.claimToken !== input.claimToken ||
          pause.startGrant.leaseId !== input.leaseId ||
          pause.startGrant.consumedAt ||
          Date.parse(pause.startGrant.expiresAt) <= nowMs
        ) {
          throw new FederatedPauseTransitionError(
            "federated_resume_grant_mismatch",
            `A different or expired start grant is already recorded for job ${job.jobId}.`,
          );
        }
        return job;
      }
      const ttlMs = Math.max(1, input.startGrantTtlMs ?? DEFAULT_RESUME_START_GRANT_TTL_MS);
      const expiresAtMs = Math.min(claimExpiresAt, leaseExpiresAt, nowMs + ttlMs);
      if (expiresAtMs <= nowMs) {
        throw new FederatedPauseTransitionError(
          "federated_resume_grant_expired",
          `Resume claim or lease expired before a start grant could be issued for ${job.jobId}.`,
        );
      }
      const startGrant: FederatedResumeStartGrant = {
        token: randomUUID(),
        projectId: input.projectId,
        jobId: input.jobId,
        taskId: input.taskId,
        jobType: input.jobType,
        hostId: input.hostId,
        originalSessionId: input.originalSessionId,
        generation: input.generation,
        releaseNonce: input.releaseNonce,
        claimToken: input.claimToken,
        leaseId: input.leaseId,
        issuedAt: now,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      return {
        ...job,
        nextAction: `observe_${pause.gate}_resume_start:${job.taskId}`,
        pause: {
          ...pause,
          state: "approved_but_not_started",
          approvedButNotStartedAt: now,
          startGrant,
        },
        updatedAt: now,
      };
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record)
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.jobId} not found.`,
    );
  return result.record;
}

function exactStartGrantMatches(
  stored: FederatedResumeStartGrant,
  supplied: FederatedResumeStartGrant,
): boolean {
  return (
    stored.token === supplied.token &&
    stored.projectId === supplied.projectId &&
    stored.jobId === supplied.jobId &&
    stored.taskId === supplied.taskId &&
    stored.jobType === supplied.jobType &&
    stored.hostId === supplied.hostId &&
    stored.originalSessionId === supplied.originalSessionId &&
    stored.generation === supplied.generation &&
    stored.releaseNonce === supplied.releaseNonce &&
    stored.claimToken === supplied.claimToken &&
    stored.leaseId === supplied.leaseId &&
    stored.issuedAt === supplied.issuedAt &&
    stored.expiresAt === supplied.expiresAt &&
    supplied.consumedAt === undefined &&
    supplied.resumedSessionId === undefined
  );
}

function startGrantStaticIdentityMatches(
  job: FederatedJobRecord,
  supplied: FederatedResumeStartGrant,
): boolean {
  const pause = job.pause;
  const storedGrant = pause?.startGrant;
  return Boolean(
    pause &&
    storedGrant &&
    exactStartGrantMatches(storedGrant, supplied) &&
    job.projectId === supplied.projectId &&
    job.jobId === supplied.jobId &&
    job.taskId === supplied.taskId &&
    job.jobType === supplied.jobType &&
    job.hostId === supplied.hostId &&
    pause.originalHostId === supplied.hostId &&
    pause.sessionId === supplied.originalSessionId &&
    pause.generation === supplied.generation &&
    pause.releaseNonce === supplied.releaseNonce &&
    pause.claim?.token === supplied.claimToken &&
    pause.claim.hostId === supplied.hostId,
  );
}

function startGrantIdentityMatches(
  job: FederatedJobRecord,
  supplied: FederatedResumeStartGrant,
): boolean {
  return Boolean(
    startGrantStaticIdentityMatches(job, supplied) &&
    job.lease?.leaseId === supplied.leaseId &&
    job.lease.hostId === supplied.hostId,
  );
}

/**
 * Apply the only transition that may revive a released pause.  Callers run
 * this pure transformer from inside updateFederatedJob so validation and
 * consumption share the same per-job lock as scheduler recovery and renewal.
 */
export function transitionFederatedResumeRunning(
  job: FederatedJobRecord,
  input: {
    startGrant: FederatedResumeStartGrant;
    resumedSessionId: string;
    /** Durable local reservation time, used to reconcile a delayed first observation. */
    resumeStartedAt?: string;
    now?: string;
  },
): FederatedJobRecord {
  const pause = job.pause;
  const storedGrant = pause?.startGrant;
  const now = input.now ?? federationNow();
  const nowMs = Date.parse(now);
  const claimExpiresAt = Date.parse(pause?.claim?.expiresAt ?? "");
  const leaseExpiresAt = Date.parse(job.lease?.expiresAt ?? "");
  const grantIssuedAt = Date.parse(storedGrant?.issuedAt ?? "");
  const grantExpiresAt = Date.parse(storedGrant?.expiresAt ?? "");
  const supplied = input.startGrant;
  const staticIdentityMatches = startGrantStaticIdentityMatches(job, supplied);
  if (!staticIdentityMatches || !input.resumedSessionId.trim()) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_mismatch",
      `Resume start grant is not current for job ${job.jobId}.`,
    );
  }

  if (storedGrant?.consumedAt) {
    if (!startGrantIdentityMatches(job, supplied)) {
      throw new FederatedPauseTransitionError(
        "federated_resume_grant_mismatch",
        `Resume start grant lease is not current for job ${job.jobId}.`,
      );
    }
    if (!Number.isFinite(nowMs) || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowMs) {
      throw new FederatedPauseTransitionError(
        "federated_resume_grant_expired",
        `Resume start lease is expired for job ${job.jobId}.`,
      );
    }
    if (
      storedGrant.resumedSessionId === input.resumedSessionId &&
      job.remoteSessionId === input.resumedSessionId &&
      ["running", "verifying", "fixing"].includes(job.status)
    ) {
      return job;
    }
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_replayed",
      `Resume start grant was already consumed for job ${job.jobId}.`,
    );
  }
  if (!startGrantIdentityMatches(job, supplied)) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_mismatch",
      `Resume start grant lease is not current for job ${job.jobId}.`,
    );
  }
  const resumeStartedAt = input.resumeStartedAt ? Date.parse(input.resumeStartedAt) : Number.NaN;
  if (input.resumeStartedAt) {
    const durableReservationIsValid =
      Number.isFinite(resumeStartedAt) &&
      Number.isFinite(grantIssuedAt) &&
      Number.isFinite(grantExpiresAt) &&
      Number.isFinite(claimExpiresAt) &&
      Number.isFinite(nowMs) &&
      resumeStartedAt >= grantIssuedAt &&
      resumeStartedAt <= grantExpiresAt &&
      resumeStartedAt <= claimExpiresAt &&
      resumeStartedAt <= nowMs;
    if (!durableReservationIsValid) {
      throw new FederatedPauseTransitionError(
        "federated_resume_reservation_mismatch",
        `Reported resume reservation is outside the grant window for job ${job.jobId}.`,
      );
    }
  }
  // The exact lease epoch must still be live at the headnode. A durable local
  // reservation made inside the grant window may reconcile a delayed first
  // observation after the grant/claim clocks pass, but a dead/reassigned lease
  // can never do so.
  if (!Number.isFinite(nowMs) || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= nowMs) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_expired",
      `Resume start grant is expired for job ${job.jobId}.`,
    );
  }
  const freshAtObservation =
    Number.isFinite(claimExpiresAt) &&
    claimExpiresAt > nowMs &&
    Number.isFinite(grantExpiresAt) &&
    grantExpiresAt > nowMs;
  if (!freshAtObservation && !input.resumeStartedAt) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_expired",
      `Resume start grant is expired for job ${job.jobId}.`,
    );
  }
  if (job.status !== "awaiting_approval" || pause?.state !== "approved_but_not_started") {
    throw new FederatedPauseTransitionError(
      "federated_resume_not_startable",
      `Job ${job.jobId} is not awaiting an acknowledged resume start.`,
    );
  }

  return {
    ...job,
    status: "running",
    pendingGate: undefined,
    remoteSessionId: input.resumedSessionId,
    nextAction: `run_${job.jobType}`,
    pause: {
      ...pause,
      resumedAt: now,
      startGrant: {
        ...storedGrant!,
        consumedAt: input.resumeStartedAt ?? now,
        resumedSessionId: input.resumedSessionId,
      },
    },
    updatedAt: now,
  };
}

/**
 * A terminal resume delivery may be acknowledged only as an immutable receipt.
 * It never renews a lease, changes status, or appends evidence after closeout.
 */
export function exactFederatedResumeTerminalReceiptMatches(
  job: FederatedJobRecord,
  input: {
    startGrant: FederatedResumeStartGrant;
    resumedSessionId?: string;
  },
): boolean {
  const pause = job.pause;
  const storedGrant = pause?.startGrant;
  if (
    !terminalFederatedResumeStatus(job.status) ||
    !storedGrant?.consumedAt ||
    !startGrantStaticIdentityMatches(job, input.startGrant)
  ) {
    return false;
  }
  if (storedGrant.resumedSessionId) {
    return (
      input.resumedSessionId === storedGrant.resumedSessionId &&
      job.remoteSessionId === storedGrant.resumedSessionId
    );
  }
  return (
    job.status === "rejected" &&
    pause?.gate === "blueprint" &&
    pause.decision?.action === "rejected" &&
    !input.resumedSessionId
  );
}

function terminalFederatedResumeStatus(status: FederatedJobRecord["status"]): boolean {
  return ["completed", "failed", "rejected", "blocked", "canceled"].includes(status);
}

/** Consume a rejected blueprint grant without inventing an implementation child. */
export function transitionFederatedResumeTerminal(
  job: FederatedJobRecord,
  input: {
    startGrant: FederatedResumeStartGrant;
    /** Durable local reservation time for a rejected blueprint with no child. */
    resumeStartedAt?: string;
    now?: string;
  },
): FederatedJobRecord {
  const pause = job.pause;
  const storedGrant = pause?.startGrant;
  const supplied = input.startGrant;
  const now = input.now ?? federationNow();
  const nowMs = Date.parse(now);
  const claimExpiresAt = Date.parse(pause?.claim?.expiresAt ?? "");
  const leaseExpiresAt = Date.parse(job.lease?.expiresAt ?? "");
  const grantIssuedAt = Date.parse(storedGrant?.issuedAt ?? "");
  const grantExpiresAt = Date.parse(storedGrant?.expiresAt ?? "");
  if (!startGrantStaticIdentityMatches(job, supplied)) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_mismatch",
      `Resume terminal grant is not current for job ${job.jobId}.`,
    );
  }
  if (storedGrant?.consumedAt) {
    if (
      pause?.state === "approved_but_not_started" &&
      !storedGrant.resumedSessionId &&
      job.status === "rejected"
    ) {
      return job;
    }
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_replayed",
      `Resume terminal grant was already consumed for job ${job.jobId}.`,
    );
  }
  if (!startGrantIdentityMatches(job, supplied)) {
    throw new FederatedPauseTransitionError(
      "federated_resume_grant_mismatch",
      `Resume terminal grant lease is not current for job ${job.jobId}.`,
    );
  }
  const resumeStartedAt = input.resumeStartedAt ? Date.parse(input.resumeStartedAt) : Number.NaN;
  if (input.resumeStartedAt) {
    const durableReservationIsValid =
      Number.isFinite(resumeStartedAt) &&
      Number.isFinite(grantIssuedAt) &&
      Number.isFinite(grantExpiresAt) &&
      Number.isFinite(claimExpiresAt) &&
      Number.isFinite(nowMs) &&
      resumeStartedAt >= grantIssuedAt &&
      resumeStartedAt <= grantExpiresAt &&
      resumeStartedAt <= claimExpiresAt &&
      resumeStartedAt <= nowMs;
    if (!durableReservationIsValid) {
      throw new FederatedPauseTransitionError(
        "federated_resume_reservation_mismatch",
        `Reported resume reservation is outside the grant window for job ${job.jobId}.`,
      );
    }
  }
  const freshAtObservation =
    Number.isFinite(claimExpiresAt) &&
    claimExpiresAt > nowMs &&
    Number.isFinite(grantExpiresAt) &&
    grantExpiresAt > nowMs;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= nowMs ||
    (!freshAtObservation && !input.resumeStartedAt) ||
    job.status !== "awaiting_approval" ||
    pause?.state !== "approved_but_not_started" ||
    pause.gate !== "blueprint" ||
    pause.decision?.action !== "rejected"
  ) {
    throw new FederatedPauseTransitionError(
      "federated_resume_terminal_not_startable",
      `Job ${job.jobId} is not eligible for a grant-bound terminal resume.`,
    );
  }
  return {
    ...job,
    status: "rejected",
    pendingGate: undefined,
    lease: undefined,
    nextAction: "manual_handoff",
    pause: {
      ...pause,
      resumedAt: now,
      startGrant: { ...storedGrant!, consumedAt: input.resumeStartedAt ?? now },
    },
    updatedAt: now,
  };
}

export async function markFederatedPauseManualRecovery(
  projectRoot: string,
  input: {
    jobId: string;
    hostId: string;
    generation: number;
    releaseNonce: string;
    reason: string;
    now?: string;
  },
): Promise<FederatedJobRecord> {
  let failure: FederatedPauseTransitionError | undefined;
  const result = await updateFederatedJob(projectRoot, input.jobId, (job) => {
    try {
      const pause = assertGeneration(job, input.hostId, input.generation, input.releaseNonce);
      if (job.status !== "awaiting_approval" || pause.state !== "resume_requested") {
        throw new FederatedPauseTransitionError(
          "federated_resume_not_recoverable",
          `Pause generation ${pause.generation} is ${job.status}/${pause.state}, not awaiting_approval/resume_requested.`,
        );
      }
      const now = input.now ?? federationNow();
      return {
        ...job,
        status: "blocked",
        lease: undefined,
        retryable: false,
        blockReasonCode: "pending_manual_handoff",
        error: input.reason,
        nextAction: "recover_paused_worktree_on_original_host",
        pause: { ...pause, state: "manual_recovery", recoveryReason: input.reason },
        updatedAt: now,
      };
    } catch (error: unknown) {
      failure = error as FederatedPauseTransitionError;
      return undefined;
    }
  });
  if (failure) throw failure;
  if (!result.record)
    throw new FederatedPauseTransitionError(
      "federated_job_not_found",
      `Federated job ${input.jobId} not found.`,
    );
  return result.record;
}

export function releasedPauseNeedsRecovery(job: FederatedJobRecord, nowMs = Date.now()): boolean {
  if (job.status !== "awaiting_approval" || !job.pause) return false;
  if (
    !["released", "resume_requested", "resume_claimed", "approved_but_not_started"].includes(
      job.pause.state,
    )
  )
    return false;
  const expiresAt =
    job.pause.startGrant?.expiresAt ?? job.pause.claim?.expiresAt ?? job.pause.sweepAfter;
  if (!expiresAt || Date.parse(expiresAt) > nowMs) return false;
  if (job.pause.state !== "approved_but_not_started" || !job.pause.startGrant) return true;

  const grant = job.pause.startGrant;
  const lease = job.lease;
  const exactLeaseIsLive = Boolean(
    lease &&
    lease.leaseId === grant.leaseId &&
    lease.hostId === grant.hostId &&
    job.hostId === grant.hostId &&
    job.projectId === grant.projectId &&
    job.jobId === grant.jobId &&
    job.taskId === grant.taskId &&
    job.jobType === grant.jobType &&
    job.pause.originalHostId === grant.hostId &&
    job.pause.sessionId === grant.originalSessionId &&
    job.pause.generation === grant.generation &&
    job.pause.releaseNonce === grant.releaseNonce &&
    job.pause.claim?.token === grant.claimToken &&
    Number.isFinite(Date.parse(lease.expiresAt)) &&
    Date.parse(lease.expiresAt) > nowMs,
  );
  // A live exact lease means the listener is still supervising the local
  // reservation/child. Defer manual recovery until that epoch stops renewing.
  return !exactLeaseIsLive;
}
