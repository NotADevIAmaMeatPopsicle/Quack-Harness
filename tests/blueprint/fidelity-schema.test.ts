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

describe("TASK-1325 Mandated Checks parsing", () => {
  it("extracts exact bullet-text forms into mandatedChecks[]", () => {
    const task = parseTaskFile(
      taskDoc(
        [
          "## Mandated Checks",
          "- `npm test -- --runInBand` expect: exactly-0",
          "- grep: every queue writer appears in the guard test by name",
          "",
        ].join("\n"),
      ),
    );
    expect(task.mandatedChecks).toEqual([
      "`npm test -- --runInBand` expect: exactly-0",
      "grep: every queue writer appears in the guard test by name",
    ]);
  });

  it("omits the field when the section is absent or contains only prose/fences", () => {
    expect(parseTaskFile(taskDoc()).mandatedChecks).toBeUndefined();
    const fencedOnly = parseTaskFile(
      taskDoc(
        [
          "## Mandated Checks",
          "Prose is not a machine-readable mandate.",
          "```sh",
          "npm test -- --runInBand",
          "```",
        ].join("\n"),
      ),
    );
    expect(fencedOnly.mandatedChecks).toBeUndefined();
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

  it("normalizes mandate echoes and carries exact pattern links", () => {
    const result = validateBlueprint({
      ...base,
      mandatedChecks: [" `npm test` expect: exactly-0 ", 42, ""],
      verificationPatterns: [
        {
          criterion: "The mandated verification form is preserved",
          checkType: "grep",
          pattern: "npm test",
          fileGlob: "docs/tasks/*.md",
          mandatedCheck: " `npm test` expect: exactly-0 ",
        },
      ],
    });
    expect(result?.mandatedChecks).toEqual([" `npm test` expect: exactly-0 "]);
    expect(result?.verificationPatterns[0]?.mandatedCheck).toBe(" `npm test` expect: exactly-0 ");
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
          { kind: "mandated_check_softened", detail: "exact-zero form changed" },
          { kind: "bogus_kind", detail: "dropped" },
        ],
        checkedAt: "2026-08-10T02:00:00.000Z",
        scope: "typed-surface+file-existence+mandated-checks",
      },
    });
    expect(result?.fidelity?.status).toBe("failed");
    expect(result?.fidelity?.violations).toHaveLength(2);
    expect(result?.fidelity?.violations[0]?.kind).toBe("unexported_symbol");
    expect(result?.fidelity?.checkedAt).toBe("2026-08-10T02:00:00.000Z");
    expect(result?.fidelity?.scope).toBe("typed-surface+file-existence+mandated-checks");
  });

  it("drops a malformed fidelity value (bad status) instead of trusting it", () => {
    const result = validateBlueprint({
      ...base,
      fidelity: { status: "totally-fine", violations: [] },
    });
    expect(result?.fidelity).toBeUndefined();
  });
});
