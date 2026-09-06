// ─── Advisory override enforcement (TASK-1319, R1-3/R1-4/R1-7) ──────
// Round 1 refuted the spec's plan to enforce at the two HTTP handlers:
// `updateApprovalState` and `updateJudgeApprovalState` are EXPORTED,
// accept any state, and never check the record is pending, so guarding
// the endpoints leaves every other caller free to write `approved` with
// no detection at all.
//
// So these exercise the WRITERS. Every test goes through the real
// function against a real approval file on disk. If enforcement ever
// moves back up to the route layer, these fail.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  saveBlueprintApproval,
  loadApproval,
  updateApprovalState,
} from "../../src/dispatcher/blueprint-approval";
import {
  saveJudgeApproval,
  loadJudgeApproval,
  updateJudgeApprovalState,
} from "../../src/dispatcher/judge-approval";
import { AdvisoryOverrideRequiredError } from "../../src/judgment/advisory-override";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import type { LoopReviewGateFacts } from "../../src/review/loop-gate";
import type { ReviewRunResult, ReviewVerdict } from "../../src/review/reviewer-types";

const tempDirs: string[] = [];

async function makeLogDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-1319-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must never fail the suite.
    }
  }
});

function review(verdict: ReviewVerdict): ReviewRunResult {
  return {
    status: "completed",
    verdict,
    findings: [],
    summary: "reviewer summary",
    rawText: "",
    runner: "codex-cli",
    durationMs: 1,
  };
}

function gate(overrides: Partial<LoopReviewGateFacts> = {}): LoopReviewGateFacts {
  return {
    crossModelSatisfied: true,
    anchorAuditPassed: true,
    treeClean: true,
    fidelityPassed: true,
    eligibleForAutoApproval: false,
    reasons: ["auto-approval disabled by adapter configuration"],
    ...overrides,
  };
}

const blueprint = {
  fileAnalyses: [],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
} as unknown as Blueprint;

function preflight(recommendDecomposition: boolean): PreflightResult {
  return {
    complexity: { recommendDecomposition },
  } as unknown as PreflightResult;
}

// ─── Judge surface ──────────────────────────────────────────────────

