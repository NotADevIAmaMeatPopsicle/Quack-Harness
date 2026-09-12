import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createMonitorServer } from "../../src/monitor/server";
import { generateProjectId } from "../../src/monitor/project-registry";
import { EventReader } from "../../src/monitor/event-reader";
import type { QuackEvent } from "../../src/monitor/event-types";
import { PrepJobStore } from "../../src/monitor/prep-job-store";
import { PrepCache, computeContentHash } from "../../src/monitor/prep-cache";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { loadFederatedJob, saveFederatedJob } from "../../src/monitor/federation/store";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }),
}));

describe("prep completion wakes current federation prerequisites", () => {
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let callback: ((event: QuackEvent) => void | Promise<void>) | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-refill-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack/logs"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../fixtures/task-valid-minimal.md"),
      path.join(root, "docs/tasks/TASK-001.md"),
    );
    // Only filesystem delivery is replaced. The real server callback, current
    // cache reader, declaration scanner, job fence and scheduler all execute.
    jest.spyOn(EventReader.prototype, "watch").mockImplementation((onEvent) => {
      callback = onEvent;
      return Promise.resolve(() => Promise.resolve());
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (stop) await stop();
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      stop = undefined;
      callback = undefined;
    }
  });
  it.each([false, true])(
    "uses persisted prep completion only as a wake-up (rejected=%s)",
    async (rejected) => {
      const projectId = generateProjectId(root);
      const logDir = path.join(root, ".quack/logs");
      const queued = queueFederatedJobRecord({
        projectId,
        taskId: "TASK-001",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        preferredHostId: "worker",
        provenance: { channel: "federation-queue", tokenId: "fixture" },
      });
      await saveFederatedJob(root, {
        ...queued,
        status: "blocked",
        error: "preflight_gate_missing",
        nextAction: "prep_or_preflight",
        retryable: true,
        blockReasonCode: "pending_manual_handoff",
      });
      await new ListenerRegistry(root).register({
        hostId: "worker",
        capabilities: ["dispatch"],
        maxConcurrentJobs: 1,
      });
      const runtime = await createMonitorServer({
        projectRoot: root,
        taskDir: "docs/tasks",
        logDir,
        host: "127.0.0.1",
        port: 0,
      }).start();
      stop = runtime.stop;
      const result = {
        schemaValid: true,
        schemaErrors: [],
        depthScore: rejected ? 4.0 : 4.9,
        depthReady: !rejected,
        deficiencies: [],
        outcome: rejected ? ("rejected" as const) : ("pass" as const),
        contentHash: computeContentHash(
          fs.readFileSync(path.join(root, "docs/tasks/TASK-001.md"), "utf-8"),
        ),
      };
      const now = new Date().toISOString();
      await new PrepCache(root).write({ ...result, taskId: "TASK-001", preparedAt: now });
      const jobId = randomUUID();
      new PrepJobStore(logDir, projectId).write({
        jobId,
        taskId: "TASK-001",
        pid: 42,
        startedAt: now,
        completedAt: now,
        status: "completed",
        exitCode: 0,
        signal: null,
        result,
        diagnostics: {
          stdout: JSON.stringify(result),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      });
      const event = JSON.parse(
        fs.readFileSync(path.join(logDir, `events-prep-${jobId}.jsonl`), "utf-8"),
      ) as QuackEvent;
      if (!callback) throw new Error("Server did not register its event watcher");
      await callback(event);
      expect(await loadFederatedJob(root, queued.jobId)).toMatchObject({
        status: rejected ? "blocked" : "assigned",
      });
      if (!rejected) expect((await loadFederatedJob(root, queued.jobId))?.hostId).toBe("worker");
    },
  );
});
