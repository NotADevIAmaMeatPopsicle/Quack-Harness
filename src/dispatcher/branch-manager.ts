// ─── Branch Manager ─────────────────────────────────────────────────
// Git branch creation, push, and cleanup for task execution.
// Each task runs on an isolated branch: quack/{taskId}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { BranchCleanupOwnerOverride, BranchCleanupPolicyConfig } from "../core/types.js";
import {
  assertBranchDeletionAllowed,
  resolveProtectedBranches,
} from "../judgment/producers/branch-mutation.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { BOUND_GIT_REMOTE, runBoundGitCommand } from "./bound-git-command.js";
import {
  originPushUrlMatches,
  pullRequestUrlMatchesOrigin,
  resolveOriginGitHubRepository,
  type GitOriginIdentity,
  type GitHubRepositoryIdentity,
} from "./github-repository.js";
import { parseStatus } from "./output-snapshot.js";

const execFileAsync = promisify(execFile);

/** TASK-1313 S5: guard refusals become visible safety facts. */
function emitGuardRefusal(
  events: IEventWriter | undefined,
  taskId: string | undefined,
  branchName: string,
  site: string,
): void {
  try {
    events?.emit("safety_fact", {
      ...(taskId ? { taskId } : {}),
      origin: "dispatcher_branch_guard",
      facts: [
        {
          kind: "branch_mutation",
          mutationClass: "branch_delete",
          verb: "branch",
          targetRef: branchName,
          candidateSafetyCode: "protected_branch_delete",
          segment: site,
        },
      ],
    });
  } catch {
    // Emission is best-effort; the refusal itself already happened.
  }
}

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum output buffer (1MB) */
const MAX_BUFFER = 1024 * 1024;

/** Timeout for git commands in milliseconds (30 seconds) */
const GIT_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────────

export interface BranchResult {
  success: boolean;
  branchName: string;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  error?: string;
  mergeCommitSha?: string;
}

/**
 * Immutable evidence for a locally prepared target-branch publication.
 *
 * The caller persists this record before the remote push. A retry can then
 * distinguish the exact prepared result from an unrelated target-branch move
 * without attempting to recreate squash/rebase commit identities.
 */
export interface PreparedTargetMerge {
  strategy: "merge" | "rebase" | "squash";
  candidateHead: string;
  targetHead: string;
  resultHead: string;
  preparedRef: string;
}

export interface TargetMergeRecovery {
  prepared?: PreparedTargetMerge;
  preparedRef?: string;
  onPrepared?: (prepared: PreparedTargetMerge) => void;
}

export interface CreateBranchOptions {
  fromBranch?: string;
  baseBranch?: string;
}

// ─── Worktree detection ────────────────────────────────────────────

/**
 * Resolve the main working directory of a git repository.
 * If `cwd` is a worktree, returns the main working tree path.
 * If `cwd` is already the main repo, returns `cwd` unchanged.
 *
 * Uses `git worktree list --porcelain` — the first entry is always
 * the main working tree. This fixes Pattern 36: local merges inside
 * worktrees fail because `git checkout <target>` refuses when the
 * target branch is checked out in another working tree.
 */
async function resolveMainWorkingDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    // First line is always "worktree <path>" for the main working tree
    const firstLine = stdout.split("\n")[0];
    if (firstLine?.startsWith("worktree ")) {
      return firstLine.slice("worktree ".length).trim();
    }
  } catch {
    // If worktree list fails, fall back to cwd
  }
  return cwd;
}

// ─── Git command execution ──────────────────────────────────────────

interface ExecError {
  code: number | null;
  stdout: string;
  stderr: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null && "stdout" in err && "stderr" in err;
}

async function runCommand(
  file: "git" | "gh",
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...(environment ? { env: { ...process.env, ...environment } } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    if (isExecError(err)) {
      return {
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: `${file} error: ${message}` };
  }
}

async function runGitCommand(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand("git", args, cwd);
}

async function readRemoteBranchHead(
  branchName: string,
  cwd: string,
  expectedOriginPushUrl?: string,
): Promise<{ success: true; head?: string } | { success: false; error: string }> {
  if (expectedOriginPushUrl && !(await originPushUrlMatches(cwd, expectedOriginPushUrl))) {
    return { success: false, error: "Git origin changed after publication was bound" };
  }
  const branchRef = `refs/heads/${branchName}`;
  const result = expectedOriginPushUrl
    ? await runBoundGitCommand(
        ["ls-remote", "--heads", BOUND_GIT_REMOTE, branchRef],
        cwd,
        expectedOriginPushUrl,
      )
    : await runGitCommand(["ls-remote", "--heads", "origin", branchRef], cwd);
  if (result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr || `Could not inspect remote branch ${branchName}`,
    };
  }
  if (!result.stdout.trim()) return { success: true };
  const lines = result.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1) {
    return { success: false, error: `Remote branch ${branchName} resolved ambiguously` };
  }
  const match = /^([a-f0-9]{40,64})\s+(.+)$/iu.exec(lines[0] ?? "");
  if (!match || match[2] !== branchRef) {
    return { success: false, error: `Remote branch ${branchName} returned an invalid ref` };
  }
  return { success: true, head: match[1]?.toLowerCase() };
}

function isConservativeBranchName(value: string): boolean {
  const shellMetacharacters = /[;&|<>`$!'"(){}]/u;
  return (
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !shellMetacharacters.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code <= 0x20 ||
        code === 0x7f ||
        ["~", "^", ":", "?", "*", "[", "]", "\\"].includes(character)
      );
    })
  );
}

const COMMIT_ID_PATTERN = /^[a-f0-9]{40,64}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pullRequestHeadRepository(value: Record<string, unknown>): string | undefined {
  const repository = value.headRepository;
  if (isRecord(repository) && typeof repository.nameWithOwner === "string") {
    return repository.nameWithOwner;
  }
  const owner = value.headRepositoryOwner;
  if (
    isRecord(repository) &&
    typeof repository.name === "string" &&
    isRecord(owner) &&
    typeof owner.login === "string"
  ) {
    return `${owner.login}/${repository.name}`;
  }
  return undefined;
}

async function currentRepository(
  cwd: string,
): Promise<
  { success: true; repository: GitHubRepositoryIdentity } | { success: false; error: string }
> {
  try {
    return { success: true, repository: await resolveOriginGitHubRepository(cwd) };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface BoundPullRequest {
  state: "OPEN" | "MERGED";
  mergeCommitSha?: string;
}

async function inspectBoundPullRequest(
  cwd: string,
  repository: GitHubRepositoryIdentity,
  prUrl: string,
  baseBranch: string,
  headBranch: string,
  headCommitSha: string,
): Promise<{ success: true; pullRequest: BoundPullRequest } | { success: false; error: string }> {
  if (!pullRequestUrlMatchesOrigin(prUrl, repository)) {
    return { success: false, error: "pull request URL does not belong to the current repository" };
  }
  if (!(await originPushUrlMatches(cwd, repository.pushUrl))) {
    return { success: false, error: "Git origin changed before pull request inspection" };
  }
  const result = await runCommand(
    "gh",
    [
      "pr",
      "view",
      prUrl,
      "--repo",
      repository.selector,
      "--json",
      "url,state,mergeCommit,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr || "could not inspect pull request" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return { success: false, error: "pull request inspection returned invalid JSON" };
  }
  if (!isRecord(parsed)) {
    return { success: false, error: "pull request inspection returned an invalid record" };
  }
  const headRepository = pullRequestHeadRepository(parsed);
  if (
    parsed.url !== prUrl ||
    parsed.baseRefName !== baseBranch ||
    parsed.headRefName !== headBranch ||
    parsed.headRefOid !== headCommitSha ||
    headRepository?.toLowerCase() !== repository.nameWithOwner.toLowerCase()
  ) {
    return {
      success: false,
      error: "pull request no longer matches the sealed repository/base/head binding",
    };
  }
  if (parsed.state !== "OPEN" && parsed.state !== "MERGED") {
    return {
      success: false,
      error: `pull request is not mergeable from state ${String(parsed.state)}`,
    };
  }
  const mergeCommit = parsed.mergeCommit;
  const mergeCommitSha =
    isRecord(mergeCommit) &&
    typeof mergeCommit.oid === "string" &&
    COMMIT_ID_PATTERN.test(mergeCommit.oid)
      ? mergeCommit.oid
      : undefined;
  return {
    success: true,
    pullRequest: {
      state: parsed.state,
      ...(mergeCommitSha ? { mergeCommitSha } : {}),
    },
  };
}

async function fetchRemoteBranch(
  branchName: string,
  cwd: string,
): Promise<{ success: boolean; ref: string; error?: string }> {
  if (!isConservativeBranchName(branchName)) {
    return { success: false, ref: `origin/${branchName}`, error: "Unsafe Git branch name" };
  }
  const fetchResult = await runGitCommand(
    ["fetch", "origin", `${branchName}:refs/remotes/origin/${branchName}`],
    cwd,
  );
  if (fetchResult.exitCode !== 0) {
    return {
      success: false,
      ref: `origin/${branchName}`,
      error: `Failed to fetch origin/${branchName}: ${fetchResult.stderr}`,
    };
  }

  const remoteRef = `origin/${branchName}`;
  const verifyResult = await runGitCommand(["rev-parse", "--verify", remoteRef], cwd);
  if (verifyResult.exitCode !== 0) {
    return {
      success: false,
      ref: remoteRef,
      error: `Remote branch ${remoteRef} was not found after fetch: ${verifyResult.stderr}`,
    };
  }

  return { success: true, ref: remoteRef };
}

async function guardAgainstStaleBranchMerge(
  branchName: string,
  targetBranch: string,
  cwd: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isConservativeBranchName(branchName) || !isConservativeBranchName(targetBranch)) {
    return { success: false, error: "Unsafe Git branch name" };
  }
  const mergeBaseResult = await runGitCommand(["merge-base", targetBranch, branchName], cwd);
  if (mergeBaseResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to determine merge-base for ${branchName} and ${targetBranch}: ${mergeBaseResult.stderr}`,
    };
  }

  const mergeBase = mergeBaseResult.stdout.trim();
  const targetHeadResult = await runGitCommand(["rev-parse", targetBranch], cwd);
  if (targetHeadResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to resolve ${targetBranch}: ${targetHeadResult.stderr}`,
    };
  }

  const targetHead = targetHeadResult.stdout.trim();
  if (mergeBase === targetHead) {
    return { success: true };
  }

  const targetChanges = await runGitCommand(
    ["diff", "--name-only", `${mergeBase}..${targetBranch}`],
    cwd,
  );
  const branchChanges = await runGitCommand(
    ["diff", "--name-only", `${mergeBase}..${branchName}`],
    cwd,
  );
  if (targetChanges.exitCode !== 0 || branchChanges.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to compare stale branch overlap for ${branchName}`,
    };
  }

  const targetFiles = new Set(
    targetChanges.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const overlappingFiles = branchChanges.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && targetFiles.has(line));

  if (overlappingFiles.length > 0) {
    const preview = overlappingFiles.slice(0, 10).join(", ");
    const extra = overlappingFiles.length > 10 ? `, and ${overlappingFiles.length - 10} more` : "";
    return {
      success: false,
      error:
        `Refusing to auto-merge stale branch ${branchName}: ${targetBranch} ` +
        `advanced after the task branch forked and both sides changed ` +
        `${overlappingFiles.length} file(s): ${preview}${extra}. ` +
        `Rebase or rescue the task-only changes before merging.`,
    };
  }

  return { success: true };
}

