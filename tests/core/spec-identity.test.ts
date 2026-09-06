import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  compareSpecIdentity,
  compareResolvedSpecIdentity,
  computeAuditHash,
  detectInHandDivergence,
  inHandDivergenceMessage,
  mayConsume,
  recoveryAdviceFor,
  computeContractHash,
  computeSpecIdentity,
  extractContract,
  resolveCurrentSpecIdentity,
  findSpecFile,
  foundSpecIdentity,
  isContestedSpecIdentity,
  StaleSpecIdentityError,
  type SpecIdentity,
  type SpecIdentityVerdict,
} from "../../src/core/spec-identity.js";
import { computeContentHash } from "../../src/monitor/prep-cache.js";
import { resolveTaskFile, resolveTaskFilePath } from "../../src/core/task-file-resolver.js";

const SPEC = [
  "# TASK-1332: a title",
  "",
  "## Metadata",
  "- **Status:** BACKLOG",
  "- **Priority:** P1-HIGH",
  "",
  "## Intent",
  "Do the thing.",
  "",
].join("\n");

const CLAIMANT_SPEC = [
  "# TASK-1332: claimant fixture",
  "",
  "## Metadata",
  "- **Priority:** P2-MEDIUM",
  "- **Effort:** SMALL",
  "- **Status:** READY",
  "- **Blocked By:** []",
  "- **Blocks:** []",
  "- **Tags:** fixture",
  "",
  "## Problem Statement",
  "Exercise declared ownership.",
  "",
  "## Success Criteria",
  "- [ ] Ownership resolves",
  "",
  "## Testing Requirements",
  "- [ ] Real files",
].join("\n");

function withStatus(status: string): string {
  return SPEC.replace(/(\*\*Status:\*\*\s*)\w+/, `$1${status}`);
}

describe("spec identity: the audit hash", () => {
  it("is byte-identical to the prep cache's content hash, so the two cannot drift apart", () => {
    // The audit hash exists to be comparable against the prep/preflight
    // caches. If this ever fails, one of the two moved and the
    // comparison silently stops meaning anything.
    expect(computeAuditHash(SPEC)).toBe(computeContentHash(SPEC));
  });

  it("moves when any byte moves, including the Status line", () => {
    expect(computeAuditHash(withStatus("IN_PROGRESS"))).not.toBe(computeAuditHash(SPEC));
  });
});

describe("spec identity: the contract hash ignores operational metadata", () => {
  // This is the R1-2 bypass. Every writer below rewrites ONLY the
  // Status line, and every one of them must be unable to change a
  // validity verdict.
  it.each([
    ["lifecycle-manager / reconciler", "IN_PROGRESS"],
    ["POST /api/tasks/:id/reject", "REJECTED"],
    ["record-on-merge advancing to COMPLETE", "COMPLETE"],
    ["watcher normalization", "READY"],
  ])("a Status-only rewrite by %s does not move the contract hash", (_writer, status) => {
    expect(computeContractHash(withStatus(status))).toBe(computeContractHash(SPEC));
  });

  it("moves when the actual contract changes", () => {
    const amended = SPEC.replace("Do the thing.", "Do a materially different thing.");
    expect(computeContractHash(amended)).not.toBe(computeContractHash(SPEC));
  });

  it("tolerates the bold-bullet and bare Status shapes the parser accepts", () => {
    const bare = SPEC.replace("- **Status:** BACKLOG", "**Status:** BACKLOG");
    // Both shapes are stripped, so the surviving contract is identical.
    expect(extractContract(bare)).toBe(extractContract(SPEC));
  });

  it("normalizes trailing whitespace but NOT interior structure", () => {
    const trailing = SPEC.replace("Do the thing.", "Do the thing.   ");
    expect(computeContractHash(trailing)).toBe(computeContractHash(SPEC));

    const restructured = SPEC.replace("## Intent\nDo the thing.", "## Intent\n\nDo the thing.");
    expect(computeContractHash(restructured)).not.toBe(computeContractHash(SPEC));
  });

  it("is CRLF-insensitive, because the writers round-trip line endings", () => {
    expect(computeContractHash(SPEC.replace(/\n/g, "\r\n"))).toBe(computeContractHash(SPEC));
  });

  it("does not strip a line that merely mentions status in prose", () => {
    const prose = SPEC.replace(
      "Do the thing.",
      "The **Status:** field is discussed here as prose.",
    );
    // A human wrote this into the body; it is contract, not bookkeeping.
    // Guard against a pattern loose enough to swallow real content.
    expect(computeContractHash(prose)).not.toBe(computeContractHash(SPEC));
  });
});

