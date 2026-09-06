import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { normalize } from "node:path";

// Mock fs before importing the module
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

import {
  loadBaseline,
  saveBaseline,
  diffAgainstBaseline,
} from "../../src/testing/baseline-manager.js";
import type { BaselineResult, TieredTestResult } from "../../src/testing/types.js";
import type { TestFailure } from "../../src/core/types.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mockExistsSync = existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof jest.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof jest.fn>;

describe("baseline-manager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("loadBaseline", () => {
    it("returns null when no baseline file exists", () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadBaseline("/project");
      expect(result).toBeNull();
    });

    it("loads and parses a baseline file", () => {
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 543,
        totalFailing: 59,
        failures: [
          {
            suitePath: "src/tests/unit/services/auth.test.js",
            ancestorTitles: ["AuthService"],
            testName: "should validate token",
            fullName: "AuthService should validate token",
            message: "Expected true to be false",
          },
        ],
        source: "/project/.quack/test-results/baseline.json",
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(baseline));

      const result = loadBaseline("/project");
      expect(result).toEqual(baseline);
    });

    it("returns null when baseline file is corrupt JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json{{{");

      const result = loadBaseline("/project");
      expect(result).toBeNull();
    });

    it("uses custom output directory", () => {
      mockExistsSync.mockReturnValue(false);

      loadBaseline("/project", "custom/test-output");
      // Should check the custom path (normalize for cross-platform)
      const calledPath = mockExistsSync.mock.calls[0][0] as string;
      expect(normalize(calledPath)).toContain(normalize("custom/test-output"));
    });
  });

  describe("saveBaseline", () => {
    it("saves baseline from clean Tier 3 results", () => {
      mockExistsSync.mockReturnValue(false); // No existing baseline

      const results: TieredTestResult = {
        tier: 3,
        ran: 543,
        passed: 543,
        failed: 0,
        skipped: 0,
        files: [],
        durationMs: 15000,
        exitCode: 0,
        failures: [],
      };

      saveBaseline("/project", results);

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenJson = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string) as {
        totalTests: number;
        totalFailing: number;
      };
      expect(writtenJson.totalTests).toBe(543);
      expect(writtenJson.totalFailing).toBe(0);
    });

    it("saves baseline when failure count improves over existing", () => {
      const existingBaseline: BaselineResult = {
        timestamp: "2026-03-20T04:00:00Z",
        totalTests: 543,
        totalFailing: 10,
        failures: [],
        source: "/project/.quack/test-results/baseline.json",
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingBaseline));

      const results: TieredTestResult = {
        tier: 3,
        ran: 543,
        passed: 538,
        failed: 5, // Improved from 10 to 5
        skipped: 0,
        files: [],
        durationMs: 15000,
        exitCode: 1,
        failures: [],
      };

      saveBaseline("/project", results);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it("does NOT save baseline when failure count regresses", () => {
      const existingBaseline: BaselineResult = {
        timestamp: "2026-03-20T04:00:00Z",
        totalTests: 543,
        totalFailing: 5,
        failures: [],
        source: "/project/.quack/test-results/baseline.json",
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingBaseline));

      const results: TieredTestResult = {
        tier: 3,
        ran: 543,
        passed: 530,
        failed: 13, // Worse than baseline's 5
        skipped: 0,
        files: [],
        durationMs: 15000,
        exitCode: 1,
        failures: [],
      };

      saveBaseline("/project", results);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("diffAgainstBaseline", () => {
    const makeFailure = (name: string): TestFailure => ({
      suitePath: "test.js",
      ancestorTitles: ["Suite"],
      testName: name,
      fullName: `Suite ${name}`,
      message: `${name} failed`,
    });

    it("classifies all failures as new when baseline has none", () => {
      const current = [makeFailure("test1"), makeFailure("test2")];
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 100,
        totalFailing: 0,
        failures: [],
        source: "baseline.json",
      };

      const diff = diffAgainstBaseline(current, baseline);
      expect(diff.newFailures).toHaveLength(2);
      expect(diff.preExisting).toHaveLength(0);
    });

    it("classifies all failures as pre-existing when all match baseline", () => {
      const current = [makeFailure("test1"), makeFailure("test2")];
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 100,
        totalFailing: 2,
        failures: [makeFailure("test1"), makeFailure("test2")],
        source: "baseline.json",
      };

      const diff = diffAgainstBaseline(current, baseline);
      expect(diff.newFailures).toHaveLength(0);
      expect(diff.preExisting).toHaveLength(2);
    });

    it("separates new from pre-existing in mixed results", () => {
      const current = [
        makeFailure("test1"), // pre-existing
        makeFailure("test3"), // new
      ];
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 100,
        totalFailing: 2,
        failures: [makeFailure("test1"), makeFailure("test2")],
        source: "baseline.json",
      };

      const diff = diffAgainstBaseline(current, baseline);
      expect(diff.newFailures).toHaveLength(1);
      expect(diff.newFailures[0].testName).toBe("test3");
      expect(diff.preExisting).toHaveLength(1);
      expect(diff.preExisting[0].testName).toBe("test1");
    });

    it("handles empty current results (all passing)", () => {
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 100,
        totalFailing: 3,
        failures: [makeFailure("test1"), makeFailure("test2"), makeFailure("test3")],
        source: "baseline.json",
      };

      const diff = diffAgainstBaseline([], baseline);
      expect(diff.newFailures).toHaveLength(0);
      expect(diff.preExisting).toHaveLength(0);
    });

    it("handles empty baseline (no prior run)", () => {
      const current = [makeFailure("test1")];
      const baseline: BaselineResult = {
        timestamp: "2026-03-21T04:00:00Z",
        totalTests: 0,
        totalFailing: 0,
        failures: [],
        source: "baseline.json",
      };

      const diff = diffAgainstBaseline(current, baseline);
      expect(diff.newFailures).toHaveLength(1);
      expect(diff.preExisting).toHaveLength(0);
    });
  });
});
