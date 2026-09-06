import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { EventReader } from "../../src/monitor/event-reader";
import type { QuackEvent, SessionEntry } from "../../src/monitor/event-types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-reader-"));
}

function writeJsonl<T>(filePath: string, entries: T[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeEvent(
  sessionId: string,
  stage: string,
  payload: Record<string, unknown> = {},
  timestamp?: string,
): QuackEvent {
  return {
    sessionId,
    taskId: "TASK-001",
    project: "test",
    timestamp: timestamp ?? new Date().toISOString(),
    stage: stage as QuackEvent["stage"],
    payload: payload as unknown as QuackEvent["payload"],
  };
}

function makeSession(
  sessionId: string,
  status: SessionEntry["status"],
  outcome?: string,
): SessionEntry {
  return {
    sessionId,
    taskId: "TASK-001",
    project: "test",
    startTime: new Date().toISOString(),
    status,
    outcome,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("EventReader", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  describe("getAllSessions", () => {
    it("returns empty array when no sessions file exists", () => {
      const reader = new EventReader(logDir);
      expect(reader.getAllSessions()).toEqual([]);
    });

    it("returns sessions in reverse order (newest first)", () => {
      const sessions = [
        makeSession("session-a", "completed", "approved"),
        makeSession("session-b", "active"),
      ];
      writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

      const reader = new EventReader(logDir);
      const result = reader.getAllSessions();

      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe("session-b");
      expect(result[1].sessionId).toBe("session-a");
    });

    it("skips malformed lines", () => {
      const content =
        '{"sessionId":"good","taskId":"T","project":"p","startTime":"2024","status":"active"}\n{bad json}\n';
      fs.writeFileSync(path.join(logDir, "sessions.jsonl"), content, "utf-8");

      const reader = new EventReader(logDir);
      const result = reader.getAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("good");
    });
  });

  describe("getExecutionSessions", () => {
    it("keeps diagnostic sessions audit-visible but excludes them from execution history", () => {
      writeJsonl(path.join(logDir, "sessions.jsonl"), [
        makeSession("execution", "completed", "approved"),
        makeSession("quack-diagnostic-claimant-task-001-kind", "completed", "claimant_diagnostic"),
      ]);
      const reader = new EventReader(logDir);

      expect(reader.getAllSessions()).toHaveLength(2);
      expect(reader.getExecutionSessions().map((session) => session.sessionId)).toEqual([
        "execution",
      ]);
    });
  });

  describe("getSessionEvents", () => {
    it("returns empty array when events file does not exist", () => {
      const reader = new EventReader(logDir);
      expect(reader.getSessionEvents("nonexistent")).toEqual([]);
    });

    it("returns all events for a session", () => {
      const events = [
        makeEvent("session-x", "session_start", { model: "opus", maxTurns: 50, maxBudget: 10 }),
        makeEvent("session-x", "gate_schema", { valid: true, missing: [], warnings: [] }),
        makeEvent("session-x", "gate_result", { outcome: "pass" }),
      ];
      writeJsonl(path.join(logDir, "events-session-x.jsonl"), events);

      const reader = new EventReader(logDir);
      const result = reader.getSessionEvents("session-x");

      expect(result).toHaveLength(3);
      expect(result[0].stage).toBe("session_start");
      expect(result[2].stage).toBe("gate_result");
    });
  });

  describe("getSessionEventsAfter", () => {
    it("filters events after a given timestamp", () => {
      const events = [
        makeEvent("s1", "session_start", {}, "2024-01-01T10:00:00.000Z"),
        makeEvent("s1", "gate_schema", {}, "2024-01-01T10:00:01.000Z"),
        makeEvent("s1", "agent_turn", {}, "2024-01-01T10:00:05.000Z"),
      ];
      writeJsonl(path.join(logDir, "events-s1.jsonl"), events);

      const reader = new EventReader(logDir);
      const result = reader.getSessionEventsAfter("s1", "2024-01-01T10:00:01.000Z");

      expect(result).toHaveLength(1);
      expect(result[0].stage).toBe("agent_turn");
    });
  });

  describe("getEscalations", () => {
    it("returns sessions with error or rejected outcomes", () => {
      const sessions = [
        makeSession("s1", "completed", "approved"),
        makeSession("s2", "completed", "rejected"),
        makeSession("s3", "error"),
        makeSession("s4", "completed", "agent_failed"),
      ];
      writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

      // Create empty event files
      for (const s of sessions) {
        fs.writeFileSync(path.join(logDir, `events-${s.sessionId}.jsonl`), "", "utf-8");
      }

      const reader = new EventReader(logDir);
      const escalations = reader.getEscalations();

      expect(escalations).toHaveLength(3);
      const ids = escalations.map((e) => e.session.sessionId);
      expect(ids).toContain("s2");
      expect(ids).toContain("s3");
      expect(ids).toContain("s4");
      expect(ids).not.toContain("s1");
    });

    it("returns empty array when no escalations", () => {
      const sessions = [makeSession("s1", "completed", "approved")];
      writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

      const reader = new EventReader(logDir);
      expect(reader.getEscalations()).toHaveLength(0);
    });
  });
});

// ─── TASK-1329 round-2 R2-1 ─────────────────────────────────────────
// cleanupOrphanedSessions runs at STARTUP, on the reasoning that "no running
// children means every active session is orphaned". That is also true of a run
// paused at a human gate, because the child exits at the gate by design - so
// the restart a pause is supposed to survive was the exact moment it got marked
// monitor_crash, BEFORE the pause-aware recovery sweep could protect it.
describe("cleanupOrphanedSessions and durably paused runs", () => {
  function seedActiveSession(dir: string, taskId: string, startTime: string): void {
    writeJsonl(path.join(dir, "sessions.jsonl"), [
      {
        sessionId: `sess-${taskId}`,
        taskId,
        project: "test",
        startTime,
        status: "active" as const,
      },
    ]);
  }

  function writePend(dir: string, taskId: string, createdAt: string): void {
    const approvals = path.join(dir, "approvals");
    fs.mkdirSync(approvals, { recursive: true });
    fs.writeFileSync(
      path.join(approvals, `${taskId}.json`),
      JSON.stringify({ state: "pending", createdAt }),
      "utf-8",
    );
  }

  it("spares a session whose run is paused at a gate", () => {
    const dir = makeTempDir();
    const startTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedActiveSession(dir, "TASK-777", startTime);
    writePend(dir, "TASK-777", new Date(Date.parse(startTime) + 1000).toISOString());

    const reader = new EventReader(dir);
    expect(reader.cleanupOrphanedSessions()).toBe(0);
    expect(reader.getAllSessions()[0].status).toBe("active");
  });

  it("still cleans a session with no pend at all", () => {
    const dir = makeTempDir();
    seedActiveSession(dir, "TASK-778", new Date(Date.now() - 30 * 60 * 1000).toISOString());

    const reader = new EventReader(dir);
    expect(reader.cleanupOrphanedSessions()).toBe(1);
    expect(reader.getAllSessions()[0].status).toBe("error");
  });

  it("still cleans when the pend belongs to an earlier run", () => {
    const dir = makeTempDir();
    const startTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedActiveSession(dir, "TASK-779", startTime);
    writePend(dir, "TASK-779", new Date(Date.parse(startTime) - 60_000).toISOString());

    const reader = new EventReader(dir);
    expect(reader.cleanupOrphanedSessions()).toBe(1);
  });
});