// ─── Branch name construction ───────────────────────────────────────

/**
 * Build the branch name for a task using the adapter's git config.
 * Format: {branchPrefix}{taskId} (e.g., "quack/TASK-011")
 */
export function buildBranchName(taskId: string, adapter: ProjectAdapter): string {
  const prefix = adapter.config.git.branchPrefix;
  return `${prefix}${taskId}`;
}

// ─── Branch operations ──────────────────────────────────────────────

/**
 * Create (or reuse) a parent feature branch for subtask chains.
 * Branch name: `{branchPrefix}{parentTaskId}` (e.g. `quack/TASK-207`).
 * Idempotent: returns existing branch if already created.
 *
 * New feature branches start from `origin/baseBranch` after a fetch so a stale
 * service clone cannot fork task chains from an old local base.
 */
export async function createFeatureBranch(
  parentTaskId: string,
  adapter: ProjectAdapter,
): Promise<BranchResult> {
  const branchName = buildBranchName(parentTaskId, adapter);
  const baseBranch = adapter.config.git.baseBranch;
  const cwd = adapter.projectRoot;

  // Check if feature branch already exists
  const checkResult = await runGitCommand(["rev-parse", "--verify", branchName], cwd);
  if (checkResult.exitCode === 0) {
    return { success: true, branchName };
  }

  const remoteBase = await fetchRemoteBranch(baseBranch, cwd);
  if (!remoteBase.success) {
    return {
      success: false,
      branchName,
      error: remoteBase.error ?? `Failed to fetch ${baseBranch}`,
    };
  }

  const remoteResult = await runGitCommand(["branch", branchName, remoteBase.ref], cwd);
  if (remoteResult.exitCode === 0) {
    return { success: true, branchName };
  }

  return {
    success: false,
    branchName,
    error: `Failed to create feature branch: ${remoteResult.stderr}`,
  };
}

/**
 * Create a new branch for the task from the configured base branch.
 *
 * Root task branches start from freshly fetched `origin/baseBranch`; relying on
 * the service clone's local base can run agents against stale verifier scripts
 * and stale task specs. Subtasks still branch from their provided parent branch.
 *
 * @param fromBranch - Optional branch to create from (defaults to adapter's baseBranch).
 *                     Used for subtasks branching from a parent feature branch.
 */
export async function createBranch(
  taskId: string,
  adapter: ProjectAdapter,
  options: CreateBranchOptions = {},
  events?: IEventWriter,
): Promise<BranchResult> {
  const branchName = buildBranchName(taskId, adapter);
  const fromBranch = options.fromBranch;
  const baseBranch = options.baseBranch ?? adapter.config.git.baseBranch;
  const cwd = adapter.projectRoot;
  let baseRef = fromBranch ?? baseBranch;

  // Stash any dirty tracked files so checkout doesn't fail.
  // This handles the case where the main working tree has uncommitted
  // changes (e.g. task specs marked COMPLETE) that would block
  // `git checkout -b`. The stash is popped after checkout succeeds,
  // or restored on failure.
  const stashResult = await runGitCommand(["stash", "--include-untracked"], cwd);
  const didStash = stashResult.exitCode === 0 && !stashResult.stdout.includes("No local changes");

  const restoreStash = async (): Promise<void> => {
    if (didStash) {
      await runGitCommand(["stash", "pop"], cwd);
    }
  };

  if (!fromBranch) {
    const remoteBase = await fetchRemoteBranch(baseBranch, cwd);
    if (!remoteBase.success) {
      await restoreStash();
      return {
        success: false,
        branchName,
        error: remoteBase.error ?? `Failed to fetch ${baseBranch}`,
      };
    }
    baseRef = remoteBase.ref;
  }

  const localResult = await runGitCommand(["checkout", "-b", branchName, baseRef], cwd);

  if (localResult.exitCode === 0) {
    await restoreStash();
    return { success: true, branchName };
  }

  // If branch already exists (stale from a prior dispatch), delete it
  // and retry. This handles the retry-after-REVISE case where the
  // previous session's branch was abandoned but not cleaned up.
  const branchExists = localResult.stderr.includes("already exists");
  if (branchExists) {
    const guard = assertBranchDeletionAllowed(
      branchName,
      resolveProtectedBranches(adapter.config.git),
    );
    if (!guard.allowed) {
      emitGuardRefusal(events, taskId, branchName, "createBranch.staleRetryDelete");
      await restoreStash();
      return { success: false, branchName, error: guard.reason };
    }
    await runGitCommand(["branch", "-D", branchName], cwd);
    const retryResult = await runGitCommand(["checkout", "-b", branchName, baseRef], cwd);
    if (retryResult.exitCode === 0) {
      await restoreStash();
      return { success: true, branchName };
    }
  }

  // For subtasks, the parent branch may only exist on origin.
  const fallbackBase = fromBranch ? (await fetchRemoteBranch(fromBranch, cwd)).ref : baseRef;
  const remoteResult = await runGitCommand(["checkout", "-b", branchName, fallbackBase], cwd);

  if (remoteResult.exitCode === 0) {
    await restoreStash();
    return { success: true, branchName };
  }

  // All attempts failed — restore stash before returning error
  await restoreStash();
  return {
    success: false,
    branchName,
    error: `Failed to create branch: ${remoteResult.stderr}`,
  };
}

/**
 * Push the task branch to the remote repository.
 * Never force-pushes.
 */
export async function pushBranch(taskId: string, adapter: ProjectAdapter): Promise<BranchResult> {
  const branchName = buildBranchName(taskId, adapter);
  const cwd = adapter.projectRoot;

  const result = await runGitCommand(["push", "-u", "origin", branchName], cwd);

  if (result.exitCode !== 0) {
    return {
      success: false,
      branchName,
      error: `Failed to push branch: ${result.stderr}`,
    };
  }

  return { success: true, branchName };
}

export type ExactBranchHeadResult =
  | { success: true; branchName: string; headCommitSha: string }
  | { success: false; branchName: string; error: string };

/** Freeze the exact local task-branch commit after judgment/lifecycle work. */
export async function resolveExactBranchHead(
  branchName: string,
  adapter: ProjectAdapter,
): Promise<ExactBranchHeadResult> {
  if (!isConservativeBranchName(branchName)) {
    return { success: false, branchName, error: "Unsafe Git branch name" };
  }
  const branchRef = `refs/heads/${branchName}`;
  const result = await runGitCommand(
    ["rev-parse", "--verify", `${branchRef}^{commit}`],
    adapter.projectRoot,
  );
  const headCommitSha = result.stdout.trim().toLowerCase();
  if (result.exitCode !== 0 || !COMMIT_ID_PATTERN.test(headCommitSha)) {
    return {
      success: false,
      branchName,
      error: `Could not seal exact branch head for ${branchName}: ${result.stderr || "invalid commit id"}`,
    };
  }
  return { success: true, branchName, headCommitSha };
}

/**
 * Push only a previously sealed object ID. The mutable branch name is checked
 * immediately before the push and is never used as the refspec source.
 */
export async function pushExactBranch(
  branchName: string,
  expectedHeadCommit: string,
  adapter: ProjectAdapter,
  expectedOriginPushUrl?: string,
): Promise<BranchResult> {
  const sealed = expectedHeadCommit.toLowerCase();
  if (!isConservativeBranchName(branchName) || !COMMIT_ID_PATTERN.test(sealed)) {
    return { success: false, branchName, error: "Invalid exact branch publication binding" };
  }
  const current = await resolveExactBranchHead(branchName, adapter);
  if (!current.success || current.headCommitSha !== sealed) {
    return {
      success: false,
      branchName,
      error: current.success
        ? `Refusing to push ${branchName}: branch advanced after judgment`
        : current.error,
    };
  }
  if (
    expectedOriginPushUrl &&
    !(await originPushUrlMatches(adapter.projectRoot, expectedOriginPushUrl))
  ) {
    return { success: false, branchName, error: "Git origin changed after publication was bound" };
  }

  const branchRef = `refs/heads/${branchName}`;
  const result = expectedOriginPushUrl
    ? await runBoundGitCommand(
        ["push", BOUND_GIT_REMOTE, `${sealed}:${branchRef}`],
        adapter.projectRoot,
        expectedOriginPushUrl,
      )
    : await runGitCommand(["push", "origin", `${sealed}:${branchRef}`], adapter.projectRoot);
  if (result.exitCode !== 0) {
    return {
      success: false,
      branchName,
      error: `Failed to push sealed branch: ${result.stderr}`,
    };
  }
  const remote = await readRemoteBranchHead(branchName, adapter.projectRoot, expectedOriginPushUrl);
  if (!remote.success || remote.head !== sealed) {
    return {
      success: false,
      branchName,
      error: remote.success
        ? `Remote branch ${branchName} did not retain the sealed commit`
        : remote.error,
    };
  }
  return { success: true, branchName };
}

/**
 * Clean up a task branch by switching back to the base branch
 * and deleting the task branch (both local and remote).
 */
export async function cleanupBranch(
  taskId: string,
  adapter: ProjectAdapter,
  events?: IEventWriter,
): Promise<BranchResult> {
  const branchName = buildBranchName(taskId, adapter);
  const baseBranch = adapter.config.git.baseBranch;
  const cwd = adapter.projectRoot;

  // Centralized deletion guard (TASK-1312): checked BEFORE the local
  // delete — the local delete precedes the remote one, so a late guard
  // would leave local damage done.
  const guard = assertBranchDeletionAllowed(
    branchName,
    resolveProtectedBranches(adapter.config.git),
  );
  if (!guard.allowed) {
    emitGuardRefusal(events, taskId, branchName, "cleanupBranch");
    return { success: false, branchName, error: guard.reason };
  }

  // Switch back to base branch
  const checkoutResult = await runGitCommand(["checkout", baseBranch], cwd);
  if (checkoutResult.exitCode !== 0) {
    return {
      success: false,
      branchName,
      error: `Failed to checkout base branch: ${checkoutResult.stderr}`,
    };
  }

  // Delete local branch
  const deleteResult = await runGitCommand(["branch", "-D", branchName], cwd);
  if (deleteResult.exitCode !== 0) {
    return {
      success: false,
      branchName,
      error: `Failed to delete local branch: ${deleteResult.stderr}`,
    };
  }

  // Delete remote branch (best-effort, don't fail if not pushed)
  await runGitCommand(["push", "origin", "--delete", branchName], cwd);

  return { success: true, branchName };
}

/**
 * Abandon a task branch by switching back to the base branch
 * WITHOUT deleting the branch. This preserves the branch for
 * post-mortem review after rejection or failure.
 */
export async function abandonBranch(
  taskId: string,
  adapter: ProjectAdapter,
): Promise<BranchResult> {
  const branchName = buildBranchName(taskId, adapter);
  const baseBranch = adapter.config.git.baseBranch;
  const cwd = adapter.projectRoot;

  const checkoutResult = await runGitCommand(["checkout", baseBranch], cwd);
  if (checkoutResult.exitCode !== 0) {
    return {
      success: false,
      branchName,
      error: `Failed to checkout base branch: ${checkoutResult.stderr}`,
    };
  }

  return { success: true, branchName };
}

/**
 * Get uncommitted changes (staged + unstaged) in the working tree.
 * Returns the short-format status output, empty string if clean.
 */
