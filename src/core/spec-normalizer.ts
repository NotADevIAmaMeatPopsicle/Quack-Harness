// ─── Spec Normalizer ────────────────────────────────────────────────
// Deterministic, intent-safe repair for task specs that fail to parse.
//
// Design contract (see docs/SPEC_REPAIR.md):
// - ENVELOPE only: may normalize/insert metadata fields (Priority, Effort,
//   Status), fix the H1 separator, and append required sections as explicit
//   TBD placeholders. It must NEVER alter payload content the submitter
//   wrote (problem statement, criteria text, notes, anything else).
// - Never invents substance. Where a value cannot be derived from what the
//   submitter wrote, it inserts a default or TBD carrying the repair
//   placeholder marker; the readiness gate and the dispatcher treat any
//   unresolved marker as NOT dispatchable. Repair promotes a spec from
//   invisible (unparseable) to tracked-but-blocked, never to dispatchable.
// - Every change is recorded in a "Repaired" provenance metadata line and
//   returned as a structured action list.
// - No LLM involved. The LLM repair leg (spec-repair-agent) runs only after
//   this normalizer gives up, and its output is checked by the same
//   additive-only guard (see core/repair-guard.ts).

import { parseTaskFile, TaskParseError } from "./task-parser.js";
import {
  TASK_STATUSES,
  TASK_STATUS_ALIASES,
  normalizeTaskStatus,
  type TaskStatus,
} from "./task-status.js";
import { verifyRepairIsAdditive } from "./repair-guard.js";

/**
 * Marker embedded in every value the normalizer had to invent (defaults and
 * TBD placeholders). The readiness gate fails and the dispatcher refuses any
 * spec that still contains this marker, so repaired-with-defaults specs are
 * tracked but never dispatchable until a human resolves them.
 */
export const REPAIR_PLACEHOLDER_MARKER = "(repair placeholder)";

/** Metadata field used for repair provenance. */
export const REPAIRED_FIELD = "Repaired";

/** True when a spec still contains unresolved repair placeholders, or an
 *  envelope metadata value (Priority/Effort/Status) that is itself a
 *  TBD/placeholder variant. The second clause exists so a repair leg (or a
 *  hand edit) cannot produce a dispatchable spec by writing "TBD" without
 *  the canonical marker; TBD envelope values always need a human confirm. */
export function hasUnresolvedRepairMarkers(content: string | undefined | null): boolean {
  if (!content) return false;
  if (content.includes(REPAIR_PLACEHOLDER_MARKER)) return true;
  const envelopeValue = /^\s*-\s*\*\*(Priority|Effort|Status):\*\*\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = envelopeValue.exec(content)) !== null) {
    const value = m[2].trim();
    if (/(^|\s)TBD\b/i.test(value) || /placeholder/i.test(value)) return true;
  }
  return false;
}

export interface NormalizeResult {
  /** Whether any change was made to the content. */
  changed: boolean;
  /** The (possibly) repaired content. Equal to input when changed=false. */
  content: string;
  /** Machine-readable action keys describing every change made. */
  actions: string[];
  /** True when the repaired content parses successfully. */
  resolved: boolean;
  /** The remaining parse error when resolved=false. */
  parseError?: string;
}

export interface NormalizeOptions {
  /** Task id derived from the filename; enables H1 insertion when absent. */
  taskIdHint?: string;
  /** Injectable date (YYYY-MM-DD) for deterministic provenance in tests. */
  now?: string;
}

// Status values the normalizer maps beyond the parser's built-in aliases.
// Only unambiguous mappings belong here; anything else stays unresolved
// because guessing a status reinterprets the submitter's meaning.
const EXTENDED_STATUS_ALIASES: Readonly<Record<string, TaskStatus>> = {
  TODO: "BACKLOG",
  OPEN: "BACKLOG",
  NEW: "BACKLOG",
  DONE: "COMPLETE",
  WIP: "IN_PROGRESS",
  "READY FOR SCOPING": "BACKLOG",
};

const PRIORITY_CANONICAL = ["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"] as const;

