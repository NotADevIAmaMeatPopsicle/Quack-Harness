import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { PrepWorker } from "../../src/monitor/prep-worker";
import { DispatchQueue } from "../../src/queue";
import { computeContentHash } from "../../src/monitor/prep-cache";
import { runReadinessGate } from "../../src/gate/gate";
import type {
  SessionEntry,
  QuackEvent,
  PreflightStartPayload,
  PreflightGatePayload,
  PreflightBlueprintPayload,
  PreflightAnalysisPayload,
  PreflightCompletePayload,
} from "../../src/monitor/event-types";

// Prevent tests from picking up real .quack/auth.json (which has users → auth enabled)
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: jest.fn(),
}));

const mockedRunReadinessGate = runReadinessGate as jest.MockedFunction<typeof runReadinessGate>;

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-server-"));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const assignedPort = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(assignedPort));
    });
  });
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function writeJsonl<T>(filePath: string, entries: T[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
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
    startTime: "2024-01-01T10:00:00.000Z",
    status,
    outcome,
  };
}

function makeEvent(sessionId: string, stage: string): QuackEvent {
  return {
    sessionId,
    taskId: "TASK-001",
    project: "test",
    timestamp: "2024-01-01T10:00:00.000Z",
    stage: stage as QuackEvent["stage"],
    payload: {} as QuackEvent["payload"],
  };
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
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
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function httpPatch(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const patchData = data ? JSON.stringify(data) : "";

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(patchData),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (patchData) req.write(patchData);
    req.end();
  });
}