export async function getUncommittedChanges(adapter: ProjectAdapter): Promise<string> {
  const cwd = adapter.projectRoot;
  const result = await runGitCommand(["status", "--short"], cwd);
  return result.stdout.trim();
}

/**
 * Auto-commit all uncommitted changes as a safety net when the agent
 * forgets to commit. Uses the adapter's commit format.
 */
export async function autoCommitChanges(
  taskId: string,
  adapter: ProjectAdapter,
): Promise<{ success: boolean; message: string; filesStaged: number }> {
  const cwd = adapter.projectRoot;
  const commitFormat = adapter.config.git.commitFormat;
  const trailer = adapter.config.git.commitTrailer;

  // Stage all changes, then unstage shared state files that cause merge
  // conflicts when task branches are squash-merged to the base branch.
  // Two-step approach because pathspec negation (:!file) is unreliable
  // on Windows — git may return exit 1 due to gitignored file warnings.
  const addResult = await runGitCommand(["add", "-A"], cwd);
  if (addResult.exitCode !== 0) {
    return {
      success: false,
      message: `git add failed: ${addResult.stderr}`,
      filesStaged: 0,
    };
  }
  // Unstage shared state files (ignore errors — files may not be staged).
  // QPI-050: the pipeline-synced adapter trio joins the list — worktree
  // copies of adapter.json/conventions.md/judge-criteria.md are
  // PIPELINE-MANAGED (the freshness sync overwrites them with the root
  // clone's content, which may carry uncommitted host-local drift like
  // the 2026-08 azure reviewer path). Sweeping them into a task commit
  // would ship that drift to the shared branch. A task that legitimately
  // changes adapter config commits it explicitly, never via this
  // forgot-to-commit safety net.
  await runGitCommand(
    [
      "reset",
      "HEAD",
      "--",
      "PROGRESS.md",
      ".quack/verified.json",
      ".quack/adapter.json",
      ".quack/conventions.md",
      ".quack/judge-criteria.md",
    ],
    cwd,
  );

  // Count staged files
  const stagedResult = await runGitCommand(["diff", "--cached", "--name-only"], cwd);
  const stagedFiles = stagedResult.stdout.trim().split("\n").filter(Boolean);
  if (stagedFiles.length === 0) {
    return {
      success: true,
      message: "No commit created; only shared Quack state was dirty",
      filesStaged: 0,
    };
  }

  // Build commit message
  const msg = commitFormat
    .replace("{taskId}", taskId)
    .replace("{message}", "auto-commit: agent did not commit before finishing");
  const fullMsg = trailer ? `${msg}\n\n${trailer}` : msg;

  const commitResult = await runGitCommand(["commit", "-m", fullMsg], cwd);
  if (commitResult.exitCode !== 0) {
    return {
      success: false,
      message: `git commit failed: ${commitResult.stderr}`,
      filesStaged: stagedFiles.length,
    };
  }

  return { success: true, message: fullMsg, filesStaged: stagedFiles.length };
}

/**
 * Get the current git diff for the task branch against the base branch.
 * Used to pass to the LLM-as-Judge for evaluation.
 * Root task diffs prefer freshly fetched `origin/baseBranch` so judges compare
 * against the canonical target state, not a stale service clone.
 *
 * @param diffBase - Optional branch to diff against (defaults to adapter's baseBranch).
 *                   Used for subtasks to diff against the parent feature branch.
 */
export async function getBranchDiff(adapter: ProjectAdapter, diffBase?: string): Promise<string> {
  const baseBranch = diffBase ?? adapter.config.git.baseBranch;
  const cwd = adapter.projectRoot;

  if (!diffBase) {
    const remoteBase = await fetchRemoteBranch(baseBranch, cwd);
    if (remoteBase.success) {
      const remoteResult = await runGitCommand(["diff", `${remoteBase.ref}...HEAD`], cwd);
      if (remoteResult.exitCode === 0) {
        return remoteResult.stdout.trim();
      }
    }
  }

  const localResult = await runGitCommand(["diff", `${baseBranch}...HEAD`], cwd);

  if (localResult.exitCode === 0) {
    return localResult.stdout.trim();
  }

  // Fall back to origin/ prefix if the initial fetch failed but the remote ref
  // already exists locally.
  const remoteResult = await runGitCommand(["diff", `origin/${baseBranch}...HEAD`], cwd);
  return remoteResult.stdout.trim();
}

/**
 * TASK-1314: progress detection the resume branch can trust. Workers
 * cannot commit (the bash floor denies git writes and the MCP git
 * server is read-only; the SEALER commits after the worker), so a
 * committed-diff-only check is structurally blind to mid-run
 * exhaustion. Progress = committed branch diff OR dirty entries the
 * sealer's own status classification would include — one definition of
 * sealable work, shared with the sealer by construction.
 */
export async function hasSealableProgress(
  adapter: ProjectAdapter,
  diffBase?: string,
): Promise<boolean> {
  const committed = await getBranchDiff(adapter, diffBase);
  if (committed.trim().length > 0) return true;
  const status = await runGitCommand(["status", "--short"], adapter.projectRoot);
  if (status.exitCode !== 0) return false;
  return parseStatus(status.stdout).included.length > 0;
}

/**
 * Count the number of commits on a branch relative to a base.
 * Returns 0 if the branch has no new commits (tip == merge-base).
 *
 * When `branchRef` is provided, counts commits on that ref instead of HEAD.
 * This is critical for post-worktree finalization: after worktree teardown,
 * HEAD in the main checkout points to the base branch, not the task branch,
 * so `base..HEAD` would always return 0. Using the explicit branch name
 * (`base..quack/TASK-NNN`) avoids this false-negative.
 */
export async function getBranchCommitCount(
  adapter: ProjectAdapter,
  baseBranch?: string,
  branchRef?: string,
): Promise<number> {
  const base = baseBranch ?? adapter.config.git.baseBranch;
  const tip = branchRef ?? "HEAD";
  const cwd = adapter.projectRoot;
  const result = await runGitCommand(["log", "--oneline", `${base}..${tip}`], cwd);
  if (result.exitCode !== 0) return 0;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return lines.length;
}

/**
 * Build a detailed squash merge commit message from the diff stats.
 *
 * Generates a message like:
 *   [TASK-212-D] squash merge
 *
 *   Files: 8 created, 1 modified
 *   Tests: 2 test files (30 test cases)
 *
 *   Created:
 *     src/controllers/twilio-webhook.controller.js
 *     src/tests/unit/controllers/twilio-webhook.controller.test.js
 *   Modified:
 *     src/routes/index.js
 */
async function buildSquashCommitMessage(
  taskId: string,
  branchName: string,
  cwd: string,
): Promise<string> {
  try {
    // Get list of changed files with status (A=added, M=modified, D=deleted)
    const diffResult = await runGitCommand(["diff", "--cached", "--name-status"], cwd);
    if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
      return `[${taskId}] squash merge`;
    }

    const lines = diffResult.stdout.trim().split("\n");
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    let testFiles = 0;

    for (const line of lines) {
      const [status, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t");
      if (!file) continue;

      if (status === "A") created.push(file);
      else if (status === "M") modified.push(file);
      else if (status === "D") deleted.push(file);

      if (file.includes("test") || file.includes("spec") || file.includes("__tests__")) {
        testFiles++;
      }
    }

    // Build summary line
    const parts: string[] = [];
    if (created.length) parts.push(`${created.length} created`);
    if (modified.length) parts.push(`${modified.length} modified`);
    if (deleted.length) parts.push(`${deleted.length} deleted`);
    const fileSummary = parts.length ? `Files: ${parts.join(", ")}` : "";
    const testSummary = testFiles ? `Tests: ${testFiles} test file${testFiles > 1 ? "s" : ""}` : "";

    // Build file lists (cap at 20 lines to avoid huge messages)
    const sections: string[] = [];
    if (created.length) {
      const fileList = created.slice(0, 15).map((f) => `  ${f}`);
      if (created.length > 15) fileList.push(`  ... and ${created.length - 15} more`);
      sections.push(`Created:\n${fileList.join("\n")}`);
    }
    if (modified.length) {
      const fileList = modified.slice(0, 10).map((f) => `  ${f}`);
      if (modified.length > 10) fileList.push(`  ... and ${modified.length - 10} more`);
      sections.push(`Modified:\n${fileList.join("\n")}`);
    }
    if (deleted.length) {
      const fileList = deleted.slice(0, 5).map((f) => `  ${f}`);
      if (deleted.length > 5) fileList.push(`  ... and ${deleted.length - 5} more`);
      sections.push(`Deleted:\n${fileList.join("\n")}`);
    }

    // Assemble the full message
    const body = [fileSummary, testSummary, "", ...sections].filter(Boolean).join("\n");

    return `[${taskId}] squash merge\n\n${body}`;
  } catch {
    // Fallback to simple message if anything goes wrong
    return `[${taskId}] squash merge`;
  }
}

function isBranchLockedInAnotherWorktree(stderr: string, targetBranch: string): boolean {
  return (
    stderr.includes(`'${targetBranch}' is already used by worktree`) ||
    stderr.includes(`"${targetBranch}" is already used by worktree`)
  );
}

function isPreparedPublicationRef(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("refs/quack/docker-publication-prepared/") ||
      value.startsWith("refs/quack/publication-prepared/")) &&
    isConservativeBranchName(value)
  );
}

async function releasePreparedTarget(
  preparedRef: string,
  resultHead: string,
  cwd: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const current = await runGitCommand(["rev-parse", "--verify", `${preparedRef}^{commit}`], cwd);
  if (current.exitCode !== 0) return { success: true };
  if (current.stdout.trim().toLowerCase() !== resultHead.toLowerCase()) {
    return {
      success: false,
      error: `Prepared publication ref ${preparedRef} changed before release`,
    };
  }
  const release = await runGitCommand(["update-ref", "-d", preparedRef, resultHead], cwd);
  if (release.exitCode !== 0) {
    return {
      success: false,
      error: `Could not release prepared publication ref: ${release.stderr}`,
    };
  }
  const retained = await runGitCommand(["rev-parse", "--verify", `${preparedRef}^{commit}`], cwd);
  return retained.exitCode === 0
    ? { success: false, error: `Prepared publication ref ${preparedRef} was not released` }
    : { success: true };
}

function normalizePreparedTargetMerge(
  prepared: PreparedTargetMerge,
  candidateHead: string,
  strategy: "merge" | "rebase" | "squash",
  expectedPreparedRef: string | undefined,
): PreparedTargetMerge | undefined {
  const normalized = {
    strategy: prepared.strategy,
    candidateHead: prepared.candidateHead.toLowerCase(),
    targetHead: prepared.targetHead.toLowerCase(),
    resultHead: prepared.resultHead.toLowerCase(),
    preparedRef: prepared.preparedRef,
  };
  if (
    normalized.strategy !== strategy ||
    !COMMIT_ID_PATTERN.test(normalized.candidateHead) ||
    !COMMIT_ID_PATTERN.test(normalized.targetHead) ||
    !COMMIT_ID_PATTERN.test(normalized.resultHead) ||
    normalized.candidateHead !== candidateHead.toLowerCase() ||
    normalized.targetHead.length !== normalized.resultHead.length ||
    normalized.targetHead.length !== normalized.candidateHead.length ||
    normalized.targetHead === normalized.resultHead ||
    !isPreparedPublicationRef(normalized.preparedRef) ||
    normalized.preparedRef !== expectedPreparedRef
  ) {
    return undefined;
  }
  return normalized;
}

