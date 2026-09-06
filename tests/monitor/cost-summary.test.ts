import {
  buildCostSummaryFromSessions,
  sessionRowToCostSummarySession,
} from "../../src/monitor/cost-summary.js";
import type { SessionRow } from "../../src/db/types.js";

describe("cost summary normalization", () => {
  const now = new Date("2026-04-30T12:00:00.000Z");

  it("returns the dashboard CostSummary shape for SQLite session rows", () => {
    const rows: SessionRow[] = [
      {
        session_id: "sess-new",
        task_id: "TASK-002",
        project: "quack",
        title: "Second task",
        start_time: "2026-04-30T11:30:00.000Z",
        status: "completed",
        outcome: "approved",
        total_cost_usd: 2.5,
        duration_ms: 120000,
        turns_used: 8,
      },
      {
        session_id: "sess-old",
        task_id: "TASK-001",
        project: "quack",
        title: "First task",
        start_time: "2026-04-24T09:00:00.000Z",
        status: "error",
        outcome: "agent_failed",
        total_cost_usd: 1.25,
        duration_ms: 60000,
        turns_used: 4,
      },
    ];

    const summary = buildCostSummaryFromSessions(rows.map(sessionRowToCostSummarySession), now);

    expect(summary).toMatchObject({
      totalCostUsd: 3.75,
      sessionCount: 2,
      avgCostPerSession: 1.875,
      todayCostUsd: 2.5,
      hourlyCostUsd: 2.5,
      monthToDateCostUsd: 3.75,
      monthToDateSessionCount: 2,
      last7DaysCostUsd: 3.75,
      last30DaysCostUsd: 3.75,
    });
    expect(summary.byDay).toEqual([
      { date: "2026-04-24", costUsd: 1.25, sessions: 1 },
      { date: "2026-04-30", costUsd: 2.5, sessions: 1 },
    ]);
    expect(summary.byTask).toEqual([
      {
        taskId: "TASK-002",
        costUsd: 2.5,
        outcome: "approved",
        date: "2026-04-30T11:30:00.000Z",
        durationMs: 120000,
        turnsUsed: 8,
      },
      {
        taskId: "TASK-001",
        costUsd: 1.25,
        outcome: "agent_failed",
        date: "2026-04-24T09:00:00.000Z",
        durationMs: 60000,
        turnsUsed: 4,
      },
    ]);
  });

  it("skips zero-cost active sessions but keeps completed zero-cost sessions", () => {
    const summary = buildCostSummaryFromSessions(
      [
        {
          taskId: "TASK-ACTIVE",
          startTime: "2026-04-30T11:59:00.000Z",
          status: "active",
          totalCostUsd: 0,
        },
        {
          taskId: "TASK-COMPLETE",
          startTime: "2026-04-30T10:00:00.000Z",
          status: "completed",
          outcome: "success",
          totalCostUsd: 0,
        },
      ],
      now,
    );

    expect(summary.sessionCount).toBe(1);
    expect(summary.byTask).toEqual([
      {
        taskId: "TASK-COMPLETE",
        costUsd: 0,
        outcome: "success",
        date: "2026-04-30T10:00:00.000Z",
        durationMs: 0,
        turnsUsed: 0,
      },
    ]);
  });
});
