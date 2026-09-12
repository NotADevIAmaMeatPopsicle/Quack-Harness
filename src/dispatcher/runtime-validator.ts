// ─── Runtime Validator ──────────────────────────────────────────────
// Provides runtime validation for frontend tasks: starts a dev server,
// uses Playwright to navigate routes, checks for errors, and captures
// screenshots. All results are warnings only — never blockers.
//
// Graceful degradation: if Playwright is not installed the check returns
// immediately with available=false. If the dev server fails to start the
// check returns with serverStarted=false. Console errors and uncaught
// exceptions are surfaced as warnings, not errors.

import type {
  ParsedTask,
  RuntimeCheckConfig,
  RuntimeCheckResult,
  RuntimeRouteResult,
} from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// ─── Frontend extension patterns ──────────────────────────────────

const FRONTEND_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte", ".css", ".html"];

// ─── Helpers (not exported) ───────────────────────────────────────

/**
 * Dynamically import Playwright and return true if available.
 */
async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    await import("playwright");
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll a health URL until it responds with a 2xx status code.
 * Returns true if the server started within the timeout.
 */
async function waitForServer(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return true;
    } catch {
      // Server not ready yet — swallow connection errors
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

/**
 * Kill a child process. On Windows, use taskkill for tree-kill.
 */
function cleanupProcess(proc: ChildProcess): void {
  if (!proc.pid) return;

  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {
        stdio: "ignore",
      });
    } else {
      proc.kill("SIGTERM");
      // Give it a moment, then force-kill
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already dead — ignore
        }
      }, 3000);
    }
  } catch {
    // Process may have already exited — ignore
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Returns true if a task targets frontend files.
 *
 * A task is considered frontend if:
 * - It has a `frontend` tag (case-insensitive), OR
 * - Its `filesToModify` contains files matching frontend extensions
 */
export function isFrontendTask(task: ParsedTask): boolean {
  // Check tags
  if (task.tags.some((tag) => tag.toLowerCase() === "frontend")) {
    return true;
  }

  // Check filesToModify for frontend extensions
  return task.filesToModify.some((file) =>
    FRONTEND_EXTENSIONS.some((ext) => file.path.endsWith(ext)),
  );
}

/**
 * Run runtime validation for a frontend task.
 *
 * Starts the project's dev server, launches Playwright in headless mode,
 * navigates each configured route, and captures screenshots + console errors.
 *
 * All results are warnings only. This function never throws.
 */
export async function runRuntimeValidation(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
): Promise<RuntimeCheckResult> {
  const emptyResult: RuntimeCheckResult = {
    available: true,
    serverStarted: false,
    routeResults: [],
    screenshots: [],
    warnings: [],
  };

  // ── Guard: not a frontend task ─────────────────────────────────
  if (!isFrontendTask(task)) {
    events.emit("runtime_check_skipped", {
      taskId,
      reason: "not_frontend_task",
    } as unknown as import("../monitor/event-types.js").EventPayload);
    return emptyResult;
  }

  // ── Guard: no runtimeCheck config in adapter ───────────────────
  const config: RuntimeCheckConfig | undefined = adapter.config.runtimeCheck;
  if (!config) {
    events.emit("runtime_check_skipped", {
      taskId,
      reason: "no_runtime_check_config",
    } as unknown as import("../monitor/event-types.js").EventPayload);
    return {
      ...emptyResult,
      warnings: ["No runtimeCheck configured in adapter"],
    };
  }

  // Runtime server commands execute project-controlled code with host filesystem
  // authority. Keep the legacy path fail-closed unless the trusted adapter makes
  // that authority explicit, and never bypass a configured verification sandbox.
  if (config.execution !== "direct-trusted") {
    events.emit("runtime_check_skipped", {
      taskId,
      reason: "direct_trusted_opt_in_required",
    } as unknown as import("../monitor/event-types.js").EventPayload);
    return {
      ...emptyResult,
      available: false,
      warnings: [
        "Runtime validation refused: runtimeCheck.execution must explicitly be direct-trusted",
      ],
    };
  }
  if ((adapter.config.verification.hostExecution ?? "direct") !== "direct") {
    events.emit("runtime_check_skipped", {
      taskId,
      reason: "verification_sandbox_conflict",
    } as unknown as import("../monitor/event-types.js").EventPayload);
    return {
      ...emptyResult,
      available: false,
      warnings: [
        "Runtime validation refused: a host dev server cannot bypass the configured verification sandbox",
      ],
    };
  }

  // ── Guard: Playwright not installed ────────────────────────────
  if (!(await isPlaywrightAvailable())) {
    events.emit("runtime_check_skipped", {
      taskId,
      reason: "playwright_not_installed",
    } as unknown as import("../monitor/event-types.js").EventPayload);
    return {
      ...emptyResult,
      available: false,
      warnings: ["Playwright not installed — runtime validation skipped"],
    };
  }

  // ── Proceed with runtime validation ────────────────────────────
  let serverProc: ChildProcess | undefined;
  let browser: unknown;

  try {
    events.emit("runtime_check_start", {
      taskId,
      routes: config.routes.length,
    } as unknown as import("../monitor/event-types.js").EventPayload);

    // Create screenshot directory
    const screenshotDir = join(workDir, ".quack", "screenshots", taskId);
    await fs.mkdir(screenshotDir, { recursive: true });

    // ── Start dev server ───────────────────────────────────────
    serverProc = spawn(config.startCommand, [], {
      cwd: workDir,
      shell: true,
      stdio: "pipe",
    });

    const startupTimeout = config.startupTimeoutMs ?? 30000;
    const serverReady = await waitForServer(config.healthUrl, startupTimeout);

    if (!serverReady) {
      cleanupProcess(serverProc);
      const result: RuntimeCheckResult = {
        available: true,
        serverStarted: false,
        routeResults: [],
        screenshots: [],
        warnings: [],
        error: "Server failed to start within timeout",
      };
      events.emit("runtime_check_complete", {
        taskId,
        available: true,
        routeCount: 0,
        warningCount: 0,
        screenshotCount: 0,
      } as unknown as import("../monitor/event-types.js").EventPayload);
      return result;
    }

    // ── Launch Playwright ──────────────────────────────────────
    const { chromium } = (await import("playwright")) as {
      chromium: {
        launch(opts: { headless: boolean }): Promise<unknown>;
      };
    };
    browser = await chromium.launch({ headless: true });
    const context = await (browser as { newContext(): Promise<unknown> }).newContext();

    // ── Check each route ───────────────────────────────────────
    const routeResults: RuntimeRouteResult[] = [];
    const allScreenshots: string[] = [];
    const allWarnings: string[] = [];
    const routeTimeout = config.routeTimeoutMs ?? 10000;

    for (const route of config.routes) {
      const routeStart = Date.now();
      const consoleErrors: string[] = [];
      const uncaughtExceptions: string[] = [];
      let loaded = false;
      let statusCode: number | null = null;
      let screenshotPath: string | undefined;

      // Create a new page for each route
      const page = await (context as { newPage(): Promise<unknown> }).newPage();

      try {
        // Listen for console errors
        (page as { on(event: string, handler: (msg: unknown) => void): void }).on(
          "console",
          (msg: unknown) => {
            const typedMsg = msg as { type(): string; text(): string };
            if (typedMsg.type() === "error") {
              consoleErrors.push(typedMsg.text());
            }
          },
        );

        // Listen for uncaught exceptions
        (page as { on(event: string, handler: (err: unknown) => void): void }).on(
          "pageerror",
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            uncaughtExceptions.push(message);
          },
        );

        // Navigate to the route
        const url = config.baseUrl + route;
        const response = await (
          page as {
            goto(
              url: string,
              opts: { timeout: number; waitUntil: string },
            ): Promise<{ status(): number } | null>;
          }
        ).goto(url, {
          timeout: routeTimeout,
          waitUntil: "load",
        });

        loaded = true;
        statusCode = response ? response.status() : null;

        // Take screenshot
        const safeRouteName = route.replace(/\//g, "_") || "_root";
        screenshotPath = join(screenshotDir, `${safeRouteName}.png`);
        await (
          page as {
            screenshot(opts: { path: string; fullPage: boolean }): Promise<void>;
          }
        ).screenshot({ path: screenshotPath, fullPage: true });

        allScreenshots.push(screenshotPath);
      } catch (err) {
        // Navigation failed — record but do not throw
        const message = err instanceof Error ? err.message : String(err);
        allWarnings.push(`Route ${route} failed: ${message}`);
      } finally {
        await (page as { close(): Promise<void> }).close();
      }

      // Build warnings from console errors and uncaught exceptions
      for (const ce of consoleErrors) {
        allWarnings.push(`[${route}] console.error: ${ce}`);
      }
      for (const ue of uncaughtExceptions) {
        allWarnings.push(`[${route}] uncaught exception: ${ue}`);
      }

      routeResults.push({
        route,
        loaded,
        statusCode,
        consoleErrors,
        uncaughtExceptions,
        screenshotPath,
        durationMs: Date.now() - routeStart,
      });
    }

    // ── Build final result ─────────────────────────────────────
    const result: RuntimeCheckResult = {
      available: true,
      serverStarted: true,
      routeResults,
      screenshots: allScreenshots,
      warnings: allWarnings,
    };

    events.emit("runtime_check_complete", {
      taskId,
      available: true,
      routeCount: routeResults.length,
      warningCount: allWarnings.length,
      screenshotCount: allScreenshots.length,
    } as unknown as import("../monitor/event-types.js").EventPayload);

    return result;
  } catch (err) {
    // Outer catch — something unexpected went wrong
    const message = err instanceof Error ? err.message : String(err);
    const result: RuntimeCheckResult = {
      available: true,
      serverStarted: false,
      routeResults: [],
      screenshots: [],
      warnings: [`Runtime validation failed unexpectedly: ${message}`],
      error: message,
    };

    events.emit("runtime_check_complete", {
      taskId,
      available: true,
      routeCount: 0,
      warningCount: 1,
      screenshotCount: 0,
    } as unknown as import("../monitor/event-types.js").EventPayload);

    return result;
  } finally {
    // ── Cleanup: always close browser and kill server ─────────
    if (browser) {
      try {
        await (browser as { close(): Promise<void> }).close();
      } catch {
        // Browser cleanup failure — ignore
      }
    }
    if (serverProc) {
      cleanupProcess(serverProc);
    }
  }
}
