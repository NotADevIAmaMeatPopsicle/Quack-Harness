import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NoopDB } from "../../src/db/noop-db";
import { TaskService } from "../../src/monitor/task-service";
import { EventReader } from "../../src/monitor/event-reader";
import { EventWriter } from "../../src/monitor/event-emitter";
import { PrepCache, computeContentHash } from "../../src/monitor/prep-cache";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { admitFederatedQueueRecord } from "../../src/monitor/federation/queue-admission";
import {
  assignFederatedJob,
  recheckRecoverableFederatedBlocks,
  runSwarmSchedulerTick,
} from "../../src/monitor/federation/scheduling";
import {
  listFederatedJobs,
  loadFederatedJob,
  saveFederatedJob,
  updateFederatedJob,
} from "../../src/monitor/federation/store";
import type {
  FederatedJobRecord,
  FederationProjectContext,
} from "../../src/monitor/federation/types";

const provenance = { channel: "federation-queue" as const, tokenId: "fixture" };
describe("recoverable federation prerequisites", () => {
  let root: string;
  let file: string;
  let project: FederationProjectContext;
  let cache: PrepCache;
  const deps = {
    createWriter: (p: FederationProjectContext, sessionId: string, taskId: string) =>
      new EventWriter({
        project: p.projectId,
        sessionId,
        taskId,
        logDir: path.join(p.projectRoot!, ".quack/logs"),
      }),
  };
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-recoverable-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    file = path.join(root, "docs/tasks/TASK-001.md");
    fs.copyFileSync(path.join(__dirname, "../fixtures/task-valid-minimal.md"), file);
    cache = new PrepCache(root);
    project = {
      projectId: "fixture",
      projectRoot: root,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: cache,
      reader: new EventReader(path.join(root, ".quack/logs")),
      db: new NoopDB(),
    };
    await new ListenerRegistry(root).register({
      hostId: "fixture-host",
      capabilities: ["dispatch", "verify"],
      maxConcurrentJobs: 1,
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = () => ({
    projectId: "fixture",
    taskId: "TASK-001",
    jobType: "dispatch" as const,
    requiredCapabilities: ["dispatch"],
    preferredHostId: "fixture-host",
    provenance,
  });
  async function prepared(overrides: Record<string, unknown> = {}): Promise<void> {
    const prep = {
      taskId: "TASK-001",
      preparedAt: new Date().toISOString(),
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.9,
      depthReady: true,
      deficiencies: [],
      outcome: "pass" as const,
      contentHash: computeContentHash(fs.readFileSync(file, "utf-8")),
      ...overrides,
    };
    await cache.write(prep);
  }
  async function blocked(): Promise<FederatedJobRecord> {
    const queued = queueFederatedJobRecord(input());
    await saveFederatedJob(root, queued);
    const job = await assignFederatedJob(project, queued, deps);
    expect(job).toMatchObject({ status: "blocked", error: "preflight_gate_missing" });
    return job;
  }
  it("rechecks a missing prep at a blocked-only tick and assigns the same job exactly once", async () => {
    const job = await blocked();
    await prepared();
    await Promise.all([
      runSwarmSchedulerTick(project, {}, deps),
      runSwarmSchedulerTick(project, {}, deps),
    ]);
    const rows = await listFederatedJobs(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: job.jobId, status: "assigned", hostId: "fixture-host" });
    const events = fs.readFileSync(
      path.join(root, ".quack/logs", `events-federation-${job.jobId}.jsonl`),
      "utf-8",
    );
    expect(
      events.split("\n").filter((line) => line.includes('"stage":"federated_job_assigned"')),
    ).toHaveLength(1);
  });
  it.each([
    ["rejected", { schemaValid: true, depthReady: false, depthScore: 4.0, outcome: "rejected" }],
    ["wrongly typed", { outcome: ["pass"] }],
    ["inconsistent schema", { schemaValid: false }],
    ["non-current hash", { contentHash: "a".repeat(64) }],
  ])("retains blocked state for %s prep", async (_name, values) => {
    const job = await blocked();
    await prepared(values as Record<string, unknown>);
    await recheckRecoverableFederatedBlocks(project);
    const persisted = await loadFederatedJob(root, job.jobId);
    expect(persisted).toMatchObject({
      status: "blocked",
    });
    expect(persisted?.lease).toBeUndefined();
  });
  it("does not carry a prior passing hash over an edited declaration", async () => {
    const job = await blocked();
    await prepared();
    fs.appendFileSync(file, "\nChanged current task content.\n");
    await recheckRecoverableFederatedBlocks(project);
    expect(await loadFederatedJob(root, job.jobId)).toMatchObject({
      status: "blocked",
      error: "preflight_gate_stale",
    });
  });
  it("refuses a new claimant inserted after discovery and rereads a concurrent cancellation", async () => {
    const job = await blocked();
    await prepared();
    await recheckRecoverableFederatedBlocks(project, {
      afterCandidateDiscoveredForTest: () => {
        fs.copyFileSync(file, path.join(root, "docs/tasks/TASK-999.md"));
        return Promise.resolve();
      },
    });
    expect(await loadFederatedJob(root, job.jobId)).toMatchObject({
      status: "blocked",
      nextAction: "resolve_duplicate_claimants",
    });
    fs.unlinkSync(path.join(root, "docs/tasks/TASK-999.md"));
    await saveFederatedJob(root, job);
    await recheckRecoverableFederatedBlocks(project, {
      afterCandidateDiscoveredForTest: async () => {
        await updateFederatedJob(root, job.jobId, (current) => ({
          ...current,
          status: "canceled",
          canceledBy: "human",
        }));
      },
    });
    expect(await loadFederatedJob(root, job.jobId)).toMatchObject({
      status: "canceled",
      canceledBy: "human",
    });
  });
  it.each([
    { nextAction: "manual_handoff", error: "operator_uncertainty" },
    { hostId: "fixture-host" },
    { remoteSessionId: "prior-paid-run" },
    { assignedAt: "2026-09-11T00:00:00.000Z" },
    { projectId: "another-project" },
  ])(
    "never releases manual, previously assigned, or mismatched identity records: %j",
    async (override) => {
      const job = { ...(await blocked()), ...override };
      await saveFederatedJob(root, job);
      await prepared();
      const before = await loadFederatedJob(root, job.jobId);
      await recheckRecoverableFederatedBlocks(project);
      expect(await loadFederatedJob(root, job.jobId)).toEqual(before);
    },
  );
  it("permits readiness refresh while paused but refuses assignment at the last gate", async () => {
    const job = await blocked();
    await prepared();
    await runSwarmSchedulerTick(project, {}, { ...deps, canDispatch: () => false });
    expect(await loadFederatedJob(root, job.jobId)).toMatchObject({ status: "queued" });
    await runSwarmSchedulerTick(project, {}, deps);
    expect(await loadFederatedJob(root, job.jobId)).toMatchObject({ status: "assigned" });
  });
  it("persists capacity and unavailable-listener decisions through one existing job fence", async () => {
    await prepared();
    const queued = queueFederatedJobRecord(input());
    await saveFederatedJob(root, queued);
    await new ListenerRegistry(root).heartbeat("fixture-host", { healthy: true, currentLoad: 1 });
    expect(await assignFederatedJob(project, queued, deps)).toMatchObject({
      status: "queued",
      nextAction: "wait_for_capacity",
    });
    await new ListenerRegistry(root).heartbeat("fixture-host", { healthy: false, currentLoad: 0 });
    expect(await assignFederatedJob(project, queued, deps)).toMatchObject({
      status: "blocked",
      error: "host_unhealthy",
    });
    expect(await loadFederatedJob(root, queued.jobId)).toMatchObject({
      status: "blocked",
      error: "host_unhealthy",
    });
    await new ListenerRegistry(root).heartbeat("fixture-host", { healthy: true, currentLoad: 0 });
    await runSwarmSchedulerTick(project, {}, deps);
    expect(await loadFederatedJob(root, queued.jobId)).toMatchObject({
      status: "assigned",
      hostId: "fixture-host",
    });
  });

  it("deduplicates simultaneous enqueue and preserves first provenance", async () => {
    const results = await Promise.all([
      admitFederatedQueueRecord(project, input()),
      admitFederatedQueueRecord(project, {
        ...input(),
        provenance: { ...provenance, tokenId: "second" },
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(await listFederatedJobs(root)).toHaveLength(1);
    const again = await admitFederatedQueueRecord(project, input());
    expect(again).toMatchObject({ ok: true, created: false });
    if (!again.ok) throw new Error("Expected duplicate reuse");
    expect(results.every((result) => result.ok && result.record.jobId === again.record.jobId)).toBe(
      true,
    );
  });
  it("reuses a recoverable blocked attempt but refuses manual state or different execution intent", async () => {
    const job = await blocked();
    expect(await admitFederatedQueueRecord(project, input())).toMatchObject({
      ok: true,
      created: false,
      record: { jobId: job.jobId },
    });
    expect(
      await admitFederatedQueueRecord(project, { ...input(), preferredHostId: "other" }),
    ).toMatchObject({ ok: false, error: "federated_queue_conflict" });
    await updateFederatedJob(root, job.jobId, (current) => ({
      ...current,
      error: "manual",
      nextAction: "manual_handoff",
    }));
    expect(await admitFederatedQueueRecord(project, input())).toMatchObject({
      ok: false,
      error: "federated_queue_conflict",
    });
    expect(await listFederatedJobs(root)).toHaveLength(1);
  });
});