describe("spec identity: comparison is three-state", () => {
  const stored = computeSpecIdentity(SPEC);

  it("reports match for an identical spec", () => {
    expect(compareSpecIdentity(stored, computeSpecIdentity(SPEC)).verdict).toBe("match");
  });

  it("reports match, flagged operational-only, when just the Status moved", () => {
    const out = compareSpecIdentity(stored, computeSpecIdentity(withStatus("IN_PROGRESS")));
    expect(out.verdict).toBe("match");
    expect(out.operationalOnlyChange).toBe(true);
    expect(out.reason).toContain("only operational metadata");
  });

  it("reports stale when the contract moved", () => {
    const amended = SPEC.replace("Do the thing.", "Do something else entirely.");
    const out = compareSpecIdentity(stored, computeSpecIdentity(amended));
    expect(out.verdict).toBe("stale");
    expect(out.reason).toContain("contract has changed");
  });

  it("reports unknown_legacy for a pre-1332 record, never stale", () => {
    // Treating an unstamped record as stale would strand every pend
    // that exists on the deploy shipping this.
    const out = compareSpecIdentity(undefined, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("unknown_legacy");
    expect(mayConsume(out.verdict)).toBe(true);
  });

  it("reports UNVERIFIABLE, not unknown, when a STAMPED record's current spec cannot be read", () => {
    // Round 2 R2-1. The first cut collapsed this into the legacy case and
    // PROCEEDED, so deleting or renaming the owner spec admitted the
    // worktree's stale brief. A record that claims an identity and cannot
    // be checked is not the same as one that never claimed one.
    const out = compareSpecIdentity(stored, undefined);
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  it("reports UNVERIFIABLE for a structurally malformed stored identity", () => {
    // Round 2 R2-4: `{contractHash: 1}` parses. The first cut called
    // .slice on it, threw inside a catch that fell through to
    // regenerating the brief, and the old `approved` state then applied
    // to the NEW artifact.
    const malformed = { contractHash: 1, auditHash: "x" } as unknown as SpecIdentity;
    const out = compareSpecIdentity(malformed, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  it("reports DIVERGED when the artifact was built from a spec other than the stamped one", () => {
    // Round 2 R2-2, the laundering case. A dispatch worktree cut before
    // an amendment builds from v1 while the owner is already v2; stamping
    // the owner's hash would certify the stale brief as current.
    const diverged = computeSpecIdentity(SPEC, {
      effectiveSpecContent: SPEC.replace("Do the thing.", "An OLDER contract."),
    });
    const out = compareSpecIdentity(diverged, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("diverged");
    expect(mayConsume(out.verdict)).toBe(false);
    expect(out.reason).toContain("not the authoritative one");
  });

  it("does NOT report diverged when the artifact was built from the authoritative spec", () => {
    const aligned = computeSpecIdentity(SPEC, { effectiveSpecContent: SPEC });
    expect(compareSpecIdentity(aligned, computeSpecIdentity(SPEC)).verdict).toBe("match");
  });
});

describe("spec identity: the contract exclusion is SCOPED, not shape-matched (R2-3)", () => {
  it("does NOT strip a status-shaped line outside the Metadata section", () => {
    // The dangerous direction: a human making a material change on a line
    // that merely LOOKS like the metadata field would read as "match".
    const withCriterion = SPEC.replace(
      "Do the thing.",
      [
        "Do the thing.",
        "",
        "## Success Criteria",
        "- **Status:** must be reported as COMPLETE by the API",
      ].join("\n"),
    );
    const amended = withCriterion.replace(
      "must be reported as COMPLETE by the API",
      "must be reported as VERIFIED by the API",
    );
    expect(computeContractHash(amended)).not.toBe(computeContractHash(withCriterion));
  });

  it("does NOT strip a status-shaped line inside a fenced code block", () => {
    const FENCE = "```";
    const withFence = SPEC.replace(
      "Do the thing.",
      ["Do the thing.", "", `${FENCE}md`, "- **Status:** BACKLOG", FENCE].join("\n"),
    );
    const amended = withFence.replace(
      `- **Status:** BACKLOG\n${FENCE}`,
      `- **Status:** COMPLETE\n${FENCE}`,
    );
    expect(computeContractHash(amended)).not.toBe(computeContractHash(withFence));
  });

  it("DOES strip the normalizer's operational fields, which would otherwise force a false stale", () => {
    // R2-3's other direction: watcher normalization adds these, and
    // missing them made every normalized spec read as amended.
    const normalized = SPEC.replace(
      "- **Status:** BACKLOG",
      [
        "- **Status:** BACKLOG",
        "- **Status-Note:** normalized from `Backlog`",
        "- **Repaired:** 2026-08-14",
      ].join("\n"),
    );
    expect(computeContractHash(normalized)).toBe(computeContractHash(SPEC));
  });
});

describe("spec identity: resolving the CURRENT spec from disk", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-spec-identity-"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-1332.md"), SPEC, "utf-8");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the spec and stamps a relative path", () => {
    const identity = resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-1332");
    expect(identity?.contractHash).toBe(computeContractHash(SPEC));
    expect(identity?.taskSpecRelativePath).toBe("docs/tasks/TASK-1332.md");
  });

  it("finds a suffixed spec file, matching the lifecycle finder", () => {
    fs.rmSync(path.join(root, "docs", "tasks", "TASK-1332.md"));
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-1332-some-slug.md"), SPEC, "utf-8");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-1332")?.contractHash).toBe(
      computeContractHash(SPEC),
    );
  });

  it("returns undefined (UNKNOWN) rather than throwing when the spec is missing", () => {
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-9999")).toBeUndefined();
  });

  it("returns explicit found, duplicate, and not-found file-resolution arms", () => {
    const taskDir = path.join(root, "docs", "tasks");
    expect(findSpecFile(taskDir, "TASK-1332")).toEqual({
      status: "found",
      filePath: path.join(taskDir, "TASK-1332.md"),
    });

    fs.writeFileSync(path.join(taskDir, "TASK-1332.md"), CLAIMANT_SPEC, "utf-8");
    fs.writeFileSync(path.join(taskDir, "TASK-999-cross.md"), CLAIMANT_SPEC, "utf-8");
    expect(findSpecFile(taskDir, "TASK-1332")).toEqual({
      status: "duplicate",
      claimants: ["TASK-1332.md", "TASK-999-cross.md"],
    });
    expect(findSpecFile(taskDir, "TASK-404")).toEqual({ status: "not-found" });
  });

  it("maps a duplicate to a named contested verdict without using the unreadable catch path", () => {
    const taskDir = path.join(root, "docs", "tasks");
    fs.writeFileSync(path.join(taskDir, "TASK-1332.md"), CLAIMANT_SPEC, "utf-8");
    fs.writeFileSync(path.join(taskDir, "TASK-999-cross.md"), CLAIMANT_SPEC, "utf-8");

    const resolution = resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-1332");
    expect(resolution).toMatchObject({
      verdict: "contested",
      claimants: ["TASK-1332.md", "TASK-999-cross.md"],
    });
    expect(isContestedSpecIdentity(resolution)).toBe(true);
    if (isContestedSpecIdentity(resolution)) {
      expect(resolution.reason).toContain("contested id");
    }
    expect(foundSpecIdentity(resolution)).toBeUndefined();
  });

  it("keeps no-spec and contested-id outcomes distinct at resolution and comparison", () => {
    const taskDir = path.join(root, "docs", "tasks");
    fs.writeFileSync(path.join(taskDir, "TASK-1332.md"), CLAIMANT_SPEC, "utf-8");
    fs.writeFileSync(path.join(taskDir, "TASK-999-cross.md"), CLAIMANT_SPEC, "utf-8");
    const contested = resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-1332");
    const missing = resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-404");

    expect(isContestedSpecIdentity(contested)).toBe(true);
    expect(missing).toBeUndefined();
    expect(compareResolvedSpecIdentity(computeSpecIdentity(SPEC), contested).verdict).toBe(
      "contested",
    );
    expect(compareResolvedSpecIdentity(computeSpecIdentity(SPEC), missing).verdict).toBe(
      "unverifiable",
    );
  });

  it("returns undefined rather than throwing when the task dir does not exist", () => {
    expect(resolveCurrentSpecIdentity(root, "nope/tasks", "TASK-1332")).toBeUndefined();
  });

  it("reads the OWNING clone, not a dispatch worktree cut before the amendment", () => {
    // R1-1, the headline. The worktree carries the PRE-amendment spec and
    // the owning clone carries the amendment. Hashing the worktree copy
    // (which is what task.rawContent gives a resumed run) would compare a
    // stale brief against a stale spec and wrongly report "match".
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(root, ".quack", "quack.db"), "", "utf-8");

    const amended = SPEC.replace("Do the thing.", "AMENDED: do the thing correctly.");
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-1332.md"), amended, "utf-8");

    const worktree = path.join(root, ".quack", "worktrees", "TASK-1332");
    fs.mkdirSync(path.join(worktree, "docs", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "docs", "tasks", "TASK-1332.md"), SPEC, "utf-8");

    const fromWorktree = resolveCurrentSpecIdentity(worktree, "docs/tasks", "TASK-1332");
    expect(fromWorktree?.contractHash).toBe(computeContractHash(amended));
    expect(fromWorktree?.contractHash).not.toBe(computeContractHash(SPEC));
  });
});