async function preservePreparedTarget(
  preparedRef: string,
  resultHead: string,
  cwd: string,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!isPreparedPublicationRef(preparedRef)) {
    return { success: false, error: "Prepared target publication ref is invalid" };
  }
  const current = await runGitCommand(["rev-parse", "--verify", `${preparedRef}^{commit}`], cwd);
  const currentHead = current.exitCode === 0 ? current.stdout.trim().toLowerCase() : undefined;
  if (currentHead !== undefined && !COMMIT_ID_PATTERN.test(currentHead)) {
    return { success: false, error: `Prepared target publication ref ${preparedRef} is invalid` };
  }
  const create =
    currentHead === resultHead
      ? { exitCode: 0, stdout: "", stderr: "" }
      : await runGitCommand(
          ["update-ref", preparedRef, resultHead, currentHead ?? "0".repeat(resultHead.length)],
          cwd,
        );
  if (create.exitCode !== 0) {
    return {
      success: false,
      error: `Could not preserve prepared target publication: ${create.stderr}`,
    };
  }
  const confirmed = await runGitCommand(["rev-parse", "--verify", `${preparedRef}^{commit}`], cwd);
  if (confirmed.exitCode !== 0 || confirmed.stdout.trim().toLowerCase() !== resultHead) {
    return { success: false, error: "Prepared target publication ref was not confirmed" };
  }
  return { success: true };
}

async function finishNoEffectTarget(
  targetHead: string,
  targetBranch: string,
  preparedRef: string | undefined,
  cwd: string,
  allowDescendant: boolean,
  expectedOriginPushUrl?: string,
): Promise<MergeResult> {
  const remote = await readRemoteBranchHead(targetBranch, cwd, expectedOriginPushUrl);
  if (!remote.success) return { success: false, error: remote.error };
  let confirmed = remote.head === targetHead;
  if (!confirmed && allowDescendant && remote.head) {
    const descendant = await runGitCommand(
      ["merge-base", "--is-ancestor", targetHead, remote.head],
      cwd,
    );
    confirmed = descendant.exitCode === 0;
  }
  if (!confirmed) {
    return {
      success: false,
      error: `Refusing no-effect publication for ${targetBranch}: remote target moved from ${targetHead}`,
    };
  }
  if (preparedRef) {
    if (!isPreparedPublicationRef(preparedRef)) {
      return { success: false, error: "Prepared target publication ref is invalid" };
    }
    const preserved = await runGitCommand(
      ["rev-parse", "--verify", `${preparedRef}^{commit}`],
      cwd,
    );
    if (preserved.exitCode === 0) {
      const preservedHead = preserved.stdout.trim().toLowerCase();
      if (!COMMIT_ID_PATTERN.test(preservedHead)) {
        return {
          success: false,
          error: `Prepared target publication ref ${preparedRef} is invalid`,
        };
      }
      const release = await runGitCommand(["update-ref", "-d", preparedRef, preservedHead], cwd);
      if (release.exitCode !== 0) {
        return {
          success: false,
          error: `Could not release orphaned prepared publication ref ${preparedRef}: ${release.stderr}`,
        };
      }
      const retained = await runGitCommand(
        ["rev-parse", "--verify", `${preparedRef}^{commit}`],
        cwd,
      );
      if (retained.exitCode === 0) {
        return {
          success: false,
          error: `Orphaned prepared publication ref ${preparedRef} was not released`,
        };
      }
    }
  }
  return { success: true, mergeCommitSha: targetHead };
}

