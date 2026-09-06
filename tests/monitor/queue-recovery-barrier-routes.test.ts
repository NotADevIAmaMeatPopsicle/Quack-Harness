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

function post(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": 0 },
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
  const fleetController = { resume: jest.fn() } as unknown as FleetController;
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
