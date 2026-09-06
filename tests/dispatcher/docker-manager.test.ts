import { DockerManager } from "../../src/dispatcher/docker-manager";
import type { DockerIsolationConfig } from "../../src/core/types";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";

type MockCallArgs = [string, string[], ...unknown[]];

// Mock child_process
jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

const mockExecFile = childProcess.execFile as unknown as jest.Mock;
const mockSpawn = childProcess.spawn as unknown as jest.Mock;

function defaultConfig(overrides?: Partial<DockerIsolationConfig>): DockerIsolationConfig {
  return {
    image: "node:20-slim",
    volumes: [],
    envPassthrough: ["ANTHROPIC_API_KEY"],
    resourceLimits: { memoryMb: 4096, cpus: 2 },
    networkMode: "bridge",
    cleanupPolicy: "remove",
    ...overrides,
  };
}

/**
 * Helper: make mockExecFile resolve with given stdout/stderr.
 * Supports sequential calls by chaining implementations.
 */
function mockExecFileSuccess(stdout = "", stderr = ""): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (cb) {
        cb(null, { stdout, stderr });
      }
    },
  );
}

/**
 * Helper: make mockExecFile reject with an error.
 */
function mockExecFileError(message: string): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (cb) {
        cb(new Error(message), { stdout: "", stderr: "" });
      }
    },
  );
}

/**
 * Helper: queue sequential execFile responses.
 */
function mockExecFileSequence(responses: Array<{ stdout?: string; error?: string }>): void {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (cb) {
        if (resp.error) {
          cb(new Error(resp.error), { stdout: "", stderr: "" });
        } else {
          cb(null, { stdout: resp.stdout ?? "", stderr: "" });
        }
      }
    },
  );
}

