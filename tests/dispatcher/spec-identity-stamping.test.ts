import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resavePendingApproval,
  saveBlueprintApproval,
  loadApproval,
  type BlueprintApproval,
} from "../../src/dispatcher/blueprint-approval.js";
import {
  resavePendingJudgeApproval,
  saveJudgeApproval,
  loadJudgeApproval,
} from "../../src/dispatcher/judge-approval.js";
import {
  compareSpecIdentity,
  computeSpecIdentity,
  SPEC_IDENTITY_VERSION,
} from "../../src/core/spec-identity.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";

const SRC = path.resolve(__dirname, "../../src");

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf-8");
}

/** Extract the balanced-paren argument text of every call to `name`. */
function callArgs(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    // A bare identifier, not a suffix of a longer one. Without this,
    // `savePendingApproval` matches inside `resavePendingApproval` and
    // the resave calls (which correctly pass `existing.specIdentity`,
    // not `currentSpecIdentity()`) get counted as creation sites. Caught
    // by this suite's own first run.
    const prev = start > 0 ? source[start - 1] : " ";
    if (/[A-Za-z0-9_$]/.test(prev)) {
      from = start + needle.length;
      continue;
    }
    // Skip the declaration itself.
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const line = source.slice(lineStart, start + needle.length);
    if (/\b(function|async function)\s*$/.test(line.slice(0, line.length - needle.length))) {
      from = start + needle.length;
      continue;
    }
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start + needle.length, i));
    from = i + 1;
  }
  return out;
}

// ── The completeness proof ───────────────────────────────────────────
// TASK-1332 S6 / round-1 R1-4. `specIdentity` is an OPTIONAL trailing
// parameter rather than a required positional, because making it
// required would have rewritten 54 test call sites without making the
// production code any safer. The cost of `optional` is that a MISSED
// creation site writes no stamp and degrades silently to UNKNOWN at a
// gate whose entire job is to not be silent. This suite is the
// completeness proof that buys the ergonomics back, and it is the same
// source-tripwire pattern TASK-1323 and TASK-1324 used for the same
// class of risk.
describe("TASK-1332: every approval CREATION site stamps spec identity", () => {
  const dispatcher = read("dispatcher/dispatcher.ts");

  it.each([
    ["saveBlueprintApproval", 1, "approvalIdentity.identity"],
    ["savePendingApproval", 1, "approvalIdentity.identity"],
    ["saveJudgeApproval", 3, "approvalIdentity.identity"],
    ["savePendingJudgeApproval", 1, "approvalIdentity.identity"],
  ])(
    "every %s call in the dispatcher passes a guarded found identity",
    (fn, expected, identity) => {
      const calls = callArgs(dispatcher, fn);
      expect(calls).toHaveLength(expected);
      for (const args of calls) {
        expect(args).toContain(identity);
      }
    },
  );

  it("keeps the two comparison consumers on full resolution while stamps use found-only", () => {
    const fullComparisons = callArgs(dispatcher, "compareResolvedSpecIdentity");
    expect(fullComparisons).toHaveLength(2);
    for (const args of fullComparisons) {
      expect(args).toContain("currentSpecResolution()");
      expect(args).not.toContain("currentFoundSpecIdentity()");
    }

    expect(dispatcher).toContain("const currentSpecResolution =");
    expect(dispatcher).toContain("const identityForApprovalSave =");
    expect(dispatcher).toContain("return { identity: foundSpecIdentity(resolution) }");
    expect(callArgs(dispatcher, "identityForApprovalSave")).toHaveLength(6);
  });

  it("resolves identity from the adapter's project root, never from task.rawContent alone", () => {
    // R1-1. If this helper ever starts hashing the in-hand task instead
    // of reading the owning clone, the whole check goes blind on exactly
    // the resume path it exists for.
    expect(dispatcher).toContain("resolveCurrentSpecIdentity(");
    const helper = dispatcher.slice(
      dispatcher.indexOf("const currentSpecResolution ="),
      dispatcher.indexOf("const effectiveExecutionMode"),
    );
    expect(helper).toContain("adapter.projectRoot");
    expect(helper).toContain("adapter.config.project.taskDir");
  });

  it("stamps the PRE-ENRICHMENT source as the in-hand content (R5-2)", () => {
    // Round 5's second HIGH, pinned at the wiring rather than only at the
    // contract. `task` is reassigned to the enriched copy further down
    // (`task = gateResult.task.enriched`), so a helper that reads
    // `task.rawContent` at STAMP time compares authoritative SOURCE
    // against ENRICHED DERIVATION, differs by construction, and makes
    // every enriched dispatch born `diverged`.
    //
    // A tripwire, not a proof, the R2-6 caveat applies here too. The
    // behavioural contract is tested in tests/core/spec-identity.test.ts;
    // this is what stops the dispatcher quietly reverting to the shape
    // that produced the defect.
    const helper = dispatcher.slice(
      dispatcher.indexOf("const inHandSourceContent"),
      dispatcher.indexOf("const refuseForSpecIdentity"),
    );
    // Round 6 (R6-5): assert the POSITIONS, not merely that the names
    // appear. The round-5 version checked only presence, so swapping the
    // source and enriched arguments, which is exactly the defect -
    // passed it.
    const call = helper.slice(helper.indexOf("resolveCurrentSpecIdentity("));
    const args = callArgs(call, "resolveCurrentSpecIdentity")[0] ?? "";
    const positional = args
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    expect(positional[0]).toBe("adapter.projectRoot");
    expect(positional[1]).toBe("adapter.config.project.taskDir");
    expect(positional[2]).toBe("taskId");
    // 4th = the captured SOURCE. Never the live task.
    expect(positional[3]).toBe("inHandSourceContent");
    // 5th = the enriched content, audit-only, and only when it actually
    // differs from the captured source.
    expect(positional.slice(4).join(",")).toContain("task.rawContent !== inHandSourceContent");
  });
});

