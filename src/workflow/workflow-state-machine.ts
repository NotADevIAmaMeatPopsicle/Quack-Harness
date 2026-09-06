import {
  type BlockReasonCode,
  type CanonicalTaskStatus,
  type WorkflowState,
} from "./workflow-state-types.js";
import { normalizeTaskStatus } from "../core/task-status.js";

export type WorkflowTransitionDenyCode =
  | "invalid_transition"
  | "missing_required_artifact"
  | "blocked_reason_required"
  | "invalid_block_reason"
  | "terminal_state";

export type WorkflowTransitionReasonCode = WorkflowTransitionDenyCode | BlockReasonCode;

export interface WorkflowTransitionRule {
  fromState: WorkflowState;
  toState: WorkflowState;
  trigger: string;
  requiredArtifacts: string[];
  blockingReasonCode?: BlockReasonCode;
}

export interface WorkflowTransitionRequest {
  fromState: WorkflowState;
  toState: WorkflowState;
  trigger: string;
  artifacts?: Record<string, unknown>;
  blockReasonCode?: BlockReasonCode;
}

export interface WorkflowTransitionValidationResult {
  allowed: boolean;
  reasonCode?: WorkflowTransitionReasonCode;
  message?: string;
  requiredArtifacts: string[];
  missingArtifacts: string[];
  rule?: WorkflowTransitionRule;
}

export interface WorkflowChecklistState {
  checked: number;
  unchecked: number;
  total?: number;
}

export interface WorkflowInvariantInput {
  taskId?: string;
  taskStatus?: string | null;
  successCriteria?: WorkflowChecklistState;
  testingRequirements?: WorkflowChecklistState;
}

export interface WorkflowInvariantIssue {
  code: BlockReasonCode;
  message: string;
  field?: string;
}

const TERMINAL_STATES = new Set<WorkflowState>(["merged", "failed", "rejected", "canceled"]);

const ALLOWED_BLOCK_REASONS_BY_STATE: Record<WorkflowState, BlockReasonCode[]> = {
  submitted: [],
  classified: [],
  routed: [],
  assigned: ["pending_remote_listener", "host_unhealthy"],
  // TASK-1332 round-8 (R8-4): `pending_manual_handoff` is legal from
  // `executing` because that is where a spec-identity refusal lands, the
  // run stopped deliberately, mid-execution, and is waiting on an
  // operator.
  //
  // **Round 9 (R9-4) corrected the reason given here.** Round 8 claimed
  // the validator had REJECTED the projection as `invalid_block_reason`
  // and stripped its reason. That is false: `validateWorkflowTransition`
  // has no production caller, only its own unit tests import it, so it
  // could not have rejected anything. The projector writes the reason
  // directly. This entry is POLICY PARITY, keeping the declared table
  // honest about a transition the system actually performs, not a fix for
  // an observed rejection.
  executing: ["pending_remote_listener", "host_unhealthy", "pending_manual_handoff"],
  verify_fix: ["pending_manual_handoff", "workflow_attempts_exhausted"],
  reviewing: [
    "pending_review",
    "unresolved_high_finding",
    "non_canonical_status",
    "checklist_mismatch",
  ],
  docs_followup: ["pending_wiki_artifacts", "missing_support_candidates"],
  verified: ["review_linkage_required"],
  merge_ready: [],
  merged: [],
  blocked: [],
  failed: [],
  rejected: [],
  canceled: [],
};

export const WORKFLOW_TRANSITIONS: WorkflowTransitionRule[] = [
  {
    fromState: "submitted",
    toState: "classified",
    trigger: "lane_classified",
    requiredArtifacts: ["lane", "riskLevel", "classificationReasons"],
  },
  {
    fromState: "classified",
    toState: "routed",
    trigger: "route_decision_persisted",
    requiredArtifacts: ["routeDecision", "routeActor", "routeDecidedAt"],
  },
  {
    fromState: "routed",
    toState: "assigned",
    trigger: "host_assigned",
    requiredArtifacts: ["hostCapabilitySnapshot", "hostHealthSnapshot", "correlationIds"],
  },
  {
    fromState: "assigned",
    toState: "executing",
    trigger: "job_accepted",
    requiredArtifacts: ["jobId", "dispatchSessionRef"],
  },
  {
    fromState: "executing",
    toState: "verify_fix",
    trigger: "verify_fix_started",
    requiredArtifacts: ["workflowRecord"],
  },
  {
    fromState: "verify_fix",
    toState: "reviewing",
    trigger: "verification_evidence_ready",
    requiredArtifacts: ["evidenceBundle"],
  },
  {
    fromState: "reviewing",
    toState: "docs_followup",
    trigger: "docs_followup_required",
    requiredArtifacts: ["reviewBundle", "docsImpact", "requiredWikiActions"],
    blockingReasonCode: "pending_wiki_artifacts",
  },
  {
    fromState: "reviewing",
    toState: "verified",
    trigger: "verification_recorded",
    requiredArtifacts: ["verificationRecord", "linkedReviewBundle"],
    blockingReasonCode: "review_linkage_required",
  },
  {
    fromState: "docs_followup",
    toState: "verified",
    trigger: "verification_recorded",
    requiredArtifacts: ["verificationRecord", "linkedReviewBundle", "docsArtifacts"],
    blockingReasonCode: "pending_wiki_artifacts",
  },
  {
    fromState: "verified",
    toState: "merge_ready",
    trigger: "quality_and_docs_gates_satisfied",
    requiredArtifacts: ["mergeReadyReviewGate"],
    blockingReasonCode: "review_linkage_required",
  },
  {
    fromState: "merge_ready",
    toState: "merged",
    trigger: "merge_completed",
    requiredArtifacts: ["mergeCommit"],
  },
  {
    fromState: "submitted",
    toState: "failed",
    trigger: "policy_failure",
    requiredArtifacts: ["failureReason"],
  },
  {
    fromState: "executing",
    toState: "failed",
    trigger: "execution_failed",
    requiredArtifacts: ["failureReason"],
  },
  {
    fromState: "reviewing",
    toState: "rejected",
    trigger: "review_rejected",
    requiredArtifacts: ["reviewBundle"],
  },
  {
    fromState: "routed",
    toState: "canceled",
    trigger: "operator_canceled",
    requiredArtifacts: ["cancelReason"],
  },
];

