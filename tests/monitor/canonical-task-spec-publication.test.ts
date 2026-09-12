const mockRunTrustedGitSync = jest.fn();
const mockResolveOriginRepository = jest.fn();
const mockResolveBoundOriginRepository = jest.fn();

jest.mock("../../src/dispatcher/trusted-git", () => ({
  ...jest.requireActual<object>("../../src/dispatcher/trusted-git"),
  runTrustedGitSync: (...args: unknown[]) => mockRunTrustedGitSync(...args) as string,
}));

jest.mock("../../src/dispatcher/github-repository", () => ({
  ...jest.requireActual<object>("../../src/dispatcher/github-repository"),
  resolveOriginRepository: (...args: unknown[]) =>
    mockResolveOriginRepository(...args) as Promise<unknown>,
  resolveBoundOriginRepository: (...args: unknown[]) =>
    mockResolveBoundOriginRepository(...args) as Promise<unknown>,
}));

import { commitCanonicalTaskSpecChange } from "../../src/monitor/server";

const PROJECT_ROOT = "C:\\quack-publication-fixture";
const TASK_FILE = `${PROJECT_ROOT}\\docs\\tasks\\TASK-001-test.md`;
const BASE_OID = "0".repeat(40);
const COMMIT_OID = "1".repeat(40);
const OTHER_OID = "2".repeat(40);
const TREE_OID = "3".repeat(40);
const EXPECTED_TASK_CONTENT = "# TASK-001: authorized replacement\n";
const ORIGIN = {
  pushUrl: "https://github.com/example/quack.git",
  pushUrlHash: "a".repeat(64),
  github: {
    selector: "github.com/example/quack",
    host: "github.com",
    nameWithOwner: "example/quack",
  },
};

function installSuccessfulGit(
  branchValue: string | (() => string) = "dev",
  remoteOid = COMMIT_OID,
  options: {
    afterTaskStaged?: () => void;
    afterCommit?: () => void;
    headAfterCommit?: string;
    parentAfterCommit?: string;
    readbackError?: Error;
    stagedTaskContent?: string;
    updateRefError?: Error;
  } = {},
): void {
  let committed = false;
  mockRunTrustedGitSync.mockImplementation((args: readonly string[]) => {
    const command = args.join(" ");
    const branch = typeof branchValue === "function" ? branchValue() : branchValue;
    const headOid = committed ? (options.headAfterCommit ?? COMMIT_OID) : BASE_OID;
    if (command === "rev-parse --is-inside-work-tree") return "true\n";
    if (command === "symbolic-ref --quiet HEAD") return `refs/heads/${branch}\n`;
    if (
      command === "rev-parse --verify HEAD^{commit}" ||
      command === `rev-parse --verify refs/heads/${branch}^{commit}`
    ) {
      return `${headOid}\n`;
    }
    if (command === "diff --cached --name-only") {
      const calls = mockRunTrustedGitSync.mock.calls.filter(
        ([candidate]) => (candidate as readonly string[]).join(" ") === command,
      );
      if (calls.length === 1) return "";
      options.afterTaskStaged?.();
      return "docs/tasks/TASK-001-test.md\n";
    }
    if (command === "write-tree") return `${TREE_OID}\n`;
    if (command === `diff-tree --no-commit-id --name-only -r ${BASE_OID} ${TREE_OID}`) {
      return "docs/tasks/TASK-001-test.md\n";
    }
    if (command === `show ${TREE_OID}:docs/tasks/TASK-001-test.md`) {
      return options.stagedTaskContent ?? EXPECTED_TASK_CONTENT;
    }
    if (args[0] === "commit-tree") return `${COMMIT_OID}\n`;
    if (args[0] === "update-ref") {
      if (options.updateRefError) throw options.updateRefError;
      committed = true;
      options.afterCommit?.();
      return "";
    }
    if (command === `rev-list --parents -n 1 ${headOid}`) {
      return `${headOid} ${options.parentAfterCommit ?? BASE_OID}\n`;
    }
    if (command === `diff-tree --no-commit-id --name-only -r ${headOid}`) {
      return "docs/tasks/TASK-001-test.md\n";
    }
    if (args[0] === "ls-remote") {
      if (options.readbackError) throw options.readbackError;
      return `${remoteOid}\trefs/heads/${branch}\n`;
    }
    return "";
  });
  mockResolveOriginRepository.mockResolvedValue(ORIGIN);
  mockResolveBoundOriginRepository.mockResolvedValue(ORIGIN);
}

