// TASK-1338-C pre-change record: both rate-limit exits wrote the
// "Re-dispatching" line before cleanup. The worktree arm removed its
// worktree and the Docker arm emitted container_stopped and stopped the
// container. Each absence oracle red at its intended first observable.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import { KeyManager } from "../../src/dispatcher/key-manager";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  removeFixture,
} from "../helpers/duplicate-claimants-fixture";

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 8181;
  kill = jest.fn(() => true);
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execSync: jest.fn().mockReturnValue(""),
    spawn: jest.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    }),
  };
});

jest.mock("../../src/monitor/trusted-node-launch", () => ({
  spawnTrustedNode: () => {
    const child = spawn(process.execPath, []);
    return {
      child,
      executablePath: process.execPath,
      processId: child.pid ?? 0,
    };
  },
  cleanupTrustedNodeLaunch: jest.fn(),
  terminateWindowsNodeJob: jest.fn(() => ({ confirmed: true })),
}));

interface ClaimantCheck {
  taskId: string;
  claimants: string[];
}

type ManagerConstructor = new (
  projectRoot: string,
  quackBin: string,
  isolationConfig: Record<string, unknown> | undefined,
  keyManager: KeyManager,
  logDir: string,
  claimantResolver: (taskId: string) => Promise<ClaimantCheck>,
  trustedLocalReadRemotePaths?: readonly string[],
  decompositionAdmissionFence?: (
    taskId: string,
    operation: (admission: {
      taskId: string;
      fileName: string;
      contentHash: string;
    }) => DispatchJob,
  ) => Promise<DispatchJob>,
) => DispatchManager;

