// ─── Producer C: Secret-Exposure Diff Scan (TASK-1312) ─────────────
// Pure two-tier secret detection over sealed agent output.
//
// Precision posture (the Intent clause governs): a false-positive hard
// stop is the exact brittleness v2 exists to kill, so the `safety` tier
// admits COMPLETE-FORMAT material only. Identifier-only hits (an AWS
// access-key id alone is an identifier, not a secret), JWT-shaped
// strings, assignments, and entropy heuristics stay `human_review`.
// Placeholder-looking matches and test-fixture paths demote one tier —
// a real secret in a test file is still a leak, so it stays VISIBLE, it
// just does not hard-stop.
//
// MASKED EVIDENCE DISCIPLINE: findings carry a masked excerpt (first 4
// chars + length). The raw match must never appear in any finding,
// event, evidence file, or log.

export type SecretTier = "safety" | "human_review";

export interface SecretFinding {
  kind: "secret";
  tier: SecretTier;
  patternId: string;
  file: string;
  /** 1-based line within the scanned content when derivable. */
  line?: number;
  /** First 4 chars + length. NEVER the raw match. */
  maskedExcerpt: string;
  demotedBy?: "placeholder" | "fixture_path";
  candidateSafetyCode?: "secret_exposure";
}

export interface SecretScanFileInput {
  /** Repo-relative path (forward slashes). */
  file: string;
  /** Text to scan: added diff lines joined, or full file content. */
  content: string;
}

export interface SecretScanSummary {
  safetyCount: number;
  humanReviewCount: number;
  findings: SecretFinding[];
}

interface PatternSpec {
  id: string;
  tier: SecretTier;
  pattern: RegExp;
}

// Safety tier: complete-format material only (round-2 tightened: the
// PEM labels must MATCH via backreference; Slack tokens need their
// numeric segments; GCP values need escaped newlines AND the end marker).
const PATTERNS: PatternSpec[] = [
  {
    id: "pem_private_key",
    tier: "safety",
    pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]{40,}?-----END \1PRIVATE KEY-----/g,
  },
  {
    id: "github_token",
    tier: "safety",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "github_pat",
    tier: "safety",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    id: "slack_token",
    tier: "safety",
    pattern: /\bxox[abprs]-\d{8,}-[A-Za-z0-9-]{8,}\b/g,
  },
  {
    id: "gcp_service_account_key",
    tier: "safety",
    pattern:
      /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----(?:\\n|[^"]){40,}?-----END PRIVATE KEY-----(?:\\n)?"/g,
  },
  // Human-review tier.
  {
    id: "aws_access_key_id",
    tier: "human_review",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "aws_secret_assignment",
    tier: "human_review",
    pattern: /aws_secret_access_key['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/gi,
  },
  {
    id: "jwt",
    tier: "human_review",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "credential_assignment",
    tier: "human_review",
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi,
  },
  {
    id: "high_entropy_base64",
    tier: "human_review",
    // Mixed-class base64-ish runs ≥ 40 chars. Hex-only runs are excluded
    // on purpose: 40/64-hex are git SHAs, which flood every diff.
    pattern:
      /\b(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}\b/g,
  },
];

const PLACEHOLDER_RE = /EXAMPLE|REDACTED|PLACEHOLDER|CHANGEME|DUMMY|SAMPLE|xxxx|0000000000|\.\.\./i;
const REPEATED_CHAR_RE = /(.)\1{7,}/;
const FIXTURE_PATH_RE = /(^|\/)(tests?|__fixtures__|__mocks__|fixtures)\/|\.(test|spec)\./i;

/** Max line distance for AWS id/secret pairing (round-2: hunk-scoped). */
const AWS_PAIR_PROXIMITY_LINES = 10;

/**
 * When an AWS access-key id and a plausible secret-key assignment appear
 * NEAR each other in the same scanned content (within
 * AWS_PAIR_PROXIMITY_LINES), the pair is treated as exposure: the
 * secret-assignment finding promotes to safety (spec S5).
 */
function pairPromoteAws(findings: SecretFinding[]): void {
  const keyIdLines = findings
    .filter((f) => f.patternId === "aws_access_key_id")
    .map((f) => f.line ?? 0);
  if (keyIdLines.length === 0) return;
  for (const finding of findings) {
    if (finding.patternId !== "aws_secret_assignment" || finding.demotedBy) continue;
    const line = finding.line ?? 0;
    const near = keyIdLines.some((idLine) => Math.abs(idLine - line) <= AWS_PAIR_PROXIMITY_LINES);
    if (near) {
      finding.tier = "safety";
      finding.candidateSafetyCode = "secret_exposure";
    }
  }
}

function mask(match: string): string {
  return `${match.slice(0, 4)}…(${match.length} chars)`;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function demotionFor(
  match: string,
  file: string,
  content: string,
  index: number,
): SecretFinding["demotedBy"] {
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const lineEnd = content.indexOf("\n", index);
  const lineText = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (PLACEHOLDER_RE.test(match) || REPEATED_CHAR_RE.test(match) || PLACEHOLDER_RE.test(lineText)) {
    return "placeholder";
  }
  if (FIXTURE_PATH_RE.test(file)) {
    return "fixture_path";
  }
  return undefined;
}

/**
 * Scan file inputs (added diff lines and/or full contents of added/
 * renamed/copied files) for secret material. Pure; deterministic.
 */
export function scanForSecrets(inputs: SecretScanFileInput[]): SecretScanSummary {
  const findings: SecretFinding[] = [];

  for (const { file, content } of inputs) {
    const fileFindings: SecretFinding[] = [];
    for (const spec of PATTERNS) {
      spec.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = spec.pattern.exec(content)) !== null) {
        const demotedBy = demotionFor(match[0], file, content, match.index);
        let tier = spec.tier;
        if (demotedBy && tier === "safety") tier = "human_review";
        fileFindings.push({
          kind: "secret",
          tier,
          patternId: spec.id,
          file,
          line: lineOf(content, match.index),
          maskedExcerpt: mask(match[0]),
          ...(demotedBy ? { demotedBy } : {}),
          ...(tier === "safety" ? { candidateSafetyCode: "secret_exposure" as const } : {}),
        });
        // Guard against zero-width loops on pathological patterns.
        if (match.index === spec.pattern.lastIndex) spec.pattern.lastIndex++;
      }
    }
    pairPromoteAws(fileFindings);
    findings.push(...fileFindings);
  }

  return {
    safetyCount: findings.filter((f) => f.tier === "safety").length,
    humanReviewCount: findings.filter((f) => f.tier === "human_review").length,
    findings,
  };
}
