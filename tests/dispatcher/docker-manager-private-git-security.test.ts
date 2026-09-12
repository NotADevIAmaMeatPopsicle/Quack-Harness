/* eslint-disable @typescript-eslint/no-require-imports */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileSync = jest.fn();
const inflateSync = jest.fn();
const runTrustedGitSync = jest.fn(() => "");

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  execFileSync,
  spawn: jest.fn(),
}));

jest.mock("node:zlib", () => ({ inflateSync }));

jest.mock("../../src/worker/trusted-executable", () => ({
  buildTrustedGitEnvironment: jest.fn(() => ({ PATH: path.dirname(process.execPath) })),
  resolveTrustedExecutable: jest.fn(() => process.execPath),
  runTrustedGitSync,
}));

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  resolveTrustedDockerExecutable: jest.fn(() => process.execPath),
  trustedDockerEnvironment: jest.fn(() => ({ PATH: path.dirname(process.execPath) })),
}));

const { DockerManager, TRUSTED_MANAGED_DOCKER_IMAGES_ENV } =
  require("../../src/dispatcher/docker-manager") as typeof import("../../src/dispatcher/docker-manager");

interface SecurityInternals {
  assertPrivateGitTreeSafe(privateGitDir: string): void;
  validatePrivateObjectsForInspection(
    container: import("../../src/dispatcher/docker-manager").DockerContainer,
  ): ReadonlyMap<string, unknown>;
  copyReachablePrivateObjects(
    container: import("../../src/dispatcher/docker-manager").DockerContainer,
    candidateHead: string,
    validated: ReadonlyMap<string, unknown>,
  ): void;
}

const TRUSTED_IMAGE = `node@sha256:${"a".repeat(64)}`;

function managerInternals(root: string): SecurityInternals {
  const manager = new DockerManager(
    root,
    {
      image: TRUSTED_IMAGE,
      volumes: [],
      envPassthrough: [],
      resourceLimits: { memoryMb: 512, cpus: 1 },
      networkMode: "none",
      cleanupPolicy: "remove",
    },
    path.join(root, "state"),
  );
  return manager as unknown as SecurityInternals;
}

function createPrivateGitLayout(root: string): {
  worktreePath: string;
  privateGitDir: string;
  authoritativeObjects: string;
} {
  const worktreePath = path.join(root, ".quack", "worktrees", "TASK-PRIVATE-GIT");
  const authoritativeGitDir = path.join(root, ".git", "worktrees", "TASK-PRIVATE-GIT");
  const authoritativeObjects = path.join(root, ".git", "objects");
  const privateGitDir = path.join(worktreePath, ".quack", "docker-git", "private.git");
  fs.mkdirSync(authoritativeGitDir, { recursive: true });
  fs.mkdirSync(authoritativeObjects, { recursive: true });
  fs.mkdirSync(path.join(privateGitDir, "objects"), { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${authoritativeGitDir}\n`, "utf-8");
  return { worktreePath, privateGitDir, authoritativeObjects };
}

describe("Docker private Git security boundaries", () => {
  let root: string;
  let previousTrustedImages: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-private-git-security-"));
    fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
    previousTrustedImages = process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
    process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = JSON.stringify([TRUSTED_IMAGE]);
  });

  afterEach(() => {
    if (previousTrustedImages === undefined) {
      delete process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV];
    } else {
      process.env[TRUSTED_MANAGED_DOCKER_IMAGES_ENV] = previousTrustedImages;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each(["refs/replace/deadbeef", "info/grafts", "shallow", "packed-refs", "commondir"])(
    "rejects graph-rewriting metadata before inspecting Git: %s",
    (relativePath) => {
      const privateGitDir = path.join(root, "private.git");
      const target = path.join(privateGitDir, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "untrusted\n", "utf-8");

      expect(() => managerInternals(root).assertPrivateGitTreeSafe(privateGitDir)).toThrow(
        /graph-rewriting metadata/u,
      );
    },
  );

  test("validates but does not import an unreachable loose object", () => {
    const { worktreePath, privateGitDir, authoritativeObjects } = createPrivateGitLayout(root);
    const privateObjects = path.join(privateGitDir, "objects");
    const inflated = Buffer.from("blob 3\0abc", "utf-8");
    const objectId = createHash("sha1").update(inflated).digest("hex");
    const source = path.join(privateObjects, objectId.slice(0, 2), objectId.slice(2));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "not-even-compressed", "utf-8");
    execFileSync.mockReturnValue("");
    inflateSync.mockReturnValue(inflated);

    const container = {
      worktreePath,
      privateGitDir,
      gitObjectsDir: authoritativeObjects,
      authoritativeHead: "b".repeat(40),
    } as import("../../src/dispatcher/docker-manager").DockerContainer;
    const internals = managerInternals(root);
    const validated = internals.validatePrivateObjectsForInspection(container);
    internals.copyReachablePrivateObjects(container, "c".repeat(40), validated);

    expect(inflateSync).toHaveBeenCalledTimes(1);
    const gitCall = execFileSync.mock.calls[0] as unknown as [
      string,
      string[],
      { maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv },
    ];
    expect(gitCall[0]).toBe(process.execPath);
    expect(gitCall[1]).toEqual(expect.arrayContaining(["rev-list", "--no-object-names"]));
    expect(gitCall[2]).toMatchObject({
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
    expect(gitCall[2].env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(
      fs.existsSync(path.join(authoritativeObjects, objectId.slice(0, 2), objectId.slice(2))),
    ).toBe(false);
  });

  test("rejects aggregate decompression beyond the bounded import budget", () => {
    const { worktreePath, privateGitDir, authoritativeObjects } = createPrivateGitLayout(root);
    const privateObjects = path.join(privateGitDir, "objects");
    const objectId = "a".repeat(40);
    const source = path.join(privateObjects, objectId.slice(0, 2), objectId.slice(2));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "compressed", "utf-8");
    inflateSync.mockReturnValue({ length: 512 * 1024 * 1024 + 1 });

    expect(() =>
      managerInternals(root).validatePrivateObjectsForInspection({
        worktreePath,
        privateGitDir,
        gitObjectsDir: authoritativeObjects,
        authoritativeHead: "b".repeat(40),
      } as import("../../src/dispatcher/docker-manager").DockerContainer),
    ).toThrow(/aggregate safety boundary/u);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
