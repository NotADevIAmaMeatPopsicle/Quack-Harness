// ─── Judge Approval Gate ───────────────────────────────────────
// Approval state machine and auto-approve evaluator for judge review.
// Pauses dispatch between agent commit and judge evaluation to allow
// human review of agent changes before expensive judge evaluation.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";
import type { IntentJudgmentAction } from "../judgment/judgment-types.js";
import { SPEC_IDENTITY_VERSION, type SpecIdentity } from "../core/spec-identity.js";
import {
  buildDirectWriteOverride,
  resolveApprovalDecision,
  type AdvisoryOverride,
  type ApprovalDecisionOptions,
} from "../judgment/advisory-override.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "auto-approved";

/**
 * TASK-1316: a judge-stage intent hold. The intent model asked for human
 * review AFTER the judge ran, so the gate was re-opened. This record is
 * what makes the hold CLEARABLE: without it, a resume re-runs the judge,
 * re-asks the intent model, gets the same answer, and pauses forever.
 *
 * `diffFingerprint` binds the hold to the exact diff a human cleared, so
 * an approval can never carry forward to different work.
 */
export interface JudgeIntentHold {
  rationale: string[];
  diffFingerprint: string;
  heldAt: string;
  /**
   * TASK-1319 (R1-2): the intent action that CAUSED the hold.
   *
   * Round 1 caught the advisory detector treating a hold's PRESENCE as
   * advice against approving, which is a false positive, and reading
   * the creation site made it a total one: `dispatcher.ts` opens this
   * gate only under `action === "human_review"`. A hold therefore says
   * "a human must look at this", and a human looking at it and
   * approving SATISFIES the hold rather than contradicting it. Without
   * this field there is no way to tell those apart from the record.
   *
   * Recorded rather than inferred so the distinction survives if
   * `repair` or a future action ever opens a hold too: then the action
   * is on the record and the detector keeps answering correctly instead
   * of silently inheriting today's single-caller assumption.
   *
   * Optional because records written before TASK-1319 do not carry it.
   * Absent is read as `human_review`, which is both what every existing
   * record actually was and the choice that cannot invent a reason
   * prompt out of missing data.
   */
  action?: IntentJudgmentAction;
}

export interface JudgeApproval {
  taskId: string;
  state: ApprovalState;
  diff: string;
  filesModified: string[];
  filesCreated: string[];
  verificationPassed: boolean;
  approvedBy?: string;
  rejectionReason?: string;
  decidedAt?: string;
  createdAt: string;
  executionMode?: "loop";
  review?: ReviewRunResult;
  reviewedAt?: string;
  reviewGate?: LoopReviewGateFacts;
  agentSessionId?: string;
  intentHold?: JudgeIntentHold;
  /** TASK-1319: recorded when this decision contradicted stored advice. */
  override?: AdvisoryOverride;
  /**
   * TASK-1332 / QPI-045: which spec contract this diff was judged
   * against. Optional because pre-1332 records lack it and absence
   * must read as UNKNOWN.
   *
   * Binding the TASK-1316 hold release to this is TASK-1333, not this
   * task: refusing at the judge gate without a recovery action strands
   * the run (1332 S10), so the stamp lands first and the enforcement
   * follows with the recycle that makes it safe.
   */
  specIdentity?: SpecIdentity;
  /**
   * Round 5 (R5-3): the record-version boundary. See the blueprint twin.
   * Stamped even when `specIdentity` could not be resolved, so that a
   * record written today by stamping-aware code is never mistaken for a
   * pre-TASK-1332 record and grandfathered.
   */
  specIdentityVersion?: number;
}

export interface JudgeAutoApproveRules {
  requireVerificationPass: boolean;
  maxFilesChanged: number;
  maxDiffLines: number;
}

export function evaluateJudgeAutoApprove(
  diff: string,
  filesChanged: number,
  verificationPassed: boolean,
  rules: JudgeAutoApproveRules,
): boolean {
  if (rules.requireVerificationPass && !verificationPassed) return false;
  if (filesChanged > rules.maxFilesChanged) return false;

  const diffLines = diff.split("\n").length;
  if (diffLines > rules.maxDiffLines) return false;

  return true;
}

