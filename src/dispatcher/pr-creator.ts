// ─── PR Creator ─────────────────────────────────────────────────────
// Creates pull requests via the `gh` CLI tool. Generates a PR with the
// task spec, verification results, and judge verdict as context.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { JudgeResult, VerificationResult } from "../core/types.js";
import { getSyncMap } from "../integrations/github/sync-map.js";
import {
  originPushUrlMatches,
  pullRequestUrlMatchesOrigin,
  resolveOriginGitHubRepository,
  type GitHubRepositoryIdentity,
} from "./github-repository.js";

const execFileAsync = promisify(execFile);

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum output buffer (1MB) */
const MAX_BUFFER = 1024 * 1024;

/** Timeout for gh commands in milliseconds (60 seconds) */
const GH_TIMEOUT_MS = 60_000;

// ─── Types ──────────────────────────────────────────────────────────

export type PrCreateResult =
  | { success: true; prUrl: string; error?: never }
  | { success: false; error: string; prUrl?: never };

export interface PrCreateInput {
  taskId: string;
  title: string;
  body: string;
  baseBranch: string;
  /** Explicit source branch for host-side/Docker publication. */
  headBranch: string;
  /** Exact remote head commit required for ambiguous-create recovery. */
  headCommitSha: string;
}

const COMMIT_ID_PATTERN = /^[a-f0-9]{40,64}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headRepositoryName(value: Record<string, unknown>): string | undefined {
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

function matchesExpectedPullRequest(
  value: unknown,
  repository: GitHubRepositoryIdentity,
  input: PrCreateInput,
): value is Record<string, unknown> & { url: string } {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    pullRequestUrlMatchesOrigin(value.url, repository) &&
    value.baseRefName === input.baseBranch &&
    value.headRefName === input.headBranch &&
    typeof value.headRefOid === "string" &&
    value.headRefOid.toLowerCase() === input.headCommitSha?.toLowerCase() &&
    headRepositoryName(value)?.toLowerCase() === repository.nameWithOwner.toLowerCase()
  );
}

async function inspectCreatedPullRequest(
  cwd: string,
  repository: GitHubRepositoryIdentity,
  prUrl: string,
  input: PrCreateInput,
): Promise<boolean> {
  if (!(await originPushUrlMatches(cwd, repository.pushUrl))) return false;
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "view",
      prUrl,
      "--repo",
      repository.selector,
      "--json",
      "url,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
    ],
    { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
  );
  return matchesExpectedPullRequest(JSON.parse(stdout) as unknown, repository, input);
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
      const syncMap = await getSyncMap(adapter.config);
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
  repositoryBinding?: GitHubRepositoryIdentity,
): Promise<PrCreateResult> {
  const cwd = adapter.projectRoot;
  if (!input.headBranch || !COMMIT_ID_PATTERN.test(input.headCommitSha)) {
    return {
      success: false,
      error: "Host-side PR publication requires a branch and exact head commit",
    };
  }
  let repository: GitHubRepositoryIdentity | undefined;
  let createAttempted = false;

  try {
    // Resolve once, then bind the mutating command to that immutable repository
    // identity. Relying on gh's ambient/default repository could create the PR
    // in a different repository if that context changes between validation and
    // the side effect.
    repository = repositoryBinding ?? (await resolveOriginGitHubRepository(cwd));
    if (!(await originPushUrlMatches(cwd, repository.pushUrl))) {
      throw new Error("Git origin changed after the publication repository was bound");
    }
    createAttempted = true;
    const { stdout, stderr } = await execFileAsync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--base",
        input.baseBranch,
        "--repo",
        repository.selector,
        "--head",
        input.headBranch,
      ],
      {
        cwd,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );

    // gh pr create outputs the PR URL on stdout
    const stdoutUrl = stdout.trim();
    const stderrUrl = stderr.split("\n").find((line) => line.trim().startsWith("http"));
    const prUrl = stdoutUrl.startsWith("http") ? stdoutUrl : stderrUrl?.trim();

    if (!prUrl || !pullRequestUrlMatchesOrigin(prUrl, repository)) {
      throw new Error("GitHub CLI did not return a pull request URL for the resolved repository");
    }

    if (!(await inspectCreatedPullRequest(cwd, repository, prUrl, input))) {
      throw new Error("created pull request does not match the exact repository/base/head binding");
    }

    return { success: true, prUrl };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // A remote may accept `gh pr create` and lose the response, or the host
    // may crash before its publication journal is advanced. Recover only an
    // unambiguous PR for the exact host-validated head/base pair.
    if (createAttempted && input.headBranch && input.headCommitSha) {
      try {
        repository ??= await resolveOriginGitHubRepository(cwd);
        if (!(await originPushUrlMatches(cwd, repository.pushUrl))) {
          throw new Error("Git origin changed before pull request recovery inspection");
        }
        const { stdout } = await execFileAsync(
          "gh",
          [
            "pr",
            "list",
            "--head",
            input.headBranch,
            "--base",
            input.baseBranch,
            "--repo",
            repository.selector,
            "--state",
            "all",
            "--limit",
            "2",
            "--json",
            "url,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
          ],
          { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        );
        const parsed = JSON.parse(stdout) as unknown;
        const matches = Array.isArray(parsed)
          ? parsed.filter((value) => matchesExpectedPullRequest(value, repository!, input))
          : [];
        if (matches.length === 1) {
          return { success: true, prUrl: matches[0].url };
        }
      } catch {
        // Preserve the original create failure below. Ambiguous or failed
        // lookups are never treated as successful publication.
      }
    }
    return {
      success: false,
      error: `Failed to create PR: ${message}`,
    };
  }
}
