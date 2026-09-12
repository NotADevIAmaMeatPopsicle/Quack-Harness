import {
  normalizeSpec,
  hasUnresolvedRepairMarkers,
  REPAIR_PLACEHOLDER_MARKER,
} from "../../src/core/spec-normalizer";
import { verifyRepairIsAdditive } from "../../src/core/repair-guard";
import { parseTaskFile } from "../../src/core/task-parser";

// Fixture shapes are modeled on the real 2026-07-02 Headnode parseErrors
// (124 example specs): prose statuses with SHAs, parenthetical priorities,
// missing Priority/Effort, missing Testing Requirements sections.

function spec(overrides: { h1?: string; metadata?: string[]; sections?: string }): string {
  const h1 = overrides.h1 ?? "# TASK-1234: Fix the widget";
  const metadata = overrides.metadata ?? [
    "- **Priority:** P1-HIGH",
    "- **Effort:** 2 hours",
    "- **Status:** READY",
  ];
  const sections =
    overrides.sections ??
    [
      "## Problem Statement",
      "The widget renders twice on load.",
      "",
      "## Success Criteria",
      "- [ ] Widget renders exactly once",
      "",
      "## Testing Requirements",
      "- [ ] Unit test covering the double-render regression",
    ].join("\n");
  return [h1, "", "## Metadata", ...metadata, "", sections, ""].join("\n");
}

/** Non-envelope lines must survive byte-identical. */
function payloadLines(content: string): string[] {
  return content.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (t === "") return false;
    if (t.startsWith("# ") && !t.startsWith("## ")) return false;
    if (/^-\s*\*\*(Priority|Effort|Status)(-Note)?:\*\*/i.test(t)) return false;
    if (/^-\s*\*\*Repaired:\*\*/i.test(t)) return false;
    if (t.includes(REPAIR_PLACEHOLDER_MARKER)) return false;
    if (/^##\s/.test(t)) return false;
    return true;
  });
}

