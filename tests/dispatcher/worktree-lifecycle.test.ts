import { execSync } from "node:child_process";
import { existsSync, symlinkSync, mkdirSync, lstatSync, readdirSync } from "node:fs";

jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  symlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  lstatSync: jest.fn(),
  readdirSync: jest.fn(),
}));

jest.mock("../../src/testing/docker-test-runner", () => ({
  tearDown: jest.fn(),
}));

import { tearDown } from "../../src/testing/docker-test-runner";
import {
  removeWorktree,
  prepareWorktreeFrontendDeps,
} from "../../src/dispatcher/worktree-lifecycle";

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockSymlinkSync = symlinkSync as jest.MockedFunction<typeof symlinkSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockLstatSync = lstatSync as jest.MockedFunction<typeof lstatSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockTearDown = tearDown as jest.MockedFunction<typeof tearDown>;

describe("worktree-lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("" as unknown as ReturnType<typeof execSync>);
  });

  test("calls tearDown when compose file is present in worktree root", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("docker-compose.yml"));

    removeWorktree("/wt/TASK-826", "TASK-826", "/project");

    expect(mockTearDown).toHaveBeenCalledWith(
      expect.stringContaining("docker-compose.yml"),
      "/wt/TASK-826",
      60_000,
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object),
    );
  });

  test("skips tearDown when no compose file exists in worktree root", () => {
    mockExistsSync.mockReturnValue(false);

    removeWorktree("/wt/TASK-826", "TASK-826", "/project");

    expect(mockTearDown).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object),
    );
  });

  test("proceeds with git worktree remove even when tearDown logs a warning", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("docker-compose.yml"));
    // tearDown itself doesn't throw (it logs); simulate it completing normally
    mockTearDown.mockImplementation(() => {
      // no-op — warning already logged inside tearDown
    });

    expect(() => removeWorktree("/wt/TASK-826", "TASK-826", "/project")).not.toThrow();

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object),
    );
  });

  test("git worktree remove failure is logged at error level and does not throw", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error("worktree locked");
    });

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => removeWorktree("/wt/TASK-826", "TASK-826", "/project")).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("git worktree remove failed"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("TASK-826"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("worktree locked"));

    errorSpy.mockRestore();
  });

  test("skips tearDown when dockerCleanup is false", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("docker-compose.yml"));

    removeWorktree("/wt/TASK-826", "TASK-826", "/project", false);

    expect(mockTearDown).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree remove"),
      expect.any(Object),
    );
  });
});

describe("worktree-lifecycle prepareWorktreeFrontendDeps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("" as unknown as ReturnType<typeof execSync>);
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
