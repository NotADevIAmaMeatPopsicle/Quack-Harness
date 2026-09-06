// ─── Advisory override detection (TASK-1319, P2-5) ──────────────────
// The two failure modes these pins exist for pull in OPPOSITE
// directions, and getting either wrong destroys the feature:
//
//   FALSE NEGATIVE — an approval genuinely contradicts advice and
//   detection returns empty. The audit silently misses a real override,
//   which is the exact hole P2-5 was filed to close.
//
//   FALSE POSITIVE — detection fires on a routine approval. Operators
//   get a reason prompt every time, learn to type "ok", and the record
//   becomes noise that looks like coverage. This is the more dangerous
//   one, because it fails while appearing to work.

import {
  buildAdvisoryOverride,
  detectOverriddenAdvisories,
  type AdvisoryEvidence,
} from "../../src/judgment/advisory-override";
import type { LoopReviewGateFacts } from "../../src/review/loop-gate";
import type { ReviewRunResult, ReviewVerdict } from "../../src/review/reviewer-types";

function completed(verdict: ReviewVerdict, summary = "Reviewer summary"): ReviewRunResult {
  return {
    status: "completed",
    verdict,
    findings: [],
    summary,
    rawText: "",
    runner: "codex-cli",
    durationMs: 1000,
  };
}

function gate(overrides: Partial<LoopReviewGateFacts> = {}): LoopReviewGateFacts {
  return {
    crossModelSatisfied: true,
    anchorAuditPassed: true,
    treeClean: true,
    fidelityPassed: true,
    eligibleForAutoApproval: true,
    reasons: [],
    ...overrides,
  };
}

