// ─── Blueprint Approval Gate ───────────────────────────────────────
// Approval state machine and auto-approve evaluator for blueprint review.
// Pauses dispatch between blueprint generation and agent execution to allow
// human review of complex implementation plans.

import type { Blueprint } from "../blueprint/blueprint-types.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";
import { SPEC_IDENTITY_VERSION, type SpecIdentity } from "../core/spec-identity.js";
import {
  buildDirectWriteOverride,
  resolveApprovalDecision,
  type AdvisoryOverride,
  type ApprovalDecisionOptions,
} from "../judgment/advisory-override.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "auto-approved";

export interface BlueprintApproval {
  taskId: string;
  state: ApprovalState;
  blueprint: Blueprint;
  preflightResult?: PreflightResult;
  approvedBy?: string;
  rejectionReason?: string;
  decidedAt?: string;
  createdAt: string;
  executionMode?: "loop";
  review?: ReviewRunResult;
  reviewedAt?: string;
  reviewGate?: LoopReviewGateFacts;
  /** TASK-1319: recorded when this decision contradicted stored advice. */
  override?: AdvisoryOverride;
  /**
   * TASK-1332 / QPI-045: which spec this brief was built from.
   *
   * Optional because every record written before TASK-1332 lacks it,
   * and absence must read as UNKNOWN rather than as either verdict.
   * NOT derived from `preflightResult.contentHash`: round 1 (R1-8)
   * found the two halves are written independently, so the attached
   * preflight can describe a different spec than the attached
   * blueprint, which is worse than absence.
   */
  specIdentity?: SpecIdentity;
  /**
   * Round 5 (R5-3): stamped whenever stamping-aware code writes this
   * record, EVEN WHEN `specIdentity` could not be resolved.
   *
   * That is the whole point of it. Absence of `specIdentity` alone was
   * ambiguous, a pre-TASK-1332 record, which must be grandfathered, and
   * a record written today by code that tried and failed to resolve the
   * authoritative spec, which must NOT be, and the ambiguity resolved
   * fail-open. With this field present, the second case is
   * `unverifiable` and refuses.
   */
  specIdentityVersion?: number;
}

export interface AutoApproveRules {
  maxFiles: number;
  maxCriteria: number;
  minBlueprintScore: number;
  requireDecomposition: boolean;
}

export function evaluateAutoApprove(
  blueprint: Blueprint,
  preflight: PreflightResult | undefined,
  rules: AutoApproveRules,
): boolean {
  // TASK-1324: a brief that failed the deterministic fidelity audit is
  // NEVER auto-approvable, in either execution mode — this is the single
  // predicate both the dispatch and loop paths consult (dispatcher
  // thresholdsPass). Absent fidelity (pre-1324 caches, deterministic
  // path) is tolerated: only an explicit failure refuses.
  if (blueprint.fidelity?.status === "failed") return false;

  const fileCount = blueprint.fileAnalyses.length;
  const criteriaCount = blueprint.verificationPatterns.length;

  if (fileCount > rules.maxFiles) return false;
  if (criteriaCount > rules.maxCriteria) return false;

  if (preflight) {
    const score = preflight.gate.score / 10; // normalize to 0-1
    if (score < rules.minBlueprintScore) return false;
    if (rules.requireDecomposition && preflight.complexity.recommendDecomposition) return false;
  }

  return true;
}

export async function savePendingApproval(
  taskId: string,
  blueprint: Blueprint,
  preflight: PreflightResult | undefined,
  logDir: string,
  specIdentity?: SpecIdentity,
): Promise<void> {
  await saveBlueprintApproval(
    taskId,
    blueprint,
    preflight,
    logDir,
    "pending",
    undefined,
    specIdentity,
  );
}

/**
 * Re-save an existing PENDING approval with a fresh `createdAt`,
 * preserving its blueprint and review evidence byte-for-byte.
 *
 * QPI-043: a fresh dispatch that re-encounters a pending approval must
 * leave a record whose `createdAt` postdates the dispatch, because the
 * monitor classifies a non-zero exit as awaiting_approval ONLY when the
 * pending record was created during that dispatch
 * (dispatch-manager.ts isGateApprovalPending). Without the re-save, the
 * re-encounter read as a silent child death. Deliberate side effect:
 * each re-encounter restarts the approval-timeout clock.
 */
