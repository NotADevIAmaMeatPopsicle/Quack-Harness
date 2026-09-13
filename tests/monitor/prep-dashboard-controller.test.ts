import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

interface State { status: string; jobId?: string; result?: unknown; readiness?: unknown; message?: string; actionError?: string }
interface Controller {
  state(id: string): State | undefined;
  sync(): void;
  start(id: string): Promise<void>;
  refresh(id: string): Promise<void>;
  recover(id: string): Promise<void>;
  event(event: unknown): void;
  readiness(id: string, prep: unknown): void;
}
const source = fs.readFileSync(path.resolve(__dirname, "../../src/monitor/public/prep-jobs.js"), "utf8");
const taskId = "TASK-1357";
const id = "00000000-0000-4000-8000-000000001357";
const other = "00000000-0000-4000-8000-000000001358";
const result = { schemaValid: true, schemaErrors: [], depthScore: 4.9, depthReady: true,
  deficiencies: [], outcome: "pass", contentHash: "a".repeat(64), schemaPolicyHash: "b".repeat(64) };
const prep = { ...result, evidenceSource: "prep_record", stale: false };
const job = (status = "running", extra = {}) => ({ taskId, jobId: id, status, ...extra });
const response = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: value => resolve(value) };
}

describe("prep attempt controller", () => {
  let scope: { apiBase: string; projectId: string | null };
  let fetcher: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let controller: Controller;
  let changes: jest.Mock;
  let storage: Map<string, string>;
  function create(): Controller {
    const browser: { fetch: typeof fetcher; sessionStorage: unknown; QuackPrepJobs?: { create: (options: unknown) => Controller } } = {
      fetch: fetcher, sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    };
    vm.runInNewContext(source, { window: browser, setTimeout, clearTimeout, AbortController, Date });
    return browser.QuackPrepJobs!.create({ getScope: () => scope, onChange: changes, fetcher, pollMs: 100, observationMs: 900, requestMs: 100 });
  }
  beforeEach(() => {
    jest.useFakeTimers(); scope = { apiBase: "", projectId: "a" }; storage = new Map();
    fetcher = jest.fn<Promise<Response>, [string, RequestInit]>(); changes = jest.fn(); controller = create();
  });
  afterEach(() => { scope = { ...scope, projectId: "cleanup" }; controller.sync(); jest.clearAllTimers(); jest.useRealTimers(); });
  async function running(): Promise<void> {
    fetcher.mockResolvedValueOnce(response({ jobId: id })).mockResolvedValue(response({ job: job() }));
    await controller.start(taskId);
  }

  test("captures explicit scope and one child even during duplicate starts", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise).mockResolvedValue(response({ job: job() }));
    const first = controller.start(taskId); await controller.start(taskId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(response({ jobId: id })); await first;
    expect(controller.state(taskId)).toMatchObject({ status: "running", jobId: id });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([`/api/tasks/${taskId}/prep?project=a`, `/api/tasks/${taskId}/prep/job?project=a`]);
    controller.readiness(taskId, prep);
    expect(controller.state(taskId)?.readiness).toBeUndefined();
  });
  test("legacy single-project requests remain unscoped", async () => {
    scope.projectId = null; await running();
    expect(fetcher.mock.calls[0][0]).toBe(`/api/tasks/${taskId}/prep`);
  });
  test.each(["pass", "rejected"])("publishes terminal %s once through authoritative GET, not duplicate SSE", async outcome => {
    await running();
    const terminal = { ...result, outcome, depthReady: outcome === "pass", depthScore: outcome === "pass" ? 4.9 : 3 };
    fetcher.mockReset().mockResolvedValueOnce(response({ job: job("completed", { result: terminal }) }))
      .mockResolvedValueOnce(response({ ...prep, ...terminal }));
    changes.mockClear();
    const event = { stage: "prep_job_completed", taskId, project: "a", payload: { jobId: id } };
    controller.event(event); controller.event(event); await jest.advanceTimersByTimeAsync(0);
    controller.event(event); await jest.advanceTimersByTimeAsync(1000);
    expect(controller.state(taskId)).toMatchObject({ status: "completed", result: terminal, readiness: terminal });
    expect(changes).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test.each([
    { stale: true }, { evidenceSource: "snapshot_projection" }, { contentHash: "c".repeat(64) },
    { schemaPolicyHash: "c".repeat(64) }, { depthScore: 4.8 }, { schemaErrors: ["bad"] },
    { contentHash: undefined }, { schemaPolicyHash: undefined }, { outcome: "rejected" },
  ])("terminal diagnostics survive a noncorresponding projection %j", async patch => {
    await running(); fetcher.mockReset().mockResolvedValueOnce(response({ job: job("completed", { result }) }))
      .mockResolvedValueOnce(response({ ...prep, ...patch }));
    await controller.refresh(taskId);
    expect(controller.state(taskId)).toMatchObject({ status: "completed", result });
    expect(controller.state(taskId)?.readiness).toBeUndefined();
    controller.readiness(taskId, prep); expect(controller.state(taskId)?.readiness).toEqual(prep);
    controller.readiness(taskId, { ...prep, ...patch }); expect(controller.state(taskId)?.readiness).toBeUndefined();
  });
  test.each([
    undefined, job("completed", { jobId: undefined, result }), job("completed", { jobId: other, result }),
    job("completed", { result: { error: "provider failed" } }), job("completed", { result: { ...result, depthScore: null } }),
    job("completed", { taskId: "TASK-OTHER", result }),
  ])("does not turn invalid/different job %j into a cached success", async latest => {
    await running(); fetcher.mockReset().mockResolvedValue(response({ job: latest }));
    await controller.refresh(taskId);
    expect(["unconfirmed", "unavailable"]).toContain(controller.state(taskId)?.status);
    expect(controller.state(taskId)?.readiness).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("uppercase policy terminal evidence remains unconfirmed with GET-only recovery", async () => {
    await running();
    fetcher.mockReset().mockResolvedValue(response({ job: job("completed", { result: { ...result, schemaPolicyHash: "B".repeat(64) } }) }));
    await controller.refresh(taskId);
    expect(controller.state(taskId)).toMatchObject({ status: "unconfirmed" });
    expect(controller.state(taskId)?.readiness).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
  });
  test.each([409, 500])("HTTP %s observes an existing running job without a second POST", async status => {
    fetcher.mockResolvedValueOnce(response({ error: "already running or admission closed" }, status))
      .mockResolvedValue(response({ job: job() }));
    await controller.start(taskId); await controller.start(taskId);
    expect(controller.state(taskId)).toMatchObject({ status: "running", jobId: id });
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  test.each(["missing-id", "lost-response", "admission-closed"])("%s cannot adopt an older terminal success", async failure => {
    if (failure === "lost-response") fetcher.mockRejectedValueOnce(new Error("lost response"));
    else fetcher.mockResolvedValueOnce(response(failure === "missing-id" ? {} : { error: "draining: survivor guard" }, failure === "admission-closed" ? 500 : 200));
    fetcher.mockResolvedValue(response({ job: job("completed", { result }) }));
    await controller.start(taskId); await controller.refresh(taskId);
    expect(controller.state(taskId)?.status).toBe("unavailable");
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  test("failed worker exposes cause and permits an explicitly requested retry", async () => {
    await running(); fetcher.mockReset().mockResolvedValueOnce(response({ job: job("failed", { error: "provider refused" }) }));
    await controller.refresh(taskId); expect(controller.state(taskId)).toMatchObject({ status: "failed", message: "provider refused" });
    fetcher.mockResolvedValueOnce(response({ jobId: other })).mockResolvedValueOnce(response({ job: job("running", { jobId: other }) }));
    await controller.start(taskId); expect(controller.state(taskId)?.jobId).toBe(other);
  });
  test("observation ends as unconfirmed; Check status resumes GET only", async () => {
    await running(); await jest.advanceTimersByTimeAsync(1000);
    expect(controller.state(taskId)?.status).toBe("unconfirmed");
    const count = fetcher.mock.calls.length; await jest.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(count);
    await controller.refresh(taskId); expect(controller.state(taskId)?.status).toBe("running");
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  test("individual request abort is bounded and does not declare the worker failed", async () => {
    await running();
    fetcher.mockImplementationOnce((_, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    const check = controller.refresh(taskId); await jest.advanceTimersByTimeAsync(100); await check;
    expect(controller.state(taskId)).toMatchObject({ status: "unconfirmed", message: expect.stringContaining("timed out") as unknown });
  });
  test("late POST/GET and SSE are inert after project and remote switch", async () => {
    const late = deferred<Response>(); fetcher.mockReturnValueOnce(late.promise);
    const starting = controller.start(taskId);
    scope = { apiBase: "https://other.invalid", projectId: "b" }; controller.sync();
    late.resolve(response({ jobId: id })); await starting;
    controller.event({ taskId, project: "a", stage: "prep_job_completed", payload: { jobId: id } });
    expect(controller.state(taskId)).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
    await running(); const stale = deferred<Response>(); fetcher.mockReturnValueOnce(stale.promise);
    const reading = controller.refresh(taskId); scope.projectId = "c"; controller.sync();
    stale.resolve(response({ job: job("completed", { result }) })); await reading;
    expect(controller.state(taskId)).toBeUndefined();
  });
  test("browser reload retains captured identity while latest slot replacement stays unavailable", async () => {
    await running(); controller = create(); controller.sync();
    fetcher.mockResolvedValue(response({ job: job("completed", { jobId: other, result }) }));
    await jest.advanceTimersByTimeAsync(0);
    expect(controller.state(taskId)).toMatchObject({ status: "unavailable", jobId: id });
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  test.each(["missing", "unavailable"])("an explicit new prep can recover from %s without automatic dispatch", async status => {
    await running(); fetcher.mockReset().mockResolvedValue(status === "missing"
      ? response({ code: "PREP_ATTEMPT_NOT_FOUND", error: "No prep attempt recorded" }, 404)
      : response({ job: job("completed", { jobId: other, result }) }));
    await controller.refresh(taskId); expect(controller.state(taskId)?.status).toBe(status);
    if (status === "missing") expect(controller.state(taskId)?.message).not.toContain("may still be running");
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    controller = create(); controller.sync(); await jest.advanceTimersByTimeAsync(0);
    expect(controller.state(taskId)?.status).toBe(status);
    fetcher.mockResolvedValueOnce(response({ jobId: other })).mockResolvedValueOnce(response({ job: job("running", { jobId: other }) }));
    await controller.start(taskId); expect(controller.state(taskId)).toMatchObject({ status: "running", jobId: other });
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  test("a superseded active job is observed after explicit new prep receives 409", async () => {
    await running(); fetcher.mockReset().mockResolvedValueOnce(response({ job: job("running", { jobId: other }) }));
    await controller.refresh(taskId); expect(controller.state(taskId)?.status).toBe("unavailable");
    fetcher.mockResolvedValueOnce(response({ error: "already running" }, 409)).mockResolvedValueOnce(response({ job: job("running", { jobId: other }) }));
    await controller.start(taskId); expect(controller.state(taskId)).toMatchObject({ status: "running", jobId: other });
  });

  test("unreadable persisted diagnostics permit only an explicit fresh attempt", async () => {
    await running(); fetcher.mockReset().mockResolvedValue(response({ code: "PREP_DIAGNOSTICS_UNAVAILABLE", error: "malformed" }, 503));
    await controller.refresh(taskId); expect(controller.state(taskId)?.status).toBe("unavailable");
    await jest.advanceTimersByTimeAsync(2000); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(response({ jobId: other })).mockResolvedValueOnce(response({ job: job("running", { jobId: other }) }));
    await controller.start(taskId); expect(controller.state(taskId)?.jobId).toBe(other);
  });

  test("reload probe can observe a running job but never imports old terminal records", async () => {
    fetcher.mockResolvedValueOnce(response({ job: job("completed", { result }) })); await controller.recover(taskId);
    expect(controller.state(taskId)).toBeUndefined();
    fetcher.mockResolvedValueOnce(response({ job: job() })); await controller.recover(taskId);
    expect(controller.state(taskId)).toMatchObject({ status: "running", jobId: id });
  });
});
