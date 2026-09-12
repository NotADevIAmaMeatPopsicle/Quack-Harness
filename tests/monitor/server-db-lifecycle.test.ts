import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { AuthService } from "../../src/monitor/auth";
import { EventReader } from "../../src/monitor/event-reader";
import { __testing__ as coordinationTesting } from "../../src/monitor/routes/coordination";
import { createMonitorServer } from "../../src/monitor/server";
import { SSEManager } from "../../src/monitor/sse-manager";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-db-lifecycle-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

async function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an IP socket address for the test server");
  }
  return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function reserveEphemeralPort(): Promise<number> {
  const reservation = await listenOnEphemeralPort();
  const { port } = reservation;
  await closeServer(reservation.server);
  return port;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe("monitor database lifecycle", () => {
  it("waits for in-flight event callbacks before closing a watcher", async () => {
    const logDir = makeTempDir();
    const reader = new EventReader(logDir);
    let releaseCallback: (() => void) | undefined;
    let callbackStarted = false;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const stopWatcher = await reader.watch(async () => {
      callbackStarted = true;
      await callbackGate;
    });

    let stopPromise: Promise<void> | undefined;
    try {
      // Give chokidar time to finish its initial scan, then append to an
      // already-known file so ignoreInitial cannot swallow the test event.
      const eventFile = path.join(logDir, "events-in-flight.jsonl");
      fs.writeFileSync(eventFile, "", "utf-8");
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      fs.appendFileSync(
        eventFile,
        `${JSON.stringify({
          sessionId: "in-flight",
          taskId: "TASK-001",
          project: "test",
          timestamp: new Date().toISOString(),
          stage: "session_start",
          payload: {},
        })}\n`,
        "utf-8",
      );
      await waitForCondition(() => callbackStarted);

      let stopSettled = false;
      stopPromise = stopWatcher().then(() => {
        stopSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(stopSettled).toBe(false);

      releaseCallback!();
      await stopPromise;
      expect(stopSettled).toBe(true);
    } finally {
      releaseCallback?.();
      await stopPromise?.catch(() => undefined);
      if (!stopPromise) await stopWatcher().catch(() => undefined);
      removeTempDir(logDir);
    }
  }, 15_000);

  it("releases quack.db handles when the monitor stops", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
      taskDir,
    });
    const { port, stop } = await serverObj.start();

    expect(port).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(projectRoot, ".quack", "quack.db"))).toBe(true);

    await stop();

    expect(() => removeTempDir(projectRoot)).not.toThrow();
  });

  it("rejects bind failures after releasing monitor resources", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    let blocker: net.Server | undefined;
    let retryStop: (() => Promise<void>) | undefined;

    try {
      const occupied = await listenOnEphemeralPort();
      blocker = occupied.server;
      const baselineExceptionHandlers = process.listenerCount("uncaughtException");
      const baselineRejectionHandlers = process.listenerCount("unhandledRejection");

      const failedServer = createMonitorServer({
        logDir,
        port: occupied.port,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });

      await expect(failedServer.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(process.listenerCount("uncaughtException")).toBe(baselineExceptionHandlers);
      expect(process.listenerCount("unhandledRejection")).toBe(baselineRejectionHandlers);

      await closeServer(blocker);
      blocker = undefined;

      const retryServer = createMonitorServer({
        logDir,
        port: occupied.port,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      const retried = await retryServer.start();
      retryStop = retried.stop;
      expect(retried.port).toBe(occupied.port);

      await retryStop();
      retryStop = undefined;
      expect(() => removeTempDir(projectRoot)).not.toThrow();
    } finally {
      if (retryStop) await retryStop();
      if (blocker) await closeServer(blocker);
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  }, 30_000);

  it("does not reconcile an incumbent monitor's active sessions before detecting EADDRINUSE", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    let primaryStop: (() => Promise<void>) | undefined;
    try {
      const primary = createMonitorServer({
        logDir,
        port: 0,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      const started = await primary.start();
      primaryStop = started.stop;

      const sessionsFile = path.join(logDir, "sessions.jsonl");
      fs.writeFileSync(
        sessionsFile,
        `${JSON.stringify({
          sessionId: "incumbent-live-session",
          taskId: "TASK-001",
          project: "test",
          startTime: new Date().toISOString(),
          status: "active",
        })}\n`,
        "utf-8",
      );

      const duplicate = createMonitorServer({
        logDir,
        port: started.port,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      await expect(duplicate.start()).rejects.toMatchObject({ code: "EADDRINUSE" });

      const rows = fs
        .readFileSync(sessionsFile, "utf-8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { status: string; outcome?: string });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "active" });
      expect(rows[0].outcome).toBeUndefined();
    } finally {
      if (primaryStop) await primaryStop();
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  }, 30_000);

  it("tears down a bound server when initialization fails", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const port = await reserveEphemeralPort();
    const baselineListeners = {
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const watchSpy = jest
      .spyOn(EventReader.prototype, "watch")
      .mockRejectedValueOnce(new Error("synthetic initialization failure"));

    let rebound: net.Server | undefined;
    try {
      const monitor = createMonitorServer({
        logDir,
        port,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });

      await expect(monitor.start()).rejects.toThrow("synthetic initialization failure");
      expect(process.listenerCount("uncaughtException")).toBe(baselineListeners.uncaughtException);
      expect(process.listenerCount("unhandledRejection")).toBe(
        baselineListeners.unhandledRejection,
      );
      expect(process.listenerCount("SIGINT")).toBe(baselineListeners.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(baselineListeners.SIGTERM);

      rebound = net.createServer();
      await new Promise<void>((resolve, reject) => {
        rebound!.once("error", reject);
        rebound!.listen(port, "127.0.0.1", resolve);
      });
      expect(() => removeTempDir(projectRoot)).not.toThrow();
    } finally {
      watchSpy.mockRestore();
      if (rebound?.listening) await closeServer(rebound);
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  }, 30_000);

  it("retries a transient watcher cleanup failure during failed startup", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const port = await reserveEphemeralPort();
    let watcherStopAttempts = 0;
    const watchSpy = jest.spyOn(EventReader.prototype, "watch").mockImplementation(() =>
      Promise.resolve(() => {
        watcherStopAttempts += 1;
        if (watcherStopAttempts === 1) {
          return Promise.reject(new Error("synthetic transient watcher close failure"));
        }
        return Promise.resolve();
      }),
    );
    const heartbeatSpy = jest
      .spyOn(SSEManager.prototype, "startHeartbeat")
      .mockImplementationOnce(() => {
        throw new Error("synthetic post-watch initialization failure");
      });

    let rebound: net.Server | undefined;
    try {
      const monitor = createMonitorServer({
        logDir,
        port,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });

      await expect(monitor.start()).rejects.toThrow("synthetic post-watch initialization failure");
      expect(watcherStopAttempts).toBe(2);

      rebound = net.createServer();
      await new Promise<void>((resolve, reject) => {
        rebound!.once("error", reject);
        rebound!.listen(port, "127.0.0.1", resolve);
      });
      expect(() => removeTempDir(projectRoot)).not.toThrow();
    } finally {
      heartbeatSpy.mockRestore();
      watchSpy.mockRestore();
      if (rebound?.listening) await closeServer(rebound);
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  }, 30_000);

  it("waits for full teardown before a signal requests process exit", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const priorSigtermListeners = new Set(process.listeners("SIGTERM"));
    let releaseWatcher: (() => void) | undefined;
    const watcherGate = new Promise<void>((resolve) => {
      releaseWatcher = resolve;
    });
    const watchSpy = jest
      .spyOn(EventReader.prototype, "watch")
      .mockResolvedValue(() => watcherGate);
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    let stop: (() => Promise<void>) | undefined;
    try {
      const monitor = createMonitorServer({
        logDir,
        port: 0,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      const started = await monitor.start();
      stop = started.stop;
      const signalListener = process
        .listeners("SIGTERM")
        .find((listener) => !priorSigtermListeners.has(listener));
      expect(signalListener).toBeDefined();

      signalListener!("SIGTERM");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(exitSpy).not.toHaveBeenCalled();

      releaseWatcher!();
      await waitForCondition(() => exitSpy.mock.calls.length > 0);
      expect(exitSpy).toHaveBeenCalledWith(0);
      await stop();
      stop = undefined;
      expect(() => removeTempDir(projectRoot)).not.toThrow();
    } finally {
      releaseWatcher?.();
      if (stop) await stop();
      watchSpy.mockRestore();
      exitSpy.mockRestore();
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  }, 30_000);

  it("disposes coordination subscribers and the dispatch watchdog on stop", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const coordinationCloseSpy = jest.spyOn(
      coordinationTesting.CoordinationSubscriberPool.prototype,
      "closeAll",
    );
    const watchdogStopSpy = jest.spyOn(DispatchManager.prototype, "stopWatchdog");

    try {
      const monitor = createMonitorServer({
        logDir,
        port: 0,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      const started = await monitor.start();
      await started.stop();

      expect(coordinationCloseSpy).toHaveBeenCalledTimes(1);
      expect(watchdogStopSpy).toHaveBeenCalledTimes(1);
    } finally {
      coordinationCloseSpy.mockRestore();
      watchdogStopSpy.mockRestore();
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  });

  it("ends active coordination SSE responses before closing the HTTP server", async () => {
    const projectRoot = makeTempDir();
    const logDir = path.join(projectRoot, ".quack", "logs");
    const taskDir = "docs/tasks";
    fs.mkdirSync(path.join(projectRoot, taskDir), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const authSpy = jest
      .spyOn(AuthService.prototype, "validateServiceToken")
      .mockReturnValue({ ok: true, tokenId: "coord-operator" });

    let request: http.ClientRequest | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      const monitor = createMonitorServer({
        logDir,
        port: 0,
        host: "127.0.0.1",
        projectRoot,
        taskDir,
      });
      const started = await monitor.start();
      stop = started.stop;

      let response: http.IncomingMessage | undefined;
      await new Promise<void>((resolve, reject) => {
        request = http.get(
          {
            host: "127.0.0.1",
            port: started.port,
            path: "/v1/coordination/stream?for=operator",
            headers: { "x-quack-service-token": "test-token" },
          },
          (incoming) => {
            response = incoming;
            incoming.setEncoding("utf-8");
            incoming.on("data", (chunk: string) => {
              if (chunk.includes("event: connected")) resolve();
            });
            incoming.once("error", reject);
          },
        );
        request.once("error", reject);
      });

      const responseClosed = new Promise<void>((resolve) => {
        response!.once("end", resolve);
        response!.once("close", resolve);
      });
      await stop();
      stop = undefined;
      await responseClosed;
      expect(response!.complete).toBe(true);
    } finally {
      request?.destroy();
      if (stop) await stop();
      authSpy.mockRestore();
      if (fs.existsSync(projectRoot)) removeTempDir(projectRoot);
    }
  });
});
