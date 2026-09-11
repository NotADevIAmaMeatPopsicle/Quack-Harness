import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import * as importPipeline from "../../src/integrations/github/import-pipeline";
import * as issuePublisher from "../../src/integrations/github/issue-publisher";
import * as statusSyncer from "../../src/integrations/github/status-syncer";
import { hashPassword } from "../../src/monitor/auth";
import { AdminRunManager, type AdminRunSnapshot } from "../../src/monitor/admin-run-manager";
import { createMonitorServer } from "../../src/monitor/server";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAdapter(projectRoot: string, projectId: string): ProjectAdapter {
  const config = {
    version: "1.0.0",
    project: {
      name: projectId,
      root: projectRoot,
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-opus-4-20250514",
      judgeModel: "claude-sonnet-4-20250514",
      enrichModel: "claude-sonnet-4-20250514",
      maxTurns: 30,
      maxBudgetPerTask: 5,
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
    integrations: {
      github: {
        owner: `${projectId}-owner`,
        repo: `${projectId}-repo`,
      },
    },
  } as AdapterConfig;

  fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
  fs.writeFileSync(
    path.join(projectRoot, ".quack", "adapter.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );

  return {
    projectRoot,
    config,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: `${projectId}-bundle`,
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function makeAdminRun(runId: string, projectId: string, projectRoot: string): AdminRunSnapshot {
  const now = new Date().toISOString();
  return {
    runId,
    action: "overnight",
    projectId,
    projectRoot,
    status: "running",
    stage: "waiting",
    pid: 1234,
    startedAt: now,
    updatedAt: now,
    stageStartedAt: now,
    durationMs: 0,
    lastHeartbeatAt: now,
    lastOutputAt: now,
    command: ["node", "quack", "overnight"],
    stdoutTail: [],
    stderrTail: [],
    watchdog: {
      status: "healthy",
      reason: "test fixture",
      recommendedAction: "none",
      stage: "waiting",
      stageAgeMs: 0,
      heartbeatAgeMs: 0,
      outputIdleMs: 0,
      outputStaleAfterMs: 60_000,
    },
  };
}

async function request(
  port: number,
  method: "GET" | "POST",
  route: string,
  options: {
    apiKey?: string;
    cookie?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  const payload = options.body ? JSON.stringify(options.body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...(options.apiKey ? { "X-API-Key": options.apiKey } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer | string) => {
          raw += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            headers: res.headers,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

describe("API-key project object scope", () => {
  let tempRoot: string;
  let alphaRoot: string;
  let betaRoot: string;
  let port: number;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    tempRoot = makeTempDir("quack-api-key-object-scope-");
    alphaRoot = path.join(tempRoot, "alpha");
    betaRoot = path.join(tempRoot, "beta");
    const authRoot = path.join(tempRoot, "auth-root");
    const authDir = path.join(authRoot, ".quack");
    fs.mkdirSync(authDir, { recursive: true });

    const [alphaKeyHash, fleetKeyHash, passwordHash] = await Promise.all([
      hashPassword("alpha-secret"),
      hashPassword("fleet-secret"),
      hashPassword("admin-pass"),
    ]);
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({
        users: [{ username: "admin", passwordHash, role: "admin" }],
        apiKeys: [
          {
            id: "alpha-key",
            name: "Alpha key",
            keyHash: alphaKeyHash,
            role: "admin",
            projectScopes: ["alpha"],
          },
          {
            id: "fleet-key",
            name: "Fleet key",
            keyHash: fleetKeyHash,
            role: "admin",
            projectScopes: ["*"],
          },
        ],
        sessionSecret: "test-secret",
        sessionTtlMs: 60_000,
      }),
      "utf-8",
    );

    port = 45000 + Math.floor(Math.random() * 1000);
    const monitor = createMonitorServer({
      port,
      quackRoot: authRoot,
      // Beta is deliberately active while the narrow key is alpha-only.
      projectAdapters: [makeAdapter(betaRoot, "beta"), makeAdapter(alphaRoot, "alpha")],
    });
    const started = await monitor.start();
    stop = started.stop;
    expect(monitor.registry?.getActiveProjectId()).toBe("beta");
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
    jest.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("uses the explicitly authorized project for every GitHub integration route", async () => {
    const importSpy = jest.spyOn(importPipeline, "importIssue").mockResolvedValue({
      taskId: "TASK-ALPHA",
      issueNumber: 41,
    });
    const publishSpy = jest.spyOn(issuePublisher, "publishTask").mockResolvedValue({
      issueNumber: 42,
      url: "https://github.com/alpha-owner/alpha-repo/issues/42",
    });
    const syncSpy = jest.spyOn(statusSyncer, "syncAllTasks").mockResolvedValue({ outcomes: [] });
    const statusSpy = jest.spyOn(statusSyncer, "getSyncStatus").mockResolvedValue({
      totalEntries: 0,
      entries: [],
    });

    const imported = await request(port, "POST", "/api/github/import", {
      apiKey: "alpha-secret",
      body: { projectId: "alpha", issueNumber: 41 },
    });
    const published = await request(port, "POST", "/api/github/publish", {
      apiKey: "alpha-secret",
      body: { projectId: "alpha", taskId: "TASK-ALPHA" },
    });
    const synced = await request(port, "POST", "/api/github/sync", {
      apiKey: "alpha-secret",
      body: { projectId: "alpha" },
    });
    const status = await request(port, "GET", "/api/github/sync-status?project=alpha", {
      apiKey: "alpha-secret",
    });

    expect(imported.status).toBe(200);
    expect(published.status).toBe(200);
    expect(synced.status).toBe(200);
    expect(status.status).toBe(200);
    expect(importSpy.mock.calls[0]?.[1].projectRoot).toBe(alphaRoot);
    expect(publishSpy.mock.calls[0]?.[1]).toBe(alphaRoot);
    expect(publishSpy.mock.calls[0]?.[2].owner).toBe("alpha-owner");
    expect(syncSpy.mock.calls[0]?.[0].project.root).toBe(alphaRoot);
    expect(statusSpy.mock.calls[0]?.[0].project.root).toBe(alphaRoot);
    expect(status.body.repo).toEqual({ owner: "alpha-owner", repo: "alpha-repo" });
  });

  it("rejects an omitted GitHub project selector when the active project is outside key scope", async () => {
    const importSpy = jest.spyOn(importPipeline, "importIssue").mockResolvedValue({
      taskId: "TASK-ALPHA",
      issueNumber: 41,
    });
    const publishSpy = jest.spyOn(issuePublisher, "publishTask").mockResolvedValue({
      issueNumber: 42,
      url: "https://github.com/alpha-owner/alpha-repo/issues/42",
    });
    const syncSpy = jest.spyOn(statusSyncer, "syncAllTasks").mockResolvedValue({ outcomes: [] });
    const statusSpy = jest.spyOn(statusSyncer, "getSyncStatus").mockResolvedValue({
      totalEntries: 0,
      entries: [],
    });

    const responses = await Promise.all([
      request(port, "POST", "/api/github/import", {
        apiKey: "alpha-secret",
        body: { issueNumber: 41 },
      }),
      request(port, "POST", "/api/github/publish", {
        apiKey: "alpha-secret",
        body: { taskId: "TASK-ALPHA" },
      }),
      request(port, "POST", "/api/github/sync", {
        apiKey: "alpha-secret",
        body: {},
      }),
      request(port, "GET", "/api/github/sync-status", {
        apiKey: "alpha-secret",
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: "API_KEY_SCOPE_MISMATCH",
        projectId: "beta",
      });
    }
    expect(importSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("filters admin-run listing and conceals cross-project run details from a scoped key", async () => {
    const alphaRun = makeAdminRun("alpha-run", "alpha", alphaRoot);
    const betaRun = makeAdminRun("beta-run", "beta", betaRoot);
    const emptyProjectRun = makeAdminRun("empty-project-run", "", betaRoot);
    jest
      .spyOn(AdminRunManager.prototype, "listRuns")
      .mockResolvedValue([alphaRun, betaRun, emptyProjectRun]);
    jest
      .spyOn(AdminRunManager.prototype, "getRun")
      .mockImplementation((runId) =>
        Promise.resolve(
          runId === alphaRun.runId
            ? alphaRun
            : runId === betaRun.runId
              ? betaRun
              : runId === emptyProjectRun.runId
                ? emptyProjectRun
                : undefined,
        ),
      );
    const stopSpy = jest.spyOn(AdminRunManager.prototype, "stopRun").mockReturnValue(true);

    const listed = await request(port, "GET", "/api/admin/runs", {
      apiKey: "alpha-secret",
    });
    const ownDetail = await request(port, "GET", "/API/Admin/Runs/alpha-run/", {
      apiKey: "alpha-secret",
    });
    const foreignDetail = await request(port, "GET", "/api/admin/runs/beta-run", {
      apiKey: "alpha-secret",
    });
    const foreignStop = await request(port, "POST", "/API/Admin/Runs/beta-run/Stop/", {
      apiKey: "alpha-secret",
    });
    const emptyProjectDetail = await request(port, "GET", "/api/admin/runs/empty-project-run", {
      apiKey: "alpha-secret",
    });
    const emptyProjectStop = await request(port, "POST", "/api/admin/runs/empty-project-run/stop", {
      apiKey: "alpha-secret",
    });
    const ownStop = await request(port, "POST", "/api/admin/runs/alpha-run/stop", {
      apiKey: "alpha-secret",
    });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ runs: [alphaRun] });
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.body).toMatchObject({ runId: "alpha-run", projectId: "alpha" });
    expect(foreignDetail.status).toBe(404);
    expect(foreignDetail.body).toEqual({ error: "Admin run not found" });
    expect(foreignStop.status).toBe(404);
    expect(foreignStop.body).toEqual({ ok: false, error: "Admin run not running or not found" });
    expect(emptyProjectDetail.status).toBe(404);
    expect(emptyProjectDetail.body).toEqual({ error: "Admin run not found" });
    expect(emptyProjectStop.status).toBe(404);
    expect(emptyProjectStop.body).toEqual({
      ok: false,
      error: "Admin run not running or not found",
    });
    expect(ownStop.status).toBe(200);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith("alpha-run");
  });

  it("preserves process-wide admin-run access for wildcard keys and sessions", async () => {
    const alphaRun = makeAdminRun("alpha-run", "alpha", alphaRoot);
    const betaRun = makeAdminRun("beta-run", "beta", betaRoot);
    const emptyProjectRun = makeAdminRun("empty-project-run", "", betaRoot);
    jest
      .spyOn(AdminRunManager.prototype, "listRuns")
      .mockResolvedValue([alphaRun, betaRun, emptyProjectRun]);
    jest
      .spyOn(AdminRunManager.prototype, "getRun")
      .mockImplementation((runId) =>
        Promise.resolve(
          runId === alphaRun.runId
            ? alphaRun
            : runId === betaRun.runId
              ? betaRun
              : runId === emptyProjectRun.runId
                ? emptyProjectRun
                : undefined,
        ),
      );
    const stopSpy = jest.spyOn(AdminRunManager.prototype, "stopRun").mockReturnValue(true);

    const wildcardList = await request(port, "GET", "/api/admin/runs", {
      apiKey: "fleet-secret",
    });
    const wildcardDetail = await request(port, "GET", "/api/admin/runs/empty-project-run", {
      apiKey: "fleet-secret",
    });
    const wildcardStop = await request(port, "POST", "/api/admin/runs/empty-project-run/stop", {
      apiKey: "fleet-secret",
    });

    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "admin-pass" },
    });
    const sessionCookie = login.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    expect(sessionCookie).toBeDefined();
    const sessionList = await request(port, "GET", "/api/admin/runs", {
      cookie: sessionCookie,
    });
    const sessionDetail = await request(port, "GET", "/api/admin/runs/empty-project-run", {
      cookie: sessionCookie,
    });
    const sessionStop = await request(port, "POST", "/api/admin/runs/empty-project-run/stop", {
      cookie: sessionCookie,
    });

    expect(wildcardList.status).toBe(200);
    expect(wildcardList.body).toEqual({ runs: [alphaRun, betaRun, emptyProjectRun] });
    expect(wildcardDetail.status).toBe(200);
    expect(wildcardStop.status).toBe(200);
    expect(sessionList.status).toBe(200);
    expect(sessionList.body).toEqual({ runs: [alphaRun, betaRun, emptyProjectRun] });
    expect(sessionDetail.status).toBe(200);
    expect(sessionStop.status).toBe(200);
    expect(stopSpy.mock.calls).toEqual([["empty-project-run"], ["empty-project-run"]]);
  });
});
