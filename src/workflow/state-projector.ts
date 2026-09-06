import type { ParsedTask } from "../core/types.js";
import type {
  ClaimantDiagnosticPayload,
  QuackEvent,
  SessionEntry,
} from "../monitor/event-types.js";
import type { PersistedReviewBundle } from "../review/docs-gate.js";
import {
  createEvidenceBundle,
  type EvidenceBundle,
  type WikiArtifactEvidence,
  type SupportDocCandidateEvidence,
} from "./evidence-bundle.js";
import {
  type BlockReasonCode,
  type DocsImpact,
  type WikiAction,
  type WorkflowLane,
  type WorkflowRiskLevel,
  type WorkflowState,
  isBlockReasonCode,
  isWorkflowLane,
  isWorkflowRiskLevel,
} from "./workflow-state-types.js";

export interface DocsJobEventRecord {
  jobId: string;
  eventType: "docs_change_event";
  taskId: string;
  timestamp: string;
  payload: {
    docsImpact: DocsImpact;
    requiredWikiActions?: WikiAction[];
    wikiArtifacts?: WikiArtifactEvidence[];
    supportDocCandidates?: SupportDocCandidateEvidence[];
    summary?: string;
  };
}

export interface WorkflowProjectionInput {
  task: ParsedTask;
  sessions?: SessionEntry[];
  events?: QuackEvent[];
  latestReview?: PersistedReviewBundle;
  docsEvents?: DocsJobEventRecord[];
  lane?: WorkflowLane;
  riskLevel?: WorkflowRiskLevel;
  hostId?: string;
  claimantDiagnostic?: ClaimantDiagnosticPayload;
}

export interface WorkflowProjectionRecord {
  taskId: string;
  intakeId?: string;
  workflowId?: string;
  title: string;
  state: WorkflowState;
  blockReasonCode?: BlockReasonCode;
  lane?: WorkflowLane;
  riskLevel?: WorkflowRiskLevel;
  mergeReady: boolean;
  docsImpact?: DocsImpact;
  requiredWikiActions: WikiAction[];
  missingWikiActions: WikiAction[];
  supportContentRecords: number;
  supportContentLastGeneratedAt?: string;
  reviewId?: string;
  jobId?: string;
  hostId?: string;
  sessionId?: string;
  updatedAt: string;
  blockers: Array<{
    code: BlockReasonCode;
    message: string;
    field?: string;
  }>;
  evidenceBundle: EvidenceBundle;
  claimantDiagnostic?: ClaimantDiagnosticPayload;
}

const STATUS_TO_BASE_STATE: Record<string, WorkflowState> = {
  BACKLOG: "submitted",
  READY: "submitted",
  IN_PROGRESS: "executing",
  BLOCKED: "blocked",
  ON_HOLD: "blocked",
  DECOMPOSED: "blocked",
  VERIFYING: "verify_fix",
  COMPLETE: "reviewing",
  VERIFIED: "verified",
  REJECTED: "rejected",
};

function latestByTimestamp<T extends { timestamp?: string; startTime?: string }>(
  items: T[],
): T | undefined {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.timestamp ?? a.item.startTime ?? "";
      const right = b.item.timestamp ?? b.item.startTime ?? "";
      const timeDiff = right.localeCompare(left);
      if (timeDiff !== 0) return timeDiff;
      return b.index - a.index;
    })[0]?.item;
}

