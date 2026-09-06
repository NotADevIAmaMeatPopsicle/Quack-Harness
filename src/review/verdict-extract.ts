// ─── Review Verdict Extraction ──────────────────────────────────────
// 3-strategy JSON extraction + validation for reviewer output (TASK-1305).
//
// This is a deliberate third local copy of the extraction approach used by
// extractJudgeJson (llm-judge.ts) and extractBlueprintJson (blueprint-agent.ts).
// Refactoring those call sites to share a helper is an explicit non-goal of
// TASK-1305 (regression risk for zero behavior gain).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewAnchorsAudit, ReviewerFinding, ReviewVerdict } from "./reviewer-types.js";

/** The validated payload extracted from reviewer output. */
export interface ExtractedReview {
  verdict: ReviewVerdict;
  findings: ReviewerFinding[];
  confidence?: number;
  summary: string;
}

const VALID_SEVERITIES = new Set(["blocking", "should_fix", "nit"]);

/**
 * Normalize a candidate verdict string. Accepts case variants and the
 * manual loop's spaced form ("FIX FIRST" / "fix-first") for FIX_FIRST.
 */
function normalizeVerdict(value: unknown): ReviewVerdict | null {
  if (typeof value !== "string") return null;
  const upper = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (upper === "SHIP" || upper === "AMEND" || upper === "FIX_FIRST") {
    return upper;
  }
  return null;
}

/** Normalize a raw findings array; drop entries without a usable summary. */
function normalizeFindings(raw: unknown): ReviewerFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: ReviewerFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (summary.length === 0) continue;

    const severityRaw = typeof obj.severity === "string" ? obj.severity.trim().toLowerCase() : "";
    const severity = (
      VALID_SEVERITIES.has(severityRaw) ? severityRaw : "should_fix"
    ) as ReviewerFinding["severity"];

    const finding: ReviewerFinding = { severity, summary };
    if (typeof obj.detail === "string" && obj.detail.trim().length > 0) {
      finding.detail = obj.detail;
    }
    if (Array.isArray(obj.anchors)) {
      const anchors = obj.anchors.filter(
        (a): a is string => typeof a === "string" && a.trim().length > 0,
      );
      if (anchors.length > 0) finding.anchors = anchors;
    }
    findings.push(finding);
  }
  return findings;
}

/** Validate a parsed object into an ExtractedReview, or null. */
function validateReview(obj: unknown): ExtractedReview | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;

  const verdict = normalizeVerdict(record.verdict);
  if (!verdict) return null;

  const findings = normalizeFindings(record.findings);

  const result: ExtractedReview = {
    verdict,
    findings,
    summary:
      typeof record.summary === "string" && record.summary.trim().length > 0
        ? record.summary
        : verdict,
  };

  if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) {
    result.confidence = Math.min(1, Math.max(0, record.confidence));
  }

  return result;
}

/**
 * Find the index of the closing brace matching the opening brace at `start`,
 * skipping brace characters inside JSON strings. Returns -1 if unbalanced.
 * (String-aware walker; mirrors blueprint-agent.ts:244-278.)
 */
function findBalancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

/**
 * Extract a validated review from reviewer output that may contain markdown,
 * prose, or multiple JSON-like blocks:
 * 1. Direct JSON.parse of the full text
 * 2. Every ```json code fence
 * 3. Balanced brace blocks containing "verdict"
 * Returns null when nothing validates (callers map to parse_failed).
 */
export function extractReviewResult(text: string): ExtractedReview | null {
  // Strategy 1: direct parse
  try {
    const direct = validateReview(JSON.parse(text));
    if (direct) return direct;
  } catch {
    /* continue */
  }

  // Strategy 2: fenced blocks (all of them)
  const fenceMatches = text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g);
  for (const fenceMatch of fenceMatches) {
    try {
      const parsed = validateReview(JSON.parse(fenceMatch[1].trim()));
      if (parsed) return parsed;
    } catch {
      /* continue */
    }
  }

  // Strategy 3: balanced objects containing "verdict"
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    const end = findBalancedJsonObjectEnd(text, i);
    if (end === -1) continue;

    const candidate = text.slice(i, end + 1);
    if (!candidate.includes('"verdict"')) continue;

    try {
      const parsed = validateReview(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      /* try next block */
    }
  }

  return null;
}

/**
 * Check findings' file anchors against disk under projectRoot. A `:line`
 * suffix is stripped before the existence check. Distinct paths only.
 * This makes the citation-paraphrase hazard visible to the caller; it never
 * overrides a verdict here (gate policy belongs to the gate, TASK-1307).
 */
export function auditFindingAnchors(
  findings: ReviewerFinding[],
  projectRoot: string,
): ReviewAnchorsAudit {
  const distinct = new Set<string>();
  for (const finding of findings) {
    for (const anchor of finding.anchors ?? []) {
      const filePart = anchor.trim().replace(/:\d+(?:-\d+)?$/, "");
      if (filePart.length > 0) distinct.add(filePart);
    }
  }

  const missing: string[] = [];
  for (const p of distinct) {
    // existsSync can THROW on malformed paths (e.g. embedded NUL bytes from a
    // garbled reviewer citation) — a thrown check counts as missing, it must
    // never escape into the runner's settle path (round-2 finding 1).
    let exists = false;
    try {
      exists = fs.existsSync(path.resolve(projectRoot, p));
    } catch {
      exists = false;
    }
    if (!exists) {
      missing.push(p);
    }
  }

  return { total: distinct.size, missing };
}