async function publishPreparedTarget(
  prepared: PreparedTargetMerge,
  targetBranch: string,
  cwd: string,
  expectedOriginPushUrl?: string,
): Promise<MergeResult> {
  const remoteBefore = await readRemoteBranchHead(targetBranch, cwd, expectedOriginPushUrl);
  if (!remoteBefore.success) {
    return { success: false, error: remoteBefore.error };
  }
  if (remoteBefore.head === prepared.resultHead) {
    return { success: true, mergeCommitSha: prepared.resultHead };
  }
  if (remoteBefore.head && remoteBefore.head !== prepared.targetHead) {
    const resultStillPublished = await runGitCommand(
      ["merge-base", "--is-ancestor", prepared.resultHead, remoteBefore.head],
      cwd,
    );
    if (resultStillPublished.exitCode === 0) {
      return { success: true, mergeCommitSha: prepared.resultHead };
    }
  }
  if (remoteBefore.head !== prepared.targetHead) {
    return {
      success: false,
      error: `Refusing prepared publication for ${targetBranch}: remote target moved from ${prepared.targetHead}`,
    };
  }

  const preserved = await runGitCommand(
    ["rev-parse", "--verify", `${prepared.preparedRef}^{commit}`],
    cwd,
  );
  if (preserved.exitCode !== 0 || preserved.stdout.trim().toLowerCase() !== prepared.resultHead) {
    const observed = preserved.stdout.trim().toLowerCase() || "missing";
    return {
      success: false,
      error: `Prepared publication ref ${prepared.preparedRef} resolved to ${observed}, expected ${prepared.resultHead}`,
    };
  }
  const descendant = await runGitCommand(
    ["merge-base", "--is-ancestor", prepared.targetHead, prepared.resultHead],
    cwd,
  );
  if (descendant.exitCode !== 0) {
    return {
      success: false,
      error: `Prepared publication ${prepared.resultHead} is not based on ${prepared.targetHead}`,
    };
  }

  const targetRef = `refs/heads/${targetBranch}`;
  if (expectedOriginPushUrl && !(await originPushUrlMatches(cwd, expectedOriginPushUrl))) {
    return { success: false, error: "Git origin changed before target publication" };
  }
  const pushArgs = [
    "push",
    `--force-with-lease=${targetRef}:${prepared.targetHead}`,
    expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin",
    `${prepared.resultHead}:${targetRef}`,
  ];
  const pushResult = expectedOriginPushUrl
    ? await runBoundGitCommand(pushArgs, cwd, expectedOriginPushUrl)
    : await runGitCommand(pushArgs, cwd);
  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to push ${targetBranch}: ${pushResult.stderr}`,
    };
  }
  const remoteAfter = await readRemoteBranchHead(targetBranch, cwd, expectedOriginPushUrl);
  if (!remoteAfter.success || remoteAfter.head !== prepared.resultHead) {
    return {
      success: false,
      error: remoteAfter.success
        ? `Remote target ${targetBranch} was not confirmed at ${prepared.resultHead}`
        : remoteAfter.error,
    };
  }
  return { success: true, mergeCommitSha: prepared.resultHead };
}

async function mergeViaDetachedWorktree(
  taskId: string,
  mergeSource: string,
  targetBranch: string,
  strategy: "merge" | "rebase" | "squash",
  repoDir: string,
  exactCandidate = false,
  recovery?: TargetMergeRecovery,
  expectedOriginPushUrl?: string,
): Promise<MergeResult> {
  if (recovery?.prepared) {
    const prepared = normalizePreparedTargetMerge(
      recovery.prepared,
      mergeSource,
      strategy,
      recovery.preparedRef,
    );
    if (!exactCandidate || !prepared) {
      return { success: false, error: "Prepared target publication does not match this merge" };
    }
    return publishPreparedTarget(prepared, targetBranch, repoDir, expectedOriginPushUrl);
  }
  const worktreePath = path.join(
    tmpdir(),
    `quack-auto-merge-${taskId.toLowerCase()}-${Date.now()}`,
  );
  let temporaryRebaseRef: string | undefined;
  let temporaryRebaseHead: string | undefined;

  try {
    const addResult = await runGitCommand(
      ["worktree", "add", "--detach", worktreePath, `origin/${targetBranch}`],
      repoDir,
    );
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to create temp merge worktree: ${addResult.stderr}`,
      };
    }

    let targetHead: string | undefined;
    if (exactCandidate) {
      const targetHeadResult = await runGitCommand(["rev-parse", "HEAD"], worktreePath);
      targetHead = targetHeadResult.stdout.trim().toLowerCase();
      if (targetHeadResult.exitCode !== 0 || !COMMIT_ID_PATTERN.test(targetHead)) {
        return {
          success: false,
          error: `Could not resolve exact target head for ${targetBranch}: ${targetHeadResult.stderr}`,
        };
      }

      // A retry can legitimately arrive after another actor integrated the
      // exact sealed candidate. Treat that as an idempotent no-effect merge;
      // there is no new result to anchor or push.
      const alreadyIntegrated = await runGitCommand(
        ["merge-base", "--is-ancestor", mergeSource, targetHead],
        worktreePath,
      );
      if (alreadyIntegrated.exitCode === 0) {
        return await finishNoEffectTarget(
          targetHead,
          targetBranch,
          recovery?.preparedRef,
          worktreePath,
          true,
          expectedOriginPushUrl,
        );
      }
      if (alreadyIntegrated.exitCode !== 1) {
        return {
          success: false,
          error: `Could not determine whether ${targetBranch} already contains the sealed candidate: ${alreadyIntegrated.stderr}`,
        };
      }
    }

    const runStaleGuard = async (): Promise<MergeResult | undefined> => {
      const staleGuard = await guardAgainstStaleBranchMerge(
        mergeSource,
        `origin/${targetBranch}`,
        worktreePath,
      );
      return staleGuard.success
        ? undefined
        : {
            success: false,
            error: staleGuard.error ?? `Stale branch guard failed for ${mergeSource}`,
          };
    };
    if (!exactCandidate || strategy === "merge") {
      const refusal = await runStaleGuard();
      if (refusal) return refusal;
    }

    let mergeResult;
    if (strategy === "squash") {
      mergeResult = await runGitCommand(["merge", "--squash", mergeSource], worktreePath);
      if (mergeResult.exitCode !== 0) {
        await runGitCommand(["reset", "--hard", "HEAD"], worktreePath);
        return {
          success: false,
          error: `Squash merge failed: ${mergeResult.stderr}`,
        };
      }

      if (exactCandidate) {
        const staged = await runGitCommand(["diff", "--cached", "--quiet"], worktreePath);
        if (staged.exitCode === 0) {
          return await finishNoEffectTarget(
            targetHead!,
            targetBranch,
            recovery?.preparedRef,
            worktreePath,
            false,
            expectedOriginPushUrl,
          );
        }
        if (staged.exitCode !== 1) {
          await runGitCommand(["reset", "--hard", "HEAD"], worktreePath);
          return {
            success: false,
            error: `Could not inspect the prepared squash result: ${staged.stderr}`,
          };
        }
        const refusal = await runStaleGuard();
        if (refusal) {
          await runGitCommand(["reset", "--hard", "HEAD"], worktreePath);
          return refusal;
        }
      }

      const commitMessage = await buildSquashCommitMessage(taskId, mergeSource, worktreePath);
      const commitResult = await runGitCommand(["commit", "-m", commitMessage], worktreePath);
      if (commitResult.exitCode !== 0) {
        return {
          success: false,
          error: `Squash commit failed: ${commitResult.stderr}`,
        };
      }
    } else if (strategy === "rebase") {
      let rebaseResult;
      if (exactCandidate) {
        const contentProbe = await runGitCommand(["merge", "--squash", mergeSource], worktreePath);
        if (contentProbe.exitCode !== 0) {
          await runGitCommand(["reset", "--hard", "HEAD"], worktreePath);
          return {
            success: false,
            error: `Rebase content probe failed: ${contentProbe.stderr}`,
          };
        }
        const staged = await runGitCommand(["diff", "--cached", "--quiet"], worktreePath);
        await runGitCommand(["reset", "--hard", "HEAD"], worktreePath);
        if (staged.exitCode === 0) {
          return await finishNoEffectTarget(
            targetHead!,
            targetBranch,
            recovery?.preparedRef,
            worktreePath,
            false,
            expectedOriginPushUrl,
          );
        }
        if (staged.exitCode !== 1) {
          return {
            success: false,
            error: `Could not inspect the prepared rebase result: ${staged.stderr}`,
          };
        }
        const refusal = await runStaleGuard();
        if (refusal) return refusal;

        const temporaryRebaseBranch = `quack-internal/merge-candidate-${randomUUID()}`;
        temporaryRebaseRef = `refs/heads/${temporaryRebaseBranch}`;
        temporaryRebaseHead = mergeSource;
        const checkoutCandidate = await runGitCommand(
          ["checkout", "-b", temporaryRebaseBranch, mergeSource],
          worktreePath,
        );
        if (checkoutCandidate.exitCode !== 0) {
          return {
            success: false,
            error: `Could not materialize exact rebase candidate: ${checkoutCandidate.stderr}`,
          };
        }
        rebaseResult = await runGitCommand(["rebase", `origin/${targetBranch}`], worktreePath);
      } else {
        rebaseResult = await runGitCommand(
          ["rebase", `origin/${targetBranch}`, mergeSource],
          worktreePath,
        );
      }
      if (rebaseResult.exitCode !== 0) {
        await runGitCommand(["rebase", "--abort"], worktreePath);
        return {
          success: false,
          error: `Rebase failed: ${rebaseResult.stderr}`,
        };
      }
      mergeResult = rebaseResult;
      if (exactCandidate) {
        const rebasedHead = await runGitCommand(["rev-parse", "HEAD"], worktreePath);
        const resolvedHead = rebasedHead.stdout.trim();
        if (rebasedHead.exitCode !== 0 || !COMMIT_ID_PATTERN.test(resolvedHead)) {
          return {
            success: false,
            error: `Could not resolve exact rebased candidate: ${rebasedHead.stderr}`,
          };
        }
        temporaryRebaseHead = resolvedHead;
      } else {
        mergeResult = await runGitCommand(["merge", "--ff-only", mergeSource], worktreePath);
        if (mergeResult.exitCode !== 0) {
          return {
            success: false,
            error: `Fast-forward merge failed: ${mergeResult.stderr}`,
          };
        }
      }
    } else {
      mergeResult = await runGitCommand(
        ["merge", "--no-ff", mergeSource, "-m", `[${taskId}] merge`],
        worktreePath,
      );
      if (mergeResult.exitCode !== 0) {
        await runGitCommand(["merge", "--abort"], worktreePath);
        return {
          success: false,
          error: `Merge failed: ${mergeResult.stderr}`,
        };
      }
    }

    const commitShaResult = await runGitCommand(["rev-parse", "HEAD"], worktreePath);
    const resultHead = commitShaResult.stdout.trim().toLowerCase();
    if (!exactCandidate) {
      const pushResult = await runGitCommand(
        ["push", "origin", `HEAD:${targetBranch}`],
        worktreePath,
      );
      if (pushResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to push ${targetBranch}: ${pushResult.stderr}`,
        };
      }
      return {
        success: true,
        ...(commitShaResult.exitCode === 0 && COMMIT_ID_PATTERN.test(resultHead)
          ? { mergeCommitSha: resultHead }
          : {}),
      };
    }
    if (commitShaResult.exitCode !== 0 || !COMMIT_ID_PATTERN.test(resultHead)) {
      return {
        success: false,
        error: `Could not resolve prepared target result: ${commitShaResult.stderr}`,
      };
    }
    if (resultHead === targetHead) {
      return {
        success: false,
        error: `${strategy} produced no target change even though the sealed candidate content is not present`,
      };
    }
    const prepared: PreparedTargetMerge = {
      strategy,
      candidateHead: mergeSource.toLowerCase(),
      targetHead: targetHead!,
      resultHead,
      preparedRef: recovery?.preparedRef ?? "",
    };
    const preserved = await preservePreparedTarget(prepared.preparedRef, resultHead, worktreePath);
    if (!preserved.success) return { success: false, error: preserved.error };
    // Keep the exact prepared ref if journal persistence reports an error.
    // A rename can have installed the next journal generation even when its
    // durability barrier also failed. Removing the ref would then make the
    // recovered preparedMerge impossible to replay. If no update landed, a
    // retry safely replaces this exact ref through preservePreparedTarget.
    recovery?.onPrepared?.(prepared);
    return await publishPreparedTarget(prepared, targetBranch, worktreePath, expectedOriginPushUrl);
  } finally {
    await runGitCommand(["worktree", "remove", worktreePath, "--force"], repoDir);
    if (temporaryRebaseRef && temporaryRebaseHead) {
      await runGitCommand(["update-ref", "-d", temporaryRebaseRef, temporaryRebaseHead], repoDir);
    }
  }
}

/**
 * Merge the task branch into the target branch after judge approval.
 *
 * If a PR URL is provided, uses `gh pr merge` (atomic, remote, respects
 * branch protection). Otherwise falls back to local merge + push.
 *
 * @param taskId - The task identifier
 * @param adapter - The project adapter with git config
 * @param prUrl - Optional PR URL for remote merge via GitHub CLI
 * @returns MergeResult indicating success or failure
 */
export async function mergeBranchToTarget(
  taskId: string,
  adapter: ProjectAdapter,
  prUrl?: string,
  targetBranchOverride?: string,
  events?: IEventWriter,
  sourceBranchOverride?: string,
  expectedHeadCommitOverride?: string,
  targetMergeRecovery?: TargetMergeRecovery,
  repositoryBinding?: GitOriginIdentity,
): Promise<MergeResult> {
  const cwd = adapter.projectRoot;
  const targetBranch =
    targetBranchOverride ?? adapter.config.git.autoMergeTarget ?? adapter.config.git.baseBranch;
  const strategy = adapter.config.git.autoMergeStrategy ?? "squash";
  const branchName = sourceBranchOverride ?? buildBranchName(taskId, adapter);
  if (!isConservativeBranchName(targetBranch) || !isConservativeBranchName(branchName)) {
    return { success: false, error: "Unsafe Git branch name" };
  }
  if (targetMergeRecovery && (prUrl || !expectedHeadCommitOverride)) {
    return {
      success: false,
      error: "Prepared target publication requires an exact local no-PR merge candidate",
    };
  }
  if (targetMergeRecovery && !isPreparedPublicationRef(targetMergeRecovery.preparedRef)) {
    return { success: false, error: "Prepared target publication ref is invalid" };
  }
  if (expectedHeadCommitOverride && !repositoryBinding) {
    return {
      success: false,
      error: "Exact branch publication requires a pre-resolved GitHub repository binding",
    };
  }

  // Prefer remote merge via gh CLI when we have a PR
  if (prUrl) {
    const expectedHeadResult = expectedHeadCommitOverride
      ? { exitCode: 0, stdout: expectedHeadCommitOverride, stderr: "" }
      : await runGitCommand(["rev-parse", "--verify", branchName], cwd);
    const expectedHeadCommit = expectedHeadResult.stdout.trim();
    if (expectedHeadResult.exitCode !== 0 || !COMMIT_ID_PATTERN.test(expectedHeadCommit)) {
      return {
        success: false,
        error: `Could not resolve the exact merge candidate for ${branchName}: ${expectedHeadResult.stderr}`,
      };
    }
    const repository = repositoryBinding
      ? repositoryBinding.github
        ? {
            success: true as const,
            repository: {
              ...repositoryBinding.github,
              pushUrl: repositoryBinding.pushUrl,
              pushUrlHash: repositoryBinding.pushUrlHash,
            },
          }
        : { success: false as const, error: "Bound Git origin is not a GitHub repository" }
      : await currentRepository(cwd);
    if (!repository.success) {
      return {
        success: false,
        error: `Could not bind pull request repository: ${repository.error}`,
      };
    }
    if (!(await originPushUrlMatches(cwd, repository.repository.pushUrl))) {
      return { success: false, error: "Git origin changed after publication was bound" };
    }
    const before = await inspectBoundPullRequest(
      cwd,
      repository.repository,
      prUrl,
      targetBranch,
      branchName,
      expectedHeadCommit,
    );
    if (!before.success) {
      return { success: false, error: before.error };
    }
    if (before.pullRequest.state === "MERGED") {
      return { success: true, mergeCommitSha: before.pullRequest.mergeCommitSha };
    }
    const strategyFlag = `--${strategy}`;
    if (!(await originPushUrlMatches(cwd, repository.repository.pushUrl))) {
      return { success: false, error: "Git origin changed before pull request merge" };
    }
    const ghResult = await runCommand(
      "gh",
      [
        "pr",
        "merge",
        prUrl,
        "--repo",
        repository.repository.selector,
        strategyFlag,
        "--match-head-commit",
        expectedHeadCommit,
      ],
      cwd,
    );

    if (ghResult.exitCode !== 0) {
      return {
        success: false,
        error: `gh pr merge failed: ${ghResult.stderr}`,
      };
    }

    const after = await inspectBoundPullRequest(
      cwd,
      repository.repository,
      prUrl,
      targetBranch,
      branchName,
      expectedHeadCommit,
    );
    if (!after.success || after.pullRequest.state !== "MERGED") {
      return {
        success: false,
        error: after.success
          ? "gh pr merge returned without a confirmed merged state"
          : `gh pr merge could not be confirmed: ${after.error}`,
      };
    }
    return { success: true, mergeCommitSha: after.pullRequest.mergeCommitSha };
  }

  // Fallback: local merge for when there's no PR (autoCreatePr: false)
  let exactCandidate: string | undefined;
  let publicationRemote = "origin";
  if (expectedHeadCommitOverride) {
    if (!COMMIT_ID_PATTERN.test(expectedHeadCommitOverride)) {
      return {
        success: false,
        error: `Could not resolve the exact merge candidate for ${branchName}: invalid commit id`,
      };
    }
    exactCandidate = expectedHeadCommitOverride.toLowerCase();
    if (!(await originPushUrlMatches(cwd, repositoryBinding!.pushUrl))) {
      return { success: false, error: "Git origin changed after publication was bound" };
    }
    // Pass the validated concrete URL to every Git network command. Even if
    // origin is rewritten immediately after this read, Git cannot be redirected.
    publicationRemote = repositoryBinding!.pushUrl;
    if (!targetMergeRecovery?.prepared) {
      const branchRef = branchName.startsWith("refs/heads/")
        ? branchName
        : `refs/heads/${branchName}`;
      const branchHead = await runGitCommand(
        ["rev-parse", "--verify", `${branchRef}^{commit}`],
        cwd,
      );
      if (branchHead.exitCode !== 0 || branchHead.stdout.trim().toLowerCase() !== exactCandidate) {
        return {
          success: false,
          error: `Refusing to merge ${branchName}: branch no longer points to the sealed candidate ${exactCandidate}`,
        };
      }
    }
  }

  // Pattern 36 fix: when dispatching in a worktree, the cwd is the worktree
  // path which can't checkout the target branch (it's checked out in the main
  // working directory). Resolve the main working directory and merge there.
  const mainDir = await resolveMainWorkingDir(cwd);

  // Fetch latest target branch
  if (exactCandidate && !(await originPushUrlMatches(mainDir, publicationRemote))) {
    return { success: false, error: "Git origin changed before target publication" };
  }
  const fetchResult = exactCandidate
    ? await runBoundGitCommand(
        ["fetch", BOUND_GIT_REMOTE, `${targetBranch}:refs/remotes/origin/${targetBranch}`],
        mainDir,
        publicationRemote,
      )
    : await runGitCommand(
        ["fetch", "origin", `${targetBranch}:refs/remotes/origin/${targetBranch}`],
        mainDir,
      );
  if (fetchResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to fetch ${targetBranch}: ${fetchResult.stderr}`,
    };
  }

  // A host-sealed candidate must never be dereferenced through its mutable
  // branch after the binding check above. Run every local strategy in a
  // detached worktree against the immutable object id; a concurrent branch
  // move can therefore affect neither the merge nor the target push.
  if (exactCandidate) {
    const transientPreparedRef = targetMergeRecovery
      ? undefined
      : `refs/quack/publication-prepared/${randomUUID()}`;
    const recovery = targetMergeRecovery ?? {
      preparedRef: transientPreparedRef,
    };
    const merged = await mergeViaDetachedWorktree(
      taskId,
      exactCandidate,
      targetBranch,
      strategy,
      mainDir,
      true,
      recovery,
      publicationRemote,
    );
    if (!merged.success || !transientPreparedRef || !merged.mergeCommitSha) return merged;
    const released = await releasePreparedTarget(
      transientPreparedRef,
      merged.mergeCommitSha,
      mainDir,
    );
    return released.success ? merged : { success: false, error: released.error };
  }

  // Checkout target branch (in the main working directory, not the worktree)
  const checkoutResult = await runGitCommand(["checkout", targetBranch], mainDir);
  if (checkoutResult.exitCode !== 0) {
    if (isBranchLockedInAnotherWorktree(checkoutResult.stderr, targetBranch)) {
      const detachedMergeResult = await mergeViaDetachedWorktree(
        taskId,
        branchName,
        targetBranch,
        strategy,
        mainDir,
      );
      if (!detachedMergeResult.success) {
        return detachedMergeResult;
      }

      const detachedGuard = assertBranchDeletionAllowed(
        branchName,
        resolveProtectedBranches(adapter.config.git),
      );
      if (detachedGuard.allowed) {
        await runGitCommand(["branch", "-D", branchName], mainDir);
        await runGitCommand(["push", "origin", "--delete", branchName], mainDir);
      } else {
        emitGuardRefusal(events, taskId, branchName, "mergeBranchToTarget.detachedCleanup");
      }
      return detachedMergeResult;
    }

    return {
      success: false,
      error: `Failed to checkout ${targetBranch}: ${checkoutResult.stderr}`,
    };
  }

  // Pull latest to avoid conflicts with remote
  const pullResult = await runGitCommand(["pull", "--ff-only", "origin", targetBranch], mainDir);
  if (pullResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to fast-forward ${targetBranch}: ${pullResult.stderr}`,
    };
  }

  const staleGuard = await guardAgainstStaleBranchMerge(branchName, targetBranch, mainDir);
  if (!staleGuard.success) {
    return {
      success: false,
      error: staleGuard.error ?? `Stale branch guard failed for ${branchName}`,
    };
  }

  // Merge using the configured strategy
  let mergeResult;
  if (strategy === "squash") {
    mergeResult = await runGitCommand(["merge", "--squash", branchName], mainDir);
    if (mergeResult.exitCode !== 0) {
      // Squash merges don't create MERGE_HEAD, so `merge --abort` silently
      // does nothing — use `reset --hard` to restore the target branch cleanly.
      await runGitCommand(["reset", "--hard", "HEAD"], mainDir);
      return {
        success: false,
        error: `Squash merge failed: ${mergeResult.stderr}`,
      };
    }
    // Build a detailed commit message from the squashed diff
    const commitMessage = await buildSquashCommitMessage(taskId, branchName, mainDir);
    const commitResult = await runGitCommand(["commit", "-m", commitMessage], mainDir);
    if (commitResult.exitCode !== 0) {
      return {
        success: false,
        error: `Squash commit failed: ${commitResult.stderr}`,
      };
    }
  } else if (strategy === "rebase") {
    // For rebase strategy: rebase task branch onto target, then fast-forward
    // Create a temporary worktree for the rebase to avoid disrupting main
    const rebaseResult = await runGitCommand(["rebase", targetBranch, branchName], mainDir);
    if (rebaseResult.exitCode !== 0) {
      await runGitCommand(["rebase", "--abort"], mainDir);
      return {
        success: false,
        error: `Rebase failed: ${rebaseResult.stderr}`,
      };
    }
    await runGitCommand(["checkout", targetBranch], mainDir);
    mergeResult = await runGitCommand(["merge", "--ff-only", branchName], mainDir);
    if (mergeResult.exitCode !== 0) {
      return {
        success: false,
        error: `Fast-forward merge failed: ${mergeResult.stderr}`,
      };
    }
  } else {
    // merge strategy: --no-ff
    mergeResult = await runGitCommand(
      ["merge", "--no-ff", branchName, "-m", `[${taskId}] merge`],
      mainDir,
    );
    if (mergeResult.exitCode !== 0) {
      await runGitCommand(["merge", "--abort"], mainDir);
      return {
        success: false,
        error: `Merge failed: ${mergeResult.stderr}`,
      };
    }
  }

  // Push the target branch
  const pushResult = await runGitCommand(["push", "origin", targetBranch], mainDir);
  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to push ${targetBranch}: ${pushResult.stderr}`,
    };
  }

  const commitShaResult = await runGitCommand(["rev-parse", "HEAD"], mainDir);
  return {
    success: true,
    mergeCommitSha: commitShaResult.exitCode === 0 ? commitShaResult.stdout.trim() : undefined,
  };
}

