// ─── Federation Event Helpers ──────────────────────────────────────
// Session-index upserts, session-start emission, task/host detail
// resolution, and the federated cancel cleanup. Anything that touches
// p.db / p.reader / p.taskService for a federation job lives here.

import type { EventWriter } from "../event-emitter.js";
import type { EventPayload } from "../event-types.js";
import type {
  FederatedHostEventDetails,
  FederatedJobRecord,
  FederatedTaskEventDetails,
  FederationProjectContext,
} from "./types.js";

interface TaskStatusRecoveryProject {
  db: {
    getStatus(taskId: string):
      | {
          status: string;
          previous_status: string | null;
        }
      | undefined;
    setStatus(taskId: string, status: string, updatedBy: string): void;
  };
}

export function upsertFederatedSessionIndex(
  p: FederationProjectContext,
  options: {
    sessionId: string;
    taskId: string;
    title?: string | null;
    status: "active" | "completed" | "error";
    outcome: string | null;
    timestamp?: string;
    totalCostUsd?: number | null;
    durationMs?: number | null;
    turnsUsed?: number | null;
  },
): void {
  const existing = p.db
    .getSessionsForTask(options.taskId)
    .find((row) => row.session_id === options.sessionId);
  p.db.upsertSession({
    session_id: options.sessionId,
    task_id: options.taskId,
    project: p.projectId,
    title: options.title ?? existing?.title ?? null,
    start_time: existing?.start_time ?? options.timestamp ?? new Date().toISOString(),
    status: options.status,
    outcome: options.outcome,
    total_cost_usd: options.totalCostUsd ?? null,
    duration_ms: options.durationMs ?? null,
    turns_used: options.turnsUsed ?? null,
  });
}

export async function resolveFederatedTaskEventDetails(
  p: FederationProjectContext,
  taskId: string,
): Promise<FederatedTaskEventDetails> {
  if (!p.taskService) return {};
  try {
    const task = await p.taskService.getTask(taskId);
    if (!task) return {};
    return {
      taskTitle: task.title,
      taskDescription: task.problemStatement || task.currentState || undefined,
    };
  } catch {
    return {};
  }
}

export function sessionTitleForFederatedTask(
  taskDetails: FederatedTaskEventDetails,
): string | undefined {
  return taskDetails.taskTitle;
}

/** General-purpose IN_PROGRESS → previous-status restoration. Lives here because
 *  restoreTaskStatusAfterFederatedCancel uses it; server.ts can also import it for
 *  monitor-orphan cleanup. */
export function restoreTaskStatusFromInProgress(
  p: TaskStatusRecoveryProject,
  taskId: string,
  updatedBy: string,
): void {
  const current = p.db.getStatus(taskId);
  if (current?.status !== "IN_PROGRESS") return;
  const restoredStatus =
    current.previous_status && current.previous_status !== "IN_PROGRESS"
      ? current.previous_status
      : "READY";
  p.db.setStatus(taskId, restoredStatus, updatedBy);
}

export function restoreTaskStatusAfterFederatedCancel(
  p: FederationProjectContext,
  taskId: string,
): void {
  restoreTaskStatusFromInProgress(p, taskId, "federated_job_canceled");
}

export function hasFederatedSessionStart(p: FederationProjectContext, sessionId: string): boolean {
  try {
    return p.reader.getSessionEvents(sessionId).some((event) => event.stage === "session_start");
  } catch {
    return false;
  }
}

export function emitFederatedSessionStart(
  p: FederationProjectContext,
  writer: EventWriter,
  record: FederatedJobRecord,
  remoteSessionId?: string,
  hostDetails: FederatedHostEventDetails = {},
  taskDetails: FederatedTaskEventDetails = {},
): void {
  if (hasFederatedSessionStart(p, writer.sessionId)) return;
  const taskTitle = sessionTitleForFederatedTask(taskDetails);
  upsertFederatedSessionIndex(p, {
    sessionId: writer.sessionId,
    taskId: record.taskId,
    title: taskTitle,
    status: "active",
    outcome: "federated_job_started",
  });
  writer.recordSession("active", {
    outcome: "federated_job_started",
    title: taskTitle,
  });
  writer.emit("session_start", {
    model: "remote-listener",
    maxTurns: 0,
    maxBudget: 0,
    taskId: record.taskId,
    taskTitle: taskDetails.taskTitle,
    taskDescription: taskDetails.taskDescription,
    jobId: record.jobId,
    hostId: record.hostId,
    hostAlias: hostDetails.hostAlias,
    hostEndpoint: hostDetails.hostEndpoint,
    remoteSessionId,
    federated: true,
    // TASK-1323: the durable session trail carries the job's entry
    // provenance (absent only on pre-1323 records).
    ...(record.provenance ? { provenance: record.provenance } : {}),
  } as EventPayload);
}
