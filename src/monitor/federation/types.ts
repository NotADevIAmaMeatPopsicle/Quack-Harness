// ─── Federation Types ──────────────────────────────────────────────
// All federation-domain interfaces hoisted from the createMonitorServer
// closure so route modules, the Operator service, and isolated unit
// tests can reference them without importing back into server.ts.
//
// Doc: docs/QUEUE_AND_FEDERATION_OPERATOR_MODEL.md (TASK-876)
// Hoist task: TASK-884.

import type { runVerifyWorkflow } from "../../workflows/verify-orchestrator.js";
import type { BlockReasonCode } from "../../workflow/workflow-state-types.js";
import type { EventReader } from "../event-reader.js";
import type { TaskService } from "../task-service.js";
import type { PrepCache } from "../prep-cache.js";
import type { QuackDB, NoopDB } from "../../db/index.js";
import type { JudgmentConfig } from "../../judgment/runner/intent-judgment-config.js";

/** Subset of the closure-scoped ResolvedProject that federation helpers actually use.
 *  ResolvedProject (in server.ts) structurally satisfies this interface, so server.ts
 *  can pass its existing project objects directly. Splitting the interface this way
 *  means federation modules don't need to import ResolvedProject (which is closure-
 *  scoped and can't be exported).
 *  See docs/QUEUE_AND_FEDERATION_OPERATOR_MODEL.md and TASK-884. */
export interface FederationProjectContext {
  projectId: string;
  projectRoot: string | undefined;
  reader: EventReader;
  taskService: TaskService | null;
  prepCache: PrepCache | null;
  db: QuackDB | NoopDB;
  judgmentConfig?: JudgmentConfig;
}

/** All federation runtime statuses. Loose synonyms (`complete`, `started`, `verify`)
 *  are accepted on input via {@link normalizeFederatedRuntimeStatus} but stored as
 *  the canonical values below.
 *
 *  TASK-1329 / QPI-041: `awaiting_approval` is the third position, and it is
 *  neither "active" nor "terminal" in the sense the other members are.
 *
 *  It means **attached but not progressing**: the run has paused at a human gate,
 *  the worker host is STILL BOUND to it (the listener holds its lease and keeps
 *  polling), and it resumes on a human decision rather than ending. Read the two
 *  halves separately, because collapsing them re-introduces real bugs:
 *
 *  - It is excluded from {@link activeFederatedStatuses}, which is the SCHEDULER's
 *    notion of assignable work. A paused job must not attract new assignment.
 *  - It is NOT excluded from lease handling or stale-lease recovery. The listener
 *    is genuinely attached, so its lease must stay renewable and the stale sweep
 *    must still see it. Treating it as "holds no worker" strands paused jobs
 *    outside recovery entirely (round-1 R1-6 caught exactly that framing error).
 *
 *  Releasing the slot on a pause is deliberately NOT done here: nothing re-binds a
 *  human-approved resume to the same jobId today, so a released job would orphan.
 *  That is TASK-1330. */
export type FederatedRuntimeStatus =
  | "assigned"
  | "queued"
  | "running"
  | "verifying"
  | "fixing"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "rejected"
  | "blocked"
  | "canceled";

/** TASK-1329: which human gate a paused run is waiting at, carried on the status
 *  relay so the queue can name the decision instead of emitting
 *  `investigate_failed_worker`. `stage` is the gate; `since` is when it opened. */
export interface FederatedPendingGate {
  stage: "blueprint" | "judge";
  since?: string;
  reason?: string;
}

export interface FederatedJobLease {
  leaseId: string;
  hostId: string;
  acquiredAt: string;
  expiresAt: string;
}

// ─── Dispatch provenance (TASK-1323 / QPI-047) ─────────────────────
// Every minted job answers three questions durably: which CHANNEL
// created it, under which IDENTITY, from which ORIGIN. Channel values
// are derivable from route + auth ALONE — a client-claimed channel
// lands only in `claimedChannel` and nothing may branch on it.
export type DispatchChannel =
  | "federation-queue"
  | "federation-jobs-legacy"
  | "external-completion"
  | "api-direct"
  | "listener-execution"
  | "replan"
  | "cli"
  | "fix-orchestration";

