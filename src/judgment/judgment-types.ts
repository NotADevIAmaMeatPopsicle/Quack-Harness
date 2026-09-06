export const JUDGMENT_SCHEMA_VERSION = 1 as const;

export const JUDGMENT_STAGES = [
  "readiness",
  "docs_review",
  "loop_brief",
  "loop_diff",
  "judge",
  "post_judge",
] as const;

export type JudgmentStage = (typeof JUDGMENT_STAGES)[number];

export const JUDGMENT_SIGNAL_DISPOSITIONS = [
  "advisory",
  "repair",
  "human_review",
  "safety",
] as const;

export type JudgmentSignalDisposition = (typeof JUDGMENT_SIGNAL_DISPOSITIONS)[number];

export const JUDGMENT_ACTIONS = ["continue", "repair", "human_review", "stop"] as const;

export type JudgmentAction = (typeof JUDGMENT_ACTIONS)[number];
export type IntentJudgmentAction = Exclude<JudgmentAction, "stop">;
export const INTENT_JUDGMENT_ACTIONS = [
  "continue",
  "repair",
  "human_review",
] as const satisfies readonly IntentJudgmentAction[];

// Adding a member is additive, not a schema break: reducer validation is
// membership-based, consumers re-reduce signals rather than switching
// exhaustively, and persisted decisions never carry codes that did not
// exist when they were written — so no JUDGMENT_SCHEMA_VERSION bump.
// `machinery_tamper` (TASK-1312): agent modified the verification
// machinery that decides whether its own work passed.
export const SAFETY_FLOOR_CODES = [
  "missing_required_schema",
  "production_deploy",
  "protected_branch_history_rewrite",
  "protected_branch_delete",
  "secret_exposure",
  "machinery_tamper",
] as const;

export type SafetyFloorCode = (typeof SAFETY_FLOOR_CODES)[number];

export interface JudgmentSignal {
  source: JudgmentStage;
  code: string;
  disposition: JudgmentSignalDisposition;
  message: string;
  deterministic: boolean;
  evidence?: string[];
  safetyCode?: SafetyFloorCode;
}

export interface IntentJudgment {
  source: "legacy_policy" | "intent_model" | "operator";
  action: IntentJudgmentAction;
  rationale: string[];
}

export interface JudgmentSafetyFloor {
  passed: boolean;
  blockers: JudgmentSignal[];
}

export interface JudgmentDecision {
  schemaVersion: typeof JUDGMENT_SCHEMA_VERSION;
  stage: JudgmentStage;
  signals: JudgmentSignal[];
  judgment: IntentJudgment;
  safetyFloor: JudgmentSafetyFloor;
  action: JudgmentAction;
  rationale: string[];
}

export type JudgeTracePhase = "raw" | "enforcement" | "path_audit";

export interface JudgeJudgmentTraceEntry {
  sequence: number;
  phase: JudgeTracePhase;
  decision: JudgmentDecision;
}

export const JUDGMENT_CONTRACT_ERROR_CODES = [
  "invalid_stage",
  "invalid_signal_code",
  "invalid_signal_message",
  "invalid_signal_disposition",
  "invalid_judgment_source",
  "invalid_judgment_action",
  "safety_code_required",
  "safety_code_forbidden",
  "invalid_safety_code",
] as const;

export type JudgmentContractErrorCode = (typeof JUDGMENT_CONTRACT_ERROR_CODES)[number];

export interface JudgmentProjectionFailure {
  errorCode: JudgmentContractErrorCode | "unexpected_projection_error";
  message: string;
}

export type JudgmentRolloutMode = "off" | "shadow" | "enforce";

export interface IntentContextMetadata {
  presentSections: string[];
  missingSections: string[];
  truncatedFields?: string[];
}

export interface IntentJudgmentSignalInput {
  ref: string;
  signal: JudgmentSignal;
}

export interface IntentJudgmentRequest {
  stage: JudgmentStage;
  taskId?: string;
  taskIntent: string;
  successCriteria: string[];
  scopeBoundaries: string[];
  stageContext: Record<string, unknown>;
  signals: IntentJudgmentSignalInput[];
  contextMetadata: IntentContextMetadata;
}

export const INTENT_JUDGMENT_RUNNER_ERROR_CODES = [
  "timeout",
  "sdk_error",
  "invalid_output",
  "no_result",
  "aborted",
] as const;

export type IntentJudgmentRunnerErrorCode = (typeof INTENT_JUDGMENT_RUNNER_ERROR_CODES)[number];

export interface IntentJudgmentRunCompleted {
  status: "completed";
  judgment: IntentJudgment & { source: "intent_model" };
  consideredSignalRefs: string[];
  model: string;
  durationMs: number;
  costUsd?: number;
  turnsUsed?: number;
  sessionId?: string;
  truncatedFields: string[];
}

export interface IntentJudgmentRunnerError {
  status: "runner_error";
  errorCode: IntentJudgmentRunnerErrorCode;
  message: string;
  model: string;
  durationMs: number;
  sessionId?: string;
  truncatedFields: string[];
}

export type IntentJudgmentRunResult = IntentJudgmentRunCompleted | IntentJudgmentRunnerError;

export interface IntentJudgmentRunner {
  readonly kind: "claude-sdk";
  run(request: IntentJudgmentRequest): Promise<IntentJudgmentRunResult>;
}

export const JUDGMENT_ORCHESTRATION_REASONS = [
  "mode_off",
  "safety_stop",
  "no_blocking_signals",
  "intent_context_unavailable",
  "shadow_candidate",
  "enforced_candidate",
  "projection_failure",
  "shadow_invalid_output",
  "shadow_runner_error",
  "enforce_runner_error",
  // TASK-1315: enforce degradation under onRunnerError "preserve_legacy"
  // (the readiness gate's availability posture).
  "enforce_runner_error_legacy_preserved",
  // TASK-1316: the monotonic outcome policy refused a candidate that was
  // LESS restrictive than the legacy decision (hold-or-demote stages).
  "intent_upgrade_refused",
] as const;

export type JudgmentOrchestrationReason = (typeof JUDGMENT_ORCHESTRATION_REASONS)[number];

export interface JudgmentOrchestrationResult {
  mode: JudgmentRolloutMode;
  attempted: boolean;
  reason: JudgmentOrchestrationReason;
  legacyDecision: JudgmentDecision;
  activeDecision: JudgmentDecision;
  candidateDecision?: JudgmentDecision;
  runnerResult?: IntentJudgmentRunResult;
  projectionFailure?: JudgmentProjectionFailure;
  diverged: boolean;
}
