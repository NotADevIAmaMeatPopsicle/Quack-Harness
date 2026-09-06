// ─── Advisory override records (TASK-1319, P2-5) ────────────────────
// The v2 judgment plane made gates ADVISORY on purpose: a cross-model
// reviewer returns a verdict, safety-floor producers emit signals, the
// intent orchestrator can hold or demote, and then a human decides
// anyway. That is the design working. The human is the final authority.
//
// What was missing is the trace. `POST /api/tasks/:id/blueprint/approve`
// called `updateApprovalState(taskId, 'approved', logDir, 'human')` — a
// HARDCODED actor and no reason at all — so approving past a FIX_FIRST
// verdict, or clearing a persisted `JudgeIntentHold`, left a record
// saying `approvedBy: "human"` and nothing else. The advisory that was
// contradicted was not named and the reason did not exist anywhere.
//
// THE LOAD-BEARING DESIGN DECISION: an override is DETECTED from the
// stored advisory, never DECLARED by the caller.
//
// A caller who must remember to say "this is an override" will forget,
// and the field then reads as "we never override" when the truth is "we
// stopped labelling". Worse, it is trivially gameable: omit the flag and
// the audit is silent. The server already holds the reviewer verdict,
// the gate facts and any intent hold at the moment the approval arrives,
// so it decides for itself whether this approval contradicts advice, and
// demands a reason only then. Nothing a caller sends can suppress that.
//
// The corollary matters just as much: an approval that contradicts
// NOTHING must stay exactly as cheap as it is today. If routine
// approvals start demanding a reason, operators learn to type "ok" and
// the whole record becomes noise. Precision here is the feature.

import type { ReviewRunResult } from "../review/reviewer-types.js";
import type { LoopReviewGateFacts } from "../review/loop-gate.js";

/** Where an override happened. Named rather than free-text so an audit
 *  can group by gate without parsing prose.
 *
 *  `gate_depth_advisory` is deliberately ABSENT (round-1 R1-8). The
 *  event that looked like it belonged here, `gate_advisory_override`,
 *  fires when a READY depth verdict is routed to enrichment BECAUSE the
 *  advisory minimum is higher: that is the advisory being HONORED, and
 *  the event has been renamed `gate_advisory_applied` to stop it reading
 *  as the opposite of what it records. */
export type AdvisoryOverrideSurface = "blueprint_approval" | "judge_approval";

/**
 * Rollout mode, matching every other v2 cutover (round-1 R1-7).
 *
 * `off` records nothing. `warn` records the override with a placeholder
 * reason and lets the decision through. `enforce` refuses the decision
 * until an actor and a reason are supplied.
 *
 * Shipping straight to `enforce` was the spec's original plan and it was
 * wrong for the same reason it would be wrong anywhere else here: at 3am
 * a client that posts no body gets a hard failure, the resume never
 * runs, and the task sits pending. `warn` also produces the evidence
 * that tells us when enforcing is safe, which is exactly the argument
 * the safety-floor and readiness cutovers are still waiting on.
 */
export type AdvisoryOverrideMode = "off" | "warn" | "enforce";

/** The reason recorded in `warn` mode when the caller supplied none.
 *  Deliberately conspicuous: an audit row reading this is a row that
 *  needs a human, not a row that was explained. */
export const UNEXPLAINED_OVERRIDE_REASON = "(none given)";

/**
 * One recorded override.
 *
 * `advisories` is the point of the record: it captures WHAT was
 * contradicted, taken from the stored evidence at decision time rather
 * than reconstructed later from a reviewer artifact that may have been
 * overwritten by a retry.
 */
export interface AdvisoryOverride {
  surface: AdvisoryOverrideSurface;
  /** Who decided. Never a hardcoded literal. */
  actor: string;
  /** Why they decided against the advice. Never empty. */
  reason: string;
  /** What the advice was. Never empty when this record exists. */
  advisories: string[];
  at: string;
}

/** The machine-readable code the approve endpoints return with 400, so a
 *  dashboard can branch on it rather than matching on a message. */
export const ADVISORY_OVERRIDE_REASON_REQUIRED = "ADVISORY_OVERRIDE_REASON_REQUIRED";

