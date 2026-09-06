// ─── Pre-Flight Types ──────────────────────────────────────────────
// Interfaces for the pre-flight pipeline that runs gate + blueprint +
// context estimation + complexity evaluation before dispatch.

import type { ContextSizeEstimate } from "../core/types.js";
import type { Blueprint } from "../blueprint/blueprint-types.js";
import type { SpecReviewResult } from "./spec-review-types.js";
import type { RuntimeDiagnostics } from "../core/runtime-errors.js";

// ─── Complexity Thresholds ──────────────────────────────────────────

export interface ComplexityThresholds {
  /** Max files to modify before recommending decomposition */
  maxFilesBeforeDecompose: number;
  /** Max success criteria before recommending decomposition */
  maxCriteriaBeforeDecompose: number;
  /** Max estimated context tokens before recommending decomposition */
  maxContextTokensBeforeDecompose: number;
  /** Max independent feature groups before recommending decomposition */
  maxIndependentFeatures: number;
}

export const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  maxFilesBeforeDecompose: 6,
  maxCriteriaBeforeDecompose: 8,
  maxContextTokensBeforeDecompose: 35_000,
  maxIndependentFeatures: 3,
};

// ─── Preflight Config ───────────────────────────────────────────────

export interface AutoDecomposeConfig {
  /** Whether to auto-decompose when complexity exceeds thresholds */
  enabled: boolean;
  /** Maximum number of subtasks to generate */
  maxSubtasks: number;
  /** Whether to write subtask spec files to disk */
  writeSpecs: boolean;
  /** Minimum parent prep depth score required before finalize is allowed */
  parentPrepThreshold?: number;
}

export interface PreflightConfig {
  /** Auto-run pre-flight when tasks are registered */
  autoRun: boolean;
  /** Complexity thresholds for decomposition recommendation */
  complexityThresholds: ComplexityThresholds;
  /** Spec review configuration */
  specReview?: {
    enabled: boolean;
    model: string;
  };
  /** Auto-decomposition configuration */
  autoDecompose?: AutoDecomposeConfig;
}

// ─── Complexity Result ──────────────────────────────────────────────

export interface FeatureCluster {
  /** Human-readable label: file basename or "unmapped" */
  label: string;
  /** Indices into the successCriteria array */
  criteriaIndices: number[];
  /** File paths in this cluster (empty for "unmapped") */
  files: string[];
}

export interface ComplexityResult {
  filesToModify: number;
  successCriteria: number;
  estimatedContextTokens: number;
  /** Number of independent feature groups detected */
  independentFeatures: number;
  /** Feature clusters by file association */
  featureClusters: FeatureCluster[];
  /** Whether this task exceeds decomposition thresholds */
  recommendDecomposition: boolean;
  /** Reason for recommendation */
  reason: string;
}

// ─── Pre-Flight Result ──────────────────────────────────────────────

export interface PreflightResult {
  taskId: string;
  timestamp: string;
  contentHash: string;
  gate: {
    ready: boolean;
    score: number;
    dimensions: Record<string, number>;
    /** ADVISORY-prefixed gate findings (low depth dimensions, artifact collisions). Informational, never blocking (TASK-1300). */
    advisories?: string[];
    /** TASK-1315: the readiness intent mode this result was computed under
     * (absent on legacy caches = off-era). Cache validity fingerprints it. */
    readinessJudgmentMode?: "off" | "shadow" | "enforce";
    /** TASK-1315 r2-F1: true when the gate stage was SKIPPED (skipGate
     * preflight) — such results carry a synthetic score and must never
     * authorize a dispatcher gate skip. */
    gateSkipped?: boolean;
    /** TASK-1315: the ACTIVE gate outcome (post-orchestration). */
    activeOutcome?: "pass" | "enriched" | "rejected";
    /** TASK-1315: compact orchestration summary for the approval UI. */
    orchestration?: {
      mode: "off" | "shadow" | "enforce";
      attempted: boolean;
      reason: string;
      diverged: boolean;
      rationale?: string[];
    };
  };
  blueprint: {
    fileAnalyses: number;
    codeExamples: number;
    verificationPatterns: number;
    antiPatterns: number;
    /** The formatted markdown blueprint string, ready for prompt inclusion */
    formattedMarkdown: string;
    /**
     * The full structured Blueprint/Brief object (TASK-1306). Present on the
     * LLM blueprint path; absent on the deterministic/degraded path and in
     * pre-1306 cache files. Consumers must treat absence as the legacy case.
     */
    structured?: Blueprint;
    /**
     * TASK-1324 monotonic cache guard receipt: present when a fresh
     * fidelity-FAILED synthesis tried to overwrite a cached fidelity-ok
     * brief for the SAME contentHash and the cache kept the good one.
     * The refused synthesis is recorded here — loud, never a warn.
     */
    structuredPreserved?: {
      reason: "fidelity_monotonic_guard";
      preservedFrom: string;
      refusedCheckedAt: string;
    };
    /**
     * TASK-1324 round-2 F1: the fidelity verdict persisted BESIDE the
     * structured object, so it survives the 256KB honesty guard that
     * drops `structured` — a size-dropped brief's rehydrated stub then
     * reattaches the REAL verdict instead of reading as unchecked.
     */
    fidelity?: import("../blueprint/blueprint-types.js").BriefFidelityResult;
  };
  contextEstimate: ContextSizeEstimate;
  complexity: ComplexityResult;
  /** Spec ambiguity review results (omitted when specReview.enabled is false) */
  specReview?: SpecReviewResult;
  /** Auto-decomposition results (present when auto-decompose ran) */
  decomposition?: {
    /** QPI-048: true ONLY when child spec files exist on disk. */
    decomposed: boolean;
    subtaskIds: string[];
    subtaskFiles: string[];
    /** QPI-048 leg (e): a plan existed but writeSpecs suppressed the
     *  children - the ids above are a RECOMMENDATION, never enforced. */
    advisoryOnly?: boolean;
    /** A write-capable run found more than one file declaring the parent id. */
    refused?: {
      errorType: "duplicate_claimants";
      claimants: string[];
    };
  };
  /** Pipeline mode used to produce this result. */
  mode?: "full" | "deterministic";
  /**
   * Present when runtime-dependent stages were unavailable and a deterministic
   * fallback path was used.
   */
  degraded?: {
    reason: string;
    diagnostics: RuntimeDiagnostics;
    checksRun: string[];
    checksSkipped: string[];
  };
}
