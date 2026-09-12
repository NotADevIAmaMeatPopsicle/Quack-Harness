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
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-github-sync-"));
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

function setupSyncFixture(projectRoot: string): void {
  // Set up sync map
  const syncDir = path.join(projectRoot, ".quack", "sync");
  fs.mkdirSync(syncDir, { recursive: true });
  const syncData = {
    entries: [
      {
        taskId: "TASK-001",
        issueNumber: 42,
        taskStatus: "COMPLETE",
        issueState: "closed",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSyncedAt: "2026-01-15T00:00:00.000Z",
      },
      {
        taskId: "TASK-002",
        issueNumber: 43,
        taskStatus: "IN_PROGRESS",
        issueState: "open",
        createdAt: "2026-01-02T00:00:00.000Z",
        lastSyncedAt: "2026-01-15T00:00:00.000Z",
      },
      {
        taskId: "TASK-003",
        issueNumber: 44,
        taskStatus: "READY",
        issueState: "open",
        createdAt: "2026-01-03T00:00:00.000Z",
        lastSyncedAt: "2026-01-15T00:00:00.000Z",
      },
    ],
  };
  fs.writeFileSync(
    path.join(syncDir, "github-sync.json"),
    JSON.stringify(syncData, null, 2),
    "utf-8",
  );

  // Set up adapter config with github integration
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
  const quackDir = path.join(projectRoot, ".quack");
  fs.mkdirSync(quackDir, { recursive: true });
  fs.writeFileSync(
    path.join(quackDir, "adapter.json"),
    JSON.stringify(adapterConfig, null, 2),
    "utf-8",
  );
}

// ─── Tests ───────────────────────────────────────────────────────

describe("GitHub Sync Map API", () => {
  let logDir: string;
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<number> {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
    });
    const started = await serverObj.start();
    stopServer = started.stop;
    return started.port;
  }

  it("GET /api/github/sync-map returns all entries", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/github/sync-map`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { entries: Array<{ taskId: string; issueNumber: number }> };
    expect(data.entries).toHaveLength(3);
    expect(data.entries.map((e) => e.taskId).sort()).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
  });

  it("GET /api/github/sync-map?taskId=X filters correctly", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/api/github/sync-map?taskId=TASK-002`,
    );
    expect(status).toBe(200);

    const data = JSON.parse(body) as { entries: Array<{ taskId: string; issueNumber: number }> };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].taskId).toBe("TASK-002");
    expect(data.entries[0].issueNumber).toBe(43);
  });

  it("GET /api/github/sync-map?issueNumber=Y filters correctly", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/api/github/sync-map?issueNumber=44`,
    );
    expect(status).toBe(200);

    const data = JSON.parse(body) as { entries: Array<{ taskId: string; issueNumber: number }> };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].taskId).toBe("TASK-003");
  });

  it("DELETE /api/github/sync-map/:taskId removes entry and persists", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpDelete(
      `http://127.0.0.1:${port}/api/github/sync-map/TASK-001`,
    );
    expect(status).toBe(200);

    const data = JSON.parse(body) as { ok: boolean; deleted: { taskId: string } };
    expect(data.ok).toBe(true);
    expect(data.deleted.taskId).toBe("TASK-001");

    // Verify entry was actually removed from disk
    const syncFilePath = path.join(projectRoot, ".quack", "sync", "github-sync.json");
    const updatedSync = JSON.parse(fs.readFileSync(syncFilePath, "utf-8")) as {
      entries: Array<{ taskId: string }>;
    };
    expect(updatedSync.entries).toHaveLength(2);
    expect(updatedSync.entries.map((e) => e.taskId)).not.toContain("TASK-001");
  });

  it("DELETE /api/github/sync-map/:taskId returns 404 for non-existent entry", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpDelete(
      `http://127.0.0.1:${port}/api/github/sync-map/TASK-999`,
    );
    expect(status).toBe(404);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("not found");
  });

  it("POST /api/github/sync-map/:taskId/refresh returns 404 for non-existent entry", async () => {
    setupSyncFixture(projectRoot);

    const port = await startServer();

    const { status, body } = await httpPost(
      `http://127.0.0.1:${port}/api/github/sync-map/TASK-999/refresh`,
    );
    expect(status).toBe(404);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("not found");
  });
});
