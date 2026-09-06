import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { TestSuiteResult } from "../../src/core/types.js";

// Mock fs for writeTestArtifact
jest.mock("node:fs", () => ({
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import * as fs from "node:fs";
import {
  formatTestSummary,
  formatTestDetails,
  writeTestArtifact,
} from "../../src/testing/test-formatter.js";

const mockWriteFileSync = fs.writeFileSync as ReturnType<typeof jest.fn>;

function makeResult(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
  return {
    totalTests: 47,
    passed: 45,
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

describe("test-formatter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("formatTestSummary", () => {
    it("formats result without baseline", () => {
      const result = makeResult();
      const summary = formatTestSummary(result);
      expect(summary).toContain("47 tests:");
      expect(summary).toContain("45 passed");
      expect(summary).toContain("2 failed");
    });

    it("formats result with baseline showing pre-existing", () => {
      const result = makeResult({
        baseline: {
          preExisting: [
            { suitePath: "a", ancestorTitles: [], testName: "t1", fullName: "t1", message: "" },
            { suitePath: "a", ancestorTitles: [], testName: "t2", fullName: "t2", message: "" },
          ],
          newFailures: [],
          newlyFixed: [],
          allFailuresPreExisting: true,
        },
      });

      const summary = formatTestSummary(result);
      expect(summary).toContain("2 pre-existing");
      expect(summary).not.toContain("new failure");
    });

    it("formats result with new failures and pre-existing", () => {
      const result = makeResult({
        baseline: {
          preExisting: [
            { suitePath: "a", ancestorTitles: [], testName: "t1", fullName: "t1", message: "" },
          ],
          newFailures: [
            { suitePath: "a", ancestorTitles: [], testName: "t2", fullName: "t2", message: "err" },
          ],
          newlyFixed: [],
          allFailuresPreExisting: false,
        },
      });

      const summary = formatTestSummary(result);
      expect(summary).toContain("1 new failure");
      expect(summary).toContain("1 pre-existing");
    });

    it("includes skipped count when present", () => {
      const result = makeResult({ skipped: 3 });
      const summary = formatTestSummary(result);
      expect(summary).toContain("3 skipped");
    });
  });

  describe("formatTestDetails", () => {
    it("includes full error message for new failures", () => {
      const result = makeResult({
        baseline: {
          preExisting: [],
          newFailures: [
            {
              suitePath: "/tests/foo.test.ts",
              ancestorTitles: ["describe"],
              testName: "fails",
              fullName: "describe fails",
              message: "Expected 1 to be 2",
            },
          ],
          newlyFixed: [],
          allFailuresPreExisting: false,
        },
      });

      const details = formatTestDetails(result);
      expect(details).toContain("New Failures");
      expect(details).toContain("MUST fix");
      expect(details).toContain("Expected 1 to be 2");
    });

    it("lists pre-existing failures by name only", () => {
      const result = makeResult({
        baseline: {
          preExisting: [
            {
              suitePath: "/tests/bar.test.ts",
              ancestorTitles: [],
              testName: "old-broken",
              fullName: "old-broken",
              message: "long error message that should not appear",
            },
          ],
          newFailures: [],
          newlyFixed: [],
          allFailuresPreExisting: true,
        },
      });

      const details = formatTestDetails(result);
      expect(details).toContain("Pre-existing Failures");
      expect(details).toContain("old-broken");
      expect(details).not.toContain("long error message that should not appear");
    });
  });

  describe("writeTestArtifact", () => {
    it("writes JSON to the specified path", () => {
      const result = makeResult();
      writeTestArtifact(result, "/out/result.json");

      expect(mockWriteFileSync).toHaveBeenCalledWith("/out/result.json", expect.any(String));

      const writtenJson = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson) as TestSuiteResult;
      expect(parsed.totalTests).toBe(47);
    });
  });
});
