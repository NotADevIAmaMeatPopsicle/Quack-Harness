import * as fs from "node:fs";
import * as path from "node:path";

import type { QuackEvent } from "../monitor/event-types.js";
import type { FederatedResumeStartGrant } from "../monitor/federation/types.js";

export interface RecoveredFederatedRunIdentity {
  jobId: string;
  taskId: string;
  jobType: "dispatch";
  hostId: string;
  sessionId: string;
  source: "checkpoint_session_start";
}

export type LocalFederatedResumeStatus =
  | "armed"
  | "decision_recorded"
  | "approved_but_not_started"
  | "started"
  | "terminal";

export class FederatedResumeStartRefusalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FederatedResumeStartRefusalError";
  }
}

export interface LocalFederatedResumeState {
  projectId: string;
  taskId: string;
  jobType: "dispatch";
  gate: "blueprint" | "judge";
  jobId: string;
  hostId: string;
  sessionId: string;
  generation: number;
  releaseNonce: string;
  /** Exact approval-file occurrence (`pendingGate.since` / pause `openedAt`). */
  pauseOpenedAt: string;
  status: LocalFederatedResumeStatus;
  armedAt: string;
  decision?: { action: "approved" | "rejected"; reason?: string; recordedAt: string };
  claimToken?: string;
  leaseId?: string;
  startGrant?: FederatedResumeStartGrant;
  startGrantConsumedAt?: string;
  updatedAt: string;
  resumedSessionId?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function recoverFederatedRunIdentity(
  logDir: string,
  taskId: string,
): RecoveredFederatedRunIdentity | null {
  try {
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(logDir, `checkpoint-${taskId}.json`), "utf-8"),
    ) as { taskId?: string; sessionId?: string };
    const sessionId = stringValue(checkpoint.sessionId);
    if (checkpoint.taskId !== taskId || !sessionId) return null;
    const lines = fs
      .readFileSync(path.join(logDir, `events-${sessionId}.jsonl`), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of lines) {
      let event: QuackEvent;
      try {
        event = JSON.parse(line) as QuackEvent;
      } catch {
        continue;
      }
      if (
        event.stage !== "session_start" ||
        event.taskId !== taskId ||
        event.sessionId !== sessionId
      )
        continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const jobId = stringValue(payload.jobId) ?? stringValue(payload.federatedJobId);
      const hostId = stringValue(payload.hostId) ?? stringValue(payload.federatedHostId);
      if (!jobId || !hostId) return null;
      return {
        jobId,
        taskId,
        jobType: "dispatch",
        hostId,
        sessionId,
        source: "checkpoint_session_start",
      };
    }
  } catch {
    // Missing or unreadable artifacts are UNKNOWN, never evidence for release.
  }
  return null;
}

function resumeDir(logDir: string): string {
  return path.join(logDir, "federated-resume");
}

function resumePath(logDir: string, taskId: string): string {
  return path.join(resumeDir(logDir), `${taskId}.json`);
}