describe("normalizeSpec", () => {
  it("leaves an already-valid spec untouched", () => {
    const content = spec({});
    const result = normalizeSpec(content);
    expect(result.changed).toBe(false);
    expect(result.resolved).toBe(true);
    expect(result.content).toBe(content);
    expect(result.actions).toEqual([]);
  });

  it("normalizes a prose status with a SHA to its leading canonical token", () => {
    const content = spec({
      metadata: [
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2 hours",
        "- **Status:** VERIFIED + MERGED TO DEV (c913575)",
      ],
    });
    const result = normalizeSpec(content, { now: "2026-07-02" });
    expect(result.resolved).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.actions).toContain("status-normalized");

    const task = parseTaskFile(result.content);
    expect(task.status).toBe("VERIFIED");
    // The submitter's original text is preserved in the note line.
    expect(result.content).toContain("VERIFIED + MERGED TO DEV (c913575)");
    expect(result.content).toContain("**Status-Note:**");
    // Meaning-preserving normalization does NOT gate the task.
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(false);
  });

  it("maps unambiguous status aliases like TODO", () => {
    const content = spec({
      metadata: ["- **Priority:** P1-HIGH", "- **Effort:** 2 hours", "- **Status:** TODO"],
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(parseTaskFile(result.content).status).toBe("BACKLOG");
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(false);
  });

  it("refuses to guess an unrecognizable status (returns unresolved, no partial write)", () => {
    const content = spec({
      metadata: [
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2 hours",
        "- **Status:** awaiting vendor sign-off",
      ],
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("extracts a parenthetical priority and keeps the original in a note", () => {
    const content = spec({
      metadata: [
        "- **Priority:** P3-LOW (deferred behind the pilot)",
        "- **Effort:** 2 hours",
        "- **Status:** READY",
      ],
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(result.actions).toContain("priority-extracted");
    expect(parseTaskFile(result.content).priority).toBe("P3-LOW");
    expect(result.content).toContain("deferred behind the pilot");
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(false);
  });

  it("defaults a missing Priority and Effort with gating markers", () => {
    const content = spec({
      metadata: ["- **Status:** READY"],
    });
    const result = normalizeSpec(content, { now: "2026-07-02" });
    expect(result.resolved).toBe(true);
    expect(result.actions).toEqual(
      expect.arrayContaining(["priority-defaulted", "effort-defaulted"]),
    );
    const task = parseTaskFile(result.content);
    expect(task.priority).toBe("P2-MEDIUM");
    // Repair-invented values gate the task until a human confirms.
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(true);
  });

  it("inserts a gating TBD placeholder for a missing Testing Requirements section", () => {
    const content = spec({
      sections: [
        "## Problem Statement",
        "The widget renders twice on load.",
        "",
        "## Success Criteria",
        "- [ ] Widget renders exactly once",
      ].join("\n"),
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(result.actions).toContain("testing-requirements-placeholder");
    const task = parseTaskFile(result.content);
    expect(task.testingRequirements).toHaveLength(1);
    expect(task.testingRequirements[0]).toContain(REPAIR_PLACEHOLDER_MARKER);
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(true);
  });

  it("fixes an H1 missing its separator", () => {
    const content = spec({ h1: "# TASK-1234 Fix the widget" });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(result.actions).toContain("h1-separator-fixed");
    const task = parseTaskFile(result.content);
    expect(task.id).toBe("TASK-1234");
    expect(task.title).toBe("Fix the widget");
  });

  it("repairs multiple problems in one pass and records provenance", () => {
    const content = spec({
      metadata: ["- **Status:** DONE"],
      sections: [
        "## Problem Statement",
        "The widget renders twice on load.",
        "",
        "## Success Criteria",
        "- [ ] Widget renders exactly once",
      ].join("\n"),
    });
    const result = normalizeSpec(content, { now: "2026-07-02" });
    expect(result.resolved).toBe(true);
    const task = parseTaskFile(result.content);
    expect(task.status).toBe("COMPLETE");
    expect(task.priority).toBe("P2-MEDIUM");
    expect(result.content).toContain("- **Repaired:** 2026-07-02 spec-normalizer:");
  });

  it("never alters payload content the submitter wrote (guard-verified)", () => {
    const content = spec({
      metadata: ["- **Status:** VERIFIED + MERGED (abc1234)"],
      sections: [
        "## Problem Statement",
        "The widget renders twice on load.",
        "Some very specific constraint the submitter cares about.",
        "",
        "## Success Criteria",
        "- [ ] Widget renders exactly once",
      ].join("\n"),
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);

    const guard = verifyRepairIsAdditive(content, result.content);
    expect(guard.ok).toBe(true);
    expect(payloadLines(result.content)).toEqual(payloadLines(content));
  });

  it("normalizes administrative-suffix statuses from the real backlog shapes", () => {
    const shapes: Array<[string, string]> = [
      ["COMPLETE — SHIPPED 2026-05-24 (PER FAMILY-VERIFY COMMIT 61)", "COMPLETE"],
      ["COMPLETE 2026-05-26 — ADDED", "COMPLETE"],
      ["COMPLETE. VERIFIED 2026-06-22 AGAINST ORIGIN/DEV @ 7E59188D", "COMPLETE"],
      ["BLOCKED — NEEDS PHOREST ADMIN EXPORT", "BLOCKED"],
      ["IN_PROGRESS — PHASE 1 (CODE) COMPLETE", "IN_PROGRESS"],
    ];
    for (const [raw, expected] of shapes) {
      const content = spec({
        metadata: ["- **Priority:** P1-HIGH", "- **Effort:** 2 hours", `- **Status:** ${raw}`],
      });
      const result = normalizeSpec(content);
      expect(result.resolved).toBe(true);
      expect(parseTaskFile(result.content).status).toBe(expected);
      expect(hasUnresolvedRepairMarkers(result.content)).toBe(false);
    }
  });

  it("refuses ambiguous leading tokens like 'READY? awaiting legal approval' (adversarial finding 5)", () => {
    const content = spec({
      metadata: [
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2 hours",
        "- **Status:** READY? awaiting legal approval",
      ],
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(false);
    expect(result.content).toBe(content);
  });

  it("gates ambiguous priorities like 'P0? maybe not urgent' instead of silently normalizing (adversarial finding 6)", () => {
    const content = spec({
      metadata: [
        "- **Priority:** P0? maybe not urgent",
        "- **Effort:** 2 hours",
        "- **Status:** READY",
      ],
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(result.actions).toContain("priority-defaulted");
    expect(parseTaskFile(result.content).priority).toBe("P2-MEDIUM");
    expect(result.content).toContain("P0? maybe not urgent");
    expect(hasUnresolvedRepairMarkers(result.content)).toBe(true);
  });

  it("never touches metadata-shaped bullets pasted into payload prose (adversarial finding 1)", () => {
    const pasted = "- **Status:** awaiting legal approval";
    const content = spec({
      metadata: [
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2 hours",
        "- **Status:** VERIFIED + MERGED (abc1234)",
      ],
      sections: [
        "## Problem Statement",
        "The pasted customer note must remain intact:",
        pasted,
        "Do not reinterpret the pasted note.",
        "",
        "## Success Criteria",
        "- [ ] Note preserved",
        "",
        "## Testing Requirements",
        "- [ ] Covered",
      ].join("\n"),
    });
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    // The metadata Status was normalized; the pasted payload bullet was not.
    expect(parseTaskFile(result.content).status).toBe("VERIFIED");
    expect(result.content).toContain(pasted);
  });

  it("flags TBD envelope values as unresolved even without the marker (adversarial finding 7)", () => {
    const content = spec({
      metadata: ["- **Priority:** P1-HIGH", "- **Effort:** TBD", "- **Status:** READY"],
    });
    expect(hasUnresolvedRepairMarkers(content)).toBe(true);
    // But TBD in payload prose does not gate.
    expect(hasUnresolvedRepairMarkers("Some prose mentioning TBD items.")).toBe(false);
  });

  it("preserves CRLF line endings on repaired output", () => {
    const content = spec({
      metadata: ["- **Priority:** P1-HIGH", "- **Effort:** 2 hours", "- **Status:** TODO"],
    }).replace(/\n/g, "\r\n");
    const result = normalizeSpec(content);
    expect(result.resolved).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.content).toContain("\r\n");
    expect(parseTaskFile(result.content).status).toBe("BACKLOG");
  });

  it("inserts an H1 from the filename hint only when no H1 exists", () => {
    const content = [
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 1 hour",
      "- **Status:** READY",
      "",
      "## Problem Statement",
      "Something.",
      "",
      "## Success Criteria",
      "- [ ] Done",
      "",
      "## Testing Requirements",
      "- [ ] Tested",
      "",
    ].join("\n");
    const withHint = normalizeSpec(content, { taskIdHint: "TASK-777" });
    expect(withHint.resolved).toBe(true);
    expect(withHint.actions).toContain("h1-inserted");
    expect(parseTaskFile(withHint.content).id).toBe("TASK-777");
    // The invented title carries the gating marker.
    expect(hasUnresolvedRepairMarkers(withHint.content)).toBe(true);

    const withoutHint = normalizeSpec(content);
    expect(withoutHint.resolved).toBe(false);
  });
});
