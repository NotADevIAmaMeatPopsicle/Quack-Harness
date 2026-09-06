import type { SessionRow } from "../db/types.js";
import type { CostSummary, SessionEntry } from "./event-types.js";

export interface CostSummarySession {
  taskId: string;
  startTime: string;
  status: string;
  outcome?: string | null;
  totalCostUsd?: number | null;
  durationMs?: number | null;
  turnsUsed?: number | null;
}

export function sessionRowToCostSummarySession(row: SessionRow): CostSummarySession {
  return {
    taskId: row.task_id,
    startTime: row.start_time,
    status: row.status,
    outcome: row.outcome,
    totalCostUsd: row.total_cost_usd,
    durationMs: row.duration_ms,
    turnsUsed: row.turns_used,
  };
}

export function eventSessionToCostSummarySession(session: SessionEntry): CostSummarySession {
  return {
    taskId: session.taskId,
    startTime: session.startTime,
    status: session.status,
    outcome: session.outcome,
    totalCostUsd: session.totalCostUsd,
    durationMs: session.durationMs,
    turnsUsed: session.turnsUsed,
  };
}

export function buildCostSummaryFromSessions(
  sessions: CostSummarySession[],
  now: Date = new Date(),
): CostSummary {
  const todayStr = now.toISOString().slice(0, 10);
  const currentMonthStr = todayStr.slice(0, 7);
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  let totalCost = 0;
  let todayCost = 0;
  let hourlyCost = 0;
  let monthToDateCost = 0;
  let monthToDateSessionCount = 0;
  let last7Cost = 0;
  let last30Cost = 0;
  let sessionCount = 0;

  const byDayMap = new Map<string, { costUsd: number; sessions: number }>();
  const byTask: CostSummary["byTask"] = [];

  for (const session of sessions) {
    const cost = session.totalCostUsd ?? 0;
    if (cost <= 0 && session.status === "active") continue;

    sessionCount++;
    totalCost += cost;

    const startDate = new Date(session.startTime);
    const dayKey = session.startTime.slice(0, 10);

    if (dayKey === todayStr) todayCost += cost;
    if (dayKey.startsWith(currentMonthStr)) {
      monthToDateCost += cost;
      monthToDateSessionCount++;
    }
    if (startDate >= oneHourAgo) hourlyCost += cost;
    if (startDate >= sevenDaysAgo) last7Cost += cost;
    if (startDate >= thirtyDaysAgo) last30Cost += cost;

    const dayEntry = byDayMap.get(dayKey) ?? { costUsd: 0, sessions: 0 };
    dayEntry.costUsd += cost;
    dayEntry.sessions++;
    byDayMap.set(dayKey, dayEntry);

    byTask.push({
      taskId: session.taskId,
      costUsd: cost,
      outcome: session.outcome ?? session.status,
      date: session.startTime,
      durationMs: session.durationMs ?? 0,
      turnsUsed: session.turnsUsed ?? 0,
    });
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalCostUsd: totalCost,
    sessionCount,
    avgCostPerSession: sessionCount > 0 ? totalCost / sessionCount : 0,
    todayCostUsd: todayCost,
    hourlyCostUsd: hourlyCost,
    monthToDateCostUsd: monthToDateCost,
    monthToDateSessionCount,
    last7DaysCostUsd: last7Cost,
    last30DaysCostUsd: last30Cost,
    byDay,
    byTask,
  };
}