/**
 * Re-save an existing PENDING judge approval with a fresh `createdAt`,
 * preserving diff, review evidence, agent session, and — critically —
 * the persisted TASK-1316 intent hold, whose release mechanism depends
 * on the record surviving intact.
 *
 * QPI-043 twin of resavePendingApproval (see blueprint-approval.ts):
 * the monitor only classifies a non-zero exit as awaiting approval when
 * the pending record postdates the dispatch, so a re-encounter must
 * re-stamp it or the pause reads as a silent death.
 */
export async function resavePendingJudgeApproval(
  existing: JudgeApproval,
  logDir: string,
): Promise<void> {
  await saveJudgeApproval(
    existing.taskId,
    existing.diff,
    [
      ...existing.filesModified,
      // Reconstruct the raw prefixed form saveJudgeApproval re-splits.
      ...existing.filesCreated.map((f) => `new: ${f}`),
    ],
    existing.verificationPassed,
    logDir,
    "pending",
    existing.executionMode === "loop" &&
      existing.review !== undefined &&
      existing.reviewGate !== undefined
      ? {
          review: existing.review,
          reviewedAt: existing.reviewedAt ?? existing.createdAt,
          reviewGate: existing.reviewGate,
          agentSessionId: existing.agentSessionId,
        }
      : undefined,
    existing.intentHold,
    // TASK-1332 (R1-4): copied, never recomputed. See the blueprint twin.
    existing.specIdentity,
    // R5-3: the version is copied for the same reason, so a pre-1332
    // record stays legacy instead of becoming `unverifiable`.
    { value: existing.specIdentityVersion },
  );
}

export async function savePendingJudgeApproval(
  taskId: string,
  diff: string,
  filesChanged: string[],
  verificationPassed: boolean,
  logDir: string,
  specIdentity?: SpecIdentity,
): Promise<void> {
  await saveJudgeApproval(
    taskId,
    diff,
    filesChanged,
    verificationPassed,
    logDir,
    "pending",
    undefined,
    undefined,
    specIdentity,
  );
}

export async function saveJudgeApproval(
  taskId: string,
  diff: string,
  filesChanged: string[],
  verificationPassed: boolean,
  logDir: string,
  state: ApprovalState,
  reviewEvidence?: {
    review: ReviewRunResult;
    reviewedAt: string;
    reviewGate: LoopReviewGateFacts;
    agentSessionId?: string;
  },
  intentHold?: JudgeIntentHold,
  specIdentity?: SpecIdentity,
  /** R5-3: resaves pass `{ value: existing.specIdentityVersion }`. See the
   *  blueprint twin for why `undefined` alone cannot express it. */
  specIdentityVersionOverride?: { value: number | undefined },
): Promise<void> {
  const specIdentityVersion = specIdentityVersionOverride
    ? specIdentityVersionOverride.value
    : SPEC_IDENTITY_VERSION;
  const filesModified = filesChanged.filter(
    (f) => !f.startsWith("new:") && !f.startsWith("created:"),
  );
  const filesCreated = filesChanged
    .filter((f) => f.startsWith("new:") || f.startsWith("created:"))
    .map((f) => f.replace(/^(new:|created:)\s*/, ""));

  const approval: JudgeApproval = {
    taskId,
    state,
    diff,
    filesModified,
    filesCreated,
    verificationPassed,
    createdAt: new Date().toISOString(),
    ...(reviewEvidence ? { executionMode: "loop" as const, ...reviewEvidence } : {}),
    ...(intentHold ? { intentHold } : {}),
    ...(specIdentity ? { specIdentity } : {}),
    // R5-3: independent of `specIdentity`. See the blueprint twin, it
    // must be present even when `specIdentity` is not, or absence stays
    // ambiguous and resolves fail-open.
    ...(specIdentityVersion !== undefined ? { specIdentityVersion } : {}),
  };

  // TASK-1319 (R1-4): auto-approval is written HERE, not through
  // `updateJudgeApprovalState`, so this is the only place that can see
  // it. Loop mode requires a SHIP verdict for auto-approval, so the
  // reviewer's verdict cannot be contradicted there, but a diff whose
  // VERIFICATION failed still can be: `requireVerificationPass` is a
  // separate configurable rule. Never refuses; an automated gate has no
  // human to ask.
  // ROUND-2 R2-1 widened this from `auto-approved` to any decided
  // approval state. The dispatcher only ever passes `pending` or
  // `auto-approved` today, but this function is EXPORTED and accepts
  // the whole union, and "no caller does that yet" is the assumption
  // that put R1-4's first fix on a path the case never takes.
  if (state === "approved" || state === "auto-approved") {
    const override = buildDirectWriteOverride("judge_approval", state, {
      ...(reviewEvidence
        ? { review: reviewEvidence.review, reviewGate: reviewEvidence.reviewGate }
        : {}),
      ...(intentHold ? { intentHold } : {}),
      verificationPassed,
    });
    if (override) approval.override = override;
  }

  const approvalDir = path.join(logDir, "approvals");
  await fs.mkdir(approvalDir, { recursive: true });
  const approvalPath = path.join(approvalDir, `${taskId}-judge.json`);
  await fs.writeFile(approvalPath, JSON.stringify(approval, null, 2), "utf-8");
}

