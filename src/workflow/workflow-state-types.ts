import { TASK_STATUSES, type TaskStatus } from "../core/task-status.js";

export const CANONICAL_WORKFLOW_STATES = [
  "submitted",
  "classified",
  "routed",
  "assigned",
  "executing",
  "verify_fix",
  "reviewing",
  "docs_followup",
  "verified",
  "merge_ready",
  "merged",
  "blocked",
  "failed",
  "rejected",
  "canceled",
] as const;

export type WorkflowState = (typeof CANONICAL_WORKFLOW_STATES)[number];

export const CANONICAL_LANES = ["auto", "guarded_auto", "human_required"] as const;

export type WorkflowLane = (typeof CANONICAL_LANES)[number];

export const CANONICAL_RISK_LEVELS = ["low", "medium", "high"] as const;

export type WorkflowRiskLevel = (typeof CANONICAL_RISK_LEVELS)[number];

export const CANONICAL_BLOCK_REASON_CODES = [
  "pending_remote_listener",
  "pending_manual_handoff",
  "pending_review",
  "pending_wiki_artifacts",
  "review_linkage_required",
  "host_unhealthy",
  "workflow_attempts_exhausted",
  "non_canonical_status",
  "checklist_mismatch",
  "unresolved_high_finding",
  "missing_support_candidates",
] as const;

export type BlockReasonCode = (typeof CANONICAL_BLOCK_REASON_CODES)[number];

export const CANONICAL_TASK_STATUSES = TASK_STATUSES;

export type CanonicalTaskStatus = TaskStatus;

export const CANONICAL_DOCS_IMPACTS = [
  "none",
  "changelog_only",
  "feature_page_update",
  "support_bundle",
] as const;

export type DocsImpact = (typeof CANONICAL_DOCS_IMPACTS)[number];

export const CANONICAL_WIKI_ACTIONS = [
  "changelog_entry",
  "feature_page_update",
  "support_bundle",
] as const;

export type WikiAction = (typeof CANONICAL_WIKI_ACTIONS)[number];

export interface WorkflowCorrelationIds {
  intakeId?: string;
  workflowId?: string;
  reviewId?: string;
  verificationRecordId?: string;
  jobId?: string;
  hostId?: string;
  sessionId?: string;
}

export interface WorkflowStateSnapshot extends WorkflowCorrelationIds {
  taskId: string;
  state: WorkflowState;
  lane?: WorkflowLane;
  riskLevel?: WorkflowRiskLevel;
  blockReasonCode?: BlockReasonCode;
  mergeReady: boolean;
  updatedAt: string;
}

export interface WorkflowBlocker {
  code: BlockReasonCode;
  message: string;
  field?: string;
}

export const REVIEW_GATE_BLOCK_REASON_BY_ISSUE_CODE: Record<string, BlockReasonCode> = {
  missing_status: "non_canonical_status",
  non_canonical_status: "non_canonical_status",
  verified_unchecked_checklists: "checklist_mismatch",
  complete_unchecked_checklists: "checklist_mismatch",
  checklist_not_countable: "checklist_mismatch",
  invalid_wiki_artifact: "pending_wiki_artifacts",
  missing_wiki_artifacts: "pending_wiki_artifacts",
  missing_support_doc_candidates: "missing_support_candidates",
  unresolved_high_severity_finding: "unresolved_high_finding",
  review_required: "review_linkage_required",
  review_missing: "review_linkage_required",
  review_invalid: "review_linkage_required",
  review_not_merge_ready: "review_linkage_required",
};

export function isWorkflowState(value: string): value is WorkflowState {
  return (CANONICAL_WORKFLOW_STATES as readonly string[]).includes(value);
}

export function isWorkflowLane(value: string): value is WorkflowLane {
  return (CANONICAL_LANES as readonly string[]).includes(value);
}

export function isWorkflowRiskLevel(value: string): value is WorkflowRiskLevel {
  return (CANONICAL_RISK_LEVELS as readonly string[]).includes(value);
}

export function isBlockReasonCode(value: string): value is BlockReasonCode {
  return (CANONICAL_BLOCK_REASON_CODES as readonly string[]).includes(value);
}

export function blockReasonForReviewGateIssue(code: string): BlockReasonCode | undefined {
  return REVIEW_GATE_BLOCK_REASON_BY_ISSUE_CODE[code];
}
