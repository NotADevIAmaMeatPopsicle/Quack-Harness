// ─── Task Decomposition Types ───────────────────────────────────────
// Type definitions for the staged Task Decomposition workflow.
// Supports plan / materialize / finalize staged modes with quality gates.

import type { FileModification } from "../core/types.js";

/** Refusal codes for staged decomposition — all callers must handle these */
export const DECOMPOSE_REFUSAL_CODES = {
  PARENT_NOT_READY: "DECOMPOSE_PARENT_NOT_READY",
  COVERAGE_GAP: "DECOMPOSE_COVERAGE_GAP",
  DRAFT_INVALID: "DECOMPOSE_DRAFT_INVALID",
  DRAFT_BELOW_THRESHOLD: "DECOMPOSE_DRAFT_BELOW_THRESHOLD",
  REVIEW_REQUIRED: "DECOMPOSE_REVIEW_REQUIRED",
  WRITE_LOCKED: "DECOMPOSE_WRITE_LOCKED",
} as const;

export type DecomposeRefusalCode =
  (typeof DECOMPOSE_REFUSAL_CODES)[keyof typeof DECOMPOSE_REFUSAL_CODES];

/**
 * A subtask topology definition (ownership only — no prose).
 * Each subtask is independently verifiable and has focused scope.
 */
export interface SubtaskDefinition {
  /** Subtask ID (e.g., "TASK-042-A", "TASK-042-B") */
  id: string;
  /** Short descriptive title (3-8 words) */
  title: string;
  /** Files this subtask owns (subset of parent's filesToModify) */
  filesToModify: FileModification[];
  /** Criterion texts owned by this subtask (subset of parent) */
  successCriteria: string[];
  /** Subtask IDs that must complete before this one */
  dependsOn: string[];
  /** Whether this is the final subtask (gets full-task judge pass) */
  isFinal: boolean;
}

/** Backward-compatible alias for callers that still use SubtaskPlan shape */
export interface SubtaskPlan {
  /** Parent task ID that was decomposed */
  parentTaskId: string;
  /** Ordered list of subtask definitions */
  subtasks: SubtaskDefinition[];
}

/** File ownership entry in the coverage report */
export interface FileOwnership {
  filePath: string;
  /** Subtask ID that owns this file */
  ownedBy: string;
  /** True if the same file appears in multiple subtasks (duplication warning) */
  isShared: boolean;
}

/**
 * Coverage report proving every parent file and criterion is mapped.
 * Any unmapped item blocks finalize.
 */
export interface CoverageReport {
  fileOwnership: FileOwnership[];
  criterionOwnership: Array<{ criterion: string; ownedBy: string[] }>;
  /** Parent files not assigned to any subtask */
  unmappedFiles: string[];
  /** Parent success criteria not assigned to any subtask */
  unmappedCriteria: string[];
  /** Files assigned to more than one subtask (duplication) */
  duplicatedFiles: string[];
  /** True when any unmappedFiles or unmappedCriteria remain */
  hasCoverageGap: boolean;
}

/** Parent readiness summary from a prep check */
export interface ParentReadiness {
  score: number;
  ready: boolean;
  deficiencies: string[];
}

/** Topology result from plan mode — side-effect free */
export interface DecompositionTopology {
  parentTaskId: string;
  subtasks: SubtaskDefinition[];
  coverageReport: CoverageReport;
  parentReadiness?: ParentReadiness;
}

/** Quality gate result for a single child draft */
export interface QualityGateResult {
  subtaskId: string;
  prepScore: number;
  prepReady: boolean;
  sectionsPresent: string[];
  deficiencies: string[];
  parseError?: string;
}

/**
 * Rich child draft produced by subtask-materializer.
 * Contains full markdown plus quality metrics.
 */
export interface ChildDraft {
  subtaskId: string;
  title: string;
  markdown: string;
  sectionsPresent: string[];
  prepScore: number;
  prepReady: boolean;
  deficiencies: string[];
  parseError?: string;
}

/** Staged decompose request body */
export interface DecomposeRequest {
  /** Operation mode — determines what side-effects occur */
  mode: "plan" | "materialize" | "finalize";
  /** Maximum child tasks to produce (plan and materialize only) */
  maxSubtasks?: number;
  /** Topology result from a previous plan call (materialize and finalize) */
  plan?: DecompositionTopology;
  /** Pre-materialized drafts from a previous materialize call (finalize only) */
  drafts?: ChildDraft[];
  /** Whether to enqueue children after writing (finalize only) */
  enqueue?: boolean;
  /** Must be true to allow finalize to write files */
  reviewAcknowledged?: boolean;
}

/** Staged decompose response body */
export interface DecomposeResponse {
  ok: boolean;
  mode: "plan" | "materialize" | "finalize";
  taskId: string;
  /** Present on plan and materialize responses */
  topology?: DecompositionTopology;
  /** Present on materialize and finalize responses */
  drafts?: ChildDraft[];
  /** Present on finalize success */
  writtenPaths?: string[];
  enqueuedItems?: Array<{ taskId: string; status: string }>;
  parentStatusUpdated?: boolean;
  /** Refusal code when ok=false */
  refusalCode?: DecomposeRefusalCode;
  /** Human-readable refusal message */
  refusalMessage?: string;
}