export async function loadJudgeApproval(
  taskId: string,
  logDir: string,
): Promise<JudgeApproval | null> {
  try {
    const approvalPath = path.join(logDir, "approvals", `${taskId}-judge.json`);
    const content = await fs.readFile(approvalPath, "utf-8");
    return JSON.parse(content) as JudgeApproval;
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
  approval: JudgeApproval,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
): boolean {
  if (approval.state !== "pending") return false;
  const createdAt = new Date(approval.createdAt).getTime();
  const now = Date.now();
  return now - createdAt >= timeoutMs;
}

/**
 * Delete a judge approval file (e.g., after rejection triggers agent retry).
 * The next dispatch run will create a fresh approval state.
 */
export async function deleteJudgeApproval(taskId: string, logDir: string): Promise<boolean> {
  try {
    const approvalPath = path.join(logDir, "approvals", `${taskId}-judge.json`);
    await fs.unlink(approvalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * TASK-1319 (R1-3): this writer is the enforcement boundary, not the
 * HTTP handler above it. It is exported and accepts any state, so
 * guarding the endpoint alone would leave every other caller free to
 * write `approved` with no detection.
 *
 * `approvedBy` stays positional so existing callers keep compiling;
 * `decision` is where actor, reason and mode arrive. Throws
 * `AdvisoryOverrideRequiredError` only in `enforce` mode.
 */
export async function updateJudgeApprovalState(
  taskId: string,
  state: ApprovalState,
  logDir: string,
  approvedBy?: string,
  rejectionReason?: string,
  decision?: ApprovalDecisionOptions,
): Promise<{ override?: AdvisoryOverride; unexplained: boolean }> {
  const approval = await loadJudgeApproval(taskId, logDir);
  if (!approval) {
    throw new Error(`No pending judge approval found for task ${taskId}`);
  }

  // `auto-approved` counts (R1-4): `evaluateJudgeAutoApprove` reads only
  // size and verification rules and never looks at `review`,
  // `reviewGate` or `intentHold`, so automation can contradict a
  // reviewer with no human involved and, before this, no record.
  const resolved = resolveApprovalDecision({
    surface: "judge_approval",
    isApproval: state === "approved" || state === "auto-approved",
    evidence: {
      ...(approval.review ? { review: approval.review } : {}),
      ...(approval.reviewGate ? { reviewGate: approval.reviewGate } : {}),
      ...(approval.intentHold ? { intentHold: approval.intentHold } : {}),
      verificationPassed: approval.verificationPassed,
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

  const approvalPath = path.join(logDir, "approvals", `${taskId}-judge.json`);
  await fs.writeFile(approvalPath, JSON.stringify(approval, null, 2), "utf-8");

  return {
    ...(resolved.override ? { override: resolved.override } : {}),
    unexplained: resolved.unexplained,
  };
}