describe("canonical task-spec publication boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects an unsafe target branch before binding, staging, or committing", async () => {
    installSuccessfulGit("dev:attacker");

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: false,
      committed: false,
      pushed: false,
      branch: "dev:attacker",
      skippedReason: "unsafe_target_branch",
    });
    expect(mockResolveOriginRepository).not.toHaveBeenCalled();
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining(["add"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("fails closed before committing when origin has multiple push URLs", async () => {
    installSuccessfulGit();
    mockResolveOriginRepository.mockRejectedValue(
      new Error("Git origin must have exactly one push URL for GitHub publication"),
    );

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({ attempted: false, committed: false, pushed: false });
    expect(result.error).toMatch(/exactly one push URL/iu);
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining(["commit"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("retains committed:true,pushed:false when the bound origin drifts after commit", async () => {
    installSuccessfulGit();
    mockResolveBoundOriginRepository.mockRejectedValue(
      new Error("Git origin changed after publication was bound"),
    );

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: true,
      pushed: false,
      branch: "dev",
      commitSha: COMMIT_OID,
    });
    expect(result.error).toMatch(/origin verification failed.*origin changed/iu);
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining(["push"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("pushes the captured commit OID to the bound concrete origin and verifies readback", async () => {
    installSuccessfulGit();

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: true,
      pushed: true,
      branch: "dev",
      commitSha: COMMIT_OID,
    });
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["update-ref", "-m", "quack canonical task TASK-001", "refs/heads/dev", COMMIT_OID, BASE_OID],
      PROJECT_ROOT,
      expect.anything(),
    );
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["push", ORIGIN.pushUrl, `${COMMIT_OID}:refs/heads/dev`],
      PROJECT_ROOT,
      expect.objectContaining({
        expectedRepository: { host: "github.com", owner: "example", repo: "quack" },
      }),
    );
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringMatching(/^HEAD:/u)]),
      expect.anything(),
      expect.anything(),
    );
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["ls-remote", "--heads", ORIGIN.pushUrl, "refs/heads/dev"],
      PROJECT_ROOT,
      expect.anything(),
    );
  });

  it("refuses to commit after a concurrent checkout changes the inspected branch", async () => {
    let branch = "dev";
    installSuccessfulGit(() => branch, COMMIT_OID, {
      afterTaskStaged: () => {
        branch = "release";
      },
    });

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      allowedTargetBranches: ["dev"],
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: false,
      pushed: false,
      branch: "dev",
      skippedReason: "git_identity_changed",
    });
    expect(
      mockRunTrustedGitSync.mock.calls.some(
        ([args]) => (args as readonly string[])[0] === "commit-tree",
      ),
    ).toBe(false);
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["reset", "HEAD", "--", "docs/tasks/TASK-001-test.md"],
      PROJECT_ROOT,
      expect.anything(),
    );
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining(["push"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not publish a concurrent commit observed after its own commit", async () => {
    installSuccessfulGit("dev", COMMIT_OID, {
      headAfterCommit: OTHER_OID,
    });

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      allowedTargetBranches: ["dev"],
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: true,
      pushed: false,
      branch: "dev",
      commitSha: COMMIT_OID,
    });
    expect(result.error).toContain("changed after its exact commit was published");
    expect(mockRunTrustedGitSync).not.toHaveBeenCalledWith(
      expect.arrayContaining(["push"]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not commit staged task bytes that differ from the authorized replacement", async () => {
    installSuccessfulGit("dev", COMMIT_OID, {
      stagedTaskContent: "# TASK-001: concurrent replacement\n",
    });

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      allowedTargetBranches: ["dev"],
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: false,
      pushed: false,
      branch: "dev",
      skippedReason: "staged_task_changed",
    });
    expect(
      mockRunTrustedGitSync.mock.calls.some(
        ([args]) => (args as readonly string[])[0] === "commit-tree",
      ),
    ).toBe(false);
    expect(
      mockRunTrustedGitSync.mock.calls.some(([args]) => (args as readonly string[])[0] === "push"),
    ).toBe(false);
  });

  it("does not advance or push when the source branch compare-and-swap loses", async () => {
    installSuccessfulGit("dev", COMMIT_OID, {
      updateRefError: new Error("cannot lock ref: is at a different object"),
    });

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      allowedTargetBranches: ["dev"],
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: false,
      pushed: false,
      branch: "dev",
      skippedReason: "git_identity_changed",
    });
    expect(result.error).toContain("different object");
    expect(
      mockRunTrustedGitSync.mock.calls.some(([args]) => (args as readonly string[])[0] === "push"),
    ).toBe(false);
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["reset", "HEAD", "--", "docs/tasks/TASK-001-test.md"],
      PROJECT_ROOT,
      expect.anything(),
    );
  });

  it("reports a committed but unverified publication when remote readback mismatches", async () => {
    installSuccessfulGit("dev", OTHER_OID);

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: true,
      pushed: false,
      commitSha: COMMIT_OID,
    });
    expect(result.error).toContain(`expected ${COMMIT_OID}, received ${OTHER_OID}`);
  });

  it("reports a committed but unverified publication when remote readback fails", async () => {
    installSuccessfulGit("dev", COMMIT_OID, {
      readbackError: new Error("simulated readback failure"),
    });

    const result = await commitCanonicalTaskSpecChange(PROJECT_ROOT, "TASK-001", TASK_FILE, {
      expectedTaskContent: EXPECTED_TASK_CONTENT,
    });

    expect(result).toMatchObject({
      attempted: true,
      committed: true,
      pushed: false,
      commitSha: COMMIT_OID,
    });
    expect(result.error).toMatch(/simulated readback failure/iu);
  });
});
