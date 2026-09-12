import {
  DockerManager,
  TRUSTED_MANAGED_DOCKER_IMAGES_ENV,
} from "../../src/dispatcher/docker-manager";
import { _setDockerExecutableForTests } from "../../src/dispatcher/docker-cleanup";
import type { DockerIsolationConfig } from "../../src/core/types";
import {
  createDecompositionDispatchAdmissionMarker,
  removeDecompositionDispatchAdmissionScope,
} from "../../src/preflight/decomposition-dispatch-admission";
import { resolveTrustedExecutable } from "../../src/worker/trusted-executable";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type MockCallArgs = [string, string[], ...unknown[]];
type ExecFileCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;
const TRUSTED_IMAGE = `node@sha256:${"a".repeat(64)}`;

// Mock child_process
jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  execFileSync: jest.fn(() => ""),
  spawn: jest.fn(),
}));

const mockExecFile = childProcess.execFile as unknown as jest.Mock;
const mockExecFileSync = childProcess.execFileSync as unknown as jest.Mock;
const mockSpawn = childProcess.spawn as unknown as jest.Mock;

function defaultConfig(overrides?: Partial<DockerIsolationConfig>): DockerIsolationConfig {
  return {
    image: TRUSTED_IMAGE,
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
    const cb = args.at(-1) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout, stderr });
  });
}

/**
 * Helper: make mockExecFile reject with an error.
 */
function mockExecFileError(message: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as (err: Error) => void;
    cb(new Error(message));
  });
}

/**
 * Helper: queue sequential execFile responses.
 */
function mockExecFileSequence(responses: Array<{ stdout?: string; error?: string }>): void {
  let callIndex = 0;
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    if (resp.error) {
      cb(new Error(resp.error), { stdout: "", stderr: "" });
    } else {
      cb(null, { stdout: resp.stdout ?? "", stderr: "" });
    }
  });
}

function managedWorktree(projectRoot: string, taskId: string): string {
  const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
  const gitDir = path.join(projectRoot, ".git", "worktrees", taskId);
  const refName = `refs/heads/quack/${taskId}`;
  const baseSha = "1111111111111111111111111111111111111111";
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".git", "refs", "heads", "quack"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: ${refName}\n`, "utf-8");
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf-8");
  fs.writeFileSync(path.join(projectRoot, ".git", ...refName.split("/")), `${baseSha}\n`, "utf-8");
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`, "utf-8");
  fs.writeFileSync(path.join(gitDir, "gitdir"), `${path.join(worktreePath, ".git")}\n`, "utf-8");
  return worktreePath;
}

