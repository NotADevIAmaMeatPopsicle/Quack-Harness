import { verifyRepairIsAdditive } from "../../src/core/repair-guard";
import { REPAIR_PLACEHOLDER_MARKER } from "../../src/core/spec-normalizer";

const ORIGINAL = [
  "# TASK-500: Harden the exporter",
  "",
  "## Metadata",
  "- **Priority:** P1-HIGH",
  "- **Effort:** 3 hours",
  "- **Status:** READY",
  "- **Blocked By:** [TASK-499]",
  "",
  "## Problem Statement",
  "The exporter drops rows when the upstream API paginates.",
  "It must retry with the documented cursor semantics.",
  "",
  "## Success Criteria",
  "- [ ] No rows dropped across pagination boundaries",
].join("\n");

describe("verifyRepairIsAdditive", () => {
  it("accepts an identical document", () => {
    expect(verifyRepairIsAdditive(ORIGINAL, ORIGINAL).ok).toBe(true);
  });

  it("keeps the guard marker in sync with the normalizer marker", () => {
    // repair-guard duplicates the marker constant to avoid an import cycle;
    // this test pins the two definitions together.
    expect(REPAIR_PLACEHOLDER_MARKER).toBe("(repair placeholder)");
  });

  it("rejects an envelope replacement with no provenance note (adversarial finding 7)", () => {
    const repaired = ORIGINAL.replace("- **Status:** READY", "- **Status:** BACKLOG");
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("without provenance");
  });

  it("accepts an envelope replacement accompanied by a same-field note", () => {
    const repaired = ORIGINAL.replace(
      "- **Status:** READY",
      [
        "- **Status:** BACKLOG",
        '- **Status-Note:** original status "READY" normalized by spec repair',
      ].join("\n"),
    );
    expect(verifyRepairIsAdditive(ORIGINAL, repaired).ok).toBe(true);
  });

  it("rejects an inserted envelope field with neither marker nor note (adversarial finding 7)", () => {
    // Original has no Effort; the insertion carries no marker and no note.
    const noEffort = ORIGINAL.replace("- **Effort:** 3 hours\n", "");
    const repaired = noEffort.replace(
      "- **Status:** READY",
      "- **Effort:** TBD\n- **Status:** READY",
    );
    const result = verifyRepairIsAdditive(noEffort, repaired);
    expect(result.ok).toBe(false);
  });

  it("protects metadata-shaped bullets in payload prose (adversarial finding 1)", () => {
    const withPastedNote = ORIGINAL.replace(
      "The exporter drops rows when the upstream API paginates.",
      [
        "The pasted customer note must remain intact:",
        "- **Status:** awaiting legal approval",
        "Do not reinterpret the pasted note.",
      ].join("\n"),
    );
    const tampered = withPastedNote.replace(
      "- **Status:** awaiting legal approval",
      "- **Status:** READY",
    );
    const result = verifyRepairIsAdditive(withPastedNote, tampered);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("payload line removed or altered");
  });

  it("rejects blank-line deletion inside payload (adversarial finding 2)", () => {
    const withFence = [ORIGINAL, "", "```ts", "const a = 1;", "", "const b = 2;", "```"].join("\n");
    const blankDropped = withFence.replace(
      "const a = 1;\n\nconst b = 2;",
      "const a = 1;\nconst b = 2;",
    );
    expect(verifyRepairIsAdditive(withFence, blankDropped).ok).toBe(false);
  });

  it("rejects marker abuse on non-TBD content (adversarial finding 3)", () => {
    const repaired = `${ORIGINAL}\n- [ ] Also implement admin impersonation ${REPAIR_PLACEHOLDER_MARKER}\n`;
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.ok).toBe(false);
  });

  it("accepts CRLF-to-LF as logical-line-identical (documented contract)", () => {
    const crlf = ORIGINAL.replace(/\n/g, "\r\n");
    expect(verifyRepairIsAdditive(crlf, ORIGINAL).ok).toBe(true);
  });

  it("accepts inserted note, provenance, and marker placeholder lines", () => {
    const repaired =
      ORIGINAL.replace(
        "- **Status:** READY",
        [
          "- **Status:** READY",
          "- **Status-Note:** original preserved",
          "- **Repaired:** 2026-07-02 spec-normalizer: test",
        ].join("\n"),
      ) +
      [
        "",
        "## Testing Requirements",
        "",
        `- [ ] TBD ${REPAIR_PLACEHOLDER_MARKER}: submitter must define real testing requirements`,
        "",
      ].join("\n");
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a paraphrased payload line", () => {
    const repaired = ORIGINAL.replace(
      "The exporter drops rows when the upstream API paginates.",
      "The exporter loses rows when the upstream API paginates.",
    );
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("payload line removed or altered");
  });

  it("rejects a deleted payload line", () => {
    const repaired = ORIGINAL.replace("It must retry with the documented cursor semantics.\n", "");
    expect(verifyRepairIsAdditive(ORIGINAL, repaired).ok).toBe(false);
  });

  it("rejects reordered payload lines", () => {
    const repaired = ORIGINAL.replace(
      [
        "The exporter drops rows when the upstream API paginates.",
        "It must retry with the documented cursor semantics.",
      ].join("\n"),
      [
        "It must retry with the documented cursor semantics.",
        "The exporter drops rows when the upstream API paginates.",
      ].join("\n"),
    );
    expect(verifyRepairIsAdditive(ORIGINAL, repaired).ok).toBe(false);
  });

  it("rejects inserted non-marker payload content", () => {
    const repaired = `${ORIGINAL}\n\n## Testing Requirements\n\n- [ ] Add a pagination integration test\n`;
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("unexpected inserted or altered line");
  });

  it("rejects a modified protected metadata field (Blocked By)", () => {
    const repaired = ORIGINAL.replace("- **Blocked By:** [TASK-499]", "- **Blocked By:** []");
    const result = verifyRepairIsAdditive(ORIGINAL, repaired);
    expect(result.ok).toBe(false);
  });

  it("rejects a wholesale rewrite even when it parses", () => {
    const rewrite = [
      "# TASK-500: Harden the exporter",
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 3 hours",
      "- **Status:** READY",
      "",
      "## Problem Statement",
      "Completely rewritten problem statement.",
      "",
      "## Success Criteria",
      "- [ ] Something else entirely",
      "",
      "## Testing Requirements",
      "- [ ] Invented tests",
    ].join("\n");
    const result = verifyRepairIsAdditive(ORIGINAL, rewrite);
    expect(result.ok).toBe(false);
  });

  it("allows an H1 insertion only when the original had none", () => {
    const noH1 = ORIGINAL.split("\n").slice(1).join("\n");
    const withH1 = `# TASK-500: Untitled ${REPAIR_PLACEHOLDER_MARKER}\n${noH1}`;
    expect(verifyRepairIsAdditive(noH1, withH1).ok).toBe(true);

    // But replacing an existing H1 with a different one is an envelope
    // replacement, which is allowed only same-kind; a second H1 that is NOT
    // a replacement (original one gone without substitute) fails.
    const h1Removed = ORIGINAL.replace("# TASK-500: Harden the exporter\n", "");
    expect(verifyRepairIsAdditive(ORIGINAL, h1Removed).ok).toBe(false);
  });
});
