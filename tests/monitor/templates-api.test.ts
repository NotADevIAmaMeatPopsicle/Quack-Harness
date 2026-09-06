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
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-templates-"));
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

// ─── Tests ───────────────────────────────────────────────────────

describe("Templates API", () => {
  let logDir: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir();
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("GET /api/templates returns registry with templates and category stats", async () => {
    const projectRoot = makeTempDir();

    // Write a pre-built registry
    const templatesDir = path.join(projectRoot, ".quack", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    const registry = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      templates: [
        {
          category: "api-endpoint",
          sourceTaskId: "TASK-042",
          specTemplate: "Add REST endpoint for <Component>",
          successRate: 0.85,
          avgCostUsd: 2.5,
          filePatterns: ["src/monitor"],
          fileCount: 3,
          tags: ["api"],
        },
      ],
      categoryStats: {
        "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "api-endpoint": { count: 1, avgSuccessRate: 0.85, avgCostUsd: 2.5 },
        testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      },
    };
    fs.writeFileSync(
      path.join(templatesDir, "task-templates.json"),
      JSON.stringify(registry, null, 2),
      "utf-8",
    );

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/templates`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as {
      templates: Array<{ sourceTaskId: string; category: string }>;
      categoryStats: Record<string, { count: number }>;
    };
    expect(data.templates).toHaveLength(1);
    expect(data.templates[0].sourceTaskId).toBe("TASK-042");
    expect(data.templates[0].category).toBe("api-endpoint");
    expect(data.categoryStats["api-endpoint"].count).toBe(1);

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/templates returns empty registry when none exists", async () => {
    const projectRoot = makeTempDir();

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
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

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/templates/:sourceTaskId returns single template", async () => {
    const projectRoot = makeTempDir();

    const templatesDir = path.join(projectRoot, ".quack", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    const registry = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      templates: [
        {
          category: "bug-fix",
          sourceTaskId: "TASK-010",
          specTemplate: "Fix <Component> rendering bug",
          successRate: 0.9,
          avgCostUsd: 1.2,
          filePatterns: ["src/components"],
          fileCount: 2,
          tags: ["bug"],
        },
      ],
      categoryStats: {
        "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "bug-fix": { count: 1, avgSuccessRate: 0.9, avgCostUsd: 1.2 },
        refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
      },
    };
    fs.writeFileSync(
      path.join(templatesDir, "task-templates.json"),
      JSON.stringify(registry, null, 2),
      "utf-8",
    );

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpGet(`http://localhost:${port}/api/templates/TASK-010`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { template: { sourceTaskId: string; category: string } };
    expect(data.template.sourceTaskId).toBe("TASK-010");
    expect(data.template.category).toBe("bug-fix");

    // Test 404 for non-existent template
    const { status: notFoundStatus } = await httpGet(
      `http://localhost:${port}/api/templates/TASK-999`,
    );
    expect(notFoundStatus).toBe(404);

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("POST /api/templates/rebuild creates registry from completed tasks", async () => {
    const projectRoot = makeTempDir();

    // Create a completed task file
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "TASK-020-complete.md"),
      [
        "# TASK-020: Complete Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2-4 hours",
        "- **Status:** COMPLETE",
        "- **Blocked By:** []",
        "- **Tags:** api",
        "",
        "## Problem Statement",
        "A completed task for template extraction",
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
        "| src/server.ts | Modify | Main server |",
      ].join("\n"),
      "utf-8",
    );

    // Create session log with history for this task
    const logsDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const sessions = [
      {
        taskId: "TASK-020",
        sessionId: "s1",
        outcome: "approved",
        costUsd: 2.0,
        turnsUsed: 10,
        retriesUsed: 0,
        taskTags: ["api"],
        targetFiles: ["src/server.ts"],
        criteriaResults: [{ criterion: "Criterion 1", status: "PASS" }],
        feedbackThemes: [],
        gateScore: 4.0,
        complexity: { filesToModify: 1, successCriteria: 1 },
      },
    ];
    fs.writeFileSync(
      path.join(logsDir, "sessions.jsonl"),
      sessions.map((s) => JSON.stringify(s)).join("\n") + "\n",
      "utf-8",
    );

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/templates/rebuild`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { ok: boolean; templateCount: number; updatedAt: string };
    expect(data.ok).toBe(true);
    expect(data.templateCount).toBe(1);
    expect(data.updatedAt).toBeDefined();

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("POST /api/templates/extract returns extracted template from a task", async () => {
    const projectRoot = makeTempDir();

    // Create a completed task file
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "TASK-030-feature.md"),
      [
        "# TASK-030: Feature Task",
        "",
        "## Metadata",
        "- **Priority:** P2-MEDIUM",
        "- **Effort:** 4-6 hours",
        "- **Status:** COMPLETE",
        "- **Blocked By:** []",
        "- **Tags:** feature, dashboard",
        "",
        "## Problem Statement",
        "Implement dashboard feature",
        "",
        "## Success Criteria",
        "- Feature works",
        "",
        "## Testing Requirements",
        "- Test it",
        "",
        "## Files to Modify",
        "| File | Action | Notes |",
        "|------|--------|-------|",
        "| src/dashboard/panel.ts | Create | New panel |",
        "| src/dashboard/index.ts | Modify | Register panel |",
      ].join("\n"),
      "utf-8",
    );

    // Create session log with history for this task
    const logsDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const sessions = [
      {
        taskId: "TASK-030",
        sessionId: "s1",
        outcome: "approved",
        costUsd: 3.5,
        turnsUsed: 15,
        retriesUsed: 0,
        taskTags: ["feature", "dashboard"],
        targetFiles: ["src/dashboard/panel.ts", "src/dashboard/index.ts"],
        criteriaResults: [{ criterion: "Feature works", status: "PASS" }],
        feedbackThemes: [],
        gateScore: 4.5,
        complexity: { filesToModify: 2, successCriteria: 1 },
      },
    ];
    fs.writeFileSync(
      path.join(logsDir, "sessions.jsonl"),
      sessions.map((s) => JSON.stringify(s)).join("\n") + "\n",
      "utf-8",
    );

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status, body } = await httpPost(`http://localhost:${port}/api/templates/extract`, {
      taskId: "TASK-030",
    });
    expect(status).toBe(200);

    const data = JSON.parse(body) as {
      ok: boolean;
      template: { sourceTaskId: string; category: string; tags: string[] };
    };
    expect(data.ok).toBe(true);
    expect(data.template.sourceTaskId).toBe("TASK-030");
    expect(data.template.tags).toContain("feature");

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("POST /api/templates/extract returns 400 when taskId missing", async () => {
    const projectRoot = makeTempDir();

    const port = await freePort();
    const serverObj = createMonitorServer({ logDir, port, projectRoot });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const { status } = await httpPost(`http://localhost:${port}/api/templates/extract`, {});
    expect(status).toBe(400);

    await stopServer();
    stopServer = undefined;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});