const PRIORITY_ALIASES: Readonly<Record<string, string>> = {
  P0: "P0-CRITICAL",
  P1: "P1-HIGH",
  P2: "P2-MEDIUM",
  P3: "P3-LOW",
  "P0-BLOCKER": "P0-CRITICAL",
  BLOCKER: "P0-CRITICAL",
  CRITICAL: "P0-CRITICAL",
  HIGH: "P1-HIGH",
  MEDIUM: "P2-MEDIUM",
  LOW: "P3-LOW",
};

const MAX_FIX_ITERATIONS = 12;

/**
 * Attempt to deterministically repair a task spec that fails to parse.
 *
 * Iteratively parses, dispatches one targeted fix per parse error, and
 * re-parses, until the spec parses, no fix applies, or the same error
 * repeats. Finishes by self-checking the result with the additive-only
 * repair guard; a guard violation (normalizer bug) returns unresolved.
 */
export function normalizeSpec(content: string, options: NormalizeOptions = {}): NormalizeResult {
  const original = content;
  // Work on LF internally; the dominant original EOL is restored on output
  // so a CRLF spec does not get rewritten wholesale (logical-line contract).
  const usesCrlf = content.includes("\r\n");
  const actions: string[] = [];
  let current = content.replace(/\r\n/g, "\n");
  let lastError = "";

  for (let i = 0; i < MAX_FIX_ITERATIONS; i++) {
    let errorMessage: string;
    try {
      parseTaskFile(current);
      // Parses. Stamp provenance if we changed anything, then verify.
      return finalize(original, current, actions, options, usesCrlf);
    } catch (err) {
      if (!(err instanceof TaskParseError)) {
        return unresolved(original, current, actions, String(err));
      }
      errorMessage = err.message;
    }

    if (errorMessage === lastError) {
      // The applied fix did not clear the error; stop rather than loop.
      return unresolved(original, current, actions, errorMessage);
    }
    lastError = errorMessage;

    const next = applyOneFix(current, errorMessage, actions, options);
    if (next === null) {
      return unresolved(original, current, actions, errorMessage);
    }
    current = next;
  }

  return unresolved(original, current, actions, lastError || "fix iteration limit reached");
}

// ─── Fix dispatch ───────────────────────────────────────────────────

/** Apply a single targeted fix for the given parse error, or null when the
 *  error class is not deterministically repairable. */
function applyOneFix(
  content: string,
  errorMessage: string,
  actions: string[],
  options: NormalizeOptions,
): string | null {
  if (errorMessage.includes("Missing required H1 heading")) {
    return fixMissingH1(content, actions, options);
  }
  if (errorMessage.includes("H1 heading does not match expected format")) {
    return fixH1Separator(content, actions);
  }
  if (errorMessage.includes("Missing required metadata field: Priority")) {
    return insertMetadataField(
      content,
      "Priority",
      "P2-MEDIUM",
      `priority missing in submission; defaulted to P2-MEDIUM by spec repair ${REPAIR_PLACEHOLDER_MARKER}; confirm before dispatch`,
      "priority-defaulted",
      actions,
    );
  }
  if (errorMessage.includes("Invalid priority value")) {
    return fixPriorityValue(content, actions);
  }
  if (errorMessage.includes("Missing required metadata field: Effort")) {
    return insertMetadataField(
      content,
      "Effort",
      `TBD ${REPAIR_PLACEHOLDER_MARKER}`,
      null,
      "effort-defaulted",
      actions,
    );
  }
  if (errorMessage.includes("Missing required metadata field: Status")) {
    return insertMetadataField(
      content,
      "Status",
      "BACKLOG",
      `status missing in submission; defaulted to BACKLOG by spec repair ${REPAIR_PLACEHOLDER_MARKER}; confirm before dispatch`,
      "status-defaulted",
      actions,
    );
  }
  if (errorMessage.includes("Invalid status value")) {
    return fixStatusValue(content, actions);
  }
  if (errorMessage.includes("Missing required section: Problem Statement")) {
    return appendSection(
      content,
      "Problem Statement",
      `TBD ${REPAIR_PLACEHOLDER_MARKER}: the original submission did not include a problem statement; the submitter must fill this in.`,
      "problem-statement-placeholder",
      actions,
    );
  }
  if (errorMessage.includes("Missing required field: Success Criteria")) {
    return appendSection(
      content,
      "Success Criteria",
      `- [ ] TBD ${REPAIR_PLACEHOLDER_MARKER}: submitter must define real success criteria`,
      "success-criteria-placeholder",
      actions,
    );
  }
  if (errorMessage.includes("Missing required field: Testing Requirements")) {
    return appendSection(
      content,
      "Testing Requirements",
      `- [ ] TBD ${REPAIR_PLACEHOLDER_MARKER}: submitter must define real testing requirements`,
      "testing-requirements-placeholder",
      actions,
    );
  }
  return null;
}