export async function resavePendingApproval(
  existing: BlueprintApproval,
  logDir: string,
): Promise<void> {
  await saveBlueprintApproval(
    existing.taskId,
    existing.blueprint,
    existing.preflightResult,
    logDir,
    "pending",
    existing.executionMode === "loop" &&
      existing.review !== undefined &&
      existing.reviewGate !== undefined
      ? {
          review: existing.review,
          reviewedAt: existing.reviewedAt ?? existing.createdAt,
          reviewGate: existing.reviewGate,
        }
      : undefined,
    // TASK-1332 (R1-4): the EXISTING identity, copied, never recomputed.
    // A resave that re-stamped from the current spec would hand the old
    // artifact the amended spec's hash and make the defect invisible at
    // exactly the moment it fires. `createdAt` still refreshes above,
    // because TASK-1329 run-scoped attribution depends on the pending
    // record postdating the run — the two are deliberately independent.
    existing.specIdentity,
    // R5-3: and the version is copied for the same reason the identity
    // is. A resave that minted a fresh version would turn a genuinely
    // pre-1332 record into "written today with no identity", i.e.
    // `unverifiable`, and refuse every live legacy pend.
    { value: existing.specIdentityVersion },
  );
}

export async function saveBlueprintApproval(
  taskId: string,
  blueprint: Blueprint,
  preflight: PreflightResult | undefined,
  logDir: string,
  state: ApprovalState,
  reviewEvidence?: {
    review: ReviewRunResult;
    reviewedAt: string;
    reviewGate: LoopReviewGateFacts;
  },
  specIdentity?: SpecIdentity,
  /**
   * Round 5 (R5-3): resaves pass `{ value: existing.specIdentityVersion }`
   * so a genuinely pre-TASK-1332 record STAYS unversioned and therefore
   * stays `unknown_legacy`.
   *
   * The wrapper object exists because `undefined` has to mean two
   * different things here: "not supplied, mint one" at a creation site,
   * and "supplied, and it was absent" on a resave of a legacy record. A
   * plain optional parameter with a default cannot express the second,
   * and getting it wrong strands every live pre-1332 pend on the deploy
   * that ships this, the exact outcome the grandfather clause exists to
   * prevent.
   */
  specIdentityVersionOverride?: { value: number | undefined },
): Promise<void> {
  const specIdentityVersion = specIdentityVersionOverride
    ? specIdentityVersionOverride.value
    : SPEC_IDENTITY_VERSION;
  const approval: BlueprintApproval = {
    taskId,
    state,
    blueprint,
    preflightResult: preflight,
    createdAt: new Date().toISOString(),
    ...(reviewEvidence ? { executionMode: "loop" as const, ...reviewEvidence } : {}),
    ...(specIdentity ? { specIdentity } : {}),
    // R5-3: independent of `specIdentity`, and that is the point, a
    // creation writes it even when the identity could NOT be resolved,
    // which is precisely the case it exists to make legible. Never make
    // it conditional on `specIdentity`.
    ...(specIdentityVersion !== undefined ? { specIdentityVersion } : {}),
  };

  // TASK-1319 (R1-4): see the judge equivalent. Auto-approval is written
  // here, never through `updateApprovalState`, so this is the only place
  // that can record it. Outside loop mode there is no review at all and
  // a decomposition recommendation is the advice being overridden.
  // ROUND-2 R2-1 widened this from `auto-approved` to any decided
  // approval state. The dispatcher only ever passes `pending` or
  // `auto-approved` today, but this function is EXPORTED and accepts
  // the whole union, and "no caller does that yet" is the assumption
  // that put R1-4's first fix on a path the case never takes.
  if (state === "approved" || state === "auto-approved") {
    const override = buildDirectWriteOverride("blueprint_approval", state, {
      ...(reviewEvidence
        ? { review: reviewEvidence.review, reviewGate: reviewEvidence.reviewGate }
        : {}),
      ...(preflight?.complexity
        ? { preflightRecommendsDecomposition: preflight.complexity.recommendDecomposition }
        : {}),
    });
    if (override) approval.override = override;
  }

  const approvalDir = path.join(logDir, "approvals");
  await fs.mkdir(approvalDir, { recursive: true });
  const approvalPath = path.join(approvalDir, `${taskId}.json`);
  await fs.writeFile(approvalPath, JSON.stringify(approval, null, 2), "utf-8");
}

