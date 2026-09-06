import type { SessionRow } from "../db/types.js";
import type { NoopDB, QuackDB } from "../db/index.js";
import type { SessionEntry } from "./event-types.js";
import type { EventReader } from "./event-reader.js";
import type { TaskService } from "./task-service.js";
import type { TaskSessionInfo } from "./task-projection.js";

export interface MonitorSessionSummary {
  sessionId: string;
  taskId: string;
  project: string;
  title: string | null;
  startTime: string;
  status: string;
  outcome: string | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  turnsUsed: number | null;
  gateScore: number | null;
}

export interface SessionServiceDeps {
  db?: QuackDB | NoopDB;
  reader: EventReader;
  taskService?: TaskService;
  resolveGateScore?: (taskId: string) => Promise<number | null>;
}

export function sessionRowToMonitorSummary(
  row: SessionRow,
  options: {
    title?: string;
    gateScore?: number | null;
  } = {},
): MonitorSessionSummary {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    project: row.project,
    title:
      (row.title && row.title !== row.task_id ? row.title : undefined) ?? options.title ?? null,
    startTime: row.start_time,
    status: row.status,
    outcome: row.outcome,
    totalCostUsd: row.total_cost_usd,
    durationMs: row.duration_ms,
    turnsUsed: row.turns_used,
    gateScore: options.gateScore ?? null,
  };
}

export function eventSessionToMonitorSummary(session: SessionEntry): MonitorSessionSummary {
  return {
    sessionId: session.sessionId,
    taskId: session.taskId,
    project: session.project,
    title: session.title ?? null,
    startTime: session.startTime,
    status: session.status,
    outcome: session.outcome ?? null,
    totalCostUsd: session.totalCostUsd ?? null,
    durationMs: session.durationMs ?? null,
    turnsUsed: session.turnsUsed ?? null,
    gateScore: null,
  };
}

export function buildTaskSessionMapFromSummaries(
  sessions: MonitorSessionSummary[],
): Map<string, TaskSessionInfo> {
  const map = new Map<string, TaskSessionInfo>();

  const priority = (session: { outcome?: string | null; status: string }): number => {
    if (session.outcome === "approved") return 3;
    if (session.status === "active") return 2;
    if (session.outcome === "rejected" || session.outcome === "agent_failed") return 1;
    return 0;
  };

  for (const session of sessions) {
    const existing = map.get(session.taskId);
    const newPriority = priority(session);
    const existingPriority = existing
      ? priority({ outcome: existing.outcome, status: existing.status })
      : -1;
    if (newPriority >= existingPriority) {
      map.set(session.taskId, {
        outcome: session.outcome ?? session.status,
        costUsd: session.totalCostUsd ?? 0,
        status: session.status,
      });
    }
  }

  return map;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async listSessions(): Promise<MonitorSessionSummary[]> {
    const dbSessions = await this.listDbSessions();
    if (dbSessions.length > 0) return dbSessions;
    return this.deps.reader.getAllSessions().map(eventSessionToMonitorSummary);
  }

  getSessionEvents(sessionId: string) {
    return this.deps.reader.getSessionEvents(sessionId);
  }

  async getTaskRuns(taskId: string): Promise<MonitorSessionSummary[]> {
    const rows = this.deps.db?.getSessionsForTask(taskId) ?? [];
    if (rows.length > 0) {
      const titleLookup = await this.buildTaskTitleLookup(rows);
      const gateScores = await this.buildGateScoreLookup(rows);
      return rows.map((row) =>
        sessionRowToMonitorSummary(row, {
          title: titleLookup.get(row.task_id),
          gateScore: gateScores.get(row.task_id) ?? null,
        }),
      );
    }
    return this.deps.reader
      .getAllSessions()
      .filter((session) => session.taskId === taskId)
      .map(eventSessionToMonitorSummary);
  }

  async buildTaskSessionMap(): Promise<Map<string, TaskSessionInfo>> {
    const dbSessions = await this.listDbSessions();
    if (dbSessions.length > 0) return buildTaskSessionMapFromSummaries(dbSessions);
    return buildTaskSessionMapFromSummaries(
      this.deps.reader.getExecutionSessions().map(eventSessionToMonitorSummary),
    );
  }

  private async listDbSessions(): Promise<MonitorSessionSummary[]> {
    const rows = this.deps.db?.getAllSessions() ?? [];
    if (rows.length === 0) return [];

    const titleLookup = await this.buildTaskTitleLookup(rows);
    const gateScores = await this.buildGateScoreLookup(rows);
    return rows.map((row) =>
      sessionRowToMonitorSummary(row, {
        title: titleLookup.get(row.task_id),
        gateScore: gateScores.get(row.task_id) ?? null,
      }),
    );
  }

  private async buildTaskTitleLookup(rows: SessionRow[]): Promise<Map<string, string>> {
    const lookup = new Map<string, string>();
    const needsTitles = rows.some((row) => !row.title || row.title === row.task_id);
    if (!needsTitles || !this.deps.taskService) return lookup;

    try {
      const { tasks } = await this.deps.taskService.listTasks();
      for (const task of tasks) {
        lookup.set(task.id, task.title);
      }
    } catch {
      // Non-critical: session rows can render without resolved task titles.
    }
    return lookup;
  }

  private async buildGateScoreLookup(rows: SessionRow[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    const db = this.deps.db;
    if (this.deps.resolveGateScore) {
      const uniqueTaskIds = [...new Set(rows.map((row) => row.task_id))];
      for (const taskId of uniqueTaskIds) {
        try {
          const score = await this.deps.resolveGateScore(taskId);
          if (typeof score === "number") {
            scores.set(taskId, score);
          }
        } catch {
          // Non-critical: gate score badges are supplemental.
        }
      }
      return scores;
    }

    if (!db) return scores;

    try {
      const uniqueTaskIds = [...new Set(rows.map((row) => row.task_id))];
      for (const taskId of uniqueTaskIds) {
        const prep = db.getPrep(taskId);
        if (prep?.depth_score) {
          scores.set(taskId, prep.depth_score);
        }
      }
    } catch {
      // Non-critical: gate score badges are supplemental.
    }
    return scores;
  }
}
