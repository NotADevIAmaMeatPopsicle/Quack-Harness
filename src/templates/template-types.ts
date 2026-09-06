// ─── Task Template Types ────────────────────────────────────────────
// Types for the task template library system (TASK-058).
// Templates are extracted from completed tasks and used to suggest similar
// completed work during context assembly and planning.

export type TaskCategory =
  | "new-module"
  | "integration"
  | "bug-fix"
  | "refactor"
  | "dashboard-feature"
  | "api-endpoint"
  | "testing"
  | "configuration"
  | "infrastructure";

export interface TaskTemplate {
  /** Task category classification */
  category: TaskCategory;
  /** Source task ID (e.g., "TASK-051") */
  sourceTaskId: string;
  /** Anonymized structure (specific names replaced with placeholders) */
  specTemplate: string;
  /** Success rate for tasks using this template's pattern (0-1) */
  successRate: number;
  /** Average cost for tasks of this type */
  avgCostUsd: number;
  /** File patterns involved (e.g., ["src/templates", "tests/templates"]) */
  filePatterns: string[];
  /** Number of files in the original task (for complexity comparison) */
  fileCount: number;
  /** Tags from the task spec */
  tags: string[];
}

export interface TemplateRegistry {
  /** Last update timestamp */
  updatedAt: string;
  /** All extracted templates */
  templates: TaskTemplate[];
  /** Category-level aggregate statistics */
  categoryStats: Record<
    TaskCategory,
    {
      count: number;
      avgSuccessRate: number;
      avgCostUsd: number;
    }
  >;
}

export interface TemplateMatch {
  /** The matched template */
  template: TaskTemplate;
  /** Match quality score (0-1) */
  score: number;
  /** Human-readable reasons for the match */
  matchReasons: string[];
}
