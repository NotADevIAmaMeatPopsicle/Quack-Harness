// ─── Analytics Types ────────────────────────────────────────────────
// Types for failure analytics and adaptive gate advisory system.
// See TASK-051 spec for full details.

/** Structured analysis of a completed task run */
export interface RunAnalysis {
  taskId: string;
  sessionId: string;
  outcome: "approved" | "rejected" | "error";
  costUsd: number;
  turnsUsed: number;
  /** How the worker stopped: stuck-loop self-bailout, max turns reached, or clean finish */
  stoppedReason?: "stuck_loop" | "max_turns" | "clean_finish";
  retriesUsed: number;
  /** Tags from the task spec (e.g., "backend", "dashboard", "integration") */
  taskTags: string[];
  /** Files the task intended to modify */
  targetFiles: string[];
  /** Which success criteria passed/failed */
  criteriaResults: Array<{ criterion: string; status: "PASS" | "PARTIAL" | "FAIL" }>;
  /** Recurring judge feedback themes */
  feedbackThemes: string[];
  /** Gate depth score at dispatch time */
  gateScore: number;
  /** Blueprint quality metrics (if available) */
  blueprintMetrics?: { fileAnalyses: number; codeExamples: number };
  /** Complexity metrics */
  complexity: { filesToModify: number; successCriteria: number };
}

/** Known pattern from historical failures */
export interface KnownPattern {
  pattern: string;
  description: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  suggestion: string;
}

/** Success rate for a specific category */
export interface SuccessRate {
  runs: number;
  approved: number;
  rejected: number;
  rate: number;
}

/** Accumulated failure patterns from historical runs */
export interface FailurePatternDB {
  updatedAt: string;
  totalRuns: number;
  totalApproved: number;
  totalRejected: number;
  totalErrors: number;
  /** Success rate by tag */
  byTag: Record<string, SuccessRate>;
  /** Success rate by file touched */
  byFile: Record<string, SuccessRate>;
  /** Success rate by complexity bucket */
  byComplexity: Record<"simple" | "medium" | "complex", SuccessRate>;
  /** Success rate by gate score bucket */
  byGateScore: Record<string, SuccessRate>;
  /** Most common judge feedback themes */
  topFeedbackThemes: Array<{ theme: string; count: number }>;
  /** Specific recurring patterns */
  knownPatterns: KnownPattern[];
}

/** Advisory suggestions based on historical patterns */
export interface GateAdvisory {
  /** Suggested minimum depth score based on historical success rates */
  suggestedMinScore: number;
  /** Warnings about task characteristics that correlate with failure */
  warnings: string[];
  /** Relevant known patterns for this task */
  relevantPatterns: Array<{ pattern: string; suggestion: string }>;
}

/** Empty pattern database (for initialization) */
export function createEmptyPatternDB(): FailurePatternDB {
  return {
    updatedAt: new Date().toISOString(),
    totalRuns: 0,
    totalApproved: 0,
    totalRejected: 0,
    totalErrors: 0,
    byTag: {},
    byFile: {},
    byComplexity: {
      simple: { runs: 0, approved: 0, rejected: 0, rate: 0 },
      medium: { runs: 0, approved: 0, rejected: 0, rate: 0 },
      complex: { runs: 0, approved: 0, rejected: 0, rate: 0 },
    },
    byGateScore: {},
    topFeedbackThemes: [],
    knownPatterns: [],
  };
}
