import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { ParsedTask } from "../../src/core/types.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";

// Mock child_process spawn
jest.mock("node:child_process", () => ({
  spawn: jest.fn<() => unknown>().mockReturnValue({
    pid: 12345,
    on: jest.fn(),
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    kill: jest.fn(),
  }),
}));

// Mock fs
jest.mock("node:fs", () => ({
  promises: {
    mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

function makeTask(overrides?: Partial<ParsedTask>): ParsedTask {
  return {
    id: "TASK-100",
    title: "Test Task",
    priority: "P2-MEDIUM",
    effort: "1-2 days",
    status: "IN_PROGRESS",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: ["Criterion 1"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# Test task",
    ...overrides,
  } as ParsedTask;
}

function makeAdapter(overrides?: Record<string, unknown>): ProjectAdapter {
  return {
    projectRoot: "/test/project",
    config: {
      verification: {
        commands: [],
        conventionChecks: [],
      },
      ...overrides,
    },
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
  } as unknown as ProjectAdapter;
}

function makeEvents(): IEventWriter {
  return {
    sessionId: "test-session",
    taskId: "TASK-100",
    project: "test",
    emit: jest.fn(),
    recordSession: jest.fn(),
  } as unknown as IEventWriter;
}

describe("runtime-validator", () => {
  let mockEvents: IEventWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEvents = makeEvents();
  });

  describe("isFrontendTask", () => {
    let isFrontendTask: typeof import("../../src/dispatcher/runtime-validator.js").isFrontendTask;

    beforeEach(async () => {
      const mod = await import("../../src/dispatcher/runtime-validator.js");
      isFrontendTask = mod.isFrontendTask;
    });

    it("returns true when task has frontend tag", () => {
      const task = makeTask({ tags: ["frontend"] });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when task has frontend tag case-insensitive", () => {
      const task = makeTask({ tags: ["Frontend"] });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .tsx file", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/components/App.tsx", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .jsx file", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/components/App.jsx", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .vue file", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/components/App.vue", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .svelte file", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/components/App.svelte", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .css file", () => {
      const task = makeTask({
        filesToModify: [{ path: "src/styles/main.css", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns true when filesToModify contains .html file", () => {
      const task = makeTask({
        filesToModify: [{ path: "public/index.html", action: "Modify", notes: "" }],
      });
      expect(isFrontendTask(task)).toBe(true);
    });

    it("returns false when task has only .ts files and no frontend tag", () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/core/types.ts", action: "Modify", notes: "" },
          { path: "src/utils/helpers.ts", action: "Create", notes: "" },
        ],
        tags: ["backend"],
      });
      expect(isFrontendTask(task)).toBe(false);
    });

    it("returns false when task has no files and no tags", () => {
      const task = makeTask();
      expect(isFrontendTask(task)).toBe(false);
    });
  });

  describe("runRuntimeValidation", () => {
    let runRuntimeValidation: typeof import("../../src/dispatcher/runtime-validator.js").runRuntimeValidation;

    beforeEach(async () => {
      const mod = await import("../../src/dispatcher/runtime-validator.js");
      runRuntimeValidation = mod.runRuntimeValidation;
    });

    it("returns empty result for non-frontend task", async () => {
      const task = makeTask({ tags: ["backend"], filesToModify: [] });
      const adapter = makeAdapter();

      const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

      expect(result.routeResults).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.screenshots).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockEvents.emit).toHaveBeenCalledWith(
        "runtime_check_skipped",
        expect.objectContaining({ reason: "not_frontend_task" }),
      );
    });

    it("returns warning when adapter has no runtimeCheck config", async () => {
      const task = makeTask({ tags: ["frontend"] });
      const adapter = makeAdapter(); // no runtimeCheck

      const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

      expect(result.warnings).toContain("No runtimeCheck configured in adapter");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockEvents.emit).toHaveBeenCalledWith(
        "runtime_check_skipped",
        expect.objectContaining({ reason: "no_runtime_check_config" }),
      );
    });

    it("returns serverStarted=false when server fails to start", async () => {
      // Mock global fetch to always reject (server never starts)
      const originalFetch = global.fetch;
      global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

      try {
        const task = makeTask({ tags: ["frontend"] });
        const adapter = makeAdapter({
          runtimeCheck: {
            execution: "direct-trusted",
            startCommand: "npm run dev",
            healthUrl: "http://localhost:3000",
            routes: ["/"],
            baseUrl: "http://localhost:3000",
            startupTimeoutMs: 2000, // Short timeout for test speed
          },
        });

        const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

        expect(result.serverStarted).toBe(false);
        expect(result.error).toContain("Server failed to start");
      } finally {
        global.fetch = originalFetch;
      }
    }, 30000);

    it("calls cleanup on server process even when server fails to start", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

      try {
        const cp = await import("node:child_process");
        const localSpawn = cp.spawn as ReturnType<typeof jest.fn>;

        const task = makeTask({ tags: ["frontend"] });
        const adapter = makeAdapter({
          runtimeCheck: {
            execution: "direct-trusted",
            startCommand: "npm run dev",
            healthUrl: "http://localhost:3000",
            routes: ["/"],
            baseUrl: "http://localhost:3000",
            startupTimeoutMs: 2000,
          },
        });

        await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

        // The dev server spawn should have been called
        expect(localSpawn).toHaveBeenCalled();

        // cleanupProcess is called internally. On Windows it spawns taskkill for
        // tree-kill, so there should be at least 2 spawn calls: the dev server
        // and the taskkill cleanup. On non-Windows, proc.kill() is called instead.
        const spawnCalls = localSpawn.mock.calls;
        // At minimum the dev server spawn call exists
        expect(spawnCalls.length).toBeGreaterThanOrEqual(1);

        // On Windows, verify taskkill was spawned for cleanup
        if (process.platform === "win32") {
          const taskkillCall = spawnCalls.find((call: unknown[]) => call[0] === "taskkill");
          expect(taskkillCall).toBeDefined();
        }
      } finally {
        global.fetch = originalFetch;
      }
    }, 30000);

    it("refuses an unacknowledged host command before it can write or detach", async () => {
      const cp = await import("node:child_process");
      const localSpawn = cp.spawn as ReturnType<typeof jest.fn>;
      const task = makeTask({ tags: ["frontend"] });
      const adapter = makeAdapter({
        runtimeCheck: {
          startCommand:
            "node -e \"require('node:fs').writeFileSync('../protected-sentinel','x');require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true})\"",
          healthUrl: "http://127.0.0.1:3000/health",
          routes: ["/"],
          baseUrl: "http://127.0.0.1:3000",
        },
      });

      const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

      expect(result.available).toBe(false);
      expect(result.warnings[0]).toContain("direct-trusted");
      expect(localSpawn).not.toHaveBeenCalled();
    });

    it("refuses direct runtime execution when verification uses a sandbox", async () => {
      const cp = await import("node:child_process");
      const localSpawn = cp.spawn as ReturnType<typeof jest.fn>;
      const task = makeTask({ tags: ["frontend"] });
      const adapter = makeAdapter({
        verification: {
          commands: [],
          conventionChecks: [],
          hostExecution: "docker-sandbox",
        },
        runtimeCheck: {
          execution: "direct-trusted",
          startCommand: "npm run dev",
          healthUrl: "http://127.0.0.1:3000/health",
          routes: ["/"],
          baseUrl: "http://127.0.0.1:3000",
        },
      });

      const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

      expect(result.available).toBe(false);
      expect(result.warnings[0]).toContain("cannot bypass");
      expect(localSpawn).not.toHaveBeenCalled();
    });
  });
});

