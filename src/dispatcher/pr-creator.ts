// ─── PR Creator ─────────────────────────────────────────────────────
// Creates pull requests via the `gh` CLI tool. Generates a PR with the
// task spec, verification results, and judge verdict as context.

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { JudgeResult, VerificationResult } from "../core/types.js";
import { getSyncMap } from "../integrations/github/sync-map.js";
import {
  resolveTrustedGitHubRepository,
  runTrustedGitHubResult,
  type TrustedGitHubRepository,
} from "../worker/trusted-executable.js";

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum output buffer (1MB) */
const MAX_BUFFER = 1024 * 1024;

/** Timeout for gh commands in milliseconds (60 seconds) */
const GH_TIMEOUT_MS = 60_000;

async function runGitHub(
  projectRoot: string,
  args: readonly string[],
  repository: TrustedGitHubRepository,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runTrustedGitHubResult(projectRoot, args, {
    timeoutMs: GH_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    expectedRepository: repository,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "GitHub CLI command failed");
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

// ─── Types ──────────────────────────────────────────────────────────

export interface PrCreateResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

export interface PrCreateInput {
  taskId: string;
  title: string;
  body: string;
  baseBranch: string;
  /** Exact source branch already pushed by the trusted host. */
  headBranch: string;
  /** Exact commit the remote pull-request head must still identify. */
  expectedHeadOid: string;
  /** Optional previously pinned repository identity (required for durable recovery). */
  repository?: TrustedGitHubRepository;
  /** Unique host-owned marker appended to a recoverable publication PR. */
  ownershipMarker?: string;
  /** Persist candidate state before the creator performs another remote action. */
  onCandidate?: (candidate: PullRequestCandidate) => void | Promise<void>;
}

export interface PullRequestCandidate {
  url: string;
  ownershipMarker: string;
  state: "pending" | "accepted" | "closed";
}

export interface PullRequestBinding {
  repository: TrustedGitHubRepository;
  headBranch: string;
  baseBranch: string;
  headOid: string;
}

export interface PullRequestInspection {
  url: string;
  state: string;
  mergeCommitSha?: string;
}

const HASH_PATTERN = /^[a-f0-9]{40,64}$/iu;
const OWNERSHIP_MARKER_PATTERN =
  /^<!-- quack-publication:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/iu;
const PR_METADATA_FIELDS =
  "url,state,body,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,mergeCommit";

function expectedRepositoryFromAdapter(
  adapter: ProjectAdapter,
): { owner: string; repo: string } | undefined {
  const configured = adapter.config.integrations?.github;
  return configured ? { owner: configured.owner, repo: configured.repo } : undefined;
}

export async function resolvePullRequestRepository(
  adapter: ProjectAdapter,
): Promise<TrustedGitHubRepository> {
  return resolveTrustedGitHubRepository(adapter.projectRoot, {
    timeoutMs: GH_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    ...(expectedRepositoryFromAdapter(adapter)
      ? { expectedRepository: expectedRepositoryFromAdapter(adapter) }
      : {}),
  });
}

function assertPullRequestUrlRepository(
  value: unknown,
  repository: TrustedGitHubRepository,
): string {
  if (typeof value !== "string") throw new Error("Pull request metadata omitted its URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Pull request metadata returned a malformed URL");
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/[1-9][0-9]*\/?$/u.exec(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    parsed.host.toLowerCase() !== repository.host.toLowerCase() ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !match ||
    match[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
    match[2]?.toLowerCase() !== repository.repo.toLowerCase()
  ) {
    throw new Error("Pull request URL does not match the pinned repository");
  }
  return value;
}

function validateHeadRepository(
  metadata: Record<string, unknown>,
  repository: TrustedGitHubRepository,
): void {
  const headRepository = metadata.headRepository;
  const headOwner = metadata.headRepositoryOwner;
  if (
    typeof headRepository !== "object" ||
    headRepository === null ||
    Array.isArray(headRepository) ||
    typeof (headRepository as { name?: unknown }).name !== "string" ||
    (headRepository as { name: string }).name.toLowerCase() !== repository.repo.toLowerCase() ||
    typeof headOwner !== "object" ||
    headOwner === null ||
    Array.isArray(headOwner) ||
    typeof (headOwner as { login?: unknown }).login !== "string" ||
    (headOwner as { login: string }).login.toLowerCase() !== repository.owner.toLowerCase()
  ) {
    throw new Error("Pull request head repository does not match the pinned origin repository");
  }
  const nameWithOwner = (headRepository as { nameWithOwner?: unknown }).nameWithOwner;
  if (
    nameWithOwner !== undefined &&
    (typeof nameWithOwner !== "string" ||
      nameWithOwner.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase())
  ) {
    throw new Error("Pull request head repository does not match the pinned origin repository");
  }
}

function validatePullRequestMetadata(
  value: unknown,
  binding: PullRequestBinding,
): PullRequestInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned invalid pull-request metadata");
  }
  const metadata = value as Record<string, unknown>;
  const url = assertPullRequestUrlRepository(metadata.url, binding.repository);
  validateHeadRepository(metadata, binding.repository);
  if (metadata.headRefName !== binding.headBranch) {
    throw new Error("Pull request head branch does not match the sealed publication branch");
  }
  if (metadata.baseRefName !== binding.baseBranch) {
    throw new Error("Pull request base branch does not match the publication target");
  }
  if (
    typeof metadata.headRefOid !== "string" ||
    !HASH_PATTERN.test(metadata.headRefOid) ||
    metadata.headRefOid.toLowerCase() !== binding.headOid.toLowerCase()
  ) {
    throw new Error("Pull request head commit does not match the sealed publication commit");
  }
  if (typeof metadata.state !== "string") {
    throw new Error("Pull request metadata omitted its state");
  }
  const mergeCommit = metadata.mergeCommit;
  const mergeCommitSha =
    typeof mergeCommit === "object" &&
    mergeCommit !== null &&
    !Array.isArray(mergeCommit) &&
    typeof (mergeCommit as Record<string, unknown>).oid === "string" &&
    HASH_PATTERN.test((mergeCommit as { oid: string }).oid)
      ? (mergeCommit as { oid: string }).oid
      : undefined;
  return { url, state: metadata.state, ...(mergeCommitSha ? { mergeCommitSha } : {}) };
}

function validateOwnershipMarker(value: string): string {
  if (!OWNERSHIP_MARKER_PATTERN.test(value)) {
    throw new Error("Pull request ownership marker is invalid");
  }
  return value;
}

function validatePullRequestOwnership(
  value: unknown,
  binding: PullRequestBinding,
  ownershipMarker: string,
): { url: string; state: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned invalid pull-request metadata");
  }
  const metadata = value as Record<string, unknown>;
  const url = assertPullRequestUrlRepository(metadata.url, binding.repository);
  if (typeof metadata.body !== "string") {
    throw new Error("Pull request metadata omitted its ownership body");
  }
  const matches = metadata.body.split(/\r?\n/u).filter((line) => line === ownershipMarker);
  if (matches.length !== 1) {
    throw new Error("Pull request does not contain the unique Quack ownership marker");
  }
  if (typeof metadata.state !== "string") {
    throw new Error("Pull request metadata omitted its state");
  }
  return { url, state: metadata.state.toUpperCase() };
}

