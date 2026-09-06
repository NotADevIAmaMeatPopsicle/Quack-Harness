// ─── Baseline Manager ─────────────────────────────────────────────
// Manages test baselines for tiered testing (TASK-094).
// Baselines are only updated by clean Tier 3 runs.
// Tier 1 and 2 results are compared against the stable baseline
// to distinguish new failures from pre-existing ones.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TestFailure } from "../core/types.js";
import type { BaselineResult, BaselineDiff, TieredTestResult } from "./types.js";

const BASELINE_FILENAME = "baseline.json";

/**
 * Load the current baseline from disk.
 * Returns null if no baseline exists.
 *
 * @param projectRoot - Absolute path to the project root
 * @param outputDir - Relative path to the test results directory (default: ".quack/test-results")
 */
export function loadBaseline(
  projectRoot: string,
  outputDir = ".quack/test-results",
): BaselineResult | null {
  const baselinePath = join(projectRoot, outputDir, BASELINE_FILENAME);
  if (!existsSync(baselinePath)) return null;

  try {
    const raw = readFileSync(baselinePath, "utf-8");
    return JSON.parse(raw) as BaselineResult;
  } catch {
    return null;
  }
}

/**
 * Save a new baseline from a Tier 3 full suite run.
 * Only saves if the results are clean (no failures) or improving
 * (failure count <= current baseline failure count).
 *
 * @param projectRoot - Absolute path to the project root
 * @param results - Tier 3 test results
 * @param outputDir - Relative path to the test results directory
 */
export function saveBaseline(
  projectRoot: string,
  results: TieredTestResult,
  outputDir = ".quack/test-results",
): void {
  const baselinePath = join(projectRoot, outputDir, BASELINE_FILENAME);

  // Load existing baseline to compare
  const existing = loadBaseline(projectRoot, outputDir);

  // Only save if clean or improving
  if (existing) {
    if (results.failed > existing.totalFailing) {
      // Regression — don't pollute baseline
      return;
    }
  }

  const baseline: BaselineResult = {
    timestamp: new Date().toISOString(),
    totalTests: results.ran,
    totalFailing: results.failed,
    failures: results.failures,
    source: baselinePath,
  };

  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
}

/**
 * Compare current test results against a baseline.
 * Separates failures into:
 * - newFailures: test was passing in baseline, now fails (task broke it)
 * - preExisting: test was already failing in baseline (ignore)
 *
 * @param current - Current test run failures
 * @param baseline - The stored baseline to compare against
 */
export function diffAgainstBaseline(
  current: TestFailure[],
  baseline: BaselineResult,
): BaselineDiff {
  const baselineKeys = new Set(baseline.failures.map(failureKey));

  const newFailures: TestFailure[] = [];
  const preExisting: TestFailure[] = [];

  for (const failure of current) {
    const key = failureKey(failure);
    if (baselineKeys.has(key)) {
      preExisting.push(failure);
    } else {
      newFailures.push(failure);
    }
  }

  return { newFailures, preExisting };
}

/**
 * Build a composite key for a test failure to enable matching across runs.
 * Uses suitePath + ancestorTitles + testName for uniqueness.
 */
function failureKey(f: TestFailure): string {
  const parts = [f.suitePath, ...f.ancestorTitles, f.testName];
  return parts.join(" > ");
}