export async function loadApproval(
  taskId: string,
  logDir: string,
): Promise<BlueprintApproval | null> {
  try {
    const approvalPath = path.join(logDir, "approvals", `${taskId}.json`);
    const content = await fs.readFile(approvalPath, "utf-8");
    return JSON.parse(content) as BlueprintApproval;
  } catch {
    return null;
  }
}

/** Default timeout for pending approvals: 24 hours in milliseconds */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Checks whether a pending approval has exceeded its timeout.
 * Returns true if the approval is pending and has been waiting longer than timeoutMs.
 */
export function isApprovalExpired(
  approval: BlueprintApproval,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
): boolean {
  if (approval.state !== "pending") return false;
  const createdAt = new Date(approval.createdAt).getTime();
  const now = Date.now();
  return now - createdAt >= timeoutMs;
}

/**
 * TASK-1319 (R1-3): the enforcement boundary lives HERE, not at the HTTP
 * handler. This function is exported and accepts any state without even
 * checking the record is pending, so guarding the endpoint alone would
 * leave every other caller able to write `approved` undetected.
 *
 * Throws `AdvisoryOverrideRequiredError` only in `enforce` mode.
 */
export async function updateApprovalState(
  taskId: string,
  state: ApprovalState,
  logDir: string,
  approvedBy?: string,
  rejectionReason?: string,
  decision?: ApprovalDecisionOptions,
): Promise<{ override?: AdvisoryOverride; unexplained: boolean }> {
  const approval = await loadApproval(taskId, logDir);
  if (!approval) {
    throw new Error(`No pending approval found for task ${taskId}`);
  }

  // `auto-approved` counts (R1-4): `evaluateAutoApprove` reads only
  // blueprint size and decomposition rules, never the review evidence,
  // so it can approve past a reviewer with no human in the loop.
  const resolved = resolveApprovalDecision({
    surface: "blueprint_approval",
    isApproval: state === "approved" || state === "auto-approved",
    evidence: {
      ...(approval.review ? { review: approval.review } : {}),
      ...(approval.reviewGate ? { reviewGate: approval.reviewGate } : {}),
      // R1-1: this is already on the record and the first detector
      // ignored it, so approving past "split this first" recorded
      // nothing on a record that may carry no review at all.
      ...(approval.preflightResult?.complexity
        ? {
            preflightRecommendsDecomposition:
              approval.preflightResult.complexity.recommendDecomposition,
          }
        : {}),
    },
    // ROUND-2 R2-3: options are ALWAYS passed, not only when
    // `decision` exists. Skipping them meant a caller using the legacy
    // positional `approvedBy` (the dispatcher's timeout path) had its
    // known label replaced by "unattributed" the moment an override was
    // detected, which is strictly worse than the attribution it had.
    options: { ...decision, actor: decision?.actor ?? approvedBy },
  });

  approval.state = state;
  approval.decidedAt = new Date().toISOString();
  const actor = resolved.actor ?? approvedBy;
  if (actor) approval.approvedBy = actor;
  if (rejectionReason) approval.rejectionReason = rejectionReason;
  if (resolved.override) approval.override = resolved.override;

  const approvalPath = path.join(logDir, "approvals", `${taskId}.json`);
  await fs.writeFile(approvalPath, JSON.stringify(approval, null, 2), "utf-8");

  return {
    ...(resolved.override ? { override: resolved.override } : {}),
    unexplained: resolved.unexplained,
  };
}
