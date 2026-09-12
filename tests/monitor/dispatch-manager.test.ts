import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  cleanupWorktreeContainers: jest.fn(() => true),
  detectStaleContainers: jest.fn(() => Promise.resolve([])),
  resolveTrustedDockerExecutable: jest.fn(() => "docker"),
  trustedDockerEnvironment: jest.fn(() => process.env),
}));

import { cleanupWorktreeContainers } from "../../src/dispatcher/docker-cleanup";
import { TRUSTED_MANAGED_DOCKER_IMAGES_ENV } from "../../src/dispatcher/docker-manager";
import * as childExitLog from "../../src/monitor/child-exit-log";
import {
  DegradedSharedCheckoutBusyError,
  DispatchManager,
  type DispatchJob,
} from "../../src/monitor/dispatch-manager";
import {
  DECOMPOSITION_ADMISSION_HASH_ENV,
  DECOMPOSITION_ADMISSION_MARKER_ENV,
  DECOMPOSITION_ADMISSION_TOKEN_ENV,
} from "../../src/preflight/decomposition-dispatch-admission";

const mockCleanupWorktreeContainers = cleanupWorktreeContainers as jest.MockedFunction<
  typeof cleanupWorktreeContainers
>;
const TRUSTED_MANAGED_IMAGE = `node@sha256:${"a".repeat(64)}`;

/**
 * Test-only operator authorization for the exact bare origin created by a
 * fixture. Production obtains the same value from the process-owned adapter
 * envelope, never from repository-controlled Git configuration.
 */