describe("spec identity: contested verdict completeness and recovery", () => {
  it("keeps the verdict inventory exhaustive", () => {
    const verdicts: Record<SpecIdentityVerdict, true> = {
      match: true,
      stale: true,
      unknown_legacy: true,
      unverifiable: true,
      diverged: true,
      contested: true,
    };
    expect(Object.keys(verdicts).sort()).toEqual([
      "contested",
      "diverged",
      "match",
      "stale",
      "unknown_legacy",
      "unverifiable",
    ]);
  });

  it("tells the operator to remove or rename extra claimant files", () => {
    const advice = recoveryAdviceFor("contested");
    expect(advice).toMatch(/remove|rename/i);
    expect(advice).toContain("claimant");
    expect(advice).not.toContain("Replan the task");
  });
});

describe("spec identity: the refusal", () => {
  it("names the reason and says nothing was destroyed", () => {
    const stored = computeSpecIdentity(SPEC);
    const current = computeSpecIdentity(SPEC.replace("Do the thing.", "Do another thing."));
    const err = new StaleSpecIdentityError(
      "TASK-1332",
      "resume",
      compareSpecIdentity(stored, current),
    );

    expect(err.message).toContain("TASK-1332");
    expect(err.message).toContain("contract has changed");
    // The operator must be able to tell a refusal from a deletion, and
    // must be told the way out. TASK-1326 is the reason.
    expect(err.message).toContain("Nothing has been deleted or rejected");
    expect(err.message).toContain("replan");
  });
});

