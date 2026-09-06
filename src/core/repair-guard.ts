// ─── Repair Guard ───────────────────────────────────────────────────
// Mechanical enforcement of the intent-safety contract for spec repair:
// a repair may only touch the ENVELOPE (metadata fields Priority/Effort/
// Status inside the Metadata section, their note lines, the Repaired
// provenance line, the H1 heading) and may only INSERT narrow TBD
// placeholder content or missing canonical section headings. Every payload
// line the submitter wrote must survive logical-line-identical and in
// order (line content is compared exactly; line TERMINATORS are not, i.e.
// a CRLF-to-LF checkout difference is tolerated by design and the
// normalizer restores the dominant original EOL on write).
//
// This guard is applied to BOTH repair legs: the deterministic normalizer
// (as a self-check) and the LLM spec-repair agent (as a hard gate before
// its output is written back). Prompt-level "preserve all content"
// instructions are hopes; this is the invariant.
//
// Hardened 2026-07-02 after cross-model adversarial review:
// - metadata-looking bullets OUTSIDE the Metadata section are payload
//   (a pasted customer note containing "- **Status:** ..." is protected);
// - blank lines are payload (deleting one inside a code fence is a
//   violation);
// - marker-carrying insertions must match the narrow TBD placeholder
//   shapes, not arbitrary content with the marker appended;
// - inserted envelope fields must gate (marker in the value or in a
//   same-field note line); replaced envelope values require a same-field
//   note line preserving the original.

const ENVELOPE_FIELDS: ReadonlySet<string> = new Set(["priority", "effort", "status"]);

const NOTE_FIELDS: ReadonlySet<string> = new Set([
  "priority-note",
  "effort-note",
  "status-note",
  "repaired",
]);

/** Section headings a repair may INSERT when the original lacked them. */
const INSERTABLE_HEADINGS: ReadonlySet<string> = new Set([
  "metadata",
  "problem statement",
  "success criteria",
  "testing requirements",
]);

/** Marker that identifies repair-inserted placeholder content. Kept in sync
 *  with core/spec-normalizer.ts (duplicated here to avoid an import cycle;
 *  pinned together by tests/core/repair-guard.test.ts). */
const MARKER = "(repair placeholder)";

type LineClass =
  | { kind: "blank" }
  | { kind: "h1" }
  | { kind: "heading"; name: string }
  | { kind: "meta"; field: string }
  | { kind: "payload" };

function normalizeHeadingName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*[(:-].*$/, "")
    .trim();
}

function classifyLine(line: string): LineClass {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "blank" };
  if (trimmed.startsWith("## ")) {
    return { kind: "heading", name: normalizeHeadingName(trimmed.slice(3)) };
  }
  if (trimmed.startsWith("# ")) return { kind: "h1" };
  const meta = trimmed.match(/^-\s*\*\*([^:*]+):\*\*/);
  if (meta) return { kind: "meta", field: meta[1].trim().toLowerCase() };
  return { kind: "payload" };
}

/** A marker line is permissible only in the narrow placeholder shapes the
 *  repair legs are allowed to produce: a TBD item/paragraph or an H1. */