async function readPullRequestMetadata(
  projectRoot: string,
  pullRequestUrl: string,
  binding: PullRequestBinding,
): Promise<unknown> {
  const { stdout } = await runGitHub(
    projectRoot,
    ["pr", "view", pullRequestUrl, "--json", PR_METADATA_FIELDS],
    binding.repository,
  );
  return JSON.parse(stdout) as unknown;
}

export async function inspectExactPullRequest(
  projectRoot: string,
  pullRequestUrl: string,
  binding: PullRequestBinding,
): Promise<PullRequestInspection> {
  return validatePullRequestMetadata(
    await readPullRequestMetadata(projectRoot, pullRequestUrl, binding),
    binding,
  );
}

/**
 * Reconcile a journaled PR candidate before another PR can be created. Exact,
 * still-valid candidates are adopted. Invalid candidates are closed only when
 * their target repository and unique Quack marker prove ownership.
 */
export async function recoverPullRequestCandidate(
  projectRoot: string,
  candidate: Pick<PullRequestCandidate, "url" | "ownershipMarker">,
  binding: PullRequestBinding,
): Promise<PullRequestCandidate> {
  const ownershipMarker = validateOwnershipMarker(candidate.ownershipMarker);
  const metadata = await readPullRequestMetadata(projectRoot, candidate.url, binding);
  const ownership = validatePullRequestOwnership(metadata, binding, ownershipMarker);
  try {
    const inspected = validatePullRequestMetadata(metadata, binding);
    if (inspected.state.toUpperCase() !== "CLOSED") {
      return { url: inspected.url, ownershipMarker, state: "accepted" };
    }
  } catch {
    // Ownership is checked independently below before any destructive action.
  }

  if (ownership.state === "CLOSED") {
    return { url: ownership.url, ownershipMarker, state: "closed" };
  }
  if (ownership.state !== "OPEN") {
    throw new Error(`Refusing to close owned pull request in state ${ownership.state}`);
  }

  await runGitHub(projectRoot, ["pr", "close", ownership.url], binding.repository);
  const closedMetadata = await readPullRequestMetadata(projectRoot, ownership.url, binding);
  const closed = validatePullRequestOwnership(closedMetadata, binding, ownershipMarker);
  if (closed.state !== "CLOSED") {
    throw new Error("Pull request close was not confirmed by an exact readback");
  }
  return { url: closed.url, ownershipMarker, state: "closed" };
}

