import { existsSync, symlinkSync, mkdirSync, lstatSync, readdirSync } from "node:fs";

jest.mock("../../src/dispatcher/trusted-git", () => ({
  runTrustedGitSync: jest.fn(),
}));

jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  symlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  lstatSync: jest.fn(),
  readdirSync: jest.fn(),
}));

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  cleanupWorktreeContainers: jest.fn(),
}));

import { cleanupWorktreeContainers } from "../../src/dispatcher/docker-cleanup";
import { runTrustedGitSync } from "../../src/dispatcher/trusted-git";
import {
  removeWorktree,
  prepareWorktreeFrontendDeps,
} from "../../src/dispatcher/worktree-lifecycle";

const mockRunTrustedGitSync = runTrustedGitSync as jest.MockedFunction<typeof runTrustedGitSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockSymlinkSync = symlinkSync as jest.MockedFunction<typeof symlinkSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockLstatSync = lstatSync as jest.MockedFunction<typeof lstatSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockCleanupWorktreeContainers = cleanupWorktreeContainers as jest.MockedFunction<
  typeof cleanupWorktreeContainers
>;

describe("worktree-lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTrustedGitSync.mockReturnValue("");
    mockCleanupWorktreeContainers.mockReturnValue(true);
  });

  test("uses trusted Docker metadata cleanup before removing the worktree", () => {
    expect(removeWorktree("/wt/TASK-826", "TASK-826", "/project")).toBe(true);

    expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith("/wt/TASK-826", expect.any(Object));
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/wt/TASK-826"],
      "/project",
      expect.objectContaining({ trustedBoundaryRoot: "/project" }),
    );
  });

  test("preserves the worktree when trusted Docker cleanup cannot prove absence", () => {
    mockCleanupWorktreeContainers.mockReturnValue(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(removeWorktree("/wt/TASK-826", "TASK-826", "/project")).toBe(false);

    expect(mockRunTrustedGitSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("preserving worktree"));
    errorSpy.mockRestore();
  });

  test("git worktree remove failure is logged at error level and does not throw", () => {
    mockExistsSync.mockReturnValue(false);
    mockRunTrustedGitSync.mockImplementation(() => {
      throw new Error("worktree locked");
    });

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(removeWorktree("/wt/TASK-826", "TASK-826", "/project")).toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("git worktree remove failed"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("TASK-826"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("worktree locked"));

    errorSpy.mockRestore();
  });

  test("skips Docker cleanup when dockerCleanup is false", () => {
    removeWorktree("/wt/TASK-826", "TASK-826", "/project", false);

    expect(mockCleanupWorktreeContainers).not.toHaveBeenCalled();
    expect(mockRunTrustedGitSync).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/wt/TASK-826"],
      "/project",
      expect.objectContaining({ trustedBoundaryRoot: "/project" }),
    );
  });
});

describe("worktree-lifecycle prepareWorktreeFrontendDeps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTrustedGitSync.mockReturnValue("");
    mockReaddirSync.mockReturnValue([]);
  });

  test("creates symlink when source exists and target is missing", () => {
    // source (frontend/node_modules in project root) exists
    mockExistsSync.mockImplementation((p) => {
      const value = String(p).replace(/\\/g, "/");
      return value.endsWith("frontend/node_modules") && value.includes("project");
    });
    // lstatSync throws ENOENT — target does not exist
    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = prepareWorktreeFrontendDeps("/wt/TASK-915", "/project", "TASK-915");

    expect(result).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("frontend"),
      expect.objectContaining({ recursive: true }),
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("node_modules"),
      expect.stringContaining("node_modules"),
      "junction",
    );
  });

  test("creates symlinks for frontends/*/node_modules layouts", () => {
    mockExistsSync.mockImplementation((p) => {
      const value = String(p).replace(/\\/g, "/");
      return (
        value.endsWith("/project/frontends") ||
        value.endsWith("/project/frontends/web-dashboard/node_modules") ||
        value.endsWith("/project/frontends/admin-portal/node_modules")
      );
    });
    mockReaddirSync.mockReturnValue([
      { name: "web-dashboard", isDirectory: () => true },
      { name: "admin-portal", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ] as unknown as ReturnType<typeof readdirSync>);
    mockLstatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = prepareWorktreeFrontendDeps("/wt/TASK-915", "/project", "TASK-915");

    expect(result).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("frontends"),
      expect.objectContaining({ recursive: true }),
    );
    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("web-dashboard"),
      expect.stringContaining("web-dashboard"),
      "junction",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("admin-portal"),
      expect.stringContaining("admin-portal"),
      "junction",
    );
  });

  test("returns false and warns when no frontend node_modules source is found", () => {
    // source does not exist
    mockExistsSync.mockReturnValue(false);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = prepareWorktreeFrontendDeps("/wt/TASK-915", "/project", "TASK-915");

    expect(result).toBe(false);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no frontend node_modules found"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("relevant frontend npm install"));

    warnSpy.mockRestore();
  });

  test("returns true and skips symlink when target already exists (idempotent)", () => {
    // source exists
    mockExistsSync.mockReturnValue(true);
    // lstatSync succeeds — target already exists
    mockLstatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof lstatSync>);

    const result = prepareWorktreeFrontendDeps("/wt/TASK-915", "/project", "TASK-915");

    expect(result).toBe(true);
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });
});