// ─── Individual fixes ───────────────────────────────────────────────

function fixMissingH1(
  content: string,
  actions: string[],
  options: NormalizeOptions,
): string | null {
  const hint = options.taskIdHint?.trim();
  if (!hint) return null;
  // Only when no H1 exists at all; a malformed H1 is a different error.
  const lines = content.split(/\r?\n/);
  const hasH1 = lines.some((l) => l.trim().startsWith("# ") && !l.trim().startsWith("## "));
  if (hasH1) return null;
  actions.push("h1-inserted");
  return [`# ${hint}: Untitled ${REPAIR_PLACEHOLDER_MARKER}`, "", ...lines].join("\n");
}

function fixH1Separator(content: string, actions: string[]): string | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("# ") || trimmed.startsWith("## ")) continue;
    // "# TASK-123 Add feature" (id followed by title with no separator)
    const m = trimmed.match(/^#\s+((?:TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3}))\s+(?![:—–-])(.+)$/);
    if (m) {
      lines[i] = `# ${m[1]}: ${m[2].trim()}`;
      actions.push("h1-separator-fixed");
      return lines.join("\n");
    }
    return null; // H1 exists but is not a mechanically fixable shape.
  }
  return null;
}

/** Locate the metadata section heading line index, or -1. */
function findMetadataHeadingIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().toLowerCase().replace(/\s+/g, " ");
    if (
      t === "## metadata" ||
      t.startsWith("## metadata (") ||
      t.startsWith("## metadata:") ||
      t.startsWith("## metadata -")
    ) {
      return i;
    }
  }
  return -1;
}

/** Index AFTER the last metadata bullet in the metadata section. */
function findMetadataInsertIndex(lines: string[], headingIndex: number): number {
  let insertAt = headingIndex + 1;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("## ")) break;
    if (t.startsWith("- ")) insertAt = i + 1;
    else if (t === "") {
      // keep scanning; blank lines inside metadata are fine
    } else if (insertAt === headingIndex + 1) {
      // non-bullet text right under the heading; insert after it
      insertAt = i + 1;
    }
  }
  return insertAt;
}

/** Ensure a metadata section exists; returns lines + heading index. */
function ensureMetadataSection(
  lines: string[],
  actions: string[],
): { lines: string[]; headingIndex: number } {
  let idx = findMetadataHeadingIndex(lines);
  if (idx !== -1) return { lines, headingIndex: idx };

  // Insert after the H1 line (and its following blank), or at the top.
  let h1 = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("# ") && !t.startsWith("## ")) {
      h1 = i;
      break;
    }
  }
  const insertAt = h1 === -1 ? 0 : h1 + 1;
  const updated = [...lines];
  updated.splice(insertAt, 0, "", "## Metadata");
  actions.push("metadata-section-inserted");
  idx = findMetadataHeadingIndex(updated);
  return { lines: updated, headingIndex: idx };
}

function insertMetadataField(
  content: string,
  field: string,
  value: string,
  note: string | null,
  actionKey: string,
  actions: string[],
): string {
  const ensured = ensureMetadataSection(content.split(/\r?\n/), actions);
  const lines = ensured.lines;
  const insertAt = findMetadataInsertIndex(lines, ensured.headingIndex);
  const inserted = [`- **${field}:** ${value}`];
  if (note) inserted.push(`- **${field}-Note:** ${note}`);
  lines.splice(insertAt, 0, ...inserted);
  actions.push(actionKey);
  return lines.join("\n");
}