describe("spec identity: in-hand divergence, caught BEFORE the spend (R3-2)", () => {
  it("is silent when the in-hand spec IS the authoritative one", () => {
    expect(detectInHandDivergence(SPEC, computeSpecIdentity(SPEC))).toBeNull();
  });

  it("is silent when there is no readable authority, because UNKNOWN never blocks", () => {
    expect(detectInHandDivergence(SPEC, undefined)).toBeNull();
  });

  it("is silent when only the Status line differs, so bookkeeping cannot block a dispatch", () => {
    // Same guarantee as the R1-2 bypass fix, one layer earlier: the reconciler
    // must not be able to stop work starting.
    expect(detectInHandDivergence(withStatus("IN_PROGRESS"), computeSpecIdentity(SPEC))).toBeNull();
  });

  it("fires when the in-hand contract differs from authority", () => {
    const authoritative = computeSpecIdentity(SPEC.replace("Do the thing.", "AMENDED contract."));
    const out = detectInHandDivergence(SPEC, authoritative);
    expect(out).not.toBeNull();
    expect(out!.inHandContractHash).toBe(computeContractHash(SPEC));
    expect(out!.authoritativeContractHash).toBe(authoritative.contractHash);
  });

  it("the message names the cause, the file, and what was NOT destroyed", () => {
    const authoritative = computeSpecIdentity(SPEC.replace("Do the thing.", "AMENDED contract."));
    const out = detectInHandDivergence(SPEC, authoritative)!;
    const msg = inHandDivergenceMessage("TASK-1332", out, {
      taskSpecRelativePath: "docs/tasks/x.md",
    });

    // The whole point of R3-2: name the real cause, which is a spec that
    // has not reached the base branch the worktree is cut from.
    expect(msg).toContain("PUSH the amended spec");
    expect(msg).toContain("docs/tasks/x.md");
    expect(msg).toContain("Nothing has been deleted");
    // Round 6 (R6-1): this test used to assert "Replan will NOT clear
    // this", which round 5 made false and unsafe. The recovery half of
    // the message is now asserted against the single advice source in
    // the R6-1 test below rather than restated here, so the two cannot
    // drift apart again, which is exactly how they drifted.
  });
});

describe("spec identity: recovery advice follows the VERDICT (R4-1)", () => {
  it("tells a DIVERGED run to push FIRST, clear the open approval, then dispatch fresh", () => {
    // Round 4 established the push and the fresh dispatch, and banned
    // resume: resume reopens the same preserved worktree, so it reproduces
    // the refusal.
    //
    // **Round 5 REVERSED the replan half of that.** Round 4 said "Do NOT
    // replan" on the reasoning that replan reproduces the refusal. It does
    // if it is followed by a RESUME, but the sequence being recommended
    // ends in a FRESH dispatch, and a fresh dispatch with the old approval
    // record still live consumes that record for a brand-new brief (R5-1).
    // So the advice terminated the loop by BYPASSING the human gate. The
    // ordering is what makes it safe: push, then clear, then dispatch.
    const advice = recoveryAdviceFor("diverged");
    expect(advice).toContain("PUSH");
    expect(advice).toContain("FRESH dispatch");
    expect(advice).toContain("REPLAN to clear it");
    expect(advice).toContain("Do NOT resume");
    // The ordering is load-bearing, not incidental: replanning before
    // pushing rebuilds from the same unamended base and refuses again.
    expect(advice.indexOf("PUSH")).toBeLessThan(advice.indexOf("REPLAN to clear it"));
    expect(advice.indexOf("REPLAN to clear it")).toBeLessThan(advice.indexOf("FRESH dispatch"));
    expect(advice).toContain("Replanning before pushing will also reproduce it");
  });

  it("the PRE-GATE message carries the same advice, not its own older copy (R6-1)", () => {
    // Round 6's HIGH. This message was written in round 3 with its own
    // embedded advice, "push, then dispatch" plus "Replan will NOT clear
    // this", and was never revisited when round 5 reversed the replan
    // half. An operator following it pushed and dispatched fresh WITHOUT
    // clearing an open approval, which is the R5-1 bypass; and for a
    // pre-1332 record, which is `unknown_legacy` by design, the reuse
    // check permits it, so the new brief skips the gate entirely.
    const msg = inHandDivergenceMessage(
      "TASK-1",
      { authoritativeContractHash: "a".repeat(64), inHandContractHash: "b".repeat(64) },
      { taskSpecRelativePath: "docs/tasks/x.md" },
    );
    expect(msg).toContain(recoveryAdviceFor("diverged"));
    // The two retired instructions, named so a revert is caught.
    expect(msg).not.toContain("Replan will NOT clear this");
    expect(msg).not.toMatch(/base branch, then dispatch/);
  });

  it("tells a STALE run to replan, which is the correct cure there", () => {
    const advice = recoveryAdviceFor("stale");
    expect(advice).toContain("Replan");
    expect(advice).not.toContain("PUSH the amended spec");
  });

  it("the typed refusal carries the verdict-appropriate advice, not a fixed string", () => {
    const staleMsg = new StaleSpecIdentityError("TASK-1", "resume", {
      verdict: "stale",
      reason: "r",
    }).message;
    const divergedMsg = new StaleSpecIdentityError("TASK-1", "resume", {
      verdict: "diverged",
      reason: "r",
    }).message;

    expect(staleMsg).toContain("Replan");
    expect(divergedMsg).toContain("PUSH");
    expect(divergedMsg).not.toMatch(/Replan the task/);
  });
});

