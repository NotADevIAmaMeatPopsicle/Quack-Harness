import { execSync } from "node:child_process";

import type { ValidationIntakePayload } from "./task-intake.js";

/**
 * Result shape for the evidence-quality gate.
 *
 * `verdict` is REVISE when ANY of the following holds (see Blueprint §2):
 *
 *   - `nonClaims` is empty — the TASK-1106 non-bypass rule. The submitter
 *     must enumerate what is NOT covered before the gates accept the bundle.
 *     This is the SEMANTIC layer of the empty-array policy; the Zod schema
 *     intentionally permits empty arrays at the SHAPE layer to stay
 *     equivalent with the example-side JSON Schema mirror.
 *   - No `tests[]` entry has `result === "PASS"` — Validation Intake is not
 *     a shortcut for unproven work. All-SKIP and all-FAIL both REVISE.
 *   - `branch` does not resolve on origin via `git ls-remote --heads origin <branch>`,
 *     even after one `git fetch origin` retry — protects against stale local
 *     refs and unpushed branches.
 *   - `commitRange` does not resolve via `git rev-list <range>`.
 *
 * `fetched` is true when we ran `git fetch origin` to recover from an initial
 * branch-resolution miss. Surfaced for debug / audit, not the REVISE decision.
 */
export interface EvidenceGateResult {
  verdict: "PASS" | "REVISE";
  deficiencies: string[];
  fetched?: boolean;
}

/**
 * Defense-in-depth guard mirroring `scope-hygiene-gate.ts::assertSafeCommitRange`.
 * Identical accept/reject set with the JSON Schema's `not: { pattern: "[`$;]" }`.
 */
function assertSafeCommitRange(commitRange: string): void {
  if (/[`$;]/.test(commitRange) || /[\r\n]/.test(commitRange)) {
    throw new Error(
      `commitRange must not contain shell metacharacters (backtick, $, ;) or newlines: ${JSON.stringify(commitRange)}`,
    );
  }
}

/**
 * Defense-in-depth guard for branch names. The Zod schema restricts branches
 * to `/^[\w./-]+$/` and rejects protected branches, but the gate re-checks
 * before passing the branch to git in case this function is called from a
 * path that did not run the Zod parse.
 */
function assertSafeBranch(branch: string): void {
  if (!/^[\w./-]+$/.test(branch)) {
    throw new Error(
      `branch must match /^[\\w./-]+$/ before git invocation: ${JSON.stringify(branch)}`,
    );
  }
}

/**
 * Returns true when `git ls-remote --heads origin <branch>` resolves to at
 * least one ref. Empty stdout means the branch is not on origin. We treat
 * any non-zero exit (network error, no remote, etc.) as "unresolved" but
 * keep the underlying error message for the deficiency reporter.
 */
function isBranchOnOrigin(projectRoot: string, branch: string): boolean {
  try {
    const output = execSync(`git ls-remote --heads origin ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * One-shot `git fetch origin` retry. Used after the first `isBranchOnOrigin`
 * miss in case the local origin refs are stale (typical mid-CI scenario where
 * the bundle was generated against a fresh push that arrived after the worker
 * cloned). Silently swallows fetch errors — the next `isBranchOnOrigin` call
 * is the authoritative check.
 */
function gitFetchOriginQuiet(projectRoot: string): void {
  try {
    execSync(`git fetch origin`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Swallow — the follow-up isBranchOnOrigin call is the source of truth.
  }
}

/**
 * Verify `commitRange` resolves locally via `git rev-list`. Returns
 * true / false rather than throwing so the gate can collect multiple
 * deficiencies in one pass.
 *
 * Implementation note: `git rev-parse --verify` rejects two-dot/three-dot
 * ranges with "Needed a single revision". `git rev-list` is the correct
 * range-validator — it exits 0 for any well-formed range (including empty
 * `HEAD..HEAD`) and 128 for unknown revisions or malformed input.
 */
function isCommitRangeResolvable(projectRoot: string, commitRange: string): boolean {
  try {
    execSync(`git rev-list ${commitRange}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the evidence-quality gate against a Zod-parsed validation-intake payload.
 *
 * Collects ALL deficiencies in a single pass (rather than short-circuiting on
 * the first failure) so the REVISE response can surface every problem at once
 * — saves the submitter a multi-round bounce.
 *
 * @param projectRoot Absolute path to the git repo being validated.
 * @param payload Zod-parsed validation-intake bundle.
 */
// Internally synchronous (execSync git ops); kept `async` so callers continue to
// `await` the gate and so the function can transparently shift to async git ops
// (e.g. simple-git) in the future without breaking the public contract.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runEvidenceGate(
  projectRoot: string,
  payload: ValidationIntakePayload,
): Promise<EvidenceGateResult> {
  assertSafeCommitRange(payload.commitRange);
  assertSafeBranch(payload.branch);

  const deficiencies: string[] = [];
  let fetched = false;

  // 1. Non-bypass rule: nonClaims must be non-empty.
  if (payload.nonClaims.length === 0) {
    deficiencies.push("evidence.nonClaims must be non-empty (TASK-1106 non-bypass rule)");
  }

  // 2. >=1 test with result === "PASS".
  const passingTests = payload.tests.filter((t) => t.result === "PASS");
  if (passingTests.length === 0) {
    deficiencies.push('evidence.tests must include at least one entry with result === "PASS"');
  }

  // 3. Branch resolves on origin (one git fetch origin retry).
  let branchResolves = isBranchOnOrigin(projectRoot, payload.branch);
  if (!branchResolves) {
    gitFetchOriginQuiet(projectRoot);
    fetched = true;
    branchResolves = isBranchOnOrigin(projectRoot, payload.branch);
  }
  if (!branchResolves) {
    deficiencies.push(
      `evidence.branch ${JSON.stringify(payload.branch)} did not resolve on origin via git ls-remote (with one git fetch origin retry)`,
    );
  }

  // 4. commitRange resolves via git rev-list.
  if (!isCommitRangeResolvable(projectRoot, payload.commitRange)) {
    deficiencies.push(
      `evidence.commitRange ${JSON.stringify(payload.commitRange)} did not resolve via git rev-list`,
    );
  }

  const verdict: "PASS" | "REVISE" = deficiencies.length > 0 ? "REVISE" : "PASS";

  return fetched ? { verdict, deficiencies, fetched: true } : { verdict, deficiencies };
}
