// QPI-043: the exit facts of a dispatch child must land in the events
// jsonl of the child's own session — on disk, surviving a monitor
// restart. These tests run against a real tmp log dir because the
// entire defect class was instrumentation that looked wired and wrote
// nothing.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendDispatchChildExit,
  type AppendDispatchChildExitOptions,
} from "../../src/monitor/child-exit-log";
import { EventReader } from "../../src/monitor/event-reader";
import type { DispatchChildExitPayload, QuackEvent } from "../../src/monitor/event-types";

describe("appendDispatchChildExit (QPI-043)", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-child-exit-"));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function writeSessions(entries: Array<Record<string, unknown>>): void {
    fs.writeFileSync(
      path.join(logDir, "sessions.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
  }

  function readEvents(sessionId: string): QuackEvent[] {
    const file = path.join(logDir, `events-${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QuackEvent);
  }

  // logDir is minted per-test in beforeEach, so options are built by a
  // factory rather than a shared const.
  function opts(
    overrides: Partial<AppendDispatchChildExitOptions> = {},
  ): AppendDispatchChildExitOptions {
    return {
      logDir,
      taskId: "TASK-1273",
      jobSessionId: "quack-TASK-1273-1754700000000",
      jobStartedAt: "2026-08-09T10:00:00.000Z",
      exitCode: null,
      signal: null,
      worktreePath: "C:\\repo\\.quack\\worktrees\\TASK-1273",
      isolation: "worktree",
      ...overrides,
    };
  }

  test("appends into the child session's events file when the child recorded after spawn", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-1273-20260809-100002",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:02.000Z",
        status: "active",
      },
    ]);

    const result = appendDispatchChildExit(opts({ exitCode: 0 }));

    expect(result.resolution).toBe("child-session");
    expect(result.sessionId).toBe("quack-TASK-1273-20260809-100002");

    const events = readEvents("quack-TASK-1273-20260809-100002");
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("dispatch_child_exit");
    expect(events[0].taskId).toBe("TASK-1273");
    expect(events[0].project).toBe("example-service");
    const payload = events[0].payload as DispatchChildExitPayload;
    expect(payload.exitCode).toBe(0);
    expect(payload.killed).toBe(false);
    expect(payload.isolation).toBe("worktree");
    expect(payload.sessionResolution).toBe("child-session");
  });

  test("appends to the END of an existing timeline rather than replacing it", () => {
    const sessionId = "quack-TASK-1273-20260809-100002";
    writeSessions([
      {
        sessionId,
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:02.000Z",
        status: "active",
      },
    ]);
    const priorEvent: QuackEvent = {
      sessionId,
      taskId: "TASK-1273",
      project: "example-service",
      timestamp: "2026-08-09T10:05:00.000Z",
      stage: "checkpoint_saved",
      payload: { taskId: "TASK-1273" } as never,
    };
    fs.writeFileSync(
      path.join(logDir, `events-${sessionId}.jsonl`),
      JSON.stringify(priorEvent) + "\n",
      "utf-8",
    );

    appendDispatchChildExit(opts());

    const events = readEvents(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].stage).toBe("checkpoint_saved");
    expect(events[1].stage).toBe("dispatch_child_exit");
  });

  test("falls back to the newest task session when every session predates the spawn", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-1273-20260808-090000",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-08T09:00:00.000Z",
        status: "error",
      },
      {
        sessionId: "quack-TASK-1273-20260808-120000",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-08T12:00:00.000Z",
        status: "error",
      },
    ]);

    const result = appendDispatchChildExit(opts());

    expect(result.resolution).toBe("latest-task-session");
    expect(result.sessionId).toBe("quack-TASK-1273-20260808-120000");
    expect(readEvents("quack-TASK-1273-20260808-120000")).toHaveLength(1);
  });

  test("falls back to the job session id when the task has no session at all", () => {
    const result = appendDispatchChildExit(opts({ exitCode: 1 }));

    expect(result.resolution).toBe("job-fallback");
    expect(result.sessionId).toBe(opts().jobSessionId);

    const events = readEvents(opts().jobSessionId);
    expect(events).toHaveLength(1);
    expect(events[0].project).toBe("unknown");
    expect((events[0].payload as DispatchChildExitPayload).exitCode).toBe(1);
  });

  test("ignores sessions belonging to other tasks", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-9999-20260809-100005",
        taskId: "TASK-9999",
        project: "example-service",
        startTime: "2026-08-09T10:00:05.000Z",
        status: "active",
      },
    ]);

    const result = appendDispatchChildExit(opts());

    expect(result.resolution).toBe("job-fallback");
    expect(readEvents("quack-TASK-9999-20260809-100005")).toHaveLength(0);
  });

  test("picks the NEWEST post-spawn session when several exist", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-1273-20260809-100002",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:02.000Z",
        status: "error",
      },
      {
        sessionId: "quack-TASK-1273-20260809-101500",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:15:00.000Z",
        status: "active",
      },
    ]);

    const result = appendDispatchChildExit(opts());

    expect(result.sessionId).toBe("quack-TASK-1273-20260809-101500");
  });

  test("never correlates a child exit to a newer claimant diagnostic session", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-1273-execution",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:02.000Z",
        status: "active",
      },
      {
        sessionId: "quack-diagnostic-claimant-task-1273-kind",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:03.000Z",
        status: "completed",
        outcome: "claimant_diagnostic",
      },
    ]);

    const result = appendDispatchChildExit(opts());

    expect(result).toMatchObject({
      resolution: "child-session",
      sessionId: "quack-TASK-1273-execution",
    });
    expect(readEvents("quack-diagnostic-claimant-task-1273-kind")).toEqual([]);
  });

  test("a SIGKILLed child is recorded as killed with the signal preserved", () => {
    const result = appendDispatchChildExit(opts({ exitCode: null, signal: "SIGKILL" }));

    const events = readEvents(result.sessionId);
    const payload = events[0].payload as DispatchChildExitPayload;
    expect(payload.signal).toBe("SIGKILL");
    expect(payload.killed).toBe(true);
    expect(payload.exitCode).toBeNull();
  });

  test("the appended line is returned by EventReader.getSessionEvents (the investigator's read path)", () => {
    writeSessions([
      {
        sessionId: "quack-TASK-1273-20260809-100002",
        taskId: "TASK-1273",
        project: "example-service",
        startTime: "2026-08-09T10:00:02.000Z",
        status: "active",
      },
    ]);

    appendDispatchChildExit(opts({ exitCode: 3 }));

    const reader = new EventReader(logDir);
    const events = reader.getSessionEvents("quack-TASK-1273-20260809-100002");
    expect(events.map((e) => e.stage)).toContain("dispatch_child_exit");
  });
});
