import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { SmartTestConfig } from "../../src/core/types.js";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

// Mock fs
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import {
  getChangedFiles,
  parseJestOutput,
  runSmartTests,
} from "../../src/testing/smart-test-runner.js";

const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof jest.fn>;
const mockStatSync = fs.statSync as ReturnType<typeof jest.fn>;
const mockMkdirSync = fs.mkdirSync as ReturnType<typeof jest.fn>;

describe("smart-test-runner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: .git is a directory (not a worktree)
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  describe("getChangedFiles", () => {
    it("returns changed files from git diff", () => {
      mockExecSync
        .mockReturnValueOnce("abc123\n") // merge-base
        .mockReturnValueOnce("src/foo.ts\nsrc/bar.ts\n"); // diff --name-only

      const files = getChangedFiles("/work", "main");
      expect(files).toEqual(["src/foo.ts", "src/bar.ts"]);
    });

    it("returns empty array on git error", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not a git repo");
      });

      const files = getChangedFiles("/work", "main");
      expect(files).toEqual([]);
    });

    it("returns empty array when merge-base is empty", () => {
      mockExecSync.mockReturnValueOnce("\n"); // empty merge-base

      const files = getChangedFiles("/work", "main");
      expect(files).toEqual([]);
    });
  });

  describe("parseJestOutput", () => {
    it("returns empty result when file does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      const result = parseJestOutput("/nonexistent.json");
      expect(result.totalTests).toBe(0);
      expect(result.exitCode).toBe(1);
    });

    it("parses valid Jest JSON output", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          success: true,
          testResults: [
            {
              name: "/work/tests/foo.test.ts",
              startTime: 1000,
              endTime: 2000,
              assertionResults: [
                {
                  title: "test1",
                  fullName: "suite test1",
                  status: "passed",
                  ancestorTitles: ["suite"],
                  failureMessages: [],
                },
                {
                  title: "test2",
                  fullName: "suite test2",
                  status: "passed",
                  ancestorTitles: ["suite"],
                  failureMessages: [],
                },
              ],
            },
          ],
        }),
      );

      const result = parseJestOutput("/results.json");
      expect(result.totalTests).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(result.suites).toHaveLength(1);
    });

    it("captures failures with messages", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          success: false,
          testResults: [
            {
              name: "/work/tests/bar.test.ts",
              startTime: 1000,
              endTime: 3000,
              assertionResults: [
                {
                  title: "passes",
                  fullName: "bar passes",
                  status: "passed",
                  ancestorTitles: ["bar"],
                  failureMessages: [],
                },
                {
                  title: "fails",
                  fullName: "bar fails",
                  status: "failed",
                  ancestorTitles: ["bar"],
                  failureMessages: ["Expected 1 to be 2"],
                },
              ],
            },
          ],
        }),
      );

      const result = parseJestOutput("/results.json");
      expect(result.totalTests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].testName).toBe("fails");
      expect(result.failures[0].message).toContain("Expected 1 to be 2");
    });

    it("handles invalid JSON gracefully", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");

      const result = parseJestOutput("/bad.json");
      expect(result.totalTests).toBe(0);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("runSmartTests", () => {
    const baseConfig: SmartTestConfig = {
      mode: "full",
      workDir: "/work",
      baseBranch: "main",
      outputDir: ".quack/test-results",
      taskId: "TASK-001",
      timeout: 60000,
    };

    it("runs full suite in full mode", () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockExecSync.mockReturnValue(""); // jest exits 0
      // parseJestOutput reads the output file
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          success: true,
          testResults: [
            {
              name: "test.ts",
              startTime: 0,
              endTime: 100,
              assertionResults: [
                {
                  title: "t1",
                  fullName: "t1",
                  status: "passed",
                  ancestorTitles: [],
                  failureMessages: [],
                },
              ],
            },
          ],
        }),
      );

      const result = runSmartTests(baseConfig);
      expect(result.totalTests).toBe(1);
      expect(result.passed).toBe(1);
    });

    it("uses --findRelatedTests with changed .ts files in related mode", () => {
      mockMkdirSync.mockReturnValue(undefined);
      let capturedCmd = "";
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("merge-base")) return "abc123\n";
        if (cmdStr.includes("diff --name-only")) return "src/foo.ts\nsrc/bar.ts\n";
        // Capture the jest command
        if (cmdStr.includes("jest")) {
          capturedCmd = cmdStr;
          return "";
        }
        return "";
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ success: true, testResults: [] }));

      runSmartTests({ ...baseConfig, mode: "related" });

      expect(capturedCmd).toContain("--findRelatedTests");
      expect(capturedCmd).toContain("src/foo.ts");
      expect(capturedCmd).toContain("src/bar.ts");
    });

    it("falls back to full suite when related finds no changed files", () => {
      mockMkdirSync.mockReturnValue(undefined);
      // getChangedFiles: merge-base fails → empty array
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("merge-base")) throw new Error("fail");
        return "";
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ success: true, testResults: [] }));

      const result = runSmartTests({ ...baseConfig, mode: "related" });
      expect(result.totalTests).toBe(0);
      expect(result.exitCode).toBe(0);
    });

    it("handles Jest exit code 1 (test failures) without throwing", () => {
      mockMkdirSync.mockReturnValue(undefined);
      // First call: Jest command throws (exit code 1)
      mockExecSync.mockImplementation(() => {
        throw new Error("exit code 1");
      });
      // parseJestOutput: file exists with failure data
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          success: false,
          testResults: [
            {
              name: "test.ts",
              startTime: 0,
              endTime: 100,
              assertionResults: [
                {
                  title: "t1",
                  fullName: "t1",
                  status: "failed",
                  ancestorTitles: [],
                  failureMessages: ["boom"],
                },
              ],
            },
          ],
        }),
      );

      const result = runSmartTests(baseConfig);
      expect(result.failed).toBe(1);
      expect(result.exitCode).toBe(1);
    });
  });
});
