import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

// Mock fs
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
}));

// Mock worktree-env
jest.mock("../../src/utils/worktree-env.js", () => ({
  worktreeEnv: jest.fn(() => ({ ...process.env })),
}));

import { runTieredTests } from "../../src/testing/test-runner.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import * as childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;
const mockExistsSync = existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof jest.fn>;

describe("test-runner", () => {
  let mockAdapter: ProjectAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAdapter = {
      projectRoot: "/test/project",
      config: {
        verification: {
          commands: [],
          conventionChecks: [],
          tieredTesting: {
            enabled: true,
            tier3Frequency: 5,
            outputDir: ".quack/test-results",
          },
        },
        git: {
          baseBranch: "main",
        },
      },
    } as unknown as ProjectAdapter;
  });

  it("returns empty result when no test files for Tier 1", async () => {
    const result = await runTieredTests("TASK-601", 1, [], mockAdapter, "/test/project");

    expect(result.tier).toBe(1);
    expect(result.ran).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("runs specific test files for Tier 1 and parses results", async () => {
    const jestOutput = {
      success: true,
      testResults: [
        {
          name: "tests/unit/auth.test.js",
          startTime: 1000,
          endTime: 2000,
          assertionResults: [
            { title: "should login", fullName: "Auth should login", status: "passed" },
            { title: "should logout", fullName: "Auth should logout", status: "passed" },
          ],
        },
      ],
    };

    mockExecSync.mockReturnValue(""); // Jest execution
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(jestOutput));

    const testFiles = ["tests/unit/auth.test.js"];
    const result = await runTieredTests("TASK-601", 1, testFiles, mockAdapter, "/test/project");

    expect(result.tier).toBe(1);
    expect(result.ran).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(0);

    // Should have called execSync with the test files
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("npx jest");
    expect(cmd).toContain("tests/unit/auth.test.js");
  });

  it("runs full suite for Tier 3 without file arguments", async () => {
    const jestOutput = {
      success: false,
      testResults: [
        {
          name: "tests/unit/auth.test.js",
          assertionResults: [
            { title: "test1", fullName: "test1", status: "passed" },
            {
              title: "test2",
              fullName: "test2",
              status: "failed",
              failureMessages: ["Expected true to be false"],
              ancestorTitles: ["Suite"],
            },
          ],
        },
      ],
    };

    mockExecSync.mockImplementation(() => {
      throw new Error("Tests failed"); // Jest exit code 1
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(jestOutput));

    const result = await runTieredTests("TASK-601", 3, [], mockAdapter, "/test/project");

    expect(result.tier).toBe(3);
    expect(result.ran).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("test2");

    // Tier 3 should NOT have file arguments
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("npx jest");
    expect(cmd).toContain("--json");
    expect(cmd).not.toContain("tests/unit/auth.test.js");
  });

  it("uses Docker command when configured", async () => {
    mockAdapter.config.verification.tieredTesting = {
      enabled: true,
      dockerCommand: "docker compose --profile testing run --rm test-runner",
      tier3Frequency: 5,
      outputDir: ".quack/test-results",
    };

    mockExecSync.mockReturnValue("");
    mockExistsSync.mockReturnValue(false); // No JSON output file

    const testFiles = ["tests/unit/auth.test.js"];
    await runTieredTests("TASK-601", 1, testFiles, mockAdapter, "/test/project");

    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("docker compose --profile testing run --rm test-runner");
    expect(cmd).toContain("npx jest");
  });

  it("handles JSON output file not found gracefully", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    mockExistsSync.mockReturnValue(false); // No output file

    const testFiles = ["tests/unit/auth.test.js"];
    const result = await runTieredTests("TASK-601", 1, testFiles, mockAdapter, "/test/project");

    expect(result.ran).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(1);
  });
});