/** The actor recorded when a decision path supplies none AND is not an
 *  override. Deliberately not "human": the server cannot identify a
 *  human from an unauthenticated POST, and claiming one would put a
 *  false attribution in the audit trail. */
export const UNATTRIBUTED_ACTOR = "unattributed";

/**
 * The advisory-bearing parts of a stored approval.
 *
 * Structural rather than the concrete `BlueprintApproval` /
 * `JudgeApproval` types, because the two records differ (only the judge
 * carries `intentHold`) and detection must read whichever fields are
 * present without either module importing the other.
 */
export interface AdvisoryEvidence {
  review?: ReviewRunResult;
  reviewGate?: LoopReviewGateFacts;
  /**
   * TASK-1316 judge-side intent hold.
   *
   * Round-1 R1-2: its PRESENCE is not advice against approving, and
   * reading `dispatcher.ts` made that total rather than occasional. The
   * judge hold is opened only under `action === "human_review"`, so
   * every hold on disk says "a human must look at this" and a human
   * looking and approving SATISFIES it. Only a non-`human_review` action
   * counts as advice; absent is read as `human_review`, which is what
   * every pre-1319 record actually was.
   */
  intentHold?: { rationale: string[]; action?: string };
  /**
   * Judge-side. Round-1 R1-1: this sits on `JudgeApproval` and the first
   * detector ignored it, so approving a diff whose verification FAILED
   * recorded nothing. A false negative on a record that may carry no
   * review at all, which is precisely the audit hole P2-5 exists to
   * close.
   */
  verificationPassed?: boolean;
  /**
   * Blueprint-side. Round-1 R1-1's other half: preflight recommending
   * decomposition is advice that this should be split before it is
   * built, and approving anyway contradicts it.
   */
  preflightRecommendsDecomposition?: boolean;
}

/**
 * Every advisory an approval of this record would contradict.
 *
 * EMPTY means the approval agrees with the advice, and the caller must
 * treat that as "not an override" and impose no new requirement.
 *
 * Three sources, deliberately in this order so the strongest signal
 * reads first:
 *
 * 1. A completed review whose verdict is not SHIP. AMEND and FIX_FIRST
 *    both say "not as it stands", so approving either is an override.
 *    A `runner_error` is NOT advice: it is an environment failure and
 *    the reviewer expressed no judgment about the artifact, so it
 *    contributes nothing. Treating it as advice would make every
 *    reviewer outage into a reason prompt, which is the false-positive
 *    failure that trains operators to type "ok".
 * 2. Gate facts that ruled the change out of AUTO-approval, with their
 *    own stated reasons. Note the asymmetry: not being eligible for
 *    auto-approval is precisely a referral to a human, so on its own it
 *    is NOT advice against approving.  It is included only when the
 *    reasons name something the reviewer could not vouch for, which is
 *    what `crossModelSatisfied`, `anchorAuditPassed` and `treeClean`
 *    each report. See `gateAdvisories`.
 * 3. A FAILED verification (judge side) or a preflight recommendation to
 *    decompose (blueprint side). Both live on records that may carry no
 *    review at all, which is what made omitting them a false negative
 *    rather than a nicety (round-1 R1-1).
 * 4. An intent hold whose action is NOT `human_review`. A `human_review`
 *    hold is a referral, and a human approving it satisfies it
 *    (round-1 R1-2).
 */
export function detectOverriddenAdvisories(evidence: AdvisoryEvidence): string[] {
  const advisories: string[] = [];

  if (evidence.review?.status === "completed" && evidence.review.verdict !== "SHIP") {
    const summary = evidence.review.summary?.trim();
    advisories.push(
      `reviewer verdict ${evidence.review.verdict}` + (summary ? `: ${summary}` : ""),
    );
  }

  advisories.push(...gateAdvisories(evidence.reviewGate));

  // Explicit `=== false`: absent means this surface does not carry the
  // fact (the blueprint record has no verification), and "not present"
  // must never read as "failed".
  if (evidence.verificationPassed === false) {
    advisories.push("verification did not pass");
  }
  if (evidence.preflightRecommendsDecomposition === true) {
    advisories.push("preflight recommends decomposing this task before building it");
  }

  advisories.push(...intentHoldAdvisories(evidence.intentHold));

  return advisories;
}

