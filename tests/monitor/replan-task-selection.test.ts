// TASK-1339-A R2: replan resolves once and preflights the parent task.
//
// The naive-control tests are MATCHER-ONLY CONTROLS and intentionally pass
// before the production change. The behavioral tests were written to fail
// on both the selected task id and the canonical resolver call count.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import { runPreflight } from "../../src/preflight/preflight-runner";
import * as taskFileResolver from "../../src/core/task-file-resolver";
import {
  armLocalFederatedResume,
  readLocalFederatedResumeState,
} from "../../src/dispatcher/federated-resume-state";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

jest.mock("../../src/preflight/preflight-runner", () => ({
  ...jest.requireActual<object>("../../src/preflight/preflight-runner"),
  runPreflight: jest.fn(() => Promise.resolve({})),
}));

const mockedRunPreflight = runPreflight as jest.MockedFunction<typeof runPreflight>;

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function postJson(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: replan parent selection (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(() => {
      fixture = createDivergentTaskFixture(order, { prefix: "quack-replan-selection-" });
      writeTestAdapter(fixture.root);
      const approvalDir = path.join(fixture.root, ".quack", "logs", "approvals");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        path.join(approvalDir, "TASK-100.json"),
        JSON.stringify({
          taskId: "TASK-100",
          state: "pending",
          blueprint: {},
          createdAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      mockedRunPreflight.mockClear();
    });

    afterEach(async () => {
      if (stopServer) await stopServer();
      stopServer = undefined;
      jest.restoreAllMocks();
      fixture.cleanup();
    });

    it("MATCHER-ONLY CONTROL: the naive prefix read selects the child", () => {
      expect(fixture.naiveSelection).toBe("TASK-100-A-child.md");
    });

    it("resolves once and preflights the parent without touching either spec", async () => {
      const resolveSpy = jest.spyOn(taskFileResolver, "resolveTaskFile");
      let capturedJobs: Map<string, DispatchJob> | undefined;
      let injected = false;
      jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
        this: DispatchManager,
        taskId: string,
      ) {
        const jobs = (this as unknown as { jobs: Map<string, DispatchJob> }).jobs;
        capturedJobs = jobs;
        if (!injected && taskId === "TASK-100") {
          jobs.set(taskId, {
            taskId,
            sessionId: "quack-TASK-100-replan-paused",
            pid: 4242,
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            status: "awaiting_approval",
            exitCode: 1,
            output: [],
          });
          injected = true;
        }
        return jobs.get(taskId);
      });
      const releaseSpy = jest.spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision");
      const queueSpy = jest.spyOn(DispatchQueue.prototype, "settleApprovalRejection");
      const monitor = createMonitorServer({
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        logDir: path.join(fixture.root, ".quack", "logs"),
        adapterPath: path.join(fixture.root, ".quack", "adapter.json"),
        quackRoot: fixture.root,
        port: 0,
        host: "127.0.0.1",
      });
      const started = await monitor.start();
      stopServer = started.stop;

      const response = await postJson(started.port, "/api/tasks/TASK-100/blueprint/replan");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response.status).toBe(200);
      expect(capturedJobs?.has("TASK-100")).toBe(false);
      expect(mockedRunPreflight).toHaveBeenCalledTimes(1);
      expect(mockedRunPreflight.mock.calls[0]?.[0].id).toBe("TASK-100");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(
        "TASK-100",
        "blueprint",
        "rejected",
        expect.any(Function),
        path.join(fixture.root, ".quack", "logs"),
        { allowAlreadyRejected: true },
      );
      expect(releaseSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockedRunPreflight.mock.invocationCallOrder[0],
      );
      expect(queueSpy).toHaveBeenCalledWith(
        "TASK-100",
        "Blueprint re-plan requested; run dispatch after preflight completes",
        "blueprint_replan_requested",
        true,
      );
      expect(queueSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockedRunPreflight.mock.invocationCallOrder[0],
      );
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });

    it("records a federated rejection before successful replan removes the approval", async () => {
      const logDir = path.join(fixture.root, ".quack", "logs");
      const sessionId = "federated-replan-original";
      fs.writeFileSync(
        path.join(logDir, "checkpoint-TASK-100.json"),
        JSON.stringify({ taskId: "TASK-100", sessionId }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(logDir, `events-${sessionId}.jsonl`),
        `${JSON.stringify({
          sessionId,
          taskId: "TASK-100",
          project: "test",
          timestamp: new Date().toISOString(),
          stage: "session_start",
          payload: { jobId: "fed-replan-100", hostId: "laptop", federated: true },
        })}\n`,
        "utf-8",
      );
      const pauseOpenedAt = (
        JSON.parse(fs.readFileSync(path.join(logDir, "approvals", "TASK-100.json"), "utf-8")) as {
          createdAt: string;
        }
      ).createdAt;
      armLocalFederatedResume(logDir, {
        projectId: "test",
        taskId: "TASK-100",
        jobType: "dispatch",
        gate: "blueprint",
        jobId: "fed-replan-100",
        hostId: "laptop",
        sessionId,
        generation: 1,
        releaseNonce: "replan-nonce",
        pauseOpenedAt,
      });

      const monitor = createMonitorServer({
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        logDir,
        adapterPath: path.join(fixture.root, ".quack", "adapter.json"),
        quackRoot: fixture.root,
        port: 0,
        host: "127.0.0.1",
      });
      const started = await monitor.start();
      stopServer = started.stop;

      const response = await postJson(started.port, "/api/tasks/TASK-100/blueprint/replan");
      const approvalPath = path.join(logDir, "approvals", "TASK-100.json");
      await waitForCondition(
        () => !fs.existsSync(approvalPath),
        "successful replan to remove the old approval",
      );

      expect(response.status).toBe(202);
      expect(readLocalFederatedResumeState(logDir, "TASK-100")).toMatchObject({
        status: "decision_recorded",
        decision: {
          action: "rejected",
          reason: "Requested re-plan",
        },
      });
    });
  },
);
