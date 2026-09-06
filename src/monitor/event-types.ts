// ─── Event Types ───────────────────────────────────────────────────
// Defines the QuackEvent schema used for all pipeline event logging.
// Events are written as JSONL lines to .quack/logs/ and streamed
// to the monitor dashboard via SSE.

import type {
  BlockReasonCode,
  DocsImpact,
  WikiAction,
  WorkflowLane,
  WorkflowRiskLevel,
  WorkflowState,
} from "../workflow/workflow-state-types.js";
import type { ExecutionMode } from "../core/types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";
import type { ReviewerRunnerKind, ReviewKind, ReviewRunResult } from "../review/reviewer-types.js";
import type {
  JudgmentContractErrorCode,
  JudgmentDecision,
  JudgmentOrchestrationResult,
  JudgmentStage,
} from "../judgment/judgment-types.js";
import type { BranchMutationFact } from "../judgment/producers/branch-mutation.js";
import type { DeployFact } from "../judgment/producers/deploy-classifier.js";
import type { SealConformanceFact } from "../judgment/producers/seal-conformance.js";
import type { JobProvenance } from "./federation/types.js";

// ─── Event Stages ──────────────────────────────────────────────────

export type EventStage =
  | "session_start"
  | "gate_schema"
  | "gate_depth"
  | "gate_advisory"
  | "gate_artifact_collisions"
  | "gate_result"
  | "judgment_decision"
  | "judgment_evaluation"
  | "judgment_hold_cleared"
  | "judgment_projection_failed"
  | "blueprint_start"
  | "blueprint_warning"
  | "blueprint_fallback"
  | "blueprint_generated"
  | "blueprint_structured_omitted"
  | "blueprint_pending_approval"
  /** TASK-1332 (QPI-045): a run refused to consume an artifact whose spec
   *  contract moved, could not be verified, or has contested ownership.
   *  The first two recover by replan; contested ownership recovers by
   *  removing or renaming the extra claimant file. Deliberately distinct
   *  from `session_error` so the control plane does not call it a crash. */
  | "spec_identity_stale"
  | "blueprint_approved"
  | "blueprint_rejected"
  | "blueprint_replan_complete"
  | "blueprint_replan_failed"
  | "loop_brief_review"
  | "loop_diff_review"
  | "judge_pending_approval"
  | "judge_review_auto_approved"
  | "judge_approved"
  | "judge_rejected"
  | "prep_schema_done"
  | "prep_depth_start"
  | "prep_depth_done"
  | "prep_complete"
  | "preflight_start"
  | "preflight_gate"
  | "preflight_spec_review"
  | "preflight_spec_review_failed"
  | "preflight_runtime_unavailable"
  | "preflight_degraded"
  | "preflight_blueprint"
  | "preflight_analysis"
  | "preflight_complete"
  | "preflight_auto_decompose"
  | "preflight_auto_decompose_complete"
  | "preflight_auto_decompose_failed"
  | "preflight_auto_decompose_refused"
  | "preflight_auto_decompose_skipped"
  | "preflight_auto_decompose_specs_committed"
  | "preflight_auto_decompose_specs_commit_failed"
  | "task_status_drift"
  | "stage_started"
  | "stage_heartbeat"
  | "stage_completed"
  | "stage_failed"
  | "task_decomposed"
  | "context_assembled"
  | "context_size"
  | "branch_created"
  | "branch_resumed"
  | "branch_reused"
  | "branch_cleaned"
  | "branch_deleted"
  | "branch_target_resolved"
  | "agent_turn"
  | "agent_tool_use"
  | "agent_complete"
  | "agent_output_seal_start"
  | "agent_output_sealed"
  | "agent_output_seal_failed"
  | "verification_start"
  | "verification_result"
  | "judge_start"
  | "judge_result"
  | "post_judge_verify_start"
  | "post_judge_verify_result"
  | "post_judge_verify_finding"
  | "post_judge_semantic_truncated"
  | "auto_commit"
  | "retry_start"
  | "pr_created"
  | "session_complete"
  | "session_error"
  | "loop_finalize_recorded"
  | "loop_finalize_record_failed"
  | "safety_fact"
  | "seal_conformance"
  | "auto_prep_started"
  | "auto_prep_paused"
  | "auto_prep_rate_limited"
  | "auto_prep_budget_exceeded"
  | "auto_prep_queue_empty"
  | "auto_prep_parse_errors"
  | "cost_alert"
  | "budget_circuit_break"
  | "fleet_budget_alert"
  | "fleet_budget_blocked"
  | "testing_output"
  | "testing_complete"
  | "transcript_linked"
  | "fleet_emergency_stop"
  | "fleet_paused"
  | "fleet_resumed"
  | "container_created"
  | "container_stopped"
  | "container_error"
  | "model_escalated"
  | "cost_velocity_warning"
  | "cost_velocity_kill"
  | "agent_progress"
  | "agent_stuck_warning"
  | "agent_stuck_critical"
  | "agent_stuck_killed"
  | "cache_metrics"
  | "agent_resume"
  | "agent_progress_update"
  | "checkpoint_saved"
  | "checkpoint_loaded"
  | "stage_skipped"
  | "dispatch_queue_started"
  | "dispatch_queue_paused"
  | "dispatch_queue_resumed"
  | "dispatch_queue_stopped"
  | "dispatch_queue_drained"
  | "dispatch_queue_recovered"
  | "dispatch_queue_recovery_scan_unavailable"
  | "dispatch_queue_error"
  | "dispatch_queue_task_enqueued"
  | "dispatch_queue_task_ready"
  | "dispatch_queue_task_started"
  | "dispatch_queue_task_completed"
  | "dispatch_queue_task_failed"
  | "dispatch_queue_task_blocked"
  | "dispatch_queue_task_unblocked"
  | "dispatch_queue_task_refused"
  | "follow_up_tasks_created"
  | "follow_up_tasks_refused"
  | "docs_change_event"
  | "revision_start"
  | "revision_complete"
  | "test_baseline_start"
  | "test_baseline_complete"
  | "test_run_start"
  | "test_run_complete"
  | "test_result_summary"
  | "test_dashboard_update"
  | "retry_resume"
  | "retry_resume_skipped"
  | "gate_advisory_applied"
  // TASK-1319 (P2-5): a decision that contradicted stored advice.
  | "advisory_override_recorded"
  // QPI-043: how a dispatch child STOPPED, written durably because the
  // in-memory job record does not survive a monitor restart.
  | "dispatch_child_exit"
  | "auto_merge_complete"
  | "auto_merge_failed"
  | "subtask_merged_to_feature_branch"
  | "worktree_failed"
  // TASK-1313 S5 (round-2 F7): pre-session branch-guard refusal from the
  // monitor's stale-branch cleanup, forwarded off the dispatch lifecycle
  // callback (sessionId "dispatch", like worktree_failed).
  | "branch_guard_refusal"
  // TASK-1326 (QPI-042): an operator override of a human-gate pause
  // archived the prior run's branch ref / checkpoint / pending record.
  | "paused_run_archived"
  | "core_worktree_cleaned"
  | "worker_sandbox_thrash"
  | "dispatch_rejected"
  | "scope_check"
  | "needs_review"
  | "lifecycle_verify_start"
  | "lifecycle_verify_result"
  | "lifecycle_fix_start"
  | "lifecycle_fix_complete"
  | "lifecycle_fix_exhausted"
  | "lifecycle_verify_skipped"
  | "lifecycle_status_updated"
  | "lifecycle_blocker_resolved"
  | "lifecycle_parent_completed"
  | "lifecycle_complete"
  | "runtime_check_start"
  | "runtime_check_complete"
  | "runtime_check_skipped"
  | "tier3_threshold_reached"
  | "lifecycle_tiered_results"
  | "docker_warmup_start"
  | "docker_warmup_complete"
  | "docker_teardown"
  | "tasks_stale"
  | "tasks_refreshed"
  | "recording_on_merge"
  | "recording_unregistered_merge"
  | "recording_claimant_diagnostic"
  | "task_rejected"
  | "task_verification_needed"
  | "intake_submitted"
  | "intake_classified"
  | "intake_routed"
  | "federated_job_submitted"
  | "federated_job_assigned"
  | "federated_transport_failed"
  | "federated_job_canceled"
  | "federated_job_status"
  | "federated_job_event"
  | "workflow_projection_updated"
  | "workflow_pending_state"
  | "lifecycle_status_update_failed";

