import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { createMonitorServer } from "../../src/monitor/server";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { QueueItemStatus } from "../../src/queue/queue-types";
import { computeSpecIdentity } from "../../src/core/spec-identity";
import { withTaskCreationReservation } from "../../src/core/task-creation-reservation";
import {
  armLocalFederatedResume,
  readLocalFederatedResumeState,
} from "../../src/dispatcher/federated-resume-state";
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
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
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("judge decisions release only a proven approval pause", () => {
  let fixture: DivergentTaskFixture;
  let logDir: string;
  let approvalPath: string;
  let stopServer: (() => Promise<void>) | undefined;
  let externalBarrierDir: string | undefined;

  function writePendingJudgeApproval(): void {
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
    fs.writeFileSync(
      approvalPath,
      JSON.stringify({
        taskId: "TASK-100",
        state: "pending",
        diff: "diff --git a/file.ts b/file.ts",
        filesModified: ["file.ts"],
        filesCreated: [],
        verificationPassed: true,
        createdAt: new Date().toISOString(),
        specIdentity: computeSpecIdentity(fixture.parentContent),
        specIdentityVersion: 1,
      }),
      "utf-8",
    );
  }

  async function startMonitor(): Promise<number> {
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
    return started.port;
  }

  beforeEach(() => {
    fixture = createDivergentTaskFixture("parent-first", {
      prefix: "quack-judge-decision-release-",
    });
    writeTestAdapter(fixture.root);
    logDir = path.join(fixture.root, ".quack", "logs");
    approvalPath = path.join(logDir, "approvals", "TASK-100-judge.json");
    writePendingJudgeApproval();
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
    if (externalBarrierDir) {
      fs.rmSync(externalBarrierDir, { recursive: true, force: true });
      externalBarrierDir = undefined;
    }
  });

  it.each(["approve", "reject"])(
    "does not consume judge state for %s when the parent decomposes while admission waits",
    async (action) => {
      const resolutionSpy = jest.spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision");
      const startSpy = jest.spyOn(DispatchManager.prototype, "start");
      const port = await startMonitor();
      let responsePromise!: ReturnType<typeof postJson>;
      let settled = false;

      await withTaskCreationReservation(
        fixture.taskDir,
        { creator: "dispatch-admission", requestedIds: [] },
        async () => {
          responsePromise = postJson(port, `/api/tasks/TASK-100/judge/${action}`, {
            actor: "reviewer",
            reason: "must lose the race",
            rejectionReason: "must lose the race",
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
      expect(response.body).toMatchObject({
        code: "decomposition_recovery_required",
        details: { admissionDisposition: "decomposed" },
      });
      expect(resolutionSpy).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
        state: "pending",
      });
    },
  );

  it.each(["awaiting_approval", "running"] satisfies QueueItemStatus[])(
    "releases an exited judge rejection before a %s queue retry and replacement start",
    async (queueStatus) => {
      let jobs: Map<string, DispatchJob> | undefined;
      let resumedItem: ReturnType<DispatchQueue["getItem"]> | undefined;
      let injected = false;
      jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
        this: DispatchManager,
        taskId: string,
      ) {
        jobs = (this as unknown as { jobs: Map<string, DispatchJob> }).jobs;
        if (!injected && taskId === "TASK-100") {
          jobs.set(taskId, {
            taskId,
            sessionId: "quack-TASK-100-judge-paused",
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
      const originalRecordApprovalResume = Object.getOwnPropertyDescriptor(
        DispatchQueue.prototype,
        "recordApprovalResume",
      )?.value as DispatchQueue["recordApprovalResume"];
      const queueResumeSpy = jest
        .spyOn(DispatchQueue.prototype, "recordApprovalResume")
        .mockImplementation(function (
          this: DispatchQueue,
          taskId: string,
          managerPauseReleased?: boolean,
        ) {
          const items = (this as unknown as { items: Map<string, unknown> }).items;
          items.set(taskId, {
            taskId,
            status: queueStatus,
            priority: 2,
            blockedBy: [],
            enqueuedAt: new Date().toISOString(),
            retryCount: 0,
          });
          const recorded = originalRecordApprovalResume.call(this, taskId, managerPauseReleased);
          resumedItem = this.getItem(taskId);
          return recorded;
        });
      const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
        taskId: "TASK-100",
        sessionId: "quack-TASK-100-judge-retry",
        pid: 4243,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
      });
      const port = await startMonitor();

      const response = await postJson(port, "/api/tasks/TASK-100/judge/reject", {
        rejectionReason: "Repair the retry lifecycle",
      });

      expect(response.status).toBe(200);
      expect(jobs?.has("TASK-100")).toBe(false);
      expect(stopSpy).not.toHaveBeenCalled();
      expect(resolutionSpy).toHaveBeenCalledWith(
        "TASK-100",
        "judge",
        "rejected",
        expect.any(Function),
        logDir,
      );
      expect(queueResumeSpy).toHaveBeenCalledWith("TASK-100", true);
      expect(resumedItem).toMatchObject({
        status: "running",
        dispatchOptions: { resume: true },
      });
      expect(resolutionSpy.mock.invocationCallOrder[0]).toBeLessThan(
        queueResumeSpy.mock.invocationCallOrder[0],
      );
      expect(queueResumeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        startSpy.mock.invocationCallOrder[0],
      );
      expect(startSpy).toHaveBeenCalledWith(
        "TASK-100",
        expect.objectContaining({ judgeFeedback: "Repair the retry lifecycle" }),
        expect.objectContaining({ taskId: "TASK-100", claimants: [] }),
      );
      expect(fs.existsSync(approvalPath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, ".quack", "operator-stop-barriers"))).toBe(
        false,
      );
    },
  );

  it.each(["awaiting_approval", "running"] satisfies QueueItemStatus[])(
    "releases an exited judge approval before a %s queue resume and replacement start",
    async (queueStatus) => {
      let jobs: Map<string, DispatchJob> | undefined;
      let resumedItem: ReturnType<DispatchQueue["getItem"]> | undefined;
      let injected = false;
      jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
        this: DispatchManager,
        taskId: string,
      ) {
        jobs = (this as unknown as { jobs: Map<string, DispatchJob> }).jobs;
        if (!injected && taskId === "TASK-100") {
          jobs.set(taskId, {
            taskId,
            sessionId: "quack-TASK-100-judge-paused",
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
      const originalRecordApprovalResume = Object.getOwnPropertyDescriptor(
        DispatchQueue.prototype,
        "recordApprovalResume",
      )?.value as DispatchQueue["recordApprovalResume"];
      const queueResumeSpy = jest
        .spyOn(DispatchQueue.prototype, "recordApprovalResume")
        .mockImplementation(function (
          this: DispatchQueue,
          taskId: string,
          managerPauseReleased?: boolean,
        ) {
          const items = (this as unknown as { items: Map<string, unknown> }).items;
          items.set(taskId, {
            taskId,
            status: queueStatus,
            priority: 2,
            blockedBy: [],
            enqueuedAt: new Date().toISOString(),
            retryCount: 0,
          });
          const recorded = originalRecordApprovalResume.call(this, taskId, managerPauseReleased);
          resumedItem = this.getItem(taskId);
          return recorded;
        });
      const startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
        taskId: "TASK-100",
        sessionId: "quack-TASK-100-judge-approved",
        pid: 4243,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
      });
      const port = await startMonitor();

      const response = await postJson(port, "/api/tasks/TASK-100/judge/approve", {
        actor: "reviewer",
      });

      expect(response.status).toBe(200);
      expect(jobs?.has("TASK-100")).toBe(false);
      expect(stopSpy).not.toHaveBeenCalled();
      expect(resolutionSpy).toHaveBeenCalledWith(
        "TASK-100",
        "judge",
        "approved",
        expect.any(Function),
        logDir,
      );
      expect(queueResumeSpy).toHaveBeenCalledWith("TASK-100", true);
      expect(resumedItem).toMatchObject({
        status: "running",
        dispatchOptions: { resume: true },
      });
      expect(queueResumeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        startSpy.mock.invocationCallOrder[0],
      );
      expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
        taskId: "TASK-100",
        state: "approved",
      });
    },
  );

  it("rolls a judge rejection queue resume back when replacement start fails", async () => {
    const queueResumeSpy = jest
      .spyOn(DispatchQueue.prototype, "recordApprovalResume")
      .mockReturnValue(true);
    const requeueSpy = jest
      .spyOn(DispatchQueue.prototype, "requeueApprovalResume")
      .mockReturnValue(true);
    jest.spyOn(DispatchManager.prototype, "start").mockImplementation(() => {
      throw new Error("spawn refused");
    });
    const port = await startMonitor();

    const response = await postJson(port, "/api/tasks/TASK-100/judge/reject", {
      rejectionReason: "Retry safely",
    });

    expect(response.status).toBe(500);
    expect(queueResumeSpy).toHaveBeenCalledWith("TASK-100", false);
    expect(requeueSpy).toHaveBeenCalledWith("TASK-100", "spawn refused");
  });

  it("serializes simultaneous approve and reject requests after a monitor restart", async () => {
    const originalResolve = Object.getOwnPropertyDescriptor(
      DispatchManager.prototype,
      "resolveApprovalPauseDecision",
    )?.value as DispatchManager["resolveApprovalPauseDecision"];
    let entered!: () => void;
    const decisionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const decisionHeld = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let holdFirstApproval = true;
    jest
      .spyOn(DispatchManager.prototype, "resolveApprovalPauseDecision")
      .mockImplementation(function (this: DispatchManager, ...args) {
        const [taskId, gate, state, persistDecision, decisionLogDir, options] = args;
        if (gate === "judge" && state === "approved" && holdFirstApproval) {
          holdFirstApproval = false;
          return originalResolve.call(
            this,
            taskId,
            gate,
            state,
            async () => {
              entered();
              await decisionHeld;
              return persistDecision();
            },
            decisionLogDir,
            options,
          );
        }
        return originalResolve.call(
          this,
          taskId,
          gate,
          state,
          persistDecision,
          decisionLogDir,
          options,
        );
      });
    jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-100",
      sessionId: "quack-TASK-100-approved",
      pid: 4244,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    });
    const port = await startMonitor();

    const approve = postJson(port, "/api/tasks/TASK-100/judge/approve", {
      actor: "reviewer",
    });
    await decisionEntered;
    let rejectSettled = false;
    const rejectPromise = postJson(port, "/api/tasks/TASK-100/judge/reject", {
      rejectionReason: "Conflicting decision",
    }).then((response) => {
      rejectSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rejectSettled).toBe(false);
    finish();
    const [approveResponse, reject] = await Promise.all([approve, rejectPromise]);

    expect(reject.status).toBe(409);
    expect(reject.body).toMatchObject({
      code: "approval_decision_conflict",
      reason: "approval_not_pending",
    });
    expect(approveResponse.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
      taskId: "TASK-100",
      state: "approved",
    });
  });

  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const)(
    "records a federated judge %s decision and defers the replacement child",
    async (routeAction, durableAction) => {
      const sessionId = "quack-TASK-100-federated-pause";
      fs.writeFileSync(
        path.join(logDir, "checkpoint-TASK-100.json"),
        JSON.stringify({ taskId: "TASK-100", sessionId }),
      );
      fs.writeFileSync(
        path.join(logDir, `events-${sessionId}.jsonl`),
        `${JSON.stringify({
          sessionId,
          taskId: "TASK-100",
          project: "fixture",
          timestamp: new Date().toISOString(),
          stage: "session_start",
          payload: { jobId: "fed-TASK-100", hostId: "laptop", federated: true },
        })}\n`,
      );
      const pauseOpenedAt = (
        JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as {
          createdAt: string;
        }
      ).createdAt;
      armLocalFederatedResume(logDir, {
        projectId: "fixture",
        taskId: "TASK-100",
        jobType: "dispatch",
        gate: "judge",
        jobId: "fed-TASK-100",
        hostId: "laptop",
        sessionId,
        generation: 1,
        releaseNonce: "nonce-1",
        pauseOpenedAt,
      });
      const startSpy = jest.spyOn(DispatchManager.prototype, "start");
      const queueResumeSpy = jest.spyOn(DispatchQueue.prototype, "recordApprovalResume");
      const port = await startMonitor();

      const response = await postJson(port, `/api/tasks/TASK-100/judge/${routeAction}`, {
        ...(routeAction === "approve"
          ? { actor: "federated-reviewer" }
          : { rejectionReason: "Federated retry" }),
      });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ ok: true, deferred: true });
      expect(startSpy).not.toHaveBeenCalled();
      expect(queueResumeSpy).not.toHaveBeenCalled();
      expect(readLocalFederatedResumeState(logDir, "TASK-100")).toMatchObject({
        status: "decision_recorded",
        decision: {
          action: durableAction,
          ...(routeAction === "reject" ? { reason: "Federated retry" } : {}),
        },
      });
      expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
        state: durableAction,
      });
    },
  );

  it("returns 409 and preserves the judge pend while the child is still running", async () => {
    let jobs: Map<string, DispatchJob> | undefined;
    jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
      this: DispatchManager,
      taskId: string,
    ) {
      jobs = (this as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      if (taskId === "TASK-100" && !jobs.has(taskId)) {
        jobs.set(taskId, {
          taskId,
          sessionId: "quack-TASK-100-running",
          pid: process.pid,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          status: "running",
          output: [],
        });
      }
      return jobs.get(taskId);
    });
    const port = await startMonitor();

    const response = await postJson(port, "/api/tasks/TASK-100/judge/reject", {
      rejectionReason: "Must not commit yet",
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "approval_decision_conflict",
      reason: "dispatch_running",
    });
    expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
      taskId: "TASK-100",
      state: "pending",
    });
    jobs?.delete("TASK-100");
  });

  it("returns 409 before mutation when a restart retained an operator-stop barrier", async () => {
    let persisted = false;
    jest.spyOn(DispatchManager.prototype, "getJob").mockImplementation(function (
      this: DispatchManager,
      taskId: string,
    ) {
      if (!persisted && taskId === "TASK-100") {
        const stopped: DispatchJob = {
          taskId,
          sessionId: "quack-TASK-100-stopped",
          pid: 4245,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          status: "stopped",
          output: [],
          executionRoot: fixture.root,
          operatorStopRequestedAt: new Date().toISOString(),
        };
        const managerInternals = this as unknown as {
          persistOperatorStopBarrier(job: DispatchJob): boolean;
        };
        expect(managerInternals.persistOperatorStopBarrier(stopped)).toBe(true);
        externalBarrierDir = path.dirname(stopped.operatorStopBarrierPath!);
        persisted = true;
      }
      // Simulate the restarted monitor: the durable marker survives but its
      // old in-memory job does not.
      return undefined;
    });
    const port = await startMonitor();

    const response = await postJson(port, "/api/tasks/TASK-100/judge/approve", {
      actor: "reviewer",
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "approval_decision_conflict",
      reason: "operator_stop_barrier",
    });
    expect(JSON.parse(fs.readFileSync(approvalPath, "utf-8"))).toMatchObject({
      taskId: "TASK-100",
      state: "pending",
    });
  });

  it.each(["approve", "reject"])(
    "returns a typed lifecycle conflict for a genuinely missing record on %s",
    async (action) => {
      fs.rmSync(approvalPath);
      const port = await startMonitor();

      const response = await postJson(port, `/api/tasks/TASK-100/judge/${action}`, {});

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: "approval_decision_conflict",
        reason: "approval_missing",
      });
      expect(response.body.error).toContain("approval record does not exist");
    },
  );

  it.each(["approve", "reject"])(
    "does not reclassify corrupt judge storage as a lifecycle conflict on %s",
    async (action) => {
      fs.writeFileSync(approvalPath, "{truncated", "utf-8");
      const port = await startMonitor();

      const response = await postJson(port, `/api/tasks/TASK-100/judge/${action}`, {});

      expect(response.status).toBe(500);
      expect(response.body.code).toBeUndefined();
      expect(response.body.error).toContain("pending record is unreadable");
    },
  );
});
