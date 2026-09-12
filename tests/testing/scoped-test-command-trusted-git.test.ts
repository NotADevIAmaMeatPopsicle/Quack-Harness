import { collectScopedTestFiles } from "../../src/testing/scoped-test-command.js";
import { runTrustedGitSync } from "../../src/dispatcher/trusted-git.js";

jest.mock("../../src/dispatcher/trusted-git.js", () => ({
  runTrustedGitSync: jest.fn(),
}));

const mockedGit = runTrustedGitSync as jest.MockedFunction<typeof runTrustedGitSync>;

describe("collectScopedTestFiles trusted Git boundary", () => {
  beforeEach(() => {
    mockedGit.mockReset();
  });

  it("uses structured trusted Git arguments and NUL-delimited paths", () => {
    mockedGit
      .mockReturnValueOnce("abc123\n")
      .mockReturnValueOnce("tests/a.test.ts\0src/value.ts\0tests/space name.spec.ts\0");

    expect(collectScopedTestFiles(undefined, "C:\\safe-worktree", "main")).toEqual([
      "tests/a.test.ts",
      "tests/space name.spec.ts",
    ]);
    expect(mockedGit).toHaveBeenNthCalledWith(
      1,
      ["merge-base", "origin/main", "HEAD"],
      "C:\\safe-worktree",
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(mockedGit).toHaveBeenNthCalledWith(
      2,
      ["diff", "--name-only", "-z", "abc123..HEAD"],
      "C:\\safe-worktree",
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("fails closed to planned files when the base branch is unsafe", () => {
    const task = {
      filesToModify: [{ path: "tests/planned.test.ts", action: "modify", notes: "" }],
    } as unknown as Parameters<typeof collectScopedTestFiles>[0];

    expect(collectScopedTestFiles(task, "C:\\safe-worktree", "main;evil")).toEqual([
      "tests/planned.test.ts",
    ]);
    expect(mockedGit).not.toHaveBeenCalled();
  });
});
