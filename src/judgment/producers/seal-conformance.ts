// ─── Producer D: Sealed Change-Set Conformance (TASK-1312) ─────────
// Post-commit classification of the sealed change-set against the
// sandbox config and the verification-machinery sets. Outcome
// verification: it does not matter HOW a file was written (Write tool,
// bash redirect, `mv`) — what changed in the tree is the truth.
//
// HONESTY (round-1 mandated): v1 is OBSERVATIONAL. It runs after the
// sealer commits (the sealer commits first, then computes the diff —
// output-snapshot.ts) and verification has already executed against the
// worktree by then, so this producer does NOT mitigate in-run tampering.
// Resume paths also reload worktree policy before any future seal-time
// gate could fire. The enforcement points — a pre-verification integrity
// check, resume-time validation of persisted conformance facts, and
// conformance validation on checkpoint commit-skip — are designed in the
// TASK-1312 spec and built in the wiring slice. This producer's
// contribution is the durable fact stream those checks will consume.
//
// Tier-S (machinery, candidate `machinery_tamper` safety fact): the
// files that DECIDE whether work passed. Tier-R (verification-
// transitive, human_review): files verification commands execute through
// (package.json scripts, jest/tsconfig/eslint configs, workflows) —
// these are ALSO legitimate work targets, so they flag, never stop.

import type { AdapterSandboxConfig } from "../../core/types.js";

export type SealConformanceClass =
  | "machinery_tier_s"
  | "verification_tier_r"
  | "denied_path"
  | "outside_writable";

export interface SealConformanceFact {
  kind: "seal_conformance_path";
  path: string;
  /** Git name-status code for the change (A/M/D/R/C...). */
  status: string;
  classification: SealConformanceClass;
  candidateSafetyCode?: "machinery_tamper";
}

export interface SealConformanceSummary {
  tierSCount: number;
  tierRCount: number;
  deniedPathCount: number;
  outsideWritableCount: number;
  cleanCount: number;
  facts: SealConformanceFact[];
}

export interface SealConformanceInput {
  /** Changed paths from the sealed name-status set. */
  changedFiles: Array<{ path: string; status: string }>;
  sandbox: AdapterSandboxConfig;
  /**
   * Repo-relative prefix identifying the active task's spec file
   * (e.g. "docs/tasks/TASK-1312" — filenames carry slug suffixes, so
   * prefix matching is the reliable form).
   */
  activeSpecPrefix?: string;
}

/** Tier-S machinery: exported as the single source of truth (TASK-1313
 * machinery-integrity and the deniedPaths defaults consume the same set). */
export const TIER_S_EXACT_PATHS = [
  ".quack/adapter.json",
  ".quack/verify.js",
  ".quack/judge-criteria.md",
  ".quack/conventions.md",
] as const;

export const TIER_S_PREFIX_PATHS = [".quack/convention-checks/", ".quack/templates/"] as const;

const TIER_S_EXACT = new Set<string>(TIER_S_EXACT_PATHS);

const TIER_S_PREFIXES = [...TIER_S_PREFIX_PATHS];

const TIER_R_EXACT = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

const TIER_R_PREFIXES = [".github/workflows/"];

const TIER_R_PATTERNS = [
  /^jest\.config\.(js|ts|mjs|cjs|json)$/,
  /^tsconfig[^/]*\.json$/,
  /^\.eslintrc(\.[^/]+)?$/,
  /^eslint\.config\.(js|ts|mjs|cjs)$/,
];

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Active-spec prefix match with an id boundary (round-2: the prefix
 * "docs/tasks/TASK-131" must match "TASK-131-slug.md" and "TASK-131.md"
 * but never "TASK-1312-*"): the char after the prefix must be a
 * separator, never an id digit continuation.
 */
function matchesActiveSpec(p: string, prefix: string): boolean {
  if (!p.startsWith(prefix)) return false;
  if (p.length === prefix.length) return true;
  return /[-.]/.test(p.charAt(prefix.length));
}

function classify(
  filePath: string,
  sandbox: AdapterSandboxConfig,
  activeSpecPrefix?: string,
): SealConformanceClass | undefined {
  const p = normalize(filePath);
  // Fixed machinery/verification sets match case-insensitively: Windows
  // filesystems are case-insensitive, so `.QUACK/adapter.json` IS the
  // adapter there (round-2 case-evasion closure). The rare cost is a
  // false Tier-S/R flag for a genuinely distinct-cased path on Linux —
  // acceptable for an observational producer.
  const pLower = p.toLowerCase();

  if (
    TIER_S_EXACT.has(pLower) ||
    TIER_S_PREFIXES.some((prefix) => pLower.startsWith(prefix)) ||
    (activeSpecPrefix !== undefined &&
      activeSpecPrefix.length > 0 &&
      matchesActiveSpec(pLower, normalize(activeSpecPrefix).toLowerCase()))
  ) {
    return "machinery_tier_s";
  }

  if (
    TIER_R_EXACT.has(pLower) ||
    TIER_R_PREFIXES.some((prefix) => pLower.startsWith(prefix)) ||
    TIER_R_PATTERNS.some((pattern) => pattern.test(pLower))
  ) {
    return "verification_tier_r";
  }

  // Same semantics as the Write/Edit guard (bash-guard.ts): exact match
  // or prefix for denied, prefix for writable.
  for (const denied of sandbox.deniedPaths) {
    if (p === denied || p.startsWith(denied)) return "denied_path";
  }
  if (sandbox.writablePaths.length > 0) {
    const writable = sandbox.writablePaths.some((prefix) => p.startsWith(prefix));
    if (!writable) return "outside_writable";
  }
  return undefined;
}

/**
 * Classify a sealed change-set. Pure; deterministic; never throws.
 */
export function evaluateSealConformance(input: SealConformanceInput): SealConformanceSummary {
  const facts: SealConformanceFact[] = [];
  let clean = 0;

  for (const file of input.changedFiles) {
    const classification = classify(file.path, input.sandbox, input.activeSpecPrefix);
    if (classification === undefined) {
      clean++;
      continue;
    }
    facts.push({
      kind: "seal_conformance_path",
      path: normalize(file.path),
      status: file.status,
      classification,
      ...(classification === "machinery_tier_s"
        ? { candidateSafetyCode: "machinery_tamper" as const }
        : {}),
    });
  }

  return {
    tierSCount: facts.filter((f) => f.classification === "machinery_tier_s").length,
    tierRCount: facts.filter((f) => f.classification === "verification_tier_r").length,
    deniedPathCount: facts.filter((f) => f.classification === "denied_path").length,
    outsideWritableCount: facts.filter((f) => f.classification === "outside_writable").length,
    cleanCount: clean,
    facts,
  };
}
