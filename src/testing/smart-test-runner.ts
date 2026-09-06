// ─── Smart Test Runner ────────────────────────────────────────────
// Runs Jest with --json output for structured results instead of
// parsing exit codes. Supports "related" mode (only tests affected
// by changed files) and "full" mode (entire suite).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { worktreeEnv } from "../utils/worktree-env.js";
import type { SmartTestConfig, TestSuiteResult, SuiteResult, TestFailure } from "../core/types.js";

/**
 * Get list of files changed between the current branch and its merge-base with baseBranch.
 */
export function getChangedFiles(workDir: string, baseBranch: string): string[] {
  const env = worktreeEnv(workDir);
  try {
    const mergeBase = execSync(`git merge-base ${baseBranch} HEAD`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    }).trim();

    if (!mergeBase) return [];

    const output = execSync(`git diff --name-only ${mergeBase} HEAD`, {
      cwd: workDir,
      env,
      encoding: "utf-8",
    });

    return output
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Parse Jest's --json output file into a structured TestSuiteResult.
 */
export function parseJestOutput(jsonPath: string): TestSuiteResult {
  const now = new Date().toISOString();
  const empty: TestSuiteResult = {
    totalTests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    suites: [],
    failures: [],
    exitCode: 1,
    timestamp: now,
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

  const suites: SuiteResult[] = [];
  const failures: TestFailure[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const suite of json.testResults ?? []) {
    const suitePath = normalize(suite.name ?? "");
    let suitePassed = 0;
    let suiteFailed = 0;
    let suiteSkipped = 0;

    for (const test of suite.assertionResults ?? []) {
      if (test.status === "passed") {
        suitePassed++;
        totalPassed++;
      } else if (test.status === "failed") {
        suiteFailed++;
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
        suiteSkipped++;
        totalSkipped++;
      }
    }

    suites.push({
      path: suitePath,
      passed: suitePassed,
      failed: suiteFailed,
      skipped: suiteSkipped,
      duration:
        suite.endTime != null && suite.startTime != null ? suite.endTime - suite.startTime : 0,
    });
  }

  const totalTests = totalPassed + totalFailed + totalSkipped;

  return {
    totalTests,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    durationMs:
      json.testResults?.reduce((sum, s) => sum + ((s.endTime ?? 0) - (s.startTime ?? 0)), 0) ?? 0,
    suites,
    failures,
    exitCode: json.success ? 0 : 1,
    timestamp: now,
  };
}

/**
 * Run Jest with structured JSON output. Returns a TestSuiteResult
 * even when tests fail (exit code 1).
 */
export function runSmartTests(config: SmartTestConfig): TestSuiteResult {
  const { mode, workDir, baseBranch, outputDir, taskId, timeout } = config;
  const env = worktreeEnv(workDir);

  // Ensure output directory exists
  const fullOutputDir = join(workDir, outputDir);
  mkdirSync(fullOutputDir, { recursive: true });

  const jsonFile = join(fullOutputDir, `${taskId}-${mode}.json`);

  let command: string;

  if (mode === "related") {
    const changedFiles = getChangedFiles(workDir, baseBranch);
    if (changedFiles.length === 0) {
      // No changed files — fall back to full suite
      command = `npx jest --json --outputFile "${jsonFile}" --forceExit`;
    } else {
      // Filter to source/test files only (not configs, docs, etc.)
      const relevantFiles = changedFiles.filter(
        (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"),
      );
      if (relevantFiles.length === 0) {
        command = `npx jest --json --outputFile "${jsonFile}" --forceExit`;
      } else {
        const fileList = relevantFiles.map((f) => `"${f}"`).join(" ");
        command = `npx jest --findRelatedTests ${fileList} --json --outputFile "${jsonFile}" --forceExit`;
      }
    }
  } else {
    // 'full' or 'baseline' mode — run the entire suite
    command = `npx jest --json --outputFile "${jsonFile}" --forceExit`;
  }

  try {
    execSync(command, {
      cwd: workDir,
      env,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Jest exits with code 1 when tests fail — that's expected.
    // The JSON output file is still written.
  }

  return parseJestOutput(jsonFile);
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