describe("TASK-1332: RESAVE preserves identity and never recomputes it", () => {
  // R1-4: a resave that re-stamped from the current spec would hand the
  // old artifact the amended spec's hash, making the defect invisible at
  // exactly the moment it fires.
  it.each([
    ["dispatcher/blueprint-approval.ts", "resavePendingApproval"],
    ["dispatcher/judge-approval.ts", "resavePendingJudgeApproval"],
  ])("%s's %s passes the EXISTING identity", (file, fn) => {
    const source = read(file);
    const body = source.slice(source.indexOf(`export async function ${fn}`));
    const upToNextExport = body.slice(0, body.indexOf("\nexport ", 1));
    expect(upToNextExport).toContain("existing.specIdentity");
    expect(upToNextExport).not.toContain("computeSpecIdentity");
    expect(upToNextExport).not.toContain("resolveCurrentSpecIdentity");
  });
});

describe("TASK-1332: stamping behaviour on disk", () => {
  let logDir: string;

  const blueprint = {
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
  } as unknown as Blueprint;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-stamp-"));
  });
  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("writes the identity onto a created blueprint record", async () => {
    const identity = computeSpecIdentity("# TASK-1\n\n- **Status:** BACKLOG\n\nbody\n");
    await saveBlueprintApproval(
      "TASK-1",
      blueprint,
      undefined,
      logDir,
      "pending",
      undefined,
      identity,
    );
    const loaded = await loadApproval("TASK-1", logDir);
    expect(loaded?.specIdentity?.contractHash).toBe(identity.contractHash);
  });

  it("omits the field entirely when identity is UNKNOWN, rather than writing a placeholder", async () => {
    await saveBlueprintApproval(
      "TASK-2",
      blueprint,
      undefined,
      logDir,
      "pending",
      undefined,
      undefined,
    );
    const loaded = await loadApproval("TASK-2", logDir);
    expect(loaded?.specIdentity).toBeUndefined();
    // Round 5 (R5-3): but it DOES carry the version, and that is the whole
    // point. Absence of the identity alone was ambiguous, pre-1332
    // record, or written today by code that tried and failed, and the
    // ambiguity resolved fail-open as `unknown_legacy`.
    expect(loaded?.specIdentityVersion).toBe(SPEC_IDENTITY_VERSION);
    expect(
      compareSpecIdentity(loaded?.specIdentity, computeSpecIdentity("# x\n"), loaded ?? undefined)
        .verdict,
    ).toBe("unverifiable");
  });

  it("a resave keeps a genuinely PRE-1332 record unversioned, so it stays grandfathered (R5-3)", async () => {
    // The trap inside the R5-3 fix. A live pre-1332 pend gets re-saved
    // whenever a fresh dispatch re-encounters it (QPI-043's fix), so if
    // the resave minted a version, that record would flip from
    // `unknown_legacy` to `unverifiable` and be REFUSED, stranding every
    // live legacy pend on the deploy that ships this, which is exactly
    // what the grandfather clause exists to prevent.
    const legacyPath = path.join(logDir, "approvals", "TASK-9.json");
    await saveBlueprintApproval("TASK-9", blueprint, undefined, logDir, "pending");
    const written = JSON.parse(fs.readFileSync(legacyPath, "utf-8")) as Record<string, unknown>;
    delete written.specIdentityVersion; // now genuinely pre-1332 on disk
    fs.writeFileSync(legacyPath, JSON.stringify(written, null, 2), "utf-8");

    const legacy = (await loadApproval("TASK-9", logDir)) as BlueprintApproval;
    expect(legacy.specIdentityVersion).toBeUndefined();

    await resavePendingApproval(legacy, logDir);
    const after = (await loadApproval("TASK-9", logDir)) as BlueprintApproval;

    expect(after.specIdentityVersion).toBeUndefined();
    expect(
      compareSpecIdentity(after.specIdentity, computeSpecIdentity("# x\n"), after).verdict,
    ).toBe("unknown_legacy");
  });

  it("a blueprint resave carries the ORIGINAL identity forward while createdAt moves", async () => {
    const original = computeSpecIdentity("# TASK-3\n\noriginal contract\n");
    await saveBlueprintApproval(
      "TASK-3",
      blueprint,
      undefined,
      logDir,
      "pending",
      undefined,
      original,
    );
    const before = (await loadApproval("TASK-3", logDir)) as BlueprintApproval;

    await new Promise((r) => setTimeout(r, 5));
    await resavePendingApproval(before, logDir);
    const after = (await loadApproval("TASK-3", logDir)) as BlueprintApproval;

    // Round 5 (R5-7): DEEP equality, not just the contract hash. A resave
    // that rebuilt the identity from the current spec would keep the same
    // contract hash here (nothing amended it in this test) while silently
    // moving `stampedAt`, so hash-only equality could not see a re-mint.
    expect(after.specIdentity).toEqual(original);
    // TASK-1329 attribution depends on this still moving. The two are
    // deliberately independent: identity is the artifact's, createdAt is
    // the run's.
    //
    // Round 5 (R5-7): STRICTLY greater. `>=` passed unchanged if the
    // resave stopped refreshing `createdAt` and copied the old timestamp
    // forward, so the assertion did not protect the behaviour it names.
    // The 5ms sleep above is what makes strict comparison safe on a
    // millisecond clock.
    expect(new Date(after.createdAt).getTime()).toBeGreaterThan(
      new Date(before.createdAt).getTime(),
    );
  });

  it("a resave of an UNSTAMPED legacy record leaves it UNKNOWN, not freshly stamped", async () => {
    await saveBlueprintApproval("TASK-4", blueprint, undefined, logDir, "pending");
    const legacy = (await loadApproval("TASK-4", logDir)) as BlueprintApproval;
    await resavePendingApproval(legacy, logDir);
    expect((await loadApproval("TASK-4", logDir))?.specIdentity).toBeUndefined();
  });

  it("a judge resave preserves identity AND the TASK-1316 intent hold together", async () => {
    const identity = computeSpecIdentity("# TASK-5\n\njudge contract\n");
    await saveJudgeApproval(
      "TASK-5",
      "diff",
      ["a.ts"],
      true,
      logDir,
      "pending",
      undefined,
      { rationale: ["look at this"], diffFingerprint: "fp-1", heldAt: "2026-08-14T00:00:00Z" },
      identity,
    );
    const before = await loadJudgeApproval("TASK-5", logDir);
    await resavePendingJudgeApproval(before!, logDir);
    const after = await loadJudgeApproval("TASK-5", logDir);

    expect(after?.specIdentity?.contractHash).toBe(identity.contractHash);
    expect(after?.intentHold?.diffFingerprint).toBe("fp-1");
  });
});
