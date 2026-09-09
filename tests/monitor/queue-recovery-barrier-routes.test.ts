// TASK-1338-C pre-change record: all three requests responded immediately.
// Each case failed at the pending-response assertion before its deferred
// recovery barrier was resolved.

import * as http from "node:http";

import express from "express";

import type { FleetBudgetChecker } from "../../src/dispatcher/fleet-budget";
import type { FleetController } from "../../src/dispatcher/fleet-controller";
import type { CostVelocityTracker } from "../../src/dispatcher/cost-velocity";
import type { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { ProgressDetector } from "../../src/monitor/progress-detector";
import { registerFleetRoutes } from "../../src/monitor/routes/fleet";
import { registerQueueRoutes } from "../../src/monitor/routes/queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function post(
  port: number,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
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
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP listener");
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, reject) => server.close((err) => (err ? reject(err) : done()))),
      });
    });
  });
}

async function expectHeldUntil(
  responsePromise: Promise<{ status: number; body: string }>,
  invoked: jest.Mock,
  release: () => void,
): Promise<void> {
  let responded = false;
  void responsePromise.then(() => {
    responded = true;
  });
  for (let attempt = 0; attempt < 20 && invoked.mock.calls.length === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(invoked).toHaveBeenCalledTimes(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(responded).toBe(false);
  release();
  const response = await responsePromise;
  expect(response.status).toBe(200);
}

it("POST /api/queue/start awaits the recovery scan", async () => {
  const gate = deferred();
  const start = jest.fn(() => gate.promise);
  const queue = { start } as unknown as DispatchQueue;
  const app = express();
  app.use(express.json());
  registerQueueRoutes(app, { resolveProject: () => ({ dispatchQueue: queue }) });
  const server = await listen(app);
  try {
    await expectHeldUntil(post(server.port, "/api/queue/start"), start, gate.resolve);
  } finally {
    await server.close();
  }
});

it("POST /api/queue/resume awaits the recovery scan", async () => {
  const gate = deferred();
  const resume = jest.fn(() => gate.promise);
  const queue = { resume } as unknown as DispatchQueue;
  const app = express();
  app.use(express.json());
  registerQueueRoutes(app, { resolveProject: () => ({ dispatchQueue: queue }) });
  const server = await listen(app);
  try {
    await expectHeldUntil(post(server.port, "/api/queue/resume"), resume, gate.resolve);
  } finally {
    await server.close();
  }
});

it("POST /api/fleet/resume waits before fleet resumed state is emitted", async () => {
  const gate = deferred();
  const resume = jest.fn(() => gate.promise);
  const queue = { resume } as unknown as DispatchQueue;
  const fleetResume = jest.fn();
  const fleetController = {
    getState: jest.fn().mockReturnValueOnce("paused").mockReturnValue("running"),
    resume: fleetResume,
  } as unknown as FleetController;
  const emitted = jest.fn();
  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, {
    resolveProject: () => ({
      dispatchQueue: queue,
      fleetController,
      costVelocityTracker: {} as CostVelocityTracker,
      progressDetector: {} as ProgressDetector,
    }),
    fleetBudget: {} as FleetBudgetChecker,
    emitFleetEvent: emitted,
  });
  const server = await listen(app);
  try {
    const response = post(server.port, "/api/fleet/resume");
    let responded = false;
    void response.then(() => {
      responded = true;
    });
    for (let attempt = 0; attempt < 20 && resume.mock.calls.length === 0; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resume).toHaveBeenCalledTimes(1);
    expect(fleetResume).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(responded).toBe(false);
    expect(emitted).not.toHaveBeenCalled();
    gate.resolve();
    expect((await response).status).toBe(200);
    expect(emitted).toHaveBeenCalledWith("fleet_resumed", {});
  } finally {
    await server.close();
  }
});

it("POST /api/fleet/resume restarts an emergency-aborted queue", async () => {
  const start = jest.fn().mockResolvedValue(undefined);
  const resume = jest.fn();
  const queue = { start, resume, abort: jest.fn() } as unknown as DispatchQueue;
  const fleetResume = jest.fn();
  const fleetController = {
    getState: jest.fn().mockReturnValueOnce("emergency_stopped").mockReturnValue("running"),
    resume: fleetResume,
    emergencyStop: jest.fn().mockResolvedValue({}),
  } as unknown as FleetController;
  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, {
    resolveProject: () => ({
      dispatchQueue: queue,
      fleetController,
      costVelocityTracker: {} as CostVelocityTracker,
      progressDetector: {} as ProgressDetector,
    }),
    fleetBudget: {} as FleetBudgetChecker,
    emitFleetEvent: jest.fn(),
  });
  const server = await listen(app);
  try {
    expect((await post(server.port, "/api/fleet/resume")).status).toBe(200);
    expect(fleetResume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it("POST /api/fleet/emergency-stop aborts queue admission before awaiting agent drain", async () => {
  const gate = deferred();
  const abort = jest.fn();
  const queue = { abort } as unknown as DispatchQueue;
  const emergencyStop = jest.fn(async () => {
    await gate.promise;
    return {
      killedTasks: [],
      killedPids: [],
      prepStopped: false,
      prepKilledTasks: [],
      prepTimedOutTasks: [],
      errors: [],
    };
  });
  const fleetController = { emergencyStop } as unknown as FleetController;
  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, {
    resolveProject: () => ({
      dispatchQueue: queue,
      fleetController,
      costVelocityTracker: {} as CostVelocityTracker,
      progressDetector: {} as ProgressDetector,
    }),
    fleetBudget: {} as FleetBudgetChecker,
    emitFleetEvent: jest.fn(),
  });
  const server = await listen(app);
  try {
    const response = post(server.port, "/api/fleet/emergency-stop");
    for (let attempt = 0; attempt < 20 && emergencyStop.mock.calls.length === 0; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(abort).toHaveBeenCalledTimes(1);
    expect(emergencyStop).toHaveBeenCalledTimes(1);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
      emergencyStop.mock.invocationCallOrder[0],
    );

    gate.resolve();
    expect((await response).status).toBe(200);
  } finally {
    gate.resolve();
    await server.close();
  }
});

it("exposes tokened prep and shared-checkout survivor reconciliation", async () => {
  const prepSurvivor = {
    version: 1 as const,
    taskId: "TASK-PREP",
    pid: 123,
    startedAt: "2026-09-09T12:00:00.000Z",
    recordedAt: "2026-09-09T12:01:00.000Z",
    confirmationToken: "prep-token",
    strategy: "windows-process-tree" as const,
  };
  const getPrepShutdownSurvivors = jest.fn(() => [prepSurvivor]);
  const reconcilePrepShutdownSurvivor = jest.fn(() => true);
  const getSharedCheckoutShutdownSurvivor = jest.fn(() => ({
    taskId: "TASK-SHARED",
    sessionId: "shared-session",
    processId: 456,
    status: "stopped" as const,
    reconciliationToken: "shared-token",
  }));
  const reconcileSharedCheckoutShutdownSurvivor = jest.fn(() => true);
  const worktreeSurvivor = {
    version: 1 as const,
    taskId: "TASK-WORKTREE",
    sessionId: "worktree-session",
    worktreePath: "C:\\repo\\.quack\\worktrees\\TASK-WORKTREE",
    processId: 789,
    strategy: "windows-process-tree" as const,
    recordedAt: "2026-09-09T12:02:00.000Z",
    reconciliationToken: "worktree-token",
  };
  const getWorktreeShutdownSurvivors = jest.fn(() => [worktreeSurvivor]);
  const reconcileWorktreeShutdownSurvivor = jest.fn(() => true);
  const fleetController = {
    getPrepShutdownSurvivors,
    reconcilePrepShutdownSurvivor,
    getSharedCheckoutShutdownSurvivor,
    reconcileSharedCheckoutShutdownSurvivor,
    getWorktreeShutdownSurvivors,
    reconcileWorktreeShutdownSurvivor,
  } as unknown as FleetController;
  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, {
    resolveProject: () => ({
      fleetController,
      costVelocityTracker: {} as CostVelocityTracker,
      progressDetector: {} as ProgressDetector,
    }),
    fleetBudget: {} as FleetBudgetChecker,
    emitFleetEvent: jest.fn(),
  });
  const server = await listen(app);
  try {
    const prepList = await get(server.port, "/api/fleet/prep-shutdown-survivors");
    expect(prepList.status).toBe(200);
    expect(JSON.parse(prepList.body)).toEqual({ survivors: [prepSurvivor] });
    expect(
      (
        await post(server.port, "/api/fleet/prep-shutdown-survivors/TASK-PREP/reconcile", {
          confirmationToken: "prep-token",
          processTreeConfirmedStopped: true,
        })
      ).status,
    ).toBe(200);
    expect(reconcilePrepShutdownSurvivor).toHaveBeenCalledWith("TASK-PREP", "prep-token", true);

    const sharedList = await get(server.port, "/api/fleet/shared-checkout-shutdown-survivor");
    expect(sharedList.status).toBe(200);
    const sharedBody = JSON.parse(sharedList.body) as { survivor: unknown };
    expect(sharedBody.survivor).toMatchObject({ taskId: "TASK-SHARED" });
    expect(
      (
        await post(server.port, "/api/fleet/shared-checkout-shutdown-survivor/reconcile", {
          taskId: "TASK-SHARED",
          sessionId: "shared-session",
          reconciliationToken: "shared-token",
          processTreeConfirmedStopped: true,
        })
      ).status,
    ).toBe(200);
    expect(reconcileSharedCheckoutShutdownSurvivor).toHaveBeenCalledWith(
      "TASK-SHARED",
      "shared-session",
      "shared-token",
      true,
    );

    const worktreeList = await get(server.port, "/api/fleet/worktree-shutdown-survivors");
    expect(worktreeList.status).toBe(200);
    expect(JSON.parse(worktreeList.body)).toEqual({ survivors: [worktreeSurvivor] });
    expect(
      (
        await post(server.port, "/api/fleet/worktree-shutdown-survivors/TASK-WORKTREE/reconcile", {
          sessionId: "worktree-session",
          reconciliationToken: "worktree-token",
          processTreeConfirmedStopped: true,
        })
      ).status,
    ).toBe(200);
    expect(reconcileWorktreeShutdownSurvivor).toHaveBeenCalledWith(
      "TASK-WORKTREE",
      "worktree-session",
      "worktree-token",
      true,
    );
  } finally {
    await server.close();
  }
});

it("GET /api/queue exposes pending recovery rows and the unavailable reason", async () => {
  const reason = "Task directory unavailable for recovery scan: C:\\missing";
  const queue = {
    getStats: jest.fn(() => ({
      total: 1,
      queued: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      stopped: 0,
      recoveredPendingScan: 1,
      recoveryScanUnavailableReason: reason,
      totalCostUsd: 0,
      totalDurationMs: 0,
    })),
    getConfig: jest.fn(() => ({ maxConcurrent: 1 })),
    getItems: jest.fn(() => [
      {
        taskId: "TASK-100",
        status: "recovered_pending_scan",
        priority: 2,
        blockedBy: [],
        enqueuedAt: "2026-08-18T00:00:00.000Z",
        retryCount: 0,
      },
    ]),
    isPaused: jest.fn(() => false),
    isRunning: jest.fn(() => false),
    getPauseReason: jest.fn(() => undefined),
  } as unknown as DispatchQueue;
  const app = express();
  registerQueueRoutes(app, { resolveProject: () => ({ dispatchQueue: queue }) });
  const server = await listen(app);
  try {
    const response = await get(server.port, "/api/queue");
    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      state: "stopped",
      running: false,
      recoveryScanUnavailableReason: reason,
      stats: {
        recoveredPendingScan: 1,
        recoveryScanUnavailableReason: reason,
      },
      items: [{ taskId: "TASK-100", status: "recovered_pending_scan" }],
    });
  } finally {
    await server.close();
  }
});
