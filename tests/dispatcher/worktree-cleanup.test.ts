import * as path from "node:path";

const mockReadTrustedCoreWorktree = jest.fn<string | undefined, [string]>();
const mockUnsetTrustedCoreWorktree = jest.fn<boolean, [string, string]>();

jest.mock("../../src/worker/trusted-executable", () => ({
  readTrustedCoreWorktree: (root: string) => mockReadTrustedCoreWorktree(root),
  unsetTrustedCoreWorktree: (root: string, value: string) =>
    mockUnsetTrustedCoreWorktree(root, value),
}));

import {
  cleanCoreWorktreeIfLeaked,
  safeUnsetCoreWorktree,
} from "../../src/dispatcher/worktree-cleanup";

describe("worktree-cleanup", () => {
  const repoPath = process.platform === "win32" ? "C:\\repo" : "/repo";
  const managedPath =
    process.platform === "win32"
      ? "C:\\repo\\.quack\\worktrees\\TASK-893-A"
      : "/repo/.quack/worktrees/TASK-893-A";

  beforeEach(() => {
    mockReadTrustedCoreWorktree.mockReset();
    mockUnsetTrustedCoreWorktree.mockReset();
  });

  test("removes an exact value inside this project's managed worktree root", async () => {
    mockReadTrustedCoreWorktree.mockReturnValue(managedPath);
    mockUnsetTrustedCoreWorktree.mockReturnValue(true);
    const emit = jest.fn();

    await expect(
      safeUnsetCoreWorktree(repoPath, { emit } as unknown as Parameters<
        typeof safeUnsetCoreWorktree
      >[1]),
    ).resolves.toEqual({ leaked: true, cleaned: true, leakedValue: managedPath });
    expect(mockUnsetTrustedCoreWorktree).toHaveBeenCalledWith(repoPath, managedPath);
    expect(emit).toHaveBeenCalledWith("core_worktree_cleaned", {
      repoPath,
      leakedValue: managedPath,
    });
  });

  test("does not remove a similarly named path outside this project", async () => {
    const foreign =
      process.platform === "win32"
        ? "C:\\other\\.quack\\worktrees\\TASK-893-A"
        : "/other/.quack/worktrees/TASK-893-A";
    mockReadTrustedCoreWorktree.mockReturnValue(foreign);

    await expect(safeUnsetCoreWorktree(repoPath)).resolves.toEqual({
      leaked: true,
      cleaned: false,
      leakedValue: foreign,
    });
    expect(mockUnsetTrustedCoreWorktree).not.toHaveBeenCalled();
  });

  test("does not allow traversal that merely contains the managed path name", async () => {
    const traversal = `.quack${path.sep}worktrees${path.sep}..${path.sep}..${path.sep}foreign`;
    mockReadTrustedCoreWorktree.mockReturnValue(traversal);

    const result = await safeUnsetCoreWorktree(repoPath);

    expect(result).toMatchObject({ leaked: true, cleaned: false });
    expect(mockUnsetTrustedCoreWorktree).not.toHaveBeenCalled();
  });

  test("is a no-op when core.worktree is absent or empty", async () => {
    mockReadTrustedCoreWorktree.mockReturnValueOnce(undefined).mockReturnValueOnce("  ");

    await expect(safeUnsetCoreWorktree(repoPath)).resolves.toEqual({
      leaked: false,
      cleaned: false,
    });
    await expect(safeUnsetCoreWorktree(repoPath)).resolves.toEqual({
      leaked: false,
      cleaned: false,
    });
  });

  test("reports a bounded repair failure without throwing", async () => {
    mockReadTrustedCoreWorktree.mockReturnValue(managedPath);
    mockUnsetTrustedCoreWorktree.mockImplementation(() => {
      throw new Error("locked");
    });

    await expect(safeUnsetCoreWorktree(repoPath)).resolves.toEqual({
      leaked: true,
      cleaned: false,
      leakedValue: managedPath,
    });
  });

  test("repair-state delegates to the same trusted cleanup", async () => {
    mockReadTrustedCoreWorktree.mockReturnValue(managedPath);
    mockUnsetTrustedCoreWorktree.mockReturnValue(true);

    await expect(cleanCoreWorktreeIfLeaked(repoPath)).resolves.toEqual({
      leaked: true,
      cleaned: true,
      leakedValue: managedPath,
    });
  });
});
