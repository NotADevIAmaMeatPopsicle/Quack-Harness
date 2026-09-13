import type { SessionRow } from "../../src/db/types";
import {
  buildTaskSessionMapFromSummaries,
  SessionService,
  sessionRowToMonitorSummary,
} from "../../src/monitor/session-service";

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  session_id: "s1",
  task_id: "TASK-001",
  project: "quack",
  title: null,
  start_time: "2026-04-30T10:00:00.000Z",
  status: "completed",
  outcome: "approved",
  total_cost_usd: 1.5,
  duration_ms: 1200,
  turns_used: 4,
  ...overrides,
});

describe("session-service", () => {
  it("normalizes DB rows to monitor summaries with fallback title and gate score", () => {
    expect(
      sessionRowToMonitorSummary(row(), {
        title: "Fallback title",
        gateScore: 4.8,
      }),
    ).toEqual({
      sessionId: "s1",
      taskId: "TASK-001",
      project: "quack",
      title: "Fallback title",
      startTime: "2026-04-30T10:00:00.000Z",
      status: "completed",
      outcome: "approved",
      totalCostUsd: 1.5,
      durationMs: 1200,
      turnsUsed: 4,
      gateScore: 4.8,
    });
  });

  it("builds latest task session map by outcome priority", () => {
    const map = buildTaskSessionMapFromSummaries([
      sessionRowToMonitorSummary(
        row({
          session_id: "s1",
          outcome: "rejected",
          total_cost_usd: 0.5,
        }),
      ),
      sessionRowToMonitorSummary(
        row({
          session_id: "s2",
          outcome: "approved",
          total_cost_usd: 1.25,
        }),
      ),
    ]);

    expect(map.get("TASK-001")).toEqual({
      outcome: "approved",
      costUsd: 1.25,
      status: "completed",
    });
  });

  it("prefers DB sessions and enriches missing titles and gate scores", async () => {
    const db = {
      getAllSessions: () => [row()],
      getSessionsForTask: () => [],
      getPrep: () => ({ depth_score: 4.9 }),
    };
    const reader = {
      getAllSessions: () => [
        {
          sessionId: "file-session",
          taskId: "TASK-999",
          project: "quack",
          startTime: "2026-04-30T09:00:00.000Z",
          status: "completed",
        },
      ],
      getSessionEvents: () => [],
    };
    const taskService = {
      listTasks: () =>
        Promise.resolve({
          tasks: [{ id: "TASK-001", title: "Resolved task title" }],
        }),
    };

    const service = new SessionService({
      db: db as never,
      reader: reader as never,
      taskService: taskService as never,
      resolveGateScore: () => Promise.resolve(4.9),
    });

    const sessions = await service.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        sessionId: "s1",
        title: "Resolved task title",
        gateScore: 4.9,
      }),
    );
  });

  it("falls back to file sessions when DB has no rows", async () => {
    const service = new SessionService({
      db: {
        getAllSessions: () => [],
        getSessionsForTask: () => [],
        getPrep: () => undefined,
      } as never,
      reader: {
        getAllSessions: () => [
          {
            sessionId: "file-session",
            taskId: "TASK-999",
            project: "quack",
            title: "File title",
            startTime: "2026-04-30T09:00:00.000Z",
            status: "completed",
            outcome: "approved",
            totalCostUsd: 0.75,
          },
        ],
        getSessionEvents: () => [],
      } as never,
    });

    const sessions = await service.listSessions();
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "file-session",
        taskId: "TASK-999",
        title: "File title",
        outcome: "approved",
        totalCostUsd: 0.75,
      }),
    ]);
  });
  it.each(["listSessions", "getTaskRuns"] as const)("%s preserves session details without trusting mixed DB scores", async method => {
    const entry = row({ title: "Stored title" });
    const getPrep = jest.fn(() => ({ depth_score: 5 }));
    const service = new SessionService({ db: { getAllSessions: () => [entry], getSessionsForTask: () => [entry], getPrep } as never,
      reader: { getAllSessions: () => [] } as never });
    const sessions = method === "listSessions" ? await service.listSessions() : await service.getTaskRuns(entry.task_id);
    expect(sessions).toEqual([sessionRowToMonitorSummary(entry)]);
    expect(sessions[0]).toMatchObject({ sessionId: "s1", title: "Stored title", status: "completed", outcome: "approved",
      totalCostUsd: 1.5, durationMs: 1200, turnsUsed: 4, gateScore: null });
    expect(getPrep).not.toHaveBeenCalled();
  });
  it.each([[0, 0], [5, 5], [4.9, 4.9], [NaN, null], [Infinity, null], [-1, null], [6, null], [null, null]])("filters resolver score %s to %s without clamping", async (score, expected) => {
    const service = new SessionService({ db: { getAllSessions: () => [row()], getSessionsForTask: () => [row()] } as never,
      reader: {} as never, resolveGateScore: () => Promise.resolve(score) });
    expect((await service.listSessions())[0].gateScore).toBe(expected);
    expect((await service.getTaskRuns("TASK-001"))[0].gateScore).toBe(expected);
  });
  it("keeps a session visible when its current readiness resolver fails", async () => {
    const service = new SessionService({ db: { getAllSessions: () => [row()] } as never, reader: {} as never,
      resolveGateScore: () => Promise.reject(new Error("unavailable")) });
    expect((await service.listSessions())[0]).toMatchObject({ sessionId: "s1", gateScore: null });
  });

});