describe("updateJudgeApprovalState is the enforcement boundary", () => {
  async function seed(
    logDir: string,
    taskId: string,
    opts: { verdict?: ReviewVerdict; verificationPassed?: boolean } = {},
  ): Promise<void> {
    await saveJudgeApproval(
      taskId,
      "diff",
      ["src/a.ts"],
      opts.verificationPassed ?? true,
      logDir,
      "pending",
      opts.verdict
        ? { review: review(opts.verdict), reviewedAt: "2026-08-07T00:00:00Z", reviewGate: gate() }
        : undefined,
    );
  }

  it("ENFORCE refuses an approval that contradicts the reviewer, and writes nothing", async () => {
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9001", { verdict: "FIX_FIRST" });

    await expect(
      updateJudgeApprovalState("TASK-9001", "approved", logDir, undefined, undefined, {
        mode: "enforce",
      }),
    ).rejects.toBeInstanceOf(AdvisoryOverrideRequiredError);

    // The refusal must be atomic: a record left half-decided would be
    // worse than either outcome.
    const after = await loadJudgeApproval("TASK-9001", logDir);
    expect(after?.state).toBe("pending");
    expect(after?.override).toBeUndefined();
  });

  it("ENFORCE names the advisories and the missing fields on the error", async () => {
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9002", { verdict: "AMEND" });

    try {
      await updateJudgeApprovalState("TASK-9002", "approved", logDir, undefined, undefined, {
        mode: "enforce",
        actor: "operator",
      });
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(AdvisoryOverrideRequiredError);
      const required = err as AdvisoryOverrideRequiredError;
      // Only `reason` is missing: the actor was supplied.
      expect(required.missing).toEqual(["reason"]);
      expect(required.advisories[0]).toContain("AMEND");
      expect(required.surface).toBe("judge_approval");
    }
  });

  it("ENFORCE accepts the same approval once actor and reason are supplied", async () => {
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9003", { verdict: "FIX_FIRST" });

    const out = await updateJudgeApprovalState(
      "TASK-9003",
      "approved",
      logDir,
      undefined,
      undefined,
      { mode: "enforce", actor: "operator", reason: "anchors point at a file the rename moved" },
    );

    expect(out.unexplained).toBe(false);
    const after = await loadJudgeApproval("TASK-9003", logDir);
    expect(after?.state).toBe("approved");
    expect(after?.approvedBy).toBe("operator");
    expect(after?.override?.actor).toBe("operator");
    expect(after?.override?.reason).toBe("anchors point at a file the rename moved");
    expect(after?.override?.advisories[0]).toContain("FIX_FIRST");
  });

  it("a CLEAN approval is untouched: no refusal, no override record, no new requirement", async () => {
    // The availability control, and the property that keeps this from
    // becoming a tax on every approval. Note the gate here has
    // `eligibleForAutoApproval: false`, which is true of EVERY gate in
    // production, so if that alone counted this would fail.
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9004", { verdict: "SHIP" });

    const out = await updateJudgeApprovalState(
      "TASK-9004",
      "approved",
      logDir,
      undefined,
      undefined,
      { mode: "enforce" },
    );

    expect(out.override).toBeUndefined();
    expect(out.unexplained).toBe(false);
    const after = await loadJudgeApproval("TASK-9004", logDir);
    expect(after?.state).toBe("approved");
    expect(after?.override).toBeUndefined();
  });

  it("WARN records the override, marks it unexplained, and lets it through", async () => {
    // Round-1 R1-7. At 3am a bodyless client must still be able to
    // approve; what it must not do is leave no trace.
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9005", { verdict: "FIX_FIRST" });

    const out = await updateJudgeApprovalState(
      "TASK-9005",
      "approved",
      logDir,
      undefined,
      undefined,
      { mode: "warn" },
    );

    expect(out.unexplained).toBe(true);
    const after = await loadJudgeApproval("TASK-9005", logDir);
    expect(after?.state).toBe("approved");
    expect(after?.override?.reason).toBe("(none given)");
    expect(after?.override?.actor).toBe("unattributed");
    expect(after?.override?.advisories[0]).toContain("FIX_FIRST");
  });

  it("WARN is the DEFAULT when no mode is supplied", async () => {
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9006", { verdict: "FIX_FIRST" });
    const out = await updateJudgeApprovalState(
      "TASK-9006",
      "approved",
      logDir,
      undefined,
      undefined,
      {},
    );
    expect(out.unexplained).toBe(true);
  });

  it("OFF records nothing at all", async () => {
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9007", { verdict: "FIX_FIRST" });
    const out = await updateJudgeApprovalState(
      "TASK-9007",
      "approved",
      logDir,
      undefined,
      undefined,
      { mode: "off" },
    );
    expect(out.override).toBeUndefined();
    const after = await loadJudgeApproval("TASK-9007", logDir);
    expect(after?.state).toBe("approved");
    expect(after?.override).toBeUndefined();
  });

  it("AUTO-APPROVED is covered, not just human approval", async () => {
    // Round-1 R1-4: `evaluateJudgeAutoApprove` reads only size and
    // verification rules and never looks at the review, so automation
    // can approve past a FIX_FIRST with no human in the loop. Before
    // this, that produced no record whatsoever.
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9008", { verdict: "FIX_FIRST" });

    const out = await updateJudgeApprovalState(
      "TASK-9008",
      "auto-approved",
      logDir,
      undefined,
      undefined,
      { mode: "warn" },
    );

    expect(out.override?.advisories[0]).toContain("FIX_FIRST");
    expect(out.unexplained).toBe(true);
  });

  it("a FAILED verification alone is an override, with no review on the record at all", async () => {
    // Round-1 R1-1 end to end. `savePendingJudgeApproval` stores no
    // review evidence, so this record has none; the first detector
    // returned EMPTY here and the audit missed it entirely.
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9009", { verificationPassed: false });

    await expect(
      updateJudgeApprovalState("TASK-9009", "approved", logDir, undefined, undefined, {
        mode: "enforce",
      }),
    ).rejects.toThrow(/verification|advisory/i);
  });

  it("REJECTING is never blocked, whatever the advice said", async () => {
    // Refusing to ship is never the dangerous direction, and a gate
    // that can trap an operator into approving would be worse than the
    // hole it closes.
    const logDir = await makeLogDir();
    await seed(logDir, "TASK-9010", { verdict: "SHIP" });

    const out = await updateJudgeApprovalState(
      "TASK-9010",
      "rejected",
      logDir,
      undefined,
      "not what I asked for",
      { mode: "enforce" },
    );

    expect(out.override).toBeUndefined();
    const after = await loadJudgeApproval("TASK-9010", logDir);
    expect(after?.state).toBe("rejected");
  });
});