/**
 * Update the task file's status to COMPLETE on the target branch.
 *
 * Uses a temporary git worktree to avoid disrupting any active working trees.
 * Failure is non-fatal — the merge has already succeeded.
 *
 * @param taskId - The task identifier
 * @param adapter - The project adapter
 * @param targetBranch - The branch where the status update should be committed
 */
export async function updateTaskFileStatus(
  taskId: string,
  adapter: ProjectAdapter,
  targetBranch: string,
  expectedOriginPushUrl?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isConservativeBranchName(targetBranch)) {
    return { success: false, error: "Unsafe Git branch name" };
  }
  const cwd = adapter.projectRoot;
  const worktreePath = path.resolve(cwd, ".quack/tmp-status-update");

  try {
    // Fetch latest
    if (expectedOriginPushUrl && !(await originPushUrlMatches(cwd, expectedOriginPushUrl))) {
      return { success: false, error: "Git origin changed before task-status publication" };
    }
    const fetchArgs = [
      "fetch",
      expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin",
      `${targetBranch}:refs/remotes/origin/${targetBranch}`,
    ];
    const fetchResult = expectedOriginPushUrl
      ? await runBoundGitCommand(fetchArgs, cwd, expectedOriginPushUrl)
      : await runGitCommand(fetchArgs, cwd);
    if (fetchResult.exitCode !== 0) {
      return { success: false, error: `Failed to fetch ${targetBranch}: ${fetchResult.stderr}` };
    }

    // Create temp worktree
    const addResult = await runGitCommand(
      ["worktree", "add", worktreePath, `origin/${targetBranch}`],
      cwd,
    );
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to create temp worktree: ${addResult.stderr}`,
      };
    }

    // Find the task file
    const taskDir = path.resolve(worktreePath, adapter.config.project.taskDir);
    const { readdir, writeFile } = await import("node:fs/promises");

    // Kept purely as the directory-exists probe it always doubled as; the
    // file SELECTION below is now canonical (TASK-1334).
    try {
      await readdir(taskDir);
    } catch {
      return { success: false, error: `Task directory not found: ${taskDir}` };
    }

    // TASK-1334: canonical resolution, because this is the site with the
    // largest blast radius in the whole class. It rewrites the file's Status
    // to COMPLETE, commits it under the PARENT's task id, and pushes straight
    // to the target branch with no PR. A prefix match here could therefore
    // publish a status change to a DIFFERENT task's spec.
    //
    // It was blocked in practice only by accident: every wrongly-selected
    // child in this repo happens to already be COMPLETE, so the status regex
    // below refused. That is not a guard, and example carries two divergent
    // pairs whose child sits in READY, held back only by `autoMerge: false`.
    const { resolveTaskFile: resolveCanonicalTaskFile } =
      await import("../core/task-file-resolver.js");
    const resolvedSpec = await resolveCanonicalTaskFile(taskDir, taskId);
    if (!resolvedSpec) {
      return {
        success: false,
        error: `Task file not found for ${taskId} in ${taskDir}`,
      };
    }
    const taskFile = resolvedSpec.fileName;

    // Update status on the resolution's own path and content (round 2,
    // R2-1): nothing may change between certifying WHICH file is the task
    // and rewriting it, even inside this private worktree.
    const filePath = resolvedSpec.filePath;
    let content = resolvedSpec.content;
    if (/(\*\*Status:\*\*\s*)COMPLETE\b/.test(content)) {
      // Idempotent recovery: the remote update may have succeeded before the
      // Docker publication journal recorded it.
      return { success: true };
    }
    const statusRegex = /(\*\*Status:\*\*\s*)(BACKLOG|READY|IN_PROGRESS|VERIFYING)/;
    if (!statusRegex.test(content)) {
      return {
        success: false,
        error: `No updatable status found in ${taskFile}`,
      };
    }
    content = content.replace(statusRegex, "$1COMPLETE");
    const { listDuplicateClaimants } = await import("../core/task-file-resolver.js");
    const claimants = await listDuplicateClaimants(taskDir, taskId);
    if (claimants.length > 0) {
      const { formatDuplicateClaimantsMessage } = await import("../core/duplicate-claimants.js");
      return {
        success: false,
        error: formatDuplicateClaimantsMessage(taskId, claimants),
      };
    }
    await writeFile(filePath, content, "utf-8");

    // Commit and push from the worktree
    const relativeTaskPath = path.join(adapter.config.project.taskDir, taskFile);
    const addFileResult = await runGitCommand(["add", "--", relativeTaskPath], worktreePath);
    if (addFileResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to stage task file: ${addFileResult.stderr}`,
      };
    }

    const commitResult = await runGitCommand(
      ["commit", "-m", `[${taskId}] mark complete (auto-merge)`],
      worktreePath,
    );
    if (commitResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to commit status update: ${commitResult.stderr}`,
      };
    }

    if (
      expectedOriginPushUrl &&
      !(await originPushUrlMatches(worktreePath, expectedOriginPushUrl))
    ) {
      return { success: false, error: "Git origin changed before task-status publication" };
    }
    const pushArgs = [
      "push",
      expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin",
      `HEAD:${targetBranch}`,
    ];
    const pushResult = expectedOriginPushUrl
      ? await runBoundGitCommand(pushArgs, worktreePath, expectedOriginPushUrl)
      : await runGitCommand(pushArgs, worktreePath);
    if (pushResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to push status update: ${pushResult.stderr}`,
      };
    }

    return { success: true };
  } finally {
    // Clean up worktree (always, even on error)
    await runGitCommand(["worktree", "remove", worktreePath, "--force"], cwd);
  }
}

// ─── Branch cleanup types ───────────────────────────────────────────

export interface DeleteAfterMergeResult {
  deleted: boolean;
  reason?: BranchCleanupSkipReason | "delete-failed" | "origin-mismatch";
  localDeleted?: boolean;
  remoteDeleted?: boolean;
  owner?: string;
  requiresOverride?: boolean;
}

