import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import express from "express";
import type { Request, Response } from "express";

// Mock fs
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(),
}));

// Mock child_process
jest.mock("node:child_process", () => ({
  spawn: jest.fn(() => ({
    on: jest.fn(),
    unref: jest.fn(),
    pid: 12345,
  })),
}));

jest.mock("../../../src/core/adapter-loader.js", () => ({
  loadAdapter: jest.fn(),
  computeAdapterBundleMetadata: jest.fn(() => ({ sharedHash: "sha256:test" })),
}));

// Mock baseline-manager
jest.mock("../../../src/testing/baseline-manager.js", () => ({
  saveBaseline: jest.fn(),
  loadBaseline: jest.fn(),
  diffAgainstBaseline: jest.fn(),
}));

import { registerTestResultsRoutes } from "../../../src/monitor/routes/test-results.js";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { loadAdapter } from "../../../src/core/adapter-loader.js";

type RouteHandler = (req: Request, res: Response) => void;

const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof jest.fn>;
const mockLoadAdapter = loadAdapter as ReturnType<typeof jest.fn>;
const mockSpawn = spawn as ReturnType<typeof jest.fn>;

function mockReqRes(params: Record<string, string> = {}) {
  const req = { params } as unknown as Request;
  const statusFn = jest.fn().mockReturnThis();
  const jsonFn = jest.fn().mockReturnThis();
  const res = {
    status: statusFn,
    json: jsonFn,
  } as unknown as Response;
  return { req, res, statusFn, jsonFn };
}

describe("test-results routes", () => {
  let handlers: Record<string, RouteHandler>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};

    // Capture route handlers registered by registerTestResultsRoutes
    const fakeApp = {
      get: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
        handlers[path] = handler;
      }),
      post: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
        handlers[path] = handler;
      }),
    } as unknown as ReturnType<typeof express>;

    registerTestResultsRoutes(fakeApp, () => ({ projectRoot: "/test/project" }));
  });

  describe("GET /api/tasks/:id/test-results", () => {
    it("registers the route", () => {
      expect(handlers["/api/tasks/:id/test-results"]).toBeDefined();
    });

    it("returns 404 when no results file exists", () => {
      mockExistsSync.mockReturnValue(false);
      const { req, res, statusFn, jsonFn } = mockReqRes({ id: "TASK-001" });

      handlers["/api/tasks/:id/test-results"](req, res);

      expect(statusFn).toHaveBeenCalledWith(404);
      expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns test results when file exists", () => {
      const mockResult = { totalTests: 10, passed: 10, failed: 0 };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockResult));
      const { req, res, jsonFn } = mockReqRes({ id: "TASK-001" });

      handlers["/api/tasks/:id/test-results"](req, res);

      expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ totalTests: 10 }));
    });
  });

  describe("GET /api/tasks/:id/test-results/baseline", () => {
    it("registers the route", () => {
      expect(handlers["/api/tasks/:id/test-results/baseline"]).toBeDefined();
    });

    it("returns 404 when no baseline file exists", () => {
      mockExistsSync.mockReturnValue(false);
      const { req, res, statusFn } = mockReqRes({ id: "TASK-001" });

      handlers["/api/tasks/:id/test-results/baseline"](req, res);

      expect(statusFn).toHaveBeenCalledWith(404);
    });

    it("returns baseline when file exists", () => {
      const mockBaseline = { totalTests: 10, passed: 8, failed: 2 };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(mockBaseline));
      const { req, res, jsonFn } = mockReqRes({ id: "TASK-001" });

      handlers["/api/tasks/:id/test-results/baseline"](req, res);

      expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ totalTests: 10, failed: 2 }));
    });
  });

  describe("POST /api/test/full-suite", () => {
    it("registers the route", () => {
      expect(handlers["/api/test/full-suite"]).toBeDefined();
    });

    it("routes the named full suite through the bounded per-project runner", async () => {
      const startAdapterVerification = jest.fn(() => ({ started: true, taskId: "manual-1" }));
      const getTestRunner = jest.fn(() => ({
        isRunning: () => false,
        startAdapterVerification,
      }));
      const fakeApp = {
        get: jest.fn(),
        post: jest.fn((route: string, handler: RouteHandler) => {
          handlers[route] = handler;
        }),
      } as unknown as ReturnType<typeof express>;
      const adapter = {
        projectRoot: "/test/project",
        config: {
          git: { baseBranch: "main" },
          verification: {
            hostExecution: "docker-sandbox",
            tieredTesting: { enabled: true },
            commands: [
              {
                name: "full-suite",
                command: "malicious-host-command",
                required: true,
                timeout: 30_000,
              },
            ],
          },
        },
      };
      mockLoadAdapter.mockResolvedValue(adapter);
      registerTestResultsRoutes(fakeApp, () => ({ projectRoot: "/test/project" }), {
        getTestRunner: getTestRunner as never,
      });
      const { req, res, jsonFn } = mockReqRes();

      await Promise.resolve(handlers["/api/test/full-suite"](req, res));

      expect(getTestRunner).toHaveBeenCalledWith("/test/project");
      expect(startAdapterVerification).toHaveBeenCalledWith(
        adapter,
        "full-suite",
        expect.objectContaining({ baseBranch: "main", force: true }),
      );
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ hostExecution: "docker-sandbox", taskId: "manual-1" }),
      );
    });

    it("fails closed when no named full-suite verifier exists", async () => {
      const fakeApp = {
        get: jest.fn(),
        post: jest.fn((route: string, handler: RouteHandler) => {
          handlers[route] = handler;
        }),
      } as unknown as ReturnType<typeof express>;
      mockLoadAdapter.mockResolvedValue({
        projectRoot: "/test/project",
        config: {
          git: { baseBranch: "main" },
          verification: {
            hostExecution: "docker-sandbox",
            tieredTesting: { enabled: true },
            commands: [],
          },
        },
      });
      registerTestResultsRoutes(fakeApp, () => ({ projectRoot: "/test/project" }), {
        getTestRunner: jest.fn() as never,
      });
      const { req, res, statusFn, jsonFn } = mockReqRes();

      await Promise.resolve(handlers["/api/test/full-suite"](req, res));

      expect(statusFn).toHaveBeenCalledWith(409);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "FULL_SUITE_COMMAND_REQUIRED" }),
      );
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns 400 when no project root configured", () => {
      const noRootHandlers: Record<string, RouteHandler> = {};
      const fakeApp = {
        get: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
          noRootHandlers[path] = handler;
        }),
        post: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
          noRootHandlers[path] = handler;
        }),
      } as unknown as ReturnType<typeof express>;

      registerTestResultsRoutes(fakeApp, () => ({ projectRoot: undefined }));

      const { req, res, statusFn } = mockReqRes({ id: "TASK-001" });
      noRootHandlers["/api/tasks/:id/test-results"](req, res);

      expect(statusFn).toHaveBeenCalledWith(400);
    });
  });
});
