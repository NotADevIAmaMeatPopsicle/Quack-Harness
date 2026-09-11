/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const execFileSync = jest.fn();
const inflateSync = jest.fn();

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  execFileSync,
  spawn: jest.fn(),
}));

jest.mock("node:zlib", () => ({ inflateSync }));

const { DockerManager } =
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

function managerInternals(root: string): SecurityInternals {
  const manager = new DockerManager(
    root,
    {
      image: "node:20-slim",
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

describe("Docker private Git security boundaries", () => {
  let root: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-private-git-security-"));
  });

  afterEach(() => {
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
    const privateGitDir = path.join(root, "private.git");
    const privateObjects = path.join(privateGitDir, "objects");
    const authoritativeObjects = path.join(root, "authoritative-objects");
    const inflated = Buffer.from("blob 3\0abc", "utf-8");
    const objectId = createHash("sha1").update(inflated).digest("hex");
    const source = path.join(privateObjects, objectId.slice(0, 2), objectId.slice(2));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(authoritativeObjects, { recursive: true });
    fs.writeFileSync(source, "not-even-compressed", "utf-8");
    execFileSync.mockReturnValue("");
    inflateSync.mockReturnValue(inflated);

    const container = {
      worktreePath: root,
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
    expect(gitCall[0]).toBe("git");
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
    const privateGitDir = path.join(root, "private.git");
    const privateObjects = path.join(privateGitDir, "objects");
    const authoritativeObjects = path.join(root, "authoritative-objects");
    const objectId = "a".repeat(40);
    const source = path.join(privateObjects, objectId.slice(0, 2), objectId.slice(2));
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(authoritativeObjects, { recursive: true });
    fs.writeFileSync(source, "compressed", "utf-8");
    execFileSync.mockReturnValue(`${objectId}\n`);
    inflateSync.mockReturnValue({ length: 512 * 1024 * 1024 + 1 });

    expect(() =>
      managerInternals(root).validatePrivateObjectsForInspection({
        worktreePath: root,
        privateGitDir,
        gitObjectsDir: authoritativeObjects,
        authoritativeHead: "b".repeat(40),
      } as import("../../src/dispatcher/docker-manager").DockerContainer),
    ).toThrow(/aggregate safety boundary/u);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
