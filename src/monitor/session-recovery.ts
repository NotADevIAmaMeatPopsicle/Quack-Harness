import type { QuackDB } from "../db/index.js";
import type { SessionRow } from "../db/types.js";
import { restoreTaskStatusFromInProgress } from "./federation/events.js";
import type { DispatchJob } from "./dispatch-manager.js";
import { resolveRunScopedPauseState } from "../dispatcher/paused-run-state.js";

export interface SessionRecoveryDb {
  getAllSessions(): SessionRow[];
  upsertSession(entry: SessionRow): void;
  getStatus(taskId: string): ReturnType<QuackDB["getStatus"]>;
  setStatus(taskId: string, status: string, updatedBy: string): void;
}

export interface SessionRecoveryProject {
  db: SessionRecoveryDb;
  dispatchManager?: {
    getAllJobs(): DispatchJob[];
  } | null;
  /**
   * TASK-1329 / QPI-041: where this project's approval records live. Without it
   * the sweep cannot tell a crashed run from one paused at a human gate, and
   * rolls both back. Optional so existing callers keep compiling; when absent
   * the sweep behaves exactly as it did before.
   */
  logDir?: string;
}

export interface SessionRecoveryResult {
  cleaned: number;
  recoveredTaskIds: string[];
  reasons: Record<string, number>;
}

export interface SessionRecoveryProjectSummary {
  projectId: string;
  projectName: string;
  cleaned: number;
  recoveredTaskIds: string[];
  reasons: Record<string, number>;
}

export interface SessionRecoverySweepSummary {
  lastRunAt: string;
  totalCleaned: number;
  projects: SessionRecoveryProjectSummary[];
}

export const DEFAULT_STALE_DB_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function recordReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export function cleanupInactiveDbDispatchSessions(
  project: SessionRecoveryProject,
  maxAgeMs = DEFAULT_STALE_DB_SESSION_MAX_AGE_MS,
  nowMs = Date.now(),
): SessionRecoveryResult {
  const jobs = project.dispatchManager?.getAllJobs() ?? [];
  const jobsBySessionId = new Map(jobs.map((job) => [job.sessionId, job] as const));
  const jobsByTaskId = new Map(jobs.map((job) => [job.taskId, job] as const));
  const result: SessionRecoveryResult = {
    cleaned: 0,
    recoveredTaskIds: [],
    reasons: {},
  };

  for (const session of project.db.getAllSessions()) {
    if (session.status !== "active") continue;
    if (session.session_id.startsWith("federation-")) continue;

    const matchedJob = jobsBySessionId.get(session.session_id) ?? jobsByTaskId.get(session.task_id);
    const matchedJobStatus = matchedJob?.status;
    if (matchedJobStatus === "running" || matchedJobStatus === "awaiting_approval") {
      continue;
    }

    // TASK-1329 / QPI-041: the checks above read the IN-MEMORY job map, which a
    // monitor restart empties. After a restart every session looks unmatched,
    // including ones paused at a human gate with a valid pend still on disk -
    // and this sweep would mark the session `error` and roll the task status
    // back out from under a decision the operator has not made yet.
    //
    // The session's own start_time is the run boundary, so the disk answer can
    // be scoped to THIS run: a pend an earlier run left behind is not a reason
    // to spare this session.
    if (project.logDir) {
      const paused = resolveRunScopedPauseState(
        project.logDir,
        session.task_id,
        session.start_time,
      );
      if (paused) {
        recordReason(result.reasons, "paused_at_human_gate");
        continue;
      }
    }

    const durationMs = Math.max(0, nowMs - new Date(session.start_time).getTime());
    let outcome: "dispatch_process_exited" | "stale_dispatch_recovery" | null = null;

    if (matchedJobStatus) {
      outcome = "dispatch_process_exited";
    } else if (durationMs >= maxAgeMs) {
      outcome = "stale_dispatch_recovery";
    }

    if (!outcome) continue;

    project.db.upsertSession({
      ...session,
      status: "error",
      outcome,
      duration_ms: durationMs,
    });
    restoreTaskStatusFromInProgress(project, session.task_id, outcome);
    result.cleaned += 1;
    result.recoveredTaskIds.push(session.task_id);
    recordReason(result.reasons, outcome);
  }

  return result;
}

export function summarizeSessionRecoverySweep(
  projects: SessionRecoveryProjectSummary[],
  lastRunAt = new Date().toISOString(),
): SessionRecoverySweepSummary {
  return {
    lastRunAt,
    totalCleaned: projects.reduce((sum, project) => sum + project.cleaned, 0),
    projects,
  };
}