function eventState(event: QuackEvent): WorkflowState | undefined {
  switch (event.stage) {
    case "intake_submitted":
    case "federated_job_submitted":
      return "submitted";
    case "intake_classified":
      return "classified";
    case "intake_routed":
      return "routed";
    case "federated_job_assigned":
      return "assigned";
    case "federated_job_status": {
      const payload = event.payload as Partial<{ status: string; workflowState: WorkflowState }>;
      if (payload.workflowState) return payload.workflowState;
      switch (payload.status) {
        case "assigned":
        case "queued":
          return "assigned";
        case "running":
          return "executing";
        case "verifying":
        case "fixing":
          return "verify_fix";
        case "completed":
          return "reviewing";
        case "failed":
          return "failed";
        case "rejected":
          return "rejected";
        case "blocked":
          return "blocked";
        case "canceled":
          return "canceled";
        default:
          return undefined;
      }
    }
    case "session_start":
    case "branch_created":
    case "agent_turn":
    case "agent_tool_use":
      return "executing";
    case "verification_start":
    case "lifecycle_verify_start":
    case "lifecycle_fix_start":
    case "lifecycle_fix_complete":
      return "verify_fix";
    case "lifecycle_verify_result": {
      const payload = event.payload as Partial<{ verified: boolean }>;
      return payload.verified ? "verified" : "blocked";
    }
    case "lifecycle_fix_exhausted":
    case "federated_transport_failed":
      return "blocked";
    case "federated_job_canceled":
      return "canceled";
    case "agent_complete":
    case "agent_output_seal_start":
    case "agent_output_sealed":
    case "judge_start":
    case "judge_result":
      return "reviewing";
    case "docs_change_event":
      return "docs_followup";
    case "auto_merge_complete":
      return "merged";
    case "session_complete": {
      const payload = event.payload as Partial<{ outcome: string }>;
      switch (payload.outcome) {
        case "canceled":
          return "canceled";
        case "rejected":
          return "rejected";
        case "failed":
        case "agent_failed":
        case "error":
          return "failed";
        case "approved":
        case "completed":
          return "reviewing";
        // TASK-1332 round-6 (R6-2): a spec-identity refusal is terminal
        // and RECOVERABLE, so it is neither `failed` nor `rejected`. It
        // is waiting on an operator, which is what federation already
        // calls it (`blocked` + `pending_manual_handoff`). Falling
        // through to `undefined` left the workflow showing whatever
        // active state it held before the run stopped.
        case "spec_changed":
          return "blocked";
        default:
          return undefined;
      }
    }
    case "session_error":
    case "worktree_failed":
    case "agent_output_seal_failed":
    case "lifecycle_status_update_failed":
      return "failed";
    case "task_rejected":
    case "dispatch_rejected":
      return "rejected";
    default:
      return undefined;
  }
}

interface IntakeEventPayload {
  intakeId?: string;
  workflowId?: string;
  lane?: WorkflowLane;
  riskLevel?: WorkflowRiskLevel;
}

interface WorkflowEventPayload {
  workflowId?: string;
  blockReasonCode?: BlockReasonCode;
}

function intakePayloadFromEvent(event: QuackEvent): IntakeEventPayload | undefined {
  if (
    event.stage !== "intake_submitted" &&
    event.stage !== "intake_classified" &&
    event.stage !== "intake_routed"
  ) {
    return undefined;
  }

  const payload = event.payload as Partial<{
    intakeId: string;
    workflowId: string;
    lane: string;
    riskLevel: string;
  }>;
  return {
    intakeId: payload.intakeId,
    workflowId: payload.workflowId,
    lane: payload.lane && isWorkflowLane(payload.lane) ? payload.lane : undefined,
    riskLevel:
      payload.riskLevel && isWorkflowRiskLevel(payload.riskLevel) ? payload.riskLevel : undefined,
  };
}

function workflowPayloadFromEvent(event: QuackEvent): WorkflowEventPayload | undefined {
  if (
    event.stage !== "lifecycle_verify_start" &&
    event.stage !== "lifecycle_verify_result" &&
    event.stage !== "lifecycle_fix_start" &&
    event.stage !== "lifecycle_fix_complete" &&
    event.stage !== "lifecycle_fix_exhausted"
  ) {
    return undefined;
  }
  const payload = event.payload as Partial<{
    workflowId: string;
    blockReasonCode: string;
  }>;
  return {
    workflowId: payload.workflowId,
    blockReasonCode:
      payload.blockReasonCode && isBlockReasonCode(payload.blockReasonCode)
        ? payload.blockReasonCode
        : undefined,
  };
}