// ─── Blueprint surface ──────────────────────────────────────────────

describe("updateApprovalState is the enforcement boundary", () => {
  it("a preflight decomposition recommendation blocks a bare approval in ENFORCE", async () => {
    // Round-1 R1-1's blueprint half, and note there is NO review on
    // this record: `savePendingApproval` never stores one.
    const logDir = await makeLogDir();
    await saveBlueprintApproval("TASK-9101", blueprint, preflight(true), logDir, "pending");

    await expect(
      updateApprovalState("TASK-9101", "approved", logDir, undefined, undefined, {
        mode: "enforce",
      }),
    ).rejects.toBeInstanceOf(AdvisoryOverrideRequiredError);
  });

  it("no decomposition recommendation means no new requirement", async () => {
    const logDir = await makeLogDir();
    await saveBlueprintApproval("TASK-9102", blueprint, preflight(false), logDir, "pending");

    const out = await updateApprovalState("TASK-9102", "approved", logDir, undefined, undefined, {
      mode: "enforce",
    });

    expect(out.override).toBeUndefined();
    const after = await loadApproval("TASK-9102", logDir);
    expect(after?.state).toBe("approved");
  });

  it("the recorded actor is never the literal 'human'", async () => {
    // The endpoints used to hardcode `'human'`, an attribution the
    // server cannot support: there is no authentication on these
    // routes. An unexplained override says `unattributed` instead.
    const logDir = await makeLogDir();
    await saveBlueprintApproval("TASK-9103", blueprint, preflight(true), logDir, "pending");

    await updateApprovalState("TASK-9103", "approved", logDir, undefined, undefined, {
      mode: "warn",
    });

    const after = await loadApproval("TASK-9103", logDir);
    expect(after?.approvedBy).toBe("unattributed");
    expect(after?.approvedBy).not.toBe("human");
  });

  it("a caller cannot suppress detection with a body field", async () => {
    // The anti-gaming property, at the writer rather than the type
    // level: detection reads the STORED record, so nothing a caller
    // sends can turn it off.
    const logDir = await makeLogDir();
    await saveBlueprintApproval("TASK-9104", blueprint, preflight(true), logDir, "pending");

    await expect(
      updateApprovalState("TASK-9104", "approved", logDir, undefined, undefined, {
        mode: "enforce",
        // Not part of the options type; present here as the shape a
        // gaming caller would try.
        ...({ isOverride: false, override: false, requireReason: false } as object),
      }),
    ).rejects.toBeInstanceOf(AdvisoryOverrideRequiredError);
  });
});

// ─── The auto-approve path R1-4 actually meant ──────────────────────
// Found while self-checking the build, BEFORE round 2: the first
// implementation put R1-4's `auto-approved` coverage in the UPDATE
// writers, and auto-approval never goes through them. The dispatcher
// calls `save*Approval` with `state: "auto-approved"` directly, so the
// guard sat on a path the case never takes. These exercise the path it
// does take.

