import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as trustedNode from "../../src/monitor/trusted-node-launch";
import { DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { QuackDB } from "../../src/db";
import { createMonitorServer } from "../../src/monitor/server";
import { ReadinessService } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import { EventReader } from "../../src/monitor/event-reader";
import { PrepCache, computeContentHash } from "../../src/monitor/prep-cache";
import { evaluateFederatedSchedulingGate } from "../../src/monitor/federation/scheduling";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import type { FederationProjectContext } from "../../src/monitor/federation/types";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { taskSpec } from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

jest.setTimeout(45_000);

describe("operator prep provenance", () => {
  const taskId = "TASK-1353";
  const content = taskSpec(taskId);
  const hash = computeContentHash(content);
  const realPrep = {
    taskId,
    preparedAt: "2026-09-13T00:00:00.000Z",
    schemaValid: true,
    schemaErrors: [],
    depthScore: 4.9,
    depthReady: true,
    deficiencies: [],
    outcome: "pass" as const,
    contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
  };
  let root: string;
  let db: QuackDB;
  let service: ReadinessService;
  let project: FederationProjectContext;
  let origin: string;
  let stop: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;

  function preflight(skipped = true): PreflightResult {
    return {
      taskId,
      timestamp: "2026-09-13T00:01:00.000Z",
      contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
      gate: { ready: true, score: 5, dimensions: {}, gateSkipped: skipped },
      blueprint: {
        fileAnalyses: 0,
        codeExamples: 0,
        verificationPatterns: 0,
        antiPatterns: 0,
        formattedMarkdown: "fixture",
      },
      complexity: {
        filesToModify: 1,
        successCriteria: 1,
        estimatedContextTokens: 0,
        independentFeatures: 1,
        featureClusters: [],
        recommendDecomposition: false,
        reason: "fixture",
      },
      contextEstimate: {
        taskSpec: 0,
        blueprint: 0,
        repoMap: 0,
        relevantFiles: 0,
        relatedPatterns: 0,
        existingTests: 0,
        conventions: 0,
        claudeMd: 0,
        total: 0,
        withinBudget: true,
      },
    };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-display-"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "tasks", `${taskId}.md`), content);
    const monitor = createMonitorServer({
      projectRoot: root,
      taskDir: "docs/tasks",
      logDir: path.join(root, ".quack", "logs"),
      host: "127.0.0.1",
      port: 0,
      quackRoot: root,
    });
    const started = await monitor.start();
    stop = started.stop;
    origin = `http://127.0.0.1:${started.port}`;
    db = new QuackDB(path.join(root, ".quack", "quack.db"));
    project = {
      projectId: "fixture",
      projectRoot: root,
      db,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: new PrepCache(root),
      reader: new EventReader(path.join(root, ".quack", "logs")),
    };
    service = new ReadinessService({ ...project, projectRoot: root });
  });

  afterEach(async () => {
    try {
      if (browser) await browser.close();
      browser = undefined;
      if (stop) await stop();
      stop = undefined;
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  async function get(route: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}${route}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function prepResponses(): Promise<Record<string, unknown>[]> {
    const single = await get(`/api/tasks/${taskId}/prep`);
    const bulk = await get("/api/tasks/prep-cache");
    expect(single.status).toBe(200);
    expect(bulk.status).toBe(200);
    return [single.body, (bulk.body.results as Record<string, Record<string, unknown>>)[taskId]];
  }

  const job = queueFederatedJobRecord({
    taskId,
    jobType: "dispatch",
    requiredCapabilities: ["dispatch"],
    provenance: { channel: "federation-queue" },
  });

  test("skipped-only projection is labelled on both endpoints while scheduling refuses", async () => {
    service.persistPreflightResult(taskId, content, preflight());
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
      ok: false,
      error: "preflight_gate_missing",
    });
    for (const result of await prepResponses()) {
      expect(result).toMatchObject({ evidenceSource: "snapshot_projection", stale: false });
    }
  });

  test.each(["db", "file"])(
    "stale %s prep stays visible through a current projection without changing admission state",
    async (source) => {
      if (source === "db") service.persistPrepResult(taskId, `${content}\nolder`, realPrep);
      else await project.prepCache!.write({ ...realPrep, contentHash: "older" });
      service.persistPreflightResult(taskId, content, preflight());
      for (const result of await prepResponses()) {
        expect(result).toMatchObject({ evidenceSource: "snapshot_projection", stale: true });
      }
      expect(await service.resolveCurrent(taskId)).toMatchObject({
        prep: { stale: false },
        hasStalePrep: true,
        admissionPrep: null,
      });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
        ok: false,
        error: "preflight_gate_stale",
      });
    },
  );

  test("current prep retains its evidence and score even with skipped preflight", async () => {
    service.persistPrepResult(taskId, content, realPrep);
    service.persistPreflightResult(taskId, content, preflight());
    for (const result of await prepResponses()) {
      expect(result).toMatchObject({
        evidenceSource: "prep_record",
        depthScore: 4.9,
        stale: false,
      });
    }
    expect(await service.getCurrentGateScore(taskId)).toBe(4.9);
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
  });

  test("schema diagnostics survive projection labelling", async () => {
    const failed = preflight(false);
    failed.gate = {
      ready: false,
      score: 0,
      dimensions: {},
      reason: "Schema validation failed",
      schemaErrors: ["required section"],
    };
    service.persistPreflightResult(taskId, content, failed);
    for (const result of await prepResponses()) {
      expect(result).toMatchObject({
        evidenceSource: "snapshot_projection",
        schemaValid: false,
        schemaErrors: ["required section"],
      });
    }
    expect(await service.getCurrentGateScore(taskId)).toBe(0);
  });

  test("missing and stale-only results retain their 404 response", async () => {
    expect(await get(`/api/tasks/${taskId}/prep`)).toMatchObject({
      status: 404,
      body: { stale: false },
    });
    expect((await get("/api/tasks/prep-cache")).body).toEqual({ results: {} });
    service.persistPrepResult(taskId, `${content}\nolder`, realPrep);
    expect(await get(`/api/tasks/${taskId}/prep`)).toMatchObject({
      status: 404,
      body: { stale: true, currentSpecHash: hash },
    });
  });

  test("session and task-run APIs exclude synthetic scores and retain genuine preflight scores", async () => {
    service.persistPreflightResult(taskId, content, preflight());
    db.upsertSession({
      session_id: "fixture-session",
      task_id: taskId,
      project: "fixture",
      title: "Fixture",
      start_time: "2026-09-13T00:00:00.000Z",
      status: "completed",
      outcome: "approved",
      total_cost_usd: 0,
      duration_ms: 100,
      turns_used: 1,
    });
    for (const route of ["/api/sessions", `/api/tasks/${taskId}/runs`]) {
      const response = await fetch(`${origin}${route}`);
      const sessions = (await response.json()) as Array<{
        sessionId: string;
        gateScore: number | null;
      }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("fixture-session");
      expect(sessions[0].gateScore).toBeNull();
    }
    service.persistPreflightResult(taskId, content, preflight(false));
    expect(await service.getCurrentGateScore(taskId)).toBe(5);
  });

  async function openLegacy(): Promise<Page> {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${origin}/legacy`);
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.waitForSelector("#tasksBody tbody tr");
    return page;
  }

  test("legacy browser clears old scores and labels projections, stale prep and skipped gate details", async () => {
    service.persistPrepResult(taskId, content, realPrep);
    const page = await openLegacy();
    expect(await page.locator("#tasksBody tbody .task-prep-badge").textContent()).toBe("Ready");
    // Replace the current DB evidence with a preflight-only row, as a refresh
    // from another producer would. The browser must not retain its old 4.9.
    const snapshot = db.getReadinessSnapshot(taskId, hash)!;
    db.upsertReadinessSnapshot({ ...snapshot, prep_data: null });
    service.persistPreflightResult(taskId, content, preflight());
    await page.evaluate("loadPrepStatus().then(loadPreflightCache).then(renderTasks)");
    expect(await page.locator("#tasksBody tbody .task-prep-badge").textContent()).toBe(
      "Prep needed",
    );
    expect(await page.locator("#tasksBody tbody .gate-score").count()).toBe(0);
    expect(await page.evaluate("taskGateScores.size")).toBe(0);
    await page.evaluate(
      `document.body.insertAdjacentHTML('beforeend', '<div id="preflight-panel-${taskId}"></div>'); renderPreflightPanel('${taskId}', preflightTaskData['${taskId}']);`,
    );
    const report = page.locator(`#preflight-panel-${taskId}`);
    expect(await report.textContent()).toContain("SKIPPED");
    expect(await report.textContent()).not.toContain("5/5");
    service.persistPrepResult(taskId, `${content}\nolder`, realPrep);
    await page.evaluate("loadPrepStatus().then(renderTasks)");
    expect(await page.locator("#tasksBody tbody .task-prep-badge").textContent()).toBe("Stale");
  });

  test("legacy dashboard labels policy-stale preflight without publishing its old passing score", async () => {
    const old = preflight(false);
    delete old.schemaPolicyHash;
    service.persistPreflightResult(taskId, content, old);
    const page = await openLegacy();
    expect(await page.locator("#tasksBody tbody .gate-score").count()).toBe(0);
    await page.evaluate(
      `document.body.insertAdjacentHTML('beforeend', '<div id="preflight-panel-${taskId}"></div>'); renderPreflightPanel('${taskId}', preflightTaskData['${taskId}']);`,
    );
    const report = page.locator(`#preflight-panel-${taskId}`);
    expect(await report.textContent()).toContain("STALE");
    expect(await report.textContent()).not.toContain("5/5");
    expect(await report.textContent()).toContain("run prep or preflight again");
  });

  async function attemptPage(): Promise<Page> {
    service.persistPrepResult(taskId, content, realPrep);
    const page = await openLegacy();
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="prep-status-${taskId}"><div id="prep-status-content-${taskId}"></div></div><button id="prep-btn-${taskId}">Prep</button>');`);
    return page;
  }
  const attemptId = "00000000-0000-4000-8000-000000001357";
  const attemptJob = (status = "running", extra = {}) => ({ jobId: attemptId, taskId, status, ...extra });
  const waitState = (page: Page, status: string) => page.waitForFunction(`prepJobs.state('${taskId}')?.status === '${status}'`);

  test("legacy polling follows its job through old cache, bounded observation and computed rejection", async () => {
    const page = await attemptPage();
    let posts = 0; let terminal = false;
    let result = { ...realPrep };
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      if (route.request().method() === "POST") { posts++; await route.fulfill({ json: { jobId: attemptId } }); }
      else if (new URL(route.request().url()).pathname.endsWith('/job')) {
        await route.fulfill({ json: { job: attemptJob(terminal ? "completed" : "running", { result }) } });
      } else await route.fulfill({ json: { ...result, evidenceSource: "prep_record", stale: false } });
    });
    await page.evaluate(`prepTask('${taskId}')`);
    await page.clock.runFor(2000);
    await page.evaluate("loadPrepStatus().then(renderTasks)");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Prepping...");
    expect(await page.locator("#tasksBody .gate-score").count()).toBe(0);
    terminal = true; await page.evaluate(`checkPrepStatus('${taskId}')`);
    await waitState(page, "completed");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("Gate passed for this attempt");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Ready");
    expect(await page.locator("#tasksBody .gate-score").textContent()).toBe("4.9");
    expect(await page.locator("#tasksBody .task-status-badge").textContent()).toBe("READY");
    expect(await page.locator("#tasksBody .preflight-row-btn").count()).toBe(1);
    terminal = false; await page.evaluate(`prepTask('${taskId}')`);
    await page.clock.runFor(91000); await waitState(page, "unconfirmed");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("worker may still be running");
    terminal = true; result = { ...realPrep, depthReady: false, depthScore: 3, outcome: "rejected" as typeof realPrep.outcome };
    await page.evaluate(`checkPrepStatus('${taskId}')`); await waitState(page, "completed");
    expect(posts).toBe(2);
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("did not pass for this attempt");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Not Ready");
  });

  test.each(["snapshot_projection", "stale", "changed-policy"])("terminal report with %s readiness cannot publish a current score", async evidence => {
    const page = await attemptPage();
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      const json = route.request().method() === "POST" ? { jobId: attemptId }
        : new URL(route.request().url()).pathname.endsWith('/job') ? { job: attemptJob("completed", { result: realPrep }) }
        : { ...realPrep, evidenceSource: evidence === "snapshot_projection" ? evidence : "prep_record", stale: evidence === "stale",
          ...(evidence === "changed-policy" ? { schemaPolicyHash: "f".repeat(64) } : {}) };
      await route.fulfill({ json });
    });
    await page.evaluate(`prepTask('${taskId}')`); await waitState(page, "completed");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("Current readiness unavailable");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("Gate passed for this attempt");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Prep needed");
    expect(await page.locator("#tasksBody .gate-score").count()).toBe(0);
  });

  test("actual worker close publishes its own terminal report and reload observes the same active child", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 54545, exitCode: null as number | null,
      signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const spy = jest.spyOn(trustedNode, "spawnTrustedNode").mockImplementation(options => {
      if (options.args[0] !== "prep") throw new Error("Unexpected child launch");
      return { child: child as unknown as ChildProcess, executablePath: process.execPath, processId: child.pid };
    });
    try {
      const page = await attemptPage(); await page.evaluate(`prepTask('${taskId}')`);
      expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Prepping...");
      const captured = await page.evaluate(`prepJobs.state('${taskId}').jobId`);
      await page.reload(); await page.getByRole("button", { name: "Tasks", exact: true }).click();
      await page.clock.runFor(1000);
      await waitState(page, "running");
      expect(await page.evaluate(`prepJobs.state('${taskId}').jobId`)).toBe(captured);
      expect(spy).toHaveBeenCalledTimes(1);
      child.stdout.emit("data", Buffer.from(JSON.stringify(realPrep)));
      child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null);
      await page.evaluate(`checkPrepStatus('${taskId}')`); await waitState(page, "completed");
      expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Ready");
      expect(await page.locator("#tasksBody .gate-score").textContent()).toBe("4.9");
      expect(await page.evaluate(`prepJobs.state('${taskId}').result.depthScore`)).toBe(4.9);
    } finally {
      if (child.exitCode === null) { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); }
      spy.mockRestore();
    }
  });

  test.each(["missing", "unavailable"])("legacy %s recovery offers explicit Start new prep", async status => {
    const page = await attemptPage(); let posts = 0;
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      if (route.request().method() === "POST") { posts++; await route.fulfill({ json: { jobId: attemptId } }); }
      else if (posts > 1) await route.fulfill({ json: { job: attemptJob() } });
      else if (status === "missing") await route.fulfill({ status: 404, json: { code: "PREP_ATTEMPT_NOT_FOUND", error: "No prep attempt recorded" } });
      else await route.fulfill({ json: { job: attemptJob("completed", { jobId: "00000000-0000-4000-8000-000000001358", result: realPrep }) } });
    });
    await page.evaluate(`prepTask('${taskId}')`);
    expect(await page.locator(`#prep-btn-${taskId}`).textContent()).toBe("Start new prep");
    expect(posts).toBe(1); await page.locator(`#prep-btn-${taskId}`).click(); await waitState(page, "running");
    expect(posts).toBe(2);
  });

  test("terminal prep restores independent preflight score and worker failure has its own badge", async () => {
    service.persistPreflightResult(taskId, content, preflight(false));
    const page = await attemptPage(); let failed = false;
    await page.evaluate(`preflightTaskData['${taskId}'] = ${JSON.stringify({ ...preflight(false), stale: false })}; renderTasks();`);
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      await route.fulfill({ json: route.request().method() === "POST" ? { jobId: attemptId }
        : new URL(route.request().url()).pathname.endsWith('/job') ? { job: failed ? attemptJob("failed", { error: "provider crashed" }) : attemptJob("completed", { result: realPrep }) }
        : { ...realPrep, stale: true, evidenceSource: "prep_record" } });
    });
    await page.evaluate(`prepTask('${taskId}')`); await waitState(page, "completed");
    expect(await page.locator("#tasksBody .gate-score").textContent()).toBe("5.0");
    failed = true; await page.evaluate(`prepTask('${taskId}')`); await waitState(page, "failed");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Prep failed");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("provider crashed");
  });

  test("a missing submission ID cannot adopt an old terminal report and offers explicit recovery", async () => {
    const page = await attemptPage(); let posts = 0;
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      if (route.request().method() === "POST") { posts++; await route.fulfill({ json: { ok: true } }); }
      else await route.fulfill({ json: { job: attemptJob("completed", { result: realPrep }) } });
    });
    await page.evaluate(`prepTask('${taskId}')`);
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("Submission could not be confirmed");
    expect(await page.locator(`#prep-btn-${taskId}`).textContent()).toBe("Start new prep");
    expect(posts).toBe(1);
    const posted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/prep"));
    await page.locator(`#prep-btn-${taskId}`).click();
    await posted; await waitState(page, "unavailable");
    expect(posts).toBe(2);
    expect(await page.locator("#tasksBody .gate-score").count()).toBe(0);
  });

  test("contract-invalid current prep cannot supply a session score", async () => {
    service.persistPrepResult(taskId, content, { ...realPrep, outcome: "rejected" });
    const raw = db.getReadinessSnapshot(taskId, hash)!.prep_data;
    db.upsertSession({ session_id: "invalid-prep-session", task_id: taskId, project: "fixture", title: "Preserved session",
      start_time: "2026-09-13T00:00:00.000Z", status: "completed", outcome: "approved", total_cost_usd: 1, duration_ms: 100, turns_used: 1 });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false, error: "preflight_gate_invalid" });
    expect(await service.getCurrentGateScore(taskId)).toBeNull();
    for (const route of ["/api/sessions", `/api/tasks/${taskId}/runs`]) {
      expect(await (await fetch(`${origin}${route}`)).json()).toEqual([expect.objectContaining({
        sessionId: "invalid-prep-session", title: "Preserved session", gateScore: null, totalCostUsd: 1 })]);
    }
    service.persistPreflightResult(taskId, content, preflight(false));
    expect(await service.getCurrentGateScore(taskId)).toBe(5);
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBeNull();
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    expect(db.getReadinessSnapshot(taskId, hash)!.prep_data).toBe(raw);
  });
  test("contract-invalid current prep is visibly invalid instead of Ready", async () => {
    service.persistPrepResult(taskId, content, { ...realPrep, outcome: "rejected" });
    const page = await openLegacy();
    expect(await page.locator("#tasksBody tbody .prep-badge-slot").textContent()).toContain("Invalid prep");
    expect(await page.locator("#tasksBody .gate-score").count()).toBe(0);
    await page.evaluate(`updatePrepBadgeInRow('${taskId}', taskPrepStatus.get('${taskId}'))`);
    const badge = page.locator("#tasksBody .task-prep-badge");
    expect(await badge.textContent()).toBe("Invalid prep");
    expect((await badge.getAttribute("class"))?.split(" ")).toContain("invalid");
    expect(await badge.getAttribute("title")).toContain("Run prep again");
    expect(await page.locator("#tasksBody .gate-score").count()).toBe(0);
    expect(await page.evaluate("getComputedStyle(document.querySelector('#tasksBody .task-prep-badge')).backgroundColor")).toBe("rgba(248, 81, 73, 0.15)");
  });
  test("contract schema rejection is visibly Not Ready instead of unprepared", async () => {
    service.persistPrepResult(taskId, content, { ...realPrep, schemaValid: false, schemaErrors: ["missing required section"], depthReady: false, depthScore: 0, outcome: "rejected" });
    const page = await openLegacy();
    expect(await page.locator("#tasksBody tbody .prep-badge-slot").textContent()).toContain("Not Ready");
    expect(await service.getCurrentGateScore(taskId)).toBe(0);
    expect(await page.locator("#tasksBody .gate-score").textContent()).toBe("0.0");
    expect(await page.locator("#tasksBody .gate-score").getAttribute("title")).toBe("Current prep score");
    service.persistPreflightResult(taskId, content, preflight(false));
    await page.evaluate("loadPrepStatus().then(loadPreflightCache).then(renderTasks)");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Not Ready");
    expect(await page.locator("#tasksBody .gate-score").textContent()).toBe("5.0");
    expect(await page.locator("#tasksBody .gate-score").getAttribute("title")).toBe("Current preflight score");
  });
  test("contract-invalid current prep cannot report an unblocked readiness summary", async () => {
    service.persistPrepResult(taskId, content, { ...realPrep, schemaErrors: ["inconsistent success"] });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false, error: "preflight_gate_invalid" });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_invalid");
  });
  test("contract low-score completed attempt stays complete without Ready or passing panel styling", async () => {
    const low = { ...realPrep, depthScore: 4.6 };
    service.persistPrepResult(taskId, content, low);
    const page = await openLegacy();
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="prep-status-${taskId}"><div id="prep-status-content-${taskId}"></div></div><button id="prep-btn-${taskId}">Prep</button>');`);
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Not Ready");
    expect(await service.getCurrentGateScore(taskId)).toBe(4.6);
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false, error: "preflight_gate_failed:4.6" });
    await page.route(`**/api/tasks/${taskId}/prep**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST") await route.fulfill({ json: { jobId: attemptId } });
      else if (pathname.endsWith("/job")) await route.fulfill({ json: { job: attemptJob("completed", { result: low }) } });
      else await route.continue();
    });
    await page.evaluate(`prepTask('${taskId}')`);
    await waitState(page, "completed");
    expect(await page.locator("#tasksBody .task-prep-badge").textContent()).toBe("Not Ready");
    expect(await page.locator(`#prep-status-content-${taskId}`).textContent()).toContain("Gate check did not pass");
    expect(await page.locator(`#prep-status-content-${taskId} .pass`).count()).toBe(0);
  });
});
