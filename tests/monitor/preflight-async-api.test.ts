import * as http from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMonitorServer } from "../../src/monitor/server";
import { loadAdapter } from "../../src/core/adapter-loader";
import { computeContentHash } from "../../src/monitor/prep-cache";
import { PreflightJobStore, PreflightJobConflict, createPreflightOwner, type PreflightJob } from "../../src/monitor/preflight-job-store";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";
import { taskSpec, writeAdapter, postJson } from "../helpers/duplicate-claimants-fixture";
import type { QuackEvent } from "../../src/monitor/event-types";
import { PreflightWorker } from "../../src/monitor/preflight-worker";
import * as resultParser from "../../src/monitor/preflight-job-result";
import * as globalConfig from "../../src/core/global-config";

class FakeChild extends EventEmitter {
  pid = 45454;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(readonly args: readonly string[]) { super(); }
  arg(flag: string): string { return this.args[this.args.indexOf(flag) + 1]; }
  finish(code = 0, duplicate = false): void {
    const result = fullPreflightReport();
    result.contentHash = this.arg("--expected-content-hash");
    if (duplicate) this.stderr.emit("data", Buffer.from(JSON.stringify({ jobId: this.arg("--job-id"),
      errorType: "duplicate_claimants", message: "Task has duplicate claimants", claimants: ["first.md", "second.md"] })));
    else this.stdout.emit("data", Buffer.from(JSON.stringify({ jobId: this.arg("--job-id"), result })));
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

type Body = { job: PreflightJob | null; jobId?: string; statusUrl?: string; code?: string; created?: boolean };
jest.setTimeout(30_000);
describe("asynchronous full-preflight HTTP lifecycle", () => {
  let roots: string[];
  let children: FakeChild[];
  let stop: (() => Promise<void>) | undefined;
  let port: number;
  let requestToAbort: http.ClientRequest | undefined;
  beforeEach(() => {
    roots = []; children = []; stop = undefined; requestToAbort = undefined;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const child of children) if (child.exitCode === null) child.finish(1);
    await stop?.();
    jest.restoreAllMocks();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function fixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-full-http-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/tasks/TASK-1355.md"), taskSpec("TASK-1355"));
    writeAdapter(root, { project: { name, root, taskDir: "docs/tasks", conventionsDir: "docs/conventions" } });
    return root;
  }
  async function boot(mode: "legacy" | "registry", root: string, secondRoot?: string): Promise<void> {
    const runtime = { platform: "linux" as const,
      spawnProcess: ((_command: string, args: readonly string[]) => {
        const child = new FakeChild(args); children.push(child); requestToAbort?.destroy(); return child as unknown as ChildProcess;
      }) as unknown as typeof spawn };
    const server = createMonitorServer({ port: 0, host: "127.0.0.1", quackRoot: root,
      preflightWorkerRuntime: runtime,
      ...(mode === "registry" ? { projectAdapters: await Promise.all([root, ...(secondRoot ? [secondRoot] : [])].map((dir) => loadAdapter(dir))) }
        : { projectRoot: root, adapterPath: path.join(root, ".quack/adapter.json"), taskDir: "docs/tasks", logDir: path.join(root, ".quack/logs") }),
    });
    const started = await server.start(); stop = started.stop; port = started.port;
  }
  async function get(url: string): Promise<{ status: number; body: Body }> {
    const response = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: response.status, body: await response.json() as Body };
  }
  async function untilRunning(url: string): Promise<PreflightJob> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { body } = await get(url);
      if (body.job?.status === "running") return body.job;
      if (body.job && body.job.status !== "accepted") throw new Error(`Unexpected job state: ${body.job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Full-preflight attempt did not reach durable running status");
  }
  async function untilTerminal(url: string): Promise<PreflightJob> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { body } = await get(url);
      if (body.job?.status === "completed" || body.job?.status === "failed") return body.job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Full-preflight attempt did not reach terminal status");
  }

  it.each(["legacy", "registry"] as const)("delivers lifecycle and replan events exactly once over real SSE (%s)", async (mode) => {
    const root = fixture("full-fixture");
    expect(fs.existsSync(path.join(root, ".quack/logs"))).toBe(false);
    await boot(mode, root);
    const frames: QuackEvent[] = [];
    let stream: http.IncomingMessage | undefined;
    const request = http.get(`http://127.0.0.1:${port}/api/events/stream`);
    try {
      await new Promise<void>((resolve, reject) => {
        request.once("error", reject);
        request.once("response", (response) => {
          stream = response;
          let buffer = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            buffer += chunk;
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              if (frame.startsWith("event: connected")) resolve();
              if (frame.startsWith("event: quack-event")) frames.push(JSON.parse(frame.split("\ndata: ")[1]) as QuackEvent);
            }
          });
        });
      });
      pendingApproval(root);
      const first = await postJson(port, "/api/tasks/TASK-1355/blueprint/replan", {});
      expect(first.status).toBe(202);
      await untilRunning(first.body.statusUrl as string);
      children[0].finish();
      await untilTerminal(first.body.statusUrl as string);
      const second = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
      expect(second.status).toBe(202);
      await untilRunning(second.body.statusUrl as string);
      children[1].finish(1);
      await untilTerminal(second.body.statusUrl as string);
      for (let i = 0; i < 100 && !frames.some((event) => event.stage === "preflight_job_failed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Allow another watcher pass to expose accidental direct + watched delivery.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const lifecycle = frames.filter((event) => event.stage.startsWith("preflight_job_"));
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "preflight_job_started", "preflight_job_completed", "preflight_job_started", "preflight_job_failed",
      ]);
      expect(lifecycle.map((event) => (event.payload as { jobId: string }).jobId))
        .toEqual([first.body.jobId, first.body.jobId, second.body.jobId, second.body.jobId]);
      expect(lifecycle.every((event) => event.project === "full-fixture" && event.sessionId === "preflight")).toBe(true);
      const replans = frames.filter((event) => event.stage === "blueprint_replan_complete");
      expect(replans).toHaveLength(1);
      expect(replans[0]).toMatchObject({ project: "full-fixture", sessionId: "approval", payload: { jobId: first.body.jobId } });
    } finally { stream?.destroy(); request.destroy(); }
  });

  it.each(["legacy", "registry"] as const)("returns two 202 responses while one child is still running (%s)", async (mode) => {
    const root = fixture("full-fixture"); await boot(mode, root);
    const replies = await Promise.all([postJson(port, "/api/tasks/TASK-1355/preflight", {}),
      postJson(port, "/api/tasks/TASK-1355/preflight", { force: true })]);
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    const first = replies[0].body as unknown as Body;
    expect(replies[1].body.jobId).toBe(first.jobId);
    expect(replies.filter((reply) => reply.body.created === true)).toHaveLength(1);
    expect((await untilRunning(first.statusUrl!)).status).toBe("running");
    expect(children).toHaveLength(1);
    expect(children[0].exitCode).toBeNull();
    children[0].emit("exit", 0, null);
    expect((await get(first.statusUrl!)).body.job?.status).toBe("running");
    children[0].finish();
    const terminal = await untilTerminal(first.statusUrl!);
    expect(terminal).toMatchObject({ jobId: first.jobId, status: "completed", result: { taskId: "TASK-1355" } });
    expect((await get("/api/tasks/TASK-1355/preflight/jobs/latest")).body.job?.jobId).toBe(first.jobId);
    const next = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
    expect(next.status).toBe(202);
    expect(next.body.jobId).not.toBe(first.jobId);
    expect((await get(first.statusUrl!)).body.job).toEqual(terminal);
  });

  it("rejects changed input without launching another child", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    const first = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
    fs.appendFileSync(path.join(root, "docs/tasks/TASK-1355.md"), "\nNew input\n");
    const changed = await postJson(port, "/api/tasks/TASK-1355/preflight", { force: true });
    expect(changed).toMatchObject({ status: 409, body: { code: "PREFLIGHT_INPUT_CHANGED", jobId: first.body.jobId } });
    expect(children).toHaveLength(1);
  });

  it("keeps known duplicates as 409 and records a raced child refusal as failed", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    const other = path.join(root, "docs/tasks/other.md"); fs.writeFileSync(other, taskSpec("TASK-1355"));
    const blocked = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
    expect(blocked).toMatchObject({ status: 409, body: { error: "duplicate_claimants" } });
    expect(children).toHaveLength(0);
    expect(new PreflightJobStore(root, "full-fixture").latest("TASK-1355")).toBeUndefined();
    fs.unlinkSync(other);
    const accepted = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
    expect(accepted.status).toBe(202);
    children[0].finish(1, true);
    expect(await untilTerminal(accepted.body.statusUrl as string)).toMatchObject({
      status: "failed", errorType: "duplicate_claimants", claimants: ["first.md", "second.md"],
    });
  });

  it("scopes both admission and immutable job reads across identical task IDs", async () => {
    const a = fixture("project-a"); const b = fixture("project-b"); await boot("registry", a, b);
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight", {})).status).toBe(400);
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight?project=missing", {})).status).toBe(404);
    const accepted = await postJson(port, "/api/tasks/TASK-1355/preflight?project=project-b", {});
    expect(accepted.status).toBe(202);
    expect(children).toHaveLength(1);
    expect(children[0].arg("--project")).toBe(b);
    expect((await get(`/api/tasks/TASK-1355/preflight/jobs/${String(accepted.body.jobId)}?project=project-a`)).status).toBe(404);
    expect((await get("/api/tasks/TASK-1355/preflight/jobs/not-a-uuid?project=project-b")).status).toBe(400);
    expect((await get("/api/tasks/TASK-1355/preflight/jobs/latest")).status).toBe(400);
    expect((await get(accepted.body.statusUrl as string)).body.job?.projectId).toBe("project-b");
  });

  it("restores scoped row summaries without returning the full paid report", async () => {
    const a = fixture("project-a"); const b = fixture("project-b"); await boot("registry", a, b);
    expect((await get("/api/preflight/jobs")).status).toBe(400);
    expect((await get("/api/preflight/jobs?project=missing")).status).toBe(404);
    const accepted = await postJson(port, "/api/tasks/TASK-1355/preflight?project=project-b", {});
    await untilRunning(accepted.body.statusUrl as string);
    children[0].finish();
    await untilTerminal(accepted.body.statusUrl as string);
    const response = await fetch(`http://127.0.0.1:${port}/api/preflight/jobs?project=project-b`);
    const { jobs } = await response.json() as { jobs: Array<PreflightJob & { reportSummary: boolean }> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId: accepted.body.jobId, status: "completed", reportSummary: true });
    expect(jobs[0].result?.blueprint.formattedMarkdown).toBeUndefined();
    expect(jobs[0].result?.contextEstimate).toBeUndefined();
    const other = await fetch(`http://127.0.0.1:${port}/api/preflight/jobs?project=project-a`);
    expect(await other.json()).toEqual({ ok: true, jobs: [], storageIssues: [] });
  });

  it("enumerates 100 large reports once, then reads no report bodies on unchanged summary/drain polls", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    const store = new PreflightJobStore(root, "full-fixture");
    const owner = await createPreflightOwner(root);
    const { job } = await store.reserve("TASK-SEED", preflightInput, { owner, force: false });
    await store.update(job.taskId, job.jobId, owner.instanceId, (current) => ({ ...current,
      status: "failed", completedAt: new Date().toISOString() }));
    const seed = store.latest(job.taskId)!;
    for (let i = 0; i < 100; i++) {
      const taskId = i === 0 ? "TASK-SEED" : `TASK-SCALE-${i}`;
      const directory = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"));
      fs.mkdirSync(directory, { recursive: true });
      const result = fullPreflightReport(taskId); result.blueprint.formattedMarkdown = "x".repeat(300 * 1024);
      fs.writeFileSync(path.join(directory, `${job.jobId}.json`), JSON.stringify({ ...seed, taskId, status: "completed", result }));
      fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ version: 1, projectId: "full-fixture", taskId, latestJobId: job.jobId }));
    }
    await stop?.(); stop = undefined;
    const parse = jest.spyOn(resultParser, "parseFullPreflightResult");
    let recoveryMs = 0;
    // Capture before spying; the wrapper calls it with the original worker receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRecovery = PreflightWorker.prototype.recover;
    jest.spyOn(PreflightWorker.prototype, "recover").mockImplementation(async function (this: PreflightWorker) {
      const began = performance.now();
      try { await originalRecovery.call(this); }
      finally { recoveryMs += performance.now() - began; }
    });
    const startup = performance.now(); await boot("legacy", root);
    const startupMs = performance.now() - startup;
    expect(parse).not.toHaveBeenCalled();
    const recover = jest.spyOn(PreflightJobStore.prototype, "recover");
    async function measure(url: string): Promise<{ elapsedMs: number; maxTimerGapMs: number }> {
      const began = performance.now(); let previous = began; let maxTimerGapMs = 0;
      const timer = setInterval(() => {
        const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - previous); previous = now;
      }, 5);
      try {
        expect((await get(url)).status).toBe(200);
        const elapsedMs = performance.now() - began;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { elapsedMs, maxTimerGapMs };
      } finally { clearInterval(timer); }
    }
    const cold = await measure("/api/preflight/jobs");
    expect(parse).toHaveBeenCalledTimes(100);
    parse.mockClear();
    const warm = await measure("/api/preflight/jobs");
    const drain = await measure("/api/admin/drain");
    expect(parse).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect((await get(`/api/tasks/TASK-SEED/preflight/jobs/${job.jobId}`)).status).toBe(200);
    expect(parse).toHaveBeenCalled();
    console.info("Preflight 100 x 300KiB summary timings (ms)", { startupMs, recoveryMs, cold, warm, drain });
  });

  it("requires explicit current-token recovery for an unproven restored owner", async () => {
    const root = fixture("full-fixture");
    const store = new PreflightJobStore(root, "full-fixture");
    const owner = await createPreflightOwner(root);
    const { job } = await store.reserve("TASK-1355", { ...preflightInput,
      contentHash: computeContentHash(taskSpec("TASK-1355")) }, { owner: { ...owner, host: "unreachable-fixture-host" }, force: true });
    await boot("legacy", root);
    const url = `/api/tasks/TASK-1355/preflight/jobs/${job.jobId}`;
    const current = (await get(url)).body.job!;
    expect(current.status).toBe("recovery_required");
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight", {})).status).toBe(409);
    expect((await postJson(port, `${url}/reconcile`, {})).status).toBe(400);
    const resolved = await postJson(port, `${url}/reconcile`, { revision: current.revision,
      confirmationToken: current.confirmationToken, processTreeConfirmedStopped: true });
    expect(resolved.status).toBe(200);
    expect((resolved.body.job as PreflightJob).status).toBe("failed");
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight", {})).status).toBe(202);
  });

  it.each([
    ["legacy", "accepted", "stop"], ["legacy", "running", "stop"],
    ["registry", "accepted", "unregister"], ["registry", "running", "unregister"],
    ["registry", "accepted", "stop"], ["registry", "running", "stop"],
  ] as const)("retains readable interrupted ownership while stopping an idle monitor (%s, %s, %s)", async (mode, status, cleanup) => {
    const root = fixture("full-fixture");
    const store = new PreflightJobStore(root, "full-fixture");
    const owner = { ...await createPreflightOwner(root), host: "unreachable-previous-monitor" };
    const { job } = await store.reserve("TASK-1355", preflightInput, { owner, force: true });
    if (status === "running") await store.update(job.taskId, job.jobId, owner.instanceId, (current) => ({
      ...current, status: "running", pid: 45454, startedAt: new Date().toISOString(),
    }));
    await boot(mode, root);
    // Read disk directly: startup, not a GET's recovery side effect, made this transition.
    expect(store.latest(job.taskId)?.status).toBe("recovery_required");
    expect(children).toHaveLength(0);
    if (cleanup === "unregister") {
      jest.spyOn(globalConfig, "unregisterProject").mockReturnValue(true);
      expect((await fetch(`http://127.0.0.1:${port}/api/projects/full-fixture`, { method: "DELETE" })).status).toBe(200);
    } else {
      const drained = await postJson(port, "/api/admin/drain", {});
      expect(drained).toMatchObject({ status: 202, body: { ownedWorkStopped: true, safeToTerminate: false } });
    }
    await stop?.(); stop = undefined;
    expect(store.latest(job.taskId)).toMatchObject({ jobId: job.jobId, status: "recovery_required" });
    await expect(store.reserve(job.taskId, preflightInput, { owner, force: true }))
      .rejects.toMatchObject({ code: "PREFLIGHT_RECOVERY_REQUIRED" });
  });
  it("continues after the requesting client disconnects before reading its response", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    await new Promise<void>((resolve, reject) => {
      requestToAbort = http.request({ host: "127.0.0.1", port, method: "POST",
        path: "/api/tasks/TASK-1355/preflight", headers: { "content-type": "application/json" } });
      requestToAbort.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      requestToAbort.once("close", resolve);
      requestToAbort.end("{}");
    });
    expect(children).toHaveLength(1);
    const latest = (await get("/api/tasks/TASK-1355/preflight/jobs/latest")).body;
    expect((await untilRunning(latest.statusUrl!)).status).toBe("running");
    expect(children[0].exitCode).toBeNull();
    children[0].finish();
    expect((await untilTerminal(latest.statusUrl!)).status).toBe("completed");
  });

  it("refuses invalid options and unknown explicit legacy scope without reserving work", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    for (const data of [{ force: true, preserveApprovals: "true" }, { preserveApprovals: true }, { force: false, preserveApprovals: true }]) {
      expect((await postJson(port, "/api/tasks/TASK-1355/preflight", data)).status).toBe(400);
    }
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight", { mode: "full" })).status).toBe(400);
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight", { force: "yes" })).status).toBe(400);
    expect((await postJson(port, "/api/tasks/TASK-1355/preflight?project=missing", {})).status).toBe(404);
    jest.spyOn(PreflightWorker.prototype, "start").mockRejectedValueOnce(new PreflightJobConflict("PREFLIGHT_INVALID_OPTIONS"));
    const internal = await postJson(port, "/api/tasks/TASK-1355/preflight", { force: true, preserveApprovals: true });
    expect(internal.status).toBe(400);
    expect(internal.body.code).toBe("PREFLIGHT_INVALID_OPTIONS");
    expect((await get("/api/tasks/TASK-1355/preflight/jobs/latest")).body.job).toBeNull();
    expect(children).toHaveLength(0);
  });

  it.each([
    ["legacy", "renamed"], ["legacy", "missing"], ["registry", "renamed"], ["registry", "missing"],
  ] as const)("boots with isolated storage damage and runs an unrelated task (%s, %s)", async (mode, damage) => {
    const root = fixture("full-fixture");
    fs.writeFileSync(path.join(root, "docs/tasks/TASK-1356.md"), taskSpec("TASK-1356"));
    const store = new PreflightJobStore(root, "full-fixture");
    const owner = await createPreflightOwner(root);
    const { job } = await store.reserve("TASK-1356", preflightInput, { owner, force: true });
    const directory = path.join(root, ".quack/preflight-jobs", Buffer.from("TASK-1356").toString("base64url"));
    const statePath = path.join(directory, "state.json");
    const jobPath = path.join(directory, `${job.jobId}.json`);
    const stateBytes = fs.readFileSync(statePath, "utf8"); const jobBytes = fs.readFileSync(jobPath, "utf8");
    if (damage === "renamed") fs.writeFileSync(statePath, stateBytes.replace('"projectId":"full-fixture"', '"projectId":"previous-name"'));
    else fs.unlinkSync(jobPath);
    fs.writeFileSync(path.join(root, ".quack/preflight-jobs/editor.tmp"), "not a task record");
    try {
      await boot(mode, root);
      expect((await get("/api/health")).status).toBe(200);
      expect((await get("/api/tasks/TASK-1356/preflight/jobs/latest"))).toMatchObject({ status: 409,
        body: { code: "PREFLIGHT_STORAGE_RECOVERY_REQUIRED" } });
      expect((await postJson(port, "/api/tasks/TASK-1356/preflight", {})).status).toBe(409);
      const accepted = await postJson(port, "/api/tasks/TASK-1355/preflight", {});
      expect(accepted.status).toBe(202);
      await untilRunning(accepted.body.statusUrl as string);
      expect(children).toHaveLength(1); children[0].finish();
      expect((await untilTerminal(accepted.body.statusUrl as string)).status).toBe("completed");
      const listing = await fetch(`http://127.0.0.1:${port}/api/preflight/jobs`);
      const data = await listing.json() as { storageIssues: Array<{ taskId: string }> };
      expect(data.storageIssues.map((issue) => issue.taskId)).toEqual(["TASK-1356"]);
      // The result is durable before lock release and terminal publication finish.
      // Poll the public drain boundary instead of assuming terminal means idle.
      let drain: { livePreflightProcesses: unknown[] } | undefined;
      const deadline = Date.now() + 5000;
      do {
        const response = await fetch(`http://127.0.0.1:${port}/api/admin/drain`);
        expect(response.status).toBe(200);
        drain = await response.json() as { livePreflightProcesses: unknown[] };
        if (drain.livePreflightProcesses.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      expect(drain).toMatchObject({ safeToTerminate: false, livePreflightProcesses: [],
        preflightStorageIssues: [expect.objectContaining({ taskId: "TASK-1356" })] });
      const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
      if (mode === "registry") {
        jest.spyOn(globalConfig, "unregisterProject").mockReturnValue(true);
        expect((await fetch(`http://127.0.0.1:${port}/api/projects/full-fixture`, { method: "DELETE" })).status).toBe(200);
      }
      if (mode === "legacy") {
        const drained = await postJson(port, "/api/admin/drain", {});
        expect(drained).toMatchObject({ status: 202, body: { safeToTerminate: false, ownedWorkStopped: true } });
      }
      await stop?.(); stop = undefined;
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain("full-preflight process termination remains unconfirmed");
      if (damage === "renamed") expect(fs.readFileSync(statePath, "utf8")).toContain("previous-name");
      else expect(fs.existsSync(jobPath)).toBe(false);
    } finally {
      // The fixture reserved no real child for TASK-1356. Restore retained evidence and close it.
      fs.writeFileSync(statePath, stateBytes); fs.writeFileSync(jobPath, jobBytes);
      await store.update("TASK-1356", job.jobId, owner.instanceId, (current) => ({ ...current,
        status: "failed", completedAt: new Date().toISOString(), error: "Unlaunched fixture closed" }));
    }
  });

  function pendingApproval(root: string): { filename: string; content: string } {
    const filename = path.join(root, ".quack/logs/approvals/TASK-1355.json");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const content = JSON.stringify({ taskId: "TASK-1355", state: "pending", blueprint: { summary: "Original brief" },
      createdAt: new Date(Date.now() - 10_000).toISOString() }, null, 2);
    fs.writeFileSync(filename, content);
    return { filename, content };
  }

  it("reserves a replan before rejection, preserves paid caches and never deletes a newer approval", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    const approval = pendingApproval(root);
    const cachePaths = ["TASK-1355.json", "TASK-1355-preflight.json"].map((name) => path.join(root, ".quack/prep", name));
    fs.mkdirSync(path.dirname(cachePaths[0]), { recursive: true });
    for (const filename of cachePaths) fs.writeFileSync(filename, '{"paid":"retained"}');
    const response = await postJson(port, "/api/tasks/TASK-1355/blueprint/replan", {});
    expect(response.status).toBe(202);
    const store = new PreflightJobStore(root, "full-fixture");
    const rejectedBytes = fs.readFileSync(approval.filename, "utf8");
    expect(JSON.parse(rejectedBytes)).toMatchObject({ state: "rejected" });
    expect(store.supersession("TASK-1355")?.replan).toMatchObject({ prepared: true,
      approvalDigest: computeContentHash(rejectedBytes), requestedApprovalDigest: computeContentHash(approval.content) });
    for (const filename of cachePaths) expect(fs.readFileSync(filename, "utf8")).toBe('{"paid":"retained"}');
    const newer = JSON.stringify({ taskId: "TASK-1355", state: "approved", blueprint: { summary: "New approval" }, createdAt: new Date().toISOString() });
    fs.writeFileSync(approval.filename, newer);
    children[0].finish();
    expect((await untilTerminal(response.body.statusUrl as string)).status).toBe("completed");
    expect(fs.readFileSync(approval.filename, "utf8")).toBe(newer);
    expect(store.supersession("TASK-1355")).toBeUndefined();
    expect(store.completedReplan("TASK-1355")?.replan?.approvalDigest).toBe(computeContentHash(rejectedBytes));
  });

  it("refuses replan against a non-forced active attempt without changing approval or cache authority", async () => {
    const root = fixture("full-fixture"); await boot("legacy", root);
    const approval = pendingApproval(root);
    await postJson(port, "/api/tasks/TASK-1355/preflight", {});
    const response = await postJson(port, "/api/tasks/TASK-1355/blueprint/replan", {});
    expect(response).toMatchObject({ status: 409, body: { code: "PREFLIGHT_REPLAN_REQUIRES_FRESH_ATTEMPT" } });
    expect(fs.readFileSync(approval.filename, "utf8")).toBe(approval.content);
    expect(new PreflightJobStore(root, "full-fixture").supersession("TASK-1355")).toBeUndefined();
    expect(children).toHaveLength(1);
  });

  it("joins a forced attempt and coalesces repeated replan without rewriting its rejection", async () => {
    const root = fixture("full-fixture"); await boot("registry", root);
    const approval = pendingApproval(root);
    const first = await postJson(port, "/api/tasks/TASK-1355/preflight", { force: true });
    const replan = await postJson(port, "/api/tasks/TASK-1355/blueprint/replan", {});
    expect(replan).toMatchObject({ status: 202, body: { jobId: first.body.jobId, created: false } });
    const rejected = fs.readFileSync(approval.filename, "utf8");
    const repeated = await postJson(port, "/api/tasks/TASK-1355/blueprint/replan", {});
    expect(repeated).toMatchObject({ status: 202, body: { jobId: first.body.jobId, created: false } });
    expect(fs.readFileSync(approval.filename, "utf8")).toBe(rejected);
    expect(children).toHaveLength(1);
    children[0].finish();
    expect((await untilTerminal(first.body.statusUrl as string)).status).toBe("completed");
  });

});