export interface SweepOptions {
  dryRun: boolean;
  minAgeDays?: number;
  baseBranch?: string;
  pattern?: string;
  allowedPrefixes?: string[];
  protectedOwners?: string[];
  protectedPatterns?: string[];
  ownerOverride?: BranchCleanupOwnerOverride;
  eventWriter?: IEventWriter;
}

export type BranchCleanupSkipReason =
  | "not-merged"
  | "head-mismatch"
  | "too-recent"
  | "skip-cleanup-marker"
  | "protected-branch"
  | "non-quack-branch"
  | "disallowed-prefix"
  | "protected-owner"
  | "cleanup-disabled"
  | "delete-error";

export interface SweepCandidateEntry {
  branch: string;
  owner?: string;
  provenance: string[];
  allowedPrefix?: string;
  protectedOwner: boolean;
  requiresOverride: boolean;
  overrideApplied: boolean;
  ageDays?: number;
  merged?: boolean;
  deleteEligible: boolean;
  reason?: BranchCleanupSkipReason;
  detail?: string;
}

export interface SweepSkipEntry {
  branch: string;
  reason: BranchCleanupSkipReason;
  detail?: string;
  owner?: string;
  requiresOverride?: boolean;
}

export interface SweepReport {
  dryRun: boolean;
  baseBranch: string;
  scanned: number;
  policy: Required<
    Pick<
      BranchCleanupPolicyConfig,
      | "enabled"
      | "allowedPrefixes"
      | "protectedOwners"
      | "protectedPatterns"
      | "requireOwnerOverride"
    >
  > & {
    retentionDays: number;
  };
  candidates: SweepCandidateEntry[];
  deleted: string[];
  skipped: SweepSkipEntry[];
  errors: Array<{ branch: string; error: string }>;
  durationMs: number;
}

// ─── Default constants ──────────────────────────────────────────────
// DEFAULT_PROTECTED_BRANCHES moved to judgment/producers/branch-mutation
// (TASK-1312): one definition shared by the cleanup policy, the sweep,
// and the centralized deletion guard.

const DEFAULT_BRANCH_RETENTION_DAYS = 1;
const QUACK_TASK_BRANCH_PREFIX = "quack/TASK-";
const DEFAULT_PROTECTED_OWNERS = ["contributor"];
const DEFAULT_PROTECTED_PATTERNS = ["contributor/**", "*/contributor/**"];

// ─── Helper ─────────────────────────────────────────────────────────

function extractTaskIdFromBranch(branch: string): string {
  const match = branch.match(/(?:quack|echo)\/(TASK-\d+)/i);
  return match?.[1] ?? branch;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(value: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(value));
}