describe("spec identity: the authority lookup uses the CANONICAL resolver (R4-3)", () => {
  let root: string;

  /**
   * Round 7 (R7-4): a spec the real parser ACCEPTS.
   *
   * The round-6 fixture omitted the sections `parseTaskFile` requires, so
   * every candidate failed to parse and the tests could only ever reach
   * the raw-filename fallback, which is precisely the half that was
   * already correct. The parsed-first phase, where R7-1 lived, was
   * unreachable from the suite that was supposed to cover it.
   */
  const specFor = (id: string, body = `${id} body`) =>
    [
      `# ${id}: fixture`,
      "",
      "## Metadata",
      "- **Priority:** P2-MEDIUM",
      "- **Effort:** 1-2 hours",
      "- **Status:** READY",
      "- **Blocked By:** []",
      "- **Blocks:** []",
      "- **Tags:** fixture",
      "",
      "## Problem Statement",
      "",
      body,
      "",
      "## Success Criteria",
      "- [ ] It resolves",
      "",
      "## Testing Requirements",
      "- [ ] None (fixture)",
      "",
    ].join("\n");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-resolver-"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("does NOT mistake TASK-1000 for TASK-100", () => {
    // A naive startsWith picks TASK-1000 for TASK-100 and compares the run
    // against a DIFFERENT task's contract, falsely refusing a legitimate
    // dispatch. That is the false-refusal class that makes a gate untrustworthy.
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-1000-other.md"),
      specFor("TASK-1000"),
      "utf-8",
    );
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")).toBeUndefined();
  });

  it("does NOT mistake a subtask for its parent", () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")).toBeUndefined();
  });

  it("still finds the real parent when it is present alongside both", () => {
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-1000-other.md"),
      specFor("TASK-1000"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    const parent = specFor("TASK-100");
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100-parent.md"), parent, "utf-8");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.contractHash).toBe(
      computeContractHash(parent),
    );
  });

  /**
   * Round 7 (R7-4): PARITY, asserted directly against the dispatcher's own
   * resolver rather than against a filename this test believes it will
   * choose. Every earlier version of these tests encoded an expectation
   * about which file should win, which is exactly how the two resolvers
   * drifted apart twice without a test noticing.
   */
  async function expectResolversAgree(taskId: string): Promise<void> {
    const taskDir = path.join(root, "docs", "tasks");
    const dispatcherChoice = await resolveTaskFile(taskDir, taskId);
    const identity = resolveCurrentSpecIdentity(root, "docs/tasks", taskId);
    expect(identity?.taskSpecRelativePath).toBeDefined();
    expect(path.resolve(root, identity!.taskSpecRelativePath!)).toBe(
      path.resolve(dispatcherChoice!.filePath),
    );
  }

  it("agrees with the canonical resolver when a descriptive file names ANOTHER task (R7-1)", async () => {
    // The round-7 finding, reproduced. `resolveTaskFile` PARSES candidates
    // and matches `task.id`, so it rejects a descriptive file whose H1
    // names a different task and loads the exact one. Round 6 reached for
    // the raw filename picker alone, only the fallback half, accepted
    // the descriptive file, hashed it, and reported a false `diverged` on
    // a perfectly correct run.
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100.md"), specFor("TASK-100"), "utf-8");
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-parent.md"),
      specFor("TASK-999", "belongs to a different task entirely"),
      "utf-8",
    );
    await expectResolversAgree("TASK-100");
    // And concretely: the exact file, not the misnamed descriptive one.
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.taskSpecRelativePath).toBe(
      "docs/tasks/TASK-100.md",
    );
  });

  it("agrees with the canonical resolver for a SUBTASK id (R7-1)", async () => {
    // The canonical parser accepts `TASK-100-A-B-child.md` as `TASK-100-A`
    // when its H1 says so, while the filename rule reads the `-B` as a
    // child suffix and declines. The dispatcher loaded it; identity
    // returned UNKNOWN. Parsed-first makes them agree.
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-B-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    await expectResolversAgree("TASK-100-A");
  });

  it("agrees with the canonical resolver on an ordinary descriptive parent", async () => {
    // The control. The parity helper must not pass merely because both
    // sides return undefined, so this asserts a real resolution too.
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-parent.md"),
      specFor("TASK-100"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    await expectResolversAgree("TASK-100");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.taskSpecRelativePath).toBe(
      "docs/tasks/TASK-100-parent.md",
    );
  });

  it("declines when the exact name is a DIRECTORY, rather than refusing on a read error (R6-3)", () => {
    // `readdirSync` returns directories too. A directory named
    // `TASK-100.md` used to win the shortcut, fail to read, and, under
    // the R5-3 version boundary, turn a resolvable task into
    // `unverifiable`, i.e. a refusal caused by a stray directory.
    fs.mkdirSync(path.join(root, "docs", "tasks", "TASK-100.md"));
    const parent = specFor("TASK-100");
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100-parent.md"), parent, "utf-8");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.contractHash).toBe(
      computeContractHash(parent),
    );
  });

  it("finds an EXACT-named parent alongside a subtask, whatever the directory order (R5-4)", () => {
    // Round 5. The raw picker's parent scan only considers names starting
    // `TASK-100-`, so with an exact `TASK-100.md` alongside
    // `TASK-100-A-child.md` its fallback can return the subtask; the
    // parent guard then declines it and the whole check silently disabled
    // itself with the parent sitting right there.
    //
    // Round 7 (R7-4): the round-5 version claimed writing the subtask
    // first CONTROLLED `readdir` order. It does not, if the filesystem
    // yields the exact file first the picker takes it directly and the
    // rescue is never exercised. Candidates are sorted now, and this
    // additionally asserts PARITY, which holds either way.
    const parent = specFor("TASK-100");
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100.md"), parent, "utf-8");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.contractHash).toBe(
      computeContractHash(parent),
    );
  });

  it("is deliberately STRICTER than the dispatcher in the RAW fallback", () => {
    // When nothing parses, `resolveTaskFile` ends at
    // `pickBestRawTaskFileCandidate(...) ?? candidates[0]`, a loose prefix
    // match that can return the SUBTASK for a parent id. This function
    // feeds a REFUSAL, so it declines the subtask and rescues the exact
    // parent instead.
    //
    // **Round 8 corrected the RATIONALE recorded here.** Round 7 said the
    // looseness was fine on the dispatcher side "because it verifies the
    // parsed id downstream". It did not, `loadTaskWithPath` checked only
    // that a task parsed, so `TASK-100` could execute `TASK-100-A`'s
    // contract. The looseness is now bounded at BOTH ends (R8-1); this
    // function staying stricter is what it always was, but it is no
    // longer resting on a downstream guard that did not exist.
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      "not a spec",
      "utf-8",
    );
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100.md"), "also not a spec", "utf-8");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.taskSpecRelativePath).toBe(
      "docs/tasks/TASK-100.md",
    );
  });

  it("does not let the raw fallback certify a DIFFERENT task as this one (R8-1)", async () => {
    // Round 8's HIGH, executed. Only a valid child spec exists. Parsed
    // first rejects it (its H1 is TASK-100-A), the loose raw fallback
    // selects it anyway, it parses fine, and the old code handed it back
    // as TASK-100, so a dispatch of TASK-100 would have run TASK-100-A's
    // contract. The right spec, executed under the wrong id, which is
    // worse than the staleness this whole task exists to prevent.
    fs.writeFileSync(
      path.join(root, "docs", "tasks", "TASK-100-A-child.md"),
      specFor("TASK-100-A"),
      "utf-8",
    );
    // Round 9 (R9-1): the wrong file is excluded ENTIRELY, not just from
    // the `task` field. Round 8 nulled the task and still returned the
    // child's `filePath`, which `resolveTaskFilePath` hands to routes that
    // then REWRITE that file under the requested id, the enrichment
    // candidate route can atomically replace it and commit it as
    // TASK-100. Fixing one accessor and not the other is this series'
    // recurring mechanism; the classification removes the file from
    // consideration so no accessor can leak it.
    const taskDir = path.join(root, "docs", "tasks");
    expect(await resolveTaskFile(taskDir, "TASK-100")).toBeNull();
    expect(await resolveTaskFilePath(taskDir, "TASK-100")).toBeNull();
    // And identity declines it too, so the two agree on refusing.
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")).toBeUndefined();
  });

  it("still serves an UNPARSEABLE PARENT to the raw fallback (R9-1 control)", async () => {
    // The control that keeps the exclusion honest: only a CLEAN parse
    // naming another task is foreign. A PARENT-named spec that does not
    // parse at all is exactly what the raw fallback exists for and must
    // still be returned, or the fix breaks every parse-error path.
    const taskDir = path.join(root, "docs", "tasks");
    fs.writeFileSync(path.join(taskDir, "TASK-100-broken.md"), "not a spec at all", "utf-8");
    const resolved = await resolveTaskFile(taskDir, "TASK-100");
    expect(resolved?.fileName).toBe("TASK-100-broken.md");
    expect(resolved?.task).toBeNull();
    expect(await resolveTaskFilePath(taskDir, "TASK-100")).toContain("TASK-100-broken.md");
  });

  it("resolves the DESCRIPTIVE spec even when a bare TASK-NNN.md competes (R10-2 boundary)", async () => {
    // Round 11 named this as the one coverage gap in the round-10 fold.
    // The dispatcher's readiness-cache hash used to read a reconstructed
    // `${taskId}.md`; it now reads the path the run actually resolved. The
    // two differ exactly when a bare `TASK-100.md` sits beside the real
    // descriptive spec, so this pins WHICH file that is: the one whose H1
    // declares the task, chosen parsed-first, not the one whose filename
    // happens to match a template.
    const taskDir = path.join(root, "docs", "tasks");
    const real = specFor("TASK-100", "the actual contract");
    fs.writeFileSync(path.join(taskDir, "TASK-100-parent.md"), real, "utf-8");
    fs.writeFileSync(
      path.join(taskDir, "TASK-100.md"),
      specFor("TASK-999", "a stray file"),
      "utf-8",
    );

    const resolved = await resolveTaskFile(taskDir, "TASK-100");
    expect(resolved?.fileName).toBe("TASK-100-parent.md");
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")?.contractHash).toBe(
      computeContractHash(real),
    );
  });

  it("does NOT serve an unparseable CHILD as its parent (R10-1)", async () => {
    // Round 10's HIGH, and the gap round 9 left. Excluding foreign parses
    // was not enough: an UNPARSEABLE child is not foreign, it is exactly
    // what the raw fallback exists for, so `TASK-100` still resolved to
    // `TASK-100-A-child.md`. `taskExists` then read that as proof the
    // parent exists, permitting an on-merge SOFT-VERIFIED record for a
    // task with no spec at all.
    const taskDir = path.join(root, "docs", "tasks");
    fs.writeFileSync(path.join(taskDir, "TASK-100-A-child.md"), "not a spec at all", "utf-8");
    expect(await resolveTaskFile(taskDir, "TASK-100")).toBeNull();
    expect(await resolveTaskFilePath(taskDir, "TASK-100")).toBeNull();
    expect(resolveCurrentSpecIdentity(root, "docs/tasks", "TASK-100")).toBeUndefined();
    // The child itself still resolves for ITS own id, so this narrows the
    // fallback rather than breaking subtask resolution.
    expect(await resolveTaskFilePath(taskDir, "TASK-100-A")).toContain("TASK-100-A-child.md");
  });
});