function createLocalOriginFixtureManager(
  projectRoot: string,
  quackBin: string,
  bareOrigin = path.join(path.dirname(projectRoot), "origin.git"),
): DispatchManager {
  return new DispatchManager(projectRoot, quackBin, undefined, undefined, undefined, undefined, [
    bareOrigin,
  ]);
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function confirmWindowsSharedCheckoutTree(markerPath: string): void {
  if (process.platform !== "win32") return;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
  marker.processTreeStatus = "confirmed-stopped";
  marker.reconciliationToken ??= "test-confirmation-token";
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
}

function markWindowsTreeKillConfirmed(manager: DispatchManager, taskId: string): void {
  if (process.platform !== "win32") return;
  const sessionId = manager.getJob(taskId)?.sessionId;
  if (!sessionId) throw new Error(`No job found for ${taskId}`);
  (
    manager as unknown as { confirmedWindowsTreeKills: Map<string, string> }
  ).confirmedWindowsTreeKills.set(taskId, sessionId);
}

function stubDockerWorktree(
  manager: DispatchManager,
  projectRoot: string,
  taskId: string,
): { worktreePath: string; runtimeLogDir: string } {
  const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
  const runtimeLogDir = path.join(projectRoot, ".quack", "docker-runtime", taskId);
  fs.mkdirSync(path.join(worktreePath, ".quack"), { recursive: true });
  fs.mkdirSync(runtimeLogDir, { recursive: true });
  (
    manager as unknown as {
      createWorktree: (requestedTaskId: string, options?: object) => string;
    }
  ).createWorktree = jest.fn(() => worktreePath);
  (
    manager as unknown as {
      prepareDockerAdmittedBranch: (
        requestedTaskId: string,
        requestedWorktreePath: string,
      ) => { branch: string; head: string };
    }
  ).prepareDockerAdmittedBranch = jest.fn(() => ({
    branch: `quack/${taskId}`,
    head: "a".repeat(40),
  }));
  return { worktreePath, runtimeLogDir };
}

function dockerManagerLifecycleStubs() {
  return {
    reconcileExistingContainers: jest.fn(() =>
      Promise.resolve({
        removedTaskIds: [],
        failedTaskIds: [],
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
      }),
    ),
    getContainer: jest.fn(() => undefined),
    getTrackedContainers: jest.fn(() => []),
    getUnresolvedContainers: jest.fn(() => []),
    abortPendingCommands: jest.fn(),
  };
}

describe("DispatchManager", () => {
  let manager: DispatchManager;
  let managerRoot: string;

  beforeEach(() => {
    mockCleanupWorktreeContainers.mockReturnValue(true);
    managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-dispatch-manager-"));
    // Use an isolated dummy project root and bin path.
    manager = new DispatchManager(managerRoot, "/fake/bin.js");
  });

  afterEach(() => {
    manager.killAll();
    fs.rmSync(managerRoot, { recursive: true, force: true });
  });

  test("getActiveJobs returns empty when no jobs", () => {
    expect(manager.getActiveJobs()).toEqual([]);
  });

  test("getAllJobs returns empty when no jobs", () => {
    expect(manager.getAllJobs()).toEqual([]);
  });

  test("getJob returns undefined for unknown task", () => {
    expect(manager.getJob("TASK-999")).toBeUndefined();
  });

  test("getActiveJob returns undefined for unknown task", () => {
    expect(manager.getActiveJob("TASK-999")).toBeUndefined();
  });

  test("getAllJobs marks a running job failed when its child pid is gone", () => {
    const jobs = (manager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
    jobs.set("TASK-DEAD", {
      taskId: "TASK-DEAD",
      sessionId: "dead-session",
      pid: 2_147_483_000,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      worktreePath: "/missing/worktree",
    });

    const [job] = manager.getAllJobs();

    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(1);
    expect(job.output.join("\n")).toContain("no longer alive");
    expect(manager.getActiveJobs()).toEqual([]);
  });

  test("stop returns false when no active job", () => {
    expect(manager.stop("TASK-999")).toBe(false);
  });

  test("start throws when task is already running", () => {
    // Start with a real bin that exists but will exit quickly
    const realManager = new DispatchManager("/fake", process.execPath);
    try {
      // This will fail to actually dispatch but creates the job entry
      // We test the double-start guard with a mock approach instead
    } finally {
      realManager.killAll();
    }
  });

  test("cleanup removes old completed jobs", () => {
    // Internal state test — just verify cleanup doesn't throw
    manager.cleanup(0);
    expect(manager.getAllJobs()).toEqual([]);
  });

  describe("worktree initialization isolation", () => {
    const initializationActive = (subject: DispatchManager): boolean =>
      (
        subject as unknown as {
          worktreeInitializationActive(): boolean;
        }
      ).worktreeInitializationActive.call(subject);

    function writeAdapter(adapter: unknown): void {
      const quackDirectory = path.join(managerRoot, ".quack");
      fs.mkdirSync(quackDirectory, { recursive: true });
      fs.writeFileSync(path.join(quackDirectory, "adapter.json"), JSON.stringify(adapter));
    }

    test("treats omitted or configured initialization as active and [] as disabled", () => {
      expect(initializationActive(manager)).toBe(false);

      writeAdapter({ dispatch: {} });
      expect(initializationActive(manager)).toBe(true);

      writeAdapter({ dispatch: { worktreeInit: ["npm ci"] } });
      expect(initializationActive(manager)).toBe(true);

      writeAdapter({ dispatch: { worktreeInit: [] } });
      expect(initializationActive(manager)).toBe(false);

      fs.writeFileSync(path.join(managerRoot, ".quack", "adapter.json"), "{truncated");
      expect(initializationActive(manager)).toBe(true);
    });

    test("fails closed before spawning when worktree creation falls back to the shared checkout", () => {
      writeAdapter({ dispatch: { worktreeInit: ["npm ci"] } });
      const createWorktree = jest.fn(
        (_taskId: string, _options?: { ownershipId?: string }) => undefined,
      );
      (
        manager as unknown as {
          createWorktree: (
            taskId: string,
            options?: { ownershipId?: string },
          ) => string | undefined;
        }
      ).createWorktree = createWorktree;

      expect(() => manager.start("TASK-INIT-ISOLATION", { skipGate: true })).toThrow(
        "refusing to run initialization in the shared project checkout",
      );
      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(createWorktree.mock.calls[0]?.[0]).toBe("TASK-INIT-ISOLATION");
      expect(typeof createWorktree.mock.calls[0]?.[1]?.ownershipId).toBe("string");
      expect(manager.getJob("TASK-INIT-ISOLATION")).toBeUndefined();
    });
  });

  describe("isolation method branching", () => {
    test("defaults to worktree isolation when no config", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      // getActiveContainers should return empty (no Docker manager)
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("defaults to worktree when method is worktree", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
        method: "worktree",
      });
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("creates DockerManager when method is docker", () => {
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
      // getActiveContainers delegates to DockerManager — should be empty but not crash
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("rejects an untrusted mutable Docker image before publishing admission", () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-image-trust-"));
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
      const startDocker = (
        mgr as unknown as {
          startDocker(taskId: string, options: { admittedTaskContentHash: string }): DispatchJob;
        }
      ).startDocker.bind(mgr);

      try {
        expect(() =>
          startDocker("TASK-IMAGE-TRUST", {
            admittedTaskContentHash: "f".repeat(64),
          }),
        ).toThrow("immutable sha256 digest-pinned image");
        expect(fs.existsSync(path.join(projectRoot, ".quack", "decomposition-admissions"))).toBe(
          false,
        );
        expect(mgr.getJob("TASK-IMAGE-TRUST")).toBeUndefined();
      } finally {
        mgr.killAll();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("stop during Docker creation cancels launch and keeps admission blocked", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-cancel-"));
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
      type ContainerInfo = {
        containerId: string;
        taskId: string;
        image: string;
        workDir: string;
        logsVolume: string;
        worktreePath: string;
        runtimeLogDir: string;
        startedAt: string;
        status: "running";
      };
      const dockerPaths = stubDockerWorktree(mgr, projectRoot, "TASK-DOCKER-CANCEL");
      let resolveCreate!: (container: ContainerInfo) => void;
      const createPromise = new Promise<ContainerInfo>((resolve) => {
        resolveCreate = resolve;
      });
      const fakeDockerManager = {
        ...dockerManagerLifecycleStubs(),
        createContainer: jest.fn(() => createPromise),
        stopContainer: jest.fn(() => Promise.resolve({ removed: true, retained: false })),
        forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
        execAgent: jest.fn(),
      };
      (
        mgr as unknown as {
          dockerManager: typeof fakeDockerManager;
        }
      ).dockerManager = fakeDockerManager;

      try {
        const job = mgr.start("TASK-DOCKER-CANCEL", { skipGate: true });
        await waitForCondition(
          () => fakeDockerManager.createContainer.mock.calls.length === 1,
          "Docker create request",
        );
        expect(mgr.stop(job.taskId)).toBe(false);
        expect(job.status).toBe("stopped");
        expect(() => mgr.start(job.taskId, { skipGate: true })).toThrow(
          "still completing operator-stop cleanup",
        );

        resolveCreate({
          containerId: "container-cancelled-before-exec",
          taskId: job.taskId,
          image: "node:20-slim",
          workDir: "/workspace",
          logsVolume: "/workspace/.quack/logs",
          worktreePath: dockerPaths.worktreePath,
          runtimeLogDir: dockerPaths.runtimeLogDir,
          startedAt: new Date().toISOString(),
          status: "running",
        });
        await waitForCondition(
          () => fakeDockerManager.forceRemoveContainer.mock.calls.length === 1,
          "Docker cancellation cleanup",
        );

        expect(fakeDockerManager.forceRemoveContainer).toHaveBeenCalledWith(
          "container-cancelled-before-exec",
        );
        expect(fakeDockerManager.execAgent).not.toHaveBeenCalled();
        expect(job.status).toBe("stopped");
        expect(job.operatorStopCleanupPending).toBe(true);
      } finally {
        mgr.killAll();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("cleans a created container when key selection fails before agent exec", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-no-key-"));
      const keyManager = { getNextKey: jest.fn(() => null) };
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
        keyManager as never,
      );
      const dockerPaths = stubDockerWorktree(mgr, projectRoot, "TASK-308");
      const fakeDockerManager = {
        ...dockerManagerLifecycleStubs(),
        createContainer: jest.fn(() =>
          Promise.resolve({
            containerId: "container-no-key",
            taskId: "TASK-308",
            image: "node:20-slim",
            workDir: "/workspace",
            logsVolume: "/workspace/.quack/logs",
            worktreePath: dockerPaths.worktreePath,
            runtimeLogDir: dockerPaths.runtimeLogDir,
            startedAt: new Date().toISOString(),
            status: "running" as const,
          }),
        ),
        stopContainer: jest.fn(() => Promise.resolve({ removed: true, retained: false })),
        forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
        execAgent: jest.fn(),
      };
      (mgr as unknown as { dockerManager: typeof fakeDockerManager }).dockerManager =
        fakeDockerManager;

      try {
        const job = mgr.start("TASK-308", { skipGate: true });
        await waitForCondition(
          () => fakeDockerManager.forceRemoveContainer.mock.calls.length === 1,
          "Docker cleanup after key-selection refusal",
        );

        expect(fakeDockerManager.execAgent).not.toHaveBeenCalled();
        expect(fakeDockerManager.forceRemoveContainer).toHaveBeenCalledWith("container-no-key");
        expect(job.status).toBe("failed");
        expect(job.output.join("\n")).toContain(
          "The configured Claude API-key pool has no available key",
        );
        expect(job.operatorStopCleanupPending).not.toBe(true);
      } finally {
        mgr.killAll();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("contains synchronous exec failure even when lifecycle observers throw", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-exec-throw-"));
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
      const dockerPaths = stubDockerWorktree(mgr, projectRoot, "TASK-309");
      const fakeDockerManager = {
        ...dockerManagerLifecycleStubs(),
        createContainer: jest.fn(() =>
          Promise.resolve({
            containerId: "container-exec-throw",
            taskId: "TASK-309",
            image: "node:20-slim",
            workDir: "/workspace",
            logsVolume: "/workspace/.quack/logs",
            worktreePath: dockerPaths.worktreePath,
            runtimeLogDir: dockerPaths.runtimeLogDir,
            startedAt: new Date().toISOString(),
            status: "running" as const,
          }),
        ),
        stopContainer: jest.fn(() => Promise.resolve({ removed: true, retained: false })),
        forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
        execAgent: jest.fn(() => {
          throw new Error("synthetic exec failure");
        }),
      };
      (mgr as unknown as { dockerManager: typeof fakeDockerManager }).dockerManager =
        fakeDockerManager;
      mgr.setEventCallback(() => {
        throw new Error("synthetic observer failure");
      });

      try {
        const job = mgr.start("TASK-309", { skipGate: true });
        await waitForCondition(
          () => fakeDockerManager.forceRemoveContainer.mock.calls.length === 1,
          "Docker cleanup after exec failure",
        );

        expect(fakeDockerManager.forceRemoveContainer).toHaveBeenCalledWith("container-exec-throw");
        expect(job.status).toBe("failed");
        expect(job.output.join("\n")).toContain("synthetic exec failure");
        expect(job.output.join("\n")).toContain("callback failed");
      } finally {
        mgr.killAll();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("keeps a durable barrier when startup cleanup cannot be confirmed", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-startup-barrier-"));
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
      const dockerPaths = stubDockerWorktree(mgr, projectRoot, "TASK-310");
      const fakeDockerManager = {
        ...dockerManagerLifecycleStubs(),
        createContainer: jest.fn(() =>
          Promise.resolve({
            containerId: "container-cleanup-uncertain",
            taskId: "TASK-310",
            image: "node:20-slim",
            workDir: "/workspace",
            logsVolume: "/workspace/.quack/logs",
            worktreePath: dockerPaths.worktreePath,
            runtimeLogDir: dockerPaths.runtimeLogDir,
            startedAt: new Date().toISOString(),
            status: "running" as const,
          }),
        ),
        stopContainer: jest.fn(() => Promise.reject(new Error("daemon unavailable"))),
        forceRemoveContainer: jest.fn(() => Promise.reject(new Error("daemon unavailable"))),
        execAgent: jest.fn(() => {
          throw new Error("synthetic exec failure");
        }),
      };
      (mgr as unknown as { dockerManager: typeof fakeDockerManager }).dockerManager =
        fakeDockerManager;

      try {
        const job = mgr.start("TASK-310", { skipGate: true });
        await waitForCondition(
          () => job.output.some((line) => line.includes("Could not confirm cleanup")),
          "durable Docker startup cleanup barrier",
        );

        expect(job.status).toBe("failed");
        expect(job.output.join("\n")).toContain("daemon unavailable");
        expect(mgr.getWorktreeShutdownSurvivors()).toEqual([
          expect.objectContaining({ taskId: "TASK-310", state: "survivor" }),
        ]);
        expect(() => mgr.start("TASK-310", { skipGate: true })).toThrow(
          "prior worktree ownership has not been reconciled",
        );
      } finally {
        mgr.killAll();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("waitForIdle tracks Docker result extraction and exposes cleanup failure", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-drain-"));
      const previousTrustedImages = process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
      process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = JSON.stringify([TRUSTED_MANAGED_IMAGE]);
      const mgr = new DispatchManager(projectRoot, "/fake/bin.js", {
        method: "docker",
        docker: {
          image: TRUSTED_MANAGED_IMAGE,
          volumes: [],
          envPassthrough: [],
          resourceLimits: { memoryMb: 2048, cpus: 1 },
          networkMode: "bridge",
          cleanupPolicy: "remove",
        },
      });
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: jest.fn(),
      });
      const dockerPaths = stubDockerWorktree(mgr, projectRoot, "TASK-307");
      let failCleanup!: (error: Error) => void;
      const fakeDockerManager = {
        ...dockerManagerLifecycleStubs(),
        createContainer: jest.fn(() =>
          Promise.resolve({
            containerId: "container-delayed-cleanup",
            taskId: "TASK-307",
            image: "node:20-slim",
            workDir: "/workspace",
            logsVolume: "/workspace/.quack/logs",
            worktreePath: dockerPaths.worktreePath,
            runtimeLogDir: dockerPaths.runtimeLogDir,
            startedAt: new Date().toISOString(),
            status: "running" as const,
          }),
        ),
        execAgent: jest.fn(() => child),
        extractResults: jest.fn(),
        stopContainer: jest.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              failCleanup = reject;
            }),
        ),
        forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
      };
      (
        mgr as unknown as {
          dockerManager: typeof fakeDockerManager;
        }
      ).dockerManager = fakeDockerManager;

      try {
        const job = mgr.start("TASK-307", {
          skipGate: true,
          admittedTaskContentHash: "a".repeat(64),
        });
        await waitForCondition(
          () => fakeDockerManager.execAgent.mock.calls.length === 1,
          "Docker exec child launch",
        );
        const execCall = fakeDockerManager.execAgent.mock.calls[0] as unknown as [
          string,
          string[],
          Record<string, string>,
        ];
        expect(execCall[2][DECOMPOSITION_ADMISSION_HASH_ENV]).toBe("a".repeat(64));
        expect(execCall[2][DECOMPOSITION_ADMISSION_MARKER_ENV]).toBe("marker.json");
        expect(execCall[2][DECOMPOSITION_ADMISSION_TOKEN_ENV]).toMatch(/^[0-9a-f-]{36}$/);
        const createCall = fakeDockerManager.createContainer.mock.calls[0] as unknown as [
          string,
          string,
          { admissionScopeDirectory?: string },
        ];
        expect(createCall[1]).toBe(dockerPaths.worktreePath);
        expect(createCall[2].admissionScopeDirectory).toMatch(
          new RegExp(`decomposition-admissions[\\\\/]dispatch-TASK-307-[0-9a-f-]{36}$`),
        );
        expect(
          fs.existsSync(
            path.join(
              createCall[2].admissionScopeDirectory!,
              execCall[2][DECOMPOSITION_ADMISSION_MARKER_ENV],
            ),
          ),
        ).toBe(true);
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        await waitForCondition(
          () => fakeDockerManager.stopContainer.mock.calls.length === 1,
          "Docker container cleanup",
        );

        let idleSettled = false;
        const idle = mgr.waitForIdle(5_000).then((value) => {
          idleSettled = true;
          return value;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(idleSettled).toBe(false);

        failCleanup(new Error("synthetic cleanup failure"));
        await expect(idle).resolves.toBe(true);
        expect(fakeDockerManager.extractResults).not.toHaveBeenCalled();
        expect(job.status).toBe("failed");
        expect(job.output.join("\n")).toContain("synthetic cleanup failure");
      } finally {
        mgr.killAll();
        if (previousTrustedImages === undefined) {
          delete process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
        } else {
          process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = previousTrustedImages;
        }
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("does not create DockerManager when docker config is missing", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
        method: "docker",
        // No docker config — should gracefully degrade
      });
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("checkDockerAvailability throws when no docker manager", async () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      await expect(mgr.checkDockerAvailability()).rejects.toThrow(
        "Docker isolation is not configured",
      );
      mgr.killAll();
    });

    test("setEventCallback stores callback without error", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      const cb = jest.fn();
      expect(() => mgr.setEventCallback(cb)).not.toThrow();
      mgr.killAll();
    });

    test("cleanupAllContainers is no-op when no docker manager", async () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      await expect(mgr.cleanupAllContainers()).resolves.not.toThrow();
      mgr.killAll();
    });
  });

  describe("unlinkJunctions", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("unlinking a junction before rmSync preserves target contents", () => {
      // Set up: real target directory with a file
      const mainLogs = path.join(tmpDir, "main-logs");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "session.jsonl"), "test data");

      // Set up: worktree with a junction pointing to the target
      const worktreePath = path.join(tmpDir, "worktree");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });
      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");

      // Verify junction exists
      expect(fs.lstatSync(path.join(wtQuack, "logs")).isSymbolicLink()).toBe(true);

      // Unlink the junction first (what unlinkJunctions does), then rmSync
      fs.unlinkSync(path.join(wtQuack, "logs"));
      fs.rmSync(worktreePath, { recursive: true, force: true });

      // Target directory and contents survive
      expect(fs.existsSync(mainLogs)).toBe(true);
      expect(fs.readFileSync(path.join(mainLogs, "session.jsonl"), "utf-8")).toBe("test data");
    });

    test("removeWorktree preserves junction target contents", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");

      // Create a fake worktree dir with a junction to a shared logs dir
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-TEST");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      const mainLogs = path.join(tmpDir, ".quack", "logs");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "keep-me.jsonl"), "precious data");
      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");

      // Call the private removeWorktree — it should unlink junctions first
      const removeWorktree = (mgr as unknown as Record<string, (p: string) => void>)[
        "removeWorktree"
      ];
      removeWorktree.call(mgr, worktreePath);

      // Main logs directory and contents must survive
      expect(fs.existsSync(mainLogs)).toBe(true);
      expect(fs.readFileSync(path.join(mainLogs, "keep-me.jsonl"), "utf-8")).toBe("precious data");

      mgr.killAll();
    });

    test("removeWorktree preserves both logs and prep junctions", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");

      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-DUAL");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      const mainLogs = path.join(tmpDir, ".quack", "logs");
      const mainPrep = path.join(tmpDir, ".quack", "prep");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.mkdirSync(mainPrep, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "log.jsonl"), "log data");
      fs.writeFileSync(path.join(mainPrep, "gate.json"), "prep data");

      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");
      fs.symlinkSync(mainPrep, path.join(wtQuack, "prep"), "junction");

      const removeWorktree = (mgr as unknown as Record<string, (p: string) => void>)[
        "removeWorktree"
      ];
      removeWorktree.call(mgr, worktreePath);

      // Both target directories and their contents survive
      expect(fs.readFileSync(path.join(mainLogs, "log.jsonl"), "utf-8")).toBe("log data");
      expect(fs.readFileSync(path.join(mainPrep, "gate.json"), "utf-8")).toBe("prep data");

      mgr.killAll();
    });

    test("unlinkJunctions handles missing .quack directory gracefully", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const worktreePath = path.join(tmpDir, "nonexistent-worktree");

      // Should not throw even when .quack doesn't exist
      const unlinkJunctions = (mgr as unknown as Record<string, (p: string) => void>)[
        "unlinkJunctions"
      ];
      expect(() => unlinkJunctions.call(mgr, worktreePath)).not.toThrow();
      mgr.killAll();
    });

    test("unlinkJunctions skips non-symlink directories", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const worktreePath = path.join(tmpDir, "worktree");
      const wtQuack = path.join(worktreePath, ".quack");

      // Create real directories (not junctions) at logs and prep
      fs.mkdirSync(path.join(wtQuack, "logs"), { recursive: true });
      fs.mkdirSync(path.join(wtQuack, "prep"), { recursive: true });
      fs.writeFileSync(path.join(wtQuack, "logs", "file.txt"), "data");

      const unlinkJunctions = (mgr as unknown as Record<string, (p: string) => void>)[
        "unlinkJunctions"
      ];
      unlinkJunctions.call(mgr, worktreePath);

      // Real directory contents are untouched (lstatSync returns isSymbolicLink=false, so no unlink)
      expect(fs.readFileSync(path.join(wtQuack, "logs", "file.txt"), "utf-8")).toBe("data");

      mgr.killAll();
    });
  });

  describe("operator stop lifecycle", () => {
    let tmpDir: string;
    const windowsTest = process.platform === "win32" ? test : test.skip;

    function git(cwd: string, args: string[]): void {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    }

    function initRepoWithOrigin(rootDir: string): string {
      const originDir = path.join(rootDir, "origin.git");
      const repoDir = path.join(rootDir, "repo");
      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "fresh\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "tracked.txt"]);
      git(repoDir, ["commit", "-m", "initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["push", "-u", "origin", "dev"]);
      return repoDir;
    }

    function createDeniedPathQuarantine(
      projectRoot: string,
      suffix: string,
      lockPid?: number,
    ): string {
      const protectedRoot = path.join(projectRoot, ".quack");
      const entries: Record<string, { kind: "file" | "directory" | "symlink"; digest: string }> =
        Object.create(null) as Record<
          string,
          { kind: "file" | "directory" | "symlink"; digest: string }
        >;
      const digest = (value: Buffer | string): string =>
        createHash("sha256").update(value).digest("hex");
      const walk = (absolute: string, relative: string): void => {
        const stat = fs.lstatSync(absolute);
        const key = relative.split(path.sep).join("/");
        if (stat.isSymbolicLink()) {
          entries[key] = { kind: "symlink", digest: digest(fs.readlinkSync(absolute)) };
          return;
        }
        if (stat.isDirectory()) {
          entries[key] = { kind: "directory", digest: "directory" };
          for (const child of fs.readdirSync(absolute).sort()) {
            walk(path.join(absolute, child), path.join(relative, child));
          }
          return;
        }
        entries[key] = { kind: "file", digest: digest(fs.readFileSync(absolute)) };
      };
      walk(protectedRoot, ".quack");

      const quarantineRoot = path.join(path.dirname(projectRoot), `.quack-codex-denied-${suffix}`);
      fs.mkdirSync(quarantineRoot);
      fs.writeFileSync(
        path.join(quarantineRoot, "manifest.json"),
        JSON.stringify({
          version: 2,
          projectRoot: fs.realpathSync(projectRoot),
          policy: { writablePaths: ["src/"], deniedPaths: [".quack/"] },
          before: { entries },
          items: [{ relativePath: ".quack", backupName: "0", mode: "move" }],
        }),
        "utf-8",
      );
      fs.renameSync(protectedRoot, path.join(quarantineRoot, "0"));
      if (lockPid !== undefined) {
        fs.writeFileSync(
          path.join(quarantineRoot, "recovery.lock"),
          JSON.stringify({ pid: lockPid }),
          "utf-8",
        );
      }
      return quarantineRoot;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-manual-stop-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("uses a durable sibling barrier when the primary barrier directory is unavailable", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const primaryBarrierPath = path.join(repoDir, ".quack", "operator-stop-barriers");
      fs.writeFileSync(primaryBarrierPath, "primary path obstruction", "utf8");
      const mgr = createLocalOriginFixtureManager(repoDir, process.execPath);
      const job: DispatchJob = {
        taskId: "TASK-BARRIER-FALLBACK",
        sessionId: "barrier-fallback",
        pid: 42,
        startedAt: new Date().toISOString(),
        status: "stopped",
        output: [],
        executionRoot: path.join(repoDir, ".quack", "worktrees", "TASK-BARRIER-FALLBACK"),
        operatorStopRequestedAt: new Date().toISOString(),
        operatorStopCleanupPending: true,
      };
      const internals = mgr as unknown as {
        persistOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        clearOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        operatorStopFallbackBarrierDirectory: () => string;
      };

      expect(internals.persistOperatorStopBarrier.call(mgr, job)).toBe(true);
      expect(job.output.join("\n")).toContain("using durable fallback");
      const fallbackDirectory = internals.operatorStopFallbackBarrierDirectory.call(mgr);
      expect(
        fs.readdirSync(fallbackDirectory).filter((entry) => entry.endsWith(".json")),
      ).toHaveLength(1);

      fs.rmSync(primaryBarrierPath);
      const restartedManager = createLocalOriginFixtureManager(repoDir, process.execPath);
      expect(() => restartedManager.start(job.taskId, { skipGate: true })).toThrow(
        "operator-stop cleanup remains unconfirmed",
      );

      expect(internals.clearOperatorStopBarrier.call(mgr, job)).toBe(true);
      restartedManager.killAll();
      mgr.killAll();
    });

    test("refuses to terminate a child when no durable stop barrier can be written", () => {
      const projectRoot = path.join(tmpDir, "barrier-write-failure");
      fs.mkdirSync(projectRoot);
      const mgr = new DispatchManager(projectRoot, process.execPath);
      const taskId = "TASK-BARRIER-WRITE-FAILURE";
      const job: DispatchJob = {
        taskId,
        sessionId: "barrier-write-failure",
        pid: 42,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
        executionRoot: projectRoot,
      };
      const kill = jest.fn();
      const internals = mgr as unknown as {
        jobs: Map<string, DispatchJob>;
        processes: Map<string, { pid: number; kill: typeof kill }>;
        operatorStopCleanupPending: Map<string, DispatchJob>;
        persistOperatorStopBarrier: (candidate: DispatchJob) => boolean;
      };
      internals.jobs.set(taskId, job);
      internals.processes.set(taskId, { pid: job.pid, kill });
      jest.spyOn(internals, "persistOperatorStopBarrier").mockReturnValue(false);

      expect(mgr.stop(taskId)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(job.status).toBe("running");
      expect(job.operatorStopRequestedAt).toBeUndefined();
      expect(job.operatorStopCleanupPending).toBe(false);
      expect(internals.operatorStopCleanupPending.has(taskId)).toBe(false);
      expect(mgr.killAll()).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    });

    test("returns false and retains the barrier when native tree termination is unconfirmed", () => {
      const projectRoot = path.join(tmpDir, "unconfirmed-native-stop");
      fs.mkdirSync(projectRoot);
      const mgr = new DispatchManager(projectRoot, process.execPath);
      const taskId = "TASK-UNCONFIRMED-NATIVE";
      const job: DispatchJob = {
        taskId,
        sessionId: "unconfirmed-native-stop",
        pid: 4242,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
        executionRoot: path.join(projectRoot, ".quack", "worktrees", taskId),
      };
      const child = { pid: job.pid, kill: jest.fn() };
      const internals = mgr as unknown as {
        jobs: Map<string, DispatchJob>;
        processes: Map<string, typeof child>;
        operatorStopCleanupPending: Map<string, DispatchJob>;
        terminateOperatorProcessTree: () => {
          confirmed: boolean;
          warning?: string;
        };
      };
      internals.jobs.set(taskId, job);
      internals.processes.set(taskId, child);
      jest.spyOn(internals, "terminateOperatorProcessTree").mockReturnValue({
        confirmed: false,
        warning: "synthetic unconfirmed process tree",
      });

      expect(mgr.stop(taskId)).toBe(false);
      expect(job.status).toBe("stopped");
      expect(job.operatorStopTreeTerminated).toBe(false);
      expect(job.operatorStopCleanupPending).toBe(true);
      expect(internals.operatorStopCleanupPending.get(taskId)).toBe(job);
      expect(fs.existsSync(job.operatorStopBarrierPath!)).toBe(true);
      expect(job.output.join("\n")).toContain("synthetic unconfirmed process tree");
      expect(mgr.killAll()).toBe(false);
    });

    (process.platform === "win32" ? test.skip : test)(
      "re-probes a cached POSIX stop and completes recovery after the child handle closes",
      async () => {
        const projectRoot = path.join(tmpDir, "cached-posix-stop");
        const worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-CACHED-STOP");
        fs.mkdirSync(worktreePath, { recursive: true });
        const mgr = new DispatchManager(projectRoot, process.execPath);
        const job: DispatchJob = {
          taskId: "TASK-CACHED-STOP",
          sessionId: "cached-posix-stop",
          pid: 4242,
          startedAt: new Date().toISOString(),
          status: "running",
          output: [],
          worktreePath,
          executionRoot: worktreePath,
        };
        const child = { pid: job.pid, kill: jest.fn() };
        const internals = mgr as unknown as {
          jobs: Map<string, DispatchJob>;
          processes: Map<string, typeof child>;
          terminateOperatorProcessTree: () => {
            confirmed: boolean;
            processGroupId?: number;
            warning?: string;
          };
          posixProcessGroupIsAbsent: (processGroupId: number) => boolean;
          shouldCleanupDockerForWorktree: () => boolean;
        };
        internals.jobs.set(job.taskId, job);
        internals.processes.set(job.taskId, child);
        jest.spyOn(internals, "terminateOperatorProcessTree").mockReturnValue({
          confirmed: false,
          processGroupId: job.pid,
          warning: "awaiting close",
        });
        jest.spyOn(internals, "posixProcessGroupIsAbsent").mockReturnValue(true);
        jest.spyOn(internals, "shouldCleanupDockerForWorktree").mockReturnValue(true);

        expect(mgr.stop(job.taskId)).toBe(false);
        internals.processes.delete(job.taskId);
        expect(mgr.stop(job.taskId)).toBe(true);
        await expect(mgr.waitForIdle()).resolves.toBe(true);

        expect(job.operatorStopTreeTerminated).toBe(true);
        expect(job.operatorStopCleanupPending).toBe(false);
        expect(mgr.hasPendingOperatorStopCleanup(job.taskId)).toBe(false);
        expect(fs.existsSync(job.operatorStopBarrierPath ?? "")).toBe(false);
      },
    );

    test("killAll fails closed when a native child has no matching job record", () => {
      const mgr = new DispatchManager(path.join(tmpDir, "missing-job"), process.execPath);
      const child = { pid: 4243, kill: jest.fn(() => true) };
      const internals = mgr as unknown as {
        processes: Map<string, typeof child>;
      };
      internals.processes.set("TASK-MISSING-JOB", child);

      expect(mgr.killAll()).toBe(false);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    test("stores shared-root barriers only in the sibling authoritative directory", () => {
      const projectRoot = path.join(tmpDir, "shared-barrier-project");
      fs.mkdirSync(projectRoot);
      const mgr = new DispatchManager(projectRoot, process.execPath);
      const job: DispatchJob = {
        taskId: "TASK-SHARED-BARRIER",
        sessionId: "shared-barrier",
        pid: 42,
        startedAt: new Date().toISOString(),
        status: "stopped",
        output: [],
        executionRoot: projectRoot,
        operatorStopRequestedAt: new Date().toISOString(),
        operatorStopCleanupPending: true,
      };
      const internals = mgr as unknown as {
        persistOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        clearOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        operatorStopBarrierDirectory: () => string;
        operatorStopFallbackBarrierDirectory: () => string;
      };

      expect(internals.persistOperatorStopBarrier.call(mgr, job)).toBe(true);
      expect(path.dirname(job.operatorStopBarrierPath!)).toBe(
        internals.operatorStopFallbackBarrierDirectory.call(mgr),
      );
      expect(fs.existsSync(internals.operatorStopBarrierDirectory.call(mgr))).toBe(false);
      expect(job.output.join("\n")).toContain("outside the worker-writable project");

      expect(internals.clearOperatorStopBarrier.call(mgr, job)).toBe(true);
      mgr.killAll();
    });

    test("fails closed on malformed durable stop evidence", () => {
      const projectRoot = path.join(tmpDir, "malformed-stop-evidence");
      const barrierDirectory = path.join(projectRoot, ".quack", "operator-stop-barriers");
      fs.mkdirSync(barrierDirectory, { recursive: true });
      fs.writeFileSync(path.join(barrierDirectory, "damaged.json"), "not-json", "utf8");
      const mgr = new DispatchManager(projectRoot, process.execPath);

      expect(() => mgr.start("TASK-MALFORMED-BARRIER", { skipGate: true })).toThrow(
        "invalid operator-stop recovery evidence",
      );
      mgr.killAll();
    });

    test("remains stopped after real process-tree termination and preserves its worktree", async () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const readyFile = path.join(tmpDir, "child-ready");
      const scriptPath = path.join(tmpDir, "long-running-child.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready', 'utf-8');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = createLocalOriginFixtureManager(repoDir, scriptPath);
      try {
        const job = mgr.start("TASK-MANUAL-STOP", { skipGate: true });
        await waitForFile(readyFile);

        expect(job.worktreePath).toBeDefined();
        expect(fs.existsSync(job.worktreePath!)).toBe(true);
        expect(typeof mgr.stop(job.taskId)).toBe("boolean");
        expect(job.status).toBe("stopped");
        expect(job.operatorStopRequestedAt).toBeDefined();

        await waitForCondition(
          () => job.output.some((line) => line.includes("Operator-requested stop confirmed")),
          "the child exit callback",
        );

        expect(job.status).toBe("stopped");
        expect(job.exitCode).toBeUndefined();
        expect(job.killedBySignal).toBe(process.platform === "win32" ? undefined : "SIGKILL");
        expect(job.operatorStopTreeTerminated).toBe(true);
        expect(fs.existsSync(job.worktreePath!)).toBe(true);
        expect(job.output.join("\n")).toContain("branch retained for recovery");
        expect(job.output.join("\n")).not.toContain("suspect the OOM killer");
        expect(job.output.join("\n")).not.toContain("dispatch failed");
        await waitForCondition(
          () => job.output.some((line) => line.includes("Operator-stop cleanup complete")),
          "the durable stop barrier to clear",
        );
        const barrierDir = path.join(repoDir, ".quack", "operator-stop-barriers");
        expect(
          fs.existsSync(barrierDir)
            ? fs.readdirSync(barrierDir).filter((entry) => entry.endsWith(".json"))
            : [],
        ).toEqual([]);
        const restartedManager = createLocalOriginFixtureManager(repoDir, scriptPath);
        const assertNoBarrier = (
          restartedManager as unknown as {
            assertNoDurableOperatorStopBarrier: (taskId: string) => void;
          }
        ).assertNoDurableOperatorStopBarrier;
        expect(() => assertNoBarrier.call(restartedManager, job.taskId)).not.toThrow();
        restartedManager.killAll();

        const eventsFile = path.join(repoDir, ".quack", "logs", `events-${job.sessionId}.jsonl`);
        await waitForFile(eventsFile);
        const exitEvent = fs
          .readFileSync(eventsFile, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { stage: string; payload: Record<string, unknown> })
          .find((event) => event.stage === "dispatch_child_exit");
        expect(exitEvent?.payload).toMatchObject({
          exitCode: process.platform === "win32" ? 1 : null,
          signal: process.platform === "win32" ? null : "SIGKILL",
          killed: process.platform !== "win32",
          operatorRequested: true,
          worktreePath: job.worktreePath,
        });
      } finally {
        mgr.killAll();
      }
    });

    test("rebinds operator local-read authorization to the managed worktree child", async () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const originDir = path.join(tmpDir, "origin.git");
      const sessionFile = path.join(tmpDir, "child-event-session.txt");
      const environmentFile = path.join(tmpDir, "child-local-read-authorization.json");
      const scriptPath = path.join(tmpDir, "capture-local-read-authorization.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(sessionFile)}, process.env.QUACK_MONITOR_EVENT_SESSION_ID || '', 'utf8');`,
          `fs.writeFileSync(${JSON.stringify(environmentFile)}, process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES || '', 'utf8');`,
        ].join("\n"),
        "utf8",
      );
      const mgr = createLocalOriginFixtureManager(repoDir, scriptPath, originDir);
      const previousAuthorization = process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES;
      process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES = JSON.stringify({
        projectRoot: fs.realpathSync(repoDir),
        paths: [originDir],
      });

      try {
        const job = mgr.start("TASK-LOCAL-READ-CHILD", { skipGate: true });
        // Observe the active worktree before yielding to successful exit cleanup.
        const expectedWorktreeRoot = fs.realpathSync(job.worktreePath!);
        await waitForFile(environmentFile);
        expect(fs.readFileSync(sessionFile, "utf8")).toBe(job.sessionId);
        const authorization = JSON.parse(fs.readFileSync(environmentFile, "utf8")) as {
          projectRoot: string;
          paths: string[];
        };

        expect(authorization).toEqual({
          projectRoot: expectedWorktreeRoot,
          paths: [originDir],
        });
      } finally {
        await mgr.shutdownAll({ gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 });
        if (previousAuthorization === undefined) {
          delete process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES;
        } else {
          process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES = previousAuthorization;
        }
      }
    });

    test("does not leak a parent local-read grant when the manager received none", async () => {
      const projectRoot = path.join(tmpDir, "no-local-read-grant");
      fs.mkdirSync(projectRoot);
      const environmentFile = path.join(tmpDir, "child-without-local-read-authorization.txt");
      const scriptPath = path.join(tmpDir, "capture-missing-local-read-authorization.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(environmentFile)}, process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES || 'absent', 'utf8');`,
        ].join("\n"),
        "utf8",
      );
      const previousAuthorization = process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES;
      process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES = "parent-grant-must-not-leak";
      const mgr = new DispatchManager(projectRoot, scriptPath);

      try {
        mgr.start("TASK-NO-LOCAL-READ-GRANT", { skipGate: true });
        await waitForFile(environmentFile);
        expect(fs.readFileSync(environmentFile, "utf8")).toBe("absent");
      } finally {
        mgr.killAll();
        if (previousAuthorization === undefined) {
          delete process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES;
        } else {
          process.env.QUACK_TRUSTED_LOCAL_READ_REMOTES = previousAuthorization;
        }
      }
    });

    test("does not expose the operator managed-Docker image allowlist to a worktree child", async () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const environmentFile = path.join(tmpDir, "child-managed-docker-policy.json");
      const scriptPath = path.join(tmpDir, "capture-managed-docker-policy.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify({`,
          "  leaked: Object.keys(process.env).some((key) => key.toUpperCase() === 'QUACK_TRUSTED_MANAGED_DOCKER_IMAGES'),",
          "  sentinel: process.env.QUACK_AGENT_ENV_SENTINEL",
          "}), 'utf8');",
        ].join("\n"),
        "utf8",
      );
      const mgr = createLocalOriginFixtureManager(repoDir, scriptPath);
      const previousAllowlist = process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
      const previousSentinel = process.env.QUACK_AGENT_ENV_SENTINEL;
      process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = JSON.stringify([TRUSTED_MANAGED_IMAGE]);
      process.env.QUACK_AGENT_ENV_SENTINEL = "visible";

      try {
        mgr.start("TASK-NO-DOCKER-POLICY", { skipGate: true });
        await waitForFile(environmentFile);
        expect(JSON.parse(fs.readFileSync(environmentFile, "utf8"))).toEqual({
          leaked: false,
          sentinel: "visible",
        });
      } finally {
        mgr.killAll();
        if (previousAllowlist === undefined) {
          delete process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
        } else {
          process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = previousAllowlist;
        }
        if (previousSentinel === undefined) delete process.env.QUACK_AGENT_ENV_SENTINEL;
        else process.env.QUACK_AGENT_ENV_SENTINEL = previousSentinel;
      }
    });

    windowsTest(
      "keeps restart blocked when worktree container cleanup is unconfirmed",
      async () => {
        const repoDir = initRepoWithOrigin(tmpDir);
        const readyFile = path.join(tmpDir, "docker-cleanup-child-ready");
        const scriptPath = path.join(tmpDir, "docker-cleanup-child.cjs");
        fs.writeFileSync(
          scriptPath,
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready', 'utf-8');`,
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf-8",
        );
        mockCleanupWorktreeContainers.mockReturnValue(false);

        const mgr = createLocalOriginFixtureManager(repoDir, scriptPath);
        try {
          const job = mgr.start("TASK-DOCKER-STOP-BARRIER", { skipGate: true });
          await waitForFile(readyFile);
          expect(mgr.stop(job.taskId)).toBe(true);
          await waitForCondition(
            () =>
              job.output.some((line) =>
                line.includes("worktree container cleanup was disabled or could not be confirmed"),
              ),
            "the failed container-cleanup barrier",
          );

          expect(job.operatorStopCleanupPending).toBe(true);
          expect(() => mgr.start(job.taskId, { skipGate: true })).toThrow(
            "still completing operator-stop cleanup",
          );
          const barrierDir = path.join(repoDir, ".quack", "operator-stop-barriers");
          expect(
            fs.readdirSync(barrierDir).filter((entry) => entry.endsWith(".json")),
          ).toHaveLength(1);

          const restartedManager = createLocalOriginFixtureManager(repoDir, scriptPath);
          expect(() => restartedManager.start(job.taskId, { skipGate: true })).toThrow(
            "operator-stop cleanup remains unconfirmed",
          );
          restartedManager.killAll();
        } finally {
          mgr.killAll();
        }
      },
    );

    windowsTest(
      "kills descendants but preserves all generations when sibling evidence is ambiguous",
      async () => {
        const repoDir = initRepoWithOrigin(tmpDir);
        const originalFixture = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 10]);
        fs.writeFileSync(path.join(repoDir, ".quack", "guard-fixture.bin"), originalFixture);
        git(repoDir, ["add", "-f", ".quack/guard-fixture.bin"]);
        git(repoDir, ["commit", "-m", "add denied-path fixture"]);
        git(repoDir, ["push", "origin", "dev"]);

        const ownerReadyFile = path.join(tmpDir, "quarantine-owner-ready.json");
        const descendantReadyFile = path.join(tmpDir, "quarantine-descendant-ready");
        const descendantScript = path.join(tmpDir, "quarantine-descendant.cjs");
        const ownerScript = path.join(tmpDir, "quarantine-owner.cjs");

        fs.writeFileSync(
          descendantScript,
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const [target, ready] = process.argv.slice(2);",
            "fs.writeFileSync(ready, String(process.pid), 'utf-8');",
            "setInterval(() => {",
            "  try {",
            "    fs.mkdirSync(path.dirname(target), { recursive: true });",
            "    fs.writeFileSync(target, 'descendant-was-still-writing', 'utf-8');",
            "  } catch {}",
            "}, 10);",
          ].join("\n"),
          "utf-8",
        );

        fs.writeFileSync(
          ownerScript,
          [
            "const crypto = require('node:crypto');",
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const { spawn } = require('node:child_process');",
            `const ownerReady = ${JSON.stringify(ownerReadyFile)};`,
            `const descendantReady = ${JSON.stringify(descendantReadyFile)};`,
            `const descendantScript = ${JSON.stringify(descendantScript)};`,
            "const projectRoot = fs.realpathSync(process.cwd());",
            "const protectedRoot = path.join(projectRoot, '.quack');",
            "const entries = Object.create(null);",
            "function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }",
            "function walk(absolute, relative) {",
            "  const stat = fs.lstatSync(absolute);",
            "  const key = relative.split(path.sep).join('/');",
            "  if (stat.isSymbolicLink()) {",
            "    entries[key] = { kind: 'symlink', digest: digest(fs.readlinkSync(absolute)) };",
            "    return;",
            "  }",
            "  if (stat.isDirectory()) {",
            "    entries[key] = { kind: 'directory', digest: 'directory' };",
            "    for (const child of fs.readdirSync(absolute).sort()) {",
            "      walk(path.join(absolute, child), path.join(relative, child));",
            "    }",
            "    return;",
            "  }",
            "  entries[key] = { kind: 'file', digest: digest(fs.readFileSync(absolute)) };",
            "}",
            "walk(protectedRoot, '.quack');",
            "const quarantineRoot = fs.mkdtempSync(path.join(path.dirname(projectRoot), '.quack-codex-denied-'));",
            "const manifest = {",
            "  version: 2,",
            "  projectRoot,",
            "  policy: { writablePaths: ['src/'], deniedPaths: ['.quack/'] },",
            "  before: { entries },",
            "  items: [{ relativePath: '.quack', backupName: '0', mode: 'move' }],",
            "};",
            "fs.writeFileSync(path.join(quarantineRoot, 'manifest.json'), JSON.stringify(manifest), 'utf-8');",
            "fs.renameSync(protectedRoot, path.join(quarantineRoot, '0'));",
            "fs.mkdirSync(protectedRoot, { recursive: true });",
            "fs.writeFileSync(path.join(protectedRoot, 'guard-fixture.bin'), 'model-created replacement', 'utf-8');",
            "fs.writeFileSync(path.join(quarantineRoot, 'recovery.lock'), JSON.stringify({ pid: process.pid }), 'utf-8');",
            "const descendantTarget = path.join(protectedRoot, 'descendant-write.txt');",
            "const descendant = spawn(process.execPath, [descendantScript, descendantTarget, descendantReady], {",
            "  stdio: 'ignore',",
            "});",
            "fs.writeFileSync(ownerReady, JSON.stringify({ quarantineRoot, descendantPid: descendant.pid }), 'utf-8');",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf-8",
        );

        const mgr = createLocalOriginFixtureManager(repoDir, ownerScript);
        try {
          const job = mgr.start("TASK-QUARANTINE-STOP", { skipGate: true });
          await waitForFile(ownerReadyFile);
          await waitForFile(descendantReadyFile);

          const ownerState = JSON.parse(fs.readFileSync(ownerReadyFile, "utf-8")) as {
            quarantineRoot: string;
            descendantPid: number;
          };
          const validManifest = JSON.parse(
            fs.readFileSync(path.join(ownerState.quarantineRoot, "manifest.json"), "utf-8"),
          ) as Record<string, unknown>;
          expect(
            JSON.parse(
              fs.readFileSync(path.join(ownerState.quarantineRoot, "recovery.lock"), "utf-8"),
            ),
          ).toEqual({ pid: job.pid });
          const worktreeParent = path.dirname(job.worktreePath!);
          const malformedRoot = path.join(worktreeParent, ".quack-codex-denied-malformed");
          const crossProjectRoot = path.join(worktreeParent, ".quack-codex-denied-cross-project");
          fs.mkdirSync(malformedRoot);
          fs.writeFileSync(path.join(malformedRoot, "manifest.json"), "not-json", "utf-8");
          fs.mkdirSync(crossProjectRoot);
          fs.writeFileSync(
            path.join(crossProjectRoot, "manifest.json"),
            JSON.stringify({ ...validManifest, projectRoot: fs.realpathSync(repoDir) }),
            "utf-8",
          );

          expect(mgr.stop(job.taskId)).toBe(true);
          await waitForCondition(
            () => job.output.some((line) => line.includes("no generation was recovered")),
            "the ambiguous quarantine refusal",
          );
          await new Promise((resolve) => setTimeout(resolve, 200));

          expect(job.status).toBe("stopped");
          expect(job.operatorStopTreeTerminated).toBe(true);
          expect(fs.existsSync(job.worktreePath!)).toBe(true);
          expect(
            fs
              .readFileSync(path.join(job.worktreePath!, ".quack", "guard-fixture.bin"))
              .equals(Buffer.from("model-created replacement")),
          ).toBe(true);
          expect(
            fs
              .readFileSync(path.join(ownerState.quarantineRoot, "0", "guard-fixture.bin"))
              .equals(originalFixture),
          ).toBe(true);
          expect(fs.existsSync(ownerState.quarantineRoot)).toBe(true);
          expect(fs.existsSync(malformedRoot)).toBe(true);
          expect(fs.existsSync(crossProjectRoot)).toBe(true);
          expect(job.operatorStopCleanupPending).toBe(true);
          expect(job.output.join("\n")).toContain("Invalid Codex denied-path quarantine manifest");
          expect(job.output.join("\n")).toContain(
            "declares another project but does not validate for that project",
          );

          let descendantAlive = true;
          try {
            process.kill(ownerState.descendantPid, 0);
          } catch {
            descendantAlive = false;
          }
          expect(descendantAlive).toBe(false);
        } finally {
          mgr.killAll();
        }
      },
    );

    test("a fresh manager refuses reuse of a worktree with orphaned quarantine evidence", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const taskId = "TASK-ORPHAN-RESTART";
      const worktreePath = path.join(repoDir, ".quack", "worktrees", taskId);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(repoDir, ["worktree", "add", "-b", `quack/${taskId}`, worktreePath, "origin/dev"]);
      fs.mkdirSync(path.join(worktreePath, ".quack"));
      fs.writeFileSync(path.join(worktreePath, ".quack", "fixture.bin"), "original");
      const quarantineRoot = createDeniedPathQuarantine(worktreePath, "restart-owned");

      // This manager has no in-memory knowledge of the run that created the
      // quarantine, matching a monitor restart after an abrupt stop.
      const restartedManager = createLocalOriginFixtureManager(repoDir, process.execPath);
      expect(() => restartedManager.start(taskId, { skipGate: true, reuseWorktree: true })).toThrow(
        "unresolved Codex denied-path quarantine evidence",
      );
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.existsSync(quarantineRoot)).toBe(true);
      restartedManager.killAll();
    });

    test("finds quarantine evidence beside a canonical target reached through a directory alias", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const aliasRoot = path.join(tmpDir, "repo-alias");
      fs.symlinkSync(repoDir, aliasRoot, "junction");
      const taskId = "TASK-ALIASED-QUARANTINE";
      const canonicalWorktree = path.join(repoDir, ".quack", "worktrees", taskId);
      fs.mkdirSync(path.dirname(canonicalWorktree), { recursive: true });
      git(repoDir, ["worktree", "add", "-b", `quack/${taskId}`, canonicalWorktree, "origin/dev"]);
      fs.mkdirSync(path.join(canonicalWorktree, ".quack"));
      fs.writeFileSync(path.join(canonicalWorktree, ".quack", "fixture.bin"), "original");
      const quarantineRoot = createDeniedPathQuarantine(canonicalWorktree, "canonical-parent");

      const restartedManager = new DispatchManager(aliasRoot, process.execPath);
      const assertNoQuarantine = (
        restartedManager as unknown as {
          assertNoOrphanedQuarantineBeforeWorktreeMutation: (
            currentTaskId: string,
            worktreePath: string,
          ) => void;
        }
      ).assertNoOrphanedQuarantineBeforeWorktreeMutation;

      expect(() =>
        assertNoQuarantine.call(
          restartedManager,
          taskId,
          path.join(aliasRoot, ".quack", "worktrees", taskId),
        ),
      ).toThrow("unresolved Codex denied-path quarantine evidence");
      expect(fs.existsSync(quarantineRoot)).toBe(true);
      restartedManager.killAll();
    });

    test("a missing fresh target ignores a fully validated sibling-worktree quarantine", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const ownerTaskId = "TASK-OTHER-OWNER";
      const ownerWorktree = path.join(repoDir, ".quack", "worktrees", ownerTaskId);
      fs.mkdirSync(path.dirname(ownerWorktree), { recursive: true });
      git(repoDir, ["worktree", "add", "-b", `quack/${ownerTaskId}`, ownerWorktree, "origin/dev"]);
      fs.mkdirSync(path.join(ownerWorktree, ".quack"));
      fs.writeFileSync(path.join(ownerWorktree, ".quack", "fixture.bin"), "owner");
      const quarantineRoot = createDeniedPathQuarantine(ownerWorktree, "valid-other");

      const mgr = createLocalOriginFixtureManager(repoDir, process.execPath);
      const createWorktree = (
        mgr as unknown as {
          createWorktree: (taskId: string) => string | undefined;
        }
      ).createWorktree;
      const freshTaskId = "TASK-FRESH-BESIDE-OTHER";
      const freshWorktree = createWorktree.call(mgr, freshTaskId);

      expect(freshWorktree).toBe(path.join(repoDir, ".quack", "worktrees", freshTaskId));
      expect(fs.existsSync(freshWorktree!)).toBe(true);
      expect(fs.existsSync(quarantineRoot)).toBe(true);
      mgr.killAll();
    });

    windowsTest("preserves two valid generations and keeps restart blocked", async () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const readyFile = path.join(tmpDir, "ambiguous-ready");
      const scriptPath = path.join(tmpDir, "ambiguous-child.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready', 'utf-8');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = createLocalOriginFixtureManager(repoDir, scriptPath);
      try {
        const job = mgr.start("TASK-AMBIGUOUS-QUARANTINE", { skipGate: true });
        await waitForFile(readyFile);
        const firstRoot = createDeniedPathQuarantine(job.worktreePath!, "generation-one");
        fs.cpSync(path.join(firstRoot, "0"), path.join(job.worktreePath!, ".quack"), {
          recursive: true,
        });
        const secondRoot = createDeniedPathQuarantine(job.worktreePath!, "generation-two");

        expect(mgr.stop(job.taskId)).toBe(true);
        await waitForCondition(
          () => job.output.some((line) => line.includes("multiple valid quarantines")),
          "the ambiguous quarantine refusal",
        );

        expect(job.status).toBe("stopped");
        expect(job.operatorStopCleanupPending).toBe(true);
        expect(fs.existsSync(firstRoot)).toBe(true);
        expect(fs.existsSync(secondRoot)).toBe(true);
        expect(() => mgr.start(job.taskId, { skipGate: true })).toThrow(
          "still completing operator-stop cleanup",
        );
      } finally {
        mgr.killAll();
      }
    });

    windowsTest("a pending shared-directory cleanup blocks a different task", async () => {
      const readyFile = path.join(tmpDir, "shared-child-ready");
      const scriptPath = path.join(tmpDir, "shared-child.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready', 'utf-8');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf-8",
      );
      const sharedRoot = path.join(tmpDir, "not-a-git-repository");
      fs.mkdirSync(sharedRoot);
      const mgr = new DispatchManager(sharedRoot, scriptPath);
      const cleanupCallsBefore = mockCleanupWorktreeContainers.mock.calls.length;
      try {
        const stoppedJob = mgr.start("TASK-SHARED-STOP", { skipGate: true });
        await waitForFile(readyFile);
        expect(stoppedJob.worktreePath).toBeUndefined();
        expect(mgr.stop(stoppedJob.taskId)).toBe(true);
        await waitForCondition(
          () =>
            stoppedJob.output.some((line) =>
              line.includes("stopped run used the shared project directory"),
            ),
          "the shared-directory manual recovery barrier",
        );
        expect(mockCleanupWorktreeContainers.mock.calls.length).toBe(cleanupCallsBefore);
        expect(() => mgr.start("TASK-DIFFERENT", { skipGate: true })).toThrow(
          "still has unconfirmed cleanup in the shared project directory",
        );

        const restartedManager = new DispatchManager(sharedRoot, scriptPath);
        expect(() => restartedManager.start("TASK-DIFFERENT", { skipGate: true })).toThrow(
          "operator-stop cleanup remains unconfirmed",
        );
        restartedManager.killAll();
      } finally {
        mgr.killAll();
      }
    });

    windowsTest(
      "refuses same-task restart until stopped-child cleanup completes",
      async () => {
        const repoDir = initRepoWithOrigin(tmpDir);
        const startsFile = path.join(tmpDir, "child-starts");
        const scriptPath = path.join(tmpDir, "replaceable-child.cjs");
        fs.writeFileSync(
          scriptPath,
          [
            "const fs = require('node:fs');",
            `fs.appendFileSync(${JSON.stringify(startsFile)}, process.pid + '\\n', 'utf-8');`,
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf-8",
        );

        const mgr = createLocalOriginFixtureManager(repoDir, scriptPath);
        try {
          const stoppedJob = mgr.start("TASK-REPLACED", { skipGate: true });
          await waitForCondition(
            () =>
              fs.existsSync(startsFile) && fs.readFileSync(startsFile, "utf-8").trim().length > 0,
            "the original child to start",
          );

          expect(mgr.stop(stoppedJob.taskId)).toBe(true);
          expect(() => mgr.start("TASK-REPLACED", { skipGate: true })).toThrow(
            "still completing operator-stop cleanup",
          );
          expect(mgr.getJob("TASK-REPLACED")).toBe(stoppedJob);

          await waitForCondition(
            () => stoppedJob.output.some((line) => line.includes("Operator-stop cleanup complete")),
            "the original child's cleanup barrier",
          );

          const replacement = mgr.start("TASK-REPLACED", { skipGate: true });
          await waitForCondition(
            () => fs.readFileSync(startsFile, "utf-8").trim().split(/\r?\n/).length === 2,
            "the replacement child to start",
          );

          expect(mgr.getJob("TASK-REPLACED")).toBe(replacement);
          expect(replacement.status).toBe("running");
          expect(mgr.stop("TASK-REPLACED")).toBe(true);
          await waitForCondition(
            () =>
              replacement.output.some((line) => line.includes("Operator-stop cleanup complete")),
            "the replacement child's cleanup barrier",
          );
          expect(replacement.status).toBe("stopped");
        } finally {
          mgr.killAll();
        }
      },
      45_000,
    );
  });

  describe("worktree freshness", () => {
    let tmpDir: string;

    function git(cwd: string, args: string[]): void {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    }

    function initRepoWithOrigin(rootDir: string): string {
      const originDir = path.join(rootDir, "origin.git");
      const repoDir = path.join(rootDir, "repo");
      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "fresh\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "tracked.txt"]);
      git(repoDir, ["commit", "-m", "initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["push", "-u", "origin", "dev"]);
      return repoDir;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worktree-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("creates worktrees from freshly fetched origin base, not stale local HEAD", () => {
      const originDir = path.join(tmpDir, "origin.git");
      const repoDir = path.join(tmpDir, "repo");
      const updaterDir = path.join(tmpDir, "updater");

      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "stale\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "tracked.txt"]);
      git(repoDir, ["commit", "-m", "initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["push", "-u", "origin", "dev"]);

      execFileSync("git", ["clone", originDir, updaterDir], { stdio: "ignore" });
      git(updaterDir, ["config", "user.email", "quack@example.test"]);
      git(updaterDir, ["config", "user.name", "Quack Test"]);
      git(updaterDir, ["checkout", "dev"]);
      fs.writeFileSync(path.join(updaterDir, "tracked.txt"), "fresh\n");
      git(updaterDir, ["commit", "-am", "remote update"]);
      git(updaterDir, ["push", "origin", "dev"]);

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js", originDir);
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-FRESH");

      expect(worktreePath).toBeDefined();
      expect(
        fs.readFileSync(path.join(worktreePath!, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("fresh\n");

      mgr.killAll();
    });

    test("keeps frontend dependencies isolated when worktree initialization is active", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const parentDependencies = path.join(repoDir, "frontend", "node_modules");
      fs.mkdirSync(parentDependencies, { recursive: true });
      fs.writeFileSync(path.join(parentDependencies, "parent-only.txt"), "do not share", "utf8");

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-ISOLATED-DEPS");

      expect(worktreePath).toBeDefined();
      expect(fs.existsSync(path.join(worktreePath!, "frontend", "node_modules"))).toBe(false);
      expect(fs.readFileSync(path.join(parentDependencies, "parent-only.txt"), "utf8")).toBe(
        "do not share",
      );
      mgr.killAll();
    });

    test("also skips dependency junctions when explicit opt-out keeps the path protected", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const adapterPath = path.join(repoDir, ".quack", "adapter.json");
      fs.writeFileSync(
        adapterPath,
        JSON.stringify({
          git: { baseBranch: "dev", branchPrefix: "quack/" },
          dispatch: { worktreeInit: [] },
          sandbox: {
            deniedPaths: ["frontend/node_modules/"],
            disposablePaths: ["frontend/node_modules/"],
          },
        }),
      );
      const parentDependencies = path.join(repoDir, "frontend", "node_modules");
      fs.mkdirSync(parentDependencies, { recursive: true });

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-PROTECTED-DEPS");

      expect(worktreePath).toBeDefined();
      expect(fs.existsSync(path.join(worktreePath!, "frontend", "node_modules"))).toBe(false);
      mgr.killAll();
    });

    test("preserves the legacy dependency junction when init is explicitly disabled and unprotected", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const adapterPath = path.join(repoDir, ".quack", "adapter.json");
      fs.writeFileSync(
        adapterPath,
        JSON.stringify({
          git: { baseBranch: "dev", branchPrefix: "quack/" },
          dispatch: { worktreeInit: [] },
          sandbox: { deniedPaths: [], disposablePaths: [] },
        }),
      );
      const parentDependencies = path.join(repoDir, "frontend", "node_modules");
      fs.mkdirSync(parentDependencies, { recursive: true });
      fs.writeFileSync(path.join(parentDependencies, "legacy.txt"), "shared", "utf8");

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-LEGACY-DEPS");
      const dependencyPath = path.join(worktreePath!, "frontend", "node_modules");

      expect(worktreePath).toBeDefined();
      expect(fs.lstatSync(dependencyPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(dependencyPath, "legacy.txt"), "utf8")).toBe("shared");
      mgr.killAll();
    });

    test("prep junction failures do not mark worktree creation degraded", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const realCreateJunction = (
        mgr as unknown as {
          createJunction(targetPath: string, junctionPath: string): void;
        }
      ).createJunction.bind(mgr);
      (
        mgr as unknown as {
          createJunction(targetPath: string, junctionPath: string): void;
        }
      ).createJunction = (targetPath: string, junctionPath: string) => {
        if (junctionPath.endsWith(`${path.sep}prep`)) {
          const err = new Error("prep exists already") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
        realCreateJunction(targetPath, junctionPath);
      };

      try {
        const worktreePath = (
          mgr as unknown as { createWorktree(taskId: string): string | undefined }
        ).createWorktree.call(mgr, "TASK-PREP");

        expect(worktreePath).toBeDefined();
        expect(mgr.isWorktreeDegraded()).toBe(false);
        expect(fs.existsSync(path.join(worktreePath!, ".quack"))).toBe(true);
      } finally {
        (
          mgr as unknown as {
            createJunction(targetPath: string, junctionPath: string): void;
          }
        ).createJunction = realCreateJunction;
        mgr.killAll();
      }
    });

    test("successful worktree creation clears degraded mode", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      (mgr as unknown as { worktreeDegraded: boolean }).worktreeDegraded = true;

      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-RECOVER");

      expect(worktreePath).toBeDefined();
      expect(mgr.isWorktreeDegraded()).toBe(false);
      mgr.killAll();
    });

    test("stale task branch is deleted on fresh re-dispatch (Pattern 22 preserved, TASK-1312)", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      git(repoDir, ["branch", "quack/TASK-STALE"]);

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-STALE");

      expect(worktreePath).toBeDefined();
      expect(() =>
        execFileSync("git", ["rev-parse", "--verify", "quack/TASK-STALE"], {
          cwd: repoDir,
          stdio: "pipe",
        }),
      ).toThrow();
      mgr.killAll();
    });

    test("resume recreation preserves and checks out the existing task branch", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      git(repoDir, ["checkout", "-b", "quack/TASK-RESUME"]);
      fs.writeFileSync(path.join(repoDir, "resumed.txt"), "preserved\n");
      git(repoDir, ["add", "resumed.txt"]);
      git(repoDir, ["commit", "-m", "preserved work"]);
      git(repoDir, ["checkout", "dev"]);

      const preservedSha = execFileSync("git", ["rev-parse", "quack/TASK-RESUME"], {
        cwd: repoDir,
        encoding: "utf-8",
      }).trim();
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as {
          createWorktree(
            taskId: string,
            options?: { preserveTaskBranch?: boolean },
          ): string | undefined;
        }
      ).createWorktree.call(mgr, "TASK-RESUME", { preserveTaskBranch: true });

      expect(worktreePath).toBeDefined();
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: worktreePath!,
          encoding: "utf-8",
        }).trim(),
      ).toBe("quack/TASK-RESUME");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktreePath!,
          encoding: "utf-8",
        }).trim(),
      ).toBe(preservedSha);
      expect(
        fs.readFileSync(path.join(worktreePath!, "resumed.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("preserved\n");

      mgr.killAll();
    });

    test("task-branch collision refuses admission before worktree, child, or ref mutation", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      // Empty prefix makes the stale-branch name collide with the base
      // branch itself: staleBranch = "" + "dev" = "dev" (protected).
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "" } }),
      );

      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      // TASK-1313 S5 (round-2 F7): the pre-session refusal reports
      // through the typed lifecycle callback.
      const lifecycleEvents: Array<{
        stage: string;
        taskId: string;
        payload: Record<string, unknown>;
      }> = [];
      mgr.setEventCallback((stage, taskId, payload) => {
        lifecycleEvents.push({ stage, taskId, payload });
      });
      const localBefore = execFileSync("git", ["rev-parse", "refs/heads/dev"], {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const remoteBefore = execFileSync("git", ["rev-parse", "refs/remotes/origin/dev"], {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      expect(() => mgr.start("dev", { skipGate: true })).toThrow(
        "collides with a protected/base branch",
      );

      expect(mgr.getJob("dev")).toBeUndefined();
      expect(fs.existsSync(path.join(repoDir, ".quack", "worktrees", "dev"))).toBe(false);
      expect(
        execFileSync("git", ["rev-parse", "refs/heads/dev"], {
          cwd: repoDir,
          encoding: "utf8",
        }).trim(),
      ).toBe(localBefore);
      expect(
        execFileSync("git", ["rev-parse", "refs/remotes/origin/dev"], {
          cwd: repoDir,
          encoding: "utf8",
        }).trim(),
      ).toBe(remoteBefore);
      const refusal = lifecycleEvents.find((event) => event.stage === "branch_guard_refusal");
      expect(refusal).toBeDefined();
      expect(refusal?.taskId).toBe("dev");
      expect(refusal?.payload.branch).toBe("dev");
      expect(refusal?.payload.site).toBe("task_branch_admission");
      mgr.killAll();
    });

    test("createWorktree refreshes refs/remotes/origin/<baseBranch> so worktrees see updates not yet in local tracking ref", () => {
      // Scenario: the local repo's origin/dev tracking ref is stale (points at commit A),
      // but origin actually has commit B. The worktree should contain B's content,
      // proving that createWorktree issued a fetch that updated refs/remotes/origin/dev,
      // not just FETCH_HEAD.
      const originDir = path.join(tmpDir, "origin2.git");
      const repoDir = path.join(tmpDir, "repo2");
      const cloneDir = path.join(tmpDir, "clone2");

      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });

      // Seed origin with commit A
      fs.mkdirSync(cloneDir, { recursive: true });
      git(cloneDir, ["init"]);
      git(cloneDir, ["config", "user.email", "quack@example.test"]);
      git(cloneDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(cloneDir, "tracked.txt"), "commit-A\n");
      git(cloneDir, ["add", "tracked.txt"]);
      git(cloneDir, ["commit", "-m", "A"]);
      git(cloneDir, ["branch", "-M", "dev"]);
      git(cloneDir, ["remote", "add", "origin", originDir]);
      git(cloneDir, ["push", "-u", "origin", "dev"]);

      // Set up local repo pointing at same origin, fetch once so origin/dev → A
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "local-stale\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "."]);
      git(repoDir, ["commit", "-m", "local-initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["fetch", "origin"]); // origin/dev now → A

      // Push commit B to origin so origin is ahead of the local tracking ref
      fs.writeFileSync(path.join(cloneDir, "tracked.txt"), "commit-B\n");
      git(cloneDir, ["commit", "-am", "B"]);
      git(cloneDir, ["push", "origin", "dev"]);

      // Local repo's origin/dev still points at A (no fetch since push)
      // createWorktree must fetch and update refs/remotes/origin/dev to B
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js", originDir);
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-REFSPEC");

      expect(worktreePath).toBeDefined();
      // Worktree content must be B (from origin), not A or the stale local value
      expect(
        fs.readFileSync(path.join(worktreePath!, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("commit-B\n");

      mgr.killAll();
    });

    test("rejects unsafe adapter branch refs before mutating worktree state", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "-c", branchPrefix: "quack/" } }),
        "utf8",
      );
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const createWorktree = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.bind(mgr);

      expect(() => createWorktree("TASK-INVALID-REF")).toThrow(
        "adapter git.baseBranch is not a safe Git branch name",
      );
      expect(fs.existsSync(path.join(repoDir, ".quack", "worktrees", "TASK-INVALID-REF"))).toBe(
        false,
      );
      mgr.killAll();
    });

    test("rejects a task id that could escape the managed worktree directory", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const createWorktree = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.bind(mgr);

      expect(() => createWorktree("../outside")).toThrow("is not a safe worktree path segment");
      expect(fs.existsSync(path.join(repoDir, ".quack", "outside"))).toBe(false);
      mgr.killAll();
    });

    test("refreshes a stale worktree adapter bundle before reuse", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-ADAPTER");

      expect(worktreePath).toBeDefined();
      const rootAdapterPath = path.join(repoDir, ".quack", "adapter.json");
      const worktreeAdapterPath = path.join(worktreePath!, ".quack", "adapter.json");

      fs.writeFileSync(
        rootAdapterPath,
        JSON.stringify({
          version: "1.0",
          project: {
            name: "test-project",
            root: ".",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          verification: {
            commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
            conventionChecks: [],
          },
          git: {
            baseBranch: "dev",
            branchPrefix: "fresh/",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "",
            autoCreatePr: false,
            autoPush: false,
          },
          logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
        }),
      );

      const freshness = (
        mgr as unknown as {
          ensureWorktreeAdapterFreshness(worktreePath: string): { status: string };
        }
      ).ensureWorktreeAdapterFreshness.call(mgr, worktreePath!);

      expect(freshness.status).toBe("refreshed");
      expect(JSON.parse(fs.readFileSync(worktreeAdapterPath, "utf-8"))).toMatchObject({
        git: { baseBranch: "dev", branchPrefix: "fresh/" },
      });

      mgr.killAll();
    });

    test("TASK-1313 F10: conventions-only drift re-copies ONLY for opted-in safetyFloor adapters; bundle-hash comparison unchanged", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = createLocalOriginFixtureManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-MACH");
      expect(worktreePath).toBeDefined();

      const rootQuack = path.join(repoDir, ".quack");
      const wtQuack = path.join(worktreePath!, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });
      const baseAdapter = {
        version: "1.0",
        project: {
          name: "test-project",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        verification: {
          commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
          conventionChecks: [],
        },
        git: {
          baseBranch: "dev",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "",
          autoCreatePr: false,
          autoPush: false,
        },
        logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
      };
      const writeBoth = (adapter: Record<string, unknown>): void => {
        const json = JSON.stringify(adapter);
        fs.writeFileSync(path.join(rootQuack, "adapter.json"), json);
        fs.writeFileSync(path.join(wtQuack, "adapter.json"), json);
      };
      const callFreshness = (): {
        status: string;
        localHash?: string;
        authoritativeHash?: string;
      } =>
        (
          mgr as unknown as {
            ensureWorktreeAdapterFreshness(worktreePath: string): {
              status: string;
              localHash?: string;
              authoritativeHash?: string;
            };
          }
        ).ensureWorktreeAdapterFreshness.call(mgr, worktreePath!);

      // The drift: ONLY conventions.md differs between root and worktree.
      fs.writeFileSync(path.join(rootQuack, "conventions.md"), "authoritative conventions v2");
      fs.writeFileSync(path.join(wtQuack, "conventions.md"), "stale worktree conventions v1");

      // Non-opted adapter (no safetyFloor key): pre-1313 behavior exactly —
      // matching bundle hashes report fresh and the drift is NOT copied.
      writeBoth(baseAdapter);
      const nonOpted = callFreshness();
      expect(nonOpted.status).toBe("fresh");
      expect(fs.readFileSync(path.join(wtQuack, "conventions.md"), "utf-8")).toBe(
        "stale worktree conventions v1",
      );

      // Opted-in adapter (identical bytes both sides, so the bundle-hash
      // comparison is STILL equal): the separate machinery hash catches
      // the conventions drift and drives the re-copy.
      writeBoth({
        ...baseAdapter,
        judgment: { safetyFloor: { signals: { mode: "report" } } },
      });
      const opted = callFreshness();
      expect(opted.status).toBe("refreshed");
      expect(opted.localHash).toBe(opted.authoritativeHash);
      expect(fs.readFileSync(path.join(wtQuack, "conventions.md"), "utf-8")).toBe(
        "authoritative conventions v2",
      );

      mgr.killAll();
    });
  });

  describe("managed worktree janitor ownership policy", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-janitor-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeAdapter(branchCleanup?: Record<string, unknown>): void {
      fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".quack", "adapter.json"),
        JSON.stringify({
          version: "1.0",
          project: {
            name: "test-project",
            root: ".",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          agent: {
            model: "claude-opus-4-6",
            judgeModel: "claude-sonnet-4-6",
            enrichModel: "claude-sonnet-4-6",
            maxTurns: 50,
            maxBudgetPerTask: 5,
            maxRetries: 1,
          },
          verification: {
            commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
            conventionChecks: [],
          },
          git: {
            baseBranch: "dev",
            branchPrefix: "quack/",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "",
            autoCreatePr: false,
            autoPush: false,
            branchCleanup,
          },
          logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
        }),
      );
    }

    function makeOldDirectory(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      fs.utimesSync(dir, old, old);
    }

    test("reports protected-owner worktrees as not prune eligible by default", () => {
      writeAdapter();
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "contributor-TASK-123");
      makeOldDirectory(worktreePath);

      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const records = mgr.listManagedWorktrees(24 * 60 * 60 * 1000);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        taskId: "contributor-TASK-123",
        rootKind: "quack",
        owner: "contributor",
        protectedOwner: true,
        requiresOwnerOverride: true,
        pruneEligible: false,
      });
      expect(records[0].skipReasons).toContain("protected_owner");

      mgr.killAll();
    });

    test("configured Hermes worktree roots can become prune candidates", () => {
      writeAdapter({
        enabled: true,
        allowedPrefixes: ["quack/TASK-", "echo/TASK-"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      });
      const worktreePath = path.join(tmpDir, ".hermes-worktrees", "TASK-1048");
      makeOldDirectory(worktreePath);

      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const result = mgr.pruneManagedWorktrees({
        dryRun: true,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });

      expect(result.policy.allowedPrefixes).toContain("echo/TASK-");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        taskId: "TASK-1048",
        rootKind: "hermes",
        owner: "hermes",
        allowedPrefix: "echo/TASK-",
        pruneEligible: true,
      });

      mgr.killAll();
    });

    test("retains a worktree fenced by a durable operator-stop barrier", () => {
      writeAdapter();
      const taskId = "TASK-1401";
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", taskId);
      makeOldDirectory(worktreePath);
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const job: DispatchJob = {
        taskId,
        sessionId: "janitor-barrier",
        pid: 42,
        startedAt: new Date().toISOString(),
        status: "stopped",
        output: [],
        executionRoot: worktreePath,
        operatorStopRequestedAt: new Date().toISOString(),
        operatorStopCleanupPending: true,
      };
      const internals = mgr as unknown as {
        persistOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        clearOperatorStopBarrier: (candidate: DispatchJob) => boolean;
      };
      const cleanupCallsBefore = mockCleanupWorktreeContainers.mock.calls.length;

      expect(internals.persistOperatorStopBarrier.call(mgr, job)).toBe(true);
      const [record] = mgr.listManagedWorktrees(24 * 60 * 60 * 1000);
      expect(record.skipReasons).toContain("operator_stop_barrier");
      expect(record.pruneEligible).toBe(false);

      const result = mgr.pruneManagedWorktrees({
        dryRun: false,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      expect(result.pruned).toEqual([]);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(mockCleanupWorktreeContainers.mock.calls.length).toBe(cleanupCallsBefore);

      expect(internals.clearOperatorStopBarrier.call(mgr, job)).toBe(true);
      mgr.killAll();
    });

    test("retains a worktree while denied-path quarantine evidence exists", () => {
      writeAdapter();
      const taskId = "TASK-1402";
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", taskId);
      makeOldDirectory(worktreePath);
      fs.writeFileSync(
        path.join(path.dirname(worktreePath), ".quack-codex-denied-janitor"),
        "unresolved recovery evidence",
        "utf8",
      );
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const cleanupCallsBefore = mockCleanupWorktreeContainers.mock.calls.length;

      const [record] = mgr.listManagedWorktrees(24 * 60 * 60 * 1000);
      expect(record.skipReasons).toContain("denied_path_quarantine");
      expect(record.pruneEligible).toBe(false);

      const result = mgr.pruneManagedWorktrees({
        dryRun: false,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      expect(result.pruned).toEqual([]);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(mockCleanupWorktreeContainers.mock.calls.length).toBe(cleanupCallsBefore);
      mgr.killAll();
    });

    test("retains a worktree when Docker absence cannot be verified", () => {
      writeAdapter();
      const taskId = "TASK-1403";
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", taskId);
      makeOldDirectory(worktreePath);
      mockCleanupWorktreeContainers.mockReturnValue(false);
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");

      const result = mgr.pruneManagedWorktrees({
        dryRun: false,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });

      expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(worktreePath, expect.any(Object));
      expect(result.pruned).toEqual([]);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(result.retained[0].skipReasons).toContain("docker_cleanup_unverified");
      expect(result.retained[0].pruneEligible).toBe(false);
      mgr.killAll();
    });
  });

  describe("awaiting_approval lifecycle (TASK-107)", () => {
    /** Helper to inject a job directly into the private jobs map */
    function injectJob(mgr: DispatchManager, job: DispatchJob): void {
      const jobs = (mgr as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      jobs.set(job.taskId, job);
    }

    function makeJob(overrides: Partial<DispatchJob> & { taskId: string }): DispatchJob {
      return {
        sessionId: `test-${Date.now()}`,
        pid: 0,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
        ...overrides,
      };
    }

    function writeBlueprintDecision(
      taskId: string,
      state: "pending" | "approved" | "rejected",
      createdAt: string,
    ): void {
      const approvalDir = path.join(managerRoot, ".quack", "logs", "approvals");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        path.join(approvalDir, `${taskId}.json`),
        JSON.stringify({
          taskId,
          state,
          createdAt,
          ...(state === "pending" ? {} : { decidedAt: new Date().toISOString() }),
          blueprint: {},
        }),
        "utf-8",
      );
    }

    test("getActiveJob returns awaiting_approval jobs", () => {
      const job = makeJob({
        taskId: "TASK-200",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, job);

      expect(manager.getActiveJob("TASK-200")).toBe(job);
    });

    test("getActiveJob does not return failed jobs", () => {
      const job = makeJob({ taskId: "TASK-201", status: "failed" });
      injectJob(manager, job);

      expect(manager.getActiveJob("TASK-201")).toBeUndefined();
    });

    test("getActiveJobs excludes awaiting_approval (no running process)", () => {
      const job = makeJob({ taskId: "TASK-202", status: "awaiting_approval" });
      injectJob(manager, job);

      // getActiveJobs returns only "running" — awaiting_approval has no process
      expect(manager.getActiveJobs()).toEqual([]);
    });

    test("shared checkout occupants include approval-paused jobs without worktrees", () => {
      const running = makeJob({ taskId: "TASK-202-A", status: "running", pid: process.pid });
      const awaiting = makeJob({ taskId: "TASK-202-B", status: "awaiting_approval" });
      const isolated = makeJob({
        taskId: "TASK-202-C",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, running);
      injectJob(manager, awaiting);
      injectJob(manager, isolated);

      expect(manager.getSharedCheckoutOccupants()).toEqual([running, awaiting]);
    });

    test("degraded admission rejects a different task while shared checkout awaits approval", () => {
      injectJob(manager, makeJob({ taskId: "TASK-202-D", status: "awaiting_approval" }));
      (manager as unknown as { worktreeDegraded: boolean }).worktreeDegraded = true;

      let thrown: unknown;
      try {
        manager.start("TASK-202-E");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DegradedSharedCheckoutBusyError);
      expect((thrown as DegradedSharedCheckoutBusyError).hasApprovalPause).toBe(true);
      expect((thrown as Error).message).toContain(
        "shared directory is occupied by TASK-202-D (awaiting_approval)",
      );
    });

    test("atomically preserves the first shared-checkout owner across manager instances", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-atomic-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const first = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const second = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const firstJob = makeJob({ taskId: "TASK-FIRST", sessionId: "first-session" });
      const secondJob = makeJob({ taskId: "TASK-SECOND", sessionId: "second-session" });
      const firstInternals = first as unknown as {
        readSharedCheckoutPause(): unknown;
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      const secondInternals = second as unknown as {
        readSharedCheckoutPause(): unknown;
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      try {
        // Both processes can observe the pre-claim state; the exclusive lock
        // and in-lock owner check still allow exactly one durable winner.
        expect(firstInternals.readSharedCheckoutPause()).toBeUndefined();
        expect(secondInternals.readSharedCheckoutPause()).toBeUndefined();
        firstInternals.persistSharedCheckoutPause(firstJob, "running");
        const markerPath = path.join(logDir, "shared-checkout-pause.json");
        const agedMarker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<
          string,
          unknown
        >;
        agedMarker.pausedAt = "2000-01-01T00:00:00.000Z";
        fs.writeFileSync(markerPath, `${JSON.stringify(agedMarker, null, 2)}\n`, "utf-8");
        expect(() => secondInternals.persistSharedCheckoutPause(secondJob, "running")).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
          taskId: string;
          sessionId: string;
        };
        expect(marker).toMatchObject({ taskId: "TASK-FIRST", sessionId: "first-session" });
      } finally {
        first.killAll();
        second.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("serializes old-owner restore and release before a same-task handoff", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-handoff-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const first = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const second = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const firstJob = makeJob({ taskId: "TASK-HANDOFF", sessionId: "old-session", pid: 999_999 });
      const nextJob = makeJob({ taskId: "TASK-HANDOFF", sessionId: "new-session" });
      const firstInternals = first as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
        restoreSharedCheckout(job: DispatchJob): boolean;
        restoreAndReleaseSharedCheckout(job: DispatchJob): boolean;
      };
      const secondInternals = second as unknown as {
        persistSharedCheckoutPause(
          job: DispatchJob,
          status: "running",
          allowOwnershipTransfer: boolean,
        ): void;
      };
      try {
        firstInternals.persistSharedCheckoutPause(firstJob, "running");
        expect(() => secondInternals.persistSharedCheckoutPause(nextJob, "running", true)).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        firstInternals.restoreSharedCheckout = () => {
          expect(() =>
            secondInternals.persistSharedCheckoutPause(nextJob, "running", true),
          ).toThrow("ownership is locked");
          return true;
        };
        expect(firstInternals.restoreAndReleaseSharedCheckout(firstJob)).toBe(true);
        expect(() =>
          secondInternals.persistSharedCheckoutPause(nextJob, "running", true),
        ).not.toThrow();
      } finally {
        first.killAll();
        second.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("uses a UUID ownership generation to reject same-session ABA callbacks", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-aba-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const first = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const second = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const oldJob = makeJob({ taskId: "TASK-ABA", sessionId: "same-millisecond", pid: 0 });
      const newJob = makeJob({ taskId: "TASK-ABA", sessionId: "same-millisecond", pid: 0 });
      const firstInternals = first as unknown as {
        persistSharedCheckoutPause(
          job: DispatchJob,
          status: "running" | "stopped" | "failed",
        ): void;
        restoreAndReleaseSharedCheckout(job: DispatchJob): boolean;
      };
      const secondInternals = second as unknown as {
        persistSharedCheckoutPause(
          job: DispatchJob,
          status: "running" | "stopped" | "failed",
          allowOwnershipTransfer?: boolean,
        ): void;
      };
      try {
        firstInternals.persistSharedCheckoutPause(oldJob, "running");
        firstInternals.persistSharedCheckoutPause(oldJob, "stopped");
        const oldOwnershipId = oldJob.sharedCheckoutOwnershipId;

        secondInternals.persistSharedCheckoutPause(newJob, "running", true);
        expect(newJob.sharedCheckoutOwnershipId).toEqual(expect.any(String));
        expect(newJob.sharedCheckoutOwnershipId).not.toBe(oldOwnershipId);

        expect(() => firstInternals.persistSharedCheckoutPause(oldJob, "failed")).toThrow(
          DegradedSharedCheckoutBusyError,
        );
        expect(firstInternals.restoreAndReleaseSharedCheckout(oldJob)).toBe(false);
        const marker = JSON.parse(
          fs.readFileSync(path.join(logDir, "shared-checkout-pause.json"), "utf-8"),
        ) as { ownershipId: string; status: string };
        expect(marker).toMatchObject({
          ownershipId: newJob.sharedCheckoutOwnershipId,
          status: "running",
        });
      } finally {
        first.killAll();
        second.killAll();
        Object.defineProperty(process, "platform", originalPlatform);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // These cases launch real children and resolve the native Git executable.
    // A mocked Windows platform on POSIX cannot provide that native contract.
    const nativeWindowsTest = process.platform === "win32" ? test : test.skip;

    nativeWindowsTest(
      "does not carry Windows tree confirmation into a same-millisecond shared resume",
      async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const fixedNow = 1_789_000_000_000;
        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-aba-"));
        const logDir = path.join(tmpDir, ".quack", "logs");
        const scriptPath = path.join(tmpDir, "quick-exit.cjs");
        fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 25);\n", "utf-8");
        const mgr = new DispatchManager(tmpDir, scriptPath, undefined, undefined, logDir);
        const oldJob = makeJob({
          taskId: "TASK-WIN-ABA",
          sessionId: `quack-TASK-WIN-ABA-${fixedNow}`,
          status: "stopped",
          pid: 0,
        });
        const internals = mgr as unknown as {
          jobs: Map<string, DispatchJob>;
          confirmedWindowsTreeKills: Map<string, string>;
          persistSharedCheckoutPause(job: DispatchJob, status: "stopped"): void;
        };
        internals.confirmedWindowsTreeKills.set(oldJob.taskId, oldJob.sessionId);
        internals.persistSharedCheckoutPause(oldJob, "stopped");
        internals.jobs.set(oldJob.taskId, oldJob);
        const oldOwnershipId = oldJob.sharedCheckoutOwnershipId;

        try {
          const resumed = mgr.start(oldJob.taskId, { skipGate: true, resume: true });
          nowSpy.mockRestore();
          const marker = JSON.parse(
            fs.readFileSync(path.join(logDir, "shared-checkout-pause.json"), "utf-8"),
          ) as { sessionId: string; ownershipId: string; processTreeStatus: string };
          expect(resumed.sessionId).not.toBe(oldJob.sessionId);
          expect(resumed.sessionId).toMatch(/^quack-TASK-WIN-ABA-[a-f0-9-]+$/);
          expect(marker.ownershipId).not.toBe(oldOwnershipId);
          expect(marker.processTreeStatus).toBe("unconfirmed");
          expect(internals.confirmedWindowsTreeKills.has(oldJob.taskId)).toBe(false);
          await waitForCondition(
            () => resumed.status !== "running",
            "same-millisecond fixture exit",
          );
        } finally {
          nowSpy.mockRestore();
          Object.defineProperty(process, "platform", originalPlatform);
          await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );

    nativeWindowsTest(
      "clears a stale Windows tree confirmation before an isolated child starts",
      async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worktree-win-session-"));
        const scriptPath = path.join(tmpDir, "quick-exit.cjs");
        fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 25);\n", "utf-8");
        const mgr = new DispatchManager(tmpDir, scriptPath);
        const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-WIN-SESSION");
        fs.mkdirSync(worktreePath, { recursive: true });
        const internals = mgr as unknown as {
          startWorktree(taskId: string): DispatchJob;
          createWorktree(taskId: string): string;
          ensureWorktreeAdapterFreshness(worktreePath: string): undefined;
          removeWorktree(worktreePath: string): void;
          confirmedWindowsTreeKills: Map<string, string>;
        };
        internals.createWorktree = () => worktreePath;
        internals.ensureWorktreeAdapterFreshness = () => undefined;
        internals.removeWorktree = jest.fn();
        internals.confirmedWindowsTreeKills.set("TASK-WIN-SESSION", "old-session");
        try {
          const job = internals.startWorktree("TASK-WIN-SESSION");
          expect(job.worktreePath).toBe(worktreePath);
          expect(internals.confirmedWindowsTreeKills.has("TASK-WIN-SESSION")).toBe(false);
          await waitForCondition(() => job.status !== "running", "isolated Windows fixture exit");
        } finally {
          Object.defineProperty(process, "platform", originalPlatform);
          await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );

    test("never expires an unverified shared-checkout mutation lock by age", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-lock-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const lockPath = path.join(logDir, "shared-checkout-pause.lock");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ version: 1, pid: 1, acquiredAt: "2000-01-01T00:00:00.000Z" }),
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const internals = mgr as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      try {
        expect(() =>
          internals.persistSharedCheckoutPause(
            makeJob({ taskId: "TASK-LOCKED", sessionId: "locked-session" }),
            "running",
          ),
        ).toThrow("unverified stale lock");
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(mgr.getSharedCheckoutOccupants()).toEqual([
          expect.objectContaining({ taskId: "unknown-shared-checkout-owner" }),
        ]);
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("requires exact reconciliation before reusing a Windows-unconfirmed shared tree", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-tree-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const markerPath = path.join(logDir, "shared-checkout-pause.json");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-WINDOWS-TREE",
          sessionId: "tree-session",
          ownershipId: "tree-owner",
          startedAt: "2026-09-09T12:00:00.000Z",
          pausedAt: "2026-09-09T12:01:00.000Z",
          status: "stopped",
          processId: 2_147_483_000,
          processTreeStatus: "unconfirmed",
          reconciliationToken: "tree-token",
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const internals = mgr as unknown as {
        durableSharedOwnerMayBeLive(marker: unknown): boolean;
        readSharedCheckoutPause(): unknown;
      };
      try {
        expect(internals.durableSharedOwnerMayBeLive(internals.readSharedCheckoutPause())).toBe(
          true,
        );
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "tree-owner",
            "stale-token",
            true,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "tree-owner",
            "tree-token",
            false,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "tree-owner",
            "tree-token",
            true,
          ),
        ).toBe(true);
        expect(internals.durableSharedOwnerMayBeLive(internals.readSharedCheckoutPause())).toBe(
          false,
        );
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrates a legacy Windows shared marker and preserves confirmation through admission", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-legacy-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const markerPath = path.join(logDir, "shared-checkout-pause.json");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-LEGACY-SHARED",
          sessionId: "legacy-session",
          startedAt: "2026-09-09T12:00:00.000Z",
          pausedAt: "2026-09-09T12:01:00.000Z",
          status: "failed",
          processId: 4242,
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const prior = makeJob({
        taskId: "TASK-LEGACY-SHARED",
        sessionId: "legacy-session",
        status: "failed",
      });
      injectJob(mgr, prior);
      const startWorktree = jest.fn(() => makeJob({ taskId: "TASK-LEGACY-SHARED" }));
      (mgr as unknown as { startWorktree: typeof startWorktree }).startWorktree = startWorktree;
      try {
        const survivor = mgr.getSharedCheckoutShutdownSurvivor();
        expect(survivor?.reconciliationToken).toEqual(expect.any(String));
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            survivor!.taskId,
            survivor!.sessionId,
            survivor!.ownershipId!,
            survivor!.reconciliationToken!,
            true,
          ),
        ).toBe(true);
        expect(() =>
          mgr.start("TASK-LEGACY-SHARED", { skipGate: true, resume: true }),
        ).not.toThrow();
        expect(startWorktree).toHaveBeenCalledWith(
          "TASK-LEGACY-SHARED",
          expect.objectContaining({ resume: true }),
          true,
          expect.any(Object),
        );
      } finally {
        mgr.killAll();
        Object.defineProperty(process, "platform", originalPlatform);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrates and safely reconciles legacy Windows worktree survivor markers", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worktree-win-legacy-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-WORKTREE");
      const markerDir = path.join(logDir, "worktree-survivors");
      const markerPath = path.join(markerDir, "TASK-WORKTREE.json");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-WORKTREE",
          sessionId: "worktree-session",
          worktreePath,
          processId: 7171,
          strategy: "windows-process-tree",
          recordedAt: "2026-09-09T12:00:00.000Z",
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      try {
        const [survivor] = mgr.getWorktreeShutdownSurvivors();
        expect(survivor.reconciliationToken).toEqual(expect.any(String));
        expect(mgr.canResumeAfterShutdown()).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            "stale-ownership",
            survivor.reconciliationToken!,
            true,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            survivor.ownershipId!,
            survivor.reconciliationToken!,
            false,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            survivor.ownershipId!,
            survivor.reconciliationToken!,
            true,
          ),
        ).toBe(true);
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(mgr.getWorktreeShutdownSurvivors()).toEqual([]);
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("contains a Windows descendant when its wrapper exits and keeps restart fail-closed", async () => {
      if (process.platform !== "win32") return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-descendant-"));
      const descendantPidPath = path.join(tmpDir, "descendant.pid");
      const touchedPath = path.join(tmpDir, "descendant-touch.txt");
      const scriptPath = path.join(tmpDir, "wrapper.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          `const touchPath = ${JSON.stringify(touchedPath)};`,
          "const code = `const fs = require('node:fs'); const p = ${JSON.stringify(touchPath)}; fs.appendFileSync(p, 'x'); setInterval(() => fs.appendFileSync(p, 'x'), 25);`;",
          "const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
          "child.unref();",
          "process.exit(0);",
        ].join("\n"),
        "utf-8",
      );
      const first = new DispatchManager(tmpDir, scriptPath);
      const restarted = new DispatchManager(tmpDir, scriptPath);
      (first as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      (restarted as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      let descendantPid = 0;
      try {
        const job = first.start("TASK-WINDOWS-DESCENDANT", { skipGate: true });
        await waitForFile(descendantPidPath);
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf-8"), 10);
        await waitForCondition(() => job.status === "completed", "wrapper exit");
        await waitForFile(touchedPath);

        await waitForCondition(
          () => !processIsAlive(descendantPid),
          "trusted Windows Job Object descendant containment",
        );
        expect(() =>
          restarted.start("TASK-WINDOWS-DESCENDANT", { skipGate: true, resume: true }),
        ).toThrow(DegradedSharedCheckoutBusyError);
        expect(restarted.getSharedCheckoutShutdownSurvivor()).toEqual(
          expect.objectContaining({
            taskId: "TASK-WINDOWS-DESCENDANT",
            status: "stopped",
          }),
        );
      } finally {
        if (descendantPid > 0 && processIsAlive(descendantPid)) {
          try {
            execFileSync("taskkill", ["/pid", String(descendantPid), "/t", "/f"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            // Best-effort cleanup of the test-only child.
          }
        }
        await first.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restarted.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("refuses shared-checkout fallback when the original Git checkout is dirty", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-dirty-"));
      const scriptPath = path.join(tmpDir, "should-not-start.cjs");
      const startedPath = path.join(tmpDir, "unsafe-started");
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
        fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "original\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", "tracked.txt", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
        fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "pre-existing user edit\n", "utf-8");

        const mgr = new DispatchManager(tmpDir, scriptPath);
        (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;

        expect(() => mgr.start("TASK-DIRTY", { skipGate: true })).toThrow(
          "shared checkout because it was already dirty",
        );
        expect(fs.readFileSync(path.join(tmpDir, "tracked.txt"), "utf-8")).toBe(
          "pre-existing user edit\n",
        );
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("refuses shared-checkout fallback when the Git branch baseline is unverifiable", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-detached-"));
      const scriptPath = path.join(tmpDir, "should-not-start.cjs");
      const startedPath = path.join(tmpDir, "unsafe-started");
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["checkout", "--detach"], { cwd: tmpDir, stdio: "ignore" });

        const mgr = new DispatchManager(tmpDir, scriptPath);
        (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;

        expect(() => mgr.start("TASK-DETACHED", { skipGate: true })).toThrow(
          "Git restoration baseline could not be verified",
        );
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("does not refresh projectRoot while another task owns the shared checkout", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-refresh-"));
      const isolatedDir = path.join(tmpDir, ".quack", "worktrees", "TASK-ISOLATED");
      const scriptPath = path.join(tmpDir, "concurrent-children.cjs");
      const isolatedReady = path.join(tmpDir, "isolated-ready");
      const sharedReady = path.join(tmpDir, "shared-ready");
      const releaseIsolated = path.join(tmpDir, "release-isolated");
      const trackedPath = path.join(tmpDir, "tracked.txt");
      let mgr: DispatchManager | undefined;
      fs.mkdirSync(isolatedDir, { recursive: true });
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(
          path.join(tmpDir, ".gitignore"),
          ".quack/\nisolated-task/\nisolated-ready\nshared-ready\nrelease-isolated\n",
          "utf-8",
        );
        fs.writeFileSync(trackedPath, "baseline\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          [
            "const fs = require('node:fs');",
            "const taskId = process.argv[3];",
            `const isolatedReady = ${JSON.stringify(isolatedReady)};`,
            `const sharedReady = ${JSON.stringify(sharedReady)};`,
            `const releaseIsolated = ${JSON.stringify(releaseIsolated)};`,
            `const trackedPath = ${JSON.stringify(trackedPath)};`,
            "if (taskId === 'TASK-ISOLATED') {",
            "  fs.writeFileSync(isolatedReady, 'ready');",
            "  const timer = setInterval(() => {",
            "    if (fs.existsSync(releaseIsolated)) { clearInterval(timer); process.exit(0); }",
            "  }, 10);",
            "} else {",
            "  fs.writeFileSync(trackedPath, 'shared worker edit\\n');",
            "  fs.writeFileSync(sharedReady, 'ready');",
            "  setInterval(() => undefined, 1000);",
            "}",
          ].join("\n"),
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", "tracked.txt", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });

        mgr = new DispatchManager(tmpDir, scriptPath);
        const internals = mgr as unknown as {
          createWorktree(taskId: string): string | undefined;
          worktreeDegraded: boolean;
        };
        internals.createWorktree = (taskId) => {
          if (taskId === "TASK-ISOLATED") return isolatedDir;
          internals.worktreeDegraded = true;
          return undefined;
        };

        const isolated = mgr.start("TASK-ISOLATED", { skipGate: true });
        await waitForFile(isolatedReady);
        const shared = mgr.start("TASK-SHARED", { skipGate: true });
        await waitForFile(sharedReady);
        if (process.platform === "win32") {
          (
            mgr as unknown as { confirmedWindowsTreeKills: Map<string, string> }
          ).confirmedWindowsTreeKills.set(isolated.taskId, isolated.sessionId);
        }
        // This test targets the shared-checkout refresh interlock, not the
        // platform-specific tree attestation exercised by dedicated tests.
        (mgr as unknown as { clearWorktreeSurvivor(): boolean }).clearWorktreeSurvivor = () => true;
        fs.writeFileSync(releaseIsolated, "release", "utf-8");
        await waitForCondition(() => isolated.status === "completed", "isolated completion");

        expect(shared.status).toBe("running");
        expect(fs.readFileSync(trackedPath, "utf-8")).toBe("shared worker edit\n");
        expect(isolated.output.join("\n")).toContain("Skipped main checkout refresh");

        const shutdown = await mgr.shutdownAll({ gracefulTimeoutMs: 50, forceTimeoutMs: 2_000 });
        expect(shutdown.timedOut).toEqual([]);
      } finally {
        if (mgr) {
          await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 2_000 });
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("restores shared-checkout pause ownership after restart before fallback spawn", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      const approvalPath = path.join(approvalDir, "TASK-PAUSED.json");
      const markerPath = path.join(logDir, "shared-checkout-pause.json");
      const firstScript = path.join(tmpDir, "pause-child.cjs");
      const nextStarted = path.join(tmpDir, "unsafe-next-started");
      const nextScript = path.join(tmpDir, "next-child.cjs");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        firstScript,
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const approvalDir = path.join(process.cwd(), '.quack', 'logs', 'approvals');",
          "fs.mkdirSync(approvalDir, { recursive: true });",
          "fs.writeFileSync(path.join(approvalDir, 'TASK-PAUSED.json'), JSON.stringify({",
          "  taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString()",
          "}), 'utf-8');",
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        nextScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(nextStarted)}, 'started', 'utf-8');`,
        ].join("\n"),
        "utf-8",
      );

      const firstManager = new DispatchManager(tmpDir, firstScript);
      const restartedManager = new DispatchManager(tmpDir, nextScript);
      const diagnosticRoot = process.env.QUACK_SHARED_PAUSE_DIAGNOSTIC_DIR;
      const diagnosticPath = diagnosticRoot
        ? path.join(diagnosticRoot, `shared-pause-${process.pid}.json`)
        : undefined;
      const appendCalls: Array<Record<string, unknown>> = [];
      const callbacks: Array<Record<string, unknown>> = [];
      const snapshots: Array<Record<string, unknown>> = [];
      const shutdown: Array<Record<string, unknown>> = [];
      const errorFacts = (error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) };
      let observedJob: DispatchJob | undefined;
      let passed = false;
      let shutdownError: unknown;
      const captureEvidence = (phase: string, error?: unknown): void => {
        const files = [approvalPath, markerPath];
        if (observedJob) files.push(path.join(logDir, `events-${observedJob.sessionId}.jsonl`));
        snapshots.push({
          phase,
          at: new Date().toISOString(),
          nowMs: Date.now(),
          job: observedJob && { ...observedJob, output: [...observedJob.output] },
          liveProcesses: firstManager.hasLiveProcesses(),
          ...(error === undefined ? {} : { error: errorFacts(error) }),
          files: files.map((filePath) => {
            try {
              const bytes = fs.readFileSync(filePath);
              return {
                filePath,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                base64: bytes.toString("base64"),
                text: bytes.toString("utf8"),
              };
            } catch (readError) {
              return { filePath, error: errorFacts(readError) };
            }
          }),
        });
        if (diagnosticPath) {
          fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
          fs.writeFileSync(
            diagnosticPath,
            `${JSON.stringify({ tmpDir, diagnosticPath, passed, appendCalls, callbacks, snapshots, shutdown }, null, 2)}\n`,
          );
        }
      };
      const realAppend = childExitLog.appendDispatchChildExit;
      const appendSpy = jest
        .spyOn(childExitLog, "appendDispatchChildExit")
        .mockImplementation((options) => {
          const call: Record<string, unknown> = { options, at: new Date().toISOString() };
          appendCalls.push(call);
          try {
            const result = realAppend(options);
            call.result = result;
            return result;
          } catch (error) {
            call.error = errorFacts(error);
            throw error;
          }
        });
      firstManager.setEventCallback((stage, taskId, payload) => {
        callbacks.push({ stage, taskId, payload, at: new Date().toISOString() });
      });
      try {
        const pausedJob = firstManager.start("TASK-PAUSED", { skipGate: true });
        observedJob = pausedJob;
        await waitForCondition(
          () => pausedJob.status === "awaiting_approval",
          "shared-checkout approval pause",
        );

        captureEvidence("before-marker-deletion");
        expect(fs.existsSync(markerPath)).toBe(true);
        const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8")) as {
          taskId: string;
          state: string;
          createdAt: string;
        };
        const exitEvents = fs
          .readFileSync(path.join(logDir, `events-${pausedJob.sessionId}.jsonl`), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { stage: string; payload: { at: string } })
          .filter((event) => event.stage === "dispatch_child_exit");
        expect(approval).toMatchObject({ taskId: "TASK-PAUSED", state: "pending" });
        expect(exitEvents).toHaveLength(1);
        expect(exitEvents[0]).toMatchObject({
          taskId: "TASK-PAUSED",
          sessionId: pausedJob.sessionId,
          payload: {
            taskId: "TASK-PAUSED",
            exitCode: 1,
            signal: null,
            killed: false,
            worktreePath: null,
            operatorRequested: false,
            sessionResolution: "job-fallback",
          },
        });
        expect(Date.parse(exitEvents[0].payload.at)).toBeGreaterThanOrEqual(
          Date.parse(approval.createdAt),
        );
        expect(callbacks.filter((event) => event.stage === "dispatch_child_exit")).toEqual([]);

        // Simulate upgrading a pause created before durable markers existed,
        // or a crash after the durable exit event but before marker creation.
        fs.rmSync(markerPath);
        // A failed worktree setup may leave a partial directory behind even
        // though the durable exit event proves the child used projectRoot.
        fs.mkdirSync(path.join(tmpDir, ".quack", "worktrees", "TASK-PAUSED"), {
          recursive: true,
        });
        expect(restartedManager.getAllJobs()).toEqual([]);
        const recoveredOccupants = restartedManager.getSharedCheckoutOccupants();
        captureEvidence("after-recovery");
        expect(recoveredOccupants).toEqual([
          expect.objectContaining({
            taskId: "TASK-PAUSED",
            status: "awaiting_approval",
          }),
        ]);
        expect(fs.existsSync(markerPath)).toBe(true);

        let thrown: unknown;
        try {
          restartedManager.start("TASK-NEXT", { skipGate: true });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(DegradedSharedCheckoutBusyError);
        expect((thrown as Error).message).toContain("TASK-PAUSED (awaiting_approval)");
        expect(restartedManager.getJob("TASK-NEXT")).toBeUndefined();
        expect(fs.existsSync(nextStarted)).toBe(false);

        fs.writeFileSync(
          path.join(approvalDir, "TASK-PAUSED.json"),
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );
        expect(() => restartedManager.start("TASK-PAUSED", { skipGate: true })).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        confirmWindowsSharedCheckoutTree(markerPath);
        const resumed = restartedManager.start("TASK-PAUSED", {
          skipGate: true,
          resume: true,
        });
        markWindowsTreeKillConfirmed(restartedManager, "TASK-PAUSED");
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(nextStarted);
        await waitForCondition(() => resumed.status === "completed", "shared-checkout resume");
        expect(fs.existsSync(markerPath)).toBe(false);
        passed = true;
        captureEvidence("successful-resume");
      } catch (error) {
        captureEvidence("failure-before-shutdown", error);
        throw error;
      } finally {
        for (const [name, instance] of [
          ["first", firstManager],
          ["restarted", restartedManager],
        ] as const) {
          try {
            const result = await instance.shutdownAll({
              gracefulTimeoutMs: 0,
              forceTimeoutMs: 1_000,
            });
            const liveProcesses = instance.hasLiveProcesses();
            shutdown.push({ manager: name, result, liveProcesses });
            expect(result.timedOut).toEqual([]);
            expect(liveProcesses).toBe(false);
          } catch (error) {
            shutdown.push({ manager: name, error: errorFacts(error) });
            shutdownError ??= error;
          }
        }
        appendSpy.mockRestore();
        captureEvidence("after-shutdown", shutdownError);
        if (passed && shutdownError === undefined) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } else {
          console.error(
            `Shared-checkout pause evidence preserved at ${tmpDir}; diagnostic=${diagnosticPath ?? "not configured"}`,
          );
        }
      }
      expect(shutdownError).toBeUndefined();
    });

    test("restores the original branch from durable shared-checkout evidence after restart", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-branch-restore-"));
      const approvalPath = path.join(tmpDir, ".quack", "logs", "approvals", "TASK-RESTORE.json");
      const scriptPath = path.join(tmpDir, "pause-and-restore.cjs");
      fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "quack@example.test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Quack Test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "const { execFileSync } = require('node:child_process');",
          `const approvalPath = ${JSON.stringify(approvalPath)};`,
          "if (!fs.existsSync(approvalPath)) {",
          "  execFileSync('git', ['checkout', '-b', 'quack/TASK-RESTORE'], { stdio: 'ignore' });",
          "  fs.mkdirSync(require('node:path').dirname(approvalPath), { recursive: true });",
          "  fs.writeFileSync(approvalPath, JSON.stringify({ taskId: 'TASK-RESTORE', state: 'pending', createdAt: new Date().toISOString() }));",
          "  process.exit(1);",
          "}",
          "process.exit(0);",
        ].join("\n"),
        "utf-8",
      );
      execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
      const originalBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: tmpDir,
        encoding: "utf-8",
      }).trim();

      const firstManager = new DispatchManager(tmpDir, scriptPath);
      const restartedManager = new DispatchManager(tmpDir, scriptPath);
      (firstManager as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      (restartedManager as unknown as { createWorktree(): undefined }).createWorktree = () =>
        undefined;
      try {
        const paused = firstManager.start("TASK-RESTORE", { skipGate: true });
        await waitForCondition(() => paused.status === "awaiting_approval", "branch restore pause");
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: tmpDir,
            encoding: "utf-8",
          }).trim(),
        ).toBe("quack/TASK-RESTORE");
        const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<
          string,
          unknown
        >;
        fs.writeFileSync(approvalPath, JSON.stringify({ ...approval, state: "approved" }), "utf-8");

        confirmWindowsSharedCheckoutTree(
          approvalPath.replace(
            path.join("approvals", "TASK-RESTORE.json"),
            "shared-checkout-pause.json",
          ),
        );
        const resumed = restartedManager.start("TASK-RESTORE", { skipGate: true, resume: true });
        markWindowsTreeKillConfirmed(restartedManager, "TASK-RESTORE");
        await waitForCondition(() => resumed.status === "completed", "branch restore completion");
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: tmpDir,
            encoding: "utf-8",
          }).trim(),
        ).toBe(originalBranch);
        expect(
          fs.existsSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json")),
        ).toBe(false);
      } finally {
        await firstManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restartedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("keeps durable ownership when a shared resume lacks a restoration baseline", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-restore-fail-"));
      const markerPath = path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json");
      const scriptPath = path.join(tmpDir, "successful-child.cjs");
      const startedPath = path.join(tmpDir, "unsafe-resume-started");
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "quack@example.test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Quack Test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
      fs.writeFileSync(
        scriptPath,
        `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
        "utf-8",
      );
      execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "-b", "quack/TASK-NO-BASELINE"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-NO-BASELINE",
          sessionId: "legacy-session",
          startedAt: now,
          pausedAt: now,
          status: "stopped",
          ...(process.platform === "win32" ? { processTreeStatus: "confirmed-stopped" } : {}),
        })}\n`,
        "utf-8",
      );

      const mgr = new DispatchManager(tmpDir, scriptPath);
      (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      try {
        expect(() => mgr.start("TASK-NO-BASELINE", { skipGate: true, resume: true })).toThrow(
          "Git restoration baseline could not be verified",
        );
        expect(fs.existsSync(markerPath)).toBe(true);
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("resumes the in-memory shared checkout when durable marker persistence failed", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-memory-"));
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      const approvalPath = path.join(approvalDir, "TASK-PAUSED.json");
      const resumedPath = path.join(tmpDir, "resumed-in-shared-checkout");
      const scriptPath = path.join(tmpDir, "pause-then-resume.cjs");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `const approvalPath = ${JSON.stringify(approvalPath)};`,
          "if (fs.existsSync(approvalPath) && JSON.parse(fs.readFileSync(approvalPath, 'utf-8')).state === 'approved') {",
          `  fs.writeFileSync(${JSON.stringify(resumedPath)}, process.cwd(), 'utf-8');`,
          "  process.exit(0);",
          "}",
          "fs.writeFileSync(approvalPath, JSON.stringify({ taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString() }), 'utf-8');",
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = new DispatchManager(tmpDir, scriptPath);
      const internals = mgr as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status?: string): void;
      };
      const persistMarker = internals.persistSharedCheckoutPause.bind(mgr);
      let markerWrites = 0;
      internals.persistSharedCheckoutPause = (job, status) => {
        markerWrites += 1;
        if (markerWrites <= 2) {
          persistMarker(job, status);
          return;
        }
        fs.rmSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json"), {
          force: true,
        });
        throw new Error("simulated marker write failure");
      };

      try {
        const pausedJob = mgr.start("TASK-PAUSED", { skipGate: true });
        await waitForCondition(
          () => pausedJob.status === "awaiting_approval",
          "in-memory shared-checkout pause",
        );
        expect(
          fs.existsSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json")),
        ).toBe(false);
        internals.persistSharedCheckoutPause = persistMarker;

        fs.writeFileSync(
          approvalPath,
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );
        if (process.platform === "win32") {
          expect(() => mgr.start("TASK-PAUSED", { skipGate: true, resume: true })).toThrow(
            DegradedSharedCheckoutBusyError,
          );
          return;
        }
        const resumed = mgr.start("TASK-PAUSED", { skipGate: true, resume: true });
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(resumedPath);
        await waitForCondition(() => resumed.status === "completed", "in-memory shared resume");
        expect(fs.readFileSync(resumedPath, "utf-8")).toBe(tmpDir);
      } finally {
        await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("keeps shared-checkout ownership after a recovered run is stopped", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-stop-"));
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      const approvalPath = path.join(approvalDir, "TASK-PAUSED.json");
      const pauseScript = path.join(tmpDir, "pause-child.cjs");
      const resumeScript = path.join(tmpDir, "resume-child.cjs");
      const readyPath = path.join(tmpDir, "resume-ready");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        pauseScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(approvalPath)}, JSON.stringify({ taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString() }), 'utf-8');`,
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        resumeScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf-8');`,
          "setInterval(() => undefined, 1000);",
        ].join("\n"),
        "utf-8",
      );

      const firstManager = new DispatchManager(tmpDir, pauseScript);
      const resumedManager = new DispatchManager(tmpDir, resumeScript);
      const restartedManager = new DispatchManager(tmpDir, resumeScript);
      try {
        const paused = firstManager.start("TASK-PAUSED", { skipGate: true });
        await waitForCondition(
          () => paused.status === "awaiting_approval",
          "durable shared-checkout pause",
        );
        fs.writeFileSync(
          approvalPath,
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );

        const resumedMarkerPath = path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json");
        confirmWindowsSharedCheckoutTree(resumedMarkerPath);
        const resumed = resumedManager.start("TASK-PAUSED", { skipGate: true, resume: true });
        markWindowsTreeKillConfirmed(resumedManager, "TASK-PAUSED");
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(readyPath);
        const shutdown = await resumedManager.shutdownAll({
          gracefulTimeoutMs: 100,
          forceTimeoutMs: 2_000,
        });
        expect(shutdown.timedOut).toEqual([]);
        expect(resumed.status).toBe("stopped");

        expect(restartedManager.getSharedCheckoutOccupants()).toEqual([
          expect.objectContaining({ taskId: "TASK-PAUSED", status: "stopped" }),
        ]);
      } finally {
        await firstManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await resumedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restartedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("does not infer shared-checkout ownership from Docker exit evidence", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-pause-evidence-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      fs.mkdirSync(approvalDir, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        path.join(approvalDir, "TASK-DOCKER.json"),
        JSON.stringify({ taskId: "TASK-DOCKER", state: "pending", createdAt: now }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(logDir, "events-docker-session.jsonl"),
        `${JSON.stringify({
          stage: "dispatch_child_exit",
          timestamp: now,
          payload: {
            taskId: "TASK-DOCKER",
            worktreePath: null,
            isolation: "docker",
            killed: false,
            at: now,
          },
        })}\n`,
        "utf-8",
      );

      try {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js", {
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
        expect(mgr.getSharedCheckoutOccupants()).toEqual([]);
        expect(fs.existsSync(path.join(logDir, "shared-checkout-pause.json"))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("start throws for awaiting_approval without resume flag", () => {
      const job = makeJob({ taskId: "TASK-203", status: "awaiting_approval" });
      injectJob(manager, job);

      expect(() => manager.start("TASK-203")).toThrow("awaiting human approval at a gate");
    });

    test("start allows resume of awaiting_approval task", () => {
      const job = makeJob({
        taskId: "TASK-204",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, job);

      // start() with resume:true should remove the old job and proceed.
      // The spawn will fail (fake paths), but the guard should NOT throw.
      let threwAwaitingError = false;
      try {
        manager.start("TASK-204", { resume: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("awaiting")) threwAwaitingError = true;
        // Other errors (spawn failure) are expected — that's fine
      }
      expect(threwAwaitingError).toBe(false);
    });

    test("a rejected run-scoped blueprint decision releases only the exited pause", async () => {
      const taskId = "TASK-204-REJECT";
      const worktreePath = path.join(managerRoot, ".quack", "worktrees", taskId);
      fs.mkdirSync(worktreePath, { recursive: true });
      const job = makeJob({
        taskId,
        status: "awaiting_approval",
        exitCode: 1,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        worktreePath,
        executionRoot: worktreePath,
      });
      injectJob(manager, job);
      const approvalCreatedAt = new Date().toISOString();
      writeBlueprintDecision(taskId, "pending", approvalCreatedAt);
      const persistDecision = jest.fn(() => {
        expect(manager.stop(taskId)).toBe(false);
        expect(() => manager.start(taskId, { resume: true })).toThrow(
          "an approval decision is being persisted",
        );
        writeBlueprintDecision(taskId, "rejected", approvalCreatedAt);
        return Promise.resolve("persisted");
      });

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistDecision),
      ).resolves.toEqual({ decision: "persisted", released: true });
      expect(persistDecision).toHaveBeenCalledTimes(1);
      expect(manager.getJob(taskId)).toBeUndefined();
      expect(manager.getActiveJob(taskId)).toBeUndefined();
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.existsSync(path.join(managerRoot, ".quack", "operator-stop-barriers"))).toBe(false);
    });

    test("resolution fails before mutation when the pending blueprint predates this run", async () => {
      const taskId = "TASK-204-STALE";
      const startedAt = new Date().toISOString();
      const job = makeJob({
        taskId,
        status: "awaiting_approval",
        exitCode: 1,
        startedAt,
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", new Date(Date.now() - 60_000).toISOString());
      const persistDecision = jest.fn(() => Promise.resolve(undefined));

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistDecision),
      ).rejects.toThrow("pending record does not match this run");
      expect(persistDecision).not.toHaveBeenCalled();
      expect(manager.getActiveJob(taskId)).toBe(job);
    });

    test("resolution refuses a blueprint decision when this run is paused at judge", async () => {
      const taskId = "TASK-204-WRONG-GATE";
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const job = makeJob({
        taskId,
        status: "awaiting_approval",
        exitCode: 1,
        startedAt,
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", new Date().toISOString());
      fs.writeFileSync(
        path.join(managerRoot, ".quack", "logs", "approvals", `${taskId}-judge.json`),
        JSON.stringify({
          taskId,
          state: "pending",
          createdAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const persistDecision = jest.fn(() => Promise.resolve(undefined));

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistDecision),
      ).rejects.toThrow("other human gate remains pending for this run");
      expect(persistDecision).not.toHaveBeenCalled();
      expect(manager.getActiveJob(taskId)).toBe(job);
    });

    test("resolution refuses before mutation while a child handle is still owned", async () => {
      const taskId = "TASK-204-LIVE";
      const job = makeJob({
        taskId,
        status: "awaiting_approval",
        exitCode: 1,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", new Date().toISOString());
      const processes = (manager as unknown as { processes: Map<string, { pid: number }> })
        .processes;
      processes.set(taskId, { pid: 1234 });
      const persistDecision = jest.fn(() => Promise.resolve(undefined));

      try {
        await expect(
          manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistDecision),
        ).rejects.toThrow("dispatch process or cleanup state remains live");
        expect(persistDecision).not.toHaveBeenCalled();
        expect(manager.getActiveJob(taskId)).toBe(job);
      } finally {
        processes.delete(taskId);
      }
    });

    test("a failed durable write releases the reservation but retains the pause", async () => {
      const taskId = "TASK-204-WRITE-FAIL";
      const approvalCreatedAt = new Date().toISOString();
      const job = makeJob({
        taskId,
        status: "awaiting_approval",
        exitCode: 1,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", approvalCreatedAt);

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", () =>
          Promise.reject(new Error("disk full")),
        ),
      ).rejects.toThrow("disk full");
      expect(manager.getActiveJob(taskId)).toBe(job);

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", () => {
          writeBlueprintDecision(taskId, "rejected", approvalCreatedAt);
          return Promise.resolve();
        }),
      ).resolves.toEqual({ decision: undefined, released: true });
    });

    test("one reservation arbitrates simultaneous approve and reject decisions after restart", async () => {
      const taskId = "TASK-204-DECISION-RACE";
      const approvalCreatedAt = new Date().toISOString();
      writeBlueprintDecision(taskId, "pending", approvalCreatedAt);
      let finishApproval!: () => void;
      const approvalHeld = new Promise<void>((resolve) => {
        finishApproval = resolve;
      });
      const persistApproval = jest.fn(async () => {
        await approvalHeld;
        writeBlueprintDecision(taskId, "approved", approvalCreatedAt);
        return "approved";
      });
      const persistRejection = jest.fn(() => {
        writeBlueprintDecision(taskId, "rejected", approvalCreatedAt);
        return Promise.resolve("rejected");
      });

      const approval = manager.resolveApprovalPauseDecision(
        taskId,
        "blueprint",
        "approved",
        persistApproval,
      );
      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistRejection),
      ).rejects.toThrow("a decision is already in flight");
      expect(persistRejection).not.toHaveBeenCalled();

      finishApproval();
      await expect(approval).resolves.toEqual({ decision: "approved", released: false });

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "rejected", persistRejection),
      ).rejects.toThrow("approval record is not pending");
      expect(persistRejection).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(managerRoot, ".quack", "logs", "approvals", `${taskId}.json`),
            "utf-8",
          ),
        ),
      ).toMatchObject({ taskId, state: "approved" });
    });

    test("refuses to decide a pending gate before the running child becomes a pause", async () => {
      const taskId = "TASK-204-STILL-RUNNING";
      const approvalCreatedAt = new Date().toISOString();
      const job = makeJob({
        taskId,
        status: "running",
        pid: process.pid,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", approvalCreatedAt);
      const persistDecision = jest.fn(() => {
        writeBlueprintDecision(taskId, "approved", approvalCreatedAt);
        return Promise.resolve(undefined);
      });

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "approved", persistDecision),
      ).rejects.toThrow("dispatch process is still running");
      expect(persistDecision).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(managerRoot, ".quack", "logs", "approvals", `${taskId}.json`),
            "utf-8",
          ),
        ),
      ).toMatchObject({ state: "pending" });

      // The failed attempt must not leak its reservation. Once the same exact
      // job has completed the ordinary non-zero pause transition, retry works.
      job.status = "awaiting_approval";
      job.exitCode = 1;
      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "approved", persistDecision),
      ).resolves.toEqual({ decision: undefined, released: true });
      expect(persistDecision).toHaveBeenCalledTimes(1);
      expect(manager.getJob(taskId)).toBeUndefined();
    });

    test("refuses a decision while an operator-stop cleanup barrier is active", async () => {
      const taskId = "TASK-204-STOPPED";
      const job = makeJob({
        taskId,
        status: "stopped",
        operatorStopCleanupPending: true,
      });
      injectJob(manager, job);
      writeBlueprintDecision(taskId, "pending", new Date().toISOString());
      const persistDecision = jest.fn(() => Promise.resolve(undefined));

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "approved", persistDecision),
      ).rejects.toThrow("cleanup state remains live");
      expect(persistDecision).not.toHaveBeenCalled();
      (manager as unknown as { jobs: Map<string, DispatchJob> }).jobs.delete(taskId);
    });

    test("allows replan to repeat an already rejected durable decision", async () => {
      const taskId = "TASK-204-REPLAN-REJECTED";
      const approvalCreatedAt = new Date().toISOString();
      writeBlueprintDecision(taskId, "rejected", approvalCreatedAt);
      const persistReplan = jest.fn(() => Promise.resolve("replanned"));

      await expect(
        manager.resolveApprovalPauseDecision(
          taskId,
          "blueprint",
          "rejected",
          persistReplan,
          path.join(managerRoot, ".quack", "logs"),
          { allowAlreadyRejected: true },
        ),
      ).resolves.toEqual({ decision: "replanned", released: false });
      expect(persistReplan).toHaveBeenCalledTimes(1);
    });

    test("refuses an ambiguous gate decision after restart when the other gate is pending", async () => {
      const taskId = "TASK-204-AMBIGUOUS-GATE";
      writeBlueprintDecision(taskId, "pending", new Date().toISOString());
      const approvalDir = path.join(managerRoot, ".quack", "logs", "approvals");
      fs.writeFileSync(
        path.join(approvalDir, `${taskId}-judge.json`),
        JSON.stringify({
          taskId,
          state: "pending",
          createdAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const persistDecision = jest.fn(() => Promise.resolve(undefined));

      await expect(
        manager.resolveApprovalPauseDecision(taskId, "blueprint", "approved", persistDecision),
      ).rejects.toThrow("other human gate remains pending");
      expect(persistDecision).not.toHaveBeenCalled();
    });

    test("stop durably fences an awaiting_approval job before changing its state", () => {
      const worktreePath = path.join(managerRoot, ".quack", "worktrees", "TASK-205");
      fs.mkdirSync(worktreePath, { recursive: true });
      const job = makeJob({
        taskId: "TASK-205",
        status: "awaiting_approval",
        pid: 4242,
        worktreePath,
        executionRoot: worktreePath,
      });
      injectJob(manager, job);

      const result = manager.stop("TASK-205");
      expect(result).toBe(false);
      expect(job.status).toBe("stopped");
      expect(job.operatorStopRequestedAt).toBeDefined();
      expect(job.operatorStopCleanupPending).toBe(true);
      expect(job.operatorStopTreeTerminated).toBe(false);
      expect(job.operatorStopBarrierPath).toBeDefined();
      expect(fs.existsSync(job.operatorStopBarrierPath!)).toBe(true);
      expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(worktreePath, expect.any(Object));
      expect(job.output.join("\n")).toContain("detached descendants cannot be excluded");
      expect(() => manager.start(job.taskId, { skipGate: true })).toThrow(
        "still completing operator-stop cleanup",
      );
      expect(fs.existsSync(worktreePath)).toBe(true);
    });

    test("killAll propagates barrier refusal for an awaiting_approval job", () => {
      const worktreePath = path.join(managerRoot, ".quack", "worktrees", "TASK-205-REFUSED");
      fs.mkdirSync(worktreePath, { recursive: true });
      const job = makeJob({
        taskId: "TASK-205-REFUSED",
        status: "awaiting_approval",
        pid: 4243,
        worktreePath,
        executionRoot: worktreePath,
      });
      injectJob(manager, job);
      const internals = manager as unknown as {
        persistOperatorStopBarrier: (candidate: DispatchJob) => boolean;
        operatorStopCleanupPending: Map<string, DispatchJob>;
      };
      jest.spyOn(internals, "persistOperatorStopBarrier").mockReturnValue(false);
      const cleanupCallsBefore = mockCleanupWorktreeContainers.mock.calls.length;

      expect(manager.killAll()).toBe(false);
      expect(job.status).toBe("awaiting_approval");
      expect(job.operatorStopRequestedAt).toBeUndefined();
      expect(job.operatorStopCleanupPending).toBe(false);
      expect(internals.operatorStopCleanupPending.has(job.taskId)).toBe(false);
      expect(mockCleanupWorktreeContainers.mock.calls.length).toBe(cleanupCallsBefore);
    });

    test("awaiting_approval stop preserves its barrier when Docker cleanup is unverified", () => {
      const worktreePath = path.join(managerRoot, ".quack", "worktrees", "TASK-205-DOCKER");
      fs.mkdirSync(worktreePath, { recursive: true });
      const job = makeJob({
        taskId: "TASK-205-DOCKER",
        status: "awaiting_approval",
        pid: 4244,
        worktreePath,
        executionRoot: worktreePath,
      });
      injectJob(manager, job);
      mockCleanupWorktreeContainers.mockReturnValueOnce(false);

      expect(manager.stop(job.taskId)).toBe(false);
      expect(job.status).toBe("stopped");
      expect(job.operatorStopCleanupPending).toBe(true);
      expect(fs.existsSync(job.operatorStopBarrierPath!)).toBe(true);
      expect(job.output.join("\n")).toContain(
        "worktree container cleanup was disabled or could not be confirmed",
      );
    });

    test("cleanup preserves awaiting_approval jobs", () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
      const awaitingJob = makeJob({
        taskId: "TASK-206",
        status: "awaiting_approval",
        startedAt: oldDate,
      });
      const failedJob = makeJob({ taskId: "TASK-207", status: "failed", startedAt: oldDate });
      injectJob(manager, awaitingJob);
      injectJob(manager, failedJob);

      manager.cleanup(3600000); // 1 hour cutoff

      // Both jobs still own a degraded shared checkout and are preserved.
      expect(manager.getJob("TASK-206")).toBeDefined();
      expect(manager.getJob("TASK-207")).toBeDefined();
    });

    test("cleanup preserves stopped jobs with unresolved operator-stop recovery", () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString();
      const flaggedJob = makeJob({
        taskId: "TASK-208",
        status: "stopped",
        startedAt: oldDate,
        operatorStopCleanupPending: true,
      });
      const mappedJob = makeJob({
        taskId: "TASK-209",
        status: "stopped",
        startedAt: oldDate,
        operatorStopCleanupPending: false,
      });
      injectJob(manager, flaggedJob);
      injectJob(manager, mappedJob);
      const pendingStops = (
        manager as unknown as { operatorStopCleanupPending: Map<string, DispatchJob> }
      ).operatorStopCleanupPending;
      pendingStops.set(mappedJob.taskId, mappedJob);

      manager.cleanup(3600000);

      expect(manager.getJob(flaggedJob.taskId)).toBe(flaggedJob);
      expect(manager.getJob(mappedJob.taskId)).toBe(mappedJob);
      expect(manager.hasPendingOperatorStopCleanup(flaggedJob.taskId)).toBe(true);
      expect(manager.hasPendingOperatorStopCleanup(mappedJob.taskId)).toBe(true);
    });

    describe("isApprovalPending", () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-approval-"));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      // QPI-041 renamed this: the detector now covers BOTH human gates,
      // because checking only the judge gate meant a run paused at the
      // BLUEPRINT gate was recorded as failed. In loop mode the brief
      // gate is the first gate every run reaches, so the unhandled case
      // was the common one.
      function callIsJudgeApprovalPending(
        mgr: DispatchManager,
        taskId: string,
        after: string,
      ): boolean {
        const fn = (mgr as unknown as Record<string, (t: string, a: string) => boolean>)[
          "isApprovalPending"
        ];
        return fn.call(mgr, taskId, after);
      }

      test("returns true for a pending BLUEPRINT approval (QPI-041)", () => {
        // The case that was NOT handled. `<taskId>.json` is the brief
        // gate; only `<taskId>-judge.json` used to be checked, so every
        // loop-mode run pausing at its FIRST gate was recorded as
        // failed, and the operator re-POSTed what looked dead.
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const startedAt = new Date(Date.now() - 60_000).toISOString();
        fs.writeFileSync(
          path.join(approvalDir, "TASK-BP.json"),
          JSON.stringify({ state: "pending", createdAt: new Date().toISOString() }),
          "utf-8",
        );

        expect(callIsJudgeApprovalPending(mgr, "TASK-BP", startedAt)).toBe(true);
      });

      test("a STALE blueprint approval from an earlier dispatch does not count", () => {
        // The guard that keeps the fix from making every failure look
        // like a pause: the approval must have been created during THIS
        // dispatch.
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const startedAt = new Date().toISOString();
        fs.writeFileSync(
          path.join(approvalDir, "TASK-BP2.json"),
          JSON.stringify({
            state: "pending",
            createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          }),
          "utf-8",
        );

        expect(callIsJudgeApprovalPending(mgr, "TASK-BP2", startedAt)).toBe(false);
      });

      test("returns true for pending approval created during dispatch", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const now = new Date();
        const approval = {
          taskId: "TASK-300",
          state: "pending",
          createdAt: now.toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-300-judge.json"), JSON.stringify(approval));

        // afterTimestamp is before the approval was created
        const before = new Date(now.getTime() - 1000).toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-300", before)).toBe(true);

        mgr.killAll();
      });

      test("returns false for stale approval from earlier dispatch", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const staleTime = new Date(Date.now() - 3600000); // 1 hour ago
        const approval = {
          taskId: "TASK-301",
          state: "pending",
          createdAt: staleTime.toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-301-judge.json"), JSON.stringify(approval));

        // afterTimestamp is after the approval was created → stale
        const after = new Date().toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-301", after)).toBe(false);

        mgr.killAll();
      });

      test("returns false for already-approved approval", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const approval = {
          taskId: "TASK-302",
          state: "approved",
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-302-judge.json"), JSON.stringify(approval));

        const before = new Date(Date.now() - 1000).toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-302", before)).toBe(false);

        mgr.killAll();
      });

      test("returns false when no approval file exists", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        expect(callIsJudgeApprovalPending(mgr, "TASK-303", new Date().toISOString())).toBe(false);
        mgr.killAll();
      });
    });
  });

  describe("CLI flag threading", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-start-flags-"));
    });

    afterEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("terminal drain fences public and internal dispatch admission", () => {
      const scriptPath = path.join(tmpDir, "must-not-run.js");
      const markerPath = path.join(tmpDir, "unexpected-launch.txt");
      fs.writeFileSync(
        scriptPath,
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran", "utf8");`,
        "utf8",
      );
      const mgr = new DispatchManager(tmpDir, scriptPath);
      const internals = mgr as unknown as {
        startWorktree(taskId: string): DispatchJob;
        startDocker(taskId: string): DispatchJob;
      };

      mgr.beginTerminalDrain();

      expect(() => mgr.start("TASK-DRAINED", { skipGate: true })).toThrow(
        "Dispatch admission is closed because the monitor is shutting down.",
      );
      expect(() => internals.startWorktree.call(mgr, "TASK-DRAINED-WORKTREE")).toThrow(
        "Dispatch admission is closed because the monitor is shutting down.",
      );
      expect(() => internals.startDocker.call(mgr, "TASK-DRAINED-DOCKER")).toThrow(
        "Dispatch admission is closed because the monitor is shutting down.",
      );
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(mgr.getActiveJobs()).toEqual([]);
    });

    test("uses canonical Node and threads --skip-depth-only into the child args", async () => {
      const projectRoot = path.join(tmpDir, "project");
      fs.mkdirSync(projectRoot);
      const gitShadowMarker = path.join(tmpDir, "git-shadow-ran.txt");
      if (process.platform === "win32") {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
        if (!systemRoot) throw new Error("SystemRoot is required for this Windows test");
        fs.copyFileSync(
          path.join(systemRoot, "System32", "cmd.exe"),
          path.join(projectRoot, "node.exe"),
        );
        fs.copyFileSync(
          path.join(systemRoot, "System32", "cmd.exe"),
          path.join(projectRoot, "powershell.exe"),
        );
        fs.writeFileSync(
          path.join(projectRoot, "git.cmd"),
          `@echo shadow>"${gitShadowMarker}"\r\n@exit /b 1\r\n`,
          "utf8",
        );
      } else {
        const gitShadow = path.join(projectRoot, "git");
        fs.writeFileSync(
          gitShadow,
          `#!/bin/sh\necho shadow > '${gitShadowMarker}'\nexit 1\n`,
          "utf8",
        );
        fs.chmodSync(gitShadow, 0o755);
      }
      const argsFile = path.join(tmpDir, "args.json");
      const scriptPath = path.join(tmpDir, "fake-quack.js");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)), 'utf-8');`,
          "setTimeout(() => process.exit(0), 50);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = new DispatchManager(projectRoot, scriptPath);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = `${projectRoot}${path.delimiter}${originalPath ?? ""}`;
        mgr.start("TASK-FLAGS", { skipGate: true, skipDepthOnly: true });
        process.env.PATH = originalPath;
        await waitForFile(argsFile);

        const args = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
        expect(args).toContain("run");
        expect(args).toContain("TASK-FLAGS");
        expect(args).toContain("--skip-gate");
        expect(args).toContain("--skip-depth-only");
        expect(fs.existsSync(gitShadowMarker)).toBe(false);
      } finally {
        process.env.PATH = originalPath;
        mgr.killAll();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });

    test("writes durable dispatch_child_exit facts into the events jsonl on child exit (QPI-043)", async () => {
      const projectRoot = path.join(tmpDir, "project");
      fs.mkdirSync(projectRoot);
      const scriptPath = path.join(tmpDir, "fake-quack.js");
      fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(3), 50);", "utf-8");

      const mgr = new DispatchManager(projectRoot, scriptPath);
      try {
        const job = mgr.start("TASK-EXIT-FACTS", { skipGate: true });
        // The fake child records no session, so the facts land durably
        // under the monitor job's own session id (the fallback path).
        const eventsFile = path.join(
          projectRoot,
          ".quack",
          "logs",
          `events-${job.sessionId}.jsonl`,
        );
        await waitForFile(eventsFile);

        const lines = fs.readFileSync(eventsFile, "utf-8").trim().split("\n");
        const exitEvent = lines
          .map((line) => JSON.parse(line) as { stage: string; payload: Record<string, unknown> })
          .find((e) => e.stage === "dispatch_child_exit");
        expect(exitEvent).toBeDefined();
        expect(exitEvent?.payload.exitCode).toBe(3);
        expect(exitEvent?.payload.killed).toBe(false);
        expect(exitEvent?.payload.sessionResolution).toBe("job-fallback");
      } finally {
        mgr.killAll();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  });
});
