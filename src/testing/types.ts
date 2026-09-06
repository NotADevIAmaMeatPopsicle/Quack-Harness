// ─── Tiered Testing Types ─────────────────────────────────────────
// Type definitions for the tiered testing infrastructure (TASK-094).
// Tier 1: Changed-file unit tests (fastest)
// Tier 2: Module integration tests (medium)
// Tier 3: Full suite (periodic baseline refresh)

import type { TestFailure } from "../core/types.js";

/** Which tier of testing to execute */
export type TestTier = 1 | 2 | 3;

/** Adapter-level tiered testing configuration (stored in adapter.json) */
export interface TieredTestingConfig {
  /** Whether tiered testing is enabled */
  enabled: boolean;
  /** Docker command prefix for running tests (e.g. "docker compose --profile testing run --rm test-runner") */
  dockerCommand?: string;
  /** How often to run Tier 3 full suite: number of merges between runs */
  tier3Frequency: number;
  /** Output directory for test result artifacts */
  outputDir: string;
}

/** Result of a single tiered test run */
export interface TieredTestResult {
  /** Which tier was executed */
  tier: TestTier;
  /** Number of tests that ran */
  ran: number;
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Number of tests that were skipped */
  skipped: number;
  /** Test files that were executed */
  files: string[];
  /** Duration of the test run in milliseconds */
  durationMs: number;
  /** Exit code of the test process */
  exitCode: number;
  /** Individual test failures */
  failures: TestFailure[];
}

/** Stored baseline from a clean Tier 3 run */
export interface BaselineResult {
  /** Timestamp of the baseline capture */
  timestamp: string;
  /** Total number of tests in the full suite */
  totalTests: number;
  /** Number of tests that were failing at baseline time */
  totalFailing: number;
  /** Failure details for matching against future runs */
  failures: TestFailure[];
  /** Source path of the baseline file */
  source: string;
}

/** Mapping of a source file to its corresponding test file(s) */
export interface TestFileMapping {
  /** The source file path (relative to project root) */
  sourceFile: string;
  /** The test file path(s) that correspond to this source file */
  testFiles: string[];
}

/** Result of diffing current test run against baseline */
export interface BaselineDiff {
  /** Failures that are new (not in baseline) */
  newFailures: TestFailure[];
  /** Failures that already existed in baseline */
  preExisting: TestFailure[];
}

/** Complete result written to .quack/test-results/TASK-NNN-results.json */
export interface TieredTestReport {
  /** Task ID */
  taskId: string;
  /** When the test run completed */
  timestamp: string;
  /** Tier 1 results (changed-file unit tests) */
  tier1: {
    ran: number;
    passed: number;
    failed: number;
    skipped: number;
    newFailures: number;
    files: string[];
  };
  /** Tier 2 results (module integration tests) */
  tier2: {
    ran: number;
    passed: number;
    failed: number;
    skipped: number;
    newFailures: number;
    preExisting: number;
    details: TestFailure[];
  };
  /** Baseline metadata */
  baseline: {
    source: string;
    date: string;
    totalTests: number;
    totalFailing: number;
  } | null;
  /** Overall test verdict */
  verdict: "pass" | "fail";
}
