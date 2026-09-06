import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

// Prevent tests from picking up real .quack/auth.json (which has users → auth enabled)
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-qapi-"));
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

describe("Queue API Endpoints", () => {
  let logDir: string;
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeEach(() => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();
    // Create minimal task directory structure
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    // Create a minimal .quack directory with adapter.json
    const quackDir = path.join(projectRoot, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        project: { name: "test", language: "typescript", taskDir: "docs/tasks" },
        agent: {},
        verification: { commands: [] },
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startServer(): Promise<number> {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      adapterPath: path.join(projectRoot, ".quack", "adapter.json"),
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
    baseUrl = `http://localhost:${port}`;
    return port;
  }

  it("GET /api/queue returns operator summary fields", async () => {
    await startServer();

    const { status, body } = await httpGet(`${baseUrl}/api/queue`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data).toHaveProperty("state", "idle");
    expect(data).toHaveProperty("running", false);
    expect(data).toHaveProperty("paused", false);
    expect(data).toHaveProperty("config");
    expect(data).toHaveProperty("stats");
    expect(data).toHaveProperty("items");
    expect(data).toHaveProperty("activeTaskIds");
    expect(data).toHaveProperty("maxConcurrent");
    expect((data.stats as Record<string, unknown>).total).toBe(0);
  });

  it("GET /api/queue/stats returns QueueStats", async () => {
    await startServer();

    const { status, body } = await httpGet(`${baseUrl}/api/queue/stats`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("queued");
    expect(data).toHaveProperty("running");
    expect(data.total).toBe(0);
  });

  it("POST /api/queue/start begins processing", async () => {
    await startServer();

    const { status, body } = await httpPost(`${baseUrl}/api/queue/start`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.message).toContain("Queue started");

    // Stop so the queue doesn't keep trying to process
    await httpPost(`${baseUrl}/api/queue/stop`);
  });

  it("POST /api/queue/pause stops new dispatches", async () => {
    await startServer();

    // Start first, then pause
    await httpPost(`${baseUrl}/api/queue/start`);
    const { status, body } = await httpPost(`${baseUrl}/api/queue/pause`, { reason: "test pause" });
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.message).toContain("paused");

    const pausedQueue = JSON.parse((await httpGet(`${baseUrl}/api/queue`)).body) as Record<
      string,
      unknown
    >;
    expect(pausedQueue.paused).toBe(true);
    expect(pausedQueue.pauseReason).toBe("test pause");
    expect(pausedQueue.state).toBe("paused");
  });

  it("POST /api/queue/resume resumes from paused state", async () => {
    await startServer();

    await httpPost(`${baseUrl}/api/queue/start`);
    await httpPost(`${baseUrl}/api/queue/pause`, { reason: "test" });
    const { status, body } = await httpPost(`${baseUrl}/api/queue/resume`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it("POST /api/queue/tasks/:id/cancel returns 404 for non-existent task", async () => {
    await startServer();

    const { status } = await httpPost(`${baseUrl}/api/queue/tasks/TASK-999/cancel`);
    expect(status).toBe(404);
  });

  it("POST /api/queue/tasks/:id/retry returns 404 for non-queued task", async () => {
    await startServer();

    const { status } = await httpPost(`${baseUrl}/api/queue/tasks/TASK-999/retry`);
    expect(status).toBe(404);
  });

  it("DELETE /api/queue/tasks/:id returns 404 for non-existent task", async () => {
    await startServer();

    const { status } = await httpDelete(`${baseUrl}/api/queue/tasks/TASK-999`);
    expect(status).toBe(404);
  });

  it("PATCH /api/queue/config updates maxConcurrent at runtime", async () => {
    await startServer();

    const { status, body } = await httpPatch(`${baseUrl}/api/queue/config`, {
      maxConcurrent: 5,
    });
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect((data.config as Record<string, unknown>).maxConcurrent).toBe(5);
    expect(data).toHaveProperty("stats");
  });

  it("queue endpoints work when projectRoot is set", async () => {
    await startServer();

    // Just verify queue is available (not 500)
    const { status } = await httpGet(`${baseUrl}/api/queue`);
    expect(status).toBe(200);
  });

  // NOTE: enqueue test last because enrichQueueItem runs async after response
  it("POST /api/queue/enqueue adds tasks and exposes normalized queue item summaries", async () => {
    // Create a task file so it can be enqueued
    const taskDirPath = path.join(projectRoot, "docs", "tasks");
    fs.writeFileSync(
      path.join(taskDirPath, "TASK-001.md"),
      `# TASK-001: Test Task\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** S\n- **Status:** READY\n- **Blocked By:** []\n- **Blocks:** []\n- **Tags:** [test]\n- **Conventions:** []\n\n## Problem Statement\nTest\n\n## Success Criteria\n- [ ] Works\n\n## Testing Requirements\n- [ ] Unit tests pass\n`,
      "utf-8",
    );

    await startServer();

    const { status, body } = await httpPost(`${baseUrl}/api/queue/enqueue`, {
      taskIds: ["TASK-001"],
    });
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, unknown>;
    const items = data.items as Array<{ taskId: string }>;
    expect(items).toBeDefined();
    expect(items).toHaveLength(1);
    expect(items[0].taskId).toBe("TASK-001");

    // Wait for async enrichment to complete before teardown
    await new Promise((r) => setTimeout(r, 100));

    const queueData = JSON.parse((await httpGet(`${baseUrl}/api/queue`)).body) as {
      items: Array<Record<string, unknown>>;
      activeTaskIds: string[];
    };
    expect(queueData.activeTaskIds).toEqual([]);
    expect(queueData.items).toHaveLength(1);
    expect(queueData.items[0].taskId).toBe("TASK-001");
    expect(queueData.items[0].priority).toBe("P2-MEDIUM");
    expect(queueData.items[0].priorityWeight).toBe(2);
  });
});

describe("Queue API without projectRoot", () => {
  let logDir: string;
  let stopServer: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeEach(() => {
    logDir = makeTempDir();
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("queue endpoints return 500 when queue not available", async () => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({ logDir, port });
    const { stop } = await serverObj.start();
    stopServer = stop;
    baseUrl = `http://localhost:${port}`;

    const { status, body } = await httpGet(`${baseUrl}/api/queue`);
    expect(status).toBe(500);

    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.error).toContain("not available");
  });
});
