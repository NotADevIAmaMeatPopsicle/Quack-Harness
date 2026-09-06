import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { QuackDB } from "../../src/db/quack-db";
import { cleanupInactiveDbDispatchSessions } from "../../src/monitor/session-recovery";

describe("cleanupInactiveDbDispatchSessions", () => {
  let tmpDir: string;
  let db: QuackDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-session-recovery-"));
    fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });
    db = new QuackDB(path.join(tmpDir, ".quack", "quack.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── TASK-1329 / QPI-041 ──────────────────────────────────────────
  // After a monitor restart the in-memory job map is EMPTY, so every active
  // session looks unmatched - including one paused at a human gate whose pend
  // is still valid on disk. Before this guard the sweep marked that session
  // `error` and rolled the task status back, out from under a decision the
  // operator had not made yet.
  function seedStaleActiveSession(taskId: string, startTime: string): void {
    db.setStatus(taskId, "READY", "seed");
    db.setStatus(taskId, "IN_PROGRESS", "session_start");
    db.upsertSession({
      session_id: `session-${taskId}`,
      task_id: taskId,
      project: "test",
      title: null,
      start_time: startTime,
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });
  }

  function writePend(logDir: string, file: string, createdAt: string): void {
    const dir = path.join(logDir, "approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, file),
      JSON.stringify({ state: "pending", createdAt }),
      "utf-8",
    );
  }

  test("does NOT roll back a run paused at a human gate when the job map is empty (post-restart)", () => {
    const logDir = path.join(tmpDir, ".quack", "logs");
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    seedStaleActiveSession("TASK-900", startTime);
    // Pend opened just after the run began, so it belongs to THIS run.
    writePend(logDir, "TASK-900.json", new Date(Date.parse(startTime) + 1000).toISOString());

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: { getAllJobs: () => [] }, // the restart
      logDir,
    });

    expect(result.cleaned).toBe(0);
    expect(result.reasons.paused_at_human_gate).toBe(1);
    expect(db.getStatus("TASK-900")?.status).toBe("IN_PROGRESS");
  });

  test("DOES roll back when the pend belongs to an earlier run, not this one", () => {
    const logDir = path.join(tmpDir, ".quack", "logs");
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    seedStaleActiveSession("TASK-901", startTime);
    // Opened BEFORE this run started: a leftover, not this run's pause.
    writePend(logDir, "TASK-901.json", new Date(Date.parse(startTime) - 60_000).toISOString());

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: { getAllJobs: () => [] },
      logDir,
    });

    expect(result.cleaned).toBe(1);
    expect(result.reasons.paused_at_human_gate).toBeUndefined();
    expect(db.getStatus("TASK-901")?.status).toBe("READY");
  });

  test("without logDir the sweep behaves exactly as it did pre-1329", () => {
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    seedStaleActiveSession("TASK-902", startTime);

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: { getAllJobs: () => [] },
    });

    expect(result.cleaned).toBe(1);
    expect(db.getStatus("TASK-902")?.status).toBe("READY");
  });

  test("restores IN_PROGRESS when a tracked dispatch session already exited", () => {
    const startTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.setStatus("TASK-101", "READY", "seed");
    db.setStatus("TASK-101", "IN_PROGRESS", "session_start");
    db.upsertSession({
      session_id: "session-101",
      task_id: "TASK-101",
      project: "test",
      title: null,
      start_time: startTime,
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: {
        getAllJobs: () => [
          {
            taskId: "TASK-101",
            sessionId: "session-101",
            pid: 0,
            startedAt: startTime,
            status: "failed",
            exitCode: 1,
            output: [],
          },
        ],
      },
    });

    expect(result.cleaned).toBe(1);
    expect(result.reasons.dispatch_process_exited).toBe(1);
    expect(db.getStatus("TASK-101")?.status).toBe("READY");
    expect(db.getLatestSession("TASK-101")).toMatchObject({
      status: "error",
      outcome: "dispatch_process_exited",
    });
  });

  test("leaves awaiting approval sessions alone", () => {
    const startTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.setStatus("TASK-102", "READY", "seed");
    db.setStatus("TASK-102", "IN_PROGRESS", "session_start");
    db.upsertSession({
      session_id: "session-102",
      task_id: "TASK-102",
      project: "test",
      title: null,
      start_time: startTime,
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: {
        getAllJobs: () => [
          {
            taskId: "TASK-102",
            sessionId: "session-102",
            pid: 0,
            startedAt: startTime,
            status: "awaiting_approval",
            output: [],
          },
        ],
      },
    });

    expect(result.cleaned).toBe(0);
    expect(db.getStatus("TASK-102")?.status).toBe("IN_PROGRESS");
    expect(db.getLatestSession("TASK-102")?.status).toBe("active");
  });

  test("recovers stale active sessions even when no dispatch job remains", () => {
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    db.setStatus("TASK-103", "READY", "seed");
    db.setStatus("TASK-103", "IN_PROGRESS", "session_start");
    db.upsertSession({
      session_id: "session-103",
      task_id: "TASK-103",
      project: "test",
      title: null,
      start_time: startTime,
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });

    const result = cleanupInactiveDbDispatchSessions({
      db,
      dispatchManager: {
        getAllJobs: () => [],
      },
    });

    expect(result.cleaned).toBe(1);
    expect(result.reasons.stale_dispatch_recovery).toBe(1);
    expect(db.getStatus("TASK-103")?.status).toBe("READY");
    expect(db.getLatestSession("TASK-103")).toMatchObject({
      status: "error",
      outcome: "stale_dispatch_recovery",
    });
  });
});