function hasArtifact(
  artifacts: Record<string, unknown> | undefined,
  artifactName: string,
): boolean {
  const value = artifacts?.[artifactName];
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function validateWorkflowTransition(
  request: WorkflowTransitionRequest,
): WorkflowTransitionValidationResult {
  if (request.fromState === request.toState) {
    return {
      allowed: true,
      requiredArtifacts: [],
      missingArtifacts: [],
    };
  }

  if (TERMINAL_STATES.has(request.fromState)) {
    return {
      allowed: false,
      reasonCode: "terminal_state",
      message: `Workflow state ${request.fromState} is terminal.`,
      requiredArtifacts: [],
      missingArtifacts: [],
    };
  }

  if (request.toState === "blocked") {
    if (!request.blockReasonCode) {
      return {
        allowed: false,
        reasonCode: "blocked_reason_required",
        message: "Blocked transitions require a canonical blockReasonCode.",
        requiredArtifacts: [],
        missingArtifacts: [],
      };
    }

    const allowedReasons = ALLOWED_BLOCK_REASONS_BY_STATE[request.fromState] ?? [];
    if (!allowedReasons.includes(request.blockReasonCode)) {
      return {
        allowed: false,
        reasonCode: "invalid_block_reason",
        message: `${request.blockReasonCode} is not valid when blocking from ${request.fromState}.`,
        requiredArtifacts: [],
        missingArtifacts: [],
      };
    }

    return {
      allowed: true,
      reasonCode: request.blockReasonCode,
      requiredArtifacts: [],
      missingArtifacts: [],
    };
  }

  const rule = WORKFLOW_TRANSITIONS.find(
    (candidate) =>
      candidate.fromState === request.fromState &&
      candidate.toState === request.toState &&
      candidate.trigger === request.trigger,
  );

  if (!rule) {
    return {
      allowed: false,
      reasonCode: "invalid_transition",
      message: `No canonical transition from ${request.fromState} to ${request.toState} via ${request.trigger}.`,
      requiredArtifacts: [],
      missingArtifacts: [],
    };
  }

  const missingArtifacts = rule.requiredArtifacts.filter(
    (artifactName) => !hasArtifact(request.artifacts, artifactName),
  );
  if (missingArtifacts.length > 0) {
    return {
      allowed: false,
      reasonCode: rule.blockingReasonCode ?? "missing_required_artifact",
      message: `Missing required artifacts: ${missingArtifacts.join(", ")}`,
      requiredArtifacts: rule.requiredArtifacts,
      missingArtifacts,
      rule,
    };
  }

  return {
    allowed: true,
    requiredArtifacts: rule.requiredArtifacts,
    missingArtifacts: [],
    rule,
  };
}

export function normalizeCanonicalTaskStatus(
  rawStatus: string | null | undefined,
): CanonicalTaskStatus | null {
  return normalizeTaskStatus(rawStatus);
}

function uncheckedCount(input?: WorkflowChecklistState): number {
  return input?.unchecked ?? 0;
}

export function validateWorkflowInvariants(
  input: WorkflowInvariantInput,
): WorkflowInvariantIssue[] {
  const issues: WorkflowInvariantIssue[] = [];
  const normalizedStatus = normalizeCanonicalTaskStatus(input.taskStatus);

  if (!normalizedStatus) {
    issues.push({
      code: "non_canonical_status",
      message: input.taskStatus
        ? `Task status "${input.taskStatus}" is non-canonical.`
        : "Task status is missing.",
      field: "status",
    });
    return issues;
  }

  const hasUncheckedChecklistItems =
    uncheckedCount(input.successCriteria) > 0 || uncheckedCount(input.testingRequirements) > 0;
  if (
    (normalizedStatus === "COMPLETE" || normalizedStatus === "VERIFIED") &&
    hasUncheckedChecklistItems
  ) {
    issues.push({
      code: "checklist_mismatch",
      message:
        "Task is marked COMPLETE or VERIFIED while Success Criteria/Testing Requirements contain unchecked items.",
      field: "status",
    });
  }

  return issues;
}