function keyManager(): { manager: KeyManager; restore: () => void } {
  const priorPrimary = process.env.ANTHROPIC_API_KEY;
  const priorSecond = process.env.ANTHROPIC_API_KEY_2;
  process.env.ANTHROPIC_API_KEY = "fixture-one";
  process.env.ANTHROPIC_API_KEY_2 = "fixture-two";
  return {
    manager: new KeyManager({ cooldownMs: 60_000 }),
    restore: () => {
      if (priorPrimary === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorPrimary;
      if (priorSecond === undefined) delete process.env.ANTHROPIC_API_KEY_2;
      else process.env.ANTHROPIC_API_KEY_2 = priorSecond;
    },
  };
}

async function rateLimit(child: FakeChild): Promise<void> {
  child.stderr.write("429 rate limit exceeded\n");
  child.emit("exit", 1, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function initializeGitFixture(root: string): void {
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Fixture"]);
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
}

function stubDockerWorktree(manager: DispatchManager, root: string, taskId: string): string {
  const worktreePath = path.join(root, ".quack", "worktrees", taskId);
  fs.mkdirSync(path.join(worktreePath, ".quack"), { recursive: true });
  (
    manager as unknown as {
      createWorktree: (requestedTaskId: string, options?: object) => string;
    }
  ).createWorktree = jest.fn(() => worktreePath);
  (
    manager as unknown as {
      prepareDockerAdmittedBranch: () => { branch: string; head: string };
    }
  ).prepareDockerAdmittedBranch = jest.fn(() => ({
    branch: `quack/${taskId}`,
    head: "a".repeat(40),
  }));
  return worktreePath;
}

function dockerLifecycleStubs() {
  return {
    reconcileExistingContainers: jest.fn().mockResolvedValue({
      discoveredTaskIds: [],
      ambiguousContainerIds: [],
      removedTaskIds: [],
      failedTaskIds: [],
    }),
    getContainer: jest.fn(() => undefined),
    getTrackedContainers: jest.fn(() => []),
    getUnresolvedContainers: jest.fn(() => []),
    abortPendingCommands: jest.fn(),
  };
}

function dockerContainerFactory(containerId: string) {
  let attempt = 0;
  return (taskId: string, worktreePath: string) => {
    attempt += 1;
    const runtimeLogDir = path.join(worktreePath, ".quack", "docker-runtime", `fixture-${attempt}`);
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    return Promise.resolve({
      containerId: `${containerId}-${attempt}`,
      containerName: `${containerId}-${attempt}`,
      taskId,
      image: "fixture",
      workDir: "/workspace",
      logsVolume: `/workspace/.quack/docker-runtime/fixture-${attempt}`,
      worktreePath,
      runtimeLogDir,
      gitDir: "/quack-git",
      startedAt: new Date().toISOString(),
      status: "running" as const,
    });
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)("key rotation claimant matrix (%s, %s)", (kind, order) => {
  it("worktree key rotation checks claimants before output or removal", async () => {
    const fixture = createDuplicateFixture("quack-key-rotation-worktree-", kind, order);
    const keys = keyManager();
    try {
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        fixture.root,
        "fixture-bin.js",
        { method: "worktree" },
        keys.manager,
        `${fixture.root}/.quack/logs`,
        (taskId) => Promise.resolve({ taskId, claimants: fixture.claimants }),
      );
      const worktreePath = path.join(fixture.root, ".quack", "worktrees", "TASK-100");
      fs.mkdirSync(worktreePath, { recursive: true });
      const createWorktree = jest.fn(() => worktreePath);
      const removeWorktree = jest.fn();
      (manager as unknown as { createWorktree: typeof createWorktree }).createWorktree =
        createWorktree;
      (manager as unknown as { removeWorktree: typeof removeWorktree }).removeWorktree =
        removeWorktree;

      const job = manager.start("TASK-100", { skipGate: true });
      const child = spawned.at(-1);
      if (!child) throw new Error("Expected spawned child");
      await rateLimit(child);

      expect(job.output.some((line) => line.includes("Re-dispatching"))).toBe(false);
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(job.status).toBe("failed");
    } finally {
      keys.restore();
      removeFixture(fixture.root);
    }
  });
});

describe("rate-limit retry decomposition admission", () => {
  const initialHash = "a".repeat(64);
  const refreshedHash = "f".repeat(64);
  const trustedDockerImage = `node@sha256:${"1".repeat(64)}`;

  test("worktree retry reacquires admission and passes only the fresh parent hash", async () => {
    const fixture = createSingleClaimantFixture("quack-key-rotation-worktree-admission-");
    const keys = keyManager();
    try {
      const admissionFence = jest.fn(
        (
          taskId: string,
          operation: (admission: {
            taskId: string;
            fileName: string;
            contentHash: string;
          }) => DispatchJob,
        ) =>
          Promise.resolve(
            operation({
              taskId,
              fileName: "TASK-100-a.md",
              contentHash: refreshedHash,
            }),
          ),
      );
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        fixture.root,
        "fixture-bin.js",
        { method: "worktree" },
        keys.manager,
        `${fixture.root}/.quack/logs`,
        (taskId) => Promise.resolve({ taskId, claimants: [] }),
        undefined,
        admissionFence,
      );
      const worktreePath = path.join(fixture.root, ".quack", "worktrees", "TASK-100");
      fs.mkdirSync(worktreePath, { recursive: true });
      const createWorktree = jest.fn(() => worktreePath);
      const removeWorktree = jest.fn(() => true);
      (manager as unknown as { createWorktree: typeof createWorktree }).createWorktree =
        createWorktree;
      (manager as unknown as { removeWorktree: typeof removeWorktree }).removeWorktree =
        removeWorktree;
      const start = jest.spyOn(manager, "start");

      manager.start("TASK-100", {
        skipGate: true,
        admittedTaskContentHash: initialHash,
      });
      const child = spawned.at(-1);
      if (!child) throw new Error("Expected spawned child");
      await rateLimit(child);

      expect(admissionFence).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ admittedTaskContentHash: refreshedHash }),
      );
    } finally {
      keys.restore();
      removeFixture(fixture.root);
    }
  });

  test("Docker retry reacquires admission and passes only the fresh parent hash", async () => {
    const fixture = createSingleClaimantFixture("quack-key-rotation-docker-admission-");
    const keys = keyManager();
    const priorTrustedImages = process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES;
    process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES = JSON.stringify([trustedDockerImage]);
    try {
      const admissionFence = jest.fn(
        (
          taskId: string,
          operation: (admission: {
            taskId: string;
            fileName: string;
            contentHash: string;
          }) => DispatchJob,
        ) =>
          Promise.resolve(
            operation({
              taskId,
              fileName: "TASK-100-a.md",
              contentHash: refreshedHash,
            }),
          ),
      );
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        fixture.root,
        "fixture-bin.js",
        { method: "docker", docker: { image: trustedDockerImage } },
        keys.manager,
        `${fixture.root}/.quack/logs`,
        (taskId) => Promise.resolve({ taskId, claimants: [] }),
        undefined,
        admissionFence,
      );
      const children: FakeChild[] = [];
      stubDockerWorktree(manager, fixture.root, "TASK-100");
      const dockerManager = {
        ...dockerLifecycleStubs(),
        createContainer: jest.fn(dockerContainerFactory("container")),
        execAgent: jest.fn(() => {
          const child = new FakeChild();
          children.push(child);
          return child as unknown as ChildProcess;
        }),
        stopContainer: jest.fn().mockResolvedValue({ removed: true, retained: false }),
        forceRemoveContainer: jest.fn().mockResolvedValue(true),
        extractResults: jest.fn().mockResolvedValue({ branch: "", diff: "" }),
      };
      (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
      const start = jest.spyOn(manager, "start");

      manager.start("TASK-100", {
        skipGate: true,
        admittedTaskContentHash: initialHash,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const child = children[0];
      if (!child) throw new Error("Expected Docker exec child");
      await rateLimit(child);

      expect(admissionFence).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ admittedTaskContentHash: refreshedHash }),
      );
    } finally {
      if (priorTrustedImages === undefined) {
        delete process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES;
      } else {
        process.env.QUACK_TRUSTED_MANAGED_DOCKER_IMAGES = priorTrustedImages;
      }
      keys.restore();
      removeFixture(fixture.root);
    }
  });

  test("Docker retry cleans the old container when claimant resolution rejects", async () => {
    const fixture = createSingleClaimantFixture("quack-key-rotation-docker-resolver-failure-");
    const keys = keyManager();
    try {
      const claimantResolver = jest.fn(() => Promise.reject(new Error("claimant lookup failed")));
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        fixture.root,
        "fixture-bin.js",
        { method: "docker", docker: {} },
        keys.manager,
        `${fixture.root}/.quack/logs`,
        claimantResolver,
      );
      const child = new FakeChild();
      stubDockerWorktree(manager, fixture.root, "TASK-100");
      const stopContainer = jest.fn().mockResolvedValue({ removed: true, retained: false });
      const dockerManager = {
        ...dockerLifecycleStubs(),
        createContainer: jest.fn(dockerContainerFactory("container-resolver-failure")),
        execAgent: jest.fn(() => child as unknown as ChildProcess),
        stopContainer,
        forceRemoveContainer: jest.fn().mockResolvedValue(true),
        extractResults: jest.fn().mockResolvedValue({ branch: "", diff: "" }),
      };
      (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;

      const job = manager.start("TASK-100", { skipGate: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await rateLimit(child);

      expect(stopContainer).toHaveBeenCalledWith("container-resolver-failure-1", true);
      expect(claimantResolver).toHaveBeenCalledWith("TASK-100");
      expect(job.output.join("\n")).toContain("claimant lookup failed");
      expect(job.status).toBe("failed");
    } finally {
      keys.restore();
      removeFixture(fixture.root);
    }
  });
});

