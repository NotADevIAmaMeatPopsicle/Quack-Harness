import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";
import { createMonitorServer } from "../../src/monitor/server.js";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-list-contracts-"));
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

async function httpPostJson(
  url: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function writeTask(
  taskDir: string,
  id: string,
  title: string,
  status: string,
  priority: string,
): void {
  fs.writeFileSync(
    path.join(taskDir, `${id}-${title.toLowerCase().replace(/\s+/g, "-")}.md`),
    [
      `# ${id}: ${title}`,
      "",
      "## Metadata",
      `- **Priority:** ${priority}`,
      "- **Effort:** 1 hour",
      `- **Status:** ${status}`,
      "- **Blocked By:** []",
      "- **Tags:** ui-2-0",
      "",
      "## Problem Statement",
      "Test task.",
      "",
      "## Success Criteria",
      "- Works",
      "",
      "## Testing Requirements",
      "- API test",
    ].join("\n"),
    "utf-8",
  );
}

function makeAdapter(projectRoot: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0.0",
    project: {
      name: "List Contracts",
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
    verification: {
      commands: [
        { name: "test", command: "echo test", phase: "all", required: true, timeout: 30000 },
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

  return {
    projectRoot,
    config,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("monitor list API contracts", () => {
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | null = null;

  beforeEach(() => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    writeTask(taskDir, "TASK-001", "Backlog Task", "BACKLOG", "P2-MEDIUM");
    writeTask(taskDir, "TASK-002", "Complete Task", "COMPLETE", "P1-HIGH");
    writeTask(taskDir, "TASK-003", "Ready Task", "READY", "P0-CRITICAL");
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns paged and sorted task list metadata while keeping parse metadata", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const res = await httpGet(
      `http://127.0.0.1:${port}/api/tasks?page=1&perPage=2&sort=id&order=desc`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      tasks: Array<{ id: string }>;
      parsedTaskCount: number;
      filteredTaskCount: number;
      pagination: {
        page: number;
        perPage: number;
        totalItems: number;
        totalPages: number;
        hasNextPage: boolean;
      };
      parseErrorCount: number;
    };

    expect(body.tasks.map((task) => task.id)).toEqual(["TASK-003", "TASK-002"]);
    expect(body.parsedTaskCount).toBe(3);
    expect(body.filteredTaskCount).toBe(3);
    expect(body.pagination).toMatchObject({
      page: 1,
      perPage: 2,
      totalItems: 3,
      totalPages: 2,
      hasNextPage: true,
    });
    expect(body.parseErrorCount).toBe(0);
  });

  it("filters task lists by excluded effective status", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const res = await httpGet(
      `http://127.0.0.1:${port}/api/tasks?excludeStatus=COMPLETE,VERIFIED&sort=id&order=asc`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      tasks: Array<{ id: string; effectiveStatus: string }>;
      filteredTaskCount: number;
    };

    expect(body.tasks.map((task) => task.id)).toEqual(["TASK-001", "TASK-003"]);
    expect(body.tasks.map((task) => task.effectiveStatus)).toEqual(["BACKLOG", "READY"]);
    expect(body.filteredTaskCount).toBe(2);
  });

  it("reports backlog hygiene through the task inventory endpoints", async () => {
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.writeFileSync(
      path.join(taskDir, "TASK-001-duplicate.md"),
      [
        "# TASK-001: Duplicate Backlog Task",
        "",
        "## Metadata",
        "- **Priority:** P2-MEDIUM",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "",
        "## Problem Statement",
        "Duplicate id.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Testing Requirements",
        "- API test",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(taskDir, "TASK-004-superseded.md"),
      [
        "# TASK-004: Superseded Task",
        "",
        "## Metadata",
        "- **Priority:** P2-MEDIUM",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Superseded By:** [TASK-999]",
        "- **Blocked By:** []",
        "",
        "## Problem Statement",
        "Superseded work.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Testing Requirements",
        "- API test",
      ].join("\n"),
      "utf-8",
    );

    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const inventory = await httpGet(`http://127.0.0.1:${port}/api/tasks`);
    expect(inventory.status).toBe(200);
    const inventoryBody = JSON.parse(inventory.body) as {
      hygiene?: {
        duplicateIds: Array<{ taskId: string; files: string[] }>;
        supersededTasks: Array<{ taskId: string; supersededBy: string[] }>;
      };
    };
    expect(inventoryBody.hygiene?.duplicateIds).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "TASK-001" })]),
    );
    expect(inventoryBody.hygiene?.supersededTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "TASK-004", supersededBy: ["TASK-999"] }),
      ]),
    );

    const hygiene = await httpGet(`http://127.0.0.1:${port}/api/tasks/hygiene`);
    expect(hygiene.status).toBe(200);
    const hygieneBody = JSON.parse(hygiene.body) as {
      duplicateIds: Array<{ taskId: string }>;
      supersededTasks: Array<{ taskId: string }>;
    };
    expect(hygieneBody.duplicateIds).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "TASK-001" })]),
    );
    expect(hygieneBody.supersededTasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "TASK-004" })]),
    );
  });

  it("keeps legacy sessions array mode and adds explicit paged sessions mode", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const ctx = server.registry?.getActiveProject();
    expect(ctx).toBeDefined();
    ctx!.db.upsertSession({
      session_id: "sess-001",
      task_id: "TASK-001",
      project: "list-contracts",
      title: "Backlog Task",
      start_time: "2026-04-30T10:00:00.000Z",
      status: "completed",
      outcome: "approved",
      total_cost_usd: 1,
      duration_ms: 1000,
      turns_used: 2,
    });
    ctx!.db.upsertSession({
      session_id: "sess-002",
      task_id: "TASK-002",
      project: "list-contracts",
      title: "Complete Task",
      start_time: "2026-04-30T11:00:00.000Z",
      status: "error",
      outcome: "agent_failed",
      total_cost_usd: 2,
      duration_ms: 2000,
      turns_used: 4,
    });
    ctx!.db.upsertSession({
      session_id: "sess-003",
      task_id: "TASK-003",
      project: "list-contracts",
      title: "Ready Task",
      start_time: "2026-04-30T12:00:00.000Z",
      status: "completed",
      outcome: "approved",
      total_cost_usd: 3,
      duration_ms: 3000,
      turns_used: 6,
    });

    const legacy = await httpGet(`http://127.0.0.1:${port}/api/sessions?limit=2`);
    expect(legacy.status).toBe(200);
    const legacyBody = JSON.parse(legacy.body) as Array<{ sessionId: string }>;
    expect(Array.isArray(legacyBody)).toBe(true);
    expect(legacyBody).toHaveLength(2);

    const paged = await httpGet(
      `http://127.0.0.1:${port}/api/sessions?paged=true&page=1&perPage=2&excludeStatus=error&sort=taskId&order=asc`,
    );
    expect(paged.status).toBe(200);
    const pagedBody = JSON.parse(paged.body) as {
      sessions: Array<{ sessionId: string; taskId: string; status: string }>;
      pagination: { totalItems: number; totalPages: number; hasNextPage: boolean };
    };
    expect(pagedBody.sessions.map((session) => session.taskId)).toEqual(["TASK-001", "TASK-003"]);
    expect(pagedBody.sessions.every((session) => session.status !== "error")).toBe(true);
    expect(pagedBody.pagination).toMatchObject({
      totalItems: 2,
      totalPages: 1,
      hasNextPage: false,
    });
  });

  it("returns task-specific runs from SQLite before file-backed session logs", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const ctx = server.registry?.getActiveProject();
    expect(ctx).toBeDefined();
    ctx!.db.upsertSession({
      session_id: "db-run-001",
      task_id: "TASK-001",
      project: "list-contracts",
      title: "Backlog Task",
      start_time: "2026-04-30T10:00:00.000Z",
      status: "completed",
      outcome: "approved",
      total_cost_usd: 1.5,
      duration_ms: 1000,
      turns_used: 2,
    });
    ctx!.db.upsertSession({
      session_id: "db-run-002",
      task_id: "TASK-002",
      project: "list-contracts",
      title: "Complete Task",
      start_time: "2026-04-30T11:00:00.000Z",
      status: "completed",
      outcome: "approved",
      total_cost_usd: 2.5,
      duration_ms: 2000,
      turns_used: 4,
    });

    const res = await httpGet(`http://127.0.0.1:${port}/api/tasks/TASK-001/runs`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      sessionId: string;
      taskId: string;
      totalCostUsd: number;
      turnsUsed: number;
      gateScore: number | null;
    }>;

    expect(body).toEqual([
      {
        sessionId: "db-run-001",
        taskId: "TASK-001",
        project: "list-contracts",
        title: "Backlog Task",
        startTime: "2026-04-30T10:00:00.000Z",
        status: "completed",
        outcome: "approved",
        totalCostUsd: 1.5,
        durationMs: 1000,
        turnsUsed: 2,
        gateScore: null,
      },
    ]);
  });

  it("updates task status through the dashboard status endpoint", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const update = await httpPostJson(`http://127.0.0.1:${port}/api/tasks/TASK-001/status`, {
      status: "IN_PROGRESS",
    });
    expect(update.status).toBe(200);
    expect(JSON.parse(update.body)).toMatchObject({
      ok: true,
      taskId: "TASK-001",
      status: "IN_PROGRESS",
    });

    const tasks = await httpGet(`http://127.0.0.1:${port}/api/tasks?status=IN_PROGRESS`);
    const body = JSON.parse(tasks.body) as {
      tasks: Array<{ id: string; effectiveStatus: string }>;
    };
    expect(body.tasks).toEqual([
      expect.objectContaining({ id: "TASK-001", effectiveStatus: "IN_PROGRESS" }),
    ]);
  });

  it("returns quiet batch prep and preflight cache lookups for dashboard startup", async () => {
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [makeAdapter(projectRoot)],
    });
    const started = await server.start();
    stopServer = started.stop;
    const { port } = started;

    const prep = await httpGet(`http://127.0.0.1:${port}/api/tasks/prep-cache`);
    expect(prep.status).toBe(200);
    expect(JSON.parse(prep.body)).toEqual({ results: {} });

    const preflight = await httpGet(`http://127.0.0.1:${port}/api/tasks/preflight-cache`);
    expect(preflight.status).toBe(200);
    expect(JSON.parse(preflight.body)).toEqual({ results: {} });
  });
});