// ─── PR body builder ────────────────────────────────────────────────

/**
 * Build a PR body from task context, verification results, and judge verdict.
 */
export function buildPrBody(
  taskId: string,
  taskSpec: string,
  verification: VerificationResult | null,
  judgeResult: JudgeResult,
): string {
  const lines: string[] = [];

  lines.push(`## Task: ${taskId}`);
  lines.push("");

  // Verification summary
  lines.push("## Verification Results");
  if (verification) {
    lines.push(verification.allPassed ? "All checks **PASSED**." : "Some checks **FAILED**.");
    lines.push("");
    for (const cmd of verification.commands) {
      const icon = cmd.passed ? "pass" : "FAIL";
      lines.push(`- [${icon}] **${cmd.name}**: ${cmd.output.slice(0, 200)}`);
    }
    for (const check of verification.conventionChecks) {
      const icon = check.passed ? "pass" : "FAIL";
      lines.push(`- [${icon}] **${check.name}**: ${check.output.slice(0, 200)}`);
    }
  } else {
    lines.push("No verification results available.");
  }
  lines.push("");

  // Judge verdict
  lines.push("## Judge Verdict");
  lines.push(`- **Verdict:** ${judgeResult.verdict}`);
  lines.push(`- **Confidence:** ${(judgeResult.confidence * 100).toFixed(0)}%`);
  if (judgeResult.scopeViolations.length > 0) {
    lines.push(`- **Scope Violations:** ${judgeResult.scopeViolations.join(", ")}`);
  }
  if (judgeResult.criteriaGaps.length > 0) {
    lines.push(`- **Criteria Gaps:** ${judgeResult.criteriaGaps.join(", ")}`);
  }
  if (judgeResult.feedback) {
    lines.push(`- **Feedback:** ${judgeResult.feedback}`);
  }
  lines.push("");

  // Success criteria from task spec (extract as checklist)
  const criteriaMatch = taskSpec.match(/## Success Criteria\s*\n([\s\S]*?)(?=\n##|\n*$)/);
  if (criteriaMatch) {
    lines.push("## Success Criteria");
    lines.push(criteriaMatch[1].trim());
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by Quack Agent*");

  return lines.join("\n");
}

/**
 * Build a PR body with GitHub issue link (if mapped).
 */
export async function buildPrBodyWithIssueLink(
  taskId: string,
  taskSpec: string,
  verification: VerificationResult | null,
  judgeResult: JudgeResult,
  adapter: ProjectAdapter,
): Promise<string> {
  let body = buildPrBody(taskId, taskSpec, verification, judgeResult);

  // Check if task is mapped to a GitHub issue
  const githubConfig = adapter.config.integrations?.github;
  if (githubConfig && githubConfig.closeOnMerge) {
    try {
      const syncMap = await getSyncMap(adapter.projectRoot);
      const issueNumber = syncMap.getIssueForTask(taskId);
      if (issueNumber) {
        body += `\n\nCloses #${issueNumber}`;
      }
    } catch (err: unknown) {
      // Non-fatal: log but don't block PR creation
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to check sync map: ${msg}`);
    }
  }

  return body;
}

// ─── PR creation ────────────────────────────────────────────────────

/**
 * Create a pull request using the `gh` CLI.
 *
 * @param input - PR creation parameters (taskId, title, body, baseBranch)
 * @param adapter - The project adapter with project root
 * @returns Result with success status and PR URL
 */
export async function createPullRequest(
  input: PrCreateInput,
  adapter: ProjectAdapter,
): Promise<PrCreateResult> {
  const cwd = adapter.projectRoot;
  if (!HASH_PATTERN.test(input.expectedHeadOid)) {
    return { success: false, error: "Failed to create PR: expected head commit is invalid" };
  }
  let ownershipMarker: string | undefined;
  try {
    ownershipMarker =
      input.ownershipMarker === undefined
        ? undefined
        : validateOwnershipMarker(input.ownershipMarker);
    if (ownershipMarker && input.body.split(/\r?\n/u).includes(ownershipMarker)) {
      throw new Error("Pull request body already contains its ownership marker");
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const repository = input.repository ?? (await resolvePullRequestRepository(adapter));
    const binding: PullRequestBinding = {
      repository,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      headOid: input.expectedHeadOid,
    };
    let createFailure: unknown;
    let createdUrl: string | undefined;
    try {
      const { stdout, stderr } = await runGitHub(
        cwd,
        [
          "pr",
          "create",
          "--title",
          input.title,
          "--body",
          ownershipMarker ? `${input.body}\n\n${ownershipMarker}` : input.body,
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
        ],
        repository,
      );

      // gh pr create outputs the PR URL on stdout, although some versions use stderr.
      const stdoutUrl = stdout.trim();
      const stderrUrl = stderr.split("\n").find((line) => line.trim().startsWith("https://"));
      createdUrl = stdoutUrl.startsWith("https://") ? stdoutUrl : stderrUrl?.trim();
    } catch (error: unknown) {
      createFailure = error;
    }

    if (createdUrl) {
      const candidateUrl = assertPullRequestUrlRepository(createdUrl, repository);
      if (ownershipMarker) {
        try {
          await input.onCandidate?.({
            url: candidateUrl,
            ownershipMarker,
            state: "pending",
          });
          const recovered = await recoverPullRequestCandidate(
            cwd,
            { url: candidateUrl, ownershipMarker },
            binding,
          );
          await input.onCandidate?.(recovered);
          if (recovered.state === "accepted") {
            return { success: true, prUrl: recovered.url };
          }
          return {
            success: false,
            error: "Failed to create PR: created pull request failed validation and was closed",
          };
        } catch (error: unknown) {
          return {
            success: false,
            error: `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const inspected = await inspectExactPullRequest(cwd, candidateUrl, binding);
      return { success: true, prUrl: inspected.url };
    }

    // A remote may accept `gh pr create` and lose the response, or the host
    // may crash before its publication journal is advanced. Recover only an
    // unambiguous PR for the exact host-validated repo/head/base/commit tuple.
    try {
      const { stdout } = await runGitHub(
        cwd,
        [
          "pr",
          "list",
          "--head",
          input.headBranch,
          "--base",
          input.baseBranch,
          "--state",
          "all",
          "--limit",
          "20",
          "--json",
          PR_METADATA_FIELDS,
        ],
        repository,
      );
      const parsed = JSON.parse(stdout) as unknown;
      if (Array.isArray(parsed)) {
        if (ownershipMarker) {
          const matches: PullRequestInspection[] = [];
          for (const candidate of parsed) {
            try {
              const inspected = validatePullRequestMetadata(candidate, binding);
              validatePullRequestOwnership(candidate, binding, ownershipMarker);
              matches.push(inspected);
            } catch {
              // Historical, malformed, or differently owned rows are not candidates.
            }
          }
          if (matches.length !== 1) {
            throw new Error("Lost-response recovery did not find one exact marker-owned PR");
          }
          const [inspected] = matches;
          if (!inspected) throw new Error("Lost-response recovery candidate disappeared");
          if (inspected.state.toUpperCase() === "CLOSED") {
            throw new Error("Recovered marker-owned pull request is already closed");
          }
          await input.onCandidate?.({
            url: inspected.url,
            ownershipMarker,
            state: "pending",
          });
          await input.onCandidate?.({
            url: inspected.url,
            ownershipMarker,
            state: "accepted",
          });
          return { success: true, prUrl: inspected.url };
        }
        if (parsed.length === 1) {
          const inspected = validatePullRequestMetadata(parsed[0], binding);
          return { success: true, prUrl: inspected.url };
        }
      }
    } catch {
      // Preserve the original create failure below. Ambiguous, incomplete, or
      // mismatched lookups are never treated as successful publication.
    }
    const message =
      createFailure instanceof Error
        ? createFailure.message
        : createFailure === undefined
          ? "GitHub CLI did not return a pull request URL"
          : "GitHub CLI command failed";
    return {
      success: false,
      error: `Failed to create PR: ${message}`,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
