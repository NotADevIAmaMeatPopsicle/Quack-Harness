// ─── Test Dashboard API Tests ─────────────────────────────────────
// Tests for aggregate test dashboard endpoint and history persistence.

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import express from "express";
import type { Request, Response } from "express";
import { registerTestResultsRoutes } from "../../src/monitor/routes/test-results.js";
import type { TestDashboardData, TestSuiteResult } from "../../src/core/types.js";

jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(() => ({ mtimeMs: Date.now() })),
  unlinkSync: jest.fn(),
  appendFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import * as fs from "node:fs";

const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof jest.fn>;
const mockReaddirSync = fs.readdirSync as ReturnType<typeof jest.fn>;

function mockReqRes(params = {}, query = {}) {
  const req = { params, query } as unknown as Request;
  const statusFn = jest.fn().mockReturnThis();
  const jsonFn = jest.fn().mockReturnThis();
  const res = { status: statusFn, json: jsonFn } as unknown as Response;
  return { req, res, statusFn, jsonFn };
}

describe("test dashboard API", () => {
  let handlers: Record<string, (req: Request, res: Response) => void>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};
    const fakeApp = {
      get: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
        handlers[path] = handler;
      }),
      post: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
        handlers[path] = handler;
      }),
    } as unknown as ReturnType<typeof express>;
    registerTestResultsRoutes(fakeApp, () => ({ projectRoot: "/test" }));
  });

  describe("GET /api/testing/dashboard", () => {
    it("returns empty structure when no results exist", () => {
      mockExistsSync.mockReturnValue(false);
      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          latest: null,
          taskResults: [],
          slowestSuites: [],
          flakyTests: [],
          recentManualRuns: [],
          commandHealth: [],
        }),
      );
    });

    it("computes aggregate metrics from multiple result files", () => {
      const mockResult1: TestSuiteResult = {
        totalTests: 100,
        passed: 90,
        failed: 10,
        skipped: 0,
        durationMs: 5000,
        suites: [
          { path: "suite1.test.ts", passed: 50, failed: 5, skipped: 0, duration: 2500 },
          { path: "suite2.test.ts", passed: 40, failed: 5, skipped: 0, duration: 2500 },
        ],
        failures: [
          {
            suitePath: "suite1.test.ts",
            ancestorTitles: ["describe block"],
            testName: "failing test",
            fullName: "describe block failing test",
            message: "error",
          },
        ],
        exitCode: 1,
        baseline: {
          preExisting: [],
          newFailures: [
            {
              suitePath: "suite1.test.ts",
              ancestorTitles: ["describe block"],
              testName: "failing test",
              fullName: "describe block failing test",
              message: "error",
            },
          ],
          newlyFixed: [],
          allFailuresPreExisting: false,
        },
        timestamp: "2026-03-15T12:00:00.000Z",
      };

      const mockResult2: TestSuiteResult = {
        totalTests: 95,
        passed: 85,
        failed: 10,
        skipped: 0,
        durationMs: 4800,
        suites: [
          { path: "suite1.test.ts", passed: 45, failed: 5, skipped: 0, duration: 2400 },
          { path: "suite2.test.ts", passed: 40, failed: 5, skipped: 0, duration: 2400 },
        ],
        failures: [],
        exitCode: 1,
        timestamp: "2026-03-14T12:00:00.000Z",
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["TASK-001-result.json", "TASK-002-result.json"] as never[]);

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("TASK-001")) {
          return JSON.stringify(mockResult1);
        }
        if (filePath.includes("TASK-002")) {
          return JSON.stringify(mockResult2);
        }
        if (filePath.includes("test-history.jsonl")) {
          return "";
        }
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.latest).not.toBeNull();
      expect(data.latest?.totalTests).toBe(100);
      expect(data.latest?.passed).toBe(90);
      expect(data.latest?.taskId).toBe("TASK-001");
      expect(data.taskResults).toHaveLength(2);
      expect(data.taskResults[0].taskId).toBe("TASK-001");
      expect(data.taskResults[0].newFailures).toBe(1);
    });

    it("identifies tests failing across multiple task results (flaky test detection)", () => {
      const sharedFailure = {
        suitePath: "flaky.test.ts",
        ancestorTitles: ["suite"],
        testName: "flaky test",
        fullName: "suite flaky test",
        message: "intermittent error",
      };

      const mockResult1: TestSuiteResult = {
        totalTests: 10,
        passed: 9,
        failed: 1,
        skipped: 0,
        durationMs: 1000,
        suites: [{ path: "flaky.test.ts", passed: 9, failed: 1, skipped: 0, duration: 1000 }],
        failures: [sharedFailure],
        exitCode: 1,
        timestamp: "2026-03-15T12:00:00.000Z",
      };

      const mockResult2: TestSuiteResult = {
        totalTests: 10,
        passed: 9,
        failed: 1,
        skipped: 0,
        durationMs: 1000,
        suites: [{ path: "flaky.test.ts", passed: 9, failed: 1, skipped: 0, duration: 1000 }],
        failures: [sharedFailure],
        exitCode: 1,
        timestamp: "2026-03-14T12:00:00.000Z",
      };

      const mockResult3: TestSuiteResult = {
        totalTests: 10,
        passed: 9,
        failed: 1,
        skipped: 0,
        durationMs: 1000,
        suites: [{ path: "flaky.test.ts", passed: 9, failed: 1, skipped: 0, duration: 1000 }],
        failures: [sharedFailure],
        exitCode: 1,
        timestamp: "2026-03-13T12:00:00.000Z",
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        "TASK-001-result.json",
        "TASK-002-result.json",
        "TASK-003-result.json",
      ] as never[]);

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("TASK-001")) return JSON.stringify(mockResult1);
        if (filePath.includes("TASK-002")) return JSON.stringify(mockResult2);
        if (filePath.includes("TASK-003")) return JSON.stringify(mockResult3);
        if (filePath.includes("test-history.jsonl")) return "";
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.flakyTests).toHaveLength(1);
      expect(data.flakyTests[0].fullName).toBe("suite flaky test");
      expect(data.flakyTests[0].failureCount).toBe(3);
      expect(data.flakyTests[0].taskIds).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    });

    it("computes slowest suites by averaging durations", () => {
      const mockResult1: TestSuiteResult = {
        totalTests: 100,
        passed: 100,
        failed: 0,
        skipped: 0,
        durationMs: 10000,
        suites: [
          { path: "slow.test.ts", passed: 50, failed: 0, skipped: 0, duration: 8000 },
          { path: "fast.test.ts", passed: 50, failed: 0, skipped: 0, duration: 2000 },
        ],
        failures: [],
        exitCode: 0,
        timestamp: "2026-03-15T12:00:00.000Z",
      };

      const mockResult2: TestSuiteResult = {
        totalTests: 100,
        passed: 100,
        failed: 0,
        skipped: 0,
        durationMs: 10000,
        suites: [
          { path: "slow.test.ts", passed: 50, failed: 0, skipped: 0, duration: 6000 },
          { path: "fast.test.ts", passed: 50, failed: 0, skipped: 0, duration: 4000 },
        ],
        failures: [],
        exitCode: 0,
        timestamp: "2026-03-14T12:00:00.000Z",
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["TASK-001-result.json", "TASK-002-result.json"] as never[]);

      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("TASK-001")) return JSON.stringify(mockResult1);
        if (filePath.includes("TASK-002")) return JSON.stringify(mockResult2);
        if (filePath.includes("test-history.jsonl")) return "";
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.slowestSuites).toHaveLength(2);
      expect(data.slowestSuites[0].path).toBe("slow.test.ts");
      expect(data.slowestSuites[0].avgDurationMs).toBe(7000); // (8000 + 6000) / 2
      expect(data.slowestSuites[1].path).toBe("fast.test.ts");
      expect(data.slowestSuites[1].avgDurationMs).toBe(3000); // (2000 + 4000) / 2
    });

    it("loads history from JSONL and includes in response (history persistence)", () => {
      const mockHistoryLines = [
        JSON.stringify({
          name: "test",
          command: "npm test",
          exitCode: 0,
          durationMs: 5000,
          startedAt: "2026-03-15T10:00:00.000Z",
          finishedAt: "2026-03-15T10:00:05.000Z",
          projectId: "/test",
        }),
        JSON.stringify({
          name: "lint",
          command: "npm run lint",
          exitCode: 0,
          durationMs: 1000,
          startedAt: "2026-03-15T10:05:00.000Z",
          finishedAt: "2026-03-15T10:05:01.000Z",
          projectId: "/test",
        }),
      ].join("\n");

      mockExistsSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-results")) return true;
        if (filePath.includes("test-history.jsonl")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue([] as never[]);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-history.jsonl")) return mockHistoryLines;
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.recentManualRuns).toHaveLength(2);
      expect(data.recentManualRuns[0].name).toBe("test");
      expect(data.recentManualRuns[1].name).toBe("lint");
    });

    it("handles missing history file gracefully (doesn't exist on first run)", () => {
      mockExistsSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-results")) return true;
        if (filePath.includes("test-history.jsonl")) return false;
        return false;
      });
      mockReaddirSync.mockReturnValue([] as never[]);

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.recentManualRuns).toEqual([]);
      expect(data.commandHealth).toEqual([]);
    });

    it("limits history to last 100 entries when loading (oldest trimmed)", () => {
      const historyLines = Array.from({ length: 150 }, (_, i) =>
        JSON.stringify({
          name: `test-${i}`,
          command: "npm test",
          exitCode: 0,
          durationMs: 1000,
          startedAt: `2026-03-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
          finishedAt: `2026-03-15T${String(i % 24).padStart(2, "0")}:00:01.000Z`,
        }),
      ).join("\n");

      mockExistsSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-results")) return true;
        if (filePath.includes("test-history.jsonl")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue([] as never[]);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-history.jsonl")) return historyLines;
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      // Should load last 100 from file, but only display last 20 in recentManualRuns
      // The full history is available for commandHealth computation
      expect(data.recentManualRuns.length).toBeLessThanOrEqual(20);
      expect(data.commandHealth.length).toBeGreaterThan(0);
    });

    it("caches results for 30s (cache invalidation after 30s)", () => {
      const mockResult: TestSuiteResult = {
        totalTests: 100,
        passed: 100,
        failed: 0,
        skipped: 0,
        durationMs: 5000,
        suites: [],
        failures: [],
        exitCode: 0,
        timestamp: "2026-03-15T12:00:00.000Z",
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["TASK-001-result.json"] as never[]);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("TASK-001")) return JSON.stringify(mockResult);
        if (filePath.includes("test-history.jsonl")) return "";
        return "[]";
      });

      const originalDateNow = Date.now;
      let currentTime = 1000000;
      Date.now = () => currentTime;

      try {
        const { req, res } = mockReqRes();

        // First call - should hit disk
        handlers["/api/testing/dashboard"](req, res);
        expect(mockReaddirSync).toHaveBeenCalledTimes(2);

        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(["TASK-001-result.json"] as never[]);
        mockReadFileSync.mockImplementation((filePath: string) => {
          if (filePath.includes("TASK-001")) return JSON.stringify(mockResult);
          if (filePath.includes("test-history.jsonl")) return "";
          return "[]";
        });

        // Second call within 30s - should use cache
        currentTime += 15_000; // 15s later
        handlers["/api/testing/dashboard"](req, res);
        expect(mockReaddirSync).not.toHaveBeenCalled();

        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(["TASK-001-result.json"] as never[]);
        mockReadFileSync.mockImplementation((filePath: string) => {
          if (filePath.includes("TASK-001")) return JSON.stringify(mockResult);
          if (filePath.includes("test-history.jsonl")) return "";
          return "[]";
        });

        // Third call after 30s - cache should expire, hit disk again
        currentTime += 20_000; // 35s total from first call
        handlers["/api/testing/dashboard"](req, res);
        expect(mockReaddirSync).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it("computes command health with recent pass rate", () => {
      const historyLines = [
        // test command: 7 passes, 3 failures in last 10 runs
        ...Array.from({ length: 7 }, (_, i) =>
          JSON.stringify({
            name: "test",
            command: "npm test",
            exitCode: 0,
            durationMs: 5000,
            startedAt: `2026-03-15T${String(i).padStart(2, "0")}:00:00.000Z`,
            finishedAt: `2026-03-15T${String(i).padStart(2, "0")}:00:05.000Z`,
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          JSON.stringify({
            name: "test",
            command: "npm test",
            exitCode: 1,
            durationMs: 5000,
            startedAt: `2026-03-15T${String(i + 7).padStart(2, "0")}:00:00.000Z`,
            finishedAt: `2026-03-15T${String(i + 7).padStart(2, "0")}:00:05.000Z`,
          }),
        ),
      ].join("\n");

      mockExistsSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-results")) return true;
        if (filePath.includes("test-history.jsonl")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue([] as never[]);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes("test-history.jsonl")) return historyLines;
        return "[]";
      });

      const { req, res, jsonFn } = mockReqRes();
      handlers["/api/testing/dashboard"](req, res);

      const data = jsonFn.mock.calls[0][0] as TestDashboardData;
      expect(data.commandHealth).toHaveLength(1);
      expect(data.commandHealth[0].name).toBe("test");
      expect(data.commandHealth[0].lastExitCode).toBe(1);
      expect(data.commandHealth[0].recentPassRate).toBe(70); // 7/10 = 70%
    });
  });
});

// ─── TestRunner Persistence Tests ─────────────────────────────────
// Tests for TestRunner JSONL history persistence (writes JSONL and loads on startup).

// Additional mocks used by TestRunner persistence tests.
const mockAppendFileSync = (fs as unknown as Record<string, ReturnType<typeof jest.fn>>)
  .appendFileSync;
const mockMkdirSync = (fs as unknown as Record<string, ReturnType<typeof jest.fn>>).mkdirSync;

// Mock child_process to prevent actual process spawning and satisfy promisify(execFile)
jest.mock("node:child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const actual = jest.requireActual("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    ...(actual as Record<string, unknown>),
    spawn: jest.fn(),
    execSync: jest.fn(),
  };
});

import { spawn } from "node:child_process";
import { TestRunner } from "../../src/monitor/server.js";

const mockSpawn = spawn as ReturnType<typeof jest.fn>;

describe("TestRunner persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads history from JSONL on construction (loads on startup)", () => {
    const historyEntries = [
      JSON.stringify({
        name: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: 5000,
        startedAt: "2026-03-15T10:00:00.000Z",
        finishedAt: "2026-03-15T10:00:05.000Z",
        projectId: "/proj",
      }),
      JSON.stringify({
        name: "lint",
        command: "npm run lint",
        exitCode: 0,
        durationMs: 1000,
        startedAt: "2026-03-15T10:05:00.000Z",
        finishedAt: "2026-03-15T10:05:01.000Z",
        projectId: "/proj",
      }),
    ].join("\n");

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(historyEntries);

    const runner = new TestRunner("/proj", () => {});
    const history = runner.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].name).toBe("test");
    expect(history[1].name).toBe("lint");
  });

  it("handles missing history file on first run — created on first write", () => {
    mockExistsSync.mockReturnValue(false);

    const runner = new TestRunner("/proj", () => {});
    const history = runner.getHistory();
    expect(history).toHaveLength(0);
    // readFileSync should not be called when file doesn't exist
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("writes JSONL entry via saveHistoryEntry when test completes (history persistence writes JSONL)", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes("test-history.jsonl")) return false;
      if (p.includes("logs")) return false;
      return false;
    });

    const runner = new TestRunner("/proj", () => {});

    // Simulate the close event by accessing the private saveHistoryEntry method
    // through a test-only path — invoke start() and trigger close
    const mockProc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      pid: 12345,
    };
    mockSpawn.mockReturnValue(mockProc);

    runner.start("test", "npm test");

    // Find the "close" handler and invoke it
    const closeCall = mockProc.on.mock.calls.find((call: unknown[]) => call[0] === "close");
    expect(closeCall).toBeDefined();
    const closeHandler = closeCall![1] as (code: number) => void;

    // Mock existsSync for saveHistoryEntry's dir check
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("logs")) return false;
      return true;
    });

    closeHandler(0);

    // Verify appendFileSync was called with JSONL data
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const writtenLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(writtenLine).toContain('"name":"test"');
    expect(writtenLine).toContain('"projectId":"/proj"');
    expect(writtenLine.endsWith("\n")).toBe(true);
  });

  it("limits in-memory history to 50 entries", () => {
    // Pre-populate with 50 entries via loadHistory
    const historyLines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({
        name: `test-${i}`,
        command: "npm test",
        exitCode: 0,
        durationMs: 1000,
        startedAt: `2026-03-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        finishedAt: `2026-03-15T${String(i % 24).padStart(2, "0")}:00:01.000Z`,
      }),
    ).join("\n");

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(historyLines);

    const runner = new TestRunner("/proj", () => {});
    expect(runner.getHistory()).toHaveLength(50);

    // Now simulate one more run completing — should trim to 50
    const mockProc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      pid: 12345,
    };
    mockSpawn.mockReturnValue(mockProc);

    runner.start("extra-test", "npm test");

    const closeCall = mockProc.on.mock.calls.find((call: unknown[]) => call[0] === "close");
    const closeHandler = closeCall![1] as (code: number) => void;
    closeHandler(0);

    const history = runner.getHistory();
    // Should be exactly 50 (oldest trimmed)
    expect(history).toHaveLength(50);
    // First entry should be test-1 (test-0 trimmed), last should be extra-test
    expect(history[history.length - 1].name).toBe("extra-test");
    expect(history[0].name).toBe("test-1");
  });
});
