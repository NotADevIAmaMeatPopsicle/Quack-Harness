import { blueprintFailure, blueprintFailureGuidance } from "../../src/blueprint/generation-failure";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess, spawn } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { createMonitorServer } from "../../src/monitor/server";
import { PreflightJobStore, createPreflightOwner, type PreflightJob } from "../../src/monitor/preflight-job-store";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";
import { taskSpec, writeAdapter } from "../helpers/duplicate-claimants-fixture";
import { PrepCache, computeContentHash } from "../../src/monitor/prep-cache";

class HeldChild extends EventEmitter {
  pid = 45454;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(readonly args: readonly string[]) { super(); }
  arg(flag: string): string { return this.args[this.args.indexOf(flag) + 1]; }
  finish(fail = false, degraded = false): void {
    const result = fullPreflightReport(); result.contentHash = this.arg("--expected-content-hash");
    if (degraded) {
      result.mode = "deterministic";
      const failure = blueprintFailure({ source: "claude-sdk", code: "sdk_error", sdkSubtype: "error_max_turns",
        kind: "runtime_unavailable", retryable: true, message: "Browser fixture runtime unavailable" });
      result.blueprint.generationFailure = failure;
      result.degraded = { reason: blueprintFailureGuidance(failure), checksRun: ["schema"], checksSkipped: ["model"], diagnostics: failure };
    }
    if (fail) this.stderr.emit("data", Buffer.from("Browser fixture worker failed"));
    else this.stdout.emit("data", Buffer.from(JSON.stringify({ jobId: this.arg("--job-id"), result })));
    this.exitCode = fail ? 1 : 0; this.emit("exit", this.exitCode, null); this.emit("close", this.exitCode, null);
  }
}