export interface JobProvenance {
  channel: DispatchChannel;
  /** Service-token id returned by requireServiceScope, when token-authed. */
  tokenId?: string;
  /** Session user, or the explicit "unauthenticated-local" marker. */
  principal?: string;
  remoteAddr?: string;
  /** Untrusted client-claimed channel hint (X-Quack-Channel). Advisory only. */
  claimedChannel?: string;
  parentJobId?: string;
}

export interface FederatedJobRecord {
  jobId: string;
  taskId: string;
  jobType: "intake" | "verify" | "fix" | "dispatch";
  status: FederatedRuntimeStatus;
  correlationId: string;
  requiredCapabilities: string[];
  parentJobId?: string;
  priority?: number;
  priorityLabel?: string;
  hostId?: string;
  fallbackUsed?: boolean;
  retryable?: boolean;
  blockReasonCode?: BlockReasonCode;
  error?: string;
  decision: Record<string, unknown>;
  lease?: FederatedJobLease;
  leaseTtlMs?: number;
  remoteSessionId?: string;
  branchName?: string;
  commitSha?: string;
  targetBranch?: string;
  lastEventAt?: string;
  lastEventStage?: string;
  eventCount?: number;
  evidence?: Array<Record<string, unknown>>;
  retryCount?: number;
  maxRetries?: number;
  nextAction?: string;
  queuedAt?: string;
  assignedAt?: string;
  staleAt?: string;
  completedAt?: string;
  reviewId?: string;
  verificationWorkflowId?: string;
  fixJobIds?: string[];
  autoMerge?: boolean;
  /** QPI-048 leg (f): operator decomposition-gate override; the
   *  executing listener passes it to its local start. */
  skipDecomposeCheck?: boolean;
  /** TASK-1329 / QPI-041: which human gate this run paused at. Set alongside
   *  `status: "awaiting_approval"` and cleared when the run leaves that state,
   *  so a stale gate never outlives the pause that produced it. */
  pendingGate?: FederatedPendingGate;
  mergeStatus?: "not_requested" | "blocked" | "merged" | "failed";
  mergeCommitSha?: string;
  mergeError?: string;
  pullCommandBroadcastAt?: string;
  createdAt: string;
  updatedAt: string;
  canceledBy?: string;
  /**
   * TASK-1323: optional on READ (legacy records predate the field and
   * must never hard-fail), REQUIRED on CREATE (the mint API's signature
   * enforces it — no record is minted without declaring its channel).
   */
  provenance?: JobProvenance;
}

export interface FederatedRelayEvent {
  stage: string;
  payload: Record<string, unknown>;
  timestamp?: string;
  sequence?: number;
  sessionId?: string;
}

export interface FederatedSchedulingOptions {
  preferredHostId?: string;
  leaseTtlMs?: number;
  allowLowPreflight?: boolean;
  allowMissingPreflight?: boolean;
  bypassDependencyGate?: boolean;
}

export interface FederatedVerificationOptions {
  reviewId?: string;
  requireReview?: boolean;
  criteriaChecked?: number;
  criteriaPassed?: number;
  phaseResults?: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    summary?: string;
  }>;
}

export interface FederatedWorkerCompletionSummary {
  canonicalSessionId?: string;
  verified?: boolean;
  verificationWorkflowId?: string;
  verificationVerdict?: "VERIFIED" | "FAILED" | "BLOCKED";
  autoMerged?: boolean;
  mergeTargetBranch?: string;
  mergeCommitSha?: string;
}

export interface FederatedCompletionOptions {
  autoVerify: boolean;
  autoMerge: boolean;
  targetBranch?: string;
  branchName?: string;
  commitSha?: string;
  verification?: FederatedVerificationOptions;
  maxFixAttempts?: number;
  workerCompletion?: FederatedWorkerCompletionSummary;
}

export interface FederatedOrchestrationResult {
  job: FederatedJobRecord;
  verification?: Awaited<ReturnType<typeof runVerifyWorkflow>>;
  fixJob?: FederatedJobRecord;
  merge?: {
    ok: boolean;
    commitSha?: string;
    error?: string;
    commands?: number;
  };
}

export interface FederatedTaskEventDetails {
  taskTitle?: string;
  taskDescription?: string;
}

export interface FederatedHostEventDetails {
  hostAlias?: string;
  hostEndpoint?: string;
}