// ─── Stage-specific payloads ───────────────────────────────────────

export interface SessionStartPayload {
  model: string;
  maxTurns: number;
  maxBudget: number;
  taskId?: string;
  taskTitle?: string;
  taskDescription?: string;
  jobId?: string;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
  remoteSessionId?: string;
  leaseId?: string;
  /** TASK-1323: how this dispatch entered the system. Absent only on
   *  pre-1323 events; every new emit site attaches it. */
  provenance?: JobProvenance;
  federated?: boolean;
}

export interface GateSchemaPayload {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export interface GateDepthPayload {
  ready: boolean;
  overallScore: number;
  deficiencies: string[];
}

export interface GateAdvisoryPayload {
  suggestedMinScore: number;
  warnings: string[];
  relevantPatterns: string[];
}

export interface GateResultPayload {
  outcome: "pass" | "enriched" | "rejected";
  reason?: string;
}

export interface JudgmentDecisionPayload {
  taskId: string;
  stage: JudgmentStage;
  decision: JudgmentDecision;
  attempt?: number;
  sequence?: number;
  final?: boolean;
}

export interface JudgmentProjectionFailedPayload {
  taskId: string;
  stage: JudgmentStage;
  errorCode: JudgmentContractErrorCode | "unexpected_projection_error";
  message: string;
  attempt?: number;
  sequence?: number;
}

export interface JudgmentEvaluationPayload {
  taskId: string;
  stage: JudgmentStage;
  sequence: number;
  final: false;
  orchestration: JudgmentOrchestrationResult;
}

/**
 * TASK-1316: a human released an intent hold for this exact diff, so the
 * cutover stood down for the attempt instead of re-asking and re-pausing.
 * Emitted INSTEAD of an orchestration — no runner is constructed.
 */
export interface JudgmentHoldClearedPayload {
  taskId: string;
  stage: JudgmentStage;
  attempt: number;
  clearedBy: string;
  rationale: string[];
}

/**
 * Producer facts recorded for attempt visibility (TASK-1312). NOT wired
 * into any stage decision — evidence and observability only.
 */
export interface SafetyFactPayload {
  taskId?: string;
  origin:
    | "worker_bash_denial"
    | "worker_bash_observation"
    | "dispatcher_branch_guard"
    | "verification_integrity"
    | "resume_validation";
  facts: Array<BranchMutationFact | DeployFact>;
  /** Machinery mismatches for the integrity/resume origins (TASK-1313). */
  integrityMismatches?: Array<{
    path: string;
    reason: "hash_mismatch" | "worktree_only" | "authoritative_only";
  }>;
}

export interface SealConformancePayload {
  taskId: string;
  attempt: number;
  kind: string;
  tierSCount: number;
  tierRCount: number;
  deniedPathCount: number;
  outsideWritableCount: number;
  cleanCount: number;
  facts: SealConformanceFact[];
  secretScan: { safetyCount: number; humanReviewCount: number };
}

export interface BlueprintGeneratedPayload {
  taskId: string;
  fileAnalyses: number;
  codeExamples: number;
  verificationPatterns: number;
  antiPatterns: number;
}

export interface BlueprintPendingApprovalPayload {
  taskId: string;
  autoApproveAttempted: boolean;
  reason: string;
}

export interface LoopReviewPayload {
  taskId: string;
  executionMode: "loop";
  reviewKind: ReviewKind;
  runnerKind: ReviewerRunnerKind;
  result: ReviewRunResult;
  reviewGate: LoopReviewGateFacts;
  nextState: "auto-approved" | "pending";
}

export interface BlueprintApprovedPayload {
  taskId: string;
  approvedBy: string;
}

export interface BlueprintRejectedPayload {
  taskId: string;
  rejectionReason: string;
}

export interface BlueprintReplanCompletePayload {
  taskId: string;
}

export interface BlueprintReplanFailedPayload {
  taskId: string;
  error: string;
}

export interface ContextAssembledPayload {
  conventionsCount: number;
  relevantFilesCount: number;
  relatedPatternsCount: number;
  existingTestsCount: number;
  claudeMdCount: number;
}

export interface ContextSizePayload {
  taskSpec: number;
  blueprint: number;
  repoMap: number;
  relevantFiles: number;
  relatedPatterns: number;
  existingTests: number;
  conventions: number;
  claudeMd: number;
  total: number;
  withinBudget: boolean;
}

export interface BranchCreatedPayload {
  branchName: string;
}

export interface BranchResumedPayload {
  branchName: string;
  reason: string;
}

export interface BranchReusedPayload {
  branchName: string;
  reason: string;
}

export interface BranchCleanedPayload {
  branchName: string;
  reason: string;
}

export interface BranchDeletedPayload {
  branch: string;
  taskId: string;
  /** true if remote branch was also deleted */
  remote: boolean;
  /** true if this was a dry-run (no actual deletion) */
  dryRun: boolean;
  timestamp: string;
}

export interface AgentTurnPayload {
  turnNumber: number;
  role: string;
  contentPreview: string;
}

export interface AgentToolUsePayload {
  turnNumber: number;
  toolName: string;
  filePath?: string;
  bashCommand?: string;
}

export interface AgentCompletePayload {
  outcome: string;
  turnsUsed: number;
  totalCostUsd: number;
  filesModified: string[];
  claudeSessionId?: string;
  /**
   * TASK-1314: bounded SDK error detail for error-subtype results
   * (≤10 items, ≤500 chars each, ≤4000 aggregate, truncation-marked).
   * Present only when the run ended on an SDK error result.
   */
  errors?: string[];
}

export interface AgentOutputSealStartPayload {
  taskId: string;
  attempt: number;
  kind: string;
  diffBase?: string;
}

export interface AgentOutputSealedPayload {
  taskId: string;
  attempt: number;
  kind: string;
  sealedCommitSha?: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  filesStaged: number;
  excludedFiles: string[];
  manifestPath: string;
  diffPath: string;
  diffLines: number;
}

export interface AgentOutputSealFailedPayload {
  taskId: string;
  attempt: number;
  kind: string;
  error: string;
}

export interface VerificationStartPayload {
  commandCount: number;
}

export interface VerificationResultPayload {
  allPassed: boolean;
  commands: Array<{ name: string; passed: boolean }>;
}

export interface JudgeStartPayload {
  model: string;
}

export interface JudgeResultPayload {
  verdict: string;
  confidence: number;
  scopeViolations: string[];
  criteriaGaps: string[];
  qualityIssues: string[];
  feedback: string;
}

export interface PostJudgeVerifyStartPayload {
  taskId: string;
}

export interface PostJudgeVerifyResultPayload {
  taskId: string;
  verified: boolean;
  findings: Array<{ criterion: string; status: string; evidence: string }>;
}

export interface PostJudgeVerifyFindingPayload {
  taskId: string;
  criterion: string;
  status: "pass" | "fail" | "warn";
  evidence: string;
}

export interface PostJudgeSemanticTruncatedPayload {
  taskId: string;
  originalTokens: number;
  retainedTokens: number;
  fileCount: number;
  mode: "truncated" | "skipped";
}

export interface AutoCommitPayload {
  filesStaged: number;
  commitMessage: string;
}

export interface RetryStartPayload {
  attempt: number;
  maxRetries: number;
  feedbackSummary: string;
}

export interface PrCreatedPayload {
  prUrl: string;
  branchName: string;
}

export interface CacheMetrics {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  cacheHitRate: number; // 0-100 percentage
}

export interface SessionCompletePayload {
  outcome: string;
  durationMs: number;
  totalCostUsd: number;
  cacheMetrics?: CacheMetrics;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
  executionMode?: ExecutionMode;
  lifecycleVerified?: boolean;
  autoMerged?: boolean;
  mergeCommitSha?: string;
  recordOnFinalize?: boolean;
}

export interface LoopFinalizeRecordedPayload {
  taskId: string;
  commit: string;
  applied: boolean;
  reason?: string;
}

export interface LoopFinalizeRecordFailedPayload {
  taskId: string;
  commit: string;
  error: string;
}

export interface SessionErrorPayload {
  error: string;
  failedStage: string;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
}

export interface PrepSchemaDonePayload {
  taskId: string;
  valid: boolean;
  errors: string[];
}

export interface PrepDepthStartPayload {
  taskId: string;
}

export interface PrepDepthDonePayload {
  taskId: string;
  score: number;
  ready: boolean;
  deficiencies: string[];
}

export interface PrepCompletePayload {
  taskId: string;
  outcome: "pass" | "enriched" | "rejected";
}

export interface PreflightStartPayload {
  taskId: string;
}

export interface PreflightGatePayload {
  taskId: string;
}

export interface PreflightSpecReviewPayload {
  taskId: string;
  riskLevel: "low" | "medium" | "high";
  ambiguityCount: number;
}

export interface PreflightBlueprintPayload {
  taskId: string;
}

export interface PreflightAnalysisPayload {
  taskId: string;
}

export interface PreflightCompletePayload {
  taskId: string;
  cached: boolean;
  recommendDecomposition: boolean;
}

export interface ClaimantDiagnosticPayload {
  kind: "duplicate-claimants" | "claimant-index-unavailable";
  taskId: string;
  commitSha: string;
  claimants: string[];
  scannerMethod: "on-merge" | "migration-scan";
  reason: string;
}

export interface PreflightAutoDecomposeRefusedPayload {
  taskId: string;
  errorType: "duplicate_claimants";
  claimants: string[];
}

export interface StageStartedPayload {
  taskId: string;
  scope: string;
  stage: string;
  staleAfterMs: number;
  recommendedAction: string;
  detail?: string;
}

export interface StageHeartbeatPayload {
  taskId: string;
  scope: string;
  stage: string;
  staleAfterMs: number;
  recommendedAction: string;
  detail?: string;
}

export interface StageCompletedPayload {
  taskId: string;
  scope: string;
  stage: string;
  detail?: string;
}

export interface StageFailedPayload {
  taskId: string;
  scope: string;
  stage: string;
  error: string;
  recommendedAction: string;
  detail?: string;
}

export interface TaskDecomposedPayload {
  taskId: string;
  subtaskCount: number;
  subtaskIds: string[];
  dryRun: boolean;
}

export interface AutoPrepStartedPayload {
  queueSize: number;
}

export interface AutoPrepPausedPayload {
  reason: string;
  queueRemaining: number;
}

export interface AutoPrepRateLimitedPayload {
  limitType: string;
  resumeAt: string;
}

export interface AutoPrepBudgetExceededPayload {
  hourlySpend: number;
  hourlyLimit: number;
}

export interface AutoPrepQueueEmptyPayload {
  totalProcessed: number;
}

export interface AutoPrepParseErrorsPayload {
  parseErrorCount: number;
  parseErrors: Array<{ file: string; error: string }>;
}

export interface CostAlertPayload {
  level: "yellow" | "orange" | "red";
  currentCostUsd: number;
  budgetUsd: number;
  percentUsed: number;
  message: string;
}

export interface BudgetCircuitBreakPayload {
  totalCostUsd: number;
  budgetUsd: number;
  retriesUsed: number;
  maxRetries: number;
  message: string;
}

export interface TestingOutputPayload {
  name: string;
  text: string;
}

export interface TestingCompletePayload {
  name: string;
  exitCode: number;
  durationMs: number;
}

export interface TranscriptLinkedPayload {
  claudeSessionIds: string[];
  transcriptPaths: string[];
}

export interface FleetBudgetAlertPayload {
  level: string;
  metric: "daily" | "hourly";
  currentUsd: number;
  capUsd: number;
  percentUsed: number;
}

export interface FleetBudgetBlockedPayload {
  taskId: string;
  reason: string;
  currentSpend: { daily: number; hourly: number };
  limits: { daily: number; hourly: number };
}

export interface FleetEmergencyStopPayload {
  reason: string;
  killedTasks: string[];
  killedPids: number[];
}

export interface FleetPausedPayload {
  reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FleetResumedPayload {
  // No additional fields needed
}

export interface ContainerCreatedPayload {
  taskId: string;
  containerId: string;
  image: string;
  resourceLimits: { memoryMb: number; cpus: number; storageMb?: number };
}

export interface ContainerStoppedPayload {
  taskId: string;
  containerId: string;
  reason: string;
  exitCode: number | null;
}

export interface ContainerErrorPayload {
  taskId: string;
  containerId: string;
  error: string;
}

export interface ModelEscalatedPayload {
  taskId: string;
  fromModel: string;
  toModel: string;
  retryAttempt: number;
  reason: string;
}

export interface CostVelocityWarningPayload {
  taskId: string;
  costPerMinute: number;
  medianCostPerMinute: number;
  multiplier: number;
  message: string;
}

export interface CostVelocityKillPayload {
  taskId: string;
  costPerMinute: number;
  medianCostPerMinute: number;
  multiplier: number;
  totalCostUsd: number;
  message: string;
}

export interface AgentProgressPayload {
  taskId: string;
  turnNumber: number;
  toolName?: string;
  filePath?: string;
  costUsd?: number;
  elapsedMs: number;
}

export interface AgentStuckWarningPayload {
  taskId: string;
  silentMs: number;
  lastActivity: string;
  turnNumber: number;
}

export interface AgentStuckCriticalPayload {
  taskId: string;
  silentMs: number;
  lastActivity: string;
  turnNumber: number;
}

export interface AgentStuckKilledPayload {
  taskId: string;
  silentMs: number;
  totalCostUsd: number;
  turnsCompleted: number;
}

export interface AgentResumePayload {
  taskId: string;
  reason: string;
  claudeSessionId: string;
  remainingBudgetUsd: number;
}

export interface AgentProgressUpdatePayload {
  taskId: string;
  completed: string[];
  inProgress: string[];
  remaining: string[];
  issues: string[];
  rawContent: string;
  lastUpdated: string;
}

export interface CheckpointSavedPayload {
  taskId: string;
  stage: string;
  completedStages: string[];
}

export interface CheckpointLoadedPayload {
  taskId: string;
  completedStages: string[];
  resumeFromStage: string;
}

export interface StageSkippedPayload {
  taskId: string;
  stage: string;
  reason: string;
}

export interface FollowUpTasksCreatedPayload {
  parentTaskId: string;
  count: number;
  taskIds: string[];
}

export interface FollowUpTasksRefusedPayload {
  parentTaskId: string;
  errorType: "duplicate_claimants";
  claimants: string[];
}

export interface DocsChangeEventPayload {
  taskId: string;
  reviewId?: string;
  jobId?: string;
  docsImpact: DocsImpact;
  requiredWikiActions?: WikiAction[];
  wikiArtifacts?: number;
  supportDocCandidates?: number;
  mergeReady?: boolean;
  workflowState?: WorkflowState;
  blockReasonCode?: BlockReasonCode;
}

export interface RevisionStartPayload {
  taskId: string;
  feedback: string;
  prNumber?: number;
  budget: number;
  turns: number;
}

export interface RevisionCompletePayload {
  taskId: string;
  outcome: string;
  costUsd: number;
  turnsUsed: number;
}

export interface TestBaselineStartPayload {
  taskId: string;
}

export interface TestBaselineCompletePayload {
  taskId: string;
  totalTests: number;
  failedTests: number;
  cachedPath: string;
}

export interface TestRunStartPayload {
  taskId: string;
  mode: "related" | "full" | "baseline";
}

export interface TestRunCompletePayload {
  taskId: string;
  totalTests: number;
  passed: number;
  failed: number;
  newFailures: number;
  preExisting: number;
}

export interface TestResultSummaryPayload {
  taskId: string;
  summary: string;
  allFailuresPreExisting: boolean;
}

export interface TestDashboardUpdatePayload {
  taskId: string;
  projectRoot: string;
}

export interface AutoMergeCompletePayload {
  taskId: string;
  targetBranch: string;
  strategy: string;
}

export interface AutoMergeFailedPayload {
  taskId: string;
  targetBranch: string;
  /** Worktree path for manual recovery (branch is already pushed) */
  worktreePath?: string;
}

export interface SubtaskMergedToFeatureBranchPayload {
  taskId: string;
  parentTaskId: string;
  featureBranch: string;
}

export interface WorktreeFailedPayload {
  taskId: string;
  error: string;
  fallback: "shared_directory";
}

export interface CoreWorktreeCleanedPayload {
  repoPath: string;
  leakedValue: string;
}

export interface DockerWarmupStartPayload {
  taskId: string;
  composeFile: string;
  services: string[];
}

export interface DockerWarmupCompletePayload {
  taskId: string;
  composeFile: string;
  services: string[];
  durationMs: number;
}

export interface DockerTeardownPayload {
  taskId: string;
  composeFile: string;
}

export interface TasksStalePayload {
  diskCount: number;
  parsedCount: number;
  drift: number;
}

export interface TasksRefreshedPayload {
  taskCount: number;
  parseErrorCount: number;
}

export interface TaskRejectedPayload {
  taskId: string;
  reason?: string;
}

export interface TaskVerificationNeededPayload {
  taskId: string;
}

export interface LifecycleVerifyStartPayload {
  taskId: string;
  workflowId?: string;
  projectId?: string;
  reviewId?: string;
}

export interface LifecycleVerifyResultPayload {
  taskId: string;
  workflowId?: string;
  projectId?: string;
  verified: boolean;
  verdict?: string;
  blockReasonCode?: BlockReasonCode;
  findings: Array<{ criterion: string; status: string; evidence: string }>;
}

export interface LifecycleFixStartPayload {
  taskId: string;
  workflowId?: string;
  projectId?: string;
  attempt: number;
  issues: string[];
}

export interface LifecycleFixCompletePayload {
  taskId: string;
  workflowId?: string;
  projectId?: string;
  attempt: number;
  fixed?: boolean;
  exhausted?: boolean;
}

export interface LifecycleFixExhaustedPayload {
  taskId: string;
  workflowId?: string;
  projectId?: string;
  attempts: number;
  remainingIssues: string[];
  blockReasonCode?: BlockReasonCode;
}

export interface IntakeSubmittedPayload {
  intakeId: string;
  workflowId: string;
  taskId?: string;
  source: string;
  requestedBy?: string;
  idempotencyKey?: string;
}

export interface IntakeClassifiedPayload {
  intakeId: string;
  workflowId: string;
  taskId?: string;
  lane: WorkflowLane;
  riskLevel: WorkflowRiskLevel;
  reasons: string[];
}

export interface IntakeRoutedPayload {
  intakeId: string;
  workflowId: string;
  taskId?: string;
  lane: WorkflowLane;
  riskLevel: WorkflowRiskLevel;
  reasons: string[];
  actor: string;
  reason?: string;
}

export interface FederatedJobSubmittedPayload {
  jobId: string;
  taskId: string;
  taskTitle?: string;
  jobType: "intake" | "verify" | "fix" | "dispatch";
  correlationId: string;
  requiredCapabilities: string[];
  /** TASK-1323: entry channel + identity of the submitter. */
  provenance?: JobProvenance;
}

export interface FederatedJobAssignedPayload {
  jobId: string;
  taskId: string;
  taskTitle?: string;
  hostId: string;
  hostAlias?: string;
  hostEndpoint?: string;
  correlationId: string;
  fallbackUsed: boolean;
  requiredCapabilities: string[];
}

export interface FederatedTransportFailedPayload {
  jobId: string;
  taskId: string;
  correlationId: string;
  retryable: boolean;
  blockReasonCode: BlockReasonCode;
  error: string;
}

export interface FederatedJobCanceledPayload {
  jobId: string;
  taskId: string;
  taskTitle?: string;
  correlationId: string;
  canceledBy: string;
}

export interface FederatedJobStatusPayload {
  jobId: string;
  taskId: string;
  taskTitle?: string;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
  status: string;
  workflowState: WorkflowState;
  blockReasonCode?: BlockReasonCode;
  correlationId?: string;
  remoteSessionId?: string;
  message?: string;
  sequence?: number;
  lastEventStage?: string;
  evidenceCount?: number;
}

export interface FederatedJobEventPayload {
  jobId: string;
  taskId: string;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
  remoteSessionId?: string;
  remoteStage: string;
  remoteTimestamp?: string;
  sequence?: number;
  relayedPayload: Record<string, unknown>;
}

export interface WorkflowProjectionUpdatedPayload {
  taskId: string;
  state: WorkflowState;
  blockReasonCode?: BlockReasonCode;
  mergeReady: boolean;
}

export interface WorkflowPendingStatePayload {
  taskId: string;
  state: WorkflowState;
  blockReasonCode: BlockReasonCode;
  label: string;
  lane?: WorkflowLane;
  riskLevel?: WorkflowRiskLevel;
  hostId?: string;
  hostAlias?: string;
  hostEndpoint?: string;
}

export interface LifecycleStatusUpdateFailedPayload {
  taskId: string;
  expectedStatus: string;
  actualContent: string;
}

// ─── Payload union ─────────────────────────────────────────────────

// QPI-043 review follow-up: the judge-gate pause event had no typed
// payload, so its emit sites were only runtime-checked. Shape matches
// both existing emitters (dispatcher.ts judge gate + intent hold).
export interface JudgePendingApprovalPayload {
  taskId: string;
  filesChanged: number;
  diffLines: number;
  reason?: string;
}

// QPI-043: how a dispatch child STOPPED — exit code and, crucially, the
// signal. Appended into the child session's own events jsonl by
// child-exit-log.ts so the facts outlive both the child and the monitor;
// the typed lifecycle callback reaches SSE only and is the fallback.
export interface DispatchChildExitPayload {
  taskId: string;
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  worktreePath: string | null;
  at: string;
  /** Which session file received the durable write (see child-exit-log.ts). */
  sessionResolution?: "child-session" | "latest-task-session" | "job-fallback";
}

export interface DispatchQueueTaskRefusedPayload {
  error: "duplicate_claimants";
  claimants: string[];
  message: string;
  duplicateBlockedBy?: string[];
}

export interface DispatchQueueRecoveryScanUnavailablePayload {
  reason: string;
}

export type EventPayload =
  | SessionStartPayload
  | GateSchemaPayload
  | GateDepthPayload
  | GateAdvisoryPayload
  | GateResultPayload
  | JudgmentDecisionPayload
  | JudgmentEvaluationPayload
  | JudgmentHoldClearedPayload
  | JudgmentProjectionFailedPayload
  | SafetyFactPayload
  | SealConformancePayload
  | BlueprintGeneratedPayload
  | BlueprintPendingApprovalPayload
  | BlueprintApprovedPayload
  | BlueprintRejectedPayload
  | BlueprintReplanCompletePayload
  | BlueprintReplanFailedPayload
  | LoopReviewPayload
  | PrepSchemaDonePayload
  | PrepDepthStartPayload
  | PrepDepthDonePayload
  | PrepCompletePayload
  | PreflightStartPayload
  | PreflightGatePayload
  | PreflightSpecReviewPayload
  | PreflightBlueprintPayload
  | PreflightAnalysisPayload
  | PreflightCompletePayload
  | PreflightAutoDecomposeRefusedPayload
  | StageStartedPayload
  | StageHeartbeatPayload
  | StageCompletedPayload
  | StageFailedPayload
  | TaskDecomposedPayload
  | ContextAssembledPayload
  | ContextSizePayload
  | BranchCreatedPayload
  | BranchResumedPayload
  | BranchReusedPayload
  | BranchCleanedPayload
  | BranchDeletedPayload
  | AgentTurnPayload
  | AgentToolUsePayload
  | AgentCompletePayload
  | AgentOutputSealStartPayload
  | AgentOutputSealedPayload
  | AgentOutputSealFailedPayload
  | VerificationStartPayload
  | VerificationResultPayload
  | JudgeStartPayload
  | JudgeResultPayload
  | PostJudgeVerifyStartPayload
  | PostJudgeVerifyResultPayload
  | PostJudgeVerifyFindingPayload
  | PostJudgeSemanticTruncatedPayload
  | AutoCommitPayload
  | RetryStartPayload
  | PrCreatedPayload
  | SessionCompletePayload
  | SessionErrorPayload
  | ClaimantDiagnosticPayload
  | LoopFinalizeRecordedPayload
  | LoopFinalizeRecordFailedPayload
  | AutoPrepStartedPayload
  | AutoPrepPausedPayload
  | AutoPrepRateLimitedPayload
  | AutoPrepBudgetExceededPayload
  | AutoPrepQueueEmptyPayload
  | AutoPrepParseErrorsPayload
  | CostAlertPayload
  | BudgetCircuitBreakPayload
  | FleetBudgetAlertPayload
  | FleetBudgetBlockedPayload
  | TestingOutputPayload
  | TestingCompletePayload
  | TranscriptLinkedPayload
  | FleetEmergencyStopPayload
  | FleetPausedPayload
  | FleetResumedPayload
  | ContainerCreatedPayload
  | ContainerStoppedPayload
  | ContainerErrorPayload
  | ModelEscalatedPayload
  | CostVelocityWarningPayload
  | CostVelocityKillPayload
  | AgentProgressPayload
  | AgentStuckWarningPayload
  | AgentStuckCriticalPayload
  | AgentStuckKilledPayload
  | CacheMetrics
  | AgentResumePayload
  | AgentProgressUpdatePayload
  | CheckpointSavedPayload
  | CheckpointLoadedPayload
  | StageSkippedPayload
  | FollowUpTasksCreatedPayload
  | FollowUpTasksRefusedPayload
  | DocsChangeEventPayload
  | RevisionStartPayload
  | RevisionCompletePayload
  | TestBaselineStartPayload
  | TestBaselineCompletePayload
  | TestRunStartPayload
  | TestRunCompletePayload
  | TestResultSummaryPayload
  | TestDashboardUpdatePayload
  | AutoMergeCompletePayload
  | AutoMergeFailedPayload
  | SubtaskMergedToFeatureBranchPayload
  | WorktreeFailedPayload
  | CoreWorktreeCleanedPayload
  | DockerWarmupStartPayload
  | DockerWarmupCompletePayload
  | DockerTeardownPayload
  | TasksStalePayload
  | TasksRefreshedPayload
  | TaskRejectedPayload
  | TaskVerificationNeededPayload
  | LifecycleVerifyStartPayload
  | LifecycleVerifyResultPayload
  | LifecycleFixStartPayload
  | LifecycleFixCompletePayload
  | LifecycleFixExhaustedPayload
  | IntakeSubmittedPayload
  | IntakeClassifiedPayload
  | IntakeRoutedPayload
  | FederatedJobSubmittedPayload
  | FederatedJobAssignedPayload
  | FederatedTransportFailedPayload
  | FederatedJobCanceledPayload
  | FederatedJobStatusPayload
  | FederatedJobEventPayload
  | WorkflowProjectionUpdatedPayload
  | WorkflowPendingStatePayload
  | LifecycleStatusUpdateFailedPayload
  | JudgePendingApprovalPayload
  | DispatchChildExitPayload
  | DispatchQueueTaskRefusedPayload
  | DispatchQueueRecoveryScanUnavailablePayload;

// ─── QuackEvent envelope ───────────────────────────────────────────

export interface QuackEvent {
  sessionId: string;
  taskId: string;
  project: string;
  timestamp: string;
  stage: EventStage;
  payload: EventPayload;
}

// ─── Session index entry ───────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  taskId: string;
  project: string;
  title?: string;
  startTime: string;
  status: "active" | "completed" | "error";
  outcome?: string;
  totalCostUsd?: number;
  durationMs?: number;
  turnsUsed?: number;
}

export const CLAIMANT_DIAGNOSTIC_SESSION_PREFIX = "quack-diagnostic-claimant-";
export const CLAIMANT_DIAGNOSTIC_OUTCOME = "claimant_diagnostic";

export function isClaimantDiagnosticSession(session: SessionEntry): boolean {
  return (
    session.outcome === CLAIMANT_DIAGNOSTIC_OUTCOME ||
    session.sessionId.startsWith(CLAIMANT_DIAGNOSTIC_SESSION_PREFIX)
  );
}

// ─── Cost aggregation types ───────────────────────────────────────

export interface CostSummary {
  totalCostUsd: number;
  sessionCount: number;
  avgCostPerSession: number;
  todayCostUsd: number;
  hourlyCostUsd?: number;
  monthToDateCostUsd?: number;
  monthToDateSessionCount?: number;
  last7DaysCostUsd: number;
  last30DaysCostUsd: number;
  byDay: Array<{ date: string; costUsd: number; sessions: number }>;
  byTask: Array<{
    taskId: string;
    costUsd: number;
    outcome: string;
    date: string;
    durationMs: number;
    turnsUsed: number;
  }>;
}