describe("DockerManager", () => {
  let manager: DockerManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new DockerManager("/project/root", defaultConfig());
  });

  // ─── checkDocker ─────────────────────────────────────────────

  describe("checkDocker", () => {
    test("returns version when Docker is available", async () => {
      mockExecFileSuccess("24.0.7\n");

      const version = await manager.checkDocker();
      expect(version).toBe("24.0.7");
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        expect.any(Function),
      );
    });

    test("throws when Docker is not available", async () => {
      mockExecFileError("command not found: docker");

      await expect(manager.checkDocker()).rejects.toThrow(
        "Docker is not available: command not found: docker",
      );
    });
  });

  // ─── createContainer ────────────────────────────────────────

  describe("createContainer", () => {
    test("creates and starts container with correct args", async () => {
      // First call: docker create → returns container ID
      // Second call: docker start → ok
      mockExecFileSequence([
        { stdout: "abc123container\n" },
        { stdout: "" }, // docker start
      ]);

      const container = await manager.createContainer("TASK-001");
      expect(container.containerId).toBe("abc123container");
      expect(container.taskId).toBe("TASK-001");
      expect(container.image).toBe("node:20-slim");
      expect(container.workDir).toBe("/workspace");
      expect(container.logsVolume).toBe("/workspace/.quack/logs");
      expect(container.status).toBe("running");

      // Verify docker create was called with correct volume mounts and limits
      const createCall = mockExecFile.mock.calls[0] as MockCallArgs;
      expect(createCall[0]).toBe("docker");
      const createArgs = createCall[1];
      expect(createArgs[0]).toBe("create");
      expect(createArgs).toContain("--memory");
      expect(createArgs).toContain("4096m");
      expect(createArgs).toContain("--cpus");
      expect(createArgs).toContain("2");
      expect(createArgs).toContain("--network");
      expect(createArgs).toContain("bridge");
      expect(createArgs).toContain("-w");
      expect(createArgs).toContain("/workspace");
      expect(createArgs).toContain("node:20-slim");

      // Verify docker start was called
      const startCall = mockExecFile.mock.calls[1] as MockCallArgs;
      expect(startCall[0]).toBe("docker");
      expect(startCall[1]).toEqual(["start", "abc123container"]);
    });

    test("runs preInstallCommand when configured", async () => {
      const mgr = new DockerManager(
        "/project/root",
        defaultConfig({ preInstallCommand: "npm install" }),
      );

      mockExecFileSequence([
        { stdout: "abc123\n" }, // docker create
        { stdout: "" }, // docker start
        { stdout: "" }, // docker exec preInstallCommand
      ]);

      await mgr.createContainer("TASK-002");

      // Third call should be the preInstallCommand
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      const execCall = mockExecFile.mock.calls[2] as MockCallArgs;
      expect(execCall[0]).toBe("docker");
      expect(execCall[1]).toEqual(["exec", "abc123", "sh", "-c", "npm install"]);
    });

    test("throws on double-create for same task", async () => {
      mockExecFileSequence([{ stdout: "abc123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-001");

      await expect(manager.createContainer("TASK-001")).rejects.toThrow(
        "Container already exists for TASK-001",
      );
    });

    test("throws when docker create fails", async () => {
      mockExecFileError("no space left on device");

      await expect(manager.createContainer("TASK-001")).rejects.toThrow(
        "Failed to create container for TASK-001: no space left on device",
      );
    });

    test("includes resource limits in create args", async () => {
      const mgr = new DockerManager(
        "/project/root",
        defaultConfig({
          resourceLimits: { memoryMb: 8192, cpus: 4, storageMb: 10240 },
        }),
      );

      mockExecFileSequence([{ stdout: "xyz789\n" }, { stdout: "" }]);

      await mgr.createContainer("TASK-003");

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(createArgs).toContain("8192m");
      expect(createArgs).toContain("4");

      // Storage opt
      const storageIdx = createArgs.indexOf("--storage-opt");
      expect(storageIdx).toBeGreaterThan(-1);
      expect(createArgs[storageIdx + 1]).toBe("size=10240M");
    });

    test("passes configured volumes", async () => {
      const mgr = new DockerManager(
        "/project/root",
        defaultConfig({ volumes: ["/host/data:/container/data:ro"] }),
      );

      mockExecFileSequence([{ stdout: "vol123\n" }, { stdout: "" }]);

      await mgr.createContainer("TASK-004");

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(createArgs).toContain("/host/data:/container/data:ro");
    });

    test("does not leak env var values into labels", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-secret-key";

      mockExecFileSequence([{ stdout: "sec123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-005");

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      // Labels should not contain the API key value
      const labelIdx = createArgs.indexOf("--label");
      expect(labelIdx).toBeGreaterThan(-1);
      const labelValue = createArgs[labelIdx + 1];
      expect(labelValue).not.toContain("sk-test-secret-key");
      expect(labelValue).toBe("quack.taskId=TASK-005");

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  // ─── execAgent ──────────────────────────────────────────────

  describe("execAgent", () => {
    test("spawns docker exec with correct args", () => {
      const mockChild = new EventEmitter() as unknown as childProcess.ChildProcess;
      Object.assign(mockChild, {
        pid: 12345,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(mockChild);

      const child = manager.execAgent("abc123", ["node", "agent.js"]);

      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["exec", "abc123", "node", "agent.js"]),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(child).toBe(mockChild);
    });

    test("passes env vars via -e flags", () => {
      const mockChild = new EventEmitter() as unknown as childProcess.ChildProcess;
      Object.assign(mockChild, {
        pid: 12345,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(mockChild);

      manager.execAgent("abc123", ["node", "agent.js"], { FOO: "bar" });

      const spawnArgs = (mockSpawn.mock.calls[0] as MockCallArgs)[1];
      expect(spawnArgs).toContain("-e");
      const fooIdx = spawnArgs.indexOf("FOO=bar");
      expect(fooIdx).toBeGreaterThan(-1);
    });

    test("passes through configured host env vars", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-key";

      const mockChild = new EventEmitter() as unknown as childProcess.ChildProcess;
      Object.assign(mockChild, {
        pid: 12345,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(mockChild);

      manager.execAgent("abc123", ["node", "agent.js"]);

      const spawnArgs = (mockSpawn.mock.calls[0] as MockCallArgs)[1];
      expect(spawnArgs).toContain("-e");
      expect(spawnArgs).toContain("ANTHROPIC_API_KEY=sk-test-key");

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  // ─── stopContainer ──────────────────────────────────────────

  describe("stopContainer", () => {
    test("calls docker stop then docker rm on success path", async () => {
      // Setup: create a container first
      mockExecFileSequence([
        { stdout: "stop123\n" },
        { stdout: "" }, // docker start
        { stdout: "" }, // docker stop
        { stdout: "" }, // docker rm
      ]);

      await manager.createContainer("TASK-010");

      // Now stop it
      await manager.stopContainer("stop123");

      // docker stop should have been called
      const stopCall = mockExecFile.mock.calls[2] as MockCallArgs;
      expect(stopCall[0]).toBe("docker");
      expect(stopCall[1]).toEqual(["stop", "-t", "10", "stop123"]);

      // docker rm should follow (cleanup policy = "remove")
      const rmCall = mockExecFile.mock.calls[3] as MockCallArgs;
      expect(rmCall[0]).toBe("docker");
      expect(rmCall[1]).toEqual(["rm", "-f", "stop123"]);
    });

    test("keeps container on failure when policy is keep_on_failure", async () => {
      const mgr = new DockerManager(
        "/project/root",
        defaultConfig({ cleanupPolicy: "keep_on_failure" }),
      );

      mockExecFileSequence([
        { stdout: "keep123\n" },
        { stdout: "" }, // docker start
        { stdout: "" }, // docker stop
      ]);

      await mgr.createContainer("TASK-011");
      await mgr.stopContainer("keep123", true); // failed = true

      // Should only have stop, no rm (3 calls: create, start, stop)
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });
  });

  // ─── removeContainer ────────────────────────────────────────

  describe("removeContainer", () => {
    test("calls docker rm -f", async () => {
      mockExecFileSequence([
        { stdout: "rm123\n" },
        { stdout: "" }, // docker start
        { stdout: "" }, // docker rm -f
      ]);

      await manager.createContainer("TASK-012");
      await manager.removeContainer("rm123");

      const rmCall = mockExecFile.mock.calls[2] as MockCallArgs;
      expect(rmCall[0]).toBe("docker");
      expect(rmCall[1]).toEqual(["rm", "-f", "rm123"]);
    });

    test("does not throw if container already removed", async () => {
      mockExecFileSequence([{ error: "No such container" }]);

      // Should not throw
      await manager.removeContainer("nonexistent");
    });
  });

  // ─── extractResults ─────────────────────────────────────────

  describe("extractResults", () => {
    test("returns git diff, log, and branch from container", async () => {
      mockExecFileSequence([
        { stdout: "diff --git a/foo.ts b/foo.ts\n+new line\n" },
        { stdout: "abc1234 Add new feature\ndef5678 Fix bug\n" },
        { stdout: "quack/TASK-001-feature\n" },
      ]);

      const results = await manager.extractResults("result123");

      expect(results.diff).toContain("diff --git");
      expect(results.log).toContain("abc1234");
      expect(results.branch).toBe("quack/TASK-001-feature");
    });

    test("returns empty strings on git failures", async () => {
      mockExecFileError("git not found");

      const results = await manager.extractResults("nogit123");

      expect(results.diff).toBe("");
      expect(results.log).toBe("");
      expect(results.branch).toBe("");
    });
  });

  // ─── getLogs ─────────────────────────────────────────────────

  describe("getLogs", () => {
    test("returns container logs", async () => {
      mockExecFileSuccess("line 1\nline 2\nline 3\n");

      const logs = await manager.getLogs("log123");

      expect(logs).toContain("line 1");
      expect(mockExecFile).toHaveBeenCalledWith("docker", ["logs", "log123"], expect.any(Function));
    });

    test("passes tail option when specified", async () => {
      mockExecFileSuccess("last line\n");

      await manager.getLogs("log123", 50);

      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["logs", "log123", "--tail", "50"],
        expect.any(Function),
      );
    });

    test("returns empty string on failure", async () => {
      mockExecFileError("no such container");

      const logs = await manager.getLogs("gone123");

      expect(logs).toBe("");
    });
  });

  // ─── getActiveContainers ────────────────────────────────────

  describe("getActiveContainers", () => {
    test("returns empty when no containers", () => {
      expect(manager.getActiveContainers()).toEqual([]);
    });

    test("tracks created containers", async () => {
      mockExecFileSequence([{ stdout: "active123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-020");

      const active = manager.getActiveContainers();
      expect(active).toHaveLength(1);
      expect(active[0].taskId).toBe("TASK-020");
      expect(active[0].containerId).toBe("active123");
      expect(active[0].status).toBe("running");
    });
  });

  // ─── cleanupAll ─────────────────────────────────────────────

  describe("cleanupAll", () => {
    test("stops and removes all tracked containers", async () => {
      // Create two containers
      mockExecFileSequence([
        { stdout: "cleanup1\n" },
        { stdout: "" },
        { stdout: "cleanup2\n" },
        { stdout: "" },
        // cleanup calls: stop + rm for each
        { stdout: "" },
        { stdout: "" },
        { stdout: "" },
        { stdout: "" },
      ]);

      await manager.createContainer("TASK-A");
      await manager.createContainer("TASK-B");

      expect(manager.getActiveContainers()).toHaveLength(2);

      await manager.cleanupAll();

      expect(manager.getActiveContainers()).toHaveLength(0);
    });

    test("does not throw when no containers exist", async () => {
      await expect(manager.cleanupAll()).resolves.not.toThrow();
    });
  });

  // ─── Docker unavailable ─────────────────────────────────────

  describe("Docker unavailable", () => {
    test("checkDocker gives clear error — no silent fallback", async () => {
      mockExecFileError("Cannot connect to the Docker daemon");

      await expect(manager.checkDocker()).rejects.toThrow("Docker is not available");
    });

    test("createContainer gives clear error when create fails", async () => {
      mockExecFileError("Cannot connect to the Docker daemon");

      await expect(manager.createContainer("TASK-099")).rejects.toThrow(
        "Failed to create container for TASK-099",
      );
    });
  });

  // ─── Network mode ──────────────────────────────────────────

  describe("network mode", () => {
    test("uses none network when configured", async () => {
      const mgr = new DockerManager("/project/root", defaultConfig({ networkMode: "none" }));

      mockExecFileSequence([{ stdout: "net123\n" }, { stdout: "" }]);

      await mgr.createContainer("TASK-NET");

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      const netIdx = createArgs.indexOf("--network");
      expect(createArgs[netIdx + 1]).toBe("none");
    });
  });
});
