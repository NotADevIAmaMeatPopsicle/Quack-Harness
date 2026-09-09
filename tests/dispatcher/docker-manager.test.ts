import { DockerManager } from "../../src/dispatcher/docker-manager";
import type { DockerIsolationConfig } from "../../src/core/types";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type MockCallArgs = [string, string[], ...unknown[]];
type ExecFileCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

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
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as ExecFileCallback | undefined;
    if (typeof cb === "function") cb(null, { stdout, stderr });
  });
}

/**
 * Helper: make mockExecFile reject with an error.
 */
function mockExecFileError(message: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as ExecFileCallback | undefined;
    if (typeof cb === "function") cb(new Error(message), { stdout: "", stderr: "" });
  });
}

/**
 * Helper: queue sequential execFile responses.
 */
function mockExecFileSequence(responses: Array<{ stdout?: string; error?: string }>): void {
  let callIndex = 0;
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as ExecFileCallback | undefined;
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    if (typeof cb === "function") {
      if (resp.error) {
        const error = Object.assign(new Error(resp.error), { stderr: resp.error });
        cb(error, { stdout: "", stderr: resp.error });
      } else {
        cb(null, { stdout: resp.stdout ?? "", stderr: "" });
      }
    }
  });
}

function managedWorktree(projectRoot: string, taskId: string): string {
  const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
  const gitDir = path.join(projectRoot, ".git", "worktrees", taskId);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`, "utf-8");
  return worktreePath;
}

describe("DockerManager", () => {
  let manager: DockerManager;
  let stateRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    jest.clearAllMocks();
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-manager-"));
    projectRoot = path.join(stateRoot, "project");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    manager = new DockerManager(projectRoot, defaultConfig(), stateRoot);
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
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
        expect.objectContaining({ timeout: 30_000 }),
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

  describe("restart ownership reconciliation", () => {
    test("discovers and removes a labeled container left by an earlier monitor", async () => {
      const projectFingerprint = (manager as unknown as { projectFingerprint: string })
        .projectFingerprint;
      mockExecFileSequence([
        { stdout: "survivor-id\n" },
        {
          stdout: JSON.stringify([
            {
              Id: "survivor-id",
              Config: {
                Image: "node:20-slim",
                Labels: {
                  "quack.taskId": "TASK-RESTART",
                  "quack.projectFingerprint": projectFingerprint,
                },
              },
              Mounts: [{ Source: "/project/root", Destination: "/workspace" }],
              State: { Running: true },
              Created: "2026-09-09T12:00:00.000Z",
            },
          ]),
        },
        { stdout: "" },
      ]);

      await expect(manager.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: ["TASK-RESTART"],
        ambiguousContainerIds: [],
        removedTaskIds: ["TASK-RESTART"],
        failedTaskIds: [],
      });
      const execCalls = mockExecFile.mock.calls as MockCallArgs[];
      expect(execCalls.map((call) => call[1])).toEqual([
        ["ps", "-a", "--filter", "label=quack.taskId", "--format", "{{.ID}}"],
        ["inspect", "--type", "container", "survivor-id"],
        ["rm", "-f", "survivor-id"],
      ]);
      expect(manager.getTrackedContainers()).toEqual([]);
    });

    test("fails closed without removing an ambiguously owned legacy container", async () => {
      mockExecFileSequence([
        { stdout: "ambiguous-id\n" },
        {
          stdout: JSON.stringify([
            {
              Id: "ambiguous-id",
              Config: {
                Image: "node:20-slim",
                Labels: { "quack.taskId": "TASK-OTHER" },
              },
              Mounts: [{ Source: "/another/project", Destination: "/workspace" }],
              State: { Running: true },
            },
          ]),
        },
      ]);

      await expect(manager.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: [],
        ambiguousContainerIds: ["ambiguous-id"],
        removedTaskIds: [],
        failedTaskIds: [],
      });
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    test("keeps probing durable uncertainty until a delayed daemon create appears", async () => {
      const timing = {
        uncertainCreateWindowMs: 80,
        uncertainCreateProbeIntervalMs: 5,
      };
      const interrupted = new DockerManager(projectRoot, defaultConfig(), stateRoot, timing);
      mockExecFileSequence([
        { error: "simulated interrupted docker create" },
        { error: "No such container" },
      ]);
      await expect(
        interrupted.createContainer(
          "TASK-LATE-CREATE",
          managedWorktree(projectRoot, "TASK-LATE-CREATE"),
        ),
      ).rejects.toThrow("simulated interrupted docker create");

      const markerFiles = fs.readdirSync(stateRoot).filter((name) => name.endsWith(".json"));
      expect(markerFiles).toHaveLength(1);
      const marker = JSON.parse(fs.readFileSync(path.join(stateRoot, markerFiles[0]), "utf-8")) as {
        containerName: string;
      };

      jest.clearAllMocks();
      mockExecFileSequence([
        { error: "No such container" },
        { stdout: marker.containerName },
        { stdout: "" },
      ]);
      const restarted = new DockerManager(projectRoot, defaultConfig(), stateRoot, timing);
      await expect(restarted.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      });

      const calls = mockExecFile.mock.calls as MockCallArgs[];
      expect(calls.map((call) => call[1])).toEqual([
        ["rm", "-f", marker.containerName],
        ["rm", "-f", marker.containerName],
        ["ps", "-a", "--filter", "label=quack.taskId", "--format", "{{.ID}}"],
      ]);
      expect(fs.readdirSync(stateRoot).filter((name) => name.endsWith(".json"))).toEqual([]);
    });

    test("starts the late-create proof window when interruption is observed", async () => {
      const timing = {
        uncertainCreateWindowMs: 4_000,
        uncertainCreateProbeIntervalMs: 250,
      };
      const mgr = new DockerManager(projectRoot, defaultConfig(), stateRoot, timing);
      const beganAt = Date.now();
      const interruptionObservedAt = beganAt + 5_000;
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockReturnValueOnce(beganAt)
        .mockReturnValueOnce(interruptionObservedAt)
        .mockReturnValue(interruptionObservedAt);
      mockExecFileSequence([
        { error: "simulated timeout after daemon acceptance delay" },
        { error: "No such container" },
      ]);
      try {
        await expect(
          mgr.createContainer(
            "TASK-OBSERVED-TIMEOUT",
            managedWorktree(projectRoot, "TASK-OBSERVED-TIMEOUT"),
          ),
        ).rejects.toThrow("simulated timeout");
      } finally {
        nowSpy.mockRestore();
      }

      const markerFile = fs.readdirSync(stateRoot).find((name) => name.endsWith(".json"));
      expect(markerFile).toBeDefined();
      const marker = JSON.parse(fs.readFileSync(path.join(stateRoot, markerFile!), "utf-8")) as {
        createdAt: string;
        interruptedAt: string;
        reconcileUntil: string;
      };
      expect(Date.parse(marker.createdAt)).toBe(beganAt);
      expect(Date.parse(marker.interruptedAt)).toBe(interruptionObservedAt);
      expect(Date.parse(marker.reconcileUntil) - Date.parse(marker.interruptedAt)).toBe(4_000);
    });

    test("uses unique create names so a same-clock loser cannot remove the winner", async () => {
      const first = new DockerManager(projectRoot, defaultConfig(), stateRoot);
      const second = new DockerManager(projectRoot, defaultConfig(), stateRoot);
      const names: string[] = [];
      const removedNames: string[] = [];
      let creates = 0;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const dockerArgs = args[1] as string[];
        const callback = args.at(-1) as ExecFileCallback;
        if (dockerArgs[0] === "create") {
          const name = dockerArgs[dockerArgs.indexOf("--name") + 1];
          names.push(name);
          creates += 1;
          if (creates === 1) callback(null, { stdout: "winner-id\n", stderr: "" });
          else callback(new Error("name conflict"), { stdout: "", stderr: "name conflict" });
          return;
        }
        if (dockerArgs[0] === "start") {
          callback(null, { stdout: "", stderr: "" });
          return;
        }
        if (dockerArgs[0] === "rm") {
          removedNames.push(dockerArgs.at(-1)!);
          const error = Object.assign(new Error("No such container"), {
            stderr: "No such container",
          });
          callback(error, { stdout: "", stderr: "No such container" });
        }
      });
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_789_000_000_000);
      try {
        const winner = first.createContainer(
          "TASK-SAME-CLOCK",
          managedWorktree(projectRoot, "TASK-SAME-CLOCK"),
        );
        const loser = second.createContainer(
          "TASK-SAME-CLOCK",
          managedWorktree(projectRoot, "TASK-SAME-CLOCK"),
        );
        await expect(winner).resolves.toMatchObject({ containerId: "winner-id" });
        await expect(loser).rejects.toThrow("name conflict");
      } finally {
        nowSpy.mockRestore();
      }

      expect(names).toHaveLength(2);
      expect(names[0]).not.toBe(names[1]);
      expect(removedNames).toEqual([names[1]]);
      expect(removedNames).not.toContain(names[0]);
    });

    test("releases same-process task tracking after uncertain create reconciliation", async () => {
      const timing = {
        uncertainCreateWindowMs: 80,
        uncertainCreateProbeIntervalMs: 5,
      };
      const mgr = new DockerManager(projectRoot, defaultConfig(), stateRoot, timing);
      mockExecFileSequence([
        { error: "simulated interrupted docker create" },
        { error: "No such container" },
        { error: "No such container" },
        { error: "No such container" },
        { error: "No such container" },
        { stdout: "" },
        { stdout: "" },
        { stdout: "retry-container\n" },
        { stdout: "" },
      ]);

      await expect(
        mgr.createContainer(
          "TASK-SAME-PROCESS-RETRY",
          managedWorktree(projectRoot, "TASK-SAME-PROCESS-RETRY"),
        ),
      ).rejects.toThrow("simulated interrupted docker create");
      await expect(mgr.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      });
      expect(mgr.getTrackedContainers()).toEqual([]);
      await expect(
        mgr.createContainer(
          "TASK-SAME-PROCESS-RETRY",
          managedWorktree(projectRoot, "TASK-SAME-PROCESS-RETRY"),
        ),
      ).resolves.toMatchObject({
        containerId: "retry-container",
        status: "running",
      });
    });

    test("treats a fingerprint-less container mounted to a registered peer as foreign", async () => {
      const projectA = path.join(stateRoot, "project-a");
      const projectB = path.join(stateRoot, "project-b");
      const peerAware = new DockerManager(projectA, defaultConfig(), path.join(stateRoot, "state"));
      mockExecFileSequence([
        { stdout: "peer-container\n" },
        {
          stdout: JSON.stringify([
            {
              Id: "peer-container",
              Config: {
                Image: "node:20-slim",
                Labels: { "quack.taskId": "TASK-PEER" },
              },
              Mounts: [{ Source: projectB, Destination: "/workspace" }],
              State: { Running: true },
            },
          ]),
        },
      ]);

      await expect(peerAware.reconcileExistingContainers([projectA, projectB])).resolves.toEqual({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      });
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    test("does not reconcile away a container actively owned by this manager", async () => {
      mockExecFileSequence([{ stdout: "active-container\n" }, { stdout: "" }]);
      await manager.createContainer("TASK-ACTIVE", managedWorktree(projectRoot, "TASK-ACTIVE"));
      const projectFingerprint = (manager as unknown as { projectFingerprint: string })
        .projectFingerprint;

      jest.clearAllMocks();
      mockExecFileSequence([
        { stdout: "active-container\n" },
        {
          stdout: JSON.stringify([
            {
              Id: "active-container",
              Config: {
                Image: "node:20-slim",
                Labels: {
                  "quack.taskId": "TASK-ACTIVE",
                  "quack.projectFingerprint": projectFingerprint,
                },
              },
              Mounts: [
                {
                  Source: managedWorktree(projectRoot, "TASK-ACTIVE"),
                  Destination: "/workspace",
                },
              ],
              State: { Running: true },
            },
          ]),
        },
      ]);

      await expect(manager.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      });
      expect((mockExecFile.mock.calls as MockCallArgs[]).some((call) => call[1][0] === "rm")).toBe(
        false,
      );
      expect(manager.getActiveContainers()).toEqual([
        expect.objectContaining({ taskId: "TASK-ACTIVE", containerId: "active-container" }),
      ]);
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

      const container = await manager.createContainer(
        "TASK-001",
        managedWorktree(projectRoot, "TASK-001"),
      );
      expect(container.containerId).toBe("abc123container");
      expect(container.taskId).toBe("TASK-001");
      expect(container.image).toBe("node:20-slim");
      expect(container.workDir).toBe("/workspace");
      expect(container.logsVolume).toMatch(
        /^\/workspace\/\.quack\/docker-runtime\/TASK-001-[a-f0-9-]+$/,
      );
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
        projectRoot,
        defaultConfig({ preInstallCommand: "npm install" }),
        stateRoot,
      );

      mockExecFileSequence([
        { stdout: "abc123\n" }, // docker create
        { stdout: "" }, // docker start
        { stdout: "" }, // docker exec preInstallCommand
      ]);

      await mgr.createContainer("TASK-002", managedWorktree(projectRoot, "TASK-002"));

      // Third call should be the preInstallCommand
      expect(mockExecFile).toHaveBeenCalledTimes(3);
      const execCall = mockExecFile.mock.calls[2] as MockCallArgs;
      expect(execCall[0]).toBe("docker");
      expect(execCall[1]).toEqual(["exec", "abc123", "sh", "-c", "npm install"]);
      expect((execCall[2] as { timeout: number }).timeout).toBeGreaterThan(30_000);
    });

    test("throws on double-create for same task", async () => {
      mockExecFileSequence([{ stdout: "abc123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-001", managedWorktree(projectRoot, "TASK-001"));

      await expect(
        manager.createContainer("TASK-001", managedWorktree(projectRoot, "TASK-001")),
      ).rejects.toThrow("Container cleanup is unresolved for TASK-001");
    });

    test("throws when docker create fails", async () => {
      mockExecFileError("no space left on device");

      await expect(
        manager.createContainer("TASK-001", managedWorktree(projectRoot, "TASK-001")),
      ).rejects.toThrow("Failed to create container for TASK-001: no space left on device");
    });

    test("includes resource limits in create args", async () => {
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig({
          resourceLimits: { memoryMb: 8192, cpus: 4, storageMb: 10240 },
        }),
        stateRoot,
      );

      mockExecFileSequence([{ stdout: "xyz789\n" }, { stdout: "" }]);

      await mgr.createContainer("TASK-003", managedWorktree(projectRoot, "TASK-003"));

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(createArgs).toContain("8192m");
      expect(createArgs).toContain("4");

      // Storage opt
      const storageIdx = createArgs.indexOf("--storage-opt");
      expect(storageIdx).toBeGreaterThan(-1);
      expect(createArgs[storageIdx + 1]).toBe("size=10240M");
    });

    test("passes configured volumes", async () => {
      const projectRoot = path.join(stateRoot, "project");
      const volumeSource = path.join(projectRoot, "fixtures");
      fs.mkdirSync(volumeSource, { recursive: true });
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig({ volumes: [`${volumeSource}:/container/data:ro`] }),
        path.join(stateRoot, "uncertainty"),
      );

      mockExecFileSequence([{ stdout: "vol123\n" }, { stdout: "" }]);

      const taskWorktree = managedWorktree(projectRoot, "TASK-004");
      fs.mkdirSync(path.join(taskWorktree, "fixtures"), { recursive: true });
      await mgr.createContainer("TASK-004", taskWorktree);

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(createArgs).toContain(
        `${fs.realpathSync.native(path.join(taskWorktree, "fixtures")).replace(/\\/g, "/")}:/container/data:ro`,
      );
    });

    test.each(["/workspace", "/workspace/.quack/prep", "/"])(
      "rejects a configured volume that shadows protected workspace mounts: %s",
      (destination) => {
        const volume = `${path.join(projectRoot, "cache")}:${destination}:ro`;
        expect(
          () => new DockerManager(projectRoot, defaultConfig({ volumes: [volume] }), stateRoot),
        ).toThrow("overlaps a protected runtime tree");
      },
    );

    test("rejects arbitrary named volumes even when read-only", () => {
      expect(
        () =>
          new DockerManager(
            projectRoot,
            defaultConfig({ volumes: ["cache:/container/cache:ro"] }),
            stateRoot,
          ),
      ).toThrow("named volume cache is not trusted");
    });

    test("rejects bind sources outside the real project and writable configured volumes", () => {
      const projectRoot = path.join(stateRoot, "project");
      const insideSource = path.join(projectRoot, "fixtures");
      fs.mkdirSync(insideSource, { recursive: true });

      expect(
        () =>
          new DockerManager(
            projectRoot,
            defaultConfig({ volumes: [`${path.join(stateRoot, "outside")}:/container/data:ro`] }),
            path.join(stateRoot, "uncertainty-outside"),
          ),
      ).toThrow("bind source must remain inside the project root");
      expect(
        () =>
          new DockerManager(
            projectRoot,
            defaultConfig({ volumes: [`${insideSource}:/container/data:rw`] }),
            path.join(stateRoot, "uncertainty-rw"),
          ),
      ).toThrow("must be explicitly read-only");
      for (const option of ["ro,z", "ro,Z", "z", ""]) {
        expect(
          () =>
            new DockerManager(
              projectRoot,
              defaultConfig({ volumes: [`${insideSource}:/container/data:${option}`] }),
              path.join(stateRoot, `uncertainty-${option || "missing"}`),
            ),
        ).toThrow("must be explicitly read-only");
      }
    });

    test("rechecks configured bind source identity before Docker create", async () => {
      const projectRoot = path.join(stateRoot, "project");
      const outsideDir = path.join(stateRoot, "outside-volume");
      const linkPath = path.join(projectRoot, "fixture-link");
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig({ volumes: [`${linkPath}:/container/data:ro`] }),
        path.join(stateRoot, "uncertainty-volume-link"),
      );
      fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");

      try {
        const worktreePath = managedWorktree(projectRoot, "TASK-VOLUME-ESCAPE");
        const worktreeLink = path.join(worktreePath, "fixture-link");
        fs.symlinkSync(outsideDir, worktreeLink, process.platform === "win32" ? "junction" : "dir");
        await expect(mgr.createContainer("TASK-VOLUME-ESCAPE", worktreePath)).rejects.toThrow(
          "resolves outside the project root",
        );
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.unlinkSync(linkPath);
      }
    });

    test("keeps a fresh task-specific log subtree inside the disposable worktree", async () => {
      const customLogDir = path.join(projectRoot, ".quack", "logs");
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig(),
        path.join(stateRoot, "uncertainty"),
        { logDir: customLogDir },
      );
      mockExecFileSequence([{ stdout: "custom-logs\n" }, { stdout: "" }]);

      const container = await mgr.createContainer(
        "TASK-CUSTOM-LOGS",
        managedWorktree(projectRoot, "TASK-CUSTOM-LOGS"),
      );
      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(container.runtimeLogDir).toMatch(
        new RegExp(
          `${path.join(projectRoot, ".quack", "worktrees", "TASK-CUSTOM-LOGS", ".quack", "docker-runtime").replace(/[\\/]/g, "[\\\\/]")}[\\\\/]TASK-CUSTOM-LOGS-`,
        ),
      );
      expect(container.logsVolume).toMatch(
        /^\/workspace\/\.quack\/docker-runtime\/TASK-CUSTOM-LOGS-[a-f0-9-]+$/,
      );
      expect(createArgs).not.toContain(
        `${customLogDir.replace(/\\/g, "/")}:/workspace/.quack/logs:rw`,
      );
    });

    test("rejects logging directories outside the dedicated .quack/logs boundary", () => {
      expect(
        () =>
          new DockerManager(projectRoot, defaultConfig(), path.join(stateRoot, "uncertainty-a"), {
            logDir: path.join(stateRoot, "outside-logs"),
          }),
      ).toThrow("must remain inside the project root");
      for (const unsafe of [
        projectRoot,
        path.join(projectRoot, ".quack"),
        path.join(projectRoot, "src"),
        path.join(projectRoot, ".quack", "prep", "events"),
      ]) {
        expect(
          () =>
            new DockerManager(projectRoot, defaultConfig(), path.join(stateRoot, "uncertainty-b"), {
              logDir: unsafe,
            }),
        ).toThrow("dedicated .quack/logs runtime directory");
      }
    });

    test("rejects logging beneath prep storage selected by a pointer", () => {
      const projectRoot = path.join(stateRoot, "project");
      const prepStorage = path.join(projectRoot, "runtime-prep-state");
      fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
      fs.mkdirSync(prepStorage, { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ".quack", "prep"), "runtime-prep-state\n", "utf-8");

      expect(
        () =>
          new DockerManager(projectRoot, defaultConfig(), path.join(stateRoot, "uncertainty-d"), {
            logDir: path.join(prepStorage, "events"),
          }),
      ).toThrow("dedicated .quack/logs runtime directory");
    });

    test("rechecks logging directory containment before creating the RW mount", async () => {
      const projectRoot = path.join(stateRoot, "project");
      const outsideDir = path.join(stateRoot, "outside");
      const configuredLogDir = path.join(projectRoot, ".quack", "logs");
      fs.mkdirSync(outsideDir, { recursive: true });
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig(),
        path.join(stateRoot, "uncertainty-c"),
        { logDir: configuredLogDir },
      );
      fs.rmSync(configuredLogDir, { recursive: true, force: true });
      fs.symlinkSync(
        outsideDir,
        configuredLogDir,
        process.platform === "win32" ? "junction" : "dir",
      );

      try {
        await expect(
          mgr.createContainer("TASK-LOG-ESCAPE", managedWorktree(projectRoot, "TASK-LOG-ESCAPE")),
        ).rejects.toThrow("resolves outside the project root");
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.unlinkSync(configuredLogDir);
      }
    });

    test("does not leak env var values into labels", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-secret-key";

      mockExecFileSequence([{ stdout: "sec123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-005", managedWorktree(projectRoot, "TASK-005"));

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      // Labels should not contain the API key value
      const labelIdx = createArgs.indexOf("--label");
      expect(labelIdx).toBeGreaterThan(-1);
      const labelValue = createArgs[labelIdx + 1];
      expect(labelValue).not.toContain("sk-test-secret-key");
      expect(labelValue).toBe("quack.taskId=TASK-005");
      expect(createArgs).toEqual(
        expect.arrayContaining([
          "--label",
          expect.stringMatching(/^quack\.projectFingerprint=[a-f0-9]{64}$/),
        ]),
      );

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

      await manager.createContainer("TASK-010", managedWorktree(projectRoot, "TASK-010"));

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
        projectRoot,
        defaultConfig({ cleanupPolicy: "keep_on_failure" }),
        stateRoot,
      );

      mockExecFileSequence([
        { stdout: "keep123\n" },
        { stdout: "" }, // docker start
        { stdout: "" }, // docker stop
      ]);

      await mgr.createContainer("TASK-011", managedWorktree(projectRoot, "TASK-011"));
      await mgr.stopContainer("keep123", true); // failed = true

      // Should only have stop, no rm (3 calls: create, start, stop)
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });

    test("preserves retained ownership across restart without blocking another task", async () => {
      const config = defaultConfig({ cleanupPolicy: "keep_on_failure" });
      const first = new DockerManager(projectRoot, config, stateRoot);
      const retainedWorktree = managedWorktree(projectRoot, "TASK-RETAINED");
      mockExecFileSequence([{ stdout: "retained-id\n" }, { stdout: "" }, { stdout: "" }]);
      const retained = await first.createContainer("TASK-RETAINED", retainedWorktree);
      await expect(first.stopContainer(retained.containerId, true)).resolves.toEqual({
        removed: false,
        retained: true,
      });

      jest.clearAllMocks();
      const restarted = new DockerManager(projectRoot, config, stateRoot);
      const fingerprint = (restarted as unknown as { projectFingerprint: string })
        .projectFingerprint;
      mockExecFileSequence([
        { stdout: "retained-id\n" },
        {
          stdout: JSON.stringify([
            {
              Id: "retained-id",
              Name: "/retained-container",
              Config: {
                Image: "node:20-slim",
                Labels: {
                  "quack.taskId": "TASK-RETAINED",
                  "quack.projectFingerprint": fingerprint,
                  "quack.runtimeLogPath": retained.logsVolume,
                },
              },
              Mounts: [{ Source: retainedWorktree, Destination: "/workspace" }],
              State: { Running: false },
            },
          ]),
        },
      ]);
      await expect(restarted.reconcileExistingContainers()).resolves.toEqual({
        discoveredTaskIds: ["TASK-RETAINED"],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
        retainedTaskIds: ["TASK-RETAINED"],
      });
      await expect(restarted.cleanupAll()).resolves.toEqual({
        removedTaskIds: [],
        failedTaskIds: [],
        retainedTaskIds: ["TASK-RETAINED"],
      });

      jest.clearAllMocks();
      mockExecFileSequence([{ stdout: "" }]);
      await expect(restarted.cleanupAll({ includeRetained: true })).resolves.toEqual({
        removedTaskIds: ["TASK-RETAINED"],
        failedTaskIds: [],
      });
      expect((mockExecFile.mock.calls[0] as MockCallArgs)[1]).toEqual(["rm", "-f", "retained-id"]);
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

      await manager.createContainer("TASK-012", managedWorktree(projectRoot, "TASK-012"));
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
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["logs", "log123"],
        expect.objectContaining({ timeout: 30_000 }),
        expect.any(Function),
      );
    });

    test("passes tail option when specified", async () => {
      mockExecFileSuccess("last line\n");

      await manager.getLogs("log123", 50);

      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["logs", "log123", "--tail", "50"],
        expect.objectContaining({ timeout: 30_000 }),
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

      await manager.createContainer("TASK-020", managedWorktree(projectRoot, "TASK-020"));

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

      await manager.createContainer("TASK-A", managedWorktree(projectRoot, "TASK-A"));
      await manager.createContainer("TASK-B", managedWorktree(projectRoot, "TASK-B"));

      expect(manager.getActiveContainers()).toHaveLength(2);

      const result = await manager.cleanupAll();

      expect(manager.getActiveContainers()).toHaveLength(0);
      expect(result).toEqual({
        removedTaskIds: ["TASK-A", "TASK-B"],
        failedTaskIds: [],
      });
    });

    test("retains and reports a container when force removal fails", async () => {
      mockExecFileSequence([
        { stdout: "survivor123\n" },
        { stdout: "" },
        { error: "daemon unavailable" },
        { stdout: "{}" },
      ]);

      await manager.createContainer("TASK-SURVIVOR", managedWorktree(projectRoot, "TASK-SURVIVOR"));
      const result = await manager.cleanupAll();

      expect(result).toEqual({
        removedTaskIds: [],
        failedTaskIds: ["TASK-SURVIVOR"],
      });
      expect(manager.getTrackedContainers()).toEqual([
        expect.objectContaining({
          taskId: "TASK-SURVIVOR",
          status: "cleanup_pending",
          cleanupPending: true,
        }),
      ]);
    });

    test("does not treat immediate absence as proof after an aborted create", async () => {
      const createError = Object.assign(new Error("The operation was aborted"), {
        code: null,
        killed: true,
        signal: "SIGTERM",
      });
      mockExecFile.mockImplementationOnce((...args: unknown[]) => {
        const cb = args.at(-1) as ExecFileCallback;
        cb(createError, { stdout: "", stderr: "" });
      });
      mockExecFileSequence([{ error: "No such container" }, { error: "No such container" }]);

      await expect(
        manager.createContainer(
          "TASK-ABORTED-CREATE",
          managedWorktree(projectRoot, "TASK-ABORTED-CREATE"),
        ),
      ).rejects.toThrow("Failed to create container");
      expect(await manager.cleanupAll()).toEqual({
        removedTaskIds: [],
        failedTaskIds: ["TASK-ABORTED-CREATE"],
      });
      await expect(
        manager.createContainer(
          "TASK-ABORTED-CREATE",
          managedWorktree(projectRoot, "TASK-ABORTED-CREATE"),
        ),
      ).rejects.toThrow("Container cleanup is unresolved");
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

      await expect(
        manager.createContainer("TASK-099", managedWorktree(projectRoot, "TASK-099")),
      ).rejects.toThrow("Failed to create container for TASK-099");
    });
  });

  // ─── Network mode ──────────────────────────────────────────

  describe("network mode", () => {
    test("uses none network when configured", async () => {
      const mgr = new DockerManager(projectRoot, defaultConfig({ networkMode: "none" }), stateRoot);

      mockExecFileSequence([{ stdout: "net123\n" }, { stdout: "" }]);

      await mgr.createContainer("TASK-NET", managedWorktree(projectRoot, "TASK-NET"));

      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      const netIdx = createArgs.indexOf("--network");
      expect(createArgs[netIdx + 1]).toBe("none");
    });
  });
});