function writeState(logDir: string, state: LocalFederatedResumeState): void {
  const dir = resumeDir(logDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = resumePath(logDir, state.taskId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(temporary, target);
}

export function readLocalFederatedResumeState(
  logDir: string,
  taskId: string,
): LocalFederatedResumeState | null {
  try {
    return JSON.parse(
      fs.readFileSync(resumePath(logDir, taskId), "utf-8"),
    ) as LocalFederatedResumeState;
  } catch {
    return null;
  }
}

export function armLocalFederatedResume(
  logDir: string,
  input: Omit<LocalFederatedResumeState, "status" | "armedAt" | "updatedAt">,
): LocalFederatedResumeState {
  if (
    !input.projectId.trim() ||
    input.jobType !== "dispatch" ||
    !Number.isInteger(input.generation) ||
    input.generation <= 0 ||
    !Number.isFinite(Date.parse(input.pauseOpenedAt))
  ) {
    throw new Error(`Invalid federated resume arm identity for ${input.taskId}.`);
  }
  const current = readLocalFederatedResumeState(logDir, input.taskId);
  if (
    current &&
    current.projectId === input.projectId &&
    current.taskId === input.taskId &&
    current.jobType === input.jobType &&
    current.gate === input.gate &&
    current.jobId === input.jobId &&
    current.hostId === input.hostId &&
    current.sessionId === input.sessionId &&
    current.generation === input.generation &&
    current.releaseNonce === input.releaseNonce &&
    current.pauseOpenedAt === input.pauseOpenedAt
  )
    return current;
  if (
    current &&
    current.status !== "terminal" &&
    (current.projectId !== input.projectId ||
      current.taskId !== input.taskId ||
      current.jobType !== input.jobType ||
      current.jobId !== input.jobId ||
      current.hostId !== input.hostId ||
      input.generation <= current.generation)
  ) {
    throw new Error(
      `A different live federated resume identity is already armed for ${input.taskId}.`,
    );
  }
  const now = new Date().toISOString();
  const state: LocalFederatedResumeState = {
    ...input,
    status: "armed",
    armedAt: now,
    updatedAt: now,
  };
  writeState(logDir, state);
  return state;
}

export function recordLocalFederatedResumeDecision(
  logDir: string,
  taskId: string,
  gate: "blueprint" | "judge",
  decision: { action: "approved" | "rejected"; reason?: string },
): LocalFederatedResumeState | null {
  const current = readLocalFederatedResumeState(logDir, taskId);
  const identity = recoverFederatedRunIdentity(logDir, taskId);
  if (
    !current ||
    current.gate !== gate ||
    !identity ||
    identity.jobId !== current.jobId ||
    identity.hostId !== current.hostId ||
    identity.sessionId !== current.sessionId ||
    current.status === "started" ||
    current.status === "terminal"
  )
    return null;
  const approvalName = gate === "judge" ? `${taskId}-judge.json` : `${taskId}.json`;
  let approval: { state?: string; createdAt?: string };
  try {
    approval = JSON.parse(
      fs.readFileSync(path.join(logDir, "approvals", approvalName), "utf-8"),
    ) as { state?: string; createdAt?: string };
  } catch {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_pause_occurrence_mismatch",
      `The ${gate} decision for ${taskId} has no readable approval occurrence.`,
    );
  }
  if (approval.createdAt !== current.pauseOpenedAt || approval.state !== decision.action) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_pause_occurrence_mismatch",
      `The ${gate} decision for ${taskId} does not belong to pause occurrence ${current.pauseOpenedAt}.`,
    );
  }
  if (current.decision) {
    if (
      current.decision.action !== decision.action ||
      current.decision.reason !== decision.reason
    ) {
      throw new Error(`A different federated resume decision is already recorded for ${taskId}.`);
    }
    return current;
  }
  const now = new Date().toISOString();
  const updated: LocalFederatedResumeState = {
    ...current,
    status: "decision_recorded",
    decision: { ...decision, recordedAt: now },
    updatedAt: now,
  };
  writeState(logDir, updated);
  return updated;
}

export function reconcileLocalFederatedResumeDecision(
  logDir: string,
  taskId: string,
): LocalFederatedResumeState | null {
  const current = readLocalFederatedResumeState(logDir, taskId);
  if (!current || current.decision || current.status !== "armed") return current;
  const approvalName = current.gate === "judge" ? `${taskId}-judge.json` : `${taskId}.json`;
  try {
    const approval = JSON.parse(
      fs.readFileSync(path.join(logDir, "approvals", approvalName), "utf-8"),
    ) as { state?: string; rejectionReason?: string; createdAt?: string };
    if (approval.state !== "approved" && approval.state !== "rejected") return current;
    if (approval.createdAt !== current.pauseOpenedAt) return current;
    return recordLocalFederatedResumeDecision(logDir, taskId, current.gate, {
      action: approval.state,
      ...(approval.rejectionReason ? { reason: approval.rejectionReason } : {}),
    });
  } catch {
    return current;
  }
}

export function advanceLocalFederatedResumeState(
  logDir: string,
  taskId: string,
  input: {
    startGrant: FederatedResumeStartGrant;
    status: "approved_but_not_started" | "started" | "terminal";
    resumedSessionId?: string;
    now?: string;
  },
): LocalFederatedResumeState {
  const reserved = reserveLocalFederatedResumeStart(logDir, taskId, input.startGrant, input.now);
  if (input.status === "approved_but_not_started") return reserved;
  return finalizeLocalFederatedResumeStart(
    logDir,
    taskId,
    input.startGrant,
    input.status,
    input.resumedSessionId,
    input.now,
  );
}