/**
 * A hold is advice against approving ONLY when the action that opened it
 * was something other than a referral to a human.
 *
 * Today `dispatcher.ts` opens the judge hold under `human_review` and
 * nothing else, so this returns empty for every hold currently on disk.
 * That is the correct answer and it is the whole of round-1 R1-2: the
 * previous version returned every hold's rationale, making a reason
 * prompt certain on the one stage where holds actually occur.
 *
 * It is written as a general rule rather than `return []` because the
 * action is now recorded, and if `repair` (or a future action) ever
 * opens a hold, this keeps answering correctly instead of silently
 * inheriting a single-caller assumption.
 */
function intentHoldAdvisories(
  hold: { rationale: string[]; action?: string } | undefined,
): string[] {
  if (!hold) return [];
  // Absent action = a pre-1319 record, every one of which was a
  // `human_review` hold.
  const action = hold.action ?? "human_review";
  if (action === "human_review") return [];

  const advisories: string[] = [];
  for (const rationale of hold.rationale) {
    const text = rationale.trim();
    if (text) advisories.push(`intent hold (${action}): ${text}`);
  }
  return advisories;
}

/**
 * The gate facts that constitute ADVICE AGAINST approving, as opposed to
 * a referral to a human.
 *
 * `eligibleForAutoApproval: false` alone is the referral, and treating
 * it as advice would fire on every human gate in loop mode — which is
 * every gate, since both example and Quack run with no auto-approve
 * thresholds. That is the noise failure, so the three specific facts are
 * read instead: a review that was not cross-model when cross-model was
 * required, findings whose file anchors did not check out against disk,
 * and a working tree left dirty by a supposedly read-only review. Each
 * says the reviewer's opinion cannot be relied on as given, which is a
 * different and weaker claim than "this is wrong", and is exactly the
 * kind of thing an operator should have to acknowledge in writing.
 */
function gateAdvisories(gate: LoopReviewGateFacts | undefined): string[] {
  if (!gate) return [];

  // ROUND-2 R2-2: each fact is compared `=== false`, NOT `!fact`.
  //
  // These are persisted records, so a field can be ABSENT — a gate
  // written before these facts existed, or a partially recovered one.
  // `!undefined` is true, so the original `!gate.crossModelSatisfied`
  // turned three MISSING facts into three affirmative contradictions,
  // and enforce mode would have demanded a reason on a routine recovery
  // that carried no negative evidence at all. Absent is not false.
  //
  // Caught by the cross-model round, and fairly: `verificationPassed`
  // three lines away was written `=== false` for exactly this reason,
  // and this block was not.
  const advisories: string[] = [];
  if (gate.crossModelSatisfied === false) {
    advisories.push("gate: cross-model review requirement not satisfied");
  }
  if (gate.anchorAuditPassed === false) {
    advisories.push("gate: reviewer finding anchors failed the on-disk audit");
  }
  if (gate.treeClean === false) {
    advisories.push("gate: working tree was dirty after a read-only review");
  }

  // The gate's own reasons are the operator-facing explanation of the
  // facts above, so they ride along ONLY when at least one fact fired.
  // Attaching them to a clean gate would turn "not auto-approvable,
  // see a human" into advice against the human's decision.
  if (advisories.length > 0) {
    for (const reason of gate.reasons) {
      const text = reason.trim();
      if (text) advisories.push(`gate reason: ${text}`);
    }
  }

  return advisories;
}

export interface BuildAdvisoryOverrideInput {
  surface: AdvisoryOverrideSurface;
  actor?: string;
  reason?: string;
  advisories: string[];
  at: string;
}

export type AdvisoryOverrideBuild =
  | { ok: true; override: AdvisoryOverride }
  | { ok: false; missing: Array<"actor" | "reason">; advisories: string[] };

