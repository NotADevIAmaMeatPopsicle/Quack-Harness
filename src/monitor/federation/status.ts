// ─── Federation Status Helpers ─────────────────────────────────────
// Pure functions over FederatedRuntimeStatus. No closure deps, no I/O.
// See docs/QUEUE_AND_FEDERATION_OPERATOR_MODEL.md §2.1 for the canonical
// operator vocabulary mapping.

import type { EventStage } from "../event-types.js";
import type { WorkflowState } from "../../workflow/workflow-state-types.js";
import type { FederatedRuntimeStatus } from "./types.js";

/** The SCHEDULER's notion of assignable/in-flight work.
 *
 *  TASK-1329: `awaiting_approval` is deliberately ABSENT. A run paused at a human
 *  gate must not attract new assignment. That is the only thing this set decides;
 *  see {@link holdsWorkerAttachment} for the lease question, which answers the
 *  opposite way. */
export const activeFederatedStatuses: ReadonlySet<FederatedRuntimeStatus> = new Set([
  "assigned",
  "queued",
  "running",
  "verifying",
  "fixing",
]);

/** Statuses where a worker host is still bound to the job.
 *
 *  TASK-1329: this is NOT `activeFederatedStatuses` plus or minus a member, and
 *  the difference is load-bearing. A paused run is not assignable (so it is out
 *  of the active set) but its listener is still attached, holding the lease and
 *  polling (`scripts/quack-listener.mjs:1264`). Lease renewal and stale-lease
 *  recovery must therefore keep seeing it, or a paused job falls outside recovery
 *  and can never be reclaimed when its host genuinely dies.
 *
 *  Round-1 R1-6 caught the inverse framing ("a pause holds no worker") before it
 *  shipped. Releasing the attachment is TASK-1330, not this. */
export const workerAttachedFederatedStatuses: ReadonlySet<FederatedRuntimeStatus> = new Set([
  "assigned",
  "queued",
  "running",
  "verifying",
  "fixing",
  "awaiting_approval",
]);

export function holdsWorkerAttachment(status: FederatedRuntimeStatus): boolean {
  return workerAttachedFederatedStatuses.has(status);
}

/** TASK-1329: a run paused at a human gate. Neither a failure nor a completion:
 *  the decision is the operator's and the run resumes from it. */
export function isAwaitingHumanGate(status: FederatedRuntimeStatus): boolean {
  return status === "awaiting_approval";
}

export const relayedSlackStages: ReadonlySet<EventStage> = new Set([
  "gate_result",
  "verification_result",
  "judge_result",
  "retry_start",
  "pr_created",
  "session_complete",
  "session_error",
  "agent_turn",
  "agent_progress_update",
  "workflow_pending_state",
  "lifecycle_verify_result",
]);

export function isActiveFederatedStatus(status: FederatedRuntimeStatus): boolean {
  return activeFederatedStatuses.has(status);
}

export function isRelayedSlackStage(stage: string): stage is EventStage {
  return relayedSlackStages.has(stage as EventStage);
}

/** Coerces loose listener vocabulary into the canonical enum.
 *  See QUEUE_AND_FEDERATION_OPERATOR_MODEL.md §2.1. */
export function normalizeFederatedRuntimeStatus(status: string): FederatedRuntimeStatus {
  if (status === "complete") return "completed";
  if (status === "started") return "running";
  if (status === "verify") return "verifying";
  return status as FederatedRuntimeStatus;
}

export function workflowStateForFederatedStatus(status: FederatedRuntimeStatus): WorkflowState {
  switch (status) {
    case "assigned":
    case "queued":
      return "assigned";
    case "running":
      return "executing";
    case "verifying":
    case "fixing":
      return "verify_fix";
    // TASK-1329: a human gate is a BLOCK on a person, not execution and not
    // failure. Before this case existed it fell through `default` to
    // "assigned", which reported a paused run as freshly handed to a host.
    // It maps to `blocked` rather than earning a new CANONICAL_WORKFLOW_STATE:
    // widening that union is a far larger blast radius than this defect, and
    // "blocked" is already the honest word for not-progressing-pending-input.
    case "awaiting_approval":
      return "blocked";
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
      return "assigned";
  }
}

export function sessionStatusForFederatedStatus(
  status: FederatedRuntimeStatus,
): "active" | "completed" | "error" {
  if (status === "failed" || status === "rejected" || status === "blocked") {
    return "error";
  }
  if (status === "completed" || status === "canceled") {
    return "completed";
  }
  return "active";
}

export function terminalFederatedStatus(status: FederatedRuntimeStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "rejected" ||
    status === "blocked" ||
    status === "canceled"
  );
}