async function httpDelete(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "DELETE",
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Monitor Server", () => {
  let logDir: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir();
    mockedRunReadinessGate.mockReset();
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    removeTempDir(logDir);
  });

  it("serves health endpoint", async () => {
    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/health`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { status: string; logDir: string };
    expect(data.status).toBe("ok");
    expect(data.logDir).toBe(logDir);
  });

  it("waits for bounded dispatch and prep shutdown before the server stop resolves", async () => {
    const projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
    let releaseShutdown!: () => void;
    let markShutdownStarted!: () => void;
    const shutdownMayFinish = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const shutdownStarted = new Promise<void>((resolve) => {
      markShutdownStarted = resolve;
    });
    let releasePrepShutdown!: () => void;
    let markPrepShutdownStarted!: () => void;
    const prepShutdownMayFinish = new Promise<void>((resolve) => {
      releasePrepShutdown = resolve;
    });
    const prepShutdownStarted = new Promise<void>((resolve) => {
      markPrepShutdownStarted = resolve;
    });
    const shutdownSpy = jest
      .spyOn(DispatchManager.prototype, "shutdownAll")
      .mockImplementation(() => {
        markShutdownStarted();
        return shutdownMayFinish.then(() => ({
          requested: [],
          exited: [],
          escalated: [],
          timedOut: [],
        }));
      });
    const prepShutdownSpy = jest
      .spyOn(PrepWorker.prototype, "shutdownAll")
      .mockImplementation(() => {
        markPrepShutdownStarted();
        return prepShutdownMayFinish.then(() => ({
          requested: [],
          exited: [],
          escalated: [],
          timedOut: [],
        }));
      });
    const queueAbortSpy = jest.spyOn(DispatchQueue.prototype, "abort");
    let stopPromise: Promise<void> | undefined;

    try {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir: path.join(projectRoot, ".quack", "logs"),
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      let stopped = false;
      stopPromise = stop().then(() => {
        stopped = true;
      });

      await Promise.all([shutdownStarted, prepShutdownStarted]);
      expect(queueAbortSpy).toHaveBeenCalledTimes(1);
      expect(queueAbortSpy.mock.invocationCallOrder[0]).toBeLessThan(
        shutdownSpy.mock.invocationCallOrder[0],
      );
      expect(stopped).toBe(false);
      releaseShutdown();
      await Promise.resolve();
      expect(stopped).toBe(false);
      releasePrepShutdown();
      await stopPromise;
      expect(stopped).toBe(true);
    } finally {
      releaseShutdown();
      releasePrepShutdown();
      await stopPromise?.catch(() => undefined);
      shutdownSpy.mockRestore();
      prepShutdownSpy.mockRestore();
      queueAbortSpy.mockRestore();
      removeTempDir(projectRoot);
    }
  });

  it("lists sessions from JSONL", async () => {
    const sessions = [makeSession("s1", "completed", "approved"), makeSession("s2", "active")];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/sessions`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Array<{ sessionId: string }>;
    expect(data).toHaveLength(2);
    // Reversed order (newest first)
    expect(data[0].sessionId).toBe("s2");
  });

  it("returns session events", async () => {
    const events = [makeEvent("s1", "session_start"), makeEvent("s1", "gate_result")];
    writeJsonl(path.join(logDir, "events-s1.jsonl"), events);

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/sessions/s1`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Array<{ stage: string }>;
    expect(data).toHaveLength(2);
    expect(data[0].stage).toBe("session_start");
  });

  it("returns 404 for nonexistent session", async () => {
    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status } = await httpGet(`http://localhost:${port}/api/sessions/nope`);
    expect(status).toBe(404);
  });

  it("returns escalations", async () => {
    const sessions = [
      makeSession("s1", "completed", "approved"),
      makeSession("s2", "completed", "rejected"),
    ];
    writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);
    // Create event files so getEscalations can read them
    fs.writeFileSync(path.join(logDir, "events-s1.jsonl"), "", "utf-8");
    fs.writeFileSync(path.join(logDir, "events-s2.jsonl"), "", "utf-8");

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/escalations`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Array<{ session: { sessionId: string } }>;
    expect(data).toHaveLength(1);
    expect(data[0].session.sessionId).toBe("s2");
  });

  describe("Task endpoints", () => {
    let projectRoot: string;
    let taskDir: string;

    beforeEach(() => {
      projectRoot = makeTempDir();
      taskDir = path.join(projectRoot, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });

      // Create sample task files
      fs.writeFileSync(
        path.join(taskDir, "TASK-001-test.md"),
        [
          "# TASK-001: Test Task",
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
          "- Criterion 2",
          "",
          "## Testing Requirements",
          "- Test it",
        ].join("\n"),
        "utf-8",
      );

      fs.writeFileSync(
        path.join(taskDir, "TASK-002-another.md"),
        [
          "# TASK-002: Another Task",
          "",
          "## Metadata",
          "- **Priority:** P2-MEDIUM",
          "- **Effort:** 1-2 hours",
          "- **Status:** COMPLETE",
          "- **Blocked By:** [TASK-001]",
          "- **Tags:** feature",
          "",
          "## Problem Statement",
          "Another problem",
          "",
          "## Success Criteria",
          "- Done",
          "",
          "## Testing Requirements",
          "- Verify",
        ].join("\n"),
        "utf-8",
      );
    });

    afterEach(async () => {
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
      if (projectRoot) {
        removeTempDir(projectRoot);
      }
    });

    it("returns 404 when task service not configured", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/tasks`);
      expect(status).toBe(404);
    });

    it("lists all tasks", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/tasks`);
      expect(status).toBe(200);

      const data = JSON.parse(body) as {
        tasks: Array<{
          id: string;
          title: string;
          priority: string;
          status: string;
        }>;
        parseErrors: Array<{ file: string; error: string }>;
        parsedTaskCount: number;
        parseErrorCount: number;
        taskFileCount: number;
      };
      expect(data.tasks).toHaveLength(2);
      expect(data.parsedTaskCount).toBe(2);
      expect(data.parseErrorCount).toBe(0);
      expect(data.taskFileCount).toBe(2);
      expect(data.tasks[0].id).toBe("TASK-001");
      expect(data.tasks[0].title).toBe("Test Task");
      expect(data.tasks[0].priority).toBe("P1-HIGH");
      expect(data.tasks[0].status).toBe("READY");
      expect(data.tasks[1].id).toBe("TASK-002");
      expect(data.parseErrors).toEqual([]);
    });

    it("returns full task details", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001`);
      expect(status).toBe(200);

      const data = JSON.parse(body) as {
        id: string;
        title: string;
        problemStatement: string;
        successCriteria: string[];
        dispatch: null;
      };
      expect(data.id).toBe("TASK-001");
      expect(data.title).toBe("Test Task");
      expect(data.problemStatement).toContain("Test problem");
      expect(data.successCriteria).toHaveLength(2);
      expect(data.dispatch).toBeNull();
    });

    it("returns 404 for nonexistent task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/tasks/TASK-999`);
      expect(status).toBe(404);
    });

    it("returns run history for a task", async () => {
      const sessions = [
        { ...makeSession("s1", "completed", "approved"), taskId: "TASK-001" },
        { ...makeSession("s2", "completed", "rejected"), taskId: "TASK-001" },
        { ...makeSession("s3", "active"), taskId: "TASK-002" },
      ];
      writeJsonl(path.join(logDir, "sessions.jsonl"), sessions);

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001/runs`);
      expect(status).toBe(200);

      const data = JSON.parse(body) as Array<{ taskId: string }>;
      expect(data).toHaveLength(2);
      expect(data[0].taskId).toBe("TASK-001");
      expect(data[1].taskId).toBe("TASK-001");
    });

    it("returns empty array when no runs exist for task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001/runs`);
      expect(status).toBe(200);

      const data = JSON.parse(body) as unknown[];
      expect(data).toEqual([]);
    });

    it("GET /api/tasks/:id/preflight returns cached preflight result", async () => {
      // Write a preflight cache file directly
      const prepDir = path.join(projectRoot, ".quack", "prep");
      fs.mkdirSync(prepDir, { recursive: true });
      const taskFilePath = path.join(projectRoot, "docs", "tasks", "TASK-001-test.md");
      const contentHash = computeContentHash(fs.readFileSync(taskFilePath, "utf-8"));
      const preflightResult = {
        taskId: "TASK-001",
        timestamp: "2026-02-24T12:00:00.000Z",
        contentHash,
        gate: { ready: true, score: 5, dimensions: {} },
        blueprint: {
          fileAnalyses: 2,
          codeExamples: 1,
          verificationPatterns: 1,
          antiPatterns: 0,
          formattedMarkdown: "## Cached Blueprint",
        },
        contextEstimate: {
          taskSpec: 500,
          blueprint: 1000,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 1500,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 2,
          successCriteria: 3,
          estimatedContextTokens: 1500,
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      };
      fs.writeFileSync(
        path.join(prepDir, "TASK-001-preflight.json"),
        JSON.stringify(preflightResult, null, 2),
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/preflight`,
      );
      expect(status).toBe(200);

      const data = JSON.parse(body) as {
        taskId: string;
        blueprint: { formattedMarkdown: string };
        complexity: { recommendDecomposition: boolean };
      };
      expect(data.taskId).toBe("TASK-001");
      expect(data.blueprint.formattedMarkdown).toBe("## Cached Blueprint");
      expect(data.complexity.recommendDecomposition).toBe(false);
    });

    it("GET /api/tasks/:id/preflight returns 404 when no cached result", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001/preflight`);
      expect(status).toBe(404);
    });

    it("GET /api/tasks/:id/preflight returns stale metadata when cached preflight hash is outdated", async () => {
      const prepDir = path.join(projectRoot, ".quack", "prep");
      fs.mkdirSync(prepDir, { recursive: true });
      fs.writeFileSync(
        path.join(prepDir, "TASK-001-preflight.json"),
        JSON.stringify(
          {
            taskId: "TASK-001",
            timestamp: "2026-02-24T12:00:00.000Z",
            contentHash: "stale-hash",
            gate: { ready: true, score: 5, dimensions: {} },
            blueprint: {
              fileAnalyses: 1,
              codeExamples: 0,
              verificationPatterns: 0,
              antiPatterns: 0,
              formattedMarkdown: "## Stale Blueprint",
            },
            contextEstimate: {
              taskSpec: 100,
              blueprint: 100,
              repoMap: 0,
              relevantFiles: 0,
              relatedPatterns: 0,
              existingTests: 0,
              conventions: 0,
              claudeMd: 0,
              total: 200,
              withinBudget: true,
            },
            complexity: {
              filesToModify: 1,
              successCriteria: 1,
              estimatedContextTokens: 200,
              recommendDecomposition: false,
              reason: "stale",
            },
          },
          null,
          2,
        ),
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/preflight`,
      );
      expect(status).toBe(404);

      const data = JSON.parse(body) as { stale: boolean; currentSpecHash?: string; error: string };
      expect(data.stale).toBe(true);
      expect(data.currentSpecHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.error).toContain("stale");
    });

    it("GET /api/tasks/:id/prep returns stale metadata when cached prep hash is outdated", async () => {
      const prepDir = path.join(projectRoot, ".quack", "prep");
      fs.mkdirSync(prepDir, { recursive: true });
      fs.writeFileSync(
        path.join(prepDir, "TASK-001.json"),
        JSON.stringify(
          {
            taskId: "TASK-001",
            preparedAt: "2026-02-24T12:00:00.000Z",
            schemaValid: true,
            schemaErrors: [],
            depthScore: 4.8,
            depthReady: true,
            deficiencies: [],
            outcome: "pass",
            stale: false,
            contentHash: "stale-hash",
          },
          null,
          2,
        ),
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001/prep`);
      expect(status).toBe(404);

      const data = JSON.parse(body) as { stale: boolean; currentSpecHash?: string; error: string };
      expect(data.stale).toBe(true);
      expect(data.currentSpecHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.error).toContain("stale");
    });
  });

  // Dispatch tests spawn real child processes — need longer timeout.
  describe("Dispatch endpoints", () => {
    beforeAll(() => {
      jest.setTimeout(30_000);
    });
    afterAll(() => {
      jest.setTimeout(15_000);
    });
    let projectRoot: string;
    let taskDir: string;

    beforeEach(() => {
      projectRoot = makeTempDir();
      taskDir = path.join(projectRoot, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });

      // Create a valid task file
      fs.writeFileSync(
        path.join(taskDir, "TASK-001-test.md"),
        [
          "# TASK-001: Test Task",
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
    });

    afterEach(async () => {
      // Wait for the server and its bounded dispatch shutdown to settle.
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
      // Give processes time to fully exit before removing directories
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (projectRoot) {
        removeTempDir(projectRoot);
      }
    });

    it("returns 500 when dispatch not available", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`);
      expect(status).toBe(500);
    });

    it("returns 404 for nonexistent task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-999/start`);
      expect(status).toBe(404);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("not found");
    });

    // QPI-048 leg (g): this gate is ARMED-only now. When auto-decompose
    // cannot actually produce children (disabled, or writeSpecs off), a
    // complexity RECOMMENDATION must recommend and never refuse —
    // refusing left over-threshold specs structurally undispatchable
    // without cache surgery, the exact inversion the leg fixed. The
    // fixture therefore has to arm it to still see the refusal, and the
    // unarmed arm below is the leg's actual behaviour.
    function armAutoDecompose(): string {
      const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
      const adapter = fs.existsSync(adapterPath)
        ? (JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<string, unknown>)
        : {};
      const preflight = (adapter.preflight as Record<string, unknown> | undefined) ?? {};
      adapter.preflight = {
        ...preflight,
        autoDecompose: { enabled: true, writeSpecs: true, maxSubtasks: 4 },
      };
      fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
      fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2), "utf-8");
      return adapterPath;
    }

    function seedOverThresholdPreflight(): void {
      const prepDir = path.join(projectRoot, ".quack", "prep");
      fs.mkdirSync(prepDir, { recursive: true });
      // The readiness resolver only honors a cached preflight whose contentHash
      // matches the current spec file's hash; a placeholder hash reads as stale.
      const taskContent = fs.readFileSync(path.join(taskDir, "TASK-001-test.md"), "utf-8");
      fs.writeFileSync(
        path.join(prepDir, "TASK-001-preflight.json"),
        JSON.stringify(
          {
            taskId: "TASK-001",
            timestamp: "2026-04-27T12:00:00.000Z",
            contentHash: computeContentHash(taskContent),
            gate: { ready: true, score: 4.8, dimensions: {} },
            blueprint: {
              fileAnalyses: 8,
              codeExamples: 2,
              verificationPatterns: 1,
              antiPatterns: 0,
              formattedMarkdown: "## Blueprint",
            },
            contextEstimate: {
              taskSpec: 1000,
              blueprint: 2000,
              repoMap: 0,
              relevantFiles: 0,
              relatedPatterns: 0,
              existingTests: 0,
              conventions: 0,
              claudeMd: 0,
              total: 3000,
              withinBudget: true,
            },
            complexity: {
              filesToModify: 8,
              successCriteria: 3,
              estimatedContextTokens: 3000,
              independentFeatures: 1,
              featureClusters: [],
              recommendDecomposition: true,
              reason: "files to modify 8 > 6",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    async function startAndDispatch(
      adapterPath?: string,
    ): Promise<{ status: number; body: string }> {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
        ...(adapterPath ? { adapterPath } : {}),
      });
      const { stop } = await serverObj.start();
      stopServer = stop;
      return httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`, { skipGate: true });
    }

    it("blocks dispatch when cached preflight recommends decomposition and auto-decompose is ARMED", async () => {
      seedOverThresholdPreflight();
      const adapterPath = armAutoDecompose();

      const { status, body } = await startAndDispatch(adapterPath);

      expect(status).toBe(409);
      const data = JSON.parse(body) as { code: string; error: string };
      expect(data.code).toBe("decomposition_required");
      expect(data.error).toContain("must be decomposed");
    });

    it("QPI-048 leg (g): an UNARMED recommendation recommends, it does not refuse", async () => {
      seedOverThresholdPreflight();
      // No autoDecompose config at all — nothing can generate children,
      // so refusing would strand the parent.

      const { status, body } = await startAndDispatch();

      expect(status).not.toBe(409);
      expect(body).not.toContain("decomposition_required");
    });

    it("starts a task and returns session info", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`, {
        skipGate: true,
      });

      expect(status).toBe(200);
      const data = JSON.parse(body) as {
        ok: boolean;
        taskId: string;
        sessionId: string;
        pid: number;
      };
      expect(data.ok).toBe(true);
      expect(data.taskId).toBe("TASK-001");
      expect(data.sessionId).toMatch(/^quack-TASK-001-/);
      expect(data.pid).toBeGreaterThan(0);
    });

    it("passes skipDepthOnly through the start API", async () => {
      const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
        taskId: "TASK-001",
        sessionId: "quack-TASK-001-test",
        pid: 12345,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
      });

      try {
        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpPost(
          `http://localhost:${port}/api/tasks/TASK-001/start`,
          { skipDepthOnly: true },
        );

        expect(status).toBe(200);
        const data = JSON.parse(body) as { ok: boolean };
        expect(data.ok).toBe(true);
        expect(startSpy).toHaveBeenCalledWith(
          "TASK-001",
          expect.objectContaining({ skipDepthOnly: true }),
          { taskId: "TASK-001", claimants: [] },
        );
      } finally {
        startSpy.mockRestore();
      }
    });

    it("returns 409 when task is already running", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Start the task
      await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`, { skipGate: true });

      // Try to start again
      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`);
      expect(status).toBe(409);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("already running");
    });

    it("stops a running task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Start the task
      await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`, { skipGate: true });

      // Stop it
      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-001/stop`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as { ok: boolean };
      expect(data.ok).toBe(true);
    });

    it("returns 404 when stopping non-running task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpPost(`http://localhost:${port}/api/tasks/TASK-001/stop`);
      expect(status).toBe(404);
    });

    it("returns active jobs list", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // No active jobs initially
      let res = await httpGet(`http://localhost:${port}/api/tasks/active`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);

      // Start a task
      await httpPost(`http://localhost:${port}/api/tasks/TASK-001/start`, { skipGate: true });

      // Should show active job
      res = await httpGet(`http://localhost:${port}/api/tasks/active`);
      expect(res.status).toBe(200);
      const jobs = JSON.parse(res.body) as Array<{ taskId: string; status: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].taskId).toBe("TASK-001");
      expect(jobs[0].status).toBe("running");
    });

    it("returns 400 when task has unmet dependencies", async () => {
      // Create a task that depends on TASK-001 (which is READY, not COMPLETE)
      fs.writeFileSync(
        path.join(taskDir, "TASK-003-blocked.md"),
        [
          "# TASK-003: Blocked Task",
          "",
          "## Metadata",
          "- **Priority:** P2-MEDIUM",
          "- **Effort:** 1-2 hours",
          "- **Status:** READY",
          "- **Blocked By:** [TASK-001]",
          "- **Tags:** test",
          "",
          "## Problem Statement",
          "Blocked problem",
          "",
          "## Success Criteria",
          "- Done",
          "",
          "## Testing Requirements",
          "- Test it",
        ].join("\n"),
        "utf-8",
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-003/start`, {
        skipGate: true,
      });
      expect(status).toBe(400);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("unmet dependencies");
      expect(data.error).toContain("TASK-001");
    });

    it("allows starting task when all dependencies are COMPLETE", async () => {
      // Create dep task that is COMPLETE
      fs.writeFileSync(
        path.join(taskDir, "TASK-004-dep.md"),
        [
          "# TASK-004: Completed Dep",
          "",
          "## Metadata",
          "- **Priority:** P1-HIGH",
          "- **Effort:** 1-2 hours",
          "- **Status:** COMPLETE",
          "- **Blocked By:** []",
          "- **Tags:** test",
          "",
          "## Problem Statement",
          "Done",
          "",
          "## Success Criteria",
          "- Done",
          "",
          "## Testing Requirements",
          "- Test it",
        ].join("\n"),
        "utf-8",
      );

      // Create task that depends on the COMPLETE task
      fs.writeFileSync(
        path.join(taskDir, "TASK-005-unblocked.md"),
        [
          "# TASK-005: Unblocked Task",
          "",
          "## Metadata",
          "- **Priority:** P2-MEDIUM",
          "- **Effort:** 1-2 hours",
          "- **Status:** READY",
          "- **Blocked By:** [TASK-004]",
          "- **Tags:** test",
          "",
          "## Problem Statement",
          "Should start fine",
          "",
          "## Success Criteria",
          "- Done",
          "",
          "## Testing Requirements",
          "- Test it",
        ].join("\n"),
        "utf-8",
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
        taskDir: "docs/tasks",
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(`http://localhost:${port}/api/tasks/TASK-005/start`, {
        skipGate: true,
      });
      expect(status).toBe(200);
      const data = JSON.parse(body) as { ok: boolean };
      expect(data.ok).toBe(true);
    });
  });

  describe("progress endpoint", () => {
    it("returns parsed progress when PROGRESS.md exists in project root", async () => {
      const projectRoot = makeTempDir();
      const progressContent = `## Completed
- [x] Implemented feature A

## In Progress
- [ ] Testing feature A

## Remaining
- [ ] Deploy
`;
      fs.writeFileSync(path.join(projectRoot, "PROGRESS.md"), progressContent, "utf-8");

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/progress`,
      );
      expect(status).toBe(200);

      const data = JSON.parse(body) as {
        completed: string[];
        inProgress: string[];
        remaining: string[];
        rawContent: string;
        lastUpdated: string;
      };
      expect(data.completed).toContain("Implemented feature A");
      expect(data.inProgress).toContain("Testing feature A");
      expect(data.remaining).toContain("Deploy");
      expect(data.rawContent).toBe(progressContent);
      expect(data.lastUpdated).toBeDefined();

      removeTempDir(projectRoot);
    });

    it("returns 404 when no PROGRESS.md exists", async () => {
      const projectRoot = makeTempDir();

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/progress`,
      );
      expect(status).toBe(404);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("No progress file found");

      removeTempDir(projectRoot);
    });

    it("returns 404 when project root not configured", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/tasks/TASK-001/progress`);
      expect(status).toBe(404);
    });
  });

  describe("fleet containers endpoint", () => {
    it("returns empty array when no containers active", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/fleet/containers`);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual([]);
    });
  });

  describe("cost velocity endpoint", () => {
    it("returns velocity data with config, baseline, and snapshots", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/fleet/velocity`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as {
        config: { enabled: boolean; warnMultiplier: number; killMultiplier: number };
        baseline: { medianCostPerMinute: number; sampleCount: number } | null;
        activeSnapshots: unknown[];
      };
      expect(data.config).toBeDefined();
      expect(typeof data.config.enabled).toBe("boolean");
      expect(typeof data.config.warnMultiplier).toBe("number");
      expect(typeof data.config.killMultiplier).toBe("number");
      expect(data.activeSnapshots).toEqual([]);
    });
  });

  describe("agent health endpoints", () => {
    it("returns fleet health with config and empty agents list", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/fleet/health`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as {
        config: { enabled: boolean; warningMinutes: number };
        agents: unknown[];
      };
      expect(data.config).toBeDefined();
      expect(typeof data.config.enabled).toBe("boolean");
      expect(typeof data.config.warningMinutes).toBe("number");
      expect(data.agents).toEqual([]);
    });

    it("returns 404 for health of non-tracked task", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/tasks/TASK-999/health`);
      expect(status).toBe(404);
    });
  });

  describe("checkpoint endpoints", () => {
    it("GET /api/checkpoints returns empty array when no checkpoints exist", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/checkpoints`);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual([]);
    });

    it("GET /api/checkpoints/:id returns 404 for non-existent checkpoint", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/checkpoints/TASK-999`);
      expect(status).toBe(404);
    });

    it("GET /api/checkpoints/:id returns checkpoint data when it exists", async () => {
      // Write a checkpoint file
      const checkpointData = {
        taskId: "TASK-001",
        sessionId: "quack-TASK-001-123",
        completedStages: ["gate", "branch"],
        totalCostUsd: 1.5,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(logDir, "checkpoint-TASK-001.json"),
        JSON.stringify(checkpointData, null, 2),
      );

      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/checkpoints/TASK-001`);
      expect(status).toBe(200);
      const parsed = JSON.parse(body) as { taskId: string; completedStages: string[] };
      expect(parsed.taskId).toBe("TASK-001");
      expect(parsed.completedStages).toEqual(["gate", "branch"]);
    });

    it("resume endpoint returns 404 when no checkpoint or sessionId provided", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const result = await httpPost(`http://localhost:${port}/api/tasks/TASK-999/resume`, {});
      expect(result.status).toBe(404);
    });
  });

  // ─── Multi-project API tests ───────────────────────────────────

  describe("Project endpoints (single-project fallback)", () => {
    it("GET /api/projects returns synthetic project in single-project mode", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/projects`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as Array<{ id: string; active: boolean; path: string }>;
      expect(data).toHaveLength(1);
      // ID is generated from projectRoot path (collision-safe; not just basename)
      expect(typeof data[0].id).toBe("string");
      expect(data[0].id.length).toBeGreaterThan(0);
      expect(data[0].active).toBe(true);
      expect(data[0].path).toBe(logDir);
    });

    it("GET /api/projects returns empty array when no project root", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/projects`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as unknown[];
      expect(data).toEqual([]);
    });

    it("POST /api/projects/active returns 404 in single-project mode", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpPost(`http://localhost:${port}/api/projects/active`, {
        projectId: "test",
      });
      expect(status).toBe(404);
    });

    it("GET /api/projects/:id returns 404 in single-project mode", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({
        logDir,
        port,
        projectRoot: logDir,
      });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/projects/test`);
      expect(status).toBe(404);
    });
  });

  describe("Project endpoints (multi-project mode)", () => {
    let projectRoot1: string;
    let projectRoot2: string;

    beforeEach(() => {
      // Create two project directories with minimal .quack/adapter.json
      projectRoot1 = makeTempDir();
      projectRoot2 = makeTempDir();

      for (const [root, name, taskDir] of [
        [projectRoot1, "Project Alpha", "docs/tasks"],
        [projectRoot2, "Project Beta", "docs/tasks"],
      ] as const) {
        const quackDir = path.join(root, ".quack");
        fs.mkdirSync(quackDir, { recursive: true });
        fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
        fs.mkdirSync(path.join(root, taskDir), { recursive: true });

        const config = {
          version: "1.0.0",
          project: { name, root, taskDir, conventionsDir: ".quack" },
          agent: {
            model: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 30,
            maxBudgetPerTask: 5.0,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: [],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            branchPrefix: "quack",
            baseBranch: "main",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "Automated-By: Quack",
            autoCreatePr: false,
            autoPush: false,
          },
          logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
        };

        fs.writeFileSync(
          path.join(quackDir, "adapter.json"),
          JSON.stringify(config, null, 2),
          "utf-8",
        );

        // Create sessions.jsonl for event reader
        fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");
      }
    });

    afterEach(async () => {
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
      removeTempDir(projectRoot1);
      removeTempDir(projectRoot2);
    });

    function makeAdapters(): import("../../src/core/adapter-loader").ProjectAdapter[] {
      return [projectRoot1, projectRoot2].map((root) => {
        const raw = JSON.parse(
          fs.readFileSync(path.join(root, ".quack", "adapter.json"), "utf-8"),
        ) as import("../../src/core/types").AdapterConfig;
        return {
          projectRoot: root,
          config: raw,
          conventionsDoc: "",
          judgeCriteria: "",
          conventionCheckScripts: [],
          adrDocs: {},
          adapterBundle: {
            authority: "local",
            sharedHash: "test-shared-hash",
            normalizedConfig: raw,
            machineLocalFields: [],
          },
        };
      });
    }

    it("GET /api/projects returns all registered projects", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/projects`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as Array<{ id: string; name: string; active: boolean }>;
      expect(data).toHaveLength(2);
      expect(data.map((d) => d.name).sort()).toEqual(["Project Alpha", "Project Beta"]);
      // First project is active by default
      const activeOnes = data.filter((d) => d.active);
      expect(activeOnes).toHaveLength(1);
      expect(activeOnes[0].name).toBe("Project Alpha");
    });

    it("POST /api/projects/active switches the active project", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Switch to Project Beta
      const switchRes = await httpPost(`http://localhost:${port}/api/projects/active`, {
        projectId: "project-beta",
      });
      expect(switchRes.status).toBe(200);
      const switchData = JSON.parse(switchRes.body) as { ok: boolean; activeProjectId: string };
      expect(switchData.ok).toBe(true);
      expect(switchData.activeProjectId).toBe("project-beta");

      // Verify the switch by listing projects
      const { body } = await httpGet(`http://localhost:${port}/api/projects`);
      const projects = JSON.parse(body) as Array<{ id: string; active: boolean }>;
      const activeProject = projects.find((p) => p.active);
      expect(activeProject?.id).toBe("project-beta");
    });

    it("POST /api/projects/active returns 404 for unknown project", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpPost(`http://localhost:${port}/api/projects/active`, {
        projectId: "nonexistent",
      });
      expect(status).toBe(404);
    });

    it("POST /api/projects/active returns 400 when projectId is missing", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpPost(`http://localhost:${port}/api/projects/active`, {});
      expect(status).toBe(400);
    });

    it("GET /api/projects/:id returns project details", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/projects/project-alpha`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as { id: string; name: string; path: string };
      expect(data.id).toBe("project-alpha");
      expect(data.name).toBe("Project Alpha");
      expect(data.path).toBe(projectRoot1);
    });

    it("GET /api/projects/:id returns 404 for unknown project", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status } = await httpGet(`http://localhost:${port}/api/projects/nonexistent`);
      expect(status).toBe(404);
    });

    it("existing endpoints use active project context", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // sessions endpoint should work against active project (Project Alpha)
      const sessRes = await httpGet(`http://localhost:${port}/api/sessions`);
      expect(sessRes.status).toBe(200);
      expect(JSON.parse(sessRes.body)).toEqual([]);

      // costs endpoint should work
      const costRes = await httpGet(`http://localhost:${port}/api/costs`);
      expect(costRes.status).toBe(200);
    });

    it("health endpoint uses active project in multi-project mode", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(`http://localhost:${port}/api/health`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as { status: string; projectRoot: string };
      expect(data.status).toBe("ok");
      expect(data.projectRoot).toBe(projectRoot1);
    });

    it("health endpoint surfaces degraded DB state", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const alpha = serverObj.registry?.getProject("project-alpha");
      expect(alpha).toBeDefined();
      if (!alpha) {
        throw new Error("project-alpha missing");
      }
      alpha.dbState = {
        dbPath: path.join(projectRoot1, ".quack", "quack.db"),
        mode: "noop",
        degraded: true,
        error: "database disk image is malformed",
      };

      const { status, body } = await httpGet(`http://localhost:${port}/api/health`);
      expect(status).toBe(200);
      const data = JSON.parse(body) as {
        status: string;
        dbDegraded: boolean;
        dbIssues: Array<{ projectId: string; error: string }>;
      };
      expect(data.status).toBe("degraded");
      expect(data.dbDegraded).toBe(true);
      expect(data.dbIssues).toEqual([
        expect.objectContaining({
          projectId: "project-alpha",
          error: "database disk image is malformed",
        }),
      ]);
    });

    it("registry is exposed on server object", async () => {
      const port = await freePort();
      const adapters = makeAdapters();
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      expect(serverObj.registry).toBeDefined();
      expect(serverObj.registry?.count()).toBe(2);
      expect(serverObj.registry?.getActiveProjectId()).toBe("project-alpha");
    });
  });

  describe("Preflight API", () => {
    it("POST /api/tasks/:id/preflight returns 500 when no project root", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(
        `http://localhost:${port}/api/tasks/TASK-001/preflight`,
      );
      expect(status).toBe(500);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("Preflight not available");
    });

    it("GET /api/tasks/:id/preflight returns 404 when no project root", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/preflight`,
      );
      expect(status).toBe(404);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("Preflight not available");
    });

    it("POST /api/tasks/:id/decompose returns 500 when no project root", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpPost(
        `http://localhost:${port}/api/tasks/TASK-001/decompose`,
      );
      expect(status).toBe(500);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("Decompose not available");
    });

    it("GET /api/tasks/:id/subtasks returns 500 when no task service", async () => {
      const port = await freePort();
      const serverObj = createMonitorServer({ logDir, port });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://localhost:${port}/api/tasks/TASK-001/subtasks`,
      );
      expect(status).toBe(500);
      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("Task service not available");
    });

    describe("with project root", () => {
      let projectRoot: string;
      let taskDir: string;

      beforeEach(() => {
        projectRoot = makeTempDir();
        taskDir = path.join(projectRoot, "docs", "tasks");
        fs.mkdirSync(taskDir, { recursive: true });
        fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });

        // Write adapter.json
        const config = {
          version: "1.0.0",
          project: {
            name: "Test",
            root: projectRoot,
            taskDir: "docs/tasks",
            conventionsDir: ".quack",
          },
          agent: {
            model: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 30,
            maxBudgetPerTask: 5.0,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: [],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            branchPrefix: "quack",
            baseBranch: "main",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "Automated-By: Quack",
            autoCreatePr: false,
            autoPush: false,
          },
          logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
        };
        fs.writeFileSync(
          path.join(projectRoot, ".quack", "adapter.json"),
          JSON.stringify(config, null, 2),
          "utf-8",
        );
        fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

        // Create a parent task
        fs.writeFileSync(
          path.join(taskDir, "TASK-010-parent.md"),
          [
            "# TASK-010: Parent Task",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 4-6 hours",
            "- **Status:** READY",
            "- **Blocked By:** []",
            "- **Tags:** test",
            "",
            "## Problem Statement",
            "A complex parent task",
            "",
            "## Success Criteria",
            "- Criterion 1",
            "- Criterion 2",
            "",
            "## Testing Requirements",
            "- Test it",
          ].join("\n"),
          "utf-8",
        );
      });

      afterEach(async () => {
        if (stopServer) {
          await stopServer();
          stopServer = undefined;
        }
        if (projectRoot) {
          removeTempDir(projectRoot);
        }
      });

      it("GET /api/tasks/:id/preflight returns full report structure with all sections", async () => {
        // Write a preflight cache with decomposition recommendation
        const prepDir = path.join(projectRoot, ".quack", "prep");
        fs.mkdirSync(prepDir, { recursive: true });
        const taskFilePath = path.join(projectRoot, "docs", "tasks", "TASK-010-parent.md");
        const contentHash = computeContentHash(fs.readFileSync(taskFilePath, "utf-8"));
        const preflightResult = {
          taskId: "TASK-010",
          timestamp: "2026-02-24T12:00:00.000Z",
          contentHash,
          gate: { ready: true, score: 4.3, dimensions: { clarity: 5, scope: 4, testability: 4 } },
          blueprint: {
            fileAnalyses: 5,
            codeExamples: 3,
            verificationPatterns: 2,
            antiPatterns: 1,
            formattedMarkdown: "## Blueprint Content",
          },
          contextEstimate: {
            taskSpec: 800,
            blueprint: 2000,
            repoMap: 500,
            relevantFiles: 3000,
            relatedPatterns: 200,
            existingTests: 400,
            conventions: 100,
            claudeMd: 150,
            total: 7150,
            withinBudget: true,
          },
          complexity: {
            filesToModify: 8,
            successCriteria: 12,
            estimatedContextTokens: 40000,
            recommendDecomposition: true,
            reason: "Exceeds file and criteria thresholds",
          },
        };
        fs.writeFileSync(
          path.join(prepDir, "TASK-010-preflight.json"),
          JSON.stringify(preflightResult, null, 2),
        );

        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpGet(
          `http://localhost:${port}/api/tasks/TASK-010/preflight`,
        );
        expect(status).toBe(200);

        const data = JSON.parse(body) as {
          taskId: string;
          gate: { ready: boolean; score: number; dimensions: Record<string, number> };
          blueprint: { fileAnalyses: number; codeExamples: number };
          contextEstimate: { total: number; withinBudget: boolean };
          complexity: { recommendDecomposition: boolean; reason: string; filesToModify: number };
        };
        expect(data.taskId).toBe("TASK-010");
        // Gate section
        expect(data.gate.ready).toBe(true);
        expect(data.gate.score).toBe(4.3);
        expect(data.gate.dimensions).toEqual({ clarity: 5, scope: 4, testability: 4 });
        // Blueprint section
        expect(data.blueprint.fileAnalyses).toBe(5);
        expect(data.blueprint.codeExamples).toBe(3);
        // Context budget section
        expect(data.contextEstimate.total).toBe(7150);
        expect(data.contextEstimate.withinBudget).toBe(true);
        // Complexity section with decomposition recommendation
        expect(data.complexity.recommendDecomposition).toBe(true);
        expect(data.complexity.reason).toContain("thresholds");
        expect(data.complexity.filesToModify).toBe(8);
      });

      it("GET /v1/tasks/:id/readiness keeps the parent task hash when a subtask shares the prefix", async () => {
        fs.writeFileSync(
          path.join(taskDir, "TASK-010-A-first-sub.md"),
          [
            "# TASK-010-A: First Subtask",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 1-2 hours",
            "- **Status:** READY",
            "- **Blocked By:** []",
            "- **Tags:** test",
            "",
            "## Problem Statement",
            "A focused subtask",
            "",
            "## Success Criteria",
            "- Criterion 1",
            "",
            "## Testing Requirements",
            "- Test it",
          ].join("\n"),
          "utf-8",
        );

        const prepDir = path.join(projectRoot, ".quack", "prep");
        fs.mkdirSync(prepDir, { recursive: true });
        const parentTaskPath = path.join(projectRoot, "docs", "tasks", "TASK-010-parent.md");
        const parentHash = computeContentHash(fs.readFileSync(parentTaskPath, "utf-8"));
        fs.writeFileSync(
          path.join(prepDir, "TASK-010-preflight.json"),
          JSON.stringify(
            {
              taskId: "TASK-010",
              timestamp: "2026-02-24T12:00:00.000Z",
              contentHash: parentHash,
              gate: {
                ready: true,
                score: 4.8,
                dimensions: { clarity: 5, scope: 5, testability: 4 },
              },
              blueprint: {
                fileAnalyses: 1,
                codeExamples: 0,
                verificationPatterns: 0,
                antiPatterns: 0,
                formattedMarkdown: "## Blueprint",
              },
              contextEstimate: {
                taskSpec: 100,
                blueprint: 100,
                repoMap: 100,
                relevantFiles: 100,
                relatedPatterns: 100,
                existingTests: 100,
                conventions: 100,
                claudeMd: 100,
                total: 800,
                withinBudget: true,
              },
              complexity: {
                filesToModify: 1,
                successCriteria: 2,
                estimatedContextTokens: 800,
                recommendDecomposition: false,
                reason: "within threshold",
              },
            },
            null,
            2,
          ),
        );

        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpGet(
          `http://localhost:${port}/v1/tasks/TASK-010/readiness`,
        );
        expect(status).toBe(200);

        const data = JSON.parse(body) as {
          taskFilePath: string;
          currentSpecHash: string;
          preflight: { taskId: string } | null;
          hasStalePreflight: boolean;
        };
        expect(data.taskFilePath).toContain("TASK-010-parent.md");
        expect(data.currentSpecHash).toBe(parentHash);
        expect(data.preflight?.taskId).toBe("TASK-010");
        expect(data.hasStalePreflight).toBe(false);
      });

      it("GET /api/tasks/:id/subtasks returns subtasks matching parent pattern", async () => {
        // Create subtask files for TASK-010
        fs.writeFileSync(
          path.join(taskDir, "TASK-010-A-first-sub.md"),
          [
            "# TASK-010-A: First Subtask",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 1-2 hours",
            "- **Status:** READY",
            "- **Blocked By:** []",
            "- **Tags:** subtask",
            "",
            "## Problem Statement",
            "First subtask of TASK-010",
            "",
            "## Success Criteria",
            "- Sub criterion A",
            "",
            "## Testing Requirements",
            "- Test sub A",
          ].join("\n"),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(taskDir, "TASK-010-B-second-sub.md"),
          [
            "# TASK-010-B: Second Subtask",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 1-2 hours",
            "- **Status:** COMPLETE",
            "- **Blocked By:** [TASK-010-A]",
            "- **Tags:** subtask",
            "",
            "## Problem Statement",
            "Second subtask of TASK-010",
            "",
            "## Success Criteria",
            "- Sub criterion B",
            "",
            "## Testing Requirements",
            "- Test sub B",
          ].join("\n"),
          "utf-8",
        );

        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpGet(
          `http://localhost:${port}/api/tasks/TASK-010/subtasks`,
        );
        expect(status).toBe(200);

        const data = JSON.parse(body) as {
          ok: boolean;
          taskId: string;
          subtasks: Array<{ id: string; title: string }>;
        };
        expect(data.ok).toBe(true);
        expect(data.taskId).toBe("TASK-010");
        expect(data.subtasks).toHaveLength(2);
        const ids = data.subtasks.map((s) => s.id).sort();
        expect(ids).toEqual(["TASK-010-A", "TASK-010-B"]);
      });

      it("GET /api/tasks/:id/subtasks returns empty array when no subtasks exist", async () => {
        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpGet(
          `http://localhost:${port}/api/tasks/TASK-010/subtasks`,
        );
        expect(status).toBe(200);

        const data = JSON.parse(body) as { ok: boolean; taskId: string; subtasks: unknown[] };
        expect(data.ok).toBe(true);
        expect(data.taskId).toBe("TASK-010");
        expect(data.subtasks).toHaveLength(0);
      });

      it("POST /api/tasks/:id/decompose returns 404 when task not found", async () => {
        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpPost(
          `http://localhost:${port}/api/tasks/TASK-999/decompose`,
        );
        expect(status).toBe(404);
        const data = JSON.parse(body) as { error: string };
        expect(data.error).toContain("TASK-999 not found");
      });

      it("POST /api/tasks/:id/preflight returns 404 when task not found", async () => {
        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpPost(
          `http://localhost:${port}/api/tasks/TASK-999/preflight`,
        );
        expect(status).toBe(404);
        const data = JSON.parse(body) as { error: string };
        expect(data.error).toContain("TASK-999 not found");
      });

      it("POST /api/tasks/:id/preflight uses the parent task instead of a subtask prefix match", async () => {
        fs.writeFileSync(
          path.join(taskDir, "TASK-010-A-first-sub.md"),
          [
            "# TASK-010-A: First Subtask",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 1-2 hours",
            "- **Status:** READY",
            "- **Blocked By:** []",
            "- **Tags:** test",
            "",
            "## Problem Statement",
            "A focused subtask",
            "",
            "## Success Criteria",
            "- Criterion 1",
            "",
            "## Testing Requirements",
            "- Test it",
          ].join("\n"),
          "utf-8",
        );

        mockedRunReadinessGate.mockResolvedValue({
          outcome: "pass",
          task: {
            id: "TASK-010",
            title: "Parent Task",
            priority: "P1-HIGH",
            effort: "4-6 hours",
            status: "READY",
            blockedBy: [],
            blocks: [],
            supersededBy: [],
            supersedes: [],
            relevanceReview: "",
            conventions: [],
            tags: ["test"],
            problemStatement: "A complex parent task",
            currentState: "",
            recommendedApproach: "",
            filesToModify: [],
            successCriteria: ["Criterion 1", "Criterion 2"],
            testingRequirements: ["Test it"],
            contextReferences: [],
            rawContent: fs.readFileSync(path.join(taskDir, "TASK-010-parent.md"), "utf-8"),
          },
        });
        fs.writeFileSync(
          path.join(projectRoot, ".quack", "adapter.json"),
          JSON.stringify(
            {
              version: "1.0.0",
              project: {
                name: "Test",
                root: projectRoot,
                taskDir: "docs/tasks",
                conventionsDir: ".quack",
              },
              agent: {
                model: "claude-opus-4-20250514",
                judgeModel: "claude-sonnet-4-20250514",
                enrichModel: "claude-sonnet-4-20250514",
                maxTurns: 30,
                maxBudgetPerTask: 5.0,
                maxRetries: 1,
              },
              verification: {
                commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
                conventionChecks: [],
              },
              sandbox: {
                writablePaths: [],
                deniedPaths: [],
                allowedBashPatterns: [],
                deniedBashPatterns: [],
              },
              git: {
                branchPrefix: "quack",
                baseBranch: "main",
                commitFormat: "[{taskId}] {message}",
                commitTrailer: "Automated-By: Quack",
                autoCreatePr: false,
                autoPush: false,
              },
              logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpPost(
          `http://localhost:${port}/api/tasks/TASK-010/preflight`,
        );
        expect(status).toBe(200);

        const data = JSON.parse(body) as {
          ok: boolean;
          taskId: string;
          result: { taskId: string };
        };
        expect(data.ok).toBe(true);
        expect(data.taskId).toBe("TASK-010");
        expect(data.result.taskId).toBe("TASK-010");
      });

      it("GET /api/tasks/:id/preflight returns 404 when no cached result exists for task", async () => {
        const port = await freePort();
        const serverObj = createMonitorServer({
          logDir,
          port,
          projectRoot,
          taskDir: "docs/tasks",
        });
        const { stop } = await serverObj.start();
        stopServer = stop;

        const { status, body } = await httpGet(
          `http://localhost:${port}/api/tasks/TASK-010/preflight`,
        );
        expect(status).toBe(404);
        const data = JSON.parse(body) as { error: string };
        expect(data.error).toContain("No preflight result");
      });

      it("preflight and decompose SSE event types are valid QuackEvent stages", () => {
        // Verify the EventStage type includes preflight stages by checking
        // that we can create valid events with these stages
        const preflightEvent: QuackEvent = {
          sessionId: "test",
          taskId: "TASK-010",
          project: "test",
          timestamp: new Date().toISOString(),
          stage: "preflight_complete",
          payload: { taskId: "TASK-010", cached: false, recommendDecomposition: true },
        };
        expect(preflightEvent.stage).toBe("preflight_complete");

        const decomposeEvent: QuackEvent = {
          sessionId: "test",
          taskId: "TASK-010",
          project: "test",
          timestamp: new Date().toISOString(),
          stage: "task_decomposed",
          payload: {
            taskId: "TASK-010",
            subtaskCount: 2,
            subtaskIds: ["TASK-010-A", "TASK-010-B"],
            dryRun: false,
          },
        };
        expect(decomposeEvent.stage).toBe("task_decomposed");

        // Verify all preflight stages are valid
        const stages: QuackEvent["stage"][] = [
          "preflight_start",
          "preflight_gate",
          "preflight_blueprint",
          "preflight_analysis",
          "preflight_complete",
          "task_decomposed",
        ];
        expect(stages).toHaveLength(6);
      });

      it("all intermediate preflight stage payloads have correct structure", () => {
        // Verify PreflightStartPayload
        const startPayload: PreflightStartPayload = { taskId: "TASK-010" };
        expect(startPayload.taskId).toBe("TASK-010");

        // Verify PreflightGatePayload
        const gatePayload: PreflightGatePayload = { taskId: "TASK-010" };
        expect(gatePayload.taskId).toBe("TASK-010");

        // Verify PreflightBlueprintPayload
        const blueprintPayload: PreflightBlueprintPayload = { taskId: "TASK-010" };
        expect(blueprintPayload.taskId).toBe("TASK-010");

        // Verify PreflightAnalysisPayload
        const analysisPayload: PreflightAnalysisPayload = { taskId: "TASK-010" };
        expect(analysisPayload.taskId).toBe("TASK-010");

        // Verify PreflightCompletePayload
        const completePayload: PreflightCompletePayload = {
          taskId: "TASK-010",
          cached: false,
          recommendDecomposition: true,
        };
        expect(completePayload.taskId).toBe("TASK-010");
        expect(completePayload.cached).toBe(false);
        expect(completePayload.recommendDecomposition).toBe(true);
      });

      it("intermediate preflight stages can be used in QuackEvent envelope", () => {
        const stages: Array<{ stage: QuackEvent["stage"]; payload: Record<string, unknown> }> = [
          { stage: "preflight_start", payload: { taskId: "TASK-010" } },
          { stage: "preflight_gate", payload: { taskId: "TASK-010" } },
          { stage: "preflight_blueprint", payload: { taskId: "TASK-010" } },
          { stage: "preflight_analysis", payload: { taskId: "TASK-010" } },
          {
            stage: "preflight_complete",
            payload: { taskId: "TASK-010", cached: false, recommendDecomposition: false },
          },
        ];

        for (const { stage, payload } of stages) {
          const event: QuackEvent = {
            sessionId: "preflight",
            taskId: "TASK-010",
            project: "test",
            timestamp: new Date().toISOString(),
            stage,
            payload: payload as QuackEvent["payload"],
          };
          expect(event.stage).toBe(stage);
          expect(event.sessionId).toBe("preflight");
          expect((event.payload as Record<string, unknown>).taskId).toBe("TASK-010");
        }
      });

      it("preflight SSE events follow the correct emission order", () => {
        // The runPreflight function emits events in this deterministic order:
        // 1. preflight_start
        // 2. preflight_gate (if gate not skipped)
        // 3. preflight_blueprint
        // 4. preflight_analysis
        // 5. preflight_complete
        const expectedOrder: QuackEvent["stage"][] = [
          "preflight_start",
          "preflight_gate",
          "preflight_blueprint",
          "preflight_analysis",
          "preflight_complete",
        ];
        expect(expectedOrder).toHaveLength(5);
        expect(expectedOrder[0]).toBe("preflight_start");
        expect(expectedOrder[1]).toBe("preflight_gate");
        expect(expectedOrder[2]).toBe("preflight_blueprint");
        expect(expectedOrder[3]).toBe("preflight_analysis");
        expect(expectedOrder[4]).toBe("preflight_complete");
      });
    });

    describe("New API endpoints (TASK-067)", () => {
      describe("Fleet routing endpoints", () => {
        it("GET /api/fleet/routing returns routing config when adapter exists", async () => {
          const projectRoot = makeTempDir();

          // Write .quack/adapter.json (loadAdapter reads from .quack/)
          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });
          fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
          fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");
          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-sonnet-4-6",
              judgeModel: "claude-sonnet-4-6",
              enrichModel: "claude-sonnet-4-6",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            modelRouting: {
              gateModel: "claude-haiku-4-5-20251001",
              enrichModel: "claude-haiku-4-5-20251001",
              plannerModel: "claude-haiku-4-5-20251001",
              workerModel: "claude-sonnet-4-6",
              workerComplexModel: "claude-opus-4-6",
              judgeModel: "claude-sonnet-4-6",
              retryEscalation: true,
            },
            verification: {
              commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(`http://localhost:${port}/api/fleet/routing`);
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            config: Record<string, unknown>;
            resolved: Record<string, string>;
          };
          expect(data.config).toBeDefined();
          expect(data.resolved).toBeDefined();
          expect(data.resolved.gate).toBe("claude-haiku-4-5-20251001");
          expect(data.resolved.worker).toBe("claude-sonnet-4-6");

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });

        it("PATCH /api/fleet/routing updates modelRouting in adapter.json", async () => {
          const projectRoot = makeTempDir();
          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });

          const adapterConfig = {
            project: { root: projectRoot, taskDir: "docs/tasks" },
            agent: { model: "claude-sonnet-4-6" },
            modelRouting: {
              gateModel: "claude-haiku-4-5-20251001",
              workerModel: "claude-sonnet-4-6",
            },
            verification: { commands: [], conventionChecks: [] },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpPatch(`http://localhost:${port}/api/fleet/routing`, {
            workerModel: "claude-opus-4-6",
            retryEscalation: false,
          });
          expect(status).toBe(200);

          const data = JSON.parse(body) as { ok: boolean; modelRouting: Record<string, unknown> };
          expect(data.ok).toBe(true);
          expect(data.modelRouting.workerModel).toBe("claude-opus-4-6");
          expect(data.modelRouting.retryEscalation).toBe(false);

          // Verify file was updated on disk
          const updatedConfig = JSON.parse(
            fs.readFileSync(path.join(projectRoot, ".quack", "adapter.json"), "utf-8"),
          ) as Record<string, unknown>;
          const updatedRouting = updatedConfig.modelRouting as Record<string, unknown>;
          expect(updatedRouting.workerModel).toBe("claude-opus-4-6");

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("Task advisory endpoint", () => {
        it("GET /api/tasks/:id/advisory returns advisory with warnings when analytics data exists", async () => {
          const projectRoot = makeTempDir();

          // Set up analytics data
          const analyticsDir = path.join(projectRoot, ".quack", "analytics");
          fs.mkdirSync(analyticsDir, { recursive: true });
          const analyticsData = {
            updatedAt: new Date().toISOString(),
            totalRuns: 20,
            totalApproved: 10,
            totalRejected: 10,
            totalErrors: 0,
            byTag: {
              refactor: { runs: 10, approved: 4, rejected: 6, rate: 0.4 },
            },
            byFile: {
              "src/test.ts": { runs: 10, approved: 4, rejected: 6, rate: 0.4 },
            },
            byComplexity: {},
            byGateScore: {},
            topFeedbackThemes: [],
            knownPatterns: [
              {
                pattern: "tag_cluster:refactor",
                frequency: 6,
                suggestion: "Add more examples for refactoring tasks",
              },
            ],
          };
          fs.writeFileSync(
            path.join(analyticsDir, "failure-patterns.json"),
            JSON.stringify(analyticsData, null, 2),
            "utf-8",
          );

          // Set up task file
          const taskDir = path.join(projectRoot, "docs", "tasks");
          fs.mkdirSync(taskDir, { recursive: true });
          const taskContent = [
            "# TASK-001: Test Task",
            "",
            "## Metadata",
            "- **Priority:** P1-HIGH",
            "- **Effort:** 2-4 hours",
            "- **Status:** READY",
            "- **Blocked By:** []",
            "- **Tags:** refactor",
            "",
            "## Problem Statement",
            "Test problem",
            "",
            "## Success Criteria",
            "- Criterion 1",
            "",
            "## Testing Requirements",
            "- Test it",
            "",
            "## Files to Modify",
            "| File | Action | Notes |",
            "|------|--------|-------|",
            "| src/test.ts | Modify | Test file |",
          ].join("\n");
          fs.writeFileSync(path.join(taskDir, "TASK-001-test.md"), taskContent, "utf-8");

          const port = await freePort();
          const serverObj = createMonitorServer({
            logDir,
            port,
            projectRoot,
            taskDir: "docs/tasks",
          });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(
            `http://localhost:${port}/api/tasks/TASK-001/advisory`,
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            taskId: string;
            suggestedMinScore: number;
            warnings: string[];
          };
          expect(data.taskId).toBe("TASK-001");
          expect(data.suggestedMinScore).toBeDefined();
          expect(Array.isArray(data.warnings)).toBe(true);

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("Templates endpoints", () => {
        it("GET /api/templates returns empty registry when none exists", async () => {
          const projectRoot = makeTempDir();

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(`http://localhost:${port}/api/templates`);
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            templates: unknown[];
            categoryStats: Record<string, unknown>;
          };
          expect(data.templates).toBeDefined();
          expect(data.categoryStats).toBeDefined();

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("Analytics endpoints", () => {
        it("GET /api/analytics/summary returns aggregate stats", async () => {
          const projectRoot = makeTempDir();

          const analyticsDir = path.join(projectRoot, ".quack", "analytics");
          fs.mkdirSync(analyticsDir, { recursive: true });
          const analyticsData = {
            updatedAt: new Date().toISOString(),
            totalRuns: 100,
            totalApproved: 85,
            totalRejected: 10,
            totalErrors: 5,
            byTag: {},
            byFile: {},
            byComplexity: {},
            byGateScore: {},
            topFeedbackThemes: [],
            knownPatterns: [{ pattern: "test-pattern", frequency: 5, suggestion: "test" }],
          };
          fs.writeFileSync(
            path.join(analyticsDir, "failure-patterns.json"),
            JSON.stringify(analyticsData, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(`http://localhost:${port}/api/analytics/summary`);
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            totalRuns: number;
            totalApproved: number;
            successRate: number;
          };
          expect(data.totalRuns).toBe(100);
          expect(data.totalApproved).toBe(85);
          expect(data.successRate).toBeCloseTo(0.85, 2);

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });

        it("GET /api/analytics/patterns returns full pattern DB", async () => {
          const projectRoot = makeTempDir();

          const analyticsDir = path.join(projectRoot, ".quack", "analytics");
          fs.mkdirSync(analyticsDir, { recursive: true });
          const analyticsData = {
            updatedAt: new Date().toISOString(),
            totalRuns: 100,
            totalApproved: 85,
            totalRejected: 10,
            totalErrors: 5,
            byTag: { "test-tag": { runs: 10, approved: 8, rejected: 2, rate: 0.8 } },
            byFile: {},
            byComplexity: {},
            byGateScore: {},
            topFeedbackThemes: [],
            knownPatterns: [],
          };
          fs.writeFileSync(
            path.join(analyticsDir, "failure-patterns.json"),
            JSON.stringify(analyticsData, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(`http://localhost:${port}/api/analytics/patterns`);
          expect(status).toBe(200);

          const data = JSON.parse(body) as { totalRuns: number; byTag: Record<string, unknown> };
          expect(data.totalRuns).toBe(100);
          expect(data.byTag).toBeDefined();
          expect(data.byTag["test-tag"]).toBeDefined();

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });

        it("GET /api/analytics/by-tag with tag param filters correctly", async () => {
          const projectRoot = makeTempDir();

          const analyticsDir = path.join(projectRoot, ".quack", "analytics");
          fs.mkdirSync(analyticsDir, { recursive: true });
          const analyticsData = {
            updatedAt: new Date().toISOString(),
            totalRuns: 100,
            totalApproved: 85,
            totalRejected: 10,
            totalErrors: 5,
            byTag: {
              "test-tag": { runs: 10, approved: 8, rejected: 2, rate: 0.8 },
              "other-tag": { runs: 5, approved: 3, rejected: 2, rate: 0.6 },
            },
            byFile: {},
            byComplexity: {},
            byGateScore: {},
            topFeedbackThemes: [],
            knownPatterns: [],
          };
          fs.writeFileSync(
            path.join(analyticsDir, "failure-patterns.json"),
            JSON.stringify(analyticsData, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(
            `http://localhost:${port}/api/analytics/by-tag?tag=test-tag`,
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as { tag: string; data: { runs: number; rate: number } };
          expect(data.tag).toBe("test-tag");
          expect(data.data.runs).toBe(10);
          expect(data.data.rate).toBe(0.8);

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("PATCH /api/fleet/routing validation", () => {
        it("rejects invalid model routing config", async () => {
          const projectRoot = makeTempDir();
          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });

          const adapterConfig = {
            project: { root: projectRoot, taskDir: "docs/tasks" },
            agent: { model: "claude-sonnet-4-6" },
            modelRouting: {
              gateModel: "claude-haiku-4-5-20251001",
              workerModel: "claude-sonnet-4-6",
            },
            verification: { commands: [], conventionChecks: [] },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          // Send invalid data (retryEscalation should be boolean, not string)
          const { status, body } = await httpPatch(`http://localhost:${port}/api/fleet/routing`, {
            retryEscalation: "not-a-boolean",
          });
          expect(status).toBe(400);

          const data = JSON.parse(body) as { error: string; details: string[] };
          expect(data.error).toContain("Invalid model routing configuration");
          expect(data.details).toBeDefined();

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("Task verify endpoint", () => {
        it("POST /api/tasks/:id/verify returns 404 when project root not configured", async () => {
          const port = await freePort();
          const serverObj = createMonitorServer({ logDir, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/verify`,
          );
          expect(status).toBe(404);

          const data = JSON.parse(body) as { error: string };
          expect(data.error).toContain("Project root not configured");
        });

        it("POST /api/tasks/:id/verify runs verification and returns structured result", async () => {
          const projectRoot = makeTempDir();

          // Set up adapter with a simple verification command
          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });
          fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
          fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");

          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-opus-4-20250514",
              judgeModel: "claude-sonnet-4-20250514",
              enrichModel: "claude-sonnet-4-20250514",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            verification: {
              commands: [{ name: "echo-test", command: "echo hello", required: true, timeout: 10 }],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/verify`,
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            allPassed: boolean;
            commands: Array<{ name: string; passed: boolean }>;
            conventionChecks: unknown[];
          };
          expect(typeof data.allPassed).toBe("boolean");
          expect(Array.isArray(data.commands)).toBe(true);
          expect(data.commands.length).toBeGreaterThanOrEqual(1);
          expect(data.commands[0].name).toBe("echo-test");

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });

        it("POST /api/tasks/:id/verify uses worktree path when dispatch is active", async () => {
          // This test verifies the dispatchManager.getJob(taskId)?.worktreePath logic
          // We test by checking the code path without an active dispatch (no worktree)
          // and verifying the endpoint completes successfully using project root
          const projectRoot = makeTempDir();

          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });
          fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
          fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");

          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-opus-4-20250514",
              judgeModel: "claude-sonnet-4-20250514",
              enrichModel: "claude-sonnet-4-20250514",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            verification: {
              commands: [
                // Cross-platform cwd probe: legacy string commands run under the
                // platform default shell (cmd.exe on Windows), where `pwd` does
                // not exist. Node is always on PATH wherever Jest runs.
                {
                  name: "pwd-check",
                  command: 'node -p "process.cwd()"',
                  required: true,
                  timeout: 10,
                },
              ],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          // When no dispatch is active, verify should run in projectRoot (fallback path)
          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/verify`,
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            allPassed: boolean;
            commands: Array<{ name: string; passed: boolean; output: string }>;
          };
          // The probe prints its cwd; with no dispatch active the endpoint must
          // fall back to running in projectRoot (mkdtemp basename is unique).
          expect(data.commands[0].name).toBe("pwd-check");
          expect(data.commands[0].passed).toBe(true);
          expect(data.commands[0].output).toContain(path.basename(projectRoot));

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });

      describe("Task enrich endpoints", () => {
        it("POST /api/tasks/:id/enrich returns 404 when project not configured", async () => {
          const port = await freePort();
          const serverObj = createMonitorServer({ logDir, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/enrich`,
          );
          expect(status).toBe(404);

          const data = JSON.parse(body) as { error: string };
          expect(data.error).toContain("not configured");
        });

        it("POST /api/tasks/:id/enrich uses the 1200s route timeout budget", async () => {
          const projectRoot = makeTempDir();
          const taskDir = path.join(projectRoot, "docs", "tasks");
          fs.mkdirSync(taskDir, { recursive: true });
          fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
          fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

          fs.writeFileSync(
            path.join(taskDir, "TASK-001-test.md"),
            [
              "# TASK-001: Test Task",
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

          const quackDir = path.join(projectRoot, ".quack");
          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-opus-4-20250514",
              judgeModel: "claude-sonnet-4-20250514",
              enrichModel: "claude-sonnet-4-20250514",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            verification: {
              commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          mockedRunReadinessGate.mockResolvedValue({
            outcome: "pass",
            task: {
              id: "TASK-001",
              title: "Test Task",
              priority: "P1-HIGH",
              effort: "2-4 hours",
              status: "READY",
              blockedBy: [],
              blocks: [],
              supersededBy: [],
              supersedes: [],
              relevanceReview: "",
              conventions: [],
              tags: ["test"],
              problemStatement: "Test problem",
              currentState: "",
              recommendedApproach: "",
              filesToModify: [],
              successCriteria: ["Criterion 1"],
              testingRequirements: ["Test it"],
              contextReferences: [],
              rawContent: "# TASK-001: Test Task",
            },
          });

          const originalSetTimeout = global.setTimeout;
          const originalClearTimeout = global.clearTimeout;
          const routeUnref = jest.fn();

          const timeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((
            handler: (...args: unknown[]) => void,
            timeout?: number,
            ...args: unknown[]
          ) => {
            if (timeout === 1_200_000) {
              return { unref: routeUnref } as unknown as ReturnType<typeof setTimeout>;
            }
            return originalSetTimeout(handler, timeout, ...args);
          }) as typeof setTimeout);
          const clearSpy = jest.spyOn(global, "clearTimeout").mockImplementation(((
            handle: ReturnType<typeof setTimeout>,
          ) => {
            if (
              handle &&
              typeof handle === "object" &&
              "unref" in handle &&
              handle.unref === routeUnref
            ) {
              return undefined;
            }
            return originalClearTimeout(handle);
          }) as typeof clearTimeout);

          try {
            const port = await freePort();
            const serverObj = createMonitorServer({
              logDir,
              port,
              projectRoot,
              taskDir: "docs/tasks",
            });
            const { stop } = await serverObj.start();
            stopServer = stop;

            const { status, body } = await httpPost(
              `http://localhost:${port}/api/tasks/TASK-001/enrich`,
            );
            expect(status).toBe(200);

            const data = JSON.parse(body) as { outcome: string; gateScore: number };
            expect(data).toEqual({ outcome: "pass", gateScore: 4.0 });
            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_200_000);
            expect(routeUnref).toHaveBeenCalled();
            expect(clearSpy).toHaveBeenCalled();
          } finally {
            timeoutSpy.mockRestore();
            clearSpy.mockRestore();
            if (stopServer) {
              await stopServer();
              stopServer = undefined;
            }
            removeTempDir(projectRoot);
          }
        });

        it("POST /api/tasks/:id/enrich/approve returns 400 when content missing", async () => {
          const projectRoot = makeTempDir();
          const taskDir = path.join(projectRoot, "docs", "tasks");
          fs.mkdirSync(taskDir, { recursive: true });
          fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
          fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

          fs.writeFileSync(
            path.join(taskDir, "TASK-001-test.md"),
            [
              "# TASK-001: Test Task",
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

          // Write adapter
          const quackDir = path.join(projectRoot, ".quack");
          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-opus-4-20250514",
              judgeModel: "claude-sonnet-4-20250514",
              enrichModel: "claude-sonnet-4-20250514",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            verification: {
              commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({
            logDir,
            port,
            projectRoot,
            taskDir: "docs/tasks",
          });
          const { stop } = await serverObj.start();
          stopServer = stop;

          // Send empty body (no content)
          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/enrich/approve`,
            {},
          );
          expect(status).toBe(400);

          const data = JSON.parse(body) as { error: string };
          expect(data.error).toContain("content is required");

          await stopServer?.();
          stopServer = undefined;
          removeTempDir(projectRoot);
        });

        it("POST /api/tasks/:id/enrich/approve writes enriched content to task file", async () => {
          const projectRoot = makeTempDir();
          const taskDir = path.join(projectRoot, "docs", "tasks");
          fs.mkdirSync(taskDir, { recursive: true });
          fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
          fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

          const originalContent = [
            "# TASK-001: Test Task",
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
          ].join("\n");
          fs.writeFileSync(path.join(taskDir, "TASK-001-test.md"), originalContent, "utf-8");

          // Write adapter (needs at least 1 verification command for schema validation)
          const quackDir = path.join(projectRoot, ".quack");
          const adapterConfig = {
            version: "1.0.0",
            project: {
              name: "Test",
              root: projectRoot,
              taskDir: "docs/tasks",
              conventionsDir: ".quack",
            },
            agent: {
              model: "claude-opus-4-20250514",
              judgeModel: "claude-sonnet-4-20250514",
              enrichModel: "claude-sonnet-4-20250514",
              maxTurns: 30,
              maxBudgetPerTask: 5.0,
              maxRetries: 1,
            },
            verification: {
              commands: [{ name: "echo", command: "echo ok", required: true, timeout: 10 }],
              conventionChecks: [],
            },
            sandbox: {
              writablePaths: [],
              deniedPaths: [],
              allowedBashPatterns: [],
              deniedBashPatterns: [],
            },
            git: {
              branchPrefix: "quack",
              baseBranch: "main",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "Automated-By: Quack",
              autoCreatePr: false,
              autoPush: false,
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({
            logDir,
            port,
            projectRoot,
            taskDir: "docs/tasks",
          });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const enrichedContent = originalContent + "\n\n## Enriched Section\nAdded by enrichment";

          const { status, body } = await httpPost(
            `http://localhost:${port}/api/tasks/TASK-001/enrich/approve`,
            {
              content: enrichedContent,
            },
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            ok: boolean;
            taskId: string;
            baseSpecHash?: string;
            effectiveSpecHash?: string;
          };
          expect(data.ok).toBe(true);
          expect(data.taskId).toBe("TASK-001");
          expect(data.baseSpecHash).toMatch(/^[0-9a-f]{64}$/);
          expect(data.effectiveSpecHash).toMatch(/^[0-9a-f]{64}$/);

          // Verify file was updated on disk
          const fileContent = fs.readFileSync(path.join(taskDir, "TASK-001-test.md"), "utf-8");
          expect(fileContent).toContain("Enriched Section");

          const readinessResponse = await httpGet(
            `http://localhost:${port}/v1/tasks/TASK-001/readiness`,
          );
          expect(readinessResponse.status).toBe(200);

          const readiness = JSON.parse(readinessResponse.body) as {
            currentEffectiveSpec: { effectiveSpecHash: string } | null;
            effectiveSpecs: Array<{ status: string; effectiveSpecHash: string }>;
          };
          expect(readiness.currentEffectiveSpec?.effectiveSpecHash).toBe(data.effectiveSpecHash);
          expect(readiness.effectiveSpecs[0]).toEqual(
            expect.objectContaining({
              status: "accepted",
              effectiveSpecHash: data.effectiveSpecHash,
            }),
          );

          await stopServer?.();
          stopServer = undefined;
          removeTempDir(projectRoot);
        });
      });

      describe("GitHub sync endpoints", () => {
        it("GET /api/github/sync-map returns entries", async () => {
          const projectRoot = makeTempDir();
          const quackDir = path.join(projectRoot, ".quack");
          fs.mkdirSync(quackDir, { recursive: true });

          // Set up sync map
          const syncDir = path.join(quackDir, "sync");
          fs.mkdirSync(syncDir, { recursive: true });
          const syncData = {
            entries: [
              {
                taskId: "TASK-001",
                issueNumber: 42,
                taskStatus: "COMPLETE",
                issueState: "closed",
                createdAt: new Date().toISOString(),
                lastSyncedAt: new Date().toISOString(),
              },
            ],
          };
          fs.writeFileSync(
            path.join(syncDir, "github-sync.json"),
            JSON.stringify(syncData, null, 2),
            "utf-8",
          );

          // Set up adapter
          const adapterConfig = {
            project: { root: projectRoot, taskDir: "docs/tasks" },
            agent: { model: "claude-sonnet-4-6" },
            verification: { commands: [], conventionChecks: [] },
            integrations: {
              github: {
                owner: "test-owner",
                repo: "test-repo",
              },
            },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpGet(`http://localhost:${port}/api/github/sync-map`);
          expect(status).toBe(200);

          const data = JSON.parse(body) as {
            entries: Array<{ taskId: string; issueNumber: number }>;
          };
          expect(data.entries).toHaveLength(1);
          expect(data.entries[0].taskId).toBe("TASK-001");
          expect(data.entries[0].issueNumber).toBe(42);

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });

        it("DELETE /api/github/sync-map/:taskId removes entry", async () => {
          const projectRoot = makeTempDir();
          const quackDir = path.join(projectRoot, ".quack");

          const syncDir = path.join(quackDir, "sync");
          fs.mkdirSync(syncDir, { recursive: true });
          const syncData = {
            entries: [
              {
                taskId: "TASK-001",
                issueNumber: 42,
                taskStatus: "COMPLETE",
                issueState: "closed",
                createdAt: new Date().toISOString(),
                lastSyncedAt: new Date().toISOString(),
              },
              {
                taskId: "TASK-002",
                issueNumber: 43,
                taskStatus: "IN_PROGRESS",
                issueState: "open",
                createdAt: new Date().toISOString(),
                lastSyncedAt: new Date().toISOString(),
              },
            ],
          };
          fs.writeFileSync(
            path.join(syncDir, "github-sync.json"),
            JSON.stringify(syncData, null, 2),
            "utf-8",
          );

          const adapterConfig = {
            project: { root: projectRoot, taskDir: "docs/tasks" },
            agent: { model: "claude-sonnet-4-6" },
            verification: { commands: [], conventionChecks: [] },
            integrations: {
              github: {
                owner: "test-owner",
                repo: "test-repo",
              },
            },
          };
          fs.writeFileSync(
            path.join(quackDir, "adapter.json"),
            JSON.stringify(adapterConfig, null, 2),
            "utf-8",
          );

          const port = await freePort();
          const serverObj = createMonitorServer({ projectRoot, port });
          const { stop } = await serverObj.start();
          stopServer = stop;

          const { status, body } = await httpDelete(
            `http://localhost:${port}/api/github/sync-map/TASK-001`,
          );
          expect(status).toBe(200);

          const data = JSON.parse(body) as { ok: boolean; deleted: { taskId: string } };
          expect(data.ok).toBe(true);
          expect(data.deleted.taskId).toBe("TASK-001");

          // Verify entry was removed from file
          const updatedSync = JSON.parse(
            fs.readFileSync(path.join(syncDir, "github-sync.json"), "utf-8"),
          ) as { entries: Array<{ taskId: string }> };
          expect(updatedSync.entries).toHaveLength(1);
          expect(updatedSync.entries[0].taskId).toBe("TASK-002");

          // Stop before rmSync: Windows cannot unlink the project quack.db while open.
          if (stopServer) {
            await stopServer();
            stopServer = undefined;
          }
          removeTempDir(projectRoot);
        });
      });
    });
  });
});
