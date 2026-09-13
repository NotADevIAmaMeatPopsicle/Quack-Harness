import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn((_file: string, args: string[]) => {
    if (args.includes("--show-object-format")) return "sha1\n";
    if (args.includes("rev-parse")) return `${"a".repeat(40)}\n`;
    return "";
  }),
}));

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

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  cleanupWorktreeContainers: jest.fn(() => true),
}));

jest.mock("../../src/dispatcher/worktree-lifecycle", () => ({
  removeWorktree: jest.fn(),
  prepareWorktreeFrontendDeps: jest.fn(),
}));

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
    mockCleanupWorktreeContainers.mockReturnValue(true);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("removeWorktree calls docker cleanup by default", () => {
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", { method: "worktree" });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-102");
    removeWorktree.call(mgr, worktreePath);

    expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(worktreePath, expect.any(Object));
    expect(mockRemoveWorktree).toHaveBeenCalledWith(worktreePath, "TASK-102", projectRoot, false);
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

  test("revokes an unconsumed admission when the child exits before bootstrap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-pre-bootstrap-exit-"));
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const mgr = new DispatchManager(root, "/missing-quack-bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: () => undefined }).createWorktree = () => undefined;
    const startWorktree = (
      mgr as unknown as {
        startWorktree: (
          taskId: string,
          options: { skipGate: boolean; admittedTaskContentHash: string },
        ) => unknown;
      }
    ).startWorktree;

    try {
      startWorktree.call(mgr, "TASK-401", {
        skipGate: true,
        admittedTaskContentHash: "a".repeat(64),
      });
      const admissionDirectory = path.join(root, ".quack", "decomposition-admissions");
      expect(fs.readdirSync(admissionDirectory)).toHaveLength(1);

      fakeChild.emit("exit", 1, null);
      fakeChild.emit("close", 1, null);
      await expect(mgr.waitForIdle(5_000)).resolves.toBe(true);

      expect(fs.readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      mgr.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a consumed admission as safe when the child later exits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-consumed-admission-exit-"));
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const mgr = new DispatchManager(root, "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: () => undefined }).createWorktree = () => undefined;
    const startWorktree = (
      mgr as unknown as {
        startWorktree: (
          taskId: string,
          options: { skipGate: boolean; admittedTaskContentHash: string },
        ) => { operatorStopCleanupPending?: boolean };
      }
    ).startWorktree;

    try {
      const job = startWorktree.call(mgr, "TASK-403", {
        skipGate: true,
        admittedTaskContentHash: "c".repeat(64),
      });
      const admissionDirectory = path.join(root, ".quack", "decomposition-admissions");
      const [markerName] = fs.readdirSync(admissionDirectory);
      fs.unlinkSync(path.join(admissionDirectory, markerName));

      fakeChild.emit("exit", 0, null);
      fakeChild.emit("close", 0, null);
      await expect(mgr.waitForIdle(5_000)).resolves.toBe(true);

      expect(job.operatorStopCleanupPending).not.toBe(true);
      expect(fs.readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      mgr.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("revokes an unconsumed admission on an asynchronous child error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admission-child-error-"));
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const mgr = new DispatchManager(root, "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: () => undefined }).createWorktree = () => undefined;
    const startWorktree = (
      mgr as unknown as {
        startWorktree: (
          taskId: string,
          options: { skipGate: boolean; admittedTaskContentHash: string },
        ) => unknown;
      }
    ).startWorktree;

    try {
      startWorktree.call(mgr, "TASK-404", {
        skipGate: true,
        admittedTaskContentHash: "d".repeat(64),
      });
      const admissionDirectory = path.join(root, ".quack", "decomposition-admissions");
      expect(fs.readdirSync(admissionDirectory)).toHaveLength(1);

      fakeChild.emit("error", new Error("synthetic child startup error"));
      fakeChild.emit("close", 1, null);
      await expect(mgr.waitForIdle(5_000)).resolves.toBe(true);

      expect(fs.readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      mgr.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("revokes the exact admission when spawning the child throws", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-spawn-refusal-"));
    mockSpawn.mockImplementation(() => {
      throw new Error("synthetic spawn refusal");
    });
    const mgr = new DispatchManager(root, "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: () => undefined }).createWorktree = () => undefined;
    const startWorktree = (
      mgr as unknown as {
        startWorktree: (
          taskId: string,
          options: { skipGate: boolean; admittedTaskContentHash: string },
        ) => unknown;
      }
    ).startWorktree;

    try {
      expect(() =>
        startWorktree.call(mgr, "TASK-402", {
          skipGate: true,
          admittedTaskContentHash: "b".repeat(64),
        }),
      ).toThrow("synthetic spawn refusal");
      expect(fs.readdirSync(path.join(root, ".quack", "decomposition-admissions"))).toEqual([]);
    } finally {
      mgr.killAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a native child error preserves the monitor and worktree when unlink fails", () => {
    const taskId = "TASK-UNLINK-ERROR";
    const worktree = path.join(projectRoot, ".quack", "worktrees", taskId);
    const shared = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(path.join(worktree, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(shared, "sentinel.txt"), "keep");
    fs.symlinkSync(shared, path.join(worktree, ".quack", "logs"), "junction");
    const fakeChild = new FakeChild();
    Object.defineProperty(fakeChild, "pid", { value: undefined });
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const mgr = new DispatchManager(projectRoot, "/fake/bin.js", { method: "worktree", dockerCleanup: false });
    (mgr as unknown as { createWorktree: () => string }).createWorktree = () => worktree;
    const nativeFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const unlink = jest.spyOn(nativeFs, "unlinkSync");
    try {
      const job = mgr.start(taskId, { skipGate: true });
      unlink.mockImplementationOnce(() => { throw new Error("fixture unlink denied"); });
      expect(() => fakeChild.emit("error", new Error("fixture spawn error"))).not.toThrow();
      expect(job.status).toBe("failed");
      expect(job.output.some((line) => line.includes("cleanup could not be confirmed"))).toBe(true);
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(fs.existsSync(worktree)).toBe(true);
      expect(fs.readFileSync(path.join(shared, "sentinel.txt"), "utf8")).toBe("keep");
      fakeChild.emit("close", 1, null);
    } finally {
      unlink.mockRestore();
      mgr.killAll();
    }
  });
});