function federatedBlockReasonFromEvent(event: QuackEvent): BlockReasonCode | undefined {
  if (event.stage !== "federated_transport_failed" && event.stage !== "federated_job_status")
    return undefined;
  const payload = event.payload as Partial<{ blockReasonCode: string }>;
  return payload.blockReasonCode && isBlockReasonCode(payload.blockReasonCode)
    ? payload.blockReasonCode
    : undefined;
}

function latestIntakePayload(events: QuackEvent[]): IntakeEventPayload | undefined {
  const intakeEvents = events
    .map((event) => ({ event, payload: intakePayloadFromEvent(event) }))
    .filter(
      (entry): entry is { event: QuackEvent; payload: IntakeEventPayload } => !!entry.payload,
    );
  return latestByTimestamp(
    intakeEvents.map((entry) => ({
      timestamp: entry.event.timestamp,
      ...entry.payload,
    })),
  );
}

function latestWorkflowPayload(events: QuackEvent[]): WorkflowEventPayload | undefined {
  const workflowEvents = events
    .map((event) => ({ event, payload: workflowPayloadFromEvent(event) }))
    .filter(
      (entry): entry is { event: QuackEvent; payload: WorkflowEventPayload } => !!entry.payload,
    );
  return latestByTimestamp(
    workflowEvents.map((entry) => ({
      timestamp: entry.event.timestamp,
      ...entry.payload,
    })),
  );
}

function outputAttemptsFromEvents(events: QuackEvent[]): EvidenceBundle["outputAttempts"] {
  const attempts: EvidenceBundle["outputAttempts"] = [];
  for (const event of events) {
    if (event.stage !== "agent_output_sealed") continue;
    const payload = event.payload as Partial<{
      attempt: number;
      kind: "worker" | "retry" | "lifecycle_fix";
      sealedCommitSha: string;
      baseSha: string;
      changedFiles: string[];
      manifestPath: string;
      diffPath: string;
    }>;
    if (!payload.attempt || !payload.kind || !payload.manifestPath || !payload.diffPath) {
      continue;
    }
    attempts.push({
      attempt: payload.attempt,
      kind: payload.kind,
      commitSha: payload.sealedCommitSha,
      baseSha: payload.baseSha,
      changedFiles: payload.changedFiles ?? [],
      manifestPath: payload.manifestPath,
      diffPath: payload.diffPath,
      sealedAt: event.timestamp,
    });
  }
  return attempts;
}

function blockReasonFromEvent(event: QuackEvent): BlockReasonCode | undefined {
  const workflowPayload = workflowPayloadFromEvent(event);
  if (workflowPayload?.blockReasonCode) return workflowPayload.blockReasonCode;
  const federatedBlockReason = federatedBlockReasonFromEvent(event);
  if (federatedBlockReason) return federatedBlockReason;

  switch (event.stage) {
    case "agent_stuck_critical":
    case "agent_stuck_killed":
    case "lifecycle_fix_exhausted":
      return "workflow_attempts_exhausted";
    case "docs_change_event":
      return "pending_wiki_artifacts";
    // TASK-1332 round-7 (R7-2): round 6 mapped `spec_changed` to the
    // `blocked` STATE and stopped there, so the projection came out
    // blocked with an EMPTY blockers list, `/workflow-state` returned a
    // null pendingState, no `workflow_pending_state` SSE fired, and the
    // state machine's rule that a blocked transition carries a canonical
    // reason was violated. The task-status restore also means the
    // `status === "BLOCKED"` fallback cannot cover for it.
    //
    // `pending_manual_handoff` is the reason federation has been posting
    // for this refusal since R3-1, so this makes the two agree rather
    // than inventing a third vocabulary.
    case "session_complete":
      return (event.payload as Partial<{ outcome: string }>)?.outcome === "spec_changed"
        ? "pending_manual_handoff"
        : undefined;
    default:
      return undefined;
  }
}

