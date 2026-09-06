import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { TestSuiteResult, TestFailure } from "../../src/core/types.js";

// Mock smart-test-runner
jest.mock("../../src/testing/smart-test-runner.js", () => ({
  runSmartTests: jest.fn(),
}));

// Mock fs
jest.mock("node:fs", () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import * as fs from "node:fs";
import { runSmartTests } from "../../src/testing/smart-test-runner.js";
import {
  captureBaseline,
  loadBaseline,
  compareWithBaseline,
} from "../../src/testing/test-baseline.js";

const mockRunSmartTests = runSmartTests as ReturnType<typeof jest.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof jest.fn>;
const mockWriteFileSync = fs.writeFileSync as ReturnType<typeof jest.fn>;
const mockMkdirSync = fs.mkdirSync as ReturnType<typeof jest.fn>;

function makeResult(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
  return {
    totalTests: 10,
    passed: 8,
    failed: 2,
    skipped: 0,
    durationMs: 5000,
    suites: [],
    failures: [],
    exitCode: 1,
    timestamp: "2026-03-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeFailure(overrides: Partial<TestFailure> = {}): TestFailure {
  return {
    suitePath: "/tests/foo.test.ts",
    ancestorTitles: ["describe"],
    testName: "test1",
    fullName: "describe test1",
    message: "Expected true to be false",
    ...overrides,
  };
}

describe("test-baseline", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("captureBaseline", () => {
    it("runs smart tests in baseline mode and writes result", () => {
      const result = makeResult({ failed: 0, exitCode: 0 });
      mockRunSmartTests.mockReturnValue(result);
      mockMkdirSync.mockReturnValue(undefined);

      const baseline = captureBaseline("/work", "main", ".quack/test-results", "TASK-001");

      expect(mockRunSmartTests).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "baseline",
          taskId: "TASK-001-baseline",
        }),
      );
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(baseline.totalTests).toBe(10);
    });
  });

  describe("loadBaseline", () => {
    it("returns null when no baseline file exists", () => {
      mockExistsSync.mockReturnValue(false);
      const result = loadBaseline("/output", "TASK-001");
      expect(result).toBeNull();
    });

    it("loads and parses existing baseline", () => {
      const stored = makeResult();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));

      const result = loadBaseline("/output", "TASK-001");
      expect(result).not.toBeNull();
      expect(result?.totalTests).toBe(10);
    });

    it("returns null on parse error", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");

      const result = loadBaseline("/output", "TASK-001");
      expect(result).toBeNull();
    });
  });

  describe("compareWithBaseline", () => {
    it("classifies pre-existing failures correctly", () => {
      const sharedFailure = makeFailure({ testName: "known-broken" });
      const baseline = makeResult({ failures: [sharedFailure] });
      const current = makeResult({ failures: [sharedFailure] });

      const comparison = compareWithBaseline(current, baseline);

      expect(comparison.preExisting).toHaveLength(1);
      expect(comparison.newFailures).toHaveLength(0);
      expect(comparison.newlyFixed).toHaveLength(0);
      expect(comparison.allFailuresPreExisting).toBe(true);
    });

    it("classifies new failures correctly", () => {
      const baseline = makeResult({ failures: [] });
      const newFail = makeFailure({ testName: "agent-broke-this" });
      const current = makeResult({ failures: [newFail] });

      const comparison = compareWithBaseline(current, baseline);

      expect(comparison.preExisting).toHaveLength(0);
      expect(comparison.newFailures).toHaveLength(1);
      expect(comparison.allFailuresPreExisting).toBe(false);
    });

    it("classifies newly fixed tests correctly", () => {
      const wasFailingBefore = makeFailure({ testName: "was-broken" });
      const baseline = makeResult({ failures: [wasFailingBefore] });
      const current = makeResult({ failures: [] });

      const comparison = compareWithBaseline(current, baseline);

      expect(comparison.newlyFixed).toHaveLength(1);
      expect(comparison.preExisting).toHaveLength(0);
      expect(comparison.newFailures).toHaveLength(0);
      expect(comparison.allFailuresPreExisting).toBe(true);
    });

    it("handles mixed scenario: pre-existing + new + fixed", () => {
      const preExistingFail = makeFailure({ testName: "known-broken" });
      const fixedFail = makeFailure({ testName: "got-fixed" });
      const newFail = makeFailure({ testName: "agent-broke-this" });

      const baseline = makeResult({ failures: [preExistingFail, fixedFail] });
      const current = makeResult({ failures: [preExistingFail, newFail] });

      const comparison = compareWithBaseline(current, baseline);

      expect(comparison.preExisting).toHaveLength(1);
      expect(comparison.newFailures).toHaveLength(1);
      expect(comparison.newlyFixed).toHaveLength(1);
      expect(comparison.allFailuresPreExisting).toBe(false);
    });

    it("returns allFailuresPreExisting=true when current has no failures", () => {
      const baseline = makeResult({ failures: [] });
      const current = makeResult({ failures: [] });

      const comparison = compareWithBaseline(current, baseline);

      expect(comparison.allFailuresPreExisting).toBe(true);
    });
  });
});
