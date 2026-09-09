import { EventEmitter } from "node:events";

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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("removeWorktree calls docker cleanup by default", () => {
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", { method: "worktree" });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    removeWorktree.call(mgr, "/fake/project/.quack/worktrees/TASK-102");

    // Docker cleanup now routes through worktree-lifecycle's removeWorktree
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      "TASK-102",
      "/fake/project",
      true, // dockerCleanup=true by default
    );
    mgr.killAll();
  });

  test("removeWorktree skips docker cleanup when isolation.dockerCleanup is false", () => {
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    removeWorktree.call(mgr, "/fake/project/.quack/worktrees/TASK-102");

    // Lifecycle removeWorktree called with dockerCleanup=false
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      "TASK-102",
      "/fake/project",
      false,
    );
    // The old cleanupWorktreeContainers should not be called directly
    expect(mockCleanupWorktreeContainers).not.toHaveBeenCalled();
    mgr.killAll();
  });

  test("failed dispatch path still runs docker cleanup when worktree is preserved", () => {
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: (taskId: string) => string }).createWorktree = () =>
      "/fake/project/.quack/worktrees/TASK-102";

    const startWorktree = (
      mgr as unknown as {
        startWorktree: (taskId: string) => unknown;
      }
    ).startWorktree;
    startWorktree.call(mgr, "TASK-102");

    fakeChild.emit("exit", 1);

    expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      expect.any(Object),
    );
    mgr.killAll();
  });

  test("shutdown waits for pending container creation and removes the late container", async () => {
    let resolveContainer!: (value: {
      containerId: string;
      taskId: string;
      image: string;
      workDir: string;
      logsVolume: string;
      startedAt: string;
      status: "running";
    }) => void;
    const containerCreated = new Promise<{
      containerId: string;
      taskId: string;
      image: string;
      workDir: string;
      logsVolume: string;
      startedAt: string;
      status: "running";
    }>((resolve) => {
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
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
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

    const job = mgr.start("TASK-DOCKER-START", { skipGate: true });
    let shutdownResolved = false;
    const shutdown = mgr
      .shutdownAll({ gracefulTimeoutMs: 500, forceTimeoutMs: 500 })
      .then((result) => {
        shutdownResolved = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownResolved).toBe(false);

    resolveContainer({
      containerId: "late-container",
      taskId: "TASK-DOCKER-START",
      image: "fixture",
      workDir: "/workspace",
      logsVolume: "/workspace/.quack/logs",
      startedAt: new Date().toISOString(),
      status: "running",
    });
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
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
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
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
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

  test("stop cancels pending container creation before an agent can spawn", async () => {
    let resolveContainer!: (value: {
      containerId: string;
      taskId: string;
      image: string;
      workDir: string;
      logsVolume: string;
      startedAt: string;
      status: "running";
    }) => void;
    const containerCreated = new Promise<{
      containerId: string;
      taskId: string;
      image: string;
      workDir: string;
      logsVolume: string;
      startedAt: string;
      status: "running";
    }>((resolve) => {
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
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
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

    const job = mgr.start("TASK-DOCKER-STOP", { skipGate: true });
    expect(job.pid).toBe(0);
    expect(mgr.stop("TASK-DOCKER-STOP")).toBe(true);

    resolveContainer({
      containerId: "stopped-before-exec",
      taskId: "TASK-DOCKER-STOP",
      image: "fixture",
      workDir: "/workspace",
      logsVolume: "/workspace/.quack/logs",
      startedAt: new Date().toISOString(),
      status: "running",
    });
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
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
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
      createContainer: jest.fn().mockResolvedValue({
        containerId: "created-before-key-failure",
        taskId: "TASK-DOCKER-STARTUP-FAIL",
        image: "fixture",
        workDir: "/workspace",
        logsVolume: "/workspace/.quack/logs",
        startedAt: new Date().toISOString(),
        status: "running" as const,
      }),
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
      "/fake/project",
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
        .mockResolvedValueOnce({
          containerId: "rate-limited-container",
          taskId: "TASK-DOCKER-RETRY",
          image: "fixture",
          workDir: "/workspace",
          logsVolume: "/workspace/.quack/logs",
          startedAt: new Date().toISOString(),
          status: "running" as const,
        })
        .mockResolvedValueOnce({
          containerId: "retry-container",
          taskId: "TASK-DOCKER-RETRY",
          image: "fixture",
          workDir: "/workspace",
          logsVolume: "/workspace/.quack/logs",
          startedAt: new Date().toISOString(),
          status: "running" as const,
        }),
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
      "/fake/project",
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
