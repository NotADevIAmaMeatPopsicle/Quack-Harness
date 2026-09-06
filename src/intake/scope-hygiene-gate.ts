import { execSync } from "node:child_process";

import type { ValidationIntakePayload } from "./task-intake.js";

/**
 * Result shape for the scope-hygiene gate. Mirrors the response shape returned
 * by `POST /v1/intake/tasks(/validate)` for validation-intake payloads:
 *
 *   - confirmed: files listed in payload.scope AND touched by the commit range.
 *   - claimed_but_unchanged: files listed in scope but NOT touched (scope inflation).
 *   - changed_but_unclaimed: files touched but NOT in scope AND NOT in nonClaims
 *     (scope drift).
 *
 * REVISE rules (Blueprint §2 + §6):
 *   1. claimed_but_unchanged.length > 0  → REVISE (inflation, always)
 *   2. changed_but_unclaimed.length > driftThreshold AND nonClaims is empty
 *      → REVISE (drift without disclaimer)
 *
 * The non-claims list suppresses drift — files appearing in nonClaims are
 * filtered OUT of `changed_but_unclaimed` before the threshold check, so a
 * submitter can explicitly own incidental touches (lockfile updates, generated
 * files, copy nits) without triggering REVISE.
 */
export interface ScopeHygieneResult {
  verdict: "PASS" | "REVISE";
  confirmed: string[];
  claimed_but_unchanged: string[];
  changed_but_unclaimed: string[];
  driftThreshold: number;
  reasons: string[];
}

/**
 * Defense-in-depth shell-metachar refusal. The Zod schema already rejects
 * backtick / $ / ; / newline in commitRange, but the gate re-checks before
 * invoking git in case this function is called from a path that has not run
 * the Zod parse (test harnesses, future direct callers, etc.).
 *
 * Matches the JSON Schema's `not: { pattern: "[`$;]" }` exactly. We also add
 * explicit newline rejection because the JS regex `.` does not match newlines
 * and a multi-line injection would slip past a `.test()` of the form `/[`$;]/`.
 */
function assertSafeCommitRange(commitRange: string): void {
  if (/[`$;]/.test(commitRange) || /[\r\n]/.test(commitRange)) {
    throw new Error(
      `commitRange must not contain shell metacharacters (backtick, $, ;) or newlines: ${JSON.stringify(commitRange)}`,
    );
  }
}

/**
 * Validate that `commitRange` resolves on the local git repo via
 * `git rev-list <range>`. Throws on any failure (the orchestrator
 * surfaces this as part of the evidence-gate's reason set, not the
 * scope-hygiene REVISE — the gates are kept independent).
 *
 * Implementation note: `git rev-parse --verify` rejects two-dot/three-dot
 * ranges with "Needed a single revision". `git rev-list` is the correct
 * range-validator — it exits 0 for any well-formed range (including empty
 * `HEAD..HEAD`) and 128 for unknown revisions or malformed input.
 */
function verifyCommitRangeResolvable(projectRoot: string, commitRange: string): void {
  try {
    execSync(`git rev-list ${commitRange}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `commitRange ${JSON.stringify(commitRange)} did not resolve via git rev-list: ${message}`,
    );
  }
}

/**
 * Enumerate files changed in the commit range via `git diff --name-only`.
 * Returns an empty array for an empty diff (range resolves but no changes).
 */
function listChangedFiles(projectRoot: string, commitRange: string): string[] {
  const output = execSync(`git diff --name-only ${commitRange}`, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Compute the scope-hygiene verdict for a validation-intake payload.
 *
 * Algorithm:
 *   1. Defense-in-depth: assert no shell metachars in commitRange.
 *   2. Verify the range resolves (throws if not — orchestrator surfaces).
 *   3. List changed files via `git diff --name-only <range>`.
 *   4. Compute three sets: confirmed, claimed_but_unchanged, changed_but_unclaimed.
 *      `changed_but_unclaimed` is computed AFTER removing files listed in
 *      payload.nonClaims (the suppression rule).
 *   5. Apply REVISE rules.
 *
 * @param projectRoot Absolute path to the git repo to evaluate against.
 * @param payload The validated validation-intake payload (Zod-parsed upstream).
 * @param driftThreshold Maximum allowed `changed_but_unclaimed` count before
 *                       REVISE fires when nonClaims is empty. Default 5; per-project
 *                       override via .quack/adapter.json#validationIntake.driftThreshold.
 */
// Internally synchronous (execSync git ops); kept `async` so callers continue to
// `await` the gate and so the function can transparently shift to async git ops
// (e.g. simple-git) in the future without breaking the public contract.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runScopeHygieneGate(
  projectRoot: string,
  payload: ValidationIntakePayload,
  driftThreshold: number,
): Promise<ScopeHygieneResult> {
  assertSafeCommitRange(payload.commitRange);
  verifyCommitRangeResolvable(projectRoot, payload.commitRange);

  const changedFiles = listChangedFiles(projectRoot, payload.commitRange);
  const changedSet = new Set(changedFiles);
  const scopeSet = new Set(payload.scope);
  const nonClaimsSet = new Set(payload.nonClaims);

  const confirmed: string[] = [];
  const claimed_but_unchanged: string[] = [];
  for (const claimed of payload.scope) {
    if (changedSet.has(claimed)) {
      confirmed.push(claimed);
    } else {
      claimed_but_unchanged.push(claimed);
    }
  }

  const changed_but_unclaimed: string[] = [];
  for (const changed of changedFiles) {
    if (scopeSet.has(changed)) continue;
    if (nonClaimsSet.has(changed)) continue;
    changed_but_unclaimed.push(changed);
  }

  const reasons: string[] = [];
  if (claimed_but_unchanged.length > 0) {
    reasons.push("scope_inflation");
  }
  if (changed_but_unclaimed.length > driftThreshold && payload.nonClaims.length === 0) {
    reasons.push("scope_drift_without_nonclaims");
  }

  const verdict: "PASS" | "REVISE" = reasons.length > 0 ? "REVISE" : "PASS";

  return {
    verdict,
    confirmed,
    claimed_but_unchanged,
    changed_but_unclaimed,
    driftThreshold,
    reasons,
  };
}