describe("spec identity: enrichment is a DERIVATION, not source divergence (R5-2)", () => {
  const ENRICHED = SPEC.replace("Do the thing.", "Do the thing, with much more detail.");

  it("does not report diverged when the brief was built from ENRICHED content", () => {
    // Round 5's sharpest false-refusal. Readiness enrichment replaces the
    // task in memory, so passing the post-enrichment content as the
    // in-hand SOURCE made every enriched dispatch stamp a record whose
    // effective hash differed from its contract hash by construction.
    // Every later consumption then refused as `diverged`, and the advice
    // told the operator to push an amendment nobody had made.
    const stamped = computeSpecIdentity(SPEC, {
      effectiveSpecContent: SPEC, // the SOURCE the run had in hand
      enrichedSpecContent: ENRICHED, // what the brief was built from
    });
    const verdict = compareSpecIdentity(stamped, computeSpecIdentity(SPEC));
    expect(verdict.verdict).toBe("match");
    expect(mayConsume(verdict.verdict)).toBe(true);
  });

  it("records what the brief was actually built from, without letting it decide", () => {
    const stamped = computeSpecIdentity(SPEC, {
      effectiveSpecContent: SPEC,
      enrichedSpecContent: ENRICHED,
    });
    // Present and correct...
    expect(stamped.enrichedContractHash).toBe(computeContractHash(ENRICHED));
    expect(stamped.enrichedContractHash).not.toBe(stamped.contractHash);
    // ...and inert. Mutating it alone cannot move any verdict.
    const tampered: SpecIdentity = { ...stamped, enrichedContractHash: "0".repeat(64) };
    expect(compareSpecIdentity(tampered, computeSpecIdentity(SPEC)).verdict).toBe("match");
    // Round 6 (R6-4): inert even when MALFORMED, which is the case the
    // round-5 test missed by only ever substituting another valid string.
    // Round 5 had added the field to the shape check for symmetry, so a
    // corrupt audit value produced `unverifiable` and REFUSED, audit
    // metadata deciding a consumption, which is precisely what the field
    // is documented not to do.
    const corrupt = { ...stamped, enrichedContractHash: 42 } as unknown as SpecIdentity;
    expect(compareSpecIdentity(corrupt, computeSpecIdentity(SPEC)).verdict).toBe("match");
    // Round 7 (R7-3): and the SAME must hold for `auditHash`, the other
    // field documented as never deciding validity. Round 6 retired one
    // audit-only producer and left this one, so `auditHash: 42` still
    // produced `unverifiable`, a refusal, while
    // `enrichedContractHash: 42` produced `match`.
    const corruptAudit = { ...stamped, auditHash: 42 } as unknown as SpecIdentity;
    expect(compareSpecIdentity(corruptAudit, computeSpecIdentity(SPEC)).verdict).toBe("match");
  });

  it("still catches REAL source divergence, which is what the field is for", () => {
    // The control: enrichment being exonerated must not exonerate a run
    // that genuinely read the wrong source (owner v2, worktree v1).
    const worktreeV1 = SPEC;
    const ownerV2 = SPEC.replace("Do the thing.", "Do a DIFFERENT thing.");
    const stamped = computeSpecIdentity(ownerV2, {
      effectiveSpecContent: worktreeV1,
      enrichedSpecContent: ENRICHED,
    });
    expect(compareSpecIdentity(stamped, computeSpecIdentity(ownerV2)).verdict).toBe("diverged");
  });
});

