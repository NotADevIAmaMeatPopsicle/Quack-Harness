import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

type Job = { taskId: string; jobId: string; projectId: string; revision: number; acceptedAt: string;
  status: string; confirmationToken?: string; result?: Record<string, unknown>; reportSummary?: boolean };
type State = { job?: Job; pending?: boolean; error?: string; actionError?: string; notice?: string; paused?: boolean };
interface Controller {
  state(id: string): State;
  start(id: string, replan?: boolean): Promise<void>;
  fresh(id: string): Promise<void>;
  refresh(id: string, latest?: boolean): Promise<void>;
  load(): Promise<void>;
  sync(): void;
  event(event: unknown): void;
  reconcile(id: string, confirmed: boolean): Promise<void>;
  label(state: State): string;
}
const taskId = "TASK-1355";
const source = fs.readFileSync(path.resolve(__dirname, "../../src/monitor/public/preflight-jobs.js"), "utf8");
const job = (status = "running", extra: Partial<Job> = {}): Job => ({ taskId, jobId: "attempt-one",
  projectId: "a", revision: 2, acceptedAt: "2026-09-13T00:00:00.000Z", status, ...extra });
const response = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("durable legacy preflight controller", () => {
  let scope: { apiBase: string; projectId: string };
  let fetcher: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let controller: Controller;
  beforeEach(() => {
    jest.useFakeTimers(); scope = { apiBase: "", projectId: "a" };
    fetcher = jest.fn<Promise<Response>, [string, RequestInit]>();
    const browser: { fetch: typeof fetcher; QuackPreflightJobs?: { create: (options: unknown) => Controller } } = { fetch: fetcher };
    vm.runInNewContext(source, { window: browser, setTimeout, clearTimeout, AbortController });
    controller = browser.QuackPreflightJobs!.create({ getScope: () => scope, onChange: () => undefined, fetcher, pollMs: 100 });
  });
  afterEach(() => { scope = { ...scope, projectId: "cleanup" }; controller.sync(); jest.useRealTimers(); });

  test.each(["ordinary", "fresh", "replan"])("%s uses its explicit route and options", async (kind) => {
    fetcher.mockResolvedValueOnce(response({ job: job(), created: true }, 202));
    if (kind === "fresh") await controller.fresh(taskId);
    else await controller.start(taskId, kind === "replan");
    expect(fetcher.mock.calls[0][0]).toBe(`/api/tasks/${taskId}/${kind === "replan" ? "blueprint/replan" : "preflight"}?project=a`);
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual(kind === "fresh"
      ? { force: true, preserveApprovals: true } : { force: kind === "replan" });
    expect(controller.state(taskId).notice).toBeUndefined();
  });

  test.each([false, undefined])("fresh start is not claimed without created confirmation (%s)", async (created) => {
    fetcher.mockResolvedValueOnce(response({ job: job(), created }, 202));
    await controller.fresh(taskId);
    const notice = controller.state(taskId).notice;
    expect(notice).toContain(created === false ? "No fresh run was started" : "did not confirm a fresh start");
    fetcher.mockResolvedValueOnce(response({ job: job("completed", { revision: 3 }) }));
    await controller.refresh(taskId);
    expect(controller.state(taskId).notice).toBe(notice);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  test.each(["accepted", "running", "recovery_required"])("fresh refuses known %s work", async (status) => {
    fetcher.mockResolvedValueOnce(response({ job: job(status) })); await controller.refresh(taskId);
    await controller.fresh(taskId);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
  });

  test("a failed fresh retry clears the previous coalescing notice", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job(), created: false }, 202));
    await controller.fresh(taskId);
    fetcher.mockResolvedValueOnce(response({ job: job("completed", { revision: 3 }) }));
    await controller.refresh(taskId);
    expect(controller.state(taskId).notice).toBe("Another preflight was already running. No fresh run was started.");
    fetcher.mockResolvedValueOnce(response({ error: "Use Replan blueprint" }, 409));
    fetcher.mockResolvedValueOnce(response({ job: job("completed", { revision: 3 }) }));
    await controller.fresh(taskId);
    expect(controller.state(taskId).notice).toBeUndefined();
    expect(controller.state(taskId).actionError).toBe("Use Replan blueprint");
  });

  test("fresh pending and late project response cannot create another writer or leak a notice", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const first = controller.fresh(taskId);
    await controller.fresh(taskId); await controller.start(taskId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    scope = { apiBase: "", projectId: "b" }; controller.sync();
    pending.resolve(response({ job: job(), created: false }, 202)); await first;
    expect(controller.state(taskId).job).toBeUndefined();
    expect(controller.state(taskId).notice).toBeUndefined();
  });

  test("lost fresh POST recovers by GET and never resubmits on SSE", async () => {
    fetcher.mockRejectedValueOnce(new Error("response lost"));
    fetcher.mockResolvedValue(response({ job: job() }));
    await controller.fresh(taskId);
    controller.event({ taskId, project: "a", stage: "preflight_job_started", payload: { jobId: "attempt-one" } });
    await jest.advanceTimersByTimeAsync(0);
    expect(controller.state(taskId).job?.jobId).toBe("attempt-one");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  test("both starts share the pending request and pipeline completion cannot announce success", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const first = controller.start(taskId);
    await controller.start(taskId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(controller.state(taskId).pending).toBe(true);
    pending.resolve(response({ job: job() }, 202)); await first;
    fetcher.mockResolvedValue(response({ job: job() }));
    controller.event({ taskId, project: "a", stage: "preflight_complete", payload: { jobId: "attempt-one" } });
    await jest.advanceTimersByTimeAsync(0);
    expect(controller.state(taskId).job?.status).toBe("running");
    expect(controller.label(controller.state(taskId))).toBe("Running preflight…");
  });

  test("reload restores an active summary and reads the immutable attempt to completion", async () => {
    fetcher.mockResolvedValueOnce(response({ jobs: [job("running", { reportSummary: true })] }));
    await controller.load();
    fetcher.mockResolvedValueOnce(response({ job: job("completed", { revision: 3, result: { gate: { ready: false } } }) }));
    await jest.advanceTimersByTimeAsync(100);
    expect(fetcher.mock.calls[1][0]).toBe(`/api/tasks/${taskId}/preflight/jobs/attempt-one?project=a`);
    expect(controller.label(controller.state(taskId))).toBe("Readiness needs attention");
    expect(controller.state(taskId).job?.reportSummary).toBeUndefined();
  });

  test("late responses and old SSE cannot populate another project", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const first = controller.start(taskId);
    scope = { apiBase: "https://other.invalid", projectId: "b" }; controller.sync();
    pending.resolve(response({ job: job() }, 202)); await first;
    controller.event({ taskId, project: "a", stage: "preflight_complete", payload: { jobId: "attempt-one" } });
    expect(controller.state(taskId).job).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(response({ job: job("accepted", { projectId: "b" }) }, 202));
    await controller.start(taskId);
    expect(fetcher.mock.calls[1][0]).toContain("https://other.invalid/api/tasks/TASK-1355/preflight?project=b");
  });

  test("three polling errors pause without marking the worker failed; manual refresh reconnects", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job() }, 202)); await controller.start(taskId);
    fetcher.mockRejectedValue(new Error("offline"));
    await jest.advanceTimersByTimeAsync(300);
    expect(controller.state(taskId)).toMatchObject({ paused: true, error: "offline", job: { status: "running" } });
    const count = fetcher.mock.calls.length;
    await jest.advanceTimersByTimeAsync(3000); expect(fetcher).toHaveBeenCalledTimes(count);
    fetcher.mockResolvedValueOnce(response({ job: job("failed", { revision: 3 }) }));
    await controller.refresh(taskId);
    expect(controller.state(taskId).error).toBeUndefined();
    expect(controller.label(controller.state(taskId))).toBe("Preflight failed");
  });

  test("a stale GET cannot overwrite a newly accepted retry even with equal timestamps", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job("completed") })); await controller.refresh(taskId);
    const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
    const reading = controller.refresh(taskId);
    fetcher.mockResolvedValueOnce(response({ job: job("accepted", { jobId: "attempt-two", revision: 1 }) }, 202));
    await controller.start(taskId);
    old.resolve(response({ job: job("completed") })); await reading;
    expect(controller.state(taskId).job?.jobId).toBe("attempt-two");
  });

  test("a lost POST response recovers the reserved job without another writer", async () => {
    fetcher.mockRejectedValueOnce(new Error("response lost"));
    fetcher.mockResolvedValueOnce(response({ job: job() }));
    await controller.start(taskId);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(controller.state(taskId)).toMatchObject({ job: { status: "running" }, actionError: "response lost" });
  });

  test("a lost retry response invalidates an older in-flight GET before recovery", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job("completed") })); await controller.refresh(taskId);
    const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise);
    const reading = controller.refresh(taskId);
    fetcher.mockRejectedValueOnce(new Error("response lost"));
    fetcher.mockResolvedValueOnce(response({ job: job("running", { jobId: "new-attempt", revision: 1 }) }));
    await controller.start(taskId);
    old.resolve(response({ job: job("completed") })); await reading;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(controller.state(taskId)).toMatchObject({ job: { jobId: "new-attempt", status: "running" }, actionError: "response lost" });
  });

  test("reconciliation requires explicit confirmation and sends the current revision/token", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job("recovery_required", { confirmationToken: "current-token" }) }));
    await controller.refresh(taskId);
    await controller.reconcile(taskId, false); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(response({ job: job("failed", { revision: 3 }) }));
    await controller.reconcile(taskId, true);
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({ revision: 2,
      confirmationToken: "current-token", processTreeConfirmedStopped: true });
  });

  test.each([
    [{ mode: "deterministic", gate: { ready: true } }, "Limited checks"],
    [{ degraded: { reason: "unavailable" }, gate: { ready: true } }, "Limited checks"],
    [{ blueprint: { structuredPreserved: {} }, gate: { ready: true } }, "Blueprint needs attention"],
    [{ blueprint: { fidelity: { status: "failed" } }, gate: { ready: true } }, "Blueprint needs attention"],
    [{ gate: { ready: true, gateSkipped: true } }, "Readiness not evaluated"],
  ])("does not turn incomplete evidence into a green result (%s)", (result, expected) => {
    expect(controller.label({ job: job("completed", { result: result as Record<string, unknown> }) })).toBe(expected);
  });
});
