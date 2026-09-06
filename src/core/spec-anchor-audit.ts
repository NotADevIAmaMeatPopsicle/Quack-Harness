// ─── Spec anchor audit (TASK-1322) ──────────────────────────────────
// Answers one question for a task spec that may be months old: **is
// anything this spec points at still where it says it is?**
//
// Operator's framing, 2026-08-09, and it is the part that makes a bulk
// repair safe rather than reckless: before adding a `Files to Modify`
// section to 444 backlogged specs, each one has to be checked to see
// whether "the spec, schema, or other changed or moved since the task
// was created". A spec whose anchors have all drifted does not need a
// Files-to-Modify section bolted on; it needs re-reading by a human,
// and this is what tells the two apart.
//
// DELIBERATELY PURE. Every filesystem and git fact arrives through the
// `SpecAnchorFacts` resolver, so the decision logic is testable without
// a repository and the CLI owns all the I/O. That split matters here
// because the expensive part (one git query per distinct file) wants
// deduping and batching at the call site, not per spec.

/** One code reference found in a spec. */
export interface SpecAnchor {
  /** Exactly as written in the spec, for reporting. */
  raw: string;
  /** The path part, with any `:line` suffix removed. */
  file: string;
  /** The line, when the anchor named one. */
  line?: number;
}

/**
 * What the audit concluded about one anchor.
 *
 * Ordered by severity so a caller can sort on it: `file_missing` means
 * the spec points at nothing, while `file_changed` means it points at
 * something that has since moved on and may no longer say what the spec
 * assumed.
 */
export type SpecAnchorStatus =
  | "ok"
  | "file_missing"
  | "line_out_of_range"
  | "file_changed_since_spec";

export interface SpecAnchorRow {
  anchor: SpecAnchor;
  status: SpecAnchorStatus;
  detail?: string;
}

/** The facts the audit needs, supplied by the caller. */
export interface SpecAnchorFacts {
  /** Does the path exist in the working tree? */
  exists(file: string): boolean;
  /** Total lines, or undefined when unknown or unreadable. */
  lineCount(file: string): number | undefined;
  /**
   * ISO timestamp of the file's last change, or undefined when unknown.
   * The CLI supplies git's last-commit date; a caller with no git can
   * supply mtime, which is weaker but honest.
   */
  lastChangedAt(file: string): string | undefined;
}

export interface SpecAuditInput {
  specPath: string;
  markdown: string;
  /**
   * The spec's own directory, repo-relative, used to resolve anchors
   * written RELATIVE to the spec (`../../architecture/decisions/x.md`).
   *
   * Found by running the audit against the real 1283-spec backlog:
   * without this, every relative anchor resolved against the repo root,
   * did not exist there, and was reported `file_missing`. That inflated
   * the drift count and would have pushed specs into the
   * "a human must re-read this" pile for no reason, which is the number
   * an operator would actually plan around.
   *
   * Optional: a caller with only repo-root-relative anchors can omit it
   * and nothing changes.
   */
  specDir?: string;
  /** ISO timestamp the spec itself was last changed. Anchors changed
   *  AFTER this are the ones that may have drifted out from under it. */
  specChangedAt?: string;
  facts: SpecAnchorFacts;
}

export interface SpecAuditResult {
  specPath: string;
  /** The example adapter's gate requires this section; without it a spec
   *  cannot be dispatched at all. */
  hasFilesToModify: boolean;
  rows: SpecAnchorRow[];
  /** True when ANY anchor is not `ok`. The signal that a human should
   *  re-read this spec before it is repaired mechanically. */
  drifted: boolean;
  /** Counts by status, for a report that does not require re-walking. */
  summary: Record<SpecAnchorStatus, number>;
}

/**
 * Matches a source-ish path with an optional `:line` or `:line-line`.
 *
 * Requires a directory separator, which is the single most useful
 * filter: it keeps `src/foo/bar.ts` and drops prose like "the .env" or
 * "package.json" mentioned in passing. A bare filename in a sentence is
 * far more often narrative than a real anchor, and a false anchor makes
 * the whole report untrustworthy.
 */
