import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  EventWriter,
  generateSessionId,
  createNoOpWriter,
  resolveDurableEventLogDir,
} from "../../src/monitor/event-emitter";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import type { QuackEvent, SessionEntry } from "../../src/monitor/event-types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-emitter-"));
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("EventWriter", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("creates log directory on construction", () => {
    const nested = path.join(logDir, "deep", "nested");
    new EventWriter({
      sessionId: "test-session",
      taskId: "TASK-001",
      project: "test-project",
      logDir: nested,
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("keeps writing through the canonical target after a worktree log link is quarantined", () => {
    const target = path.join(logDir, "canonical-logs");
    const workspace = path.join(logDir, "worktree");
    const linked = path.join(workspace, ".quack", "logs");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");

    const writer = new EventWriter({
      sessionId: "linked-session",
      taskId: "TASK-DETACHED",
      project: "test-project",
      logDir: linked,
    });
    fs.rmSync(linked, { recursive: true, force: true });

    expect(() => writer.emit("session_start", { model: "test" })).not.toThrow();
    expect(fs.existsSync(path.join(target, "events-linked-session.jsonl"))).toBe(true);
  });

  it("emits events to JSONL file", () => {
    const writer = new EventWriter({
      sessionId: "test-session-1",
      taskId: "TASK-001",
      project: "test-project",
      logDir,
    });

    writer.emit("session_start", {
      model: "claude-opus-4-6",
      maxTurns: 50,
      maxBudget: 10,
    });

    writer.emit("gate_schema", {
      valid: true,
      missing: [],
      warnings: [],
    });

    const eventsFile = path.join(logDir, "events-test-session-1.jsonl");
    const events = readJsonl<QuackEvent>(eventsFile);

    expect(events).toHaveLength(2);
    expect(events[0].stage).toBe("session_start");
    expect(events[0].sessionId).toBe("test-session-1");
    expect(events[0].taskId).toBe("TASK-001");
    expect(events[0].project).toBe("test-project");
    expect(events[0].payload).toEqual({
      model: "claude-opus-4-6",
      maxTurns: 50,
      maxBudget: 10,
    });
    expect(events[1].stage).toBe("gate_schema");
  });

  it("records session entries to sessions.jsonl", () => {
    const writer = new EventWriter({
      sessionId: "test-session-2",
      taskId: "TASK-002",
      project: "test-project",
      logDir,
    });

    writer.recordSession("active");
    writer.recordSession("completed", {
      outcome: "approved",
      totalCostUsd: 1.5,
      durationMs: 60000,
    });

    const sessionsFile = path.join(logDir, "sessions.jsonl");
    const entries = readJsonl<SessionEntry>(sessionsFile);

    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe("active");
    expect(entries[0].sessionId).toBe("test-session-2");
    expect(entries[1].status).toBe("completed");
    expect(entries[1].outcome).toBe("approved");
    expect(entries[1].totalCostUsd).toBe(1.5);
    expect(entries[1].durationMs).toBe(60000);
  });

  it("includes title from instance property in session entries", () => {
    const writer = new EventWriter({
      sessionId: "test-session-title",
      taskId: "TASK-003",
      project: "test-project",
      logDir,
    });

    writer.title = "Add Task Title to SessionEntry";
    writer.recordSession("active");
    writer.recordSession("completed", { outcome: "approved" });

    const sessionsFile = path.join(logDir, "sessions.jsonl");
    const entries = readJsonl<SessionEntry>(sessionsFile);

    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("Add Task Title to SessionEntry");
    expect(entries[1].title).toBe("Add Task Title to SessionEntry");
  });

  it("allows extra.title to override instance title", () => {
    const writer = new EventWriter({
      sessionId: "test-session-override",
      taskId: "TASK-004",
      project: "test-project",
      logDir,
    });

    writer.title = "Original Title";
    writer.recordSession("active", { title: "Overridden Title" });

    const sessionsFile = path.join(logDir, "sessions.jsonl");
    const entries = readJsonl<SessionEntry>(sessionsFile);

    expect(entries[0].title).toBe("Overridden Title");
  });

  it("omits title when not set on instance", () => {
    const writer = new EventWriter({
      sessionId: "test-session-no-title",
      taskId: "TASK-005",
      project: "test-project",
      logDir,
    });

    writer.recordSession("active");

    const sessionsFile = path.join(logDir, "sessions.jsonl");
    const entries = readJsonl<SessionEntry>(sessionsFile);

    expect(entries[0].title).toBeUndefined();
  });

  it("appends to existing files", () => {
    const writer1 = new EventWriter({
      sessionId: "session-a",
      taskId: "TASK-001",
      project: "test",
      logDir,
    });
    writer1.recordSession("active");

    const writer2 = new EventWriter({
      sessionId: "session-b",
      taskId: "TASK-002",
      project: "test",
      logDir,
    });
    writer2.recordSession("active");

    const entries = readJsonl<SessionEntry>(path.join(logDir, "sessions.jsonl"));
    expect(entries).toHaveLength(2);
    expect(entries[0].sessionId).toBe("session-a");
    expect(entries[1].sessionId).toBe("session-b");
  });
});

describe("generateSessionId", () => {
  it("generates ID in expected format", () => {
    const id = generateSessionId("TASK-042");
    expect(id).toMatch(/^quack-TASK-042-\d{8}-\d{6}$/);
  });

  it("includes the task ID", () => {
    const id = generateSessionId("TASK-123");
    expect(id).toContain("TASK-123");
  });
});

describe("createNoOpWriter", () => {
  it("returns a writer that implements IEventWriter", () => {
    const writer: IEventWriter = createNoOpWriter();
    expect(writer.sessionId).toBe("noop");
    expect(writer.taskId).toBe("noop");
    expect(writer.project).toBe("noop");
  });

  it("emit does nothing without error", () => {
    const writer = createNoOpWriter();
    expect(() => {
      writer.emit("session_start", { model: "test", maxTurns: 10, maxBudget: 5 });
    }).not.toThrow();
  });

  it("recordSession does nothing without error", () => {
    const writer = createNoOpWriter();
    expect(() => {
      writer.recordSession("active");
      writer.recordSession("completed", { outcome: "approved" });
    }).not.toThrow();
  });

  it("returns the same instance", () => {
    const a = createNoOpWriter();
    const b = createNoOpWriter();
    expect(a).toBe(b);
  });
});

describe("EventWriter durable worktree logging", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-events-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("redirects linked-worktree logs to the primary checkout", () => {
    const primaryRoot = path.join(tempRoot, "project");
    const worktreeRoot = path.join(tempRoot, "worktree");
    const worktreeGitDir = path.join(primaryRoot, ".git", "worktrees", "demo");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const worktreeLogDir = path.join(worktreeRoot, ".quack", "logs");
    const primaryLogDir = path.join(primaryRoot, ".quack", "logs");
    expect(resolveDurableEventLogDir(worktreeLogDir)).toBe(primaryLogDir);

    const writer = new EventWriter({
      sessionId: "session-1",
      taskId: "TASK-1",
      project: "demo",
      logDir: worktreeLogDir,
    });
    writer.emit("session_start", { taskId: "TASK-1" });

    expect(fs.existsSync(path.join(primaryLogDir, "events-session-1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(worktreeLogDir, "events-session-1.jsonl"))).toBe(false);
  });

  test("keeps logs in place for a primary checkout", () => {
    const projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    const logDir = path.join(projectRoot, ".quack", "logs");

    expect(resolveDurableEventLogDir(logDir)).toBe(logDir);
  });
});