function isNarrowPlaceholderLine(line: string): boolean {
  if (!line.includes(MARKER)) return false;
  const t = line.trim();
  if (/^#\s/.test(t) && !/^##/.test(t)) return true; // inserted "Untitled" H1
  return /^(-\s*\[[ xX]?\]\s*)?TBD\b/.test(t);
}

/** Annotated line: classification + whether it sits inside the Metadata
 *  section (metadata bullets outside it are payload, e.g. pasted notes). */
interface AnnotatedLine {
  raw: string;
  cls: LineClass;
  inMetadata: boolean;
}

function annotate(lines: string[]): AnnotatedLine[] {
  const out: AnnotatedLine[] = [];
  let section: string | null = null;
  for (const raw of lines) {
    const cls = classifyLine(raw);
    if (cls.kind === "heading") section = cls.name;
    out.push({ raw, cls, inMetadata: section === "metadata" });
  }
  return out;
}

function isEnvelopeMeta(a: AnnotatedLine): boolean {
  return a.cls.kind === "meta" && a.inMetadata && ENVELOPE_FIELDS.has(a.cls.field);
}

export interface RepairGuardResult {
  ok: boolean;
  violations: string[];
}

function excerpt(line: string): string {
  const t = line.trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/**
 * Verify that `repaired` differs from `original` only by permitted envelope
 * changes and narrow placeholder insertions.
 *
 * Rules enforced:
 * - Every original line (INCLUDING blank lines) must appear with identical
 *   content, in order, in the repaired text. Exceptions: the H1 line and
 *   Priority/Effort/Status bullets INSIDE the Metadata section may be
 *   REPLACED (H1 only as a punctuation-preserving reformat; envelope values
 *   only when a same-field note line preserves provenance).
 * - Every repaired line not matched to an original line must be one of:
 *   an envelope bullet inside Metadata that gates or is note-covered, a
 *   note/provenance bullet inside Metadata, a narrow TBD placeholder line,
 *   an insertable canonical section heading the original did not have, an
 *   H1 when the original had none (or its punctuation-preserving reformat),
 *   or a blank line ADJACENT to another permissible insertion or heading.
 * - Deletions, reorderings, and paraphrases of payload are violations.
 */
export function verifyRepairIsAdditive(original: string, repaired: string): RepairGuardResult {
  const o = annotate(original.split(/\r?\n/));
  const r = annotate(repaired.split(/\r?\n/));
  const violations: string[] = [];

  const canonicalH1 = (line: string): string =>
    line
      .replace(/^\s*#\s*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const originalHeadings = new Set<string>();
  const originalH1Canonicals = new Set<string>();
  const originalEnvelopeFields = new Set<string>();
  let originalHasH1 = false;
  for (const a of o) {
    if (a.cls.kind === "heading") originalHeadings.add(a.cls.name);
    if (a.cls.kind === "h1") {
      originalHasH1 = true;
      originalH1Canonicals.add(canonicalH1(a.raw));
    }
    if (isEnvelopeMeta(a)) originalEnvelopeFields.add((a.cls as { field: string }).field);
  }

  /** A same-field note line exists somewhere in the repaired metadata. */
  const hasFieldNote = (field: string): boolean =>
    r.some((a) => a.cls.kind === "meta" && a.inMetadata && a.cls.field === `${field}-note`);

  const isPermissibleInsertion = (a: AnnotatedLine): boolean => {
    if (isNarrowPlaceholderLine(a.raw)) return true;
    if (a.cls.kind === "meta" && a.inMetadata) {
      const field = a.cls.field;
      if (NOTE_FIELDS.has(field)) return true;
      if (ENVELOPE_FIELDS.has(field)) {
        // An inserted or replaced envelope value must be auditable: either
        // the value itself carries the marker (gates the task) or a
        // same-field note line records what happened.
        return a.raw.includes(MARKER) || hasFieldNote(field);
      }
      return false;
    }
    if (a.cls.kind === "heading") {
      return INSERTABLE_HEADINGS.has(a.cls.name) && !originalHeadings.has(a.cls.name);
    }
    if (a.cls.kind === "h1") {
      // New H1 when none existed, or a punctuation-only reformat of the
      // original (separator fix). A retitle is NOT permissible.
      return !originalHasH1 || originalH1Canonicals.has(canonicalH1(a.raw));
    }
    return false;
  };

  /** Blank insertions are permissible only next to another permissible
   *  insertion or an inserted heading (formatting around placeholders). */
  const insertionRunPermissible = (start: number, end: number): boolean => {
    let sawViolation = false;
    for (let idx = start; idx < end; idx++) {
      const a = r[idx];
      if (a.cls.kind === "blank") continue;
      if (!isPermissibleInsertion(a)) {
        violations.push(`unexpected inserted or altered line: "${excerpt(a.raw)}"`);
        sawViolation = true;
      }
    }
    return !sawViolation;
  };

  let j = 0;
  for (const oa of o) {
    // Find the exact original line content at or after the current position.
    let k = -1;
    for (let idx = j; idx < r.length; idx++) {
      if (r[idx].raw === oa.raw) {
        k = idx;
        break;
      }
    }

    if (k !== -1) {
      insertionRunPermissible(j, k);
      j = k + 1;
      continue;
    }

    // Original line is gone. Only true envelope lines may be replaced.
    if (oa.cls.kind === "h1") {
      const reformatted = r.some(
        (a) => a.cls.kind === "h1" && canonicalH1(a.raw) === canonicalH1(oa.raw),
      );
      if (!reformatted) {
        violations.push(`H1 removed or retitled: "${excerpt(oa.raw)}"`);
      }
      continue;
    }
    if (isEnvelopeMeta(oa)) {
      const field = (oa.cls as { field: string }).field;
      const replacement = r.find(
        (a) => a.cls.kind === "meta" && a.inMetadata && a.cls.field === field,
      );
      if (!replacement) {
        violations.push(`envelope line removed without replacement: "${excerpt(oa.raw)}"`);
      } else if (!replacement.raw.includes(MARKER) && !hasFieldNote(field)) {
        violations.push(
          `envelope value replaced without provenance (no ${field}-note and no marker): "${excerpt(replacement.raw)}"`,
        );
      }
      continue;
    }

    violations.push(`payload line removed or altered: "${excerpt(oa.raw)}"`);
  }

  // Everything after the last matched original line must be permissible.
  insertionRunPermissible(j, r.length);

  return { ok: violations.length === 0, violations };
}
