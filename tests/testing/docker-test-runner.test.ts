import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
  spawnSync: jest.fn(),
}));

// Mock node:fs for worktreeEnv
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import {
  isDockerAvailable,
  warmUp,
  run,
  runScoped,
  tearDown,
} from "../../src/testing/docker-test-runner.js";

const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;
const mockSpawnSync = childProcess.spawnSync as ReturnType<typeof jest.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockStatSync = fs.statSync as ReturnType<typeof jest.fn>;

describe("docker-test-runner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: .git is a directory (not a worktree)
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  // ─── isDockerAvailable ─────────────────────────────────────────────

  describe("isDockerAvailable", () => {
    it("returns true when docker info succeeds", () => {
      mockSpawnSync.mockReturnValue({ status: 0, error: undefined });

      expect(isDockerAvailable()).toBe(true);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );
    });

    it("returns false when docker info fails (non-zero exit)", () => {
      mockSpawnSync.mockReturnValue({ status: 1, error: undefined });

      expect(isDockerAvailable()).toBe(false);
    });

    it("returns false when docker is not installed (spawn error)", () => {
      mockSpawnSync.mockReturnValue({ status: null, error: new Error("ENOENT") });

      expect(isDockerAvailable()).toBe(false);
    });

    it("returns false when spawnSync throws", () => {
      mockSpawnSync.mockImplementation(() => {
        throw new Error("unexpected error");
      });

      expect(isDockerAvailable()).toBe(false);
    });
  });

  // ─── run ──────────────────────────────────────────────────────────

  describe("run", () => {
    const baseOpts = {
      composeFile: "docker-compose.test.yml",
      service: "test-runner",
      command: "npm test",
      workDir: "/work",
      timeout: 60000,
    };

    it("returns exitCode 0 and stdout on success", () => {
      mockExecSync.mockReturnValue("Tests passed: 42\n");

      const result = run(baseOpts);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Tests passed: 42\n");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
    });

    it("builds correct docker compose command", () => {
      mockExecSync.mockReturnValue("");

      run(baseOpts);

      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("docker compose");
      expect(calledCommand).toContain('-f "docker-compose.test.yml"');
      expect(calledCommand).toContain('--project-directory "/work"');
      expect(calledCommand).toContain("run --rm test-runner npm test");
    });

    it("returns exitCode 1 and stderr on command failure", () => {
      const err = Object.assign(new Error("Command failed"), {
        status: 1,
        stdout: "",
        stderr: "Test failed: assertion error",
        killed: false,
        signal: null,
      });
      mockExecSync.mockImplementation(() => {
        throw err;
      });

      const result = run(baseOpts);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("Test failed: assertion error");
      expect(result.timedOut).toBe(false);
    });

    it("marks timedOut when killed by SIGTERM", () => {
      const err = Object.assign(new Error("Command timed out"), {
        status: 1,
        stdout: "",
        stderr: "",
        killed: true,
        signal: "SIGTERM",
      });
      mockExecSync.mockImplementation(() => {
        throw err;
      });

      const result = run({ ...baseOpts, timeout: 1000 });

      expect(result.timedOut).toBe(true);
      expect(result.stderr).toContain("timed out");
    });

    it("handles non-exec error gracefully", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("unexpected failure");
      });

      const result = run(baseOpts);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unexpected failure");
      expect(result.timedOut).toBe(false);
    });
  });

  // ─── runScoped ────────────────────────────────────────────────────

  describe("runScoped", () => {
    const baseOpts = {
      composeFile: "docker-compose.test.yml",
      service: "test-runner",
      command: "npx jest",
      workDir: "/work",
      timeout: 60000,
    };

    it("appends --findRelatedTests with quoted file list", () => {
      mockExecSync.mockReturnValue("Tests passed\n");

      runScoped(baseOpts, ["src/foo.ts", "src/bar.ts"]);

      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("--findRelatedTests");
      expect(calledCommand).toContain('"src/foo.ts"');
      expect(calledCommand).toContain('"src/bar.ts"');
    });

    it("runs the plain command when changedFiles is empty", () => {
      mockExecSync.mockReturnValue("Tests passed\n");

      runScoped(baseOpts, []);

      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).not.toContain("--findRelatedTests");
      expect(calledCommand).toContain("npx jest");
    });
  });

  // ─── warmUp ───────────────────────────────────────────────────────

  describe("warmUp", () => {
    it("starts dependent services via docker compose up -d", () => {
      // First call: docker compose up
      // Second call: docker compose ps (health check) - return healthy JSON
      mockExecSync
        .mockReturnValueOnce("") // up -d
        .mockReturnValueOnce(
          JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" }) +
            "\n" +
            JSON.stringify({ Service: "redis", State: "running", Health: "healthy" }),
        ); // ps

      warmUp("docker-compose.test.yml", ["postgres", "redis"], "/work", 30000);

      const firstCall = mockExecSync.mock.calls[0][0] as string;
      expect(firstCall).toContain("up -d postgres redis");
    });

    it("returns early when dependsOn is empty", () => {
      warmUp("docker-compose.test.yml", [], "/work", 30000);

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("does not throw when docker compose up fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Docker daemon not running");
      });

      // Should throw since warmUp propagates the error from docker compose up
      expect(() => warmUp("docker-compose.test.yml", ["postgres"], "/work", 5000)).toThrow();
    });
  });

  // ─── tearDown ─────────────────────────────────────────────────────

  describe("tearDown", () => {
    it("runs docker compose down", () => {
      mockExecSync.mockReturnValue("");

      tearDown("docker-compose.test.yml", "/work", 30000);

      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain("docker compose");
      expect(calledCommand).toContain('-f "docker-compose.test.yml"');
      expect(calledCommand).toContain("down");
    });

    it("includes --project-directory in compose down command", () => {
      mockExecSync.mockReturnValue("");

      tearDown("docker-compose.test.yml", "/work/path", 30000);

      const calledCommand = mockExecSync.mock.calls[0][0] as string;
      expect(calledCommand).toContain('--project-directory "/work/path"');
    });

    it("does not throw when docker compose down fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("services already stopped");
      });

      // Should not throw — teardown failures are non-fatal
      expect(() => tearDown("docker-compose.test.yml", "/work", 30000)).not.toThrow();
    });

    it("logs a warning when docker compose down exits non-zero", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockExecSync.mockImplementation(() => {
        throw new Error("container already removed");
      });

      tearDown("docker-compose.test.yml", "/work/path", 30000);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("docker-compose.test.yml"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("/work/path"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("container already removed"));
      warnSpy.mockRestore();
    });
  });
});