/**
 * Validate and build the record, or report exactly which fields are
 * missing so the caller can say so in a 400.
 *
 * Blank and whitespace-only are treated as missing. A reason of `" "`
 * satisfies a truthiness check while recording nothing, and a record
 * that exists but says nothing is worse than an honest rejection
 * because it looks like coverage.
 *
 * Callers must not reach this with an empty `advisories`: a record whose
 * whole purpose is naming what was overridden cannot be built when
 * nothing was. That is a programming error, not a user error, so it
 * throws rather than returning a validation failure.
 */
export function buildAdvisoryOverride(input: BuildAdvisoryOverrideInput): AdvisoryOverrideBuild {
  if (input.advisories.length === 0) {
    throw new Error(
      "buildAdvisoryOverride requires at least one overridden advisory; " +
        "check detectOverriddenAdvisories before calling",
    );
  }

  const actor = input.actor?.trim() ?? "";
  const reason = input.reason?.trim() ?? "";
  const missing: Array<"actor" | "reason"> = [];
  if (!actor) missing.push("actor");
  if (!reason) missing.push("reason");
  if (missing.length > 0) {
    return { ok: false, missing, advisories: input.advisories };
  }

  return {
    ok: true,
    override: {
      surface: input.surface,
      actor,
      reason,
      advisories: input.advisories,
      at: input.at,
    },
  };
}

// ─── The enforcement boundary (round-1 R1-3) ────────────────────────
// The spec put enforcement at the two HTTP approve handlers. Round 1
// refuted that and was right: `updateApprovalState` and
// `updateJudgeApprovalState` are EXPORTED, accept any state, and do not
// even check that the record is pending, so guarding the handlers leaves
// every other caller free to write `approved` with no detection at all.
//
// So the writers are the boundary. `resolveApprovalDecision` is the
// shared body both of them run, and an endpoint's only job is to
// translate the typed refusal into a status code.

/** Thrown by the writers when `enforce` mode blocks a decision. Typed so
 *  a route can map it to a 400 without matching on message text. */
export class AdvisoryOverrideRequiredError extends Error {
  readonly code = ADVISORY_OVERRIDE_REASON_REQUIRED;
  constructor(
    readonly surface: AdvisoryOverrideSurface,
    readonly advisories: string[],
    readonly missing: Array<"actor" | "reason">,
  ) {
    super(
      `This decision contradicts ${advisories.length} advisory item(s); ` +
        `${missing.join(" and ")} required to record the override`,
    );
    this.name = "AdvisoryOverrideRequiredError";
  }
}

export interface ApprovalDecisionOptions {
  /** Who decided. A LABEL, not an authenticated identity (round-1 R1-9):
   *  these endpoints add no authentication, so any caller can type any
   *  name. Recorded for audit, never trusted as attribution. */
  actor?: string;
  reason?: string;
  /** Defaults to `warn`. */
  mode?: AdvisoryOverrideMode;
  /** Injected so tests and callers do not depend on a clock. */
  now?: string;
}

export interface ApprovalDecisionResult {
  /** The actor to persist. Never the literal `"human"` (round-1: that
   *  was a hardcoded claim the server could not support). */
  actor?: string;
  /** Present only when this decision contradicted advice AND the mode
   *  records it. */
  override?: AdvisoryOverride;
  /** True when `warn` mode let an unexplained override through. The
   *  caller emits the warning; this module does no I/O. */
  unexplained: boolean;
  advisories: string[];
}

/** The actor recorded for an automated approval. Not a person, and
 *  deliberately not `UNATTRIBUTED_ACTOR` either: nobody failed to
 *  attribute this, a policy made it. */
export const AUTO_POLICY_ACTOR = "auto_policy";

/**
 * The override record for an AUTOMATED approval, or undefined when the
 * automation agreed with the advice.
 *
 * Round-1 R1-4 asked for `auto-approved` coverage and the first build
 * put it only in the UPDATE writers. That was wrong, and I found it
 * before round 2 did: auto-approval never goes through those writers. It
 * is written by `saveBlueprintApproval` / `saveJudgeApproval` with
 * `state: "auto-approved"` directly from the dispatcher, so the guard
 * sat on a path the case never takes.
 *
 * Loop mode narrows but does not close the hole. `eligibleForAutoApproval`
 * requires `verdict === "SHIP"`, so automation cannot contradict the
 * reviewer's VERDICT there. It can still auto-approve a diff whose
 * verification failed, because `requireVerificationPass` is a separate
 * configurable rule, and outside loop mode there is no review at all.
 *
 * This never REFUSES, in any mode. There is no human at an automated
 * gate to ask for a reason, and failing the write would strand the
 * dispatch. The point is that the decision stops being invisible.
 */
