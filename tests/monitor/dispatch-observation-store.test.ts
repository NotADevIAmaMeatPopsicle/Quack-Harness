import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DispatchObservationStore,
  type DispatchObservationIdentity,
} from "../../src/monitor/dispatch-observation-store.js";
import type { DispatchJob } from "../../src/monitor/dispatch-manager.js";

describe("exact dispatch observations", () => {
  let root: string;
  const identity: DispatchObservationIdentity = {
    projectId: "project-a",
    taskId: "TASK-1",
    jobId: "job-a",
    hostId: "host-a",
    leaseId: "lease-a",
    sessionId: "session-a",
  };
  const completedAt = "2026-09-11T12:01:00.000Z";
  const makeJob = (overrides: Partial<DispatchJob> = {}): DispatchJob => ({
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    pid: 123,
    startedAt: "2026-09-11T10:00:00.000Z",
    status: "completed",
    exitCode: 0,
    output: ["required checks passed"],
    federatedJobId: identity.jobId,
    federatedHostId: identity.hostId,
    federatedLeaseId: identity.leaseId,
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-dispatch-observation-"));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the exact terminal attempt after a fresh store instance", () => {
    new DispatchObservationStore(root, identity.projectId).write(identity, makeJob(), completedAt);
    const result = new DispatchObservationStore(root, identity.projectId).read(identity);
    expect(result).toMatchObject({
      identity,
      job: { status: "completed", completedAt, sessionId: identity.sessionId, exitCode: 0 },
    });
    expect(result?.job.output).toEqual(["required checks passed"]);
  });

  it.each(["projectId", "taskId", "jobId", "hostId", "leaseId", "sessionId"] as const)(
    "does not mistake a different %s for the retained attempt",
    (field) => {
      const store = new DispatchObservationStore(root, identity.projectId);
      store.write(identity, makeJob(), completedAt);
      const different = { ...identity, [field]: `${identity[field]}-other` };
      const reader = new DispatchObservationStore(root, different.projectId);
      expect(reader.read(different)).toBeUndefined();
    },
  );

  it("keeps old and newer sessions independently addressable", () => {
    const store = new DispatchObservationStore(root, identity.projectId);
    store.write(identity, makeJob({ status: "failed", exitCode: 1 }), completedAt, "session-b");
    const nextIdentity = { ...identity, sessionId: "session-b" };
    store.write(
      nextIdentity,
      makeJob({ sessionId: "session-b", output: ["replacement completed"] }),
      completedAt,
    );
    expect(store.read(identity)?.job).toMatchObject({
      status: "failed",
      replacementSessionId: "session-b",
    });
    expect(store.read(nextIdentity)?.job).toMatchObject({
      status: "completed",
      output: ["replacement completed"],
    });
  });

  it("bounds UTF-8 diagnostics consistently for a durable round trip", () => {
    const store = new DispatchObservationStore(root, identity.projectId);
    store.write(
      identity,
      makeJob({ output: Array.from({ length: 250 }, () => "界".repeat(5000)) }),
      completedAt,
    );
    const saved = store.read(identity)!;
    expect(saved.job.output.join("").length).toBe(32 * 1024);
    expect(saved.job.output.every((line) => line.length <= 2048)).toBe(true);
    expect(saved.job.output.length).toBeLessThanOrEqual(200);
  });

  it.each([
    { status: "running" },
    { operatorStopCleanupPending: true },
    { federatedLeaseId: "different-lease" },
    { exitCode: 1 },
    { killedBySignal: "SIGTERM" },
  ] as Partial<DispatchJob>[])(
    "refuses unsettled or inconsistent completion without creating a record: %p",
    (change) => {
      const store = new DispatchObservationStore(root, identity.projectId);
      expect(() => store.write(identity, makeJob(change), completedAt)).toThrow();
      expect(store.read(identity)).toBeUndefined();
    },
  );

  it.each([
    { status: ["completed"] },
    { exitCode: 1 },
    { killedBySignal: "SIGTERM" },
    { completedAt: 2026 },
    { completedAt: "2026-09-11T09:59:59.000Z" },
    { replacementSessionId: "session-a" },
    { branchName: ["main"] },
  ])("refuses malformed stored terminal facts without rewriting evidence: %p", (change) => {
    const store = new DispatchObservationStore(root, identity.projectId);
    store.write(identity, makeJob(), completedAt);
    const directory = path.join(root, ".quack", "dispatch-observations");
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const record = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      job: Record<string, unknown>;
    };
    Object.assign(record.job, change);
    const corrupt = JSON.stringify(record);
    fs.writeFileSync(filename, corrupt);
    expect(() => store.read(identity)).toThrow("malformed");
    expect(fs.readFileSync(filename, "utf8")).toBe(corrupt);
  });

  it("leaves the prior complete record intact if atomic replacement fails", () => {
    const store = new DispatchObservationStore(root, identity.projectId);
    store.write(identity, makeJob(), completedAt);
    jest.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("disk fault"), { code: "EIO" });
    });
    expect(() => store.write(identity, makeJob({ output: ["new tail"] }), completedAt)).toThrow(
      "disk fault",
    );
    expect(store.read(identity)?.job.output).toEqual(["required checks passed"]);
    expect(fs.readdirSync(path.join(root, ".quack", "dispatch-observations"))).toHaveLength(1);
  });
});
