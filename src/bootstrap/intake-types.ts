import type { ScanResult } from "./project-scanner.js";
import type { GeneratedAdapter } from "./adapter-generator.js";

// ─── Command Validation ────────────────────────────────────────────

export interface CommandValidation {
  /** Command name (e.g., "tests", "build") */
  name: string;
  /** Full command string executed */
  command: string;
  /** Exit code (null if timed out) */
  exitCode: number | null;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Standard output (truncated to 2000 chars) */
  stdout: string;
  /** Standard error (truncated to 2000 chars) */
  stderr: string;
  /** Parsed test count from test runner output (if applicable) */
  testCount?: number;
  /** Validation status */
  status: "pass" | "fail" | "timeout" | "skipped";
}

// ─── Testing Strategy ──────────────────────────────────────────────

export interface TestingStrategy {
  /** Primary test command recommendation */
  primaryCommand: {
    command: string;
    rationale: string;
  };
  /** Targeted command for changed files only */
  targetedCommand?: {
    command: string;
    rationale: string;
  };
  /** Full suite command for comprehensive validation */
  fullSuiteCommand?: {
    command: string;
    rationale: string;
  };
  /** Estimated full suite execution time */
  estimatedFullSuiteTime: string;
  /** Human-readable recommendations */
  recommendations: string[];
}

// ─── Adapter Review ────────────────────────────────────────────────

export interface AdapterReviewResult {
  /** Configuration suggestions from LLM */
  suggestions: string[];
  /** Overall confidence in adapter quality */
  confidence: "high" | "medium" | "low";
}

// ─── Intake Report ─────────────────────────────────────────────────

export interface IntakeReport {
  /** Scan results from deterministic detection */
  scan: ScanResult;
  /** Command validation results */
  commandValidation: CommandValidation[];
  /** LLM-generated testing strategy */
  testingStrategy: TestingStrategy;
  /** LLM-generated conventions analysis */
  conventionsAnalysis: string;
  /** LLM adapter review */
  adapterReview: AdapterReviewResult;
  /** Generated adapter configuration */
  generatedAdapter: GeneratedAdapter;
  /** Overall confidence in adapter correctness */
  confidence: "high" | "medium" | "low";
  /** Manual review items for human to check */
  manualReviewItems: string[];
}
