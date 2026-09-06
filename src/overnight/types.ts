import type { ParsedTask } from "../core/types.js";
import type { AdminRunStageProgress } from "../monitor/admin-run-stage-policy.js";

export type OvernightTaskStatus =
  | "pending_prep"
  | "ready_for_dispatch"
  | "running"
  | "completed"
  | "failed"
  | "manual_review"
  | "blocked"
  | "needs_decomposition"
  | "decomposed"
  | "skipped";

export type OvernightFailureClass =
  | "task_failure"
  | "quack_infra"
  | "parse_error"
  | "dependency_blocked"
  | "verification_failed"
  | "unknown";

export interface OvernightPrepResult {
  schemaValid: boolean;
  schemaErrors: string[];
  depthScore: number;
  depthReady: boolean;
  deficiencies: string[];
  outcome: "pass" | "enriched" | "rejected";
  recommendDecomposition?: boolean;
  decompositionReason?: string;
}

export interface OvernightTaskRecord {
  taskId: string;
  title?: string;
  taskFile?: string;
  sourcePath?: string;
  status: OvernightTaskStatus;
  prepAttempts: number;
  dispatchAttempts: number;
  enrichmentAttempts: number;
  depthScore?: number;
  depthReady?: boolean;
  deficiencies: string[];
  blockedBy?: string[];
  recommendDecomposition?: boolean;
  decompositionReason?: string;
  subtaskIds?: string[];
  sessionId?: string;
  lastOutcome?: string;
  lastCostUsd?: number;
  failureClass?: OvernightFailureClass;
  lastError?: string;
  updatedAt: string;
  /** "direct" for local monitor dispatch, "federation" for /v1/federation/queue dispatch. */
  dispatchMode?: "direct" | "federation";
  /** Job ID returned by the federation queue when dispatchMode is "federation". */
  federatedJobId?: string;
  /** Host ID the federation scheduler assigned this job to (when known). */
  federatedHostId?: string;
  /** Topology returned by the decompose plan step (kept for admin resume). */
  decomposePlan?: Record<string, unknown>;
  /** Number of child drafts materialized in the decompose materialize step. */
  decomposeDraftCount?: number;
  /** True when the materialize step reported a clean coverage report. */
  decomposeCoverageClean?: boolean;
  /** Refusal code from a failed decompose finalize step. */
  decomposeRefusalCode?: string;
  /** Human-readable refusal message from a failed decompose step. */
  decomposeRefusalMessage?: string;
}

export interface OvernightRunSettings {
  projectRoot: string;
  projectId: string;
  monitorUrl: string;
  sourceBranch?: string;
  targetBranch: string;
  minDepthScore: number;
  maxPrepAttempts: number;
  maxEnrichmentAttempts: number;
  maxDispatchAttempts: number;
  maxDispatches: number;
  activeDispatchLimit: number;
  pollIntervalMs: number;
  verifyAfterDispatch: boolean;
  autoEnrich: boolean;
  autoDecompose: boolean;
  maxSubtasks: number;
  skipGateOnDispatch: boolean;
  haltOnParseErrors: boolean;
  maxInfraFailures: number;
  maxBudgetUsd?: number;
  /** When true, dispatch through /v1/federation/queue instead of /api/tasks/:id/start. */
  federationDispatch: boolean;
  /** Preferred host ID to pass to the federation scheduler (operator-controlled). */
  preferredHostId?: string;
  /** When true, pass allowLowPreflight:true to the federation queue. */
  allowLowPreflightOnFederationDispatch: boolean;
  /** When true, auto-decompose may proceed to finalize without operator review. */
  autoAcknowledgeDecomposeReview: boolean;
}

export interface OvernightEvent {
  timestamp: string;
  type: string;
  taskId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface OvernightRunCheckpoint {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  settings: OvernightRunSettings;
  tasks: OvernightTaskRecord[];
  events: OvernightEvent[];
  dispatchesStarted: number;
  totalCostUsd: number;
  halted: boolean;
  haltReason?: string;
  currentStage?: AdminRunStageProgress;
}

export interface OvernightInventoryItem {
  taskId: string;
  sourcePath?: string;
  task?: ParsedTask;
  taskFile?: string;
  parseError?: string;
  dependenciesSatisfied?: boolean;
  verified?: boolean;
}

export interface OvernightDispatchJob {
  taskId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "stopped" | "awaiting_approval";
  exitCode?: number;
  output?: string[];
}

export interface OvernightSessionEntry {
  sessionId: string;
  taskId: string;
  project?: string;
  title?: string;
  startTime: string;
  status: "active" | "completed" | "error";
  outcome?: string;
  totalCostUsd?: number;
  durationMs?: number;
  turnsUsed?: number;
}

export interface OvernightVerificationResult {
  allPassed?: boolean;
  commands?: Array<{
    name: string;
    passed: boolean;
    output?: string;
  }>;
  conventionChecks?: Array<{
    name: string;
    passed: boolean;
    output?: string;
  }>;
}

export interface OvernightRunnerOptions {
  projectRoot?: string;
  monitorUrl?: string;
  taskIds?: string[];
  sourceBranch?: string;
  targetBranch?: string;
  checkpointPath?: string;
  minDepthScore?: number;
  maxPrepAttempts?: number;
  maxEnrichmentAttempts?: number;
  maxDispatchAttempts?: number;
  maxDispatches?: number;
  activeDispatchLimit?: number;
  pollIntervalMs?: number;
  verifyAfterDispatch?: boolean;
  autoEnrich?: boolean;
  autoDecompose?: boolean;
  maxSubtasks?: number;
  skipGateOnDispatch?: boolean;
  haltOnParseErrors?: boolean;
  maxInfraFailures?: number;
  maxBudgetUsd?: number;
  dryRun?: boolean;
  once?: boolean;
  maxCycles?: number;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  logger?: (message: string) => void;
  /** When true, dispatch through /v1/federation/queue (requires QUACK_SERVICE_TOKEN). */
  federationDispatch?: boolean;
  /** Preferred host ID to pass to the federation scheduler (operator-controlled). */
  preferredHostId?: string;
  /** When true, pass allowLowPreflight:true to the federation queue. */
  allowLowPreflightOnFederationDispatch?: boolean;
  /** When true, auto-decompose may proceed to finalize without operator review. */
  autoAcknowledgeDecomposeReview?: boolean;
}
