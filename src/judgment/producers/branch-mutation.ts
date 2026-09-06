// ─── Producer A: Protected-Branch Mutation (TASK-1312) ─────────────
// Deterministic facts about branch-mutation attempts and a shared guard
// for the dispatcher's OWN branch-deletion primitives.
//
// NOT wired into any judgment stage in this task (wiring restraint):
// facts feed evidence/event recording only. The dispatcher-side guard IS
// live — it hardens Quack's own delete primitives, not agent behavior.
//
// The protected set REUSES the existing adapter field
// `git.protectedBranches` (adapter-schema.ts) with the long-standing
// four-branch default, unioned with the adapter's base branch. Round-1
// review caught that an earlier draft would have replaced the default
// with `[baseBranch]` and silently weakened protection for dev/staging/
// prod — the union shape exists so that can never happen.

import type { AdapterGitConfig } from "../../core/types.js";
import { checkGitFloor, type GitFloorClass, type GitFloorMatch } from "../../worker/git-floor.js";

/**
 * The default protected set. Single definition for the whole codebase —
 * branch-manager's cleanup policy and sweep import this rather than
 * carrying their own copy.
 */
export const DEFAULT_PROTECTED_BRANCHES = ["main", "dev", "staging", "prod"];

export interface BranchMutationFact {
  kind: "branch_mutation";
  mutationClass: GitFloorClass;
  verb: string;
  targetRef?: string;
  /** Candidate code the wiring slice may promote to a safety signal. */
  candidateSafetyCode?: "protected_branch_history_rewrite" | "protected_branch_delete";
  /** The offending command segment (truncated by git-floor). */
  segment: string;
}

/**
 * Effective protected set: configured (or the shared default) unioned
 * with the base branch, deduplicated, order-preserving.
 */
export function resolveProtectedBranches(git: AdapterGitConfig): string[] {
  const configured = git.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  return [...new Set([...configured, git.baseBranch])];
}

/** Verbs whose targetless history rewrites endanger EVERY ref. */
const GLOBAL_REWRITE_VERBS = new Set(["reflog", "gc", "update-ref"]);

function candidateCodeFor(
  match: GitFloorMatch,
  protectedBranches: string[],
): BranchMutationFact["candidateSafetyCode"] {
  const targetsProtected =
    match.targetRef !== undefined &&
    protectedBranches.some(
      (branch) =>
        match.targetRef === branch ||
        match.targetRef === `refs/heads/${branch}` ||
        match.targetRef === `origin/${branch}`,
    );
  if (match.class === "branch_delete" && targetsProtected) {
    return "protected_branch_delete";
  }
  if (match.class === "history_rewrite") {
    // Round-2 precision: targetless promotion is reserved for genuinely
    // global operations (reflog expire, gc --prune, bare update-ref). A
    // force-push whose destination did not parse is NOT promoted — a
    // task-branch force-push must not masquerade as a protected-history
    // candidate.
    if (targetsProtected) return "protected_branch_history_rewrite";
    if (match.targetRef === undefined && GLOBAL_REWRITE_VERBS.has(match.verb)) {
      return "protected_branch_history_rewrite";
    }
  }
  return undefined;
}

/**
 * Classify a raw Bash command into branch-mutation facts. Pure; the
 * caller decides what to do with them (today: evidence + events only).
 */
export function classifyGitMutation(
  command: string,
  protectedBranches: string[],
): BranchMutationFact[] {
  return checkGitFloor(command).matches.map((match) => ({
    kind: "branch_mutation",
    mutationClass: match.class,
    verb: match.verb,
    ...(match.targetRef !== undefined ? { targetRef: match.targetRef } : {}),
    ...(candidateCodeFor(match, protectedBranches)
      ? { candidateSafetyCode: candidateCodeFor(match, protectedBranches) }
      : {}),
    segment: match.segment,
  }));
}

export interface BranchDeletionCheck {
  allowed: boolean;
  /** Set when refused. */
  reason?: string;
}

/**
 * The centralized deletion guard. EVERY local and remote branch deletion
 * in the dispatcher/monitor goes through this check BEFORE executing —
 * including the local delete that precedes a remote delete (round-1
 * finding: cleanupBranch deleted locally before its remote step).
 */
/**
 * Conservative branch-name validity: git ref charset without shell
 * metacharacters. Round-2 closure: a config-supplied name like
 * `x; git branch -D prod #` must fail CLOSED here — the deletion
 * primitives interpolate names into shell strings, so an exact-match
 * guard alone would pass the string through to the shell.
 */
const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function assertBranchDeletionAllowed(
  branch: string,
  protectedBranches: string[],
): BranchDeletionCheck {
  if (!VALID_BRANCH_NAME.test(branch)) {
    return {
      allowed: false,
      reason: `refusing to delete branch with invalid name ${JSON.stringify(branch)} (shell-unsafe or non-ref characters)`,
    };
  }
  const normalized = branch.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  if (protectedBranches.includes(normalized)) {
    return {
      allowed: false,
      reason: `refusing to delete protected branch "${normalized}" (protected set: ${protectedBranches.join(", ")})`,
    };
  }
  return { allowed: true };
}
