import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager.js";
import {
  DispatchObservationStore,
  type DispatchObservationIdentity,
} from "../../src/monitor/dispatch-observation-store.js";

interface ObservationLifecycle {
  jobs: Map<string, DispatchJob>;
  trackChildClose(child: ChildProcess, job: DispatchJob): void;
  trackExitHandler(handler: Promise<void>, job: DispatchJob): void;
  recordAuthRetryReplacement(previous: DispatchJob, replacement: DispatchJob): void;
}

describe("dispatch terminal observation lifecycle", () => {
  let root: string;
  let manager: DispatchManager;
  let internals: ObservationLifecycle;
  let now: number;
  let pendingReleases: Array<() => void>;
  let children: EventEmitter[];
  const identity: DispatchObservationIdentity = {
    projectId: "project-a",
    taskId: "TASK-001",
    jobId: "federated-a",
    hostId: "host-a",
    leaseId: "lease-a",
    sessionId: "session-a",
  };
  const makeJob = (overrides: Partial<DispatchJob> = {}): DispatchJob => ({
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    pid: 123,
    startedAt: "2026-09-11T10:00:00.000Z",
    status: "running",
    output: [],
    federatedJobId: identity.jobId,
    federatedHostId: identity.hostId,
    federatedLeaseId: identity.leaseId,
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-observation-lifecycle-"));
    manager = new DispatchManager(root, path.join(root, "unused.js"));
    manager.setObservationProjectId(identity.projectId);
    internals = manager as unknown as ObservationLifecycle;
    now = Date.parse("2026-09-11T12:00:00.000Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    pendingReleases = [];
    children = [];
  });
  afterEach(async () => {
    for (const release of pendingReleases) release();
    for (const child of children) child.emit("close", 0, null);
    await expect(manager.waitForIdle()).resolves.toBe(true);
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Fake the producer and child events; exercise the real manager's close/exit
  // accounting, canonical observation writer, retention, and exact read route.
  function ownAttempt(job = makeJob()): {
    child: EventEmitter;
    job: DispatchJob;
    release: () => void;
  } {
    const child = new EventEmitter();
    children.push(child);
    internals.jobs.set(job.taskId, job);
    internals.trackChildClose(child as unknown as ChildProcess, job);
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    pendingReleases.push(release);
    child.once("exit", (code: number) => {
      const handler = work.then(() => {
        job.exitCode = code;
        job.status = code === 0 ? "completed" : "failed";
        job.output.push("owned exit work finished");
      });
      internals.trackExitHandler(handler, job);
    });
    return { child, job, release };
  }

  it("records only after closed stdio and pending exit work, then ages from completion", async () => {
    const { child, job, release } = ownAttempt();
    child.emit("exit", 0);
    expect(new DispatchObservationStore(root, identity.projectId).read(identity)).toBeUndefined();
    child.emit("close", 0, null);
    expect(job.completedAt).toBeUndefined();
    release();
    await expect(manager.waitForIdle()).resolves.toBe(true);
    expect(job.completedAt).toBe(new Date(now).toISOString());
    manager.cleanup(60_000);
    expect(manager.getJob(identity.taskId)).toBe(job);
    now += 60_001;
    manager.cleanup(60_000);
    expect(manager.getJob(identity.taskId)).toBeUndefined();
    const restarted = new DispatchManager(root, path.join(root, "unused.js"));
    restarted.setObservationProjectId(identity.projectId);
    expect(restarted.getDispatchObservation(identity)).toMatchObject({
      source: "durable",
      settled: true,
      identity,
      job: { sessionId: identity.sessionId, status: "completed", completedAt: job.completedAt },
    });
    expect(restarted.getJob(identity.taskId)).toBeUndefined();
  });

  it("does not report a terminal attempt while stdio remains open", async () => {
    const { child, job, release } = ownAttempt();
    child.emit("exit", 0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(job.status).toBe("completed");
    expect(job.completedAt).toBeUndefined();
    expect(manager.getDispatchObservation(identity)?.settled).toBe(false);
    expect(new DispatchObservationStore(root, identity.projectId).read(identity)).toBeUndefined();
    child.emit("close", 0, null);
    await expect(manager.waitForIdle()).resolves.toBe(true);
    expect(manager.getDispatchObservation(identity)?.settled).toBe(true);
  });

  it("retains an old attempt separately when a newer session occupies the task", async () => {
    const { child, job, release } = ownAttempt();
    child.emit("exit", 0);
    release();
    child.emit("close", 0, null);
    await manager.waitForIdle();
    const newer = makeJob({ sessionId: "session-newer" });
    internals.jobs.set(identity.taskId, newer);
    expect(manager.getDispatchObservation(identity)).toMatchObject({
      source: "durable",
      job: { sessionId: job.sessionId },
    });
    expect(manager.getJob(identity.taskId)).toBe(newer);
    expect(manager.getDispatchObservation({ ...identity, leaseId: "different" })).toBeUndefined();
  });

  it("retains the original completion time and job when observation persistence fails", async () => {
    const write = jest.spyOn(DispatchObservationStore.prototype, "write").mockImplementation(() => {
      throw new Error("fixture disk fault");
    });
    const { child, job, release } = ownAttempt();
    child.emit("exit", 0);
    release();
    child.emit("close", 0, null);
    await manager.waitForIdle();
    const completedAt = job.completedAt;
    now += 120_000;
    manager.cleanup(60_000);
    expect(manager.getJob(identity.taskId)).toBe(job);
    expect(() => manager.getDispatchObservation(identity)).toThrow(
      "Durable dispatch observation unavailable",
    );
    expect(job.completedAt).toBe(completedAt);
    write.mockRestore();
    manager.cleanup(60_000);
    expect(manager.getJob(identity.taskId)).toBeUndefined();
    expect(manager.getDispatchObservation(identity)).toMatchObject({
      source: "durable",
      job: { completedAt },
    });
  });

  it("records an API-key replacement link only for the same complete federated attempt identity", () => {
    const previous = makeJob({ status: "failed", exitCode: 1 });
    internals.recordAuthRetryReplacement(
      previous,
      makeJob({ sessionId: "newer", federatedLeaseId: "another-lease" }),
    );
    expect(previous.replacementSessionId).toBeUndefined();
    internals.recordAuthRetryReplacement(previous, makeJob({ sessionId: "selected-next" }));
    expect(previous.replacementSessionId).toBe("selected-next");
  });

  it("does not guess a completion clock for legacy or manually retained recovery records", () => {
    const job = makeJob({ status: "completed", exitCode: 0 });
    internals.jobs.set(identity.taskId, job);
    manager.cleanup(60_000);
    expect(manager.getJob(identity.taskId)).toBe(job);
    expect(job.completedAt).toBeUndefined();
  });
});