/** Extract a canonical value from the start of a prose metadata value.
 *  Returns null when no known token leads the value.
 *
 *  The remainder after the token must be an ADMINISTRATIVE suffix: empty, a
 *  parenthetical, a date, or annotation text introduced by a separator
 *  (+ - : ; , / . or an em/en dash, the shapes real specs use, e.g.
 *  "COMPLETE — SHIPPED 2026-05-24 (sha)", "COMPLETE. VERIFIED 2026-06-22",
 *  "COMPLETE 2026-05-26 — ADDED"). Anything else, e.g. "READY? awaiting
 *  legal approval", is refused rather than normalized: extracting a
 *  canonical value there would be a semantic guess presented as a
 *  meaning-preserving cleanup (cross-model review findings 5/6). */
function extractLeadingToken(
  rawValue: string,
  candidates: ReadonlyArray<readonly [name: string, canonical: string]>,
): { canonical: string; matched: string } | null {
  const trimmed = rawValue.trim();
  const upper = trimmed.toUpperCase();
  const ADMIN_SUFFIX = /^\s*($|[(+;:,/.–—-]|\d{4}-\d{2}-\d{2})/;
  // Longest candidate names first so "P1-HIGH" wins over "P1".
  const sorted = [...candidates].sort((a, b) => b[0].length - a[0].length);
  for (const [name, canonical] of sorted) {
    if (!upper.startsWith(name)) continue;
    const remainder = trimmed.slice(name.length);
    if (ADMIN_SUFFIX.test(remainder)) {
      return { canonical, matched: name };
    }
  }
  return null;
}

/** [start, end) line range of the Metadata section body, or null. Scoping
 *  every value read/rewrite here means a metadata-shaped bullet pasted into
 *  payload prose (e.g. a customer note quoting "- **Status:** ...") can
 *  never be read or rewritten by the normalizer. */
function metadataSectionRange(lines: string[]): { start: number; end: number } | null {
  const headingIndex = findMetadataHeadingIndex(lines);
  if (headingIndex === -1) return null;
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start: headingIndex + 1, end };
}

function rewriteMetadataValue(
  content: string,
  field: string,
  newValue: string,
  note: string | null,
): string | null {
  const lines = content.split(/\r?\n/);
  const range = metadataSectionRange(lines);
  if (!range) return null;
  const pattern = new RegExp(`^(\\s*-\\s*\\*\\*${field}:\\*\\*\\s*)(.+)$`, "i");
  for (let i = range.start; i < range.end; i++) {
    const m = lines[i].match(pattern);
    if (!m) continue;
    lines[i] = `${m[1]}${newValue}`;
    if (note) lines.splice(i + 1, 0, `- **${field}-Note:** ${note}`);
    return lines.join("\n");
  }
  return null;
}

function getMetadataValue(content: string, field: string): string | null {
  const lines = content.split(/\r?\n/);
  const range = metadataSectionRange(lines);
  if (!range) return null;
  const pattern = new RegExp(`^\\s*-\\s*\\*\\*${field}:\\*\\*\\s*(.+)$`, "i");
  for (let i = range.start; i < range.end; i++) {
    const m = lines[i].match(pattern);
    if (m) return m[1].trim();
  }
  return null;
}

function fixPriorityValue(content: string, actions: string[]): string | null {
  const raw = getMetadataValue(content, "Priority");
  if (raw === null) return null;

  const candidates: Array<readonly [string, string]> = [
    ...PRIORITY_CANONICAL.map((p) => [p, p] as const),
    ...Object.entries(PRIORITY_ALIASES).map(([k, v]) => [k, v] as const),
  ];
  const hit = extractLeadingToken(raw, candidates);
  if (hit) {
    const note =
      raw.toUpperCase() === hit.canonical
        ? null
        : `original priority "${raw}" normalized to ${hit.canonical} by spec repair`;
    const updated = rewriteMetadataValue(content, "Priority", hit.canonical, note);
    if (updated) {
      actions.push("priority-extracted");
      return updated;
    }
    return null;
  }

  // No recognizable token leads the value; default with a gating marker but
  // keep the submitter's original text in the note, nothing is lost.
  const updated = rewriteMetadataValue(
    content,
    "Priority",
    "P2-MEDIUM",
    `original priority "${raw}" was not recognized; defaulted to P2-MEDIUM by spec repair ${REPAIR_PLACEHOLDER_MARKER}; confirm before dispatch`,
  );
  if (updated) {
    actions.push("priority-defaulted");
    return updated;
  }
  return null;
}