describe("auto-approval records its own override, on the path it actually takes", () => {
  it("a judge auto-approval with FAILED verification is recorded", async () => {
    // Loop mode requires a SHIP verdict to auto-approve, so the verdict
    // cannot be contradicted there. Verification is a SEPARATE
    // configurable rule (`requireVerificationPass`), so this is the case
    // that survives: automation shipping a diff whose tests did not pass.
    const logDir = await makeLogDir();
    await saveJudgeApproval(
      "TASK-9201",
      "diff",
      ["src/a.ts"],
      false, // verification FAILED
      logDir,
      "auto-approved",
      { review: review("SHIP"), reviewedAt: "2026-08-07T00:00:00Z", reviewGate: gate() },
    );

    const stored = await loadJudgeApproval("TASK-9201", logDir);
    expect(stored?.state).toBe("auto-approved");
    expect(stored?.override?.actor).toBe("auto_policy");
    expect(stored?.override?.advisories).toContain("verification did not pass");
    // Not a person, and not "unattributed" either: nobody failed to
    // attribute this, a policy made it.
    expect(stored?.override?.actor).not.toBe("unattributed");
  });

  it("a clean judge auto-approval records nothing", async () => {
    const logDir = await makeLogDir();
    await saveJudgeApproval("TASK-9202", "diff", ["src/a.ts"], true, logDir, "auto-approved", {
      review: review("SHIP"),
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewGate: gate(),
    });
    const stored = await loadJudgeApproval("TASK-9202", logDir);
    expect(stored?.override).toBeUndefined();
  });

  it("a blueprint auto-approval past a decomposition recommendation is recorded", async () => {
    const logDir = await makeLogDir();
    await saveBlueprintApproval("TASK-9203", blueprint, preflight(true), logDir, "auto-approved");
    const stored = await loadApproval("TASK-9203", logDir);
    expect(stored?.override?.actor).toBe("auto_policy");
    expect(stored?.override?.advisories[0]).toContain("decompos");
  });

  it("a PENDING save records nothing, whatever the advice says", async () => {
    // The gate that has not been decided yet is not an override of
    // anything. Recording one here would put a decision in the audit
    // trail before anybody made it.
    const logDir = await makeLogDir();
    await saveJudgeApproval("TASK-9204", "diff", ["src/a.ts"], false, logDir, "pending", {
      review: review("FIX_FIRST"),
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewGate: gate(),
    });
    const stored = await loadJudgeApproval("TASK-9204", logDir);
    expect(stored?.override).toBeUndefined();
  });
});

describe("round-2 R2-3: a caller's own actor label survives detection", () => {
  it("the legacy positional approvedBy is not replaced by 'unattributed'", async () => {
    // Options used to be passed only when a `decision` object existed,
    // so a caller using the legacy positional argument (the dispatcher's
    // timeout path) had its KNOWN label discarded the moment an override
    // was detected. Replacing a real attribution with "unattributed" is
    // strictly worse than the attribution it had.
    const logDir = await makeLogDir();
    await saveJudgeApproval("TASK-9301", "diff", ["src/a.ts"], false, logDir, "pending", {
      review: review("FIX_FIRST"),
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewGate: gate(),
    });

    await updateJudgeApprovalState("TASK-9301", "approved", logDir, "approval-timeout");

    const after = await loadJudgeApproval("TASK-9301", logDir);
    expect(after?.approvedBy).toBe("approval-timeout");
    expect(after?.override?.actor).toBe("approval-timeout");
    expect(after?.override?.actor).not.toBe("unattributed");
  });
});

describe("round-2b: a direct write is labelled honestly, not as automation", () => {
  it("a direct APPROVED save is not attributed to auto_policy", async () => {
    // Introduced by my own R2-1 widening and caught by the confirmation
    // pass: routing `approved` through the auto-approval builder stamped
    // it `auto_policy` with "auto-approved by policy", which is a FALSE
    // audit record. No policy made that call. Getting the attribution
    // wrong is worse than the silence the guard exists to end.
    const logDir = await makeLogDir();
    await saveJudgeApproval("TASK-9401", "diff", ["src/a.ts"], false, logDir, "approved", {
      review: review("SHIP"),
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewGate: gate(),
    });

    const stored = await loadJudgeApproval("TASK-9401", logDir);
    expect(stored?.override?.actor).toBe("unattributed");
    expect(stored?.override?.actor).not.toBe("auto_policy");
    expect(stored?.override?.reason).toMatch(/bypassed the decision boundary/);
    // Still RECORDED, so R2-1 stays closed.
    expect(stored?.override?.advisories).toContain("verification did not pass");
  });

  it("an AUTO-APPROVED save is still attributed to the policy", async () => {
    const logDir = await makeLogDir();
    await saveJudgeApproval("TASK-9402", "diff", ["src/a.ts"], false, logDir, "auto-approved", {
      review: review("SHIP"),
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewGate: gate(),
    });
    const stored = await loadJudgeApproval("TASK-9402", logDir);
    expect(stored?.override?.actor).toBe("auto_policy");
  });
});
