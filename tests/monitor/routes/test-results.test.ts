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

// Mock baseline-manager
jest.mock("../../../src/testing/baseline-manager.js", () => ({
  saveBaseline: jest.fn(),
  loadBaseline: jest.fn(),
  diffAgainstBaseline: jest.fn(),
}));

import { registerTestResultsRoutes } from "../../../src/monitor/routes/test-results.js";
import * as fs from "node:fs";

const mockExistsSync = fs.existsSync as ReturnType<typeof jest.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof jest.fn>;

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
  let handlers: Record<string, (req: Request, res: Response) => void>;

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
  });

  describe("error handling", () => {
    it("returns 400 when no project root configured", () => {
      const noRootHandlers: Record<string, (req: Request, res: Response) => void> = {};
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
