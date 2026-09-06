// ─── Intent-cutover inventory pins (TASK-1316, decision D1) ─────────
// Two claims, kept separate on purpose:
//   1. STAGE completeness — every judgment stage is either a cutover
//      target or an exclusion with a recorded rationale.
//   2. STRUCTURAL truth — no post-judge module orchestrates intent
//      judgment, and the one excluded call site of an INCLUDED stage
//      stays unwired.
// A data-only list would let the code drift from the claim, so the
// structural half reads the actual source (the TASK-1312/1313 idiom).

import * as fs from "node:fs";
import * as path from "node:path";

import {
  INTENT_CUTOVER_CALL_SITE_EXCLUSIONS,
  INTENT_CUTOVER_EXCLUSIONS,
  INTENT_CUTOVER_TARGETS,
  intentCutoverCoverageIsComplete,
} from "../../src/judgment/intent-cutover-inventory";
import { JUDGMENT_STAGES } from "../../src/judgment/judgment-types";

/** The only modules allowed to orchestrate intent judgment. */
const SANCTIONED_ORCHESTRATION_SITES = [
  "src/gate/gate.ts",
  "src/review/docs-gate.ts",
  "src/review/loop-gate.ts",
  "src/dispatcher/dispatcher.ts",
];

function sourceOf(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf-8");
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() && rel.endsWith(".ts") ? [rel] : [];
  });
}

describe("TASK-1316 intent-cutover inventory", () => {
  it("accounts for EVERY judgment stage exactly once", () => {
    const listed = [
      ...INTENT_CUTOVER_TARGETS,
      ...INTENT_CUTOVER_EXCLUSIONS.map((exclusion) => exclusion.stage),
    ];
    expect([...listed].sort()).toEqual([...JUDGMENT_STAGES].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(intentCutoverCoverageIsComplete()).toBe(true);
  });

  it("excludes post_judge with a recorded rationale (D1)", () => {
    const postJudge = INTENT_CUTOVER_EXCLUSIONS.find(
      (exclusion) => exclusion.stage === "post_judge",
    );
    expect(postJudge).toBeDefined();
    expect(postJudge?.rationale.length).toBeGreaterThan(40);
    expect(INTENT_CUTOVER_TARGETS).not.toContain("post_judge");
  });

  it("does NOT overload STAGE_INJECTION_EXCLUSIONS (they prove different claims)", () => {
    const inventory = sourceOf("src/judgment/intent-cutover-inventory.ts");
    // Naming it in a comment is the POINT (the distinction is
    // load-bearing); depending on it as a value is what would blur the
    // two completeness claims.
    const codeReferences = inventory
      .split("\n")
      .filter((line) => line.includes("STAGE_INJECTION_EXCLUSIONS"))
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    expect(codeReferences).toEqual([]);
  });

  // ── Structural pins ───────────────────────────────────────────────

  it("only sanctioned modules orchestrate intent judgment", () => {
    const orchestrating = walk("src").filter((relPath) =>
      /\borchestrateJudgment\s*\(/.test(sourceOf(relPath)),
    );
    expect(orchestrating.sort()).toEqual(
      [...SANCTIONED_ORCHESTRATION_SITES, "src/judgment/judgment-orchestrator.ts"].sort(),
    );
  });

  it("no post-judge module orchestrates intent judgment", () => {
    const postJudgeFiles = walk("src").filter((relPath) => /post-judge/.test(relPath));
    expect(postJudgeFiles.length).toBeGreaterThan(0);
    for (const relPath of postJudgeFiles) {
      expect(sourceOf(relPath)).not.toMatch(/orchestrateJudgment/);
    }
  });

  it("the judge cutover is applied at exactly the two sanctioned seams", () => {
    const dispatcher = sourceOf("src/dispatcher/dispatcher.ts");
    const calls = dispatcher.match(/await applyJudgeIntentCutover\(/g) ?? [];
    // Initial judge + retry judge. A third seam must be a conscious
    // decision, not a silent addition — see the call-site exclusion.
    expect(calls).toHaveLength(2);
  });

  // Round-2 F5: counting the calls proves they EXIST, not that they run
  // where D1 requires. Both the cutover and post-judge live in
  // dispatcher.ts, so a reordering would satisfy every other assertion
  // here. Pin the ORDER: each cutover must precede the post-judge
  // verification that follows it, or the intent model would be reacting
  // to deterministic build/test/lint authority.
  it("each judge cutover runs BEFORE its post-judge verification (D1 ordering)", () => {
    const dispatcher = sourceOf("src/dispatcher/dispatcher.ts");
    const offsets = (pattern: RegExp): number[] =>
      [...dispatcher.matchAll(pattern)].map((match) => match.index ?? -1);

    const cutovers = offsets(/await applyJudgeIntentCutover\(/g);
    const postJudge = offsets(/await runPostJudgeVerifyAndConvert\(/g);
    expect(cutovers).toHaveLength(2);
    expect(postJudge.length).toBeGreaterThanOrEqual(2);

    // Pair each cutover with the FIRST post-judge call after it and
    // require the pairing to exist: a cutover with no post-judge call
    // downstream would mean it moved past the deterministic layer.
    for (const cutover of cutovers) {
      const next = postJudge.find((offset) => offset > cutover);
      expect(next).toBeDefined();
    }
    // And no post-judge call may sit between the judge seam and its
    // cutover: the first cutover precedes the first post-judge call.
    expect(cutovers[0]).toBeLessThan(postJudge[0]);
  });

  it("the integration judge stays unwired, with its rationale recorded", () => {
    const dispatcher = sourceOf("src/dispatcher/dispatcher.ts");
    expect(dispatcher).not.toMatch(/applyJudgeIntentCutover\(\s*integrationJudgeResult/);
    const exclusion = INTENT_CUTOVER_CALL_SITE_EXCLUSIONS.find((entry) =>
      entry.site.includes("integration-judge"),
    );
    expect(exclusion).toBeDefined();
    expect(exclusion?.rationale).toMatch(/terminal|abandon|reject/i);
  });
});