const ANCHOR_RE = /(?:^|[\s`("'[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,9})(:(\d+)(?:-\d+)?)?/g;

/** Sections whose file references are examples rather than targets. */
const SKIPPED_HEADINGS = /^#{1,6}\s+(review rounds?|round \d|dispositions|changelog|history)/i;

/**
 * Pull every code anchor out of a spec.
 *
 * Fenced code blocks are SKIPPED. A spec routinely quotes sample code,
 * diffs and command output, and those paths are illustrative rather
 * than claims about this repository. Auditing them produces noise that
 * buries the real drift.
 */
export function extractSpecAnchors(markdown: string): SpecAnchor[] {
  const seen = new Map<string, SpecAnchor>();
  let inFence = false;
  let skipping = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine;

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^#{1,6}\s/.test(line)) {
      skipping = SKIPPED_HEADINGS.test(line);
    }
    if (skipping) continue;

    ANCHOR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ANCHOR_RE.exec(line)) !== null) {
      const file = m[1];
      const lineNo = m[3] ? Number(m[3]) : undefined;
      const raw = lineNo === undefined ? file : `${file}:${lineNo}`;
      if (!seen.has(raw)) {
        seen.set(raw, lineNo === undefined ? { raw, file } : { raw, file, line: lineNo });
      }
    }
  }

  return [...seen.values()];
}

/** Does the spec carry the section the gate requires? */
export function hasFilesToModifySection(markdown: string): boolean {
  return /^#{1,6}\s*files\s+to\s+modify\s*$/im.test(markdown);
}

/**
 * Audit one spec's anchors against the current tree.
 *
 * Status precedence is deliberate: a missing file is reported as
 * missing even if it would also be "changed", because the caller needs
 * the strongest true statement, not all of them.
 */
export function auditSpecAnchors(input: SpecAuditInput): SpecAuditResult {
  const anchors = extractSpecAnchors(input.markdown);
  const rows: SpecAnchorRow[] = [];

  for (const anchor of anchors) {
    const resolved = resolveAnchorPath(anchor.file, input.specDir);
    if (!input.facts.exists(resolved)) {
      rows.push({
        anchor,
        status: "file_missing",
        detail: "the spec points at a path that is not in the tree",
      });
      continue;
    }

    if (anchor.line !== undefined) {
      const total = input.facts.lineCount(resolved);
      if (total !== undefined && anchor.line > total) {
        rows.push({
          anchor,
          status: "line_out_of_range",
          detail: `spec cites line ${anchor.line}; the file now has ${total}`,
        });
        continue;
      }
    }

    const changedAt = input.facts.lastChangedAt(resolved);
    if (input.specChangedAt && changedAt && isAfter(changedAt, input.specChangedAt)) {
      rows.push({
        anchor,
        status: "file_changed_since_spec",
        detail: `file changed ${changedAt}, after the spec at ${input.specChangedAt}`,
      });
      continue;
    }

    rows.push({ anchor, status: "ok" });
  }

  const summary: Record<SpecAnchorStatus, number> = {
    ok: 0,
    file_missing: 0,
    line_out_of_range: 0,
    file_changed_since_spec: 0,
  };
  for (const row of rows) summary[row.status] += 1;

  return {
    specPath: input.specPath,
    hasFilesToModify: hasFilesToModifySection(input.markdown),
    rows,
    drifted: rows.some((row) => row.status !== "ok"),
    summary,
  };
}

/**
 * Resolve an anchor against the spec's directory when it is written
 * relatively, and otherwise leave it exactly as the spec wrote it.
 *
 * Normalizes `..` segments manually rather than through `node:path`,
 * because the result must be a POSIX repo-relative key that matches how
 * git reports paths, on every platform.
 */
export function resolveAnchorPath(file: string, specDir?: string): string {
  if (!specDir || !(file.startsWith("./") || file.startsWith("../"))) {
    return file;
  }
  const out: string[] = specDir.split("/").filter((p) => p.length > 0 && p !== ".");
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Refuse to climb above the repo root: a path that escapes is not
      // resolvable here and is better left as written, where it reports
      // as missing honestly rather than as some unrelated file.
      if (out.length === 0) return file;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * Timestamp comparison that refuses to guess.
 *
 * An unparseable date returns false rather than throwing or coercing to
 * NaN-compares-false-silently: a spec is not "drifted" because its
 * timestamp was malformed, and a report that invents drift is worse
 * than one that misses some.
 */
function isAfter(candidate: string, reference: string): boolean {
  const a = Date.parse(candidate);
  const b = Date.parse(reference);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}
