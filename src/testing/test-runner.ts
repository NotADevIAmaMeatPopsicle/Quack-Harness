// ─── Tiered Test Runner ───────────────────────────────────────────
// Executes tiered tests via child process and captures JSON output.
// Infrastructure-driven: tests run as child processes, not in-agent.
//
// Tier 1: 60s timeout — changed-file unit tests
// Tier 2: 180s timeout — module integration tests
// Tier 3: 600s timeout — full suite (periodic baseline refresh)

import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { worktreeEnv } from "../utils/worktree-env.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { TestFailure } from "../core/types.js";
import type { TieredTestResult, TestTier } from "./types.js";

/** Timeout per tier in milliseconds */
const TIER_TIMEOUTS: Record<TestTier, number> = {
  1: 60_000,
  2: 180_000,
  3: 600_000,
};

/**
 * Run tiered tests for a task.
 *
 * @param taskId - Task identifier (e.g. "TASK-601")
 * @param tier - Which tier to run (1, 2, or 3)
 * @param testFiles - Test files to run (empty for Tier 3 = full suite)
 * @param adapter - Project adapter with configuration
 * @param projectRoot - Absolute path to project root / worktree
 * @returns Structured test result
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function runTieredTests(
  taskId: string,
  tier: TestTier,
  testFiles: string[],
  adapter: ProjectAdapter,
  projectRoot: string,
): Promise<TieredTestResult> {
  const timeout = TIER_TIMEOUTS[tier];
  const env = worktreeEnv(projectRoot);

  // Determine the test command
  const tieredConfig = adapter.config.verification.tieredTesting;
  const dockerCommand = tieredConfig?.dockerCommand;

  // Build output path for Jest JSON results
  const outputDir = tieredConfig?.outputDir ?? ".quack/test-results";
  const fullOutputDir = join(projectRoot, outputDir);
  mkdirSync(fullOutputDir, { recursive: true });
  const jsonOutputFile = join(fullOutputDir, `${taskId}-tier${tier}.json`);

  let command: string;

  if (tier === 3) {
    // Tier 3: Full suite — no file arguments
    if (dockerCommand) {
      command = `${dockerCommand} npx jest --json --outputFile="${jsonOutputFile}" --forceExit`;
    } else {
      command = `npx jest --json --outputFile="${jsonOutputFile}" --forceExit`;
    }
  } else {
    // Tier 1 or 2: Run specific test files
    if (testFiles.length === 0) {
      // No test files to run — return empty result
      return {
        tier,
        ran: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        files: [],
        durationMs: 0,
        exitCode: 0,
        failures: [],
      };
    }

    const fileArgs = testFiles.map((f) => `"${f}"`).join(" ");
    if (dockerCommand) {
      command = `${dockerCommand} npx jest --json --outputFile="${jsonOutputFile}" --forceExit ${fileArgs}`;
    } else {
      command = `npx jest --json --outputFile="${jsonOutputFile}" --forceExit ${fileArgs}`;
    }
  }

  const startTime = Date.now();

  try {
    execSync(command, {
      cwd: projectRoot,
      env,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Jest exits with code 1 when tests fail — that's expected.
    // The JSON output file is still written.
  }

  const durationMs = Date.now() - startTime;

  return parseJestJsonOutput(jsonOutputFile, tier, testFiles, durationMs);
}

/**
 * Parse Jest's --json output file into a TieredTestResult.
 */
function parseJestJsonOutput(
  jsonPath: string,
  tier: TestTier,
  testFiles: string[],
  durationMs: number,
): TieredTestResult {
  const empty: TieredTestResult = {
    tier,
    ran: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    files: testFiles,
    durationMs,
    exitCode: 1,
    failures: [],
  };

  if (!existsSync(jsonPath)) return empty;

  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf-8");
  } catch {
    return empty;
  }

  let json: JestJsonOutput;
  try {
    json = JSON.parse(raw) as JestJsonOutput;
  } catch {
    return empty;
  }

  const failures: TestFailure[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const suite of json.testResults ?? []) {
    const suitePath = suite.name ?? "";

    for (const test of suite.assertionResults ?? []) {
      if (test.status === "passed") {
        totalPassed++;
      } else if (test.status === "failed") {
        totalFailed++;
        failures.push({
          suitePath,
          ancestorTitles: test.ancestorTitles ?? [],
          testName: test.title ?? "",
          fullName: test.fullName ?? "",
          message: (test.failureMessages ?? []).join("\n"),
          stack: (test.failureMessages ?? []).join("\n"),
        });
      } else {
        // pending/skipped/todo
        totalSkipped++;
      }
    }
  }

  const totalTests = totalPassed + totalFailed + totalSkipped;

  return {
    tier,
    ran: totalTests,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    files: testFiles,
    durationMs,
    exitCode: json.success ? 0 : 1,
    failures,
  };
}

// ─── Jest JSON output types (internal) ───────────────────────────

interface JestAssertionResult {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
}

interface JestSuiteResult {
  name?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: JestAssertionResult[];
}

interface JestJsonOutput {
  success?: boolean;
  testResults?: JestSuiteResult[];
}
