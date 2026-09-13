import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as lockRuntime from "../../src/monitor/federation/store";
import {
  PreflightJobStore, createPreflightOwner, MAX_RETAINED_PREFLIGHT_HISTORY, type PreflightOwner,
} from "../../src/monitor/preflight-job-store";
import { parsePreflightJobEnvelope } from "../../src/monitor/preflight-job-result";
import { fullPreflightReport, preflightInput } from "../helpers/preflight-job-fixture";

describe("durable full-preflight attempts", () => {
  let root: string;
  let store: PreflightJobStore;
  let owner: PreflightOwner;
  const taskId = "TASK-1355";
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-preflight-attempt-"));
    store = new PreflightJobStore(root, "fixture");
    owner = await createPreflightOwner(root);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const replan = () => ({ approvalDigest: "b".repeat(64), approvalLogDir: path.join(root, ".quack/logs") });
  const start = (force = false) => store.reserve(taskId, preflightInput, { owner, force });

  it.each(["failed", "degraded", "unprepared", "running"])("guarded fresh refuses an unfinished %s replan without transferring its receipt", async (kind) => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { ...replan(), ...(kind === "unprepared" ? { prepared: false } : {}) } });
    if (kind !== "running") await store.update(taskId, first.job.jobId, owner.instanceId, (job) => kind === "degraded"
      ? { ...job, status: "completed", completedAt: new Date().toISOString(), result: { ...fullPreflightReport(), mode: "deterministic" } }
      : { ...job, status: "failed", completedAt: new Date().toISOString(), error: "fixture failure" });
    const dir = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"));
    const before = fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
    await expect(store.reserve(taskId, preflightInput, { owner, force: true, preserveApprovals: true }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_PENDING", message: expect.stringContaining("Use Replan blueprint") as unknown });
    expect(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])).toEqual(before);
    expect(store.supersession(taskId)?.jobId).toBe(first.job.jobId);
    expect(store.completedReplan(taskId)).toBeUndefined();
  });

  it("guarded fresh preserves a completed replacement receipt and cannot be upgraded into a replan", async () => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    await store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    const receipt = store.completedReplan(taskId);
    const { job, created } = await store.reserve(taskId, preflightInput, { owner, force: true, preserveApprovals: true });
    expect(created).toBe(true);
    expect(job).toMatchObject({ route: "preflight", force: true, preserveApprovals: true });
    expect(job.replan).toBeUndefined();
    const prepare = jest.fn();
    await expect(store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { ...replan(), prepared: false }, prepareReplan: prepare }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_REQUIRES_SEPARATE_ATTEMPT" });
    expect(prepare).not.toHaveBeenCalled();
    expect(new PreflightJobStore(root, "fixture").latest(taskId)).toEqual(job);
    await expect(store.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current, preserveApprovals: false })))
      .rejects.toThrow("immutable");
    await expect(store.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current, replan: replan() })))
      .rejects.toThrow("cannot carry a replan");
    await store.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    expect(store.supersession(taskId)).toBeUndefined();
    expect(store.completedReplan(taskId)).toEqual(receipt);
  });

  it("guarded fresh coalesces an ordinary active attempt without changing its force or protection", async () => {
    const ordinary = await start();
    const fresh = await store.reserve(taskId, preflightInput, { owner, force: true, preserveApprovals: true });
    expect(fresh).toEqual({ created: false, job: ordinary.job });
    expect(fresh.job.force).toBe(false);
    expect(fresh.job.preserveApprovals).toBeUndefined();
  });

  it("refuses incompatible internal guard options before preparation or reservation", async () => {
    const prepare = jest.fn();
    for (const extra of [{ force: false }, { replan: replan() }, { prepareReplan: prepare }]) {
      await expect(store.reserve(taskId, preflightInput, { owner, force: true, preserveApprovals: true, ...extra }))
        .rejects.toMatchObject({ code: "PREFLIGHT_INVALID_OPTIONS" });
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(store.latest(taskId)).toBeUndefined();
  });

  it("bounds ordinary terminal history while preserving active and replacement receipts", async () => {
    const replacement = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    await store.update(taskId, replacement.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETAINED_PREFLIGHT_HISTORY + 3; i++) {
      const { job } = await start(); ids.push(job.jobId);
      await store.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current,
        status: "failed", completedAt: new Date(Date.now() + i * 1000).toISOString(), error: "fixture" }));
    }
    expect(ids.filter((id) => store.read(taskId, id))).toHaveLength(MAX_RETAINED_PREFLIGHT_HISTORY + 1);
    expect(store.read(taskId, ids[0])).toBeUndefined();
    expect(store.completedReplan(taskId)?.jobId).toBe(replacement.job.jobId);
    expect(store.latest(taskId)?.jobId).toBe(ids[ids.length - 1]);
    const active = await start();
    expect(store.latest(taskId)?.jobId).toBe(active.job.jobId);
    expect(store.read(taskId, replacement.job.jobId)).toBeDefined();
  });

  it("isolates malformed task metadata while preserving affected-task refusal and unrelated reservations", async () => {
    await start();
    const filename = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"), "state.json");
    const bytes = fs.readFileSync(filename, "utf8");
    fs.writeFileSync(filename, bytes.replace('"projectId":"fixture"', '"projectId":"old-name"'));
    fs.writeFileSync(path.join(root, ".quack/preflight-jobs", "editor.tmp"), "stray");
    expect(store.listLatest()).toEqual([]);
    expect(store.getReadIssues()).toHaveLength(1);
    expect(store.getReadIssues()[0].taskId).toBe(taskId);
    expect(store.getReadIssues()[0].message).toContain("identity mismatch");
    await expect(start()).rejects.toMatchObject({ code: "PREFLIGHT_STORAGE_RECOVERY_REQUIRED" });
    const other = await store.reserve("TASK-OTHER", preflightInput, { owner, force: true });
    expect(other.created).toBe(true);
    expect(store.listLatest().map((job) => job.taskId)).toEqual(["TASK-OTHER"]);
    expect(fs.readFileSync(filename, "utf8")).not.toBe(bytes);
  });

  it("two store instances reserve one durable attempt and force joins it", async () => {
    const other = new PreflightJobStore(root, "fixture");
    const results = await Promise.all([start(), other.reserve(taskId, preflightInput, { owner, force: true })]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].job.jobId).toBe(results[1].job.jobId);
    expect(other.latest(taskId)?.jobId).toBe(results[0].job.jobId);
  });

  it("invalidates display summaries on external changes while exact reads stay authoritative", async () => {
    const { job } = await start();
    expect(store.listSummaries()[0].status).toBe("accepted");
    const other = new PreflightJobStore(root, "fixture");
    await other.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    const first = store.listSummaries(); first[0].status = "failed";
    expect(store.listSummaries()[0]).toMatchObject({ status: "completed", result: { blueprint: { hasMarkdown: true } } });
    expect(store.read(taskId, job.jobId)?.result?.blueprint.formattedMarkdown).toBe("Fresh generated blueprint");
    const filename = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"), `${job.jobId}.json`);
    fs.writeFileSync(filename, "{broken");
    expect(store.listSummaries()).toEqual([]);
    expect(store.getReadIssues()).toHaveLength(1);
    expect(() => store.read(taskId, job.jobId)).toThrow("needs recovery");
  });

  it.each(["supersededByJobId", "completedReplanJobId"])("names malformed replan receipts as storage recovery (%s)", async (field) => {
    const { job } = await start();
    const filename = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"), "state.json");
    const state = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(filename, JSON.stringify({ ...state, [field]: job.jobId }));
    try {
      if (field === "supersededByJobId") store.supersession(taskId); else store.completedReplan(taskId);
      throw new Error("Expected storage refusal");
    } catch (error) { expect(error).toMatchObject({ code: "PREFLIGHT_STORAGE_RECOVERY_REQUIRED" }); }
  });

  it.each([
    { contentHash: "c".repeat(64) }, { schemaPolicyHash: "d".repeat(64) },
    { readinessJudgmentMode: "shadow" as const }, { requestedMode: "deterministic" as const },
  ])("changed input refuses without altering the active attempt (%j)", async (change) => {
    const first = await start();
    await expect(store.reserve(taskId, { ...preflightInput, ...change }, { owner, force: true }))
      .rejects.toMatchObject({ code: "PREFLIGHT_INPUT_CHANGED", job: { jobId: first.job.jobId } });
    expect(store.read(taskId, first.job.jobId)).toEqual(first.job);
  });

  it("replan refuses a non-force attempt without superseding its cache", async () => {
    await start();
    await expect(store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_REQUIRES_FRESH_ATTEMPT" });
    expect(store.supersession(taskId)).toBeUndefined();
  });

  it("replan joins a forced attempt and preserves its exact rejected-record identity", async () => {
    const first = await start(true);
    const joined = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    expect(joined).toMatchObject({ created: false, job: { jobId: first.job.jobId, replan: replan() } });
    expect(store.supersession(taskId)?.jobId).toBe(first.job.jobId);
  });

  it("closed attempts stay addressable after a newer reservation", async () => {
    const first = await start();
    const closed = await store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    const next = await start();
    expect(next.job.jobId).not.toBe(closed.jobId);
    expect(store.read(taskId, first.job.jobId)).toEqual(closed);
    await expect(store.update(taskId, first.job.jobId, owner.instanceId, (job) => job))
      .rejects.toMatchObject({ code: "PREFLIGHT_ATTEMPT_CHANGED" });
    expect(store.latest(taskId)?.jobId).toBe(next.job.jobId);
  });

  it("malformed or wrong-identity completion never overwrites the accepted record", async () => {
    const { job } = await start();
    for (const result of [{}, fullPreflightReport("TASK-OTHER")]) {
      await expect(store.update(taskId, job.jobId, owner.instanceId, (current) => ({ ...current,
        status: "completed", completedAt: new Date().toISOString(), result: result as ReturnType<typeof fullPreflightReport> })))
        .rejects.toThrow();
      expect(store.read(taskId, job.jobId)).toEqual(job);
    }
  });

  it("failed replan retains its barrier; a later successful fresh replacement releases it", async () => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    await store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "failed", completedAt: new Date().toISOString(), error: "provider failed" }));
    expect(store.supersession(taskId)?.jobId).toBe(first.job.jobId);
    await expect(start()).rejects.toMatchObject({ code: "PREFLIGHT_FRESH_REPLACEMENT_REQUIRED" });
    const next = await start(true);
    expect(next.job.replan).toEqual(replan());
    await store.update(taskId, next.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() }));
    expect(store.supersession(taskId)).toBeUndefined();
    expect(store.read(taskId, first.job.jobId)?.status).toBe("failed");
    await start();
    expect(store.completedReplan(taskId)?.jobId).toBe(next.job.jobId);
  });

  it("a deterministic replan report does not release the rejected-blueprint barrier", async () => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    await store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: { ...fullPreflightReport(), mode: "deterministic" } }));
    expect(store.supersession(taskId)?.jobId).toBe(first.job.jobId);
  });

  it("terminal publication survives an index-write failure and repairs before the next start", async () => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    const disk = jest.requireActual<typeof fs>("node:fs");
    const rename = disk.renameSync;
    const failure = jest.spyOn(disk, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("state.json")) throw new Error("simulated index write failure");
      rename(from, to);
    });
    await expect(store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() })))
      .rejects.toThrow("simulated index write failure");
    failure.mockRestore();
    expect(store.latest(taskId)?.status).toBe("completed");
    await store.recover(taskId);
    expect(store.supersession(taskId)).toBeUndefined();
    expect(store.completedReplan(taskId)?.jobId).toBe(first.job.jobId);
    expect((await start()).created).toBe(true);
    expect(store.completedReplan(taskId)?.jobId).toBe(first.job.jobId);
    expect(store.supersession(taskId)).toBeUndefined();
  });

  it("restored unproven ownership requires exact tokened confirmation before retry", async () => {
    const oldOwner = { ...owner, startedAt: "different-process-incarnation" };
    const first = await store.reserve(taskId, preflightInput, { owner: oldOwner, force: false });
    const recovery = await store.recover(taskId);
    expect(recovery?.status).toBe("recovery_required");
    await expect(start()).rejects.toMatchObject({ code: "PREFLIGHT_RECOVERY_REQUIRED" });
    await expect(store.reconcile(taskId, first.job.jobId, recovery!.revision, randomUUID(), true)).rejects.toThrow();
    await expect(store.reconcile(taskId, first.job.jobId, recovery!.revision, recovery!.confirmationToken, false)).rejects.toThrow();
    await store.reconcile(taskId, first.job.jobId, recovery!.revision, recovery!.confirmationToken, true);
    expect((await start()).created).toBe(true);
    expect(store.read(taskId, first.job.jobId)).toMatchObject({ status: "failed", errorType: "PREFLIGHT_INTERRUPTED" });
  });

  it("a live owner remains running and cannot be reconciled as an interrupted job", async () => {
    const first = await start();
    expect((await store.recover(taskId))?.status).toBe("accepted");
    await expect(store.reconcile(taskId, first.job.jobId, first.job.revision, first.job.confirmationToken, true)).rejects.toThrow();
  });

  it.each(["accepted", "running"] as const)("retains a verified self-owned %s replan after later OS uncertainty", async (status) => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    if (status === "running") await store.update(taskId, first.job.jobId, owner.instanceId,
      (job) => ({ ...job, status: "running", startedAt: new Date().toISOString() }));
    const before = store.latest(taskId);
    const supersession = store.supersession(taskId);
    const probe = jest.fn(() => Promise.resolve({ state: "unknown" as const }));
    lockRuntime.setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: probe });
    try {
      expect((await store.recover(taskId))?.status).toBe(status);
      expect(store.latest(taskId)).toEqual(before);
      expect(store.supersession(taskId)).toEqual(supersession);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      lockRuntime.setFederatedJobLockOptionsForTests(undefined);
    }
  });

  it.each(["bootId", "startedAt"] as const)("still refuses a self-PID owner with a different %s after OS uncertainty", async (field) => {
    await store.reserve(taskId, preflightInput, { owner: { ...owner, [field]: "old-incarnation" }, force: false });
    lockRuntime.setFederatedJobLockOptionsForTests({ cacheCurrentProcessIdentityForTest: true,
      processIdentityProbeForTest: () => Promise.resolve({ state: "unknown" }) });
    try {
      expect(await store.recover(taskId)).toMatchObject({ status: "recovery_required",
        errorType: "PREFLIGHT_OWNERSHIP_UNCONFIRMED" });
    } finally {
      lockRuntime.setFederatedJobLockOptionsForTests(undefined);
    }
  });

  it("never consults the local identity probe for a remote-host owner", async () => {
    await store.reserve(taskId, preflightInput, { owner: { ...owner, host: `${os.hostname()}-remote` }, force: false });
    const probe = jest.spyOn(lockRuntime, "probeFederatedLockProcessIdentity");
    expect((await store.recover(taskId))?.status).toBe("recovery_required");
    expect(probe).not.toHaveBeenCalled();
  });

  it("owner initialization retries one transient probe without reserving work", async () => {
    const probe = jest.spyOn(lockRuntime, "currentFederatedLockProcessIdentity")
      .mockRejectedValueOnce(new Error("unknown process incarnation"))
      .mockResolvedValueOnce({ bootId: owner.bootId, startedAt: owner.startedAt });
    expect(await createPreflightOwner(root)).toMatchObject({ bootId: owner.bootId, startedAt: owner.startedAt });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(store.latest(taskId)).toBeUndefined();
  });

  it("owner initialization never substitutes a numeric PID after repeated unknown probes", async () => {
    const probe = jest.spyOn(lockRuntime, "currentFederatedLockProcessIdentity")
      .mockRejectedValue(new Error("unknown process incarnation"));
    await expect(createPreflightOwner(root)).rejects.toThrow("unknown process incarnation");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(store.latest(taskId)).toBeUndefined();
  });

  it("rejects cross-project records, cross-task lookups and path-shaped ids", async () => {
    const { job } = await start();
    expect(store.read("TASK-OTHER", job.jobId)).toBeUndefined();
    expect(() => store.read(taskId, "../../state")).toThrow();
    expect(() => new PreflightJobStore(root, "other").latest(taskId)).toThrow(/identity mismatch/);
    const record = path.join(root, ".quack/preflight-jobs", Buffer.from(taskId).toString("base64url"), `${job.jobId}.json`);
    fs.writeFileSync(record, "{}");
    expect(() => store.latest(taskId)).toThrow();
    await expect(start()).rejects.toThrow();
  });

  it("full-report envelope accepts large reports and computed rejection but rejects stale attempt identity", () => {
    const jobId = randomUUID();
    const result = fullPreflightReport();
    result.blueprint.formattedMarkdown = "Report content ".repeat(12000);
    result.gate.ready = false;
    result.gate.score = 2;
    expect(parsePreflightJobEnvelope({ jobId, result }, jobId).gate.score).toBe(2);
    expect(() => parsePreflightJobEnvelope({ jobId: randomUUID(), result }, jobId)).toThrow(/different attempt/);
    expect(() => parsePreflightJobEnvelope({ jobId, result: {} }, jobId)).toThrow();
    result.blueprint.formattedMarkdown = "x".repeat(4 * 1024 * 1024);
    expect(() => parsePreflightJobEnvelope({ jobId, result }, jobId)).toThrow(/bounded output size/);
  });
  it("reserves before rejection, records exact rejection bytes and coalesces the original request", async () => {
    const requested = { ...replan(), prepared: false };
    const written = { ...replan(), approvalDigest: "c".repeat(64) };
    const prepare = jest.fn(() => {
      expect(store.latest(taskId)?.status).toBe("accepted");
      expect(store.supersession(taskId)?.replan?.prepared).toBe(false);
      return Promise.resolve(written);
    });
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: requested, prepareReplan: prepare });
    expect(first.job.replan).toMatchObject({ ...written, prepared: true, requestedApprovalDigest: requested.approvalDigest });
    const duplicate = await store.reserve(taskId, preflightInput, { owner, force: true, replan: requested, prepareReplan: prepare });
    expect(duplicate).toMatchObject({ created: false, job: { jobId: first.job.jobId } });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not run rejection preparation when a non-forced child already owns the task", async () => {
    await start();
    const prepare = jest.fn();
    await expect(store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { ...replan(), prepared: false }, prepareReplan: prepare }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_REQUIRES_FRESH_ATTEMPT" });
    expect(prepare).not.toHaveBeenCalled();
    expect(store.supersession(taskId)).toBeUndefined();
  });

  it("keeps a failed preparation explicit and requires the replan path to retry it", async () => {
    await expect(store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { ...replan(), prepared: false }, prepareReplan: () => Promise.reject(new Error("approval write failed")) }))
      .rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_PREPARATION_FAILED", job: { status: "failed" } });
    expect(store.latest(taskId)).toMatchObject({ status: "failed", error: "approval write failed" });
    expect(store.supersession(taskId)?.replan?.prepared).toBe(false);
    await expect(start(true)).rejects.toMatchObject({ code: "PREFLIGHT_REPLAN_PREPARATION_REQUIRED" });
  });

  it("serializes joined replan preparation before an already-running child's terminal commit", async () => {
    const first = await start(true);
    let entered!: () => void;
    const inPreparation = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const joined = store.reserve(taskId, preflightInput, { owner, force: true,
      replan: { ...replan(), prepared: false }, prepareReplan: async () => {
        entered(); await held; return { ...replan(), approvalDigest: "d".repeat(64) };
      } });
    await inPreparation;
    let completed = false;
    const terminalWrite = store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result: fullPreflightReport() })).then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    release(); await joined; await terminalWrite;
    expect(store.supersession(taskId)).toBeUndefined();
    expect(store.completedReplan(taskId)?.replan).toMatchObject({ approvalDigest: "d".repeat(64), prepared: true });
  });

  it.each(["empty", "failed_fidelity"])("does not clear supersession for an unusable full blueprint (%s)", async (kind) => {
    const first = await store.reserve(taskId, preflightInput, { owner, force: true, replan: replan() });
    const result = fullPreflightReport();
    if (kind === "empty") result.blueprint.formattedMarkdown = "";
    else result.blueprint.fidelity = { status: "failed", scope: "typed-surface+file-existence", checkedAt: new Date().toISOString(), violations: [] };
    await store.update(taskId, first.job.jobId, owner.instanceId, (job) => ({ ...job,
      status: "completed", completedAt: new Date().toISOString(), result }));
    expect(store.supersession(taskId)?.jobId).toBe(first.job.jobId);
    expect(store.completedReplan(taskId)).toBeUndefined();
  });

});