describe("detectOverriddenAdvisories: what counts as advice", () => {
  it("a SHIP verdict on a clean gate is not an override", () => {
    expect(detectOverriddenAdvisories({ review: completed("SHIP"), reviewGate: gate() })).toEqual(
      [],
    );
  });

  it("AMEND and FIX_FIRST are both advice against approving as-is", () => {
    // Only FIX_FIRST reads as a hard "no", but AMEND still says "not as
    // it stands". Approving either without a word is the thing P2-5
    // exists to stop.
    for (const verdict of ["AMEND", "FIX_FIRST"] as const) {
      const advisories = detectOverriddenAdvisories({ review: completed(verdict) });
      expect(advisories).toHaveLength(1);
      expect(advisories[0]).toContain(verdict);
      expect(advisories[0]).toContain("Reviewer summary");
    }
  });

  it("a runner_error is NOT advice, because the reviewer never judged the artifact", () => {
    // THE false-positive case. Reviewer outages happen; codex hit
    // "model is at capacity" twice while this very task was being
    // written. If every outage demanded an override reason, operators
    // would type "ok" through them and the record would be worthless.
    const runnerError: ReviewRunResult = {
      status: "runner_error",
      errorKind: "unavailable",
      message: "Selected model is at capacity",
      runner: "codex-cli",
      durationMs: 12,
    };
    expect(detectOverriddenAdvisories({ review: runnerError })).toEqual([]);
  });

  it("not being eligible for AUTO-approval is a referral to a human, not advice", () => {
    // The single most important negative case. Both live adapters run
    // loop mode with NO auto-approve thresholds, so every gate pauses
    // for a human and `eligibleForAutoApproval` is false on all of
    // them. Treating that as advice would fire on literally every
    // approval in production.
    expect(
      detectOverriddenAdvisories({
        review: completed("SHIP"),
        reviewGate: gate({
          eligibleForAutoApproval: false,
          reasons: ["auto-approval disabled by adapter configuration"],
        }),
      }),
    ).toEqual([]);
  });

  it("gate facts that undermine the review ARE advice, and drag their reasons in", () => {
    const advisories = detectOverriddenAdvisories({
      review: completed("SHIP"),
      reviewGate: gate({
        crossModelSatisfied: false,
        anchorAuditPassed: false,
        treeClean: false,
        fidelityPassed: true,
        eligibleForAutoApproval: false,
        reasons: ["reviewer ran same-family", "2 anchors missing"],
      }),
    });

    expect(advisories).toEqual([
      "gate: cross-model review requirement not satisfied",
      "gate: reviewer finding anchors failed the on-disk audit",
      "gate: working tree was dirty after a read-only review",
      "gate reason: reviewer ran same-family",
      "gate reason: 2 anchors missing",
    ]);
  });

  it("a human_review intent hold is a REFERRAL, so approving it is not an override", () => {
    // Round-1 R1-2, and reading the creation site made it total rather
    // than occasional: `dispatcher.ts` opens the judge hold ONLY under
    // `action === "human_review"`. Every hold on disk therefore says "a
    // human must look at this", and a human looking and approving
    // SATISFIES it. The first version of this detector returned every
    // hold's rationale, which guaranteed a reason prompt on the one
    // stage where holds actually happen.
    expect(
      detectOverriddenAdvisories({
        intentHold: {
          action: "human_review",
          rationale: ["a human must confirm this migration"],
        },
      }),
    ).toEqual([]);
  });

  it("a hold with NO action is read as human_review, because every pre-1319 hold was", () => {
    expect(
      detectOverriddenAdvisories({
        intentHold: { rationale: ["a human must confirm this migration"] },
      }),
    ).toEqual([]);
  });

  it("a hold from a NON-referral action IS advice", () => {
    // The rule is written generally rather than as `return []` so that
    // if `repair` ever opens a hold, the detector keeps answering
    // correctly instead of inheriting today's single-caller assumption.
    const advisories = detectOverriddenAdvisories({
      intentHold: {
        action: "repair",
        rationale: ["scope exceeds the brief", "  ", "no test covers the new branch"],
      },
    });
    // Blank rationale entries record nothing and are dropped.
    expect(advisories).toEqual([
      "intent hold (repair): scope exceeds the brief",
      "intent hold (repair): no test covers the new branch",
    ]);
  });

  it("a FAILED verification is advice against approving the diff", () => {
    // Round-1 R1-1. This sits on `JudgeApproval` and the first detector
    // ignored it, so approving a diff whose verification failed recorded
    // nothing on a record that may carry no review at all.
    expect(detectOverriddenAdvisories({ verificationPassed: false })).toEqual([
      "verification did not pass",
    ]);
    // Passing is not advice, and ABSENT is not "failed": the blueprint
    // surface carries no verification at all.
    expect(detectOverriddenAdvisories({ verificationPassed: true })).toEqual([]);
    expect(detectOverriddenAdvisories({})).toEqual([]);
  });

  it("a preflight decomposition recommendation is advice against building it as one task", () => {
    expect(detectOverriddenAdvisories({ preflightRecommendsDecomposition: true })).toEqual([
      "preflight recommends decomposing this task before building it",
    ]);
    expect(detectOverriddenAdvisories({ preflightRecommendsDecomposition: false })).toEqual([]);
  });

  it("sources accumulate, strongest first", () => {
    const advisories = detectOverriddenAdvisories({
      review: completed("FIX_FIRST", "two blocking findings"),
      reviewGate: gate({ crossModelSatisfied: false, reasons: ["same-family reviewer"] }),
      verificationPassed: false,
      intentHold: { action: "repair", rationale: ["scope exceeds the brief"] },
    });
    expect(advisories).toHaveLength(5);
    expect(advisories[0]).toContain("FIX_FIRST");
    expect(advisories[4]).toContain("scope exceeds the brief");
  });

  it("an empty record is not an override", () => {
    // A pending approval with no review yet (the reviewer has not run,
    // or the stage does not use one) must not demand a reason.
    expect(detectOverriddenAdvisories({})).toEqual([]);
  });

  it("detection reads ONLY stored evidence, so a caller cannot suppress it", () => {
    // The anti-gaming property. `AdvisoryEvidence` has no field a
    // request body could populate to say "this is not an override";
    // extra properties are structurally ignored. If this ever fails,
    // the design has been inverted into the self-declared flag the
    // spec's anti-gaming clause forbids.
    const evidence = {
      review: completed("FIX_FIRST"),
      isOverride: false,
      override: false,
      requireReason: false,
    } as AdvisoryEvidence;
    expect(detectOverriddenAdvisories(evidence)).toHaveLength(1);
  });
});