export function buildDirectWriteOverride(
  surface: AdvisoryOverrideSurface,
  /** ROUND-2b: the state MATTERS, because it decides who to blame. The
   *  first version of this labelled every direct write `auto_policy`
   *  with an "auto-approved by policy" reason, which is a FALSE audit
   *  record for a direct `approved` write: no policy made that call.
   *  Getting the attribution wrong is worse than the silence this
   *  function exists to end. */
  state: "approved" | "auto-approved",
  evidence: AdvisoryEvidence,
  options: { mode?: AdvisoryOverrideMode; now?: string } = {},
): AdvisoryOverride | undefined {
  if ((options.mode ?? "warn") === "off") return undefined;
  const advisories = detectOverriddenAdvisories(evidence);
  if (advisories.length === 0) return undefined;
  return {
    surface,
    actor: state === "auto-approved" ? AUTO_POLICY_ACTOR : UNATTRIBUTED_ACTOR,
    reason:
      state === "auto-approved"
        ? "auto-approved by policy despite the advice above; no human was asked"
        : "approved by a direct record write that bypassed the decision boundary; no actor or reason was supplied",
    advisories,
    at: options.now ?? new Date().toISOString(),
  };
}

/**
 * Decide what a state change should record, and refuse it in `enforce`
 * mode when it contradicts advice without saying why.
 *
 * `states` is the transition matrix round-1 R1-5 asked for, supplied by
 * the caller rather than assumed here: the judge and blueprint writers
 * pass which target states count as "agreeing with the work". Both count
 * `auto-approved` alongside `approved` (round-1 R1-4), because neither
 * auto-approve evaluator reads review evidence, so automation can
 * contradict a reviewer with no human in the loop at all.
 *
 * Throws `AdvisoryOverrideRequiredError` only in `enforce` mode.
 */
export function resolveApprovalDecision(input: {
  surface: AdvisoryOverrideSurface;
  /** True when the target state means "proceed with this work". */
  isApproval: boolean;
  evidence: AdvisoryEvidence;
  options?: ApprovalDecisionOptions;
}): ApprovalDecisionResult {
  const options = input.options ?? {};
  const mode: AdvisoryOverrideMode = options.mode ?? "warn";
  const actor = options.actor?.trim() || undefined;

  if (mode === "off" || !input.isApproval) {
    return { ...(actor ? { actor } : {}), unexplained: false, advisories: [] };
  }

  const advisories = detectOverriddenAdvisories(input.evidence);
  if (advisories.length === 0) {
    // Not an override. Nothing new is required, which is the property
    // that keeps routine approvals from becoming a reason tax.
    return { ...(actor ? { actor } : {}), unexplained: false, advisories };
  }

  const at = options.now ?? new Date().toISOString();
  const built = buildAdvisoryOverride({
    surface: input.surface,
    ...(actor ? { actor } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    advisories,
    at,
  });

  if (built.ok) {
    return {
      actor: built.override.actor,
      override: built.override,
      unexplained: false,
      advisories,
    };
  }

  if (mode === "enforce") {
    throw new AdvisoryOverrideRequiredError(input.surface, advisories, built.missing);
  }

  // `warn`: record it, mark it, let it through. The row is deliberately
  // ugly so it reads as "needs a human", not as an explanation.
  return {
    actor: actor ?? UNATTRIBUTED_ACTOR,
    override: {
      surface: input.surface,
      actor: actor ?? UNATTRIBUTED_ACTOR,
      reason: options.reason?.trim() || UNEXPLAINED_OVERRIDE_REASON,
      advisories,
      at,
    },
    unexplained: true,
    advisories,
  };
}