describe.each(DUPLICATE_FIXTURE_CASES)("key rotation claimant matrix (%s, %s)", (kind, order) => {
  it("Docker key rotation cleans the old container before refusing a duplicate retry", async () => {
    const fixture = createDuplicateFixture("quack-key-rotation-docker-", kind, order);
    const keys = keyManager();
    try {
      initializeGitFixture(fixture.root);
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        fixture.root,
        "fixture-bin.js",
        { method: "docker", docker: {} },
        keys.manager,
        `${fixture.root}/.quack/logs`,
        (taskId) => Promise.resolve({ taskId, claimants: fixture.claimants }),
      );
      const child = new FakeChild();
      stubDockerWorktree(manager, fixture.root, "TASK-100");
      const stopContainer = jest.fn().mockResolvedValue({ removed: true, retained: false });
      const dockerManager = {
        ...dockerLifecycleStubs(),
        createContainer: jest.fn(dockerContainerFactory("container")),
        execAgent: jest.fn(() => child as unknown as ChildProcess),
        stopContainer,
        forceRemoveContainer: jest.fn().mockResolvedValue(true),
      };
      (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
      const events: Array<{ stage: string; taskId: string }> = [];
      manager.setEventCallback((stage, taskId) => {
        events.push({ stage, taskId });
      });

      const job = manager.start("TASK-100", { skipGate: true });
      for (
        let attempt = 0;
        attempt < 100 && dockerManager.execAgent.mock.calls.length === 0;
        attempt++
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(dockerManager.execAgent).toHaveBeenCalledTimes(1);
      await rateLimit(child);

      expect(job.output.some((line) => line.includes("Re-dispatching"))).toBe(false);
      expect(events.some((event) => event.stage === "container_stopped")).toBe(true);
      expect(stopContainer).toHaveBeenCalledWith("container-1", true);
      expect(job.status).toBe("failed");
    } finally {
      keys.restore();
      removeFixture(fixture.root);
    }
  });
});

describe("key rotation shutdown arbitration", () => {
  it("preserves the worktree when shutdown starts during an asynchronous claimant refresh", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-key-rotation-shutdown-"));
    const keys = keyManager();
    let releaseClaimants!: (value: ClaimantCheck) => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const claimantResult = new Promise<ClaimantCheck>((resolve) => {
      releaseClaimants = resolve;
    });

    try {
      const Manager = DispatchManager as unknown as ManagerConstructor;
      const manager = new Manager(
        root,
        "fixture-bin.js",
        { method: "worktree" },
        keys.manager,
        path.join(root, ".quack", "logs"),
        () => {
          markResolverStarted();
          return claimantResult;
        },
      );
      const worktreePath = path.join(root, ".quack", "worktrees", "TASK-100");
      const createWorktree = jest.fn(() => worktreePath);
      const removeWorktree = jest.fn();
      (manager as unknown as { createWorktree: typeof createWorktree }).createWorktree =
        createWorktree;
      (manager as unknown as { removeWorktree: typeof removeWorktree }).removeWorktree =
        removeWorktree;

      const spawnCount = spawned.length;
      const job = manager.start("TASK-100", { skipGate: true });
      const child = spawned.at(-1);
      if (!child) throw new Error("Expected spawned child");
      child.stderr.write("429 rate limit exceeded\n");
      child.emit("exit", 1, null);
      await resolverStarted;

      await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });
      releaseClaimants({ taskId: "TASK-100", claimants: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(job.status).toBe("stopped");
      expect(job.output).toContain(
        "[key-rotation] Re-dispatch cancelled because shutdown is in progress; worktree preserved.",
      );
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(spawnCount + 1);
    } finally {
      keys.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
