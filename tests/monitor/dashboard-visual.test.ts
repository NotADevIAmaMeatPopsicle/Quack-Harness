import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

import { createMonitorServer } from "../../src/monitor/server";
import { computeContentHash } from "../../src/monitor/prep-cache";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

jest.setTimeout(120_000);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

describe("Monitor UI 2.0 production smoke", () => {
  let logDir: string;
  let projectRoot: string;
  let uiBuildDir: string;
  let stopServer: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let consoleErrors: string[];
  let pageErrors: string[];
  const port = 30000 + Math.floor(Math.random() * 10000);

  beforeAll(async () => {
    logDir = makeTempDir("quack-vis-log-");
    projectRoot = makeTempDir("quack-vis-proj-");
    uiBuildDir = path.join(process.cwd(), "frontend", "dist");
    consoleErrors = [];
    pageErrors = [];

    execSync("npm --prefix frontend run build", {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const taskDir = path.join(projectRoot, "docs", "tasks");
    const prepDir = path.join(projectRoot, ".quack", "prep");
    const listenerDir = path.join(projectRoot, ".quack", "federation", "listeners");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(prepDir, { recursive: true });
    fs.mkdirSync(listenerDir, { recursive: true });

    const tasks = [
      { id: "TASK-001", title: "Ready Task", priority: "P1-HIGH", status: "READY" },
      { id: "TASK-002", title: "In Progress Task", priority: "P0-CRITICAL", status: "IN_PROGRESS" },
      { id: "TASK-003", title: "Complete Task", priority: "P2-MEDIUM", status: "COMPLETE" },
    ];

    for (const task of tasks) {
      fs.writeFileSync(
        path.join(taskDir, `${task.id}-smoke.md`),
        [
          `# ${task.id}: ${task.title}`,
          "",
          "## Metadata",
          `- **Priority:** ${task.priority}`,
          "- **Effort:** 1-2 hours",
          `- **Status:** ${task.status}`,
          "- **Blocked By:** []",
          "- **Tags:** smoke",
          "",
          "## Problem Statement",
          "Smoke validation task.",
          "",
          "## Success Criteria",
          "- UI 2.0 route loads this task.",
          "",
          "## Testing Requirements",
          "- Browser smoke only.",
        ].join("\n"),
        "utf-8",
      );
    }

    fs.writeFileSync(
      path.join(prepDir, "TASK-001.json"),
      JSON.stringify(
        {
          taskId: "TASK-001",
          preparedAt: new Date().toISOString(),
          schemaValid: true,
          schemaErrors: [],
          depthScore: 5,
          depthReady: true,
          deficiencies: [],
          outcome: "pass",
          stale: false,
          contentHash: computeContentHash(
            fs.readFileSync(path.join(taskDir, "TASK-001-smoke.md"), "utf-8"),
          ),
        },
        null,
        2,
      ),
      "utf-8",
    );

    const listeners = [
      {
        id: "headnode",
        alias: "headnode",
        capabilities: ["dispatch", "fix", "verify"],
        enabled: true,
        healthy: true,
        lastHealthCheckAt: new Date().toISOString(),
        currentLoad: 0,
        maxConcurrentJobs: 2,
        repoCommit: "abc12345fedcba",
        metadata: {},
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "worker-b",
        alias: "worker-b",
        capabilities: ["dispatch", "fix", "intake", "verify", "browser"],
        enabled: true,
        healthy: true,
        lastHealthCheckAt: new Date().toISOString(),
        currentLoad: 0,
        maxConcurrentJobs: 1,
        repoCommit: "deadbeef112233",
        metadata: {},
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "laptop",
        alias: "laptop",
        capabilities: ["dispatch", "fix", "intake", "verify"],
        enabled: true,
        healthy: true,
        lastHealthCheckAt: new Date().toISOString(),
        currentLoad: 0,
        maxConcurrentJobs: 1,
        repoCommit: "cafefeed445566",
        metadata: {},
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    for (const listener of listeners) {
      fs.writeFileSync(
        path.join(listenerDir, `${listener.id}.json`),
        JSON.stringify(listener, null, 2),
        "utf-8",
      );
    }

    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      taskDir: "docs/tasks",
      uiBuildDir,
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const sourceUrl = message.location().url;
        consoleErrors.push(sourceUrl ? `${message.text()} (${sourceUrl})` : message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(`http://localhost:${port}/`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Overview", { timeout: 15_000 });
  });

  afterAll(async () => {
    if (page) {
      await page.close();
      page = undefined;
    }
    if (browser) {
      await browser.close();
      browser = undefined;
    }
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    removeTempDir(logDir);
    removeTempDir(projectRoot);
  });

  it("loads the integrated React shell at / with the operator navigation", async () => {
    if (!page) throw new Error("Playwright page not initialized");

    await expectText(page, "Quack Harness");
    await expectText(page, "Overview");
    await expectText(page, "Tasks");
    await expectText(page, "Fleet");
    await expectText(page, "Worker Hosts");
    await expectText(page, "Attention Board");
    await expectText(page, "Dispatch Watch");
    await expectText(page, "Dispatch Readiness");
    await expectText(page, "headnode");
    await expectText(page, "worker-b");
    await expectText(page, "laptop");
  });

  it("navigates to Tasks and shows real task data from the monitor API", async () => {
    if (!page) throw new Error("Playwright page not initialized");

    await page.click("text=Tasks");
    await page.waitForSelector("table", { timeout: 15_000 });
    await expectText(page, "TASK-001");
    await expectText(page, "Ready Task");
  });

  it("supports direct task-detail routes through the production app shell", async () => {
    if (!page) throw new Error("Playwright page not initialized");

    await page.goto(`http://localhost:${port}/tasks/TASK-001`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Run History", { timeout: 15_000 });
    await expectText(page, "TASK-001");
  });

  it("keeps the classic dashboard available at /legacy", async () => {
    if (!page) throw new Error("Playwright page not initialized");

    await page.goto(`http://localhost:${port}/legacy`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Dashboard", { timeout: 15_000 });
    await expect(page.title()).resolves.toContain("Quack Monitor");
  });

  it("does not emit browser console or page errors during the smoke flow", () => {
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

async function expectText(page: Page, text: string): Promise<void> {
  await page.waitForSelector(`text=${text}`, { timeout: 15_000 });
}
