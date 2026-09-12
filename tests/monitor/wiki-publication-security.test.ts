const mockRunTrustedGitResult = jest.fn();
const mockResolveOriginRepository = jest.fn();
const mockResolveBoundOriginRepository = jest.fn();

jest.mock("../../src/worker/trusted-executable", () => ({
  ...jest.requireActual<object>("../../src/worker/trusted-executable"),
  runTrustedGitResult: (...args: unknown[]) => mockRunTrustedGitResult(...args) as Promise<unknown>,
}));

jest.mock("../../src/dispatcher/github-repository", () => ({
  ...jest.requireActual<object>("../../src/dispatcher/github-repository"),
  resolveOriginRepository: (...args: unknown[]) =>
    mockResolveOriginRepository(...args) as Promise<unknown>,
  resolveBoundOriginRepository: (...args: unknown[]) =>
    mockResolveBoundOriginRepository(...args) as Promise<unknown>,
}));

import { pushWikiChanges } from "../../src/monitor/routes/wiki";

const ROOT = "C:\\trusted-wiki";
const HEAD = "1".repeat(40);
const OTHER = "2".repeat(40);
const ORIGIN = {
  pushUrl: "https://github.com/example/wiki.git",
  pushUrlHash: "a".repeat(64),
  github: {
    selector: "github.com/example/wiki",
    host: "github.com",
    nameWithOwner: "example/wiki",
  },
};

function installGit(
  remoteOutput?: string,
  branchValue: string | null | (() => string | null) = "main",
  headValue: string | (() => string) = HEAD,
): void {
  mockRunTrustedGitResult.mockImplementation((_root: string, args: readonly string[]) => {
    const command = args.join(" ");
    const branch = typeof branchValue === "function" ? branchValue() : branchValue;
    const head = typeof headValue === "function" ? headValue() : headValue;
    if (command === "rev-parse --is-inside-work-tree") {
      return Promise.resolve({ exitCode: 0, stdout: "true\n", stderr: "" });
    }
    if (command === "symbolic-ref --quiet HEAD") {
      return branch
        ? Promise.resolve({ exitCode: 0, stdout: `refs/heads/${branch}\n`, stderr: "" })
        : Promise.resolve({ exitCode: 1, stdout: "", stderr: "detached HEAD" });
    }
    if (
      command === "rev-parse --verify HEAD^{commit}" ||
      command === `rev-parse --verify refs/heads/${branch}^{commit}`
    ) {
      return Promise.resolve({ exitCode: 0, stdout: `${head}\n`, stderr: "" });
    }
    if (command === "status --porcelain=v1 -b -uall") {
      return Promise.resolve({
        exitCode: 0,
        stdout: branch ? `## ${branch}...origin/${branch} [ahead 1]\n` : "## HEAD (no branch)\n",
        stderr: "",
      });
    }
    if (command === "rev-parse HEAD") {
      return Promise.resolve({ exitCode: 0, stdout: `${head}\n`, stderr: "" });
    }
    if (args[0] === "push") {
      return Promise.resolve({ exitCode: 0, stdout: "pushed\n", stderr: "" });
    }
    if (args[0] === "ls-remote") {
      return Promise.resolve({
        exitCode: 0,
        stdout: remoteOutput ?? `${head}\trefs/heads/${branch}\n`,
        stderr: "",
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  });
  mockResolveOriginRepository.mockResolvedValue(ORIGIN);
  mockResolveBoundOriginRepository.mockResolvedValue(ORIGIN);
}

function calledGitCommand(command: string): boolean {
  return mockRunTrustedGitResult.mock.calls.some(
    ([, args]) => (args as readonly string[])[0] === command,
  );
}

describe("wiki publication security boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installGit();
  });

  it("publishes the exact HEAD OID to the bound origin and verifies readback", async () => {
    const result = await pushWikiChanges(ROOT, {});

    expect(result.ok).toBe(true);
    expect(mockRunTrustedGitResult).toHaveBeenCalledWith(
      ROOT,
      ["push", ORIGIN.pushUrl, `${HEAD}:refs/heads/main`],
      expect.objectContaining({
        expectedRepository: { host: "github.com", owner: "example", repo: "wiki" },
      }),
    );
    expect(mockRunTrustedGitResult).toHaveBeenCalledWith(
      ROOT,
      ["ls-remote", "--heads", ORIGIN.pushUrl, "refs/heads/main"],
      expect.objectContaining({
        expectedRepository: { host: "github.com", owner: "example", repo: "wiki" },
      }),
    );
    expect(
      mockRunTrustedGitResult.mock.calls.some(([, args]) =>
        (args as readonly string[]).some((value) => value.startsWith("HEAD:")),
      ),
    ).toBe(false);
  });

  it("publishes a dotted branch from its exact symbolic ref", async () => {
    installGit(undefined, "release/1.2");

    await expect(pushWikiChanges(ROOT, {})).resolves.toMatchObject({
      ok: true,
      git: { branch: "release/1.2", upstream: "origin/release/1.2" },
    });
    expect(mockRunTrustedGitResult).toHaveBeenCalledWith(
      ROOT,
      ["push", ORIGIN.pushUrl, `${HEAD}:refs/heads/release/1.2`],
      expect.anything(),
    );
  });

  it("rejects detached HEAD before binding or pushing", async () => {
    installGit(undefined, null);

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow("active branch");
    expect(mockResolveOriginRepository).not.toHaveBeenCalled();
    expect(calledGitCommand("push")).toBe(false);
  });

  it("rejects branch drift after origin binding", async () => {
    let branch = "main";
    installGit(undefined, () => branch);
    mockResolveBoundOriginRepository.mockImplementationOnce(() => {
      branch = "release";
      return Promise.resolve(ORIGIN);
    });

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow("changed before publication");
    expect(calledGitCommand("push")).toBe(false);
  });

  it("rejects HEAD drift after origin binding", async () => {
    let head = HEAD;
    installGit(undefined, "main", () => head);
    mockResolveBoundOriginRepository.mockImplementationOnce(() => {
      head = OTHER;
      return Promise.resolve(ORIGIN);
    });

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow("changed before publication");
    expect(calledGitCommand("push")).toBe(false);
  });

  it("refuses a request-selected branch instead of publishing a caller-selected ref", async () => {
    await expect(pushWikiChanges(ROOT, { branch: "release" })).rejects.toThrow(
      "current safe branch",
    );
    expect(mockResolveOriginRepository).not.toHaveBeenCalled();
  });

  it("fails closed when origin changes after capture", async () => {
    mockResolveBoundOriginRepository.mockRejectedValueOnce(
      new Error("Git origin changed after publication was bound"),
    );

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow(
      /Failed to bind wiki publication origin.*origin changed/iu,
    );
    expect(
      mockRunTrustedGitResult.mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(false);
  });

  it("rejects a remote readback at a different object ID", async () => {
    installGit(`${OTHER}\trefs/heads/main\n`);

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow(
      `Wiki push readback mismatch: expected ${HEAD}, received ${OTHER}`,
    );
  });

  it("rejects ambiguous exact-ref readback", async () => {
    installGit(`${HEAD}\trefs/heads/main\n${OTHER}\trefs/heads/main\n`);

    await expect(pushWikiChanges(ROOT, {})).rejects.toThrow(/received no exact remote ref/iu);
  });

  it("refuses to change upstream configuration during publication", async () => {
    await expect(pushWikiChanges(ROOT, { setUpstream: true })).rejects.toThrow(
      "does not change upstream configuration",
    );
    expect(mockResolveOriginRepository).not.toHaveBeenCalled();
  });
});