/**
 * Separate describe block that mocks playwright to throw at the module level.
 * This simulates Playwright not being installed. We use a separate block
 * because jest.mock is hoisted and affects the entire file scope for this mock.
 */
describe("runtime-validator (playwright unavailable)", () => {
  // We cannot use jest.mock("playwright") at the top level because it would
  // affect ALL tests. Instead, we test the Playwright-not-installed path
  // by resetting modules and providing a mock that throws.
  //
  // Since the source code uses dynamic `import("playwright")`, and Jest's
  // jest.mock is hoisted, we need to isolate this in a separate test run.
  // However, Playwright IS installed in this environment, so we verify the
  // behavior indirectly by testing the guard with a patched module cache.

  it("returns available=false when playwright import fails", async () => {
    // Save original and replace
    const originalFetch = global.fetch;
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      // Use jest.isolateModulesAsync to get a fresh module with playwright mocked
      await jest.isolateModulesAsync(async () => {
        // Mock playwright to throw on import (simulating not installed)
        jest.mock("playwright", () => {
          throw new Error("Cannot find module 'playwright'");
        });

        const { runRuntimeValidation } = await import("../../src/dispatcher/runtime-validator.js");

        const mockEvents = makeEvents();
        const task = makeTask({ tags: ["frontend"] });
        const adapter = makeAdapter({
          runtimeCheck: {
            execution: "direct-trusted",
            startCommand: "npm run dev",
            healthUrl: "http://localhost:3000",
            routes: ["/"],
            baseUrl: "http://localhost:3000",
          },
        });

        const result = await runRuntimeValidation("TASK-100", task, adapter, "/work", mockEvents);

        expect(result.available).toBe(false);
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.stringContaining("Playwright not installed")]),
        );
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(mockEvents.emit).toHaveBeenCalledWith(
          "runtime_check_skipped",
          expect.objectContaining({ reason: "playwright_not_installed" }),
        );
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