function fixStatusValue(content: string, actions: string[]): string | null {
  const raw = getMetadataValue(content, "Status");
  if (raw === null) return null;

  // 1. The parser's own normalizer (aliases + trailing annotation).
  const direct = normalizeTaskStatus(raw);
  if (direct) return null; // parser would not have failed; different problem

  // 2. Extended unambiguous aliases on the whole value.
  const upperWhole = raw.trim().toUpperCase();
  const aliasWhole = EXTENDED_STATUS_ALIASES[upperWhole];
  if (aliasWhole) {
    const updated = rewriteMetadataValue(
      content,
      "Status",
      aliasWhole,
      `original status "${raw}" normalized to ${aliasWhole} by spec repair`,
    );
    if (updated) {
      actions.push("status-normalized");
      return updated;
    }
    return null;
  }

  // 3. Leading-token extraction: "VERIFIED + MERGED TO DEV (sha)" -> VERIFIED.
  const candidates: Array<readonly [string, string]> = [
    ...TASK_STATUSES.map((s) => [s, s] as const),
    ...Object.entries(TASK_STATUS_ALIASES).map(([k, v]) => [k, v] as const),
    ...Object.entries(EXTENDED_STATUS_ALIASES).map(([k, v]) => [k, v] as const),
  ];
  const hit = extractLeadingToken(raw, candidates);
  if (hit) {
    const updated = rewriteMetadataValue(
      content,
      "Status",
      hit.canonical,
      `original status "${raw}" normalized to ${hit.canonical} by spec repair`,
    );
    if (updated) {
      actions.push("status-normalized");
      return updated;
    }
    return null;
  }

  // Anything else would be a semantic guess (the submitter wrote words we
  // cannot map to a lifecycle state); refuse rather than reinterpret.
  return null;
}

function appendSection(
  content: string,
  heading: string,
  body: string,
  actionKey: string,
  actions: string[],
): string {
  const trimmedEnd = content.replace(/\s+$/, "");
  actions.push(actionKey);
  return `${trimmedEnd}\n\n## ${heading}\n\n${body}\n`;
}

// ─── Finalization ───────────────────────────────────────────────────

function addProvenance(content: string, actions: string[], options: NormalizeOptions): string {
  if (actions.length === 0) return content;
  const date = options.now ?? new Date().toISOString().slice(0, 10);
  const value = `${date} spec-normalizer: ${actions.join(", ")}`;
  const lines = content.split(/\r?\n/);
  const headingIndex = findMetadataHeadingIndex(lines);
  if (headingIndex === -1) return content; // no metadata section: skip provenance
  const insertAt = findMetadataInsertIndex(lines, headingIndex);
  lines.splice(insertAt, 0, `- **${REPAIRED_FIELD}:** ${value}`);
  return lines.join("\n");
}

function finalize(
  original: string,
  current: string,
  actions: string[],
  options: NormalizeOptions,
  usesCrlf: boolean,
): NormalizeResult {
  if (actions.length === 0) {
    return { changed: false, content: original, actions: [], resolved: true };
  }

  const withProvenance = addProvenance(current, actions, options);

  // Self-check: the normalizer must obey its own additive-only contract.
  const guard = verifyRepairIsAdditive(original, withProvenance);
  if (!guard.ok) {
    return {
      changed: false,
      content: original,
      actions,
      resolved: false,
      parseError: `normalizer self-check failed additive-only guard: ${guard.violations.join("; ")}`,
    };
  }

  // The provenance line must not break parsing.
  try {
    parseTaskFile(withProvenance);
  } catch (err) {
    return {
      changed: false,
      content: original,
      actions,
      resolved: false,
      parseError: `repaired content failed to re-parse after provenance: ${String(err)}`,
    };
  }

  // Restore the dominant original EOL so a CRLF spec is not rewritten
  // wholesale (the guard's contract is logical-line-identical).
  const output = usesCrlf ? withProvenance.replace(/\n/g, "\r\n") : withProvenance;
  return { changed: true, content: output, actions, resolved: true };
}

function unresolved(
  original: string,
  _current: string,
  actions: string[],
  parseError: string,
): NormalizeResult {
  // Unresolved repairs never write partial changes; return the original.
  return { changed: false, content: original, actions, resolved: false, parseError };
}