function firstReviewBlockReason(review: PersistedReviewBundle): BlockReasonCode | undefined {
  // Advisory issues carry blockReasonCodes too (TASK-1300); only blocking
  // issues may project the workflow as blocked — mirrors buildReviewBlockers.
  return review.gate.issues.find((issue) => issue.blocking && issue.blockReasonCode)
    ?.blockReasonCode;
}

function buildReviewBlockers(review?: PersistedReviewBundle): WorkflowProjectionRecord["blockers"] {
  if (!review || review.gate.mergeReady) return [];
  return review.gate.issues
    .filter((issue) => issue.blocking && issue.blockReasonCode)
    .map((issue) => ({
      code: issue.blockReasonCode as BlockReasonCode,
      message: issue.message,
      field: issue.field,
    }));
}

function countSupportRecords(docsEvents: DocsJobEventRecord[]): number {
  return docsEvents.reduce(
    (count, event) => count + (event.payload.supportDocCandidates?.length ?? 0),
    0,
  );
}

function uniqueWikiActions(values: WikiAction[]): WikiAction[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function projectWorkflowState(input: WorkflowProjectionInput): WorkflowProjectionRecord {
  const executionEvents = (input.events ?? []).filter(
    (event) => event.stage !== "recording_claimant_diagnostic",
  );
  const latestSession = latestByTimestamp(input.sessions ?? []);
  const latestEvent = latestByTimestamp(executionEvents);
  const latestDocsEvent = latestByTimestamp(input.docsEvents ?? []);
  const intakePayload = latestIntakePayload(executionEvents);
  const workflowPayload = latestWorkflowPayload(executionEvents);
  const eventDerivedState = latestEvent ? eventState(latestEvent) : undefined;
  const latestEventBlockReason = latestEvent ? blockReasonFromEvent(latestEvent) : undefined;
  const reviewBlockers = buildReviewBlockers(input.latestReview);
  const reviewBlockReason = input.latestReview
    ? firstReviewBlockReason(input.latestReview)
    : undefined;

  let state: WorkflowState =
    eventDerivedState ?? STATUS_TO_BASE_STATE[input.task.status] ?? "submitted";
  let blockReasonCode: BlockReasonCode | undefined = latestEventBlockReason;

  // TASK-1332 round-8 (R8-4): a spec-identity refusal is a TERMINAL event
  // on the current run and outranks a review blocker carried over from an
  // earlier one. Without this, an older blocking review overwrote the
  // fresh `pending_manual_handoff` with a stale reason (the round
  // reproduced `pending_wiki_artifacts` winning), so the operator was
  // told to go fix documentation for a run that had refused to start.
  const terminalRefusal =
    latestEventBlockReason === "pending_manual_handoff" &&
    latestEvent?.stage === "session_complete";

  if (reviewBlockReason && !terminalRefusal) {
    state = "blocked";
    blockReasonCode = reviewBlockReason;
  } else if (terminalRefusal) {
    state = "blocked";
    blockReasonCode = latestEventBlockReason;
  } else if (
    state === "reviewing" &&
    !input.latestReview &&
    (input.task.status === "COMPLETE" || input.task.status === "VERIFIED")
  ) {
    state = "blocked";
    blockReasonCode = "pending_review";
  } else if (state === "docs_followup" && input.latestReview?.gate.mergeReady === false) {
    state = "blocked";
    blockReasonCode = "pending_wiki_artifacts";
  } else if (input.latestReview?.gate.mergeReady && state === "reviewing") {
    state = "merge_ready";
  }

  if (input.task.status === "BLOCKED" && !blockReasonCode) {
    blockReasonCode = "pending_manual_handoff";
  }

  if (input.claimantDiagnostic) {
    state = "blocked";
    blockReasonCode = "pending_manual_handoff";
  }

  const requiredWikiActions = uniqueWikiActions([
    ...(input.latestReview?.gate.requiredWikiActions ?? []),
    ...(latestDocsEvent?.payload.requiredWikiActions ?? []),
  ]);
  const missingWikiActions = uniqueWikiActions(input.latestReview?.gate.missingWikiActions ?? []);
  const supportContentRecords = countSupportRecords(input.docsEvents ?? []);
  const docsImpact = input.latestReview?.docsImpact ?? latestDocsEvent?.payload.docsImpact;

  const evidenceBundle = createEvidenceBundle({
    taskId: input.task.id,
    intakeId: intakePayload?.intakeId,
    workflowId: workflowPayload?.workflowId ?? intakePayload?.workflowId,
    reviewId: input.latestReview?.reviewId,
    jobId: latestDocsEvent?.jobId,
    hostId: input.hostId,
    sessionId: latestSession?.sessionId,
    workflowState: state,
    blockReasonCode,
    lane: input.lane ?? intakePayload?.lane,
    riskLevel: input.riskLevel ?? intakePayload?.riskLevel,
    changedFiles: input.task.filesToModify.map((file) => file.path),
    outputAttempts: outputAttemptsFromEvents(executionEvents),
    review: input.latestReview
      ? {
          reviewId: input.latestReview.reviewId,
          verdict: input.latestReview.verdict,
          mergeReady: input.latestReview.gate.mergeReady,
          docsImpact: input.latestReview.docsImpact,
          requiredWikiActions: input.latestReview.gate.requiredWikiActions,
          missingWikiActions: input.latestReview.gate.missingWikiActions,
          wikiArtifacts: input.latestReview.wikiArtifacts ?? [],
          supportDocCandidates: input.latestReview.supportDocCandidates ?? [],
        }
      : undefined,
    docs: docsImpact
      ? {
          docsImpact,
          requiredWikiActions,
          wikiArtifacts: latestDocsEvent?.payload.wikiArtifacts ?? [],
          supportDocCandidates: latestDocsEvent?.payload.supportDocCandidates ?? [],
          supportContentRecords,
          lastDocsEventAt: latestDocsEvent?.timestamp,
        }
      : undefined,
    updatedAt: new Date().toISOString(),
  });

  return {
    taskId: input.task.id,
    intakeId: intakePayload?.intakeId,
    workflowId: workflowPayload?.workflowId ?? intakePayload?.workflowId,
    title: input.task.title,
    state,
    blockReasonCode,
    lane: input.lane ?? intakePayload?.lane,
    riskLevel: input.riskLevel ?? intakePayload?.riskLevel,
    mergeReady: state === "merge_ready" || state === "merged",
    docsImpact,
    requiredWikiActions,
    missingWikiActions,
    supportContentRecords,
    supportContentLastGeneratedAt: latestDocsEvent?.timestamp,
    reviewId: input.latestReview?.reviewId,
    jobId: latestDocsEvent?.jobId,
    hostId: input.hostId,
    sessionId: latestSession?.sessionId,
    updatedAt: evidenceBundle.updatedAt ?? new Date().toISOString(),
    // TASK-1332 round-9 (R9-3): `blockers` is a SECOND producer of the
    // same answer, and round 8 moved only the first. It fixed
    // `blockReasonCode` to prefer a terminal refusal and left this
    // returning the stale review blockers, so the projection contradicted
    // itself: a `pending_manual_handoff` badge beside a "fix the wiki
    // artifacts" blocker list, which is what the dashboard actually
    // renders. Same precedence, both fields.
    blockers:
      reviewBlockers.length > 0 && !terminalRefusal && !input.claimantDiagnostic
        ? reviewBlockers
        : blockReasonCode
          ? [
              {
                code: blockReasonCode,
                message: input.claimantDiagnostic?.reason ?? blockReasonCode,
              },
            ]
          : [],
    evidenceBundle,
    claimantDiagnostic: input.claimantDiagnostic,
  };
}