describe("DockerManager", () => {
  let manager: DockerManager;
  let stateRoot: string;
  let projectRoot: string;
  let previousTrustedImages: string | undefined;

  beforeAll(() => {
    _setDockerExecutableForTests(process.execPath);
    previousTrustedImages = process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
    process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = JSON.stringify([TRUSTED_IMAGE]);
  });

  afterAll(() => {
    _setDockerExecutableForTests(undefined);
    if (previousTrustedImages === undefined) {
      delete process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
    } else {
      process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = previousTrustedImages;
    }
  });

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
        process.execPath,
        ["info", "--format", "{{.ServerVersion}}"],
        expect.objectContaining({
          cwd: path.dirname(process.execPath),
          windowsHide: true,
        }),
        expect.any(Function),
      );
    });

    test("throws when Docker is not available", async () => {
      mockExecFileError("command not found: docker");

      await expect(manager.checkDocker()).rejects.toThrow(
        "Docker is not available: command not found: docker",
      );
    });

    test("uses a trusted cwd and strips unrelated host secrets from Docker CLI calls", async () => {
      process.env.QUACK_DOCKER_SENTINEL_SECRET = "must-not-leak";
      mockExecFileSuccess("24.0.7\n");

      await manager.checkDocker();

      const call = mockExecFile.mock.calls[0] as MockCallArgs;
      const options = call[2] as { cwd?: string; env?: NodeJS.ProcessEnv };
      expect(call[0]).toBe(process.execPath);
      expect(options.cwd).toBe(path.dirname(process.execPath));
      expect(options.env?.QUACK_DOCKER_SENTINEL_SECRET).toBeUndefined();
      delete process.env.QUACK_DOCKER_SENTINEL_SECRET;
    });
  });

  describe("containerPathForHost", () => {
    test("prefers the read-only runtime mount when the runtime is the managed project", () => {
      const runtimeManager = new DockerManager(projectRoot, defaultConfig(), stateRoot, {
        runtimeRoot: projectRoot,
      });

      expect(runtimeManager.containerPathForHost(path.join(projectRoot, "dist", "index.js"))).toBe(
        "/quack-runtime/dist/index.js",
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
    test("skips a project-root Git shadow for Docker admission and private Git setup", async () => {
      const trustedGit = resolveTrustedExecutable("git", projectRoot, "test Git");
      const shadowGit = path.join(projectRoot, process.platform === "win32" ? "git.exe" : "git");
      if (process.platform === "win32") {
        const commandInterpreter = process.env.ComSpec;
        if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
        fs.copyFileSync(commandInterpreter, shadowGit);
      } else {
        fs.writeFileSync(shadowGit, "#!/bin/sh\nexit 91\n", "utf8");
        fs.chmodSync(shadowGit, 0o755);
      }
      const pathKey =
        Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
      const previousPath = process.env[pathKey];
      process.env[pathKey] = [projectRoot, path.dirname(trustedGit)].join(path.delimiter);
      mockExecFileSync.mockReturnValue("");
      mockExecFileSequence([{ stdout: "trusted-git-container\n" }, { stdout: "" }]);

      try {
        await manager.createContainer(
          "TASK-TRUSTED-GIT",
          managedWorktree(projectRoot, "TASK-TRUSTED-GIT"),
        );
      } finally {
        if (previousPath === undefined) delete process.env[pathKey];
        else process.env[pathKey] = previousPath;
      }

      const gitCalls = (mockExecFileSync.mock.calls as MockCallArgs[]).filter((call) =>
        (call[1] ?? []).some((argument) =>
          ["config", "read-tree", "rev-parse"].includes(String(argument)),
        ),
      );
      expect(gitCalls.length).toBeGreaterThan(0);
      expect(gitCalls.every((call) => call[0] === trustedGit)).toBe(true);
      expect(gitCalls.some((call) => call[0] === shadowGit)).toBe(false);
    });

    test("creates and starts container with correct args", async () => {
      fs.writeFileSync(path.join(projectRoot, ".quack", "adapter.json"), "{}\n", "utf-8");
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
      expect(container.image).toBe(TRUSTED_IMAGE);
      expect(container.workDir).toBe("/workspace");
      expect(container.logsVolume).toMatch(
        /^\/workspace\/\.quack\/docker-runtime\/TASK-001-[a-f0-9-]+$/,
      );
      expect(container.status).toBe("running");

      // Verify docker create was called with correct volume mounts and limits
      const createCall = mockExecFile.mock.calls[0] as MockCallArgs;
      expect(createCall[0]).toBe(process.execPath);
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
      expect(createArgs.slice(-4)).toEqual(["--entrypoint", "sleep", TRUSTED_IMAGE, "infinity"]);
      expect(createArgs).toContain(TRUSTED_IMAGE);
      expect(createArgs.join(" ")).not.toContain(":/workspace/.quack/decomposition-admissions:rw");
      expect(createArgs).toContain(
        `${fs.realpathSync.native(path.join(projectRoot, ".git", "objects")).replace(/\\/g, "/")}:/quack-git-objects:ro`,
      );
      expect(createArgs.some((arg) => arg.endsWith(":/workspace/.git:ro"))).toBe(true);
      expect(createArgs.some((arg) => arg.includes(":/quack-git:rw"))).toBe(false);
      expect(createArgs.join(" ")).not.toContain(
        `${path.join(projectRoot, ".quack", "logs").replace(/\\/g, "/")}:/workspace/.quack/logs:rw`,
      );

      // Verify docker start was called
      const startCall = mockExecFile.mock.calls[1] as MockCallArgs;
      expect(startCall[0]).toBe(process.execPath);
      expect(startCall[1]).toEqual(["start", "abc123container"]);
    });

    test("keeps a custom operator log path outside the writable container mounts", async () => {
      const customLogs = path.join(projectRoot, ".quack", "logs", "custom-events");
      const mgr = new DockerManager(projectRoot, defaultConfig(), stateRoot, {
        logDir: customLogs,
      });
      mockExecFileSequence([{ stdout: "custom-logs\n" }, { stdout: "" }]);

      const container = await mgr.createContainer(
        "TASK-LOGS",
        managedWorktree(projectRoot, "TASK-LOGS"),
      );

      expect(container.logsVolume).toMatch(
        /^\/workspace\/\.quack\/docker-runtime\/TASK-LOGS-[a-f0-9-]+$/,
      );
      const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      expect(createArgs.join(" ")).not.toContain(customLogs.replace(/\\/g, "/"));
    });

    test("rejects a mutable or non-allowlisted image before managed Docker creation", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-image-refusal-"));
      const mutableAdmission = createDecompositionDispatchAdmissionMarker({
        projectRoot: root,
        taskId: "TASK-901",
        contentHash: "a".repeat(64),
        isolatedDirectory: true,
      });
      const untrustedAdmission = createDecompositionDispatchAdmissionMarker({
        projectRoot: root,
        taskId: "TASK-902",
        contentHash: "b".repeat(64),
        isolatedDirectory: true,
      });
      try {
        const mutable = new DockerManager(root, defaultConfig({ image: "node:20-slim" }));
        await expect(
          mutable.createContainer("TASK-901", managedWorktree(root, "TASK-901"), {
            admissionScopeDirectory: mutableAdmission.hostDirectory,
          }),
        ).rejects.toThrow("immutable sha256 digest-pinned image");

        const otherDigest = `node@sha256:${"b".repeat(64)}`;
        const untrusted = new DockerManager(root, defaultConfig({ image: otherDigest }));
        await expect(
          untrusted.createContainer("TASK-902", managedWorktree(root, "TASK-902"), {
            admissionScopeDirectory: untrustedAdmission.hostDirectory,
          }),
        ).rejects.toThrow("operator-owned");
        expect(mockExecFile).not.toHaveBeenCalled();
        expect(fs.existsSync(mutableAdmission.hostDirectory)).toBe(false);
        expect(fs.existsSync(untrustedAdmission.hostDirectory)).toBe(false);
      } finally {
        if (fs.existsSync(mutableAdmission.hostDirectory)) {
          removeDecompositionDispatchAdmissionScope(root, mutableAdmission.hostDirectory);
        }
        if (fs.existsSync(untrustedAdmission.hostDirectory)) {
          removeDecompositionDispatchAdmissionScope(root, untrustedAdmission.hostDirectory);
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("never forwards the operator image allowlist into a managed container", async () => {
      process.env.QUACK_VISIBLE_DOCKER_TEST = "visible";
      const mgr = new DockerManager(
        projectRoot,
        defaultConfig({
          envPassthrough: ["quack_trusted_managed_docker_images", "QUACK_VISIBLE_DOCKER_TEST"],
        }),
        stateRoot,
      );
      mockExecFileSequence([{ stdout: "trusted-image\n" }, { stdout: "" }]);
      try {
        await mgr.createContainer(
          "TASK-TRUSTED-ENV",
          managedWorktree(projectRoot, "TASK-TRUSTED-ENV"),
        );
        const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
        expect(createArgs.join(" ")).not.toMatch(/quack_trusted_managed_docker_images/i);
        expect(createArgs).toContain("QUACK_VISIBLE_DOCKER_TEST=visible");

        mgr.execAgent("trusted-image", ["node", "dist/index.js"], {
          QuAcK_TrUsTeD_MaNaGeD_DoCkEr_ImAgEs: "must-not-leak",
          QUACK_VISIBLE_DOCKER_TEST: "child-visible",
        });
        const execArgs = (mockSpawn.mock.calls[0] as MockCallArgs)[1];
        expect(execArgs.join(" ")).not.toMatch(/quack_trusted_managed_docker_images/i);
        expect(execArgs).toContain("QUACK_VISIBLE_DOCKER_TEST=child-visible");
      } finally {
        delete process.env.QUACK_VISIBLE_DOCKER_TEST;
      }
    });

    test.each([
      ".quack",
      ".quack/worktrees",
      ".quack/federation",
      ".quack/evidence",
      ".quack/prep",
      ".quack/prep/custom-events",
      ".quack/runtime-prep",
      ".quack/runtime-prep/custom-events",
      ".quack/decomposition-admissions",
      ".quack/decomposition-admissions/custom-events",
    ])("refuses a logging directory inside protected runtime path %s", (relativeLogs) => {
      expect(
        () =>
          new DockerManager("/project/root", defaultConfig(), undefined, {
            logDir: path.resolve("/project/root", relativeLogs),
          }),
      ).toThrow(/dedicated runtime tree|overlaps a protected runtime directory/);
    });

    test("refuses a writable logging mount outside the private runtime directory", () => {
      expect(
        () =>
          new DockerManager("/project/root", defaultConfig(), undefined, {
            logDir: "/project/root/docs/tasks",
          }),
      ).toThrow("must stay within its dedicated runtime tree");
    });

    test("refuses a symlinked logging directory", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-mount-"));
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-external-"));
      try {
        fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
        try {
          fs.symlinkSync(
            external,
            path.join(root, ".quack", "logs"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (error) {
          if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            return;
          }
          throw error;
        }

        expect(() => new DockerManager(root, defaultConfig())).toThrow("not a regular directory");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(external, { recursive: true, force: true });
      }
    });

    test("refuses a hard-linked file anywhere inside the writable log tree", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-hardlink-"));
      try {
        const logs = path.join(root, ".quack", "logs");
        fs.mkdirSync(logs, { recursive: true });
        const first = path.join(logs, "first.log");
        fs.writeFileSync(first, "shared log bytes\n", "utf-8");
        fs.linkSync(first, path.join(logs, "second.log"));

        expect(() => new DockerManager(root, defaultConfig())).toThrow("hard-linked file");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("revalidates the writable log tree immediately before Docker create", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-revalidate-"));
      try {
        const manager = new DockerManager(root, defaultConfig());
        const logs = path.join(root, ".quack", "logs");
        const first = path.join(logs, "first.log");
        fs.writeFileSync(first, "shared log bytes\n", "utf-8");
        fs.linkSync(first, path.join(logs, "second.log"));

        await expect(
          manager.createContainer("TASK-LOG-RACE", managedWorktree(root, "TASK-LOG-RACE")),
        ).rejects.toThrow("hard-linked file");
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("refuses a symlinked descendant inside the writable log tree", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-child-link-"));
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-log-child-target-"));
      try {
        const logs = path.join(root, ".quack", "logs");
        fs.mkdirSync(logs, { recursive: true });
        try {
          fs.symlinkSync(
            external,
            path.join(logs, "redirect"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (error) {
          if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            return;
          }
          throw error;
        }

        expect(() => new DockerManager(root, defaultConfig())).toThrow("symbolic link");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(external, { recursive: true, force: true });
      }
    });

    test("refuses a symlinked admission-marker mount at create time", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-admission-mount-"));
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-admission-external-"));
      try {
        fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
        try {
          fs.symlinkSync(
            external,
            path.join(root, ".quack", "decomposition-admissions"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (error) {
          if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            return;
          }
          throw error;
        }

        const mgr = new DockerManager(root, defaultConfig());
        await expect(
          mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002"), {
            admissionScopeDirectory: path.join(
              root,
              ".quack",
              "decomposition-admissions",
              "dispatch-TASK-002-00000000-0000-0000-0000-000000000000",
            ),
          }),
        ).rejects.toThrow("unsafe");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(external, { recursive: true, force: true });
      }
    });

    test("mounts only the exact one-use admission scope for each container", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-admission-isolation-"));
      try {
        const mgr = new DockerManager(root, defaultConfig());
        const first = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-001",
          contentHash: "a".repeat(64),
          isolatedDirectory: true,
        });
        const second = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-002",
          contentHash: "b".repeat(64),
          isolatedDirectory: true,
        });
        mockExecFileSequence([
          { stdout: "one\n" },
          { stdout: "" },
          { stdout: "two\n" },
          { stdout: "" },
          { stdout: "" },
          { stdout: "" },
          { stdout: "" },
          { stdout: "" },
        ]);

        await mgr.createContainer("TASK-001", managedWorktree(root, "TASK-001"), {
          admissionScopeDirectory: first.hostDirectory,
        });
        await mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002"), {
          admissionScopeDirectory: second.hostDirectory,
        });

        const firstArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
        const secondArgs = (mockExecFile.mock.calls[2] as MockCallArgs)[1];
        const firstMount = `${fs.realpathSync(first.hostDirectory).replace(/\\/g, "/")}:/workspace/.quack/decomposition-admissions:rw`;
        const secondMount = `${fs.realpathSync(second.hostDirectory).replace(/\\/g, "/")}:/workspace/.quack/decomposition-admissions:rw`;
        expect(firstArgs).toContain(firstMount);
        expect(firstArgs).not.toContain(secondMount);
        expect(secondArgs).toContain(secondMount);
        expect(secondArgs).not.toContain(firstMount);
        expect(firstArgs).not.toContain(
          `${path.join(root, ".quack", "decomposition-admissions").replace(/\\/g, "/")}:/workspace/.quack/decomposition-admissions:rw`,
        );

        await mgr.stopContainer("one");
        await mgr.stopContainer("two");
        expect(fs.existsSync(first.hostDirectory)).toBe(false);
        expect(fs.existsSync(second.hostDirectory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("revalidates runtime directories immediately before docker create", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-revalidate-"));
      try {
        const mgr = new DockerManager(root, defaultConfig());
        const logs = path.join(root, ".quack", "logs");
        fs.rmSync(logs, { recursive: true, force: true });
        fs.writeFileSync(logs, "not a directory", "utf-8");

        await expect(
          mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002")),
        ).rejects.toThrow("not a regular directory");
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
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
      expect(execCall[0]).toBe(process.execPath);
      expect(execCall[1]).toEqual(["exec", "abc123", "sh", "-c", "npm install"]);
      expect((execCall[2] as { timeout: number }).timeout).toBeGreaterThan(30_000);
    });

    test("refuses pre-install code before exposing a managed admission", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-preinstall-admission-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-002",
          contentHash: "6".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(
          root,
          defaultConfig({
            preInstallCommand: "cat /workspace/.quack/decomposition-admissions/marker.json",
          }),
        );

        await expect(
          mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002"), {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("preInstallCommand is not allowed on a managed dispatch container");
        expect(mockExecFile).not.toHaveBeenCalled();
        expect(fs.existsSync(admission.hostDirectory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("force-removes a created container before releasing its admission scope on start failure", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-install-cleanup-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-002",
          contentHash: "c".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(root, defaultConfig());
        mockExecFileSequence([
          { stdout: "created-before-start\n" },
          { error: "start failed" },
          { stdout: "" },
        ]);

        await expect(
          mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002"), {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("start failed");
        expect((mockExecFile.mock.calls[2] as MockCallArgs)[1]).toEqual([
          "rm",
          "-f",
          "created-before-start",
        ]);
        expect(mgr.getActiveContainers()).toEqual([]);
        expect(fs.existsSync(admission.hostDirectory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("retains tracking and the admission scope when post-create cleanup fails", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-install-retain-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-002",
          contentHash: "d".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(root, defaultConfig());
        mockExecFileSequence([
          { stdout: "possibly-live\n" },
          { error: "start failed" },
          { error: "remove failed" },
        ]);

        const worktree = managedWorktree(root, "TASK-002");
        await expect(
          mgr.createContainer("TASK-002", worktree, {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("Failed to create container for TASK-002: start failed");
        expect(mgr.getTrackedContainers()).toEqual([
          expect.objectContaining({ taskId: "TASK-002", status: "cleanup_pending" }),
        ]);
        expect(fs.existsSync(admission.hostDirectory)).toBe(true);
        await expect(
          mgr.createContainer("TASK-002", worktree, {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("admission scope remains unresolved");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("retains the named cleanup barrier when create has an ambiguous outcome", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-create-ambiguous-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-002",
          contentHash: "f".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(root, defaultConfig());
        mockExecFileSequence([
          { error: "docker create timed out after the daemon accepted the request" },
          { error: "No such container" },
        ]);

        await expect(
          mgr.createContainer("TASK-002", managedWorktree(root, "TASK-002"), {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow(
          "Failed to create container for TASK-002: docker create timed out after the daemon accepted the request",
        );

        const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
        const containerName = createArgs[createArgs.indexOf("--name") + 1];
        expect((mockExecFile.mock.calls[1] as MockCallArgs)[1]).toEqual([
          "rm",
          "-f",
          containerName,
        ]);
        expect(mgr.getTrackedContainers()).toEqual([
          expect.objectContaining({
            containerId: containerName,
            taskId: "TASK-002",
            status: "cleanup_pending",
          }),
        ]);
        expect(fs.existsSync(admission.hostDirectory)).toBe(true);
        expect(() =>
          createDecompositionDispatchAdmissionMarker({
            projectRoot: root,
            taskId: "TASK-002",
            contentHash: "f".repeat(64),
            isolatedDirectory: true,
          }),
        ).toThrow("admission scope remains unresolved");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("releases an ambiguous create only after name-based removal succeeds", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-create-removed-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-003",
          contentHash: "5".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(root, defaultConfig());
        mockExecFileSequence([{ error: "ambiguous create failure" }, { stdout: "" }]);

        await expect(
          mgr.createContainer("TASK-003", managedWorktree(root, "TASK-003"), {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("ambiguous create failure");
        expect(mgr.getActiveContainers()).toEqual([]);
        expect(fs.existsSync(admission.hostDirectory)).toBe(false);

        const replacement = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-003",
          contentHash: "5".repeat(64),
          isolatedDirectory: true,
        });
        removeDecompositionDispatchAdmissionScope(root, replacement.hostDirectory);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("throws on double-create for same task", async () => {
      mockExecFileSequence([{ stdout: "abc123\n" }, { stdout: "" }]);

      await manager.createContainer("TASK-001", managedWorktree(projectRoot, "TASK-001"));

      await expect(
        manager.createContainer("TASK-001", managedWorktree(projectRoot, "TASK-001")),
      ).rejects.toThrow("Container cleanup is unresolved for TASK-001");
    });

    test("uses collision-resistant names across independent managers for the same task", async () => {
      const first = new DockerManager(projectRoot, defaultConfig(), stateRoot);
      const second = new DockerManager(projectRoot, defaultConfig(), stateRoot);
      mockExecFileSequence([
        { stdout: "first-id\n" },
        { stdout: "" },
        { stdout: "second-id\n" },
        { stdout: "" },
      ]);

      const uuidWorktree = managedWorktree(projectRoot, "TASK-UUID");
      await first.createContainer("TASK-UUID", uuidWorktree);
      await second.createContainer("TASK-UUID", uuidWorktree);

      const firstArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
      const secondArgs = (mockExecFile.mock.calls[2] as MockCallArgs)[1];
      expect(firstArgs[firstArgs.indexOf("--name") + 1]).not.toBe(
        secondArgs[secondArgs.indexOf("--name") + 1],
      );
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

    test("passes a read-only configured volume from a real project-local source", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-volume-"));
      const source = path.join(root, "fixtures");
      fs.mkdirSync(source);
      try {
        const mgr = new DockerManager(
          root,
          defaultConfig({ volumes: [`${source}:/quack-inputs/data:ro`] }),
        );

        mockExecFileSequence([{ stdout: "vol123\n" }, { stdout: "" }]);

        const worktree = managedWorktree(root, "TASK-004");
        const worktreeSource = path.join(worktree, "fixtures");
        fs.mkdirSync(worktreeSource);
        await mgr.createContainer("TASK-004", worktree);

        const createArgs = (mockExecFile.mock.calls[0] as MockCallArgs)[1];
        expect(createArgs).toContain(
          `${fs.realpathSync(worktreeSource).replace(/\\/g, "/")}:/quack-inputs/data:ro`,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test.each([
      "/workspace",
      "/workspace/src",
      "/workspace/.quack/prep",
      "/workspace/.quack/prep/cache",
      "/workspace/.quack/decomposition-admissions",
      "/workspace/.quack/decomposition-admissions/forged",
      "/",
    ])("rejects configured volumes overlapping protected destination %s", (destination) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-shadow-"));
      const source = path.join(root, "fixtures");
      fs.mkdirSync(source);
      try {
        expect(
          () =>
            new DockerManager(root, defaultConfig({ volumes: [`${source}:${destination}:ro`] })),
        ).toThrow("overlaps a protected mount");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects writable, relative, missing, and external configured volume sources", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-untrusted-volume-"));
      const localSource = path.join(root, "fixtures");
      const externalSource = fs.mkdtempSync(
        path.join(os.tmpdir(), "quack-docker-external-volume-"),
      );
      fs.mkdirSync(localSource);
      fs.mkdirSync(path.join(root, ".quack", "decomposition-admissions"), {
        recursive: true,
      });
      try {
        expect(
          () =>
            new DockerManager(
              root,
              defaultConfig({ volumes: [`${localSource}:/container/data:rw`] }),
            ),
        ).toThrow("exactly the non-mutating 'ro' option");
        for (const options of ["ro,z", "ro,Z", "ro,ro", "ro,"]) {
          expect(
            () =>
              new DockerManager(
                root,
                defaultConfig({ volumes: [`${localSource}:/container/data:${options}`] }),
              ),
          ).toThrow("exactly the non-mutating 'ro' option");
        }
        expect(
          () =>
            new DockerManager(root, defaultConfig({ volumes: ["relative:/container/data:ro"] })),
        ).toThrow("absolute host path");
        expect(
          () =>
            new DockerManager(
              root,
              defaultConfig({ volumes: [`${path.join(root, "missing")}:/container/data:ro`] }),
            ),
        ).toThrow("must already exist");
        expect(
          () =>
            new DockerManager(
              root,
              defaultConfig({ volumes: [`${externalSource}:/container/data:ro`] }),
            ),
        ).toThrow("must stay inside the project root");
        expect(
          () => new DockerManager(root, defaultConfig({ volumes: [`${root}:/repo-copy:ro`] })),
        ).toThrow("must not expose the project root");
        expect(
          () =>
            new DockerManager(
              root,
              defaultConfig({
                volumes: [
                  `${path.join(root, ".quack", "decomposition-admissions")}:/admission-copy:ro`,
                ],
              }),
            ),
        ).toThrow("private .quack runtime state");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(externalSource, { recursive: true, force: true });
      }
    });

    test("rejects a repository-controlled prep pointer outside the allowed project runtime", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-prep-pointer-"));
      try {
        fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
        fs.writeFileSync(path.join(root, ".quack", "prep"), `${root}\n`, "utf-8");
        expect(() => new DockerManager(root, defaultConfig())).toThrow(
          "overlaps a protected runtime directory",
        );
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects a writable log mount overlapping pointer-backed runtime prep", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-runtime-prep-"));
      try {
        const runtimePrep = path.join(root, ".quack", "runtime-prep");
        fs.mkdirSync(runtimePrep, { recursive: true });
        fs.writeFileSync(path.join(root, ".quack", "prep"), ".quack/runtime-prep\n", "utf-8");

        expect(
          () =>
            new DockerManager(root, defaultConfig(), undefined, {
              logDir: path.join(runtimePrep, "logs"),
            }),
        ).toThrow("overlaps a protected runtime directory");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects a configured volume whose project-local source traverses a symlink", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-volume-link-"));
      const realSource = path.join(root, "real-fixtures");
      const linkedSource = path.join(root, "linked-fixtures");
      fs.mkdirSync(realSource);
      try {
        try {
          fs.symlinkSync(
            realSource,
            linkedSource,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (error) {
          if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            return;
          }
          throw error;
        }
        expect(
          () =>
            new DockerManager(
              root,
              defaultConfig({ volumes: [`${linkedSource}:/container/data:ro`] }),
            ),
        ).toThrow("traverses a symbolic link");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("revalidates configured volumes if the adapter object changes before create", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-volume-mutate-"));
      const source = path.join(root, "fixtures");
      fs.mkdirSync(source);
      const config = defaultConfig();
      try {
        const mgr = new DockerManager(root, config);
        config.volumes.push(`${source}:/workspace/docs/tasks:ro`);

        await expect(
          mgr.createContainer("TASK-004", managedWorktree(root, "TASK-004")),
        ).rejects.toThrow("overlaps a protected mount");
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("revokes its exact scope when pre-create mount revalidation fails", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-precreate-refusal-"));
      const config = defaultConfig();
      try {
        const mgr = new DockerManager(root, config);
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-004",
          contentHash: "4".repeat(64),
          isolatedDirectory: true,
        });
        config.volumes.push(`${root}:/repo-copy:ro`);

        await expect(
          mgr.createContainer("TASK-004", managedWorktree(root, "TASK-004"), {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("must not expose the project root");
        expect(mockExecFile).not.toHaveBeenCalled();
        expect(fs.existsSync(admission.hostDirectory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
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
        process.execPath,
        expect.arrayContaining(["exec", "abc123", "node", "agent.js"]),
        expect.objectContaining({
          cwd: path.dirname(process.execPath),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        }),
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

    test("injects the task worktree gitdir for a created container", async () => {
      mockExecFileSequence([{ stdout: "git-container\n" }, { stdout: "" }]);
      const container = await manager.createContainer(
        "TASK-GIT-ENV",
        managedWorktree(projectRoot, "TASK-GIT-ENV"),
      );
      const mockChild = new EventEmitter() as unknown as childProcess.ChildProcess;
      Object.assign(mockChild, {
        pid: 12345,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(mockChild);

      manager.execAgent(container.containerId, ["node", "agent.js"]);

      expect((mockSpawn.mock.calls[0] as MockCallArgs)[1]).toEqual(
        expect.arrayContaining([
          "-e",
          `GIT_DIR=${container.gitDir}`,
          "-e",
          "GIT_WORK_TREE=/workspace",
        ]),
      );
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
      expect(stopCall[0]).toBe(process.execPath);
      expect(stopCall[1]).toEqual(["stop", "-t", "10", "stop123"]);

      // docker rm should follow (cleanup policy = "remove")
      const rmCall = mockExecFile.mock.calls[3] as MockCallArgs;
      expect(rmCall[0]).toBe(process.execPath);
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

    test("retains the same-task barrier when stop and force-remove are unconfirmed", async () => {
      mockExecFileSequence([
        { stdout: "uncertain123\n" },
        { stdout: "" },
        { error: "daemon unavailable" },
        { error: "permission denied" },
      ]);
      const worktree = managedWorktree(projectRoot, "TASK-011");
      await manager.createContainer("TASK-011", worktree);

      await expect(manager.stopContainer("uncertain123")).resolves.toEqual({
        removed: false,
        retained: false,
      });
      expect(manager.getTrackedContainers()).toEqual([
        expect.objectContaining({ taskId: "TASK-011", status: "cleanup_pending" }),
      ]);
      await expect(manager.createContainer("TASK-011", worktree)).rejects.toThrow(
        "Container cleanup is unresolved",
      );
    });

    test("retains the same-task barrier when a stopped container's capability cannot be revoked", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-revoke-failure-"));
      try {
        const admission = createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-011",
          contentHash: "e".repeat(64),
          isolatedDirectory: true,
        });
        const mgr = new DockerManager(root, defaultConfig({ cleanupPolicy: "keep_on_failure" }));
        mockExecFileSequence([{ stdout: "stopped-but-mounted\n" }, { stdout: "" }, { stdout: "" }]);
        const worktree = managedWorktree(root, "TASK-011");
        await mgr.createContainer("TASK-011", worktree, {
          admissionScopeDirectory: admission.hostDirectory,
        });
        fs.writeFileSync(path.join(admission.hostDirectory, "unexpected.txt"), "retain evidence");

        await expect(mgr.stopContainer("stopped-but-mounted", true)).rejects.toThrow(
          "unrecognized residual state",
        );
        await expect(
          mgr.createContainer("TASK-011", worktree, {
            admissionScopeDirectory: admission.hostDirectory,
          }),
        ).rejects.toThrow("admission scope remains");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
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
      expect(rmCall[0]).toBe(process.execPath);
      expect(rmCall[1]).toEqual(["rm", "-f", "rm123"]);
    });

    test("does not throw if container already removed", async () => {
      mockExecFileSequence([{ error: "No such container" }]);

      // Should not throw
      await manager.removeContainer("nonexistent");
    });

    test("does not erase tracking after an unconfirmed force-remove", async () => {
      mockExecFileSequence([
        { stdout: "tracked123\n" },
        { stdout: "" },
        { error: "access denied" },
      ]);
      await manager.createContainer("TASK-012", managedWorktree(projectRoot, "TASK-012"));

      await expect(manager.removeContainer("tracked123")).resolves.toBeUndefined();
      expect(manager.getTrackedContainers()).toEqual([
        expect.objectContaining({ taskId: "TASK-012", status: "cleanup_pending" }),
      ]);
    });
  });

  // ─── extractResults ─────────────────────────────────────────

  describe("extractResults", () => {
    test("returns git diff, log, and admitted branch from stopped private metadata", async () => {
      mockExecFileSequence([{ stdout: "result123\n" }, { stdout: "" }]);
      const container = await manager.createContainer(
        "TASK-RESULT",
        managedWorktree(projectRoot, "TASK-RESULT"),
      );
      container.status = "stopped";
      mockExecFileSync.mockImplementation((_file: string, args: string[]) => {
        if (args.includes("diff")) return "diff --git a/foo.ts b/foo.ts\n+new line\n";
        if (args.includes("log")) return "abc1234 Add new feature\ndef5678 Fix bug\n";
        return "";
      });

      const results = await manager.extractResults(container);

      expect(results.diff).toContain("diff --git");
      expect(results.log).toContain("abc1234");
      expect(results.branch).toBe("quack/TASK-RESULT");
    });

    test("refuses extraction without tracked private metadata", () => {
      expect(() => manager.extractResults("nogit123")).toThrow(
        "requires tracked private Git metadata",
      );
    });

    test("refuses publication that creates a previously absent protected policy file", async () => {
      mockExecFileSequence([{ stdout: "policy123\n" }, { stdout: "" }]);
      const container = await manager.createContainer(
        "TASK-POLICY",
        managedWorktree(projectRoot, "TASK-POLICY"),
      );
      container.status = "stopped";
      const candidate = "2".repeat(40);
      fs.writeFileSync(
        path.join(container.privateGitDir!, ...container.authoritativeRef!.split("/")),
        `${candidate}\n`,
        "utf-8",
      );
      mockExecFileSync.mockImplementation((_file: string, args: string[]) => {
        if (args.includes("diff") && args.at(-1) === ".quack/verify.js") {
          return ".quack/verify.js\n";
        }
        return "";
      });

      expect(() =>
        manager.preparePrivateGitForPublication(container, "11111111-1111-4111-8111-111111111111"),
      ).toThrow("changed protected policy .quack/verify.js");
    });
  });

  // ─── getLogs ─────────────────────────────────────────────────

  describe("getLogs", () => {
    test("returns container logs", async () => {
      mockExecFileSuccess("line 1\nline 2\nline 3\n");

      const logs = await manager.getLogs("log123");

      expect(logs).toContain("line 1");
      expect(mockExecFile).toHaveBeenCalledWith(
        process.execPath,
        ["logs", "log123"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    test("passes tail option when specified", async () => {
      mockExecFileSuccess("last line\n");

      await manager.getLogs("log123", 50);

      expect(mockExecFile).toHaveBeenCalledWith(
        process.execPath,
        ["logs", "log123", "--tail", "50"],
        expect.any(Object),
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

    test("retains tracking when shutdown cannot confirm container removal", async () => {
      mockExecFileSequence([
        { stdout: "cleanup-uncertain\n" },
        { stdout: "" },
        { error: "stop unavailable" },
        { error: "remove unavailable" },
      ]);
      const worktree = managedWorktree(projectRoot, "TASK-020");
      await manager.createContainer("TASK-020", worktree);

      await manager.cleanupAll();

      expect(manager.getTrackedContainers()).toEqual([
        expect.objectContaining({ taskId: "TASK-020", status: "cleanup_pending" }),
      ]);
      await expect(manager.createContainer("TASK-020", worktree)).rejects.toThrow(
        "Container cleanup is unresolved",
      );
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