jest.setTimeout(45_000);
describe("full preflight in built dashboards", () => {
  let root: string;
  let origin: string;
  let children: HeldChild[];
  let browser: Browser | undefined;
  let page: Page;
  let stop: (() => Promise<void>) | undefined;
  beforeEach(() => {
    children = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-preflight-browser-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/tasks/TASK-1355.md"), taskSpec("TASK-1355"));
    writeAdapter(root, { project: { name: "browser-fixture", root, taskDir: "docs/tasks", conventionsDir: "docs/conventions" } });
    fs.writeFileSync(path.join(root, ".quack/auth.json"), JSON.stringify({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }));
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await browser?.close(); browser = undefined;
    for (const child of children) if (child.exitCode === null) child.finish(true);
    await stop?.(); stop = undefined;
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function boot(): Promise<void> {
    const uiBuildDir = path.resolve(__dirname, "../../frontend/dist");
    if (!fs.existsSync(path.join(uiBuildDir, "index.html"))) throw new Error("Build the frontend before browser verification");
    const monitor = createMonitorServer({ projectRoot: root, quackRoot: root, taskDir: "docs/tasks",
      logDir: path.join(root, ".quack/logs"), adapterPath: path.join(root, ".quack/adapter.json"),
      host: "127.0.0.1", port: 0, uiBuildDir,
      preflightWorkerRuntime: { platform: "linux", spawnProcess: ((_command: string, args: readonly string[]) => {
        const child = new HeldChild(args); children.push(child); return child as unknown as ChildProcess;
      }) as unknown as typeof spawn },
    });
    const started = await monitor.start(); stop = started.stop; origin = `http://127.0.0.1:${started.port}`;
    browser = await chromium.launch({ headless: true }); page = await browser.newPage();
  }
  async function textVisible(text: string): Promise<void> {
    await page.getByText(text, { exact: true }).first().waitFor({ state: "visible" });
  }
  async function completed(): Promise<void> {
    const store = new PreflightJobStore(root, "browser-fixture");
    for (let attempt = 0; attempt < 50; attempt++) {
      if (store.latest("TASK-1355")?.status === "completed") return;
      await delay(20);
    }
    throw new Error("Fixture did not complete");
  }

  async function openDetail(ui: string): Promise<void> {
    await page.goto(ui === "legacy" ? `${origin}/legacy#tasks` : `${origin}/tasks/TASK-1355`);
    if (ui === "legacy") await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    await page.getByRole("button", { name: "Run fresh preflight", exact: true }).waitFor();
  }

  async function terminalEvent(jobId: string, session = "preflight"): Promise<void> {
    const filename = path.join(root, `.quack/logs/events-${session}.jsonl`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (fs.existsSync(filename)) {
        const events = fs.readFileSync(filename, "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as { stage: string; payload: { jobId?: string } });
        if (events.some((event) => event.payload.jobId === jobId && event.stage.endsWith("_complete" + (session === "preflight" ? "d" : "")))) return;
      }
      await delay(20);
    }
    throw new Error(`No ${session} terminal event for ${jobId}`);
  }

  test.each(["legacy", "react"])("fresh retry bypasses a failure cache and preserves approval receipts (%s)", async (ui) => {
    await boot();
    const approvalPath = path.join(root, ".quack/logs/approvals/TASK-1355.json");
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    fs.writeFileSync(approvalPath, JSON.stringify({ taskId: "TASK-1355", state: "pending", blueprint: { summary: "Old brief" }, createdAt: new Date().toISOString() }));
    const initial = await page.request.post(`${origin}/api/tasks/TASK-1355/blueprint/replan?project=browser-fixture`, { data: {} });
    expect(initial.status()).toBe(202); children[0].finish(); await completed();
    const store = new PreflightJobStore(root, "browser-fixture");
    const receipt = store.completedReplan("TASK-1355");
    await terminalEvent(receipt!.jobId, "approval");
    const eventsPath = path.join(root, ".quack/logs/events-approval.jsonl");
    const approvalEvents = fs.readFileSync(eventsPath, "utf8");
    for (const state of ["pending", "approved"]) {
      const bytes = JSON.stringify({ taskId: "TASK-1355", state, blueprint: { summary: "Current brief" }, createdAt: new Date().toISOString() });
      fs.writeFileSync(approvalPath, bytes);
      await page.goto("about:blank"); await openDetail(ui);
      const before = children.length;
      const request = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/preflight?"));
      const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/preflight?"));
      await page.getByRole("button", { name: "Run fresh preflight", exact: true }).click();
      const submitted = await request;
      expect(submitted.url()).toContain("project=browser-fixture");
      expect(submitted.postDataJSON()).toEqual({ force: true, preserveApprovals: true });
      expect((await response).status()).toBe(202);
      const body = await (await response).json() as { created: boolean; job: PreflightJob };
      expect(body.created).toBe(true);
      expect(body.job).toMatchObject({ route: "preflight", preserveApprovals: true, force: true });
      expect(body.job.replan).toBeUndefined();
      expect(children).toHaveLength(before + 1);
      expect(children[before].args).toContain("--force");
      await page.reload();
      if (ui === "legacy") await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
      await textVisible(`Attempt ${body.job.jobId}`);
      expect(await page.getByRole("button", { name: "Run fresh preflight", exact: true }).isDisabled()).toBe(true);
      expect(children).toHaveLength(before + 1);
      children[before].finish(false, state === "pending"); await completed();
      await terminalEvent(body.job.jobId);
      const report = store.latest("TASK-1355")!.result!;
      if (state === "pending") {
        expect(report.blueprint.generationFailure).toBeDefined();
        await new PrepCache(root).writePreflight(report);
        await page.locator('[aria-label="Full preflight status"]').getByText(`Limited checks: ${report.degraded!.reason}`, { exact: true }).waitFor();
      }
      expect(fs.readFileSync(approvalPath, "utf8")).toBe(bytes);
      expect(store.supersession("TASK-1355")).toBeUndefined();
      expect(store.completedReplan("TASK-1355")).toEqual(receipt);
      expect(fs.readFileSync(eventsPath, "utf8")).toBe(approvalEvents);
    }
  });

  test.each(["legacy", "react"])("fresh refusal for an unprepared replan is actionable and preserves evidence (%s)", async (ui) => {
    const store = new PreflightJobStore(root, "browser-fixture");
    const owner = await createPreflightOwner(root);
    const first = await store.reserve("TASK-1355", { ...preflightInput, contentHash: computeContentHash(taskSpec("TASK-1355")) },
      { owner, force: true, replan: { approvalDigest: "b".repeat(64), approvalLogDir: path.join(root, ".quack/logs"), prepared: false } });
    await store.update("TASK-1355", first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "failed", error: "Approval preparation failed", completedAt: new Date().toISOString() }));
    const before = store.latest("TASK-1355");
    await boot(); await openDetail(ui);
    await page.getByRole("button", { name: "Run fresh preflight", exact: true }).click();
    await page.locator('[aria-label="Full preflight status"]').getByText("A blueprint replan is unfinished. Use Replan blueprint to continue it.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Replan blueprint", exact: true }).isEnabled()).toBe(true);
    expect(children).toHaveLength(0);
    expect(store.latest("TASK-1355")).toEqual(before);
    expect(store.supersession("TASK-1355")?.jobId).toBe(first.job.jobId);
    expect(fs.existsSync(path.join(root, ".quack/logs/events-approval.jsonl"))).toBe(false);
  });

  test.each(["legacy", "react"])("fresh coalescing reports no new run and permits explicit retry after failure (%s)", async (ui) => {
    await boot(); await openDetail(ui);
    await page.route("**/api/tasks/TASK-1355/preflight?*", async (route) => {
      // Another operator reserves ordinary work after this tab read its status.
      const ordinary = await page.request.post(`${origin}/api/tasks/TASK-1355/preflight?project=browser-fixture`, { data: { force: false } });
      expect(ordinary.status()).toBe(202);
      await route.fulfill({ response: await route.fetch() });
    });
    await page.getByRole("button", { name: "Run fresh preflight", exact: true }).click();
    await textVisible("Another preflight was already running. No fresh run was started.");
    expect(children).toHaveLength(1); expect(children[0].args).not.toContain("--force");
    expect(new PreflightJobStore(root, "browser-fixture").latest("TASK-1355")?.preserveApprovals).toBeUndefined();
    await page.unroute("**/api/tasks/TASK-1355/preflight?*");
    children[0].finish(true);
    await page.waitForFunction("[...document.querySelectorAll('button')].some(button => button.textContent === 'Run fresh preflight' && !button.disabled)");
    await textVisible("Another preflight was already running. No fresh run was started.");
    expect(await page.getByText("Another preflight is already running. No fresh run was started.", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    expect(children).toHaveLength(1);
    await page.getByRole("button", { name: "Run fresh preflight", exact: true }).click();
    for (let i = 0; i < 50 && children.length === 1; i++) await delay(20);
    expect(children).toHaveLength(2); expect(children[1].args).toContain("--force");
    expect(await page.getByText("Another preflight was already running. No fresh run was started.", { exact: true }).count()).toBe(0);
  });

  test("legacy detail renders the actual provider cause and retry guidance", async () => {
    await boot();
    await page.goto(`${origin}/legacy#tasks`);
    await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    const panel = page.locator('[aria-label="Full preflight status"]');
    await page.locator("#preflight-btn-TASK-1355").click();
    await panel.getByText("Running preflight…", { exact: true }).waitFor();
    children[0].finish(false, true);
    await completed();
    const report = new PreflightJobStore(root, "browser-fixture").latest("TASK-1355")!.result!;
    expect(report.degraded?.reason).toContain("Browser fixture runtime unavailable");
    expect(report.degraded?.reason).toContain("then retry preflight");
    await panel.getByText(`Limited checks: ${report.degraded!.reason}`, { exact: true }).waitFor();
  });

  test("legacy reaches terminal state through SSE while polling is held for a minute", async () => {
    await boot();
    await page.route("**/legacy/preflight-jobs.js", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      expect(source).toContain("pollMs = 1000");
      await route.fulfill({ response, body: source.replace("pollMs = 1000", "pollMs = 60000") });
    });
    await page.goto(`${origin}/legacy#tasks`);
    await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    const panel = page.locator('[aria-label="Full preflight status"]');
    await page.getByRole("button", { name: "Pre-Flight", exact: true }).click();
    await panel.getByText("Running preflight…", { exact: true }).waitFor();
    expect(children).toHaveLength(1); children[0].finish();
    await panel.getByText("Preflight report ready", { exact: true }).waitFor({ timeout: 10_000 });
  });

  test.each(["legacy", "react"])("plain preflight preserves newer pending and approved records after replan (%s)", async (ui) => {
    await boot();
    const approvalPath = path.join(root, ".quack/logs/approvals/TASK-1355.json");
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    const store = new PreflightJobStore(root, "browser-fixture");
    for (const state of ["pending", "approved"]) {
      fs.writeFileSync(approvalPath, JSON.stringify({ taskId: "TASK-1355", state: "pending", blueprint: { summary: "Old brief" }, createdAt: new Date().toISOString() }));
      const replan = await page.request.post(`${origin}/api/tasks/TASK-1355/blueprint/replan?project=browser-fixture`, { data: {} });
      expect(replan.status()).toBe(202);
      children[children.length - 1].finish(); await completed();
      const bytes = JSON.stringify({ taskId: "TASK-1355", state, blueprint: { summary: "New brief" }, createdAt: new Date().toISOString() });
      fs.writeFileSync(approvalPath, bytes);
      await page.goto("about:blank");
      await page.goto(ui === "legacy" ? `${origin}/legacy#tasks` : `${origin}/tasks/TASK-1355`);
      if (ui === "legacy") await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
      const before = children.length;
      await page.getByRole("button", { name: "Run preflight again", exact: true }).click();
      for (let attempt = 0; attempt < 50 && children.length === before; attempt++) await delay(20);
      expect(children).toHaveLength(before + 1);
      expect(children[children.length - 1].args).not.toContain("--force");
      expect(fs.readFileSync(approvalPath, "utf8")).toBe(bytes);
      expect(store.supersession("TASK-1355")).toBeUndefined();
      children[children.length - 1].finish(); await completed();
      expect(fs.readFileSync(approvalPath, "utf8")).toBe(bytes);
    }
  });

  test("legacy rollout retains a separately labelled paid report before any durable attempt", async () => {
    const result = fullPreflightReport(); result.contentHash = computeContentHash(taskSpec("TASK-1355"));
    await new PrepCache(root).writePreflight(result);
    await boot(); await page.goto(`${origin}/legacy#tasks`);
    await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    await textVisible("No full-preflight attempt yet.");
    const cache = page.locator('[aria-label="Cached preflight report"]');
    await cache.getByText("4.9/5", { exact: true }).waitFor({ state: "visible" });
    expect(await cache.innerText()).toContain("separate from the current attempt");
    expect(children).toHaveLength(0);
  });

  test("React persists running state over reload and exposes failed, retried and degraded attempts", async () => {
    await boot(); await page.goto(`${origin}/tasks/TASK-1355`);
    await page.getByRole("button", { name: "Preflight", exact: true }).click();
    await page.locator('[aria-label="Full preflight status"] [role="status"]').filter({ hasText: "Running preflight…" }).waitFor();
    expect(children).toHaveLength(1);
    const first = children[0].arg("--job-id");
    await page.reload(); await textVisible(`Attempt ${first}`);
    expect(await page.getByRole("button", { name: "Running preflight…" }).isDisabled()).toBe(true);
    children[0].emit("exit", 0, null);
    await page.getByRole("button", { name: "Check status" }).click();
    await page.locator('[aria-label="Full preflight status"] [role="status"]').filter({ hasText: "Running preflight…" }).waitFor();
    children[0].finish(true); await textVisible("Preflight failed: Browser fixture worker failed");
    await page.getByRole("button", { name: "Run preflight again" }).click();
    await page.locator('[aria-label="Full preflight status"] [role="status"]').filter({ hasText: "Running preflight…" }).waitFor(); expect(children).toHaveLength(2);
    children[1].finish(false, true);
    await completed();
    const currentReport = new PreflightJobStore(root, "browser-fixture").latest("TASK-1355")!.result!;
    await textVisible(`Limited checks: ${currentReport.degraded!.reason}`);
    const panelText = await page.locator('[aria-label="Full preflight status"]').innerText();
    expect(panelText).toContain("Browser fixture runtime unavailable");
    expect(panelText).toContain("then retry preflight");
    expect(await page.locator('[aria-label="Full preflight status"]').innerText()).not.toContain(first);
  });

  test("legacy row and detail share running, reload, visible failure and retry controls", async () => {
    await boot(); await page.goto(`${origin}/legacy#tasks`);
    await page.getByRole("button", { name: "Pre-Flight", exact: true }).click();
    await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    const panel = page.locator('[aria-label="Full preflight status"]');
    await panel.getByText("Running preflight…", { exact: true }).waitFor({ state: "visible" });
    expect(await page.getByRole("button", { name: "Running preflight…", exact: true }).count()).toBe(2);
    expect(children).toHaveLength(1);
    await page.reload();
    await page.getByRole("button", { name: "Running preflight…", exact: true }).waitFor();
    await page.getByRole("cell", { name: "TASK-1355", exact: true }).click();
    children[0].finish(true);
    await panel.getByText("Browser fixture worker failed", { exact: true }).waitFor({ state: "visible" });
    await panel.getByRole("button", { name: "Retry preflight" }).click();
    await panel.getByText("Running preflight…", { exact: true }).waitFor();
    expect(children).toHaveLength(2);
    children[1].finish();
    await panel.getByText("Preflight report ready", { exact: true }).waitFor();
  });

  test("React shows interrupted ownership and refresh errors without permitting another writer", async () => {
    const store = new PreflightJobStore(root, "browser-fixture");
    const owner = await createPreflightOwner(root);
    await store.reserve("TASK-1355", preflightInput, { owner: { ...owner, host: "unreachable-fixture" }, force: true });
    await boot(); await page.goto(`${origin}/tasks/TASK-1355`);
    await page.getByRole("button", { name: "Reconcile interrupted run" }).waitFor();
    expect(await page.getByRole("button", { name: "Run preflight again" }).isDisabled()).toBe(true);
    await page.route("**/preflight/jobs/latest?*", route => route.abort());
    await page.getByRole("button", { name: "Check status" }).click();
    await textVisible("Unable to refresh preflight status. The last known state is shown below.");
    expect(children).toHaveLength(0);
    await page.unroute("**/preflight/jobs/latest?*");
    await page.getByRole("button", { name: "Check status" }).click();
    await page.getByRole("button", { name: "Reconcile interrupted run" }).click();
    await page.getByRole("button", { name: "I confirmed they stopped" }).click();
    await textVisible("Preflight failed: Interrupted attempt reconciled; retry preflight.");
    expect(children).toHaveLength(0);
  });
});