function exactGrantMatches(
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

function assertLocalFederatedResumeGrantIdentity(
  state: LocalFederatedResumeState | null,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
): asserts state is LocalFederatedResumeState {
  const issuedAtMs = Date.parse(startGrant.issuedAt);
  const expiresAtMs = Date.parse(startGrant.expiresAt);
  if (
    !state ||
    !state.decision ||
    state.projectId !== startGrant.projectId ||
    state.taskId !== taskId ||
    state.taskId !== startGrant.taskId ||
    state.jobType !== startGrant.jobType ||
    state.jobId !== startGrant.jobId ||
    state.hostId !== startGrant.hostId ||
    state.sessionId !== startGrant.originalSessionId ||
    state.generation !== startGrant.generation ||
    state.releaseNonce !== startGrant.releaseNonce ||
    !state.pauseOpenedAt ||
    !Number.isFinite(Date.parse(state.pauseOpenedAt)) ||
    startGrant.consumedAt !== undefined ||
    startGrant.resumedSessionId !== undefined ||
    !startGrant.token.trim() ||
    !startGrant.claimToken.trim() ||
    !startGrant.leaseId.trim() ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= issuedAtMs
  ) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_mismatch",
      `Federated resume start grant does not match ${taskId}.`,
    );
  }
}

/** Validate the immutable identity of the exact grant already installed locally. */
export function assertLocalFederatedResumeInstalledGrantIdentity(
  state: LocalFederatedResumeState | null,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
): asserts state is LocalFederatedResumeState {
  assertLocalFederatedResumeGrantIdentity(state, taskId, startGrant);
  if (!state.startGrant) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_not_installed",
      `Federated resume start grant is not installed for ${taskId}.`,
    );
  }
  if (
    !exactGrantMatches(state.startGrant, startGrant) ||
    state.claimToken !== startGrant.claimToken ||
    state.leaseId !== startGrant.leaseId
  ) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_mismatch",
      `Federated resume start grant does not match the installed grant for ${taskId}.`,
    );
  }
}

/** Validate every grant binding and freshness before a new reservation/start. */
export function assertLocalFederatedResumeStartGrant(
  state: LocalFederatedResumeState | null,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
  now = new Date().toISOString(),
): asserts state is LocalFederatedResumeState {
  assertLocalFederatedResumeGrantIdentity(state, taskId, startGrant);
  if (
    state.startGrant &&
    (!exactGrantMatches(state.startGrant, startGrant) ||
      state.claimToken !== startGrant.claimToken ||
      state.leaseId !== startGrant.leaseId)
  ) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_mismatch",
      `Federated resume start grant does not match the installed grant for ${taskId}.`,
    );
  }
  const nowMs = Date.parse(now);
  const issuedAtMs = Date.parse(startGrant.issuedAt);
  const expiresAtMs = Date.parse(startGrant.expiresAt);
  if (!Number.isFinite(nowMs) || issuedAtMs > nowMs) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_mismatch",
      `Federated resume start grant does not match ${taskId}.`,
    );
  }
  if (expiresAtMs <= nowMs) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_expired",
      `Federated resume start grant expired for ${taskId}.`,
    );
  }
}

/**
 * Persist the exact headnode-issued capability before the worker attempts a
 * local start.  This gives every daemon on the host one durable value to race
 * against instead of allowing the first `/start` caller to choose the grant.
 */
export function installLocalFederatedResumeStartGrant(
  logDir: string,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
  now = new Date().toISOString(),
): LocalFederatedResumeState {
  const current = reconcileLocalFederatedResumeDecision(logDir, taskId);
  assertLocalFederatedResumeGrantIdentity(current, taskId, startGrant);
  if (current.startGrant) {
    assertLocalFederatedResumeInstalledGrantIdentity(current, taskId, startGrant);
    return current;
  }
  assertLocalFederatedResumeStartGrant(current, taskId, startGrant, now);
  if (current.status === "started" || current.status === "terminal") {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_replayed",
      `Federated resume state is already closed for ${taskId}.`,
    );
  }
  const updated: LocalFederatedResumeState = {
    ...current,
    claimToken: startGrant.claimToken,
    leaseId: startGrant.leaseId,
    startGrant: { ...startGrant },
    updatedAt: now,
  };
  writeState(logDir, updated);
  return updated;
}

/**
 * Consume the local copy before starting the child.  A later launch failure is
 * deliberately fail-closed: the same capability cannot be replayed and the
 * headnode must recover the paused generation explicitly.
 */
