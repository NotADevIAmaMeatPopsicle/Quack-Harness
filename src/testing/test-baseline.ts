// ─── Test Baseline ────────────────────────────────────────────────
// Captures pre-agent test suite state and compares post-agent results
// against it to distinguish pre-existing failures from agent-caused ones.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSmartTests } from "./smart-test-runner.js";
import type { TestSuiteResult, TestFailure, BaselineComparison } from "../core/types.js";

/**
 * Capture a baseline test snapshot by running the full suite before the agent starts.
 * Writes the result to `<outputDir>/<taskId>-baseline.json`.
 */
export function captureBaseline(
  workDir: string,
  baseBranch: string,
  outputDir: string,
  taskId: string,
  timeout = 120_000,
): TestSuiteResult {
  const result = runSmartTests({
    mode: "baseline",
    workDir,
    baseBranch,
    outputDir,
    taskId: `${taskId}-baseline`,
    timeout,
  });

  // Persist baseline for later comparison
  const baselineDir = join(workDir, outputDir);
  mkdirSync(baselineDir, { recursive: true });
  const baselinePath = join(baselineDir, `${taskId}-baseline.json`);
  writeFileSync(baselinePath, JSON.stringify(result, null, 2));

  return result;
}

/**
 * Load a previously captured baseline from disk.
 * Returns null if no baseline file exists.
 */
export function loadBaseline(outputDir: string, taskId: string): TestSuiteResult | null {
  const baselinePath = join(outputDir, `${taskId}-baseline.json`);
  if (!existsSync(baselinePath)) return null;

  try {
    const raw = readFileSync(baselinePath, "utf-8");
    return JSON.parse(raw) as TestSuiteResult;
  } catch {
    return null;
  }
}

/**
 * Build a composite key for a test failure to enable matching across runs.
 * Uses suitePath + ancestorTitles + testName for uniqueness.
 */
function failureKey(f: TestFailure): string {
  const parts = [f.suitePath, ...f.ancestorTitles, f.testName];
  return parts.join(" > ");
}

/**
 * Compare current test results against a baseline to classify failures.
 *
 * - preExisting: failed in both baseline AND current
 * - newFailures: failed in current but NOT in baseline
 * - newlyFixed: failed in baseline but NOT in current
 * - allFailuresPreExisting: true when newFailures.length === 0
 */
export function compareWithBaseline(
  current: TestSuiteResult,
  baseline: TestSuiteResult,
): BaselineComparison {
  const baselineKeys = new Set(baseline.failures.map(failureKey));
  const currentKeys = new Set(current.failures.map(failureKey));

  const preExisting: TestFailure[] = [];
  const newFailures: TestFailure[] = [];
  const newlyFixed: TestFailure[] = [];

  // Classify current failures
  for (const failure of current.failures) {
    const key = failureKey(failure);
    if (baselineKeys.has(key)) {
      preExisting.push(failure);
    } else {
      newFailures.push(failure);
    }
  }

  // Find newly fixed tests (were failing in baseline, now passing)
  for (const failure of baseline.failures) {
    const key = failureKey(failure);
    if (!currentKeys.has(key)) {
      newlyFixed.push(failure);
    }
  }

  return {
    preExisting,
    newFailures,
    newlyFixed,
    allFailuresPreExisting: newFailures.length === 0,
  };
}