describe("buildAdvisoryOverride: the record cannot be empty theatre", () => {
  const at = "2026-08-07T12:00:00.000Z";

  it("builds when actor and reason are both present", () => {
    const built = buildAdvisoryOverride({
      surface: "judge_approval",
      actor: "operator",
      reason: "the finding is a false positive; anchors point at a moved file",
      advisories: ["reviewer verdict FIX_FIRST"],
      at,
    });
    expect(built).toEqual({
      ok: true,
      override: {
        surface: "judge_approval",
        actor: "operator",
        reason: "the finding is a false positive; anchors point at a moved file",
        advisories: ["reviewer verdict FIX_FIRST"],
        at,
      },
    });
  });

  it("whitespace-only fields are MISSING, not present", () => {
    // `" "` satisfies a truthiness check while recording nothing. A
    // record that exists and says nothing is worse than a rejection,
    // because it reads as coverage in the audit.
    const built = buildAdvisoryOverride({
      surface: "blueprint_approval",
      actor: "   ",
      reason: "\t\n",
      advisories: ["reviewer verdict AMEND"],
      at,
    });
    expect(built).toEqual({
      ok: false,
      missing: ["actor", "reason"],
      advisories: ["reviewer verdict AMEND"],
    });
  });

  it("reports exactly which field is missing", () => {
    const built = buildAdvisoryOverride({
      surface: "blueprint_approval",
      actor: "operator",
      advisories: ["reviewer verdict AMEND"],
      at,
    });
    expect(built).toEqual({
      ok: false,
      missing: ["reason"],
      advisories: ["reviewer verdict AMEND"],
    });
  });

  it("trims what it stores", () => {
    const built = buildAdvisoryOverride({
      surface: "judge_approval",
      actor: "  operator  ",
      reason: "  the anchor points at a moved file  ",
      advisories: ["gate: reviewer finding anchors failed the on-disk audit"],
      at,
    });
    expect(built.ok && built.override.actor).toBe("operator");
    expect(built.ok && built.override.reason).toBe("the anchor points at a moved file");
  });

  it("refuses to build a record with nothing to name", () => {
    // A programming error, not a user error: the record's entire
    // purpose is naming what was overridden.
    expect(() =>
      buildAdvisoryOverride({
        surface: "judge_approval",
        actor: "operator",
        reason: "looks fine",
        advisories: [],
        at,
      }),
    ).toThrow(/at least one overridden advisory/);
  });
});

// ─── Round-2 findings, pinned ───────────────────────────────────────

describe("round-2 R2-2: ABSENT gate facts are not FALSE gate facts", () => {
  it("a partial gate record produces no advisories", () => {
    // These are PERSISTED records, so a field can be missing: a gate
    // written before these facts existed, or a partially recovered one.
    // `!undefined` is true, so the original `!gate.crossModelSatisfied`
    // turned three MISSING facts into three affirmative contradictions
    // and enforce mode would have demanded a reason on a routine
    // recovery carrying no negative evidence at all.
    const partial = {
      eligibleForAutoApproval: false,
      reasons: ["review unavailable"],
    } as unknown as LoopReviewGateFacts;

    expect(detectOverriddenAdvisories({ reviewGate: partial })).toEqual([]);
  });

  it("an explicitly false fact still fires", () => {
    // The other half: fixing the absent case must not blunt the real one.
    const partial = {
      crossModelSatisfied: false,
      reasons: ["same-family reviewer"],
    } as unknown as LoopReviewGateFacts;

    expect(detectOverriddenAdvisories({ reviewGate: partial })).toEqual([
      "gate: cross-model review requirement not satisfied",
      "gate reason: same-family reviewer",
    ]);
  });
});
