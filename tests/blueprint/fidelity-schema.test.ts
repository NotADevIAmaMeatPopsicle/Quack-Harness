// ─── TASK-1324 S1: fidelity schema + Decided Facts parsing ─────────
// Pins the machine-readable surfaces everything downstream builds on:
// the `## Decided Facts` spec section → ParsedTask.decidedFacts, and the
// typed directive/fidelity fields through the single normalizer
// (validateBlueprint) — junk dropped, absent stays absent, and a
// persisted fidelity result survives the cached rehydration path.

import { parseTaskFile } from "../../src/core/task-parser";
import { validateBlueprint } from "../../src/blueprint/blueprint-agent";

function taskDoc(extraSections = ""): string {
  return [
    "# TASK-999: Fixture",
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    "- **Status:** BACKLOG",
    "",
    "## Problem Statement",
    "Fixture problem.",
    "",
    "## Success Criteria",
    "- [ ] Works",
    "",
    "## Testing Requirements",
    "- [ ] Tested",
    "",
    extraSections,
  ].join("\n");
}

describe("TASK-1324 Decided Facts parsing", () => {
  it("extracts a Decided Facts section as decidedFacts[]", () => {
    const task = parseTaskFile(
      taskDoc(
        [
          "## Decided Facts",
          "- The DTO boundary runs BEFORE break classification",
          "- The JSON export is raw end-to-end",
          "",
        ].join("\n"),
      ),
    );
    expect(task.decidedFacts).toEqual([
      "The DTO boundary runs BEFORE break classification",
      "The JSON export is raw end-to-end",
    ]);
  });

  it("omits decidedFacts entirely when the section is absent (no prose scrape)", () => {
    const task = parseTaskFile(taskDoc());
    expect(task.decidedFacts).toBeUndefined();
  });

  it("omits decidedFacts when the section exists but has no bullets", () => {
    const task = parseTaskFile(taskDoc("## Decided Facts\n\nProse only, no bullets.\n"));
    expect(task.decidedFacts).toBeUndefined();
  });
});

describe("TASK-1324 normalizer: typed directives + specFacts + fidelity", () => {
  const base = {
    taskId: "TASK-999",
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  };

  it("keeps valid directives, drops junk entries, trims strings", () => {
    const result = validateBlueprint({
      ...base,
      importsToUse: [
        { symbol: " importHotAppointments ", fromFile: "src/importers/hot.ts " },
        { symbol: "", fromFile: "src/x.ts" },
        { symbol: "noFile" },
        "garbage",
        null,
      ],
      entryPoints: [{ symbol: "main", file: "src/cli.ts" }, { file: "src/cli.ts" }],
    });
    expect(result?.importsToUse).toEqual([
      { symbol: "importHotAppointments", fromFile: "src/importers/hot.ts" },
    ]);
    expect(result?.entryPoints).toEqual([{ symbol: "main", file: "src/cli.ts" }]);
  });

  it("omits directive fields entirely when nothing valid remains (absent stays absent)", () => {
    const result = validateBlueprint({
      ...base,
      importsToUse: ["junk", { symbol: "", fromFile: "" }],
    });
    expect(result?.importsToUse).toBeUndefined();
    expect(result?.entryPoints).toBeUndefined();
  });

  it("normalizes specFacts as a string array", () => {
    const result = validateBlueprint({
      ...base,
      specFacts: ["fact one", 42, "", "fact two"],
    });
    expect(result?.specFacts).toEqual(["fact one", "fact two"]);
  });

  it("carries a well-formed persisted fidelity result through (cached path)", () => {
    const result = validateBlueprint({
      ...base,
      fidelity: {
        status: "failed",
        violations: [
          {
            kind: "unexported_symbol",
            detail: "upsertAppointments is not exported",
            anchor: "src/importers/hot.ts",
          },
          { kind: "bogus_kind", detail: "dropped" },
        ],
        checkedAt: "2026-08-10T02:00:00.000Z",
        scope: "typed-surface+file-existence",
      },
    });
    expect(result?.fidelity?.status).toBe("failed");
    expect(result?.fidelity?.violations).toHaveLength(1);
    expect(result?.fidelity?.violations[0]?.kind).toBe("unexported_symbol");
    expect(result?.fidelity?.checkedAt).toBe("2026-08-10T02:00:00.000Z");
  });

  it("drops a malformed fidelity value (bad status) instead of trusting it", () => {
    const result = validateBlueprint({
      ...base,
      fidelity: { status: "totally-fine", violations: [] },
    });
    expect(result?.fidelity).toBeUndefined();
  });
});
