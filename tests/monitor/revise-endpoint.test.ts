import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { reviseCommand } from "../../src/cli/revise";
import * as dispatcher from "../../src/dispatcher/dispatcher";
import type { SessionEntry, QuackEvent } from "../../src/monitor/event-types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-revise-"));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function writeJsonl<T>(filePath: string, entries: T[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeSession(
  sessionId: string,
  taskId: string,
  status: SessionEntry["status"],
  outcome?: string,
): SessionEntry {
  return {
    sessionId,
    taskId,
    project: "test",
    startTime: "2024-01-01T10:00:00.000Z",
    status,
    outcome,
  };
}

function makeJudgeEvent(
  sessionId: string,
  taskId: string,
  verdict: string,
  feedback: string,
): QuackEvent {
  return {
    sessionId,
    taskId,
    project: "test",
    timestamp: "2024-01-01T10:05:00.000Z",
    stage: "judge_result",
    payload: {
      verdict,
      confidence: 0.9,
      feedback,
      scopeViolations: [],
      criteriaGaps: [],
      qualityIssues: [],
    },
  };
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe("POST /api/tasks/:id/revise", () => {
  let logDir: string;
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;
  let startSpy: jest.SpiedFunction<DispatchManager["start"]>;

  function startedOptions(): NonNullable<Parameters<DispatchManager["start"]>[1]> {
    expect(startSpy).toHaveBeenCalledTimes(1);
    const options = startSpy.mock.calls[0]?.[1];
    if (!options) throw new Error("DispatchManager.start options were not captured");
    return options;
  }

  beforeEach(() => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();

    // Create task dir with a sample task
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });

    fs.writeFileSync(
      path.join(taskDir, "TASK-042-test.md"),
      [
        "# TASK-042: Test Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2-4 hours",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** test",
        "",
        "## Problem Statement",
        "Test problem",
        "",
        "## Success Criteria",
        "- Criterion 1",
        "",
        "## Testing Requirements",
        "- Test it",
      ].join("\n"),
      "utf-8",
    );

    // Create .quack dir with adapter.json
    const quackDir = path.join(projectRoot, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: {
          name: "test",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: ".quack",
        },
        agent: { model: "claude-sonnet-4-6", maxTurns: 100, maxBudgetPerTask: 8 },
        verification: {
          commands: [{ name: "test", command: "npm test", required: true, timeout: 60_000 }],
          conventionChecks: [],
        },
        sandbox: {
          writablePaths: ["src/", "tests/"],
          deniedPaths: [],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "",
          autoCreatePr: false,
          autoPush: false,
        },
        logging: { dir: logDir, level: "debug", retainDays: 30 },
        revision: { maxBudget: 1.5, maxTurns: 30 },
      }),
      "utf-8",
    );
    startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-042",
      sessionId: "revision-session",
      pid: 12345,
      startedAt: "2026-08-18T12:00:00.000Z",
      status: "running",
      output: [],
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    // Small delay to let Windows release file handles (chokidar, server)
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* best-effort cleanup */
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("returns 404 for unknown task", async () => {
    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    // TASK-999 does not exist in the task dir
    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-999/revise`, {
      feedback: "Fix the bug",
    });

    expect(status).toBe(404);
    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("not found");
  });

  it("both doors reject an unparseable task before persisted revision writes", async () => {
    const taskPath = path.join(projectRoot, "docs", "tasks", "TASK-042-test.md");
    const invalidSpec = fs
      .readFileSync(taskPath, "utf-8")
      .replace("- **Status:** READY", "- **Status:** READY\n- **Execution Mode:** unsafe-loop");
    fs.writeFileSync(taskPath, invalidSpec, "utf-8");

    const checkpointPath = path.join(logDir, "checkpoint-TASK-042.json");
    const originalCheckpoint = JSON.stringify({ sentinel: "untouched" });
    fs.writeFileSync(checkpointPath, originalCheckpoint, "utf-8");
    const dispatchSpy = jest.spyOn(dispatcher, "dispatchTask");
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await reviseCommand("TASK-042", { project: projectRoot, feedback: "Retry" });

    expect(errorSpy).toHaveBeenCalledWith("Error: Task TASK-042 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(checkpointPath, "utf-8")).toBe(originalCheckpoint);
    expect(fs.existsSync(path.join(logDir, "sessions.jsonl"))).toBe(false);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    dispatchSpy.mockRestore();

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
    const response = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Retry",
    });

    expect(response.status).toBe(404);
    expect(fs.readFileSync(checkpointPath, "utf-8")).toBe(originalCheckpoint);
    expect(fs.existsSync(path.join(logDir, "sessions.jsonl"))).toBe(false);
  });

  it("CLI refuses a durable active session without a monitor", async () => {
    writeJsonl(path.join(logDir, "sessions.jsonl"), [makeSession("active", "TASK-042", "active")]);
    const dispatchSpy = jest.spyOn(dispatcher, "dispatchTask");
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await reviseCommand("TASK-042", { project: projectRoot, feedback: "Retry" });

    expect(errorSpy).toHaveBeenCalledWith("Error: Task TASK-042 is already running");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when task has no prior runs", async () => {
    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix the bug",
    });

    expect(status).toBe(400);
    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("no prior runs");
  });

  it("returns 409 if task is currently running", async () => {
    // Create a session so task has "prior runs"
    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);
    fs.writeFileSync(path.join(logDir, "events-s1.jsonl"), "", "utf-8");

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    jest.spyOn(DispatchManager.prototype, "getJob").mockReturnValue({
      taskId: "TASK-042",
      sessionId: "active-session",
      pid: 12345,
      startedAt: "2026-08-18T12:00:00.000Z",
      status: "running",
      output: [],
    });

    // Now try to revise — should be 409
    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix it",
    });

    expect(status).toBe(409);
    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("already running");
  });

  it("dispatches revision with judgeFeedback and skipGate when task has prior runs", async () => {
    // Create session + judge event
    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

    const events = [makeJudgeEvent("s1", "TASK-042", "REVISE", "Missing integration in server.ts")];
    writeJsonl(path.join(logDir, "events-s1.jsonl"), events);

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix the integration wiring",
    });

    expect(status).toBe(200);
    const data = JSON.parse(body) as { ok: boolean; sessionId: string };
    expect(data.ok).toBe(true);
    expect(data.sessionId).toBeTruthy();
    expect(startedOptions()).toMatchObject({
      judgeFeedback:
        "Missing integration in server.ts\n\n---\n\n## Human Revision Feedback\n\nFix the integration wiring",
      skipGate: true,
      reuseWorktree: true,
    });

    // Stop the dispatch
    await httpPost(`http://localhost:${port}/api/tasks/TASK-042/stop`);
  });

  it("uses adapter revision config defaults when no overrides provided", async () => {
    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);
    fs.writeFileSync(path.join(logDir, "events-s1.jsonl"), "", "utf-8");

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
      adapterPath: path.join(projectRoot, ".quack", "adapter.json"),
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    // Dispatch revision — endpoint reads adapter.json revision config
    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix it",
    });

    // If we get 200, the endpoint successfully read the adapter config
    // and dispatched with revision defaults (maxBudget: 1.50, maxTurns: 30)
    expect(status).toBe(200);
    const data = JSON.parse(body) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(startedOptions()).toMatchObject({ maxBudget: 1.5, maxTurns: 30 });

    await httpPost(`http://localhost:${port}/api/tasks/TASK-042/stop`);
  });

  it("respects maxBudget and maxTurns overrides", async () => {
    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);
    fs.writeFileSync(path.join(logDir, "events-s1.jsonl"), "", "utf-8");

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix it",
      maxBudget: 5.0,
      maxTurns: 100,
    });

    expect(status).toBe(200);
    const data = JSON.parse(body) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(startedOptions()).toMatchObject({ maxBudget: 5, maxTurns: 100 });

    await httpPost(`http://localhost:${port}/api/tasks/TASK-042/stop`);
  });

  it("merges human feedback with last judge feedback", async () => {
    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

    const events = [makeJudgeEvent("s1", "TASK-042", "REVISE", "Judge says: missing tests")];
    writeJsonl(path.join(logDir, "events-s1.jsonl"), events);

    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    // The endpoint merges judge feedback + human feedback.
    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Also fix the linting",
    });

    expect(status).toBe(200);
    const data = JSON.parse(body) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(startedOptions().judgeFeedback).toBe(
      "Judge says: missing tests\n\n---\n\n## Human Revision Feedback\n\nAlso fix the linting",
    );

    await httpPost(`http://localhost:${port}/api/tasks/TASK-042/stop`);
  });

  it("ignores a newer diagnostic when selecting execution judge feedback", async () => {
    const execution = {
      ...makeSession("execution", "TASK-042", "completed", "rejected"),
      startTime: "2026-08-18T10:00:00.000Z",
    };
    const diagnostic = {
      ...makeSession(
        "quack-diagnostic-claimant-task-042-kind",
        "TASK-042",
        "completed",
        "claimant_diagnostic",
      ),
      startTime: "2026-08-18T11:00:00.000Z",
    };
    writeJsonl(path.join(logDir, "sessions.jsonl"), [execution, diagnostic]);
    writeJsonl(path.join(logDir, "events-execution.jsonl"), [
      makeJudgeEvent("execution", "TASK-042", "REVISE", "execution judge feedback"),
    ]);
    writeJsonl(path.join(logDir, `events-${diagnostic.sessionId}.jsonl`), []);
    startSpy.mockClear();
    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot, taskDir: "docs/tasks" });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "human feedback",
    });

    expect(status).toBe(200);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toBe("TASK-042");
    expect(startSpy.mock.calls[0]?.[1]?.judgeFeedback).toContain("execution judge feedback");
  });

  it("leaves identical durable revision state through the CLI and HTTP doors", async () => {
    const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
    const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>;
    adapter.executionMode = "loop";
    fs.writeFileSync(adapterPath, JSON.stringify(adapter), "utf-8");

    const sessions = [makeSession("s1", "TASK-042", "completed", "rejected")];
    const events = [makeJudgeEvent("s1", "TASK-042", "REVISE", "Judge feedback")];
    const checkpoint = {
      taskId: "TASK-042",
      sessionId: "s1",
      claudeSessionId: "claude-session-1",
      branchName: "quack/TASK-042-test",
      completedStages: [
        "gate",
        "blueprint",
        "approve",
        "branch",
        "context",
        "agent",
        "commit",
        "judge_review",
        "judge",
      ],
      agentResult: { success: true },
      gitDiff: "diff --git a/a.ts b/a.ts",
      outputSnapshots: [{ attempt: 1 }],
      judgeResult: { verdict: "REVISE" },
      retriesUsed: 2,
      totalCostUsd: 3.5,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const approval = {
      taskId: "TASK-042",
      state: "rejected",
      createdAt: new Date().toISOString(),
      review: {
        status: "completed",
        verdict: "AMEND",
        findings: [{ severity: "should_fix", summary: "Keep the retry focused" }],
        summary: "The first attempt is close.",
        rawText: "review",
        runner: "codex-cli",
        durationMs: 10,
      },
    };
    const checkpointPath = path.join(logDir, "checkpoint-TASK-042.json");
    const approvalDir = path.join(logDir, "approvals");
    const approvalPath = path.join(approvalDir, "TASK-042-judge.json");
    fs.mkdirSync(approvalDir, { recursive: true });
    const resetDurableState = (): void => {
      writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);
      writeJsonl(path.join(logDir, "events-s1.jsonl"), events);
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");
      fs.writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf-8");
    };
    const snapshotDurableState = (): { checkpoint: Record<string, unknown>; sessions: string } => {
      const persisted = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as Record<
        string,
        unknown
      >;
      delete persisted.updatedAt;
      expect(fs.existsSync(approvalPath)).toBe(false);
      return {
        checkpoint: persisted,
        sessions: fs.readFileSync(path.join(logDir, "sessions.jsonl"), "utf-8"),
      };
    };

    resetDurableState();
    const dispatchSpy = jest.spyOn(dispatcher, "dispatchTask").mockResolvedValue({
      taskId: "TASK-042",
      outcome: "approved",
      retriesUsed: 0,
    });
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await reviseCommand("TASK-042", { project: projectRoot, feedback: "Human feedback" });
    const cliState = snapshotDurableState();
    const cliOptions = dispatchSpy.mock.calls[0]?.[2];
    expect(cliOptions?.skipGate).toBe(true);
    expect(cliOptions?.resumeFromCheckpoint).toBe(true);
    expect(cliOptions?.admittedTaskContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(exitSpy).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
    exitSpy.mockRestore();
    dispatchSpy.mockRestore();

    resetDurableState();
    startSpy.mockClear();
    const port = await freePort();
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
      adapterPath,
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
    const response = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Human feedback",
    });

    expect(response.status).toBe(200);
    const httpState = snapshotDurableState();
    expect(httpState).toEqual(cliState);
    expect(startedOptions()).toMatchObject({
      judgeFeedback: cliOptions?.retryFeedback,
      skipGate: true,
      reuseWorktree: true,
      resume: true,
    });
  });

  it("returns 500 when dispatch service not available", async () => {
    // Start server without projectRoot — no dispatch manager
    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-042/revise`, {
      feedback: "Fix it",
    });

    expect(status).toBe(500);
    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("not available");
  });
});
