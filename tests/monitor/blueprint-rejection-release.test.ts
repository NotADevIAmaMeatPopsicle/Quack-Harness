import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { createMonitorServer } from "../../src/monitor/server";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import { withTaskCreationReservation } from "../../src/core/task-creation-reservation";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
} from "../helpers/divergent-task-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

async function postJson(
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("blueprint decisions release an exited approval pause", () => {
  let fixture: DivergentTaskFixture;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    fixture = createDivergentTaskFixture("parent-first", {
      prefix: "quack-blueprint-reject-release-",
    });
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
    execFileSync("git", ["init"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "quack-tests@example.invalid"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Tests"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
  });

  afterEach(async () => {
    if (stopServer) await stopServer();
    stopServer = undefined;
    jest.restoreAllMocks();
    fixture.cleanup();
  });

  it("removes the manager guard without invoking operator stop or writing a barrier", async () => {
    let capturedJobs: Map<string, DispatchJob> | undefined;
    let injected = false;
    jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
      this: DispatchManager,
      taskId: string,
    ) {
      const jobs = (this as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      capturedJobs = jobs;
      if (!injected && taskId === "TASK-100") {
        const job: DispatchJob = {
          taskId,
          sessionId: "quack-TASK-100-paused",
          pid: 4242,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          status: "awaiting_approval",
          exitCode: 1,
          output: [],
        };
        jobs.set(taskId, job);
        injected = true;
      }
      return jobs.get(taskId);
    });
    const stopSpy = jest.spyOn(DispatchManager.prototype, "stop");
    const resolutionSpy = jest.spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision");
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

    const response = await postJson(started.port, "/api/tasks/TASK-100/blueprint/reject", {
      rejectionReason: "Needs a safer plan",
    });

    expect(response.status).toBe(200);
    expect(capturedJobs).toBeDefined();
    expect(capturedJobs?.has("TASK-100")).toBe(false);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(queueSpy).toHaveBeenCalledWith("TASK-100", "Needs a safer plan", "rejected", true);
    expect(resolutionSpy.mock.invocationCallOrder[0]).toBeLessThan(
      queueSpy.mock.invocationCallOrder[0],
    );
    expect(fs.existsSync(path.join(fixture.root, ".quack", "operator-stop-barriers"))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, ".quack", "logs", "approvals", "TASK-100.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      taskId: "TASK-100",
      state: "rejected",
      rejectionReason: "Needs a safer plan",
    });
  });

  it("refuses before changing the durable decision when exit proof is missing", async () => {
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
          sessionId: "quack-TASK-100-unproven",
          pid: 4242,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          status: "awaiting_approval",
          output: [],
        });
        injected = true;
      }
      return jobs.get(taskId);
    });

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

    const response = await postJson(started.port, "/api/tasks/TASK-100/blueprint/reject", {
      rejectionReason: "Must remain pending",
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "approval_decision_conflict",
      reason: "exit_unproven",
    });
    expect(capturedJobs?.has("TASK-100")).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, ".quack", "logs", "approvals", "TASK-100.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({ taskId: "TASK-100", state: "pending" });
    expect(fs.existsSync(path.join(fixture.root, ".quack", "operator-stop-barriers"))).toBe(false);
    capturedJobs?.delete("TASK-100");
  });

  it("routes approval through the same reservation before starting its resume", async () => {
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
          sessionId: "quack-TASK-100-approve-paused",
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
    const stopSpy = jest.spyOn(DispatchManager.prototype, "stop");
    const resolutionSpy = jest.spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision");
    const queueResumeSpy = jest.spyOn(DispatchQueue.prototype, "recordApprovalResume");
    const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-100",
      sessionId: "quack-TASK-100-resumed",
      pid: 4243,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    });

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

    const response = await postJson(started.port, "/api/tasks/TASK-100/blueprint/approve", {
      actor: "reviewer",
      reason: "Plan is ready",
    });

    expect(response.status).toBe(200);
    expect(capturedJobs?.has("TASK-100")).toBe(false);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(resolutionSpy).toHaveBeenCalledWith(
      "TASK-100",
      "blueprint",
      "approved",
      expect.any(Function),
      path.join(fixture.root, ".quack", "logs"),
    );
    expect(resolutionSpy.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0],
    );
    expect(queueResumeSpy).toHaveBeenCalledWith("TASK-100", true);
    expect(startSpy).toHaveBeenCalledWith(
      "TASK-100",
      expect.objectContaining({ resume: true }),
      expect.any(Object),
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, ".quack", "logs", "approvals", "TASK-100.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({ taskId: "TASK-100", state: "approved" });
  });

  it("does not consume a blueprint approval when the parent decomposes while admission waits", async () => {
    const resolutionSpy = jest.spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision");
    const startSpy = jest.spyOn(DispatchManager.prototype, "start");
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
    let responsePromise!: ReturnType<typeof postJson>;
    let settled = false;

    await withTaskCreationReservation(
      fixture.taskDir,
      { creator: "dispatch-admission", requestedIds: [] },
      async () => {
        responsePromise = postJson(started.port, "/api/tasks/TASK-100/blueprint/approve", {
          actor: "reviewer",
          reason: "must lose the race",
        }).then((response) => {
          settled = true;
          return response;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        fs.writeFileSync(
          fixture.parentPath,
          fixture.parentContent.replace("- **Status:** READY", "- **Status:** DECOMPOSED"),
          "utf-8",
        );
      },
    );

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "decomposition_recovery_required",
      details: { admissionDisposition: "decomposed" },
    });
    expect(resolutionSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, ".quack", "logs", "approvals", "TASK-100.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      state: "pending",
    });
  });
});