export function reserveLocalFederatedResumeStart(
  logDir: string,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
  now = new Date().toISOString(),
): LocalFederatedResumeState {
  const current = reconcileLocalFederatedResumeDecision(logDir, taskId);
  assertLocalFederatedResumeStartGrant(current, taskId, startGrant, now);
  if (!current.startGrant) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_not_installed",
      `Federated resume start grant is not installed for ${taskId}.`,
    );
  }
  if (!exactGrantMatches(current.startGrant, startGrant)) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_mismatch",
      `A different federated resume start grant is recorded for ${taskId}.`,
    );
  }
  if (current.startGrantConsumedAt) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_replayed",
      `Federated resume start grant was already consumed for ${taskId}.`,
    );
  }
  const updated: LocalFederatedResumeState = {
    ...current,
    status: "approved_but_not_started",
    claimToken: startGrant.claimToken,
    leaseId: startGrant.leaseId,
    startGrant: { ...startGrant },
    startGrantConsumedAt: now,
    updatedAt: now,
  };
  writeState(logDir, updated);
  return updated;
}

export function finalizeLocalFederatedResumeStart(
  logDir: string,
  taskId: string,
  startGrant: FederatedResumeStartGrant,
  status: "started" | "terminal",
  resumedSessionId?: string,
  now = new Date().toISOString(),
): LocalFederatedResumeState {
  const current = readLocalFederatedResumeState(logDir, taskId);
  // Reservation already established temporal freshness. Finalization must keep
  // exact identity checks but may cross expiresAt after the child was launched.
  assertLocalFederatedResumeInstalledGrantIdentity(current, taskId, startGrant);
  if (
    !current.startGrant ||
    !exactGrantMatches(current.startGrant, startGrant) ||
    !current.startGrantConsumedAt ||
    current.status !== "approved_but_not_started"
  ) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_grant_not_reserved",
      `Federated resume start grant is not reserved for ${taskId}.`,
    );
  }
  if (status === "started" && !resumedSessionId?.trim()) {
    throw new FederatedResumeStartRefusalError(
      "federated_resume_session_missing",
      `Federated resume start for ${taskId} requires its exact child session.`,
    );
  }
  const updated: LocalFederatedResumeState = {
    ...current,
    status,
    resumedSessionId: resumedSessionId ?? current.resumedSessionId,
    updatedAt: now,
  };
  writeState(logDir, updated);
  return updated;
}

export function localFederatedResumeReplayMatches(
  state: LocalFederatedResumeState,
  startGrant: FederatedResumeStartGrant,
  active:
    | {
        taskId: string;
        sessionId: string;
        federatedJobId?: string;
        federatedHostId?: string;
        federatedLeaseId?: string;
      }
    | undefined,
): boolean {
  return Boolean(
    state.status === "started" &&
    state.startGrant &&
    exactGrantMatches(state.startGrant, startGrant) &&
    state.startGrantConsumedAt &&
    state.resumedSessionId &&
    active &&
    active.taskId === startGrant.taskId &&
    active.sessionId === state.resumedSessionId &&
    active.federatedJobId === startGrant.jobId &&
    active.federatedHostId === startGrant.hostId &&
    active.federatedLeaseId === startGrant.leaseId,
  );
}

/**
 * Prove that a child launched after reservation even when the final durable
 * `started` projection failed.  This is reconciliation only: it never admits
 * a second child and requires the active process to carry the exact epoch.
 */
export function localFederatedResumeReservationMatches(
  state: LocalFederatedResumeState,
  startGrant: FederatedResumeStartGrant,
  active:
    | {
        taskId: string;
        sessionId: string;
        federatedJobId?: string;
        federatedHostId?: string;
        federatedLeaseId?: string;
      }
    | undefined,
): boolean {
  return Boolean(
    state.status === "approved_but_not_started" &&
    state.startGrant &&
    exactGrantMatches(state.startGrant, startGrant) &&
    state.startGrantConsumedAt &&
    active &&
    active.taskId === startGrant.taskId &&
    active.federatedJobId === startGrant.jobId &&
    active.federatedHostId === startGrant.hostId &&
    active.federatedLeaseId === startGrant.leaseId,
  );
}

export function localFederatedResumeTerminalReplayMatches(
  state: LocalFederatedResumeState,
  startGrant: FederatedResumeStartGrant,
  active: { sessionId: string } | undefined,
): boolean {
  return Boolean(
    state.status === "terminal" &&
    state.gate === "blueprint" &&
    state.decision?.action === "rejected" &&
    state.startGrant &&
    exactGrantMatches(state.startGrant, startGrant) &&
    state.startGrantConsumedAt &&
    !state.resumedSessionId &&
    !active,
  );
}