function normalizeOwner(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function cleanupPolicy(
  adapter: ProjectAdapter,
  opts?: SweepOptions,
): Required<
  Pick<
    BranchCleanupPolicyConfig,
    "enabled" | "allowedPrefixes" | "protectedOwners" | "protectedPatterns" | "requireOwnerOverride"
  >
> & {
  retentionDays: number;
} {
  const config = adapter.config.git.branchCleanup;
  return {
    enabled: config?.enabled ?? true,
    retentionDays:
      opts?.minAgeDays ??
      config?.retentionDays ??
      adapter.config.git.branchRetentionDays ??
      DEFAULT_BRANCH_RETENTION_DAYS,
    allowedPrefixes: opts?.allowedPrefixes ?? config?.allowedPrefixes ?? [QUACK_TASK_BRANCH_PREFIX],
    protectedOwners: (
      opts?.protectedOwners ??
      config?.protectedOwners ??
      DEFAULT_PROTECTED_OWNERS
    ).map((owner) => owner.toLowerCase()),
    protectedPatterns:
      opts?.protectedPatterns ?? config?.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS,
    requireOwnerOverride: config?.requireOwnerOverride ?? true,
  };
}

function allowedPrefixForBranch(branch: string, allowedPrefixes: string[]): string | undefined {
  return allowedPrefixes.find((prefix) => branch.startsWith(prefix));
}

function ownerFromBranch(
  branch: string,
  protectedPatterns: string[],
): { owner?: string; provenance: string[] } {
  const lower = branch.toLowerCase();
  const provenance: string[] = [];
  if (lower.startsWith("quack/task-")) {
    provenance.push("prefix:quack/TASK-");
    return { owner: "quack", provenance };
  }
  if (lower.startsWith("echo/task-")) {
    provenance.push("prefix:echo/TASK-");
    return { owner: "hermes", provenance };
  }
  if (lower.startsWith("codex/")) {
    provenance.push("prefix:codex/");
    return { owner: "codex", provenance };
  }
  const protectedPattern = matchesPattern(branch, protectedPatterns);
  if (protectedPattern) {
    provenance.push(`protectedPattern:${protectedPattern}`);
    const firstSegment = lower.split(/[/-]/)[0]?.split("/")[0];
    return { owner: firstSegment || "unknown", provenance };
  }
  const contributorMatch = lower.match(/(^|[/_-])(contributor)([/_-]|$)/);
  if (contributorMatch) {
    provenance.push("name:contributor");
    return { owner: "contributor", provenance };
  }
  return { provenance };
}

async function ownerFromCommit(
  branch: string,
  cwd: string,
): Promise<{ owner?: string; provenance: string[] }> {
  const provenance: string[] = [];
  const msgResult = await runGitCommand(["log", "-1", "--format=%B", branch], cwd);
  if (msgResult.exitCode === 0) {
    const ownerLine = msgResult.stdout.match(/^(?:Owner|Branch-Owner|Task-Owner):\s*(.+)$/im);
    const owner = normalizeOwner(ownerLine?.[1]);
    if (owner) {
      provenance.push("trailer:owner");
      return { owner, provenance };
    }
  }
  const authorResult = await runGitCommand(["log", "-1", "--format=%an <%ae>", branch], cwd);
  if (authorResult.exitCode === 0) {
    const author = authorResult.stdout.toLowerCase();
    if (author.includes("contributor")) {
      provenance.push("commit-author:contributor");
      return { owner: "contributor", provenance };
    }
  }
  return { provenance };
}

async function resolveBranchOwner(
  branch: string,
  cwd: string,
  protectedPatterns: string[],
  inspectionRef = branch,
): Promise<{ owner?: string; provenance: string[] }> {
  const byBranch = ownerFromBranch(branch, protectedPatterns);
  if (byBranch.owner) return byBranch;
  const byCommit = await ownerFromCommit(inspectionRef, cwd);
  return {
    owner: byCommit.owner,
    provenance: [...byBranch.provenance, ...byCommit.provenance],
  };
}

/**
 * Safely delete a merged quack/TASK-* branch locally and remotely.
 *
 * Safety conditions (all must pass):
 *  1. Branch name matches /^quack\/TASK-/
 *  2. Branch, or an exact prepared squash/rebase result, is an ancestor of
 *     origin/<baseBranch> (fully merged)
 *  3. Branch last commit is older than minAgeDays (default: 1)
 *  4. Last commit message does NOT contain [skip-cleanup]
 *
 * Uses `git branch -d` (safe-delete) — will fail if not merged.
 * Exact-candidate cleanup uses compare-and-delete leases locally and remotely.
 */
export async function deleteAfterMerge(
  branch: string,
  adapter: ProjectAdapter,
  opts?: {
    baseBranch?: string;
    minAgeDays?: number;
    allowedPrefixes?: string[];
    protectedOwners?: string[];
    protectedPatterns?: string[];
    ownerOverride?: BranchCleanupOwnerOverride;
    eventWriter?: IEventWriter;
    expectedHeadCommit?: string;
    expectedMergedCommit?: string;
    expectedOriginPushUrl?: string;
  },
): Promise<DeleteAfterMergeResult> {
  const cwd = adapter.projectRoot;
  const baseBranch = opts?.baseBranch ?? adapter.config.git.baseBranch ?? "dev";
  const policy = cleanupPolicy(adapter, {
    dryRun: false,
    minAgeDays: opts?.minAgeDays,
    allowedPrefixes: opts?.allowedPrefixes,
    protectedOwners: opts?.protectedOwners,
    protectedPatterns: opts?.protectedPatterns,
    ownerOverride: opts?.ownerOverride,
  });
  const minAgeDays = policy.retentionDays;
  const protected_ = resolveProtectedBranches(adapter.config.git);

  if (!policy.enabled) {
    return { deleted: false, reason: "cleanup-disabled" };
  }

  // 1. Validate branch name
  const allowedPrefix = allowedPrefixForBranch(branch, policy.allowedPrefixes);
  if (!allowedPrefix) {
    return { deleted: false, reason: "non-quack-branch" };
  }

  // 2. Check against protected branches (round-2 F9: through the
  // centralized guard, matching the authority-audit claim)
  const retentionGuard = assertBranchDeletionAllowed(branch, protected_);
  if (!retentionGuard.allowed) {
    return { deleted: false, reason: "protected-branch" };
  }

  const expectedHeadCommit = opts?.expectedHeadCommit?.toLowerCase();
  const expectedMergedCommit = opts?.expectedMergedCommit?.toLowerCase();
  const branchRef = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  if (
    opts?.expectedOriginPushUrl &&
    !(await originPushUrlMatches(cwd, opts.expectedOriginPushUrl))
  ) {
    return { deleted: false, reason: "origin-mismatch" };
  }
  if (expectedHeadCommit) {
    if (!COMMIT_ID_PATTERN.test(expectedHeadCommit)) {
      return { deleted: false, reason: "head-mismatch" };
    }
    const currentHead = await runGitCommand(["rev-parse", "--verify", branchRef], cwd);
    if (
      currentHead.exitCode !== 0 ||
      currentHead.stdout.trim().toLowerCase() !== expectedHeadCommit
    ) {
      return { deleted: false, reason: "head-mismatch" };
    }
  }
  if (expectedMergedCommit && !COMMIT_ID_PATTERN.test(expectedMergedCommit)) {
    return { deleted: false, reason: "not-merged" };
  }
  if (expectedMergedCommit && !expectedHeadCommit) {
    return { deleted: false, reason: "head-mismatch" };
  }
  const inspectionRef = expectedHeadCommit ?? branch;

  const ownership = await resolveBranchOwner(branch, cwd, policy.protectedPatterns, inspectionRef);
  const protectedOwner = ownership.owner ? policy.protectedOwners.includes(ownership.owner) : false;
  const overrideApplied =
    protectedOwner &&
    opts?.ownerOverride &&
    normalizeOwner(opts.ownerOverride.owner) === ownership.owner &&
    opts.ownerOverride.reason.trim().length > 0;
  if (protectedOwner && policy.requireOwnerOverride && !overrideApplied) {
    return {
      deleted: false,
      reason: "protected-owner",
      owner: ownership.owner,
      requiresOverride: true,
    };
  }

  // 3. Check age
  const ageResult = await runGitCommand(["log", "-1", "--format=%ct", inspectionRef], cwd);
  const commitTimestamp = parseInt(ageResult.stdout.trim(), 10);
  if (ageResult.exitCode !== 0 || isNaN(commitTimestamp)) {
    // If we can't determine age, treat as too-recent (defensive)
    return { deleted: false, reason: "too-recent" };
  }
  const ageThresholdSec = Math.floor(Date.now() / 1000) - minAgeDays * 86400;
  if (commitTimestamp > ageThresholdSec) {
    return { deleted: false, reason: "too-recent" };
  }

  // 4. Check skip-cleanup marker
  const msgResult = await runGitCommand(["log", "-1", "--format=%B", inspectionRef], cwd);
  if (msgResult.exitCode === 0 && msgResult.stdout.includes("[skip-cleanup]")) {
    return { deleted: false, reason: "skip-cleanup-marker" };
  }

  // 5. Check ancestor (merged check). Squash and rebase publication create a
  // new target-side commit, so the sealed candidate itself is not necessarily
  // an ancestor. The publication journal supplies the exact prepared result
  // that was confirmed on the remote; refresh the tracking ref before using
  // that result as the merge proof.
  if (expectedMergedCommit) {
    if (
      opts?.expectedOriginPushUrl &&
      !(await originPushUrlMatches(cwd, opts.expectedOriginPushUrl))
    ) {
      return { deleted: false, reason: "origin-mismatch" };
    }
    const refreshArgs = [
      "fetch",
      opts?.expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin",
      `${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ];
    const refreshTarget = opts?.expectedOriginPushUrl
      ? await runBoundGitCommand(refreshArgs, cwd, opts.expectedOriginPushUrl)
      : await runGitCommand(refreshArgs, cwd);
    if (refreshTarget.exitCode !== 0) {
      return { deleted: false, reason: "not-merged" };
    }
  }
  const mergedInspectionRef = expectedMergedCommit ?? inspectionRef;
  const ancestorResult = await runGitCommand(
    ["merge-base", "--is-ancestor", mergedInspectionRef, `origin/${baseBranch}`],
    cwd,
  );
  if (ancestorResult.exitCode !== 0) {
    return { deleted: false, reason: "not-merged" };
  }

  // 6. An exact publication cleanup uses update-ref's old-value compare as
  // an atomic lease. If another process moves the branch after validation,
  // the delete fails rather than removing unrelated work.
  const localDeleteResult = expectedHeadCommit
    ? await runGitCommand(["update-ref", "-d", branchRef, expectedHeadCommit], cwd)
    : await runGitCommand(["branch", "-d", branch], cwd);
  const localDeleted = localDeleteResult.exitCode === 0;

  if (!localDeleted) {
    // Unexpected failure — local branch was not deleted
    return { deleted: false, reason: "delete-failed", localDeleted: false };
  }

  if (
    opts?.expectedOriginPushUrl &&
    !(await originPushUrlMatches(cwd, opts.expectedOriginPushUrl))
  ) {
    return {
      deleted: false,
      reason: "origin-mismatch",
      localDeleted: true,
      remoteDeleted: false,
    };
  }

  // 7. The remote delete carries the same exact expected old value. Git's
  // force-with-lease check is evaluated atomically by the remote, closing the
  // check/delete race without permitting a force update.
  const deleteArgs = expectedHeadCommit
    ? [
        "push",
        `--force-with-lease=${branchRef}:${expectedHeadCommit}`,
        opts?.expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin",
        `:${branchRef}`,
      ]
    : ["push", opts?.expectedOriginPushUrl ? BOUND_GIT_REMOTE : "origin", "--delete", branch];
  const remoteDeleteResult = opts?.expectedOriginPushUrl
    ? await runBoundGitCommand(deleteArgs, cwd, opts.expectedOriginPushUrl)
    : await runGitCommand(deleteArgs, cwd);
  let remoteDeleted = remoteDeleteResult.exitCode === 0;
  if (!remoteDeleted && expectedHeadCommit) {
    // A leased deletion against an already-absent ref is reported by real Git
    // as rejected `(stale info)`, not as "remote ref does not exist". Resolve
    // the exact remote ref after any failed push so the retry is idempotent
    // without ever treating a replacement head as deleted.
    const remoteAfterFailure = await readRemoteBranchHead(branch, cwd, opts?.expectedOriginPushUrl);
    if (!remoteAfterFailure.success) {
      return { deleted: false, reason: "delete-failed", localDeleted: true, remoteDeleted: false };
    }
    if (remoteAfterFailure.head === undefined) {
      remoteDeleted = true;
    } else if (remoteAfterFailure.head !== expectedHeadCommit) {
      return { deleted: false, reason: "head-mismatch", localDeleted: true, remoteDeleted: false };
    } else {
      return { deleted: false, reason: "delete-failed", localDeleted: true, remoteDeleted: false };
    }
  } else if (!remoteDeleted) {
    remoteDeleted = remoteDeleteResult.stderr.includes("remote ref does not exist");
  }

  // 8. Emit event
  const taskId = extractTaskIdFromBranch(branch);
  opts?.eventWriter?.emit("branch_deleted", {
    branch,
    taskId,
    remote: remoteDeleted,
    dryRun: false,
    timestamp: new Date().toISOString(),
  });

  // 9. Return result
  return { deleted: true, localDeleted: true, remoteDeleted };
}

/**
 * Scan and optionally delete merged quack/TASK-* branches (local + remote).
 */
export async function sweep(
  projectRoot: string,
  opts: SweepOptions,
  adapter: ProjectAdapter,
): Promise<SweepReport> {
  const startMs = Date.now();
  const baseBranch = opts.baseBranch ?? adapter.config.git.baseBranch ?? "dev";
  const policy = cleanupPolicy(adapter, opts);
  const minAgeDays = policy.retentionDays;
  const protected_ = resolveProtectedBranches(adapter.config.git);

  const deleted: string[] = [];
  const skipped: SweepSkipEntry[] = [];
  const candidates: SweepCandidateEntry[] = [];
  const errors: Array<{ branch: string; error: string }> = [];

  if (!policy.enabled) {
    return {
      dryRun: opts.dryRun,
      baseBranch,
      scanned: 0,
      policy,
      candidates,
      deleted,
      skipped,
      errors,
      durationMs: Date.now() - startMs,
    };
  }

  // Step 1: fetch to refresh remote-tracking refs (non-fatal)
  const fetchResult = await runGitCommand(["fetch", "origin"], projectRoot);
  if (fetchResult.exitCode !== 0) {
    errors.push({ branch: "fetch", error: fetchResult.stderr || "git fetch origin failed" });
    // Continue with stale remote refs
  }

  // Step 2: List all local branches
  const listResult = await runGitCommand(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    projectRoot,
  );
  if (listResult.exitCode !== 0) {
    throw new Error(`git for-each-ref failed: ${listResult.stderr}`);
  }

  const allBranches = listResult.stdout
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  // Step 3: Filter to branches in the cleanup universe. Default remains
  // conservative: only quack/TASK-* is scanned unless config/request opts in
  // additional prefixes.
  const candidateBranches = allBranches.filter(
    (branch) =>
      Boolean(allowedPrefixForBranch(branch, policy.allowedPrefixes)) ||
      Boolean(matchesPattern(branch, policy.protectedPatterns)),
  );

  // Step 4: Check each candidate
  for (const branch of candidateBranches) {
    try {
      const allowedPrefix = allowedPrefixForBranch(branch, policy.allowedPrefixes);
      const ownership = await resolveBranchOwner(branch, projectRoot, policy.protectedPatterns);
      const protectedOwner = ownership.owner
        ? policy.protectedOwners.includes(ownership.owner)
        : false;
      const overrideApplied =
        protectedOwner &&
        opts.ownerOverride &&
        normalizeOwner(opts.ownerOverride.owner) === ownership.owner &&
        opts.ownerOverride.reason.trim().length > 0;
      const candidate: SweepCandidateEntry = {
        branch,
        owner: ownership.owner,
        provenance: ownership.provenance,
        allowedPrefix,
        protectedOwner,
        requiresOverride: protectedOwner && policy.requireOwnerOverride && !overrideApplied,
        overrideApplied: Boolean(overrideApplied),
        deleteEligible: false,
      };
      candidates.push(candidate);

      if (!allowedPrefix) {
        candidate.reason = "disallowed-prefix";
        skipped.push({
          branch,
          reason: "disallowed-prefix",
          owner: ownership.owner,
          detail: "branch did not match configured cleanup prefixes",
        });
        continue;
      }

      // Protected branch check
      if (!assertBranchDeletionAllowed(branch, protected_).allowed) {
        candidate.reason = "protected-branch";
        skipped.push({ branch, reason: "protected-branch", owner: ownership.owner });
        continue;
      }

      if (protectedOwner && policy.requireOwnerOverride && !overrideApplied) {
        candidate.reason = "protected-owner";
        skipped.push({
          branch,
          reason: "protected-owner",
          owner: ownership.owner,
          requiresOverride: true,
        });
        continue;
      }

      // Age check
      const ageResult = await runGitCommand(["log", "-1", "--format=%ct", branch], projectRoot);
      const commitTimestamp = parseInt(ageResult.stdout.trim(), 10);
      if (ageResult.exitCode !== 0 || isNaN(commitTimestamp)) {
        candidate.reason = "too-recent";
        skipped.push({
          branch,
          reason: "too-recent",
          detail: "could not determine age",
          owner: ownership.owner,
        });
        continue;
      }
      const ageThresholdSec = Math.floor(Date.now() / 1000) - minAgeDays * 86400;
      candidate.ageDays = (Math.floor(Date.now() / 1000) - commitTimestamp) / 86400;
      if (commitTimestamp > ageThresholdSec) {
        candidate.reason = "too-recent";
        skipped.push({ branch, reason: "too-recent", owner: ownership.owner });
        continue;
      }

      // Skip-cleanup marker
      const msgResult = await runGitCommand(["log", "-1", "--format=%B", branch], projectRoot);
      if (msgResult.exitCode === 0 && msgResult.stdout.includes("[skip-cleanup]")) {
        candidate.reason = "skip-cleanup-marker";
        skipped.push({ branch, reason: "skip-cleanup-marker", owner: ownership.owner });
        continue;
      }

      // Ancestor check (merged check)
      const ancestorResult = await runGitCommand(
        ["merge-base", "--is-ancestor", branch, `origin/${baseBranch}`],
        projectRoot,
      );
      if (ancestorResult.exitCode !== 0) {
        candidate.reason = "not-merged";
        candidate.merged = false;
        skipped.push({ branch, reason: "not-merged", owner: ownership.owner });
        continue;
      }
      candidate.merged = true;

      // Eligible for deletion
      candidate.deleteEligible = true;
      if (opts.dryRun) {
        deleted.push(branch);
        // Emit dry-run event
        const taskId = extractTaskIdFromBranch(branch);
        opts.eventWriter?.emit("branch_deleted", {
          branch,
          taskId,
          remote: false,
          dryRun: true,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Actually delete
        const deleteResult = await deleteAfterMerge(branch, adapter, {
          baseBranch,
          minAgeDays,
          allowedPrefixes: policy.allowedPrefixes,
          protectedOwners: policy.protectedOwners,
          protectedPatterns: policy.protectedPatterns,
          ownerOverride: opts.ownerOverride,
          eventWriter: opts.eventWriter,
        });
        if (deleteResult.deleted) {
          deleted.push(branch);
        } else {
          candidate.deleteEligible = false;
          candidate.reason = "delete-error";
          skipped.push({
            branch,
            reason: "delete-error",
            detail: deleteResult.reason,
            owner: deleteResult.owner ?? ownership.owner,
            requiresOverride: deleteResult.requiresOverride,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ branch, error: message });
    }
  }

  return {
    dryRun: opts.dryRun,
    baseBranch,
    scanned: candidates.length,
    policy,
    candidates,
    deleted,
    skipped,
    errors,
    durationMs: Date.now() - startMs,
  };
}
