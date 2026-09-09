import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  cleanupWorktreeContainers: jest.fn(),
}));

jest.mock("../../src/dispatcher/worktree-lifecycle", () => ({
  removeWorktree: jest.fn(),
  prepareWorktreeFrontendDeps: jest.fn(),
}));

import { spawn } from "node:child_process";
import { cleanupWorktreeContainers } from "../../src/dispatcher/docker-cleanup";
import { removeWorktree as lifecycleRemoveWorktreeMock } from "../../src/dispatcher/worktree-lifecycle";
import { DispatchManager } from "../../src/monitor/dispatch-manager";

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockCleanupWorktreeContainers = cleanupWorktreeContainers as jest.MockedFunction<
  typeof cleanupWorktreeContainers
>;
const mockRemoveWorktree = lifecycleRemoveWorktreeMock as jest.MockedFunction<
  typeof lifecycleRemoveWorktreeMock
>;

describe("DispatchManager docker cleanup integration", () => {
  let projectRoot: string;

  beforeEach(() => {
    jest.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-dispatch-docker-"));
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function stubWorktrees(mgr: DispatchManager): void {
    (
      mgr as unknown as {
        createWorktree(taskId: string): string;
      }
    ).createWorktree = (taskId: string) => {
      const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
      fs.mkdirSync(path.join(worktreePath, ".quack", "docker-runtime"), {
        recursive: true,
      });
      return worktreePath;
    };
  }

  function fakeContainer(taskId: string, containerId: string) {
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
    const runtimeLogDir = path.join(worktreePath, ".quack", "docker-runtime", `${taskId}-runtime`);
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    return {
      containerId,
      containerName: containerId,
      taskId,
      image: "fixture",
      workDir: "/workspace",
      logsVolume: `/workspace/.quack/docker-runtime/${taskId}-runtime`,
      worktreePath,
      runtimeLogDir,
      gitDir: `/quack-git/worktrees/${taskId}`,
      startedAt: new Date().toISOString(),
      status: "running" as const,
    };
  }

  test("removeWorktree calls docker cleanup by default", () => {
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", { method: "worktree" });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-102");
    removeWorktree.call(mgr, worktreePath);

    // Docker cleanup now routes through worktree-lifecycle's removeWorktree
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      worktreePath,
      "TASK-102",
      projectRoot,
      true, // dockerCleanup=true by default
    );
    mgr.killAll();
  });

  test("removeWorktree skips docker cleanup when isolation.dockerCleanup is false", () => {
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-102");
    removeWorktree.call(mgr, worktreePath);

    // Lifecycle removeWorktree called with dockerCleanup=false
    expect(mockRemoveWorktree).toHaveBeenCalledWith(worktreePath, "TASK-102", projectRoot, false);
    // The old cleanupWorktreeContainers should not be called directly
    expect(mockCleanupWorktreeContainers).not.toHaveBeenCalled();
    mgr.killAll();
  });

  test("failed dispatch path still runs docker cleanup when worktree is preserved", () => {
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: (taskId: string) => string }).createWorktree = () =>
      path.join(projectRoot, ".quack", "worktrees", "TASK-102");

    const startWorktree = (
      mgr as unknown as {
        startWorktree: (taskId: string) => unknown;
      }
    ).startWorktree;
    startWorktree.call(mgr, "TASK-102");

    fakeChild.emit("exit", 1);

    expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(
      path.join(projectRoot, ".quack", "worktrees", "TASK-102"),
      expect.any(Object),
    );
    mgr.killAll();
  });

  test("shutdown waits for pending container creation and removes the late container", async () => {
    let resolveContainer!: (value: ReturnType<typeof fakeContainer>) => void;
    const containerCreated = new Promise<ReturnType<typeof fakeContainer>>((resolve) => {
      resolveContainer = resolve;
    });
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest.fn(() => containerCreated),
      execAgent: jest.fn(),
      removeContainer: jest.fn().mockResolvedValue(undefined),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    const job = mgr.start("TASK-DOCKER-START", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dockerManager.createContainer).toHaveBeenCalledTimes(1);
    let shutdownResolved = false;
    const shutdown = mgr
      .shutdownAll({ gracefulTimeoutMs: 500, forceTimeoutMs: 500 })
      .then((result) => {
        shutdownResolved = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownResolved).toBe(false);

    resolveContainer(fakeContainer("TASK-DOCKER-START", "late-container"));
    const result = await shutdown;

    expect(dockerManager.execAgent).not.toHaveBeenCalled();
    expect(dockerManager.forceRemoveContainer).toHaveBeenCalledWith("late-container");
    expect(dockerManager.cleanupAll).toHaveBeenCalled();
    expect(result.requested).toEqual(["TASK-DOCKER-START"]);
    expect(result.timedOut).toEqual([]);
    expect(job.status).toBe("stopped");
  });

  test("restart reconciliation blocks new container admission when prior ownership is unresolved", async () => {
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: ["TASK-OLD"],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: ["TASK-OLD"],
      }),
      createContainer: jest.fn(),
      execAgent: jest.fn(),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    const job = mgr.start("TASK-NEW", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.reconcileExistingContainers).toHaveBeenCalledTimes(1);
    expect(dockerManager.createContainer).not.toHaveBeenCalled();
    expect(job.status).toBe("failed");
    expect(job.output.join("\n")).toContain(
      "Docker ownership reconciliation could not remove prior containers for: TASK-OLD",
    );
  });

  test("re-runs ownership reconciliation after a successful scan", async () => {
    const dockerManager = {
      reconcileExistingContainers: jest
        .fn()
        .mockResolvedValueOnce({
          discoveredTaskIds: [],
          ambiguousContainerIds: [],
          removedTaskIds: [],
          failedTaskIds: [],
        })
        .mockResolvedValueOnce({
          discoveredTaskIds: ["TASK-LATE"],
          ambiguousContainerIds: [],
          removedTaskIds: [],
          failedTaskIds: ["TASK-LATE"],
        }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
    const reconcile = (
      mgr as unknown as { ensureDockerOwnershipReconciled(): Promise<void> }
    ).ensureDockerOwnershipReconciled.bind(mgr);

    await expect(reconcile()).resolves.toBeUndefined();
    await expect(reconcile()).rejects.toThrow(
      "Docker ownership reconciliation could not remove prior containers for: TASK-LATE",
    );
    expect(dockerManager.reconcileExistingContainers).toHaveBeenCalledTimes(2);
  });

  test("serializes concurrent Docker reconciliation and container admission", async () => {
    let releaseFirstCreate!: () => void;
    const firstCreate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const children = [new FakeChild(), new FakeChild()];
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest.fn(async (taskId: string) => {
        if (taskId === "TASK-FIRST") await firstCreate;
        return fakeContainer(taskId, `${taskId}-container`);
      }),
      execAgent: jest.fn().mockReturnValueOnce(children[0]).mockReturnValueOnce(children[1]),
      extractResults: jest.fn().mockResolvedValue({ diff: "", log: "", branch: "" }),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    mgr.start("TASK-FIRST", { skipGate: true });
    mgr.start("TASK-SECOND", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.reconcileExistingContainers).toHaveBeenCalledTimes(1);
    expect(dockerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(dockerManager.createContainer).toHaveBeenCalledWith(
      "TASK-FIRST",
      path.join(projectRoot, ".quack", "worktrees", "TASK-FIRST"),
    );

    releaseFirstCreate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.reconcileExistingContainers).toHaveBeenCalledTimes(2);
    expect(dockerManager.createContainer.mock.calls.map(([taskId]) => taskId)).toEqual([
      "TASK-FIRST",
      "TASK-SECOND",
    ]);

    children[0].emit("exit", 0, null);
    children[1].emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("stop cancels pending container creation before an agent can spawn", async () => {
    let resolveContainer!: (value: ReturnType<typeof fakeContainer>) => void;
    const containerCreated = new Promise<ReturnType<typeof fakeContainer>>((resolve) => {
      resolveContainer = resolve;
    });
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest.fn(() => containerCreated),
      execAgent: jest.fn(),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    const job = mgr.start("TASK-DOCKER-STOP", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dockerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(job.pid).toBe(0);
    expect(mgr.stop("TASK-DOCKER-STOP")).toBe(true);

    resolveContainer(fakeContainer("TASK-DOCKER-STOP", "stopped-before-exec"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.execAgent).not.toHaveBeenCalled();
    expect(dockerManager.forceRemoveContainer).toHaveBeenCalledWith("stopped-before-exec");
    expect(job.status).toBe("stopped");
  });

  test("shutdown reports Docker cleanup failures instead of claiming exit", async () => {
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      getActiveContainers: jest.fn().mockReturnValue([
        {
          containerId: "survivor",
          taskId: "TASK-DOCKER-SURVIVOR",
          image: "fixture",
          workDir: "/workspace",
          logsVolume: "/workspace/.quack/logs",
          startedAt: new Date().toISOString(),
          status: "running" as const,
        },
      ]),
      getTrackedContainers: jest.fn().mockReturnValue([
        {
          containerId: "survivor",
          taskId: "TASK-DOCKER-SURVIVOR",
          image: "fixture",
          workDir: "/workspace",
          logsVolume: "/workspace/.quack/logs",
          startedAt: new Date().toISOString(),
          status: "running" as const,
        },
      ]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({
        removedTaskIds: [],
        failedTaskIds: ["TASK-DOCKER-SURVIVOR"],
      }),
    };
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
      method: "docker",
      docker: {
        image: "node:20-slim",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 2048, cpus: 1 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
    });
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    const result = await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 25 });

    expect(result.requested).toContain("TASK-DOCKER-SURVIVOR");
    expect(result.exited).not.toContain("TASK-DOCKER-SURVIVOR");
    expect(result.timedOut).toContain("TASK-DOCKER-SURVIVOR");
  });

  test("removes a created container when startup fails before docker exec", async () => {
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(fakeContainer("TASK-DOCKER-STARTUP-FAIL", "created-before-key-failure")),
        ),
      execAgent: jest.fn(),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const noKeys = {
      getNextKey: jest.fn().mockReturnValue(undefined),
    };
    const mgr = new DispatchManager(
      projectRoot,
      "/fake/bin.js",
      {
        method: "docker",
        docker: {
          image: "node:20-slim",
          volumes: [],
          envPassthrough: [],
          resourceLimits: { memoryMb: 2048, cpus: 1 },
          networkMode: "bridge",
          cleanupPolicy: "remove",
        },
      },
      noKeys as never,
    );
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    const job = mgr.start("TASK-DOCKER-STARTUP-FAIL", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.execAgent).not.toHaveBeenCalled();
    expect(dockerManager.forceRemoveContainer).toHaveBeenCalledWith("created-before-key-failure");
    expect(job.status).toBe("failed");
  });

  test("force-removes a rate-limited container before same-task retry", async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.resolve(fakeContainer("TASK-DOCKER-RETRY", "rate-limited-container")),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(fakeContainer("TASK-DOCKER-RETRY", "retry-container")),
        ),
      execAgent: jest.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      extractResults: jest.fn().mockResolvedValue({ diff: "", log: "", branch: "" }),
      forceRemoveContainer: jest.fn().mockResolvedValue(true),
      getActiveContainers: jest.fn().mockReturnValue([]),
      getTrackedContainers: jest.fn().mockReturnValue([]),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn().mockResolvedValue({ removedTaskIds: [], failedTaskIds: [] }),
    };
    const keyManager = {
      getNextKey: jest
        .fn()
        .mockReturnValueOnce({ id: "key-1" })
        .mockReturnValueOnce({ id: "key-2" }),
      getKeyValue: jest.fn((id: string) => id),
      markRateLimited: jest.fn(),
      getCooldownMs: jest.fn().mockReturnValue(60_000),
      hasAvailableKeys: jest.fn().mockReturnValue(true),
    };
    const mgr = new DispatchManager(
      projectRoot,
      "/fake/bin.js",
      {
        method: "docker",
        docker: {
          image: "node:20-slim",
          volumes: [],
          envPassthrough: [],
          resourceLimits: { memoryMb: 2048, cpus: 1 },
          networkMode: "bridge",
          cleanupPolicy: "keep_on_failure",
        },
      },
      keyManager as never,
      undefined,
      (taskId) => Promise.resolve({ taskId, claimants: [] }),
    );
    stubWorktrees(mgr);
    (mgr as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

    mgr.start("TASK-DOCKER-RETRY", { skipGate: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstChild.stderr.emit("data", Buffer.from("429 rate limit exceeded\n"));
    firstChild.emit("exit", 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dockerManager.forceRemoveContainer).toHaveBeenCalledWith("rate-limited-container");
    expect(dockerManager.createContainer).toHaveBeenCalledTimes(2);
    expect(dockerManager.stopContainer).not.toHaveBeenCalledWith("rate-limited-container", true);
    secondChild.emit("exit", 0, null);
  });
});
