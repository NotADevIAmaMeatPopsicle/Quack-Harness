import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PreflightWorker, type PreflightJobStage } from "../../src/monitor/preflight-worker";
import { PreflightJobStore, type PreflightJob } from "../../src/monitor/preflight-job-store";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";
import { blueprintFailure } from "../../src/blueprint/generation-failure";

class FakeChild extends EventEmitter {
  pid = 45454;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
describe("durable full-preflight coordinator", () => {
  let root: string;
  let worker: PreflightWorker;
  let child: FakeChild;
  let launch: jest.Mock<ChildProcess, Parameters<typeof spawn>>;
  const events = jest.fn<void, [PreflightJobStage, PreflightJob]>();
  const taskId = "TASK-1355";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-full-worker-"));
    child = new FakeChild();
    launch = jest.fn<ChildProcess, Parameters<typeof spawn>>(() => child as unknown as ChildProcess);
    events.mockReset();
    worker = new PreflightWorker(root, "fixture.js", { projectId: "fixture", onEvent: events,
      runtime: { platform: "linux", spawnProcess: launch as unknown as typeof spawn } });
  });
  afterEach(async () => {
    if (launch.mock.calls.length > 0 && child.exitCode === null) finish(undefined, 1);
    await worker.waitForIdle();
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  function finish(payload?: unknown, code = 0): void {
    if (payload !== undefined) child.stdout.emit("data", Buffer.from(JSON.stringify(payload)));
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
  }
  async function started(force = false) {
    const reserved = await worker.start(taskId, preflightInput, { force });
    const deadline = Date.now() + 5000;
    while (worker.getJob(taskId)?.status === "accepted" && Date.now() < deadline) await tick();
    expect(worker.getJob(taskId)?.status).toBe("running");
    return reserved.job;
  }

  it("publishes a new preparation failure once and never re-emits it on guarded fresh refusal", async () => {
    await expect(worker.start(taskId, preflightInput, { force: true,
      replan: { approvalDigest: "b".repeat(64), approvalLogDir: path.join(root, ".quack/logs"), prepared: false },
      prepareReplan: () => Promise.reject(new Error("Approval write failed")) }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_PREPARATION_FAILED" });
    const failed = worker.getJob(taskId)!;
    expect(failed.status).toBe("failed");
    expect(events.mock.calls.map(([stage, job]) => [stage, job.jobId])).toEqual([["preflight_job_failed", failed.jobId]]);
    expect(launch).not.toHaveBeenCalled();
    const filename = path.join(root, ".quack/logs/events-approval.jsonl");
    const bytes = fs.readFileSync(filename, "utf8");
    expect(bytes.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(bytes) as unknown).toMatchObject({ stage: "blueprint_replan_failed", payload: { jobId: failed.jobId } });
    await expect(worker.start(taskId, preflightInput, { force: true, preserveApprovals: true }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_PENDING" });
    expect(events).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
  });

  it("isolates damaged storage at startup without reporting unproven ownership safe to drain", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const directory = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "state.json"), "{broken");
    await expect(worker.recover()).resolves.toBeUndefined();
    expect(worker.getActiveJobs()).toEqual([]);
    expect(worker.hasLiveProcesses()).toBe(false);
    expect(worker.store.getReadIssues()[0].taskId).toBe(taskId);
    await expect(worker.start(taskId, preflightInput, { force: true })).rejects.toMatchObject({ code: "PREFLIGHT_STORAGE_RECOVERY_REQUIRED" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("persists acceptance before launch, coalesces duplicate requests and retains a low-gate report as completed", async () => {
    events.mockImplementation((stage) => {
      if (stage === "preflight_job_started") {
        expect(new PreflightJobStore(root, "fixture").latest(taskId)?.status).toBe("accepted");
        expect(launch).not.toHaveBeenCalled();
      } else expect(new PreflightJobStore(root, "fixture").latest(taskId)?.status).toBe("completed");
    });
    const first = await started();
    const duplicate = await worker.start(taskId, preflightInput, { force: true });
    expect(duplicate).toMatchObject({ created: false, job: { jobId: first.jobId } });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "--job-id", first.jobId, "--expected-content-hash", preflightInput.contentHash,
      "--expected-schema-policy-hash", preflightInput.schemaPolicyHash, "--mode", "auto",
    ]));
    const report = fullPreflightReport();
    report.gate = { ...report.gate, ready: false, score: 2 };
    finish({ jobId: first.jobId, result: report });
    await worker.waitForIdle();
    expect(worker.getJob(taskId, first.jobId)).toMatchObject({ status: "completed", result: { gate: { ready: false } } });
    expect(events.mock.calls.map(([stage]) => stage)).toEqual(["preflight_job_started", "preflight_job_completed"]);
  });

  it.each(["wrong_job", "wrong_task", "wrong_input", "truncated", "nonzero"])("publishes a failed attempt for %s", async (kind) => {
    const job = await started();
    const report = fullPreflightReport(kind === "wrong_task" ? "TASK-OTHER" : taskId);
    if (kind === "wrong_input") report.contentHash = "b".repeat(64);
    if (kind === "truncated") { child.stdout.emit("data", Buffer.from('{"result":')); finish(); }
    else finish({ jobId: kind === "wrong_job" ? "00000000-0000-4000-8000-000000000000" : job.jobId, result: report }, kind === "nonzero" ? 1 : 0);
    await worker.waitForIdle();
    expect(worker.getJob(taskId, job.jobId)).toMatchObject({ status: "failed", errorType: kind === "nonzero" ? "PREFLIGHT_CHILD_FAILED" : "PREFLIGHT_INVALID_RESULT" });
    expect(worker.getJob(taskId, job.jobId)?.result).toBeUndefined();
    expect(events).toHaveBeenLastCalledWith("preflight_job_failed", expect.objectContaining({ jobId: job.jobId }));
  });

  it("retains named duplicate-claimant failure details from the child", async () => {
    const job = await started();
    const claimants = ["docs/TASK-1355-a.md", "docs/TASK-1355-b.md"];
    child.stderr.emit("data", Buffer.from(JSON.stringify({ jobId: job.jobId,
      errorType: "duplicate_claimants", message: "Two task claimants", claimants })));
    finish(undefined, 1);
    await worker.waitForIdle();
    expect(worker.getJob(taskId)).toMatchObject({ status: "failed", errorType: "duplicate_claimants", claimants });
  });

  it("round-trips a retained failed report without clearing its replan barrier", async () => {
    const reserved = await worker.start(taskId, preflightInput, { force: true,
      replan: { approvalDigest: "b".repeat(64), approvalLogDir: path.join(root, ".quack/logs") } });
    const deadline = Date.now() + 5000;
    while (worker.getJob(taskId)?.status === "accepted" && Date.now() < deadline) await tick();
    expect(worker.getJob(taskId)?.status).toBe("running");
    const report = fullPreflightReport();
    const failure = blueprintFailure({ source: "claude-sdk", code: "sdk_error", sdkSubtype: "error_max_turns",
      sdkErrors: ["Maximum turns"], kind: "runtime_unavailable", retryable: true, message: "Maximum turns" });
    report.mode = "deterministic";
    report.degraded = { reason: failure.message, diagnostics: failure, checksRun: [], checksSkipped: ["blueprint.llm"] };
    report.blueprint.generationFailure = failure;
    report.blueprint.structuredPreserved = { reason: "fidelity_monotonic_guard",
      preservedFrom: "2026-09-01T00:00:00.000Z", refusedCheckedAt: failure.failedAt };
    finish({ jobId: reserved.job.jobId, result: report });
    await worker.waitForIdle();
    const restored = new PreflightJobStore(root, "fixture");
    expect(restored.read(taskId, reserved.job.jobId)?.result).toEqual(report);
    expect(restored.supersession(taskId)?.jobId).toBe(reserved.job.jobId);
    expect(restored.completedReplan(taskId)).toBeUndefined();
  });

  it("keeps the durable terminal result when its event observer fails", async () => {
    events.mockImplementation(() => { throw new Error("event disk unavailable"); });
    const job = await started();
    finish({ jobId: job.jobId, result: fullPreflightReport() });
    await worker.waitForIdle();
    expect(new PreflightJobStore(root, "fixture").read(taskId, job.jobId)).toMatchObject({
      status: "completed", eventError: "event disk unavailable",
    });
  });

  it("exposes result-publication failure and retries it only with the exact recovery confirmation", async () => {
    const job = await started();
    const original = worker.store.update.bind(worker.store);
    const spy = jest.spyOn(worker.store, "update").mockRejectedValueOnce(new Error("storage unavailable"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    finish({ jobId: job.jobId, result: fullPreflightReport() });
    await worker.waitForIdle();
    const current = worker.getJob(taskId)!;
    expect(current).toMatchObject({ status: "recovery_required", errorType: "PREFLIGHT_PUBLICATION_FAILED" });
    expect(worker.hasActiveWork()).toBe(true);
    expect(events).not.toHaveBeenCalledWith("preflight_job_completed", expect.anything());
    await expect(worker.reconcile(taskId, job.jobId, current.revision, "wrong", true)).rejects.toThrow();
    spy.mockImplementation(original);
    await expect(worker.reconcile(taskId, job.jobId, current.revision, current.confirmationToken, true))
      .resolves.toMatchObject({ status: "completed" });
    expect(worker.hasActiveWork()).toBe(false);
  });

  it("drains an accepted attempt before it can launch and refuses subsequent work", async () => {
    const { job } = await worker.start(taskId, preflightInput, { force: false });
    await worker.shutdownAll();
    expect(launch).not.toHaveBeenCalled();
    expect(worker.getJob(taskId, job.jobId)).toMatchObject({ status: "failed" });
    await expect(worker.start(taskId, preflightInput, { force: false })).rejects.toMatchObject({ code: "PREFLIGHT_DRAINING" });
  });

  it("refuses manual recovery of a locally owned active child", async () => {
    const job = await started();
    const current = worker.getJob(taskId)!;
    await expect(worker.reconcile(taskId, job.jobId, current.revision, current.confirmationToken, true))
      .rejects.toMatchObject({ code: "PREFLIGHT_RECOVERY_CONFIRMATION_REQUIRED" });
    expect(worker.getJob(taskId)?.status).toBe("running");
  });

  it("still counts a live owned child when its durable record requires recovery", async () => {
    const job = await started();
    await worker.store.update(taskId, job.jobId, job.owner.instanceId, (current) => ({ ...current, status: "recovery_required" }));
    expect(worker.hasActiveWork()).toBe(true);
    expect(worker.hasLiveProcesses()).toBe(true);
    expect(worker.getStatusSnapshot().shutdownUnconfirmed).toBe(true);
  });

  it("retains an unreadable restored process-tree marker as uncertified after owned cleanup", async () => {
    const filename = path.join(root, ".quack/logs/preflight-shutdown-survivors/unknown.json");
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, "{broken");
    expect(worker.hasActiveWork()).toBe(false);
    expect(worker.getStatusSnapshot().shutdownUnconfirmed).toBe(true);
    const result = await worker.shutdownAll();
    expect(result.timedOut).toEqual(["unreadable:unknown.json"]);
    expect(worker.hasActiveWork()).toBe(false);
    expect(worker.getStatusSnapshot()).toMatchObject({ shutdownUnconfirmed: true, unconfirmedShutdownTasks: ["unreadable:unknown.json"] });
    expect(fs.readFileSync(filename, "utf8")).toBe("{broken");
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([true, false])("accepts a parent hash transition only with committed decomposition provenance (%s)", async (committed) => {
    const job = await started(true);
    const report = fullPreflightReport();
    report.inputContentHash = preflightInput.contentHash;
    report.contentHash = "c".repeat(64);
    report.decomposition = { decomposed: true, subtaskIds: ["TASK-1355-A"], subtaskFiles: ["child.md"],
      ...(committed ? { committedSha: "abcdef1" } : {}), recoveryPending: true };
    finish({ jobId: job.jobId, result: report });
    await worker.waitForIdle();
    expect(worker.getJob(taskId)?.status).toBe(committed ? "completed" : "failed");
    expect(worker.getJob(taskId)?.input.contentHash).toBe(preflightInput.contentHash);
    if (committed) expect(worker.getJob(taskId)?.result?.contentHash).toBe("c".repeat(64));
  });

});