describe("spec identity: the record-version boundary (R5-3)", () => {
  it("grandfathers a record with NO version and no identity", () => {
    const out = compareSpecIdentity(undefined, computeSpecIdentity(SPEC), {});
    expect(out.verdict).toBe("unknown_legacy");
    expect(mayConsume(out.verdict)).toBe(true);
  });

  it("REFUSES a record written today whose identity could not be resolved", () => {
    // The fail-open round 5 found: `unknown_legacy` was inferred purely
    // from a missing field, so a record written NOW by code that tried
    // and failed to read the authoritative spec was grandfathered exactly
    // like a pre-TASK-1332 record. The version says which it is.
    const out = compareSpecIdentity(undefined, computeSpecIdentity(SPEC), {
      specIdentityVersion: 1,
    });
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  it("REFUSES a malformed identity OBJECT that carries no contract hash (R8-3)", () => {
    // Round 7 removed `auditHash` from claim detection alongside removing
    // it from `wellFormed`, and that went one step too far: an unversioned
    // record carrying `{ auditHash }` and no `contractHash` stopped
    // counting as a claim at all, so it became `unknown_legacy` and
    // `mayConsume` let it through. A malformed identity object is not the
    // same as no identity object, the R2-1 distinction, reintroduced
    // through claim detection after being fixed in the verdict.
    const malformed = { auditHash: "a".repeat(64) } as unknown as SpecIdentity;
    const out = compareSpecIdentity(malformed, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  it("REFUSES an EMPTY identity object, the last fail-open cell (R9-2)", () => {
    // Round 9 walked the full {contractHash} x {auditHash} x {version}
    // matrix and found one cell still open: `specIdentity: {}`. It carries
    // neither hash, so keying the claim on "carries either hash" read it
    // as NO claim and grandfathered it, and `loadApproval` parses
    // unvalidated JSON, so such a record does reach here. The claim is now
    // the PRESENCE of the object, which is the simplest rule that cannot
    // have such a cell.
    const empty = {} as unknown as SpecIdentity;
    const out = compareSpecIdentity(empty, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  // Round 10 (R10-3): keying the claim on "is an object" left four more
  // cells open, because `loadApproval` parses unvalidated JSON and
  // `"specIdentity": null` is not an object. Only `undefined`, a field
  // that is genuinely absent, i.e. written before TASK-1332, is absence.
  it.each([
    ["null", null],
    ["a string", "not-an-identity"],
    ["a number", 0],
    ["a boolean", false],
  ])("REFUSES a stored identity that is %s (R10-3)", (_label, value) => {
    const out = compareSpecIdentity(value as unknown as SpecIdentity, computeSpecIdentity(SPEC));
    expect(out.verdict).toBe("unverifiable");
    expect(mayConsume(out.verdict)).toBe(false);
  });

  it("keeps grandfathering when no record is supplied at all", () => {
    // Callers that pass nothing must keep the pre-R5-3 behaviour, or the
    // change strands every live pend on the deploy that ships it.
    expect(compareSpecIdentity(undefined, computeSpecIdentity(SPEC)).verdict).toBe(
      "unknown_legacy",
    );
  });
});

describe("spec identity: unverifiable advice can actually be followed (R5-5)", () => {
  it("does not send the operator to replan, which needs the file that is missing", () => {
    const advice = recoveryAdviceFor("unverifiable");
    // Replan has to LOCATE and preflight the task file to clear the
    // record, so "just replan" is a dead end when the file is the thing
    // that cannot be read. Same shape of unfollowable advice R4-1 fixed
    // for `diverged`.
    expect(advice).not.toMatch(/^Replan the task/);
    expect(advice).toMatch(/Restore the task spec/);
    expect(advice).toMatch(/THEN replan/);
  });

  it("still sends a plain stale verdict to replan, which does work", () => {
    expect(recoveryAdviceFor("stale")).toMatch(/^Replan the task/);
  });
});
