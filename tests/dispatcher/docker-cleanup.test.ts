import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  _setDockerExecutableForTests,
  cleanupWorktreeContainers,
  detectStaleContainers,
  resolveTrustedDockerExecutable,
} from "../../src/dispatcher/docker-cleanup";

jest.mock("node:child_process", () => ({
  execFileSync: jest.fn(),
}));

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
const trustedDocker = realpathSync.native(process.execPath);
const worktreePath =
  process.platform === "win32" ? "C:\\worktrees\\TASK-123" : "/worktrees/TASK-123";
const separator = process.platform === "win32" ? "\\" : "/";

function inspectRecord(options?: {
  id?: string;
  workingDirectory?: string;
  configFiles?: string;
  mountSource?: string;
}): string {
  return JSON.stringify([
    {
      Id: options?.id ?? "container-1",
      Config: {
        Labels: {
          ...(options?.workingDirectory
            ? { "com.docker.compose.project.working_dir": options.workingDirectory }
            : {}),
          ...(options?.configFiles
            ? { "com.docker.compose.project.config_files": options.configFiles }
            : {}),
        },
      },
      Mounts: options?.mountSource ? [{ Source: options.mountSource }] : [],
    },
  ]);
}

describe("docker-cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _setDockerExecutableForTests(trustedDocker);
  });

  afterEach(() => {
    _setDockerExecutableForTests(undefined);
  });

  test("removes and verifies containers tied to the worktree by Compose metadata", () => {
    mockExecFileSync
      .mockReturnValueOnce("container-1\n")
      .mockReturnValueOnce(inspectRecord({ workingDirectory: worktreePath }))
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");
    const info = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { info })).toBe(true);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      trustedDocker,
      ["rm", "--force", "--volumes", "container-1"],
      expect.any(Object),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Removed 1 container"));
  });

  test("recognizes custom Compose files from immutable container labels", () => {
    const customCompose = `${worktreePath}${separator}infra${separator}ci.stack.yml`;
    mockExecFileSync
      .mockReturnValueOnce("container-custom\n")
      .mockReturnValueOnce(inspectRecord({ id: "container-custom", configFiles: customCompose }))
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");

    expect(cleanupWorktreeContainers(worktreePath)).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      trustedDocker,
      ["rm", "--force", "--volumes", "container-custom"],
      expect.any(Object),
    );
  });

  test("removes a non-Compose container that mounts the worktree", () => {
    const mountedPath = `${worktreePath}${separator}src`;
    mockExecFileSync
      .mockReturnValueOnce("container-mounted\n")
      .mockReturnValueOnce(inspectRecord({ id: "container-mounted", mountSource: mountedPath }))
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");

    expect(cleanupWorktreeContainers(worktreePath)).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      trustedDocker,
      ["rm", "--force", "--volumes", "container-mounted"],
      expect.any(Object),
    );
  });

  test("fails closed without removing a container that mounts an ancestor of the worktree", () => {
    const broaderMount = path.dirname(worktreePath);
    mockExecFileSync
      .mockReturnValueOnce("container-broad-mount\n")
      .mockReturnValueOnce(
        inspectRecord({ id: "container-broad-mount", mountSource: broaderMount }),
      );
    const warn = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { warn })).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      trustedDocker,
      expect.arrayContaining(["rm"]),
      expect.any(Object),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mount a broader host path"));
  });

  test("does not remove unrelated containers", () => {
    const otherRoot =
      process.platform === "win32" ? "C:\\worktrees\\TASK-OTHER" : "/worktrees/TASK-OTHER";
    mockExecFileSync
      .mockReturnValueOnce("container-other\n")
      .mockReturnValueOnce(inspectRecord({ id: "container-other", workingDirectory: otherRoot }))
      .mockReturnValueOnce("container-other\n")
      .mockReturnValueOnce(inspectRecord({ id: "container-other", workingDirectory: otherRoot }));
    const info = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { info })).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      trustedDocker,
      expect.arrayContaining(["rm"]),
      expect.any(Object),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Verified no containers"));
  });

  test("fails closed when a matching container survives removal", () => {
    mockExecFileSync.mockImplementation((_file, args) => {
      const command = args as string[];
      if (command[0] === "ps") return "container-1\n";
      if (command[0] === "inspect") {
        return inspectRecord({ workingDirectory: worktreePath });
      }
      return "";
    });
    const warn = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remain for"));
  });

  test("proves a no-Compose project safe by querying runtime state", () => {
    mockExecFileSync.mockReturnValue("");
    const info = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { info })).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Verified no containers"));
  });

  test("fails closed when Docker runtime state cannot be inspected", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("docker unavailable");
    });
    const warn = jest.fn();

    expect(cleanupWorktreeContainers(worktreePath, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify container absence"),
    );
  });

  test("detectStaleContainers returns only task postgres/redis container names", async () => {
    mockExecFileSync.mockReturnValue(
      ["task-691-postgres-1", "task-691-redis-1", "nginx-proxy-1", "task-700-other-1"].join(
        "\n",
      ) as unknown as ReturnType<typeof execFileSync>,
    );

    const warn = jest.fn();
    const stale = await detectStaleContainers({ warn });

    expect(stale).toEqual(["task-691-postgres-1", "task-691-redis-1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Detected 2 stale task containers"));
  });

  test("detectStaleContainers returns empty array when none match", async () => {
    mockExecFileSync.mockReturnValue(
      "project-web-1\nproject-worker-1" as unknown as ReturnType<typeof execFileSync>,
    );

    const stale = await detectStaleContainers();
    expect(stale).toEqual([]);
  });

  test("detectStaleContainers returns empty array on docker command failure", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("docker not found");
    });

    const warn = jest.fn();
    const stale = await detectStaleContainers({ warn });
    expect(stale).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unable to scan docker containers"));
  });

  test("uses a canonical executable, trusted cwd, and scrubbed environment", () => {
    const secretName = "QUACK_DOCKER_CLEANUP_TEST_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-leak";
    mockExecFileSync.mockReturnValue("");

    try {
      expect(cleanupWorktreeContainers(worktreePath)).toBe(true);
      const [executable, , options] = mockExecFileSync.mock.calls[0];
      expect(executable).toBe(trustedDocker);
      expect(options).toEqual(
        expect.objectContaining({
          cwd: path.dirname(trustedDocker),
          shell: false,
          windowsHide: true,
        }),
      );
      expect(options?.env?.[secretName]).toBeUndefined();
      expect(options?.env?.PATH).toContain(path.dirname(trustedDocker));
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  });

  test("ignores a docker executable shadow inside the mutable worktree", () => {
    _setDockerExecutableForTests(undefined);
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "quack-docker-resolution-"));
    const mutableRoot = path.join(fixtureRoot, "worktree");
    const trustedRoot = path.join(fixtureRoot, "host-bin");
    const executableName = process.platform === "win32" ? "docker.exe" : "docker";
    const shadow = path.join(mutableRoot, executableName);
    const trusted = path.join(trustedRoot, executableName);
    mkdirSync(mutableRoot);
    mkdirSync(trustedRoot);
    writeFileSync(shadow, "shadow");
    writeFileSync(trusted, "trusted");
    if (process.platform !== "win32") {
      chmodSync(shadow, 0o755);
      chmodSync(trusted, 0o755);
    }

    try {
      expect(
        resolveTrustedDockerExecutable([mutableRoot], {
          PATH: [mutableRoot, trustedRoot].join(path.delimiter),
        }),
      ).toBe(realpathSync.native(trusted));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
