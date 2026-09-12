// ─── GitHub Issue Fetcher ───────────────────────────────────────────
// Fetch GitHub issues via gh CLI.

import type { GitHubIssue, GitHubConfig } from "./github-types.js";
import {
  assertIssueNumber,
  assertIssueUrl,
  assertNonEmptyString,
  parseIssueLabels,
  parseJsonArray,
  parseJsonObject,
  runBoundGitHubCommand,
} from "./trusted-github.js";
import {
  resolveTrustedGitHubRepository,
  type TrustedGitHubRepository,
} from "../../worker/trusted-executable.js";

const MAX_BUFFER = 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;

// ─── gh CLI Validation ──────────────────────────────────────────────

/**
 * Validate that gh CLI is installed and authenticated.
 * Throws a descriptive error if not.
 */
export async function validateGhCli(projectRoot: string = process.cwd()): Promise<void> {
  try {
    const repository = await resolveTrustedGitHubRepository(projectRoot, {
      timeoutMs: 10_000,
      maxBuffer: MAX_BUFFER,
    });
    const result = await runBoundGitHubCommand(
      projectRoot,
      repository,
      ["repo", "view", "--json", "nameWithOwner"],
      { timeoutMs: 10_000 },
    );
    const data = parseJsonObject(result.stdout, "GitHub CLI repository validation");
    const expectedName = `${repository.owner}/${repository.repo}`;
    if (
      typeof data.nameWithOwner !== "string" ||
      data.nameWithOwner.toLowerCase() !== expectedName.toLowerCase()
    ) {
      throw new Error("GitHub CLI repository validation returned the wrong repository");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("not found") ||
      message.includes("ENOENT") ||
      message.includes("is not recognized")
    ) {
      throw new Error(
        "GitHub CLI (gh) is not installed. Install from https://cli.github.com/ and run 'gh auth login'.",
      );
    }
    if (message.includes("not logged") || message.includes("no oauth")) {
      throw new Error("GitHub CLI is not authenticated. Run 'gh auth login' to authenticate.");
    }
    throw new Error(`GitHub CLI validation failed: ${message}`);
  }
}

// ─── File Reference Extraction ──────────────────────────────────────

/**
 * Extract file references from issue body and comments.
 * Matches backtick-wrapped paths with common extensions.
 */
function extractFileReferences(body: string, comments: Array<{ body: string }>): string[] {
  const pattern = /`([^`]+\.(ts|js|tsx|jsx|md|json|py|go|java|rb|php|c|cpp|h|hpp|rs|swift|kt))`/gi;
  const files = new Set<string>();

  const allText = [body, ...comments.map((c) => c.body)].join("\n");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(allText)) !== null) {
    files.add(match[1]);
  }

  return Array.from(files);
}

function parseAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub issue response did not contain an assignees array");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { login?: unknown }).login !== "string"
    ) {
      throw new Error("GitHub issue response contained an invalid assignee");
    }
    return (entry as { login: string }).login;
  });
}

function parseComments(value: unknown): GitHubIssue["comments"] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub issue response did not contain a comments array");
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("GitHub issue response contained an invalid comment");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.author !== "object" ||
      record.author === null ||
      Array.isArray(record.author) ||
      typeof (record.author as { login?: unknown }).login !== "string" ||
      typeof record.body !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      throw new Error("GitHub issue response contained an incomplete comment");
    }
    return {
      author: (record.author as { login: string }).login,
      body: record.body,
      createdAt: record.createdAt,
    };
  });
}

function parseIssueResponse(
  data: Record<string, unknown>,
  repository: TrustedGitHubRepository,
  expectedNumber: number,
): GitHubIssue {
  if (data.number !== expectedNumber) {
    throw new Error("GitHub issue response returned the wrong issue number");
  }
  const title = assertNonEmptyString(data.title, "GitHub issue title");
  let body = "";
  if (data.body !== null && data.body !== undefined) {
    if (typeof data.body !== "string") {
      throw new Error("GitHub issue body was not a string or null");
    }
    body = data.body;
  }
  const labels = parseIssueLabels(data.labels, "GitHub issue response");
  const assignees = parseAssignees(data.assignees);
  const comments = parseComments(data.comments);
  if (typeof data.state !== "string") {
    throw new Error("GitHub issue response did not contain a state");
  }
  const normalizedState = data.state.toLowerCase();
  if (normalizedState !== "open" && normalizedState !== "closed") {
    throw new Error(`GitHub issue response contained an invalid state: ${data.state}`);
  }
  const url = assertIssueUrl(data.url, repository, expectedNumber);

  return {
    number: expectedNumber,
    title,
    body,
    labels,
    assignees,
    comments,
    referencedFiles: extractFileReferences(body, comments),
    linkedPRs: [],
    state: normalizedState,
    url,
  };
}

function validateImportLabel(label: string): string {
  const hasControlCharacter = [...label].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (label.length === 0 || label.length > 50 || hasControlCharacter) {
    throw new Error(`Refusing invalid GitHub import label: ${JSON.stringify(label)}`);
  }
  return label;
}

// ─── Fetch Single Issue ─────────────────────────────────────────────

/**
 * Fetch a single GitHub issue by number.
 */
export async function fetchIssue(
  owner: string,
  repo: string,
  number: number,
  projectRoot: string = process.cwd(),
): Promise<GitHubIssue> {
  try {
    assertIssueNumber(number);
    const result = await runBoundGitHubCommand(
      projectRoot,
      { owner, repo },
      [
        "issue",
        "view",
        String(number),
        "--json",
        "number,title,body,labels,assignees,comments,state,url",
      ],
      { timeoutMs: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    return parseIssueResponse(
      parseJsonObject(result.stdout, "GitHub issue response"),
      result.repository,
      number,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issue #${number}: ${message}`);
  }
}

// ─── Fetch Issues by Label ──────────────────────────────────────────

/**
 * Fetch all open issues with a specific label.
 */
export async function fetchIssuesByLabel(
  owner: string,
  repo: string,
  label: string,
  projectRoot: string = process.cwd(),
): Promise<GitHubIssue[]> {
  try {
    const safeLabel = validateImportLabel(label);
    const result = await runBoundGitHubCommand(
      projectRoot,
      { owner, repo },
      [
        "issue",
        "list",
        `--label=${safeLabel}`,
        "--state=open",
        "--json",
        "number,title,body,labels,assignees,state,url",
        "--limit=100",
      ],
      { timeoutMs: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    const data = parseJsonArray(result.stdout, "GitHub issue list response");

    // Fetch full details for each issue (including comments)
    const issues: GitHubIssue[] = [];
    const seenIssueNumbers = new Set<number>();
    for (const item of data) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("GitHub issue list response contained an invalid issue");
      }
      const record = item as Record<string, unknown>;
      if (typeof record.number !== "number") {
        throw new Error("GitHub issue list response contained an invalid issue number");
      }
      const issueNumber = assertIssueNumber(record.number);
      if (seenIssueNumbers.has(issueNumber)) {
        throw new Error(`GitHub issue list response repeated issue #${issueNumber}`);
      }
      seenIssueNumbers.add(issueNumber);
      assertIssueUrl(record.url, result.repository, issueNumber);
      if (typeof record.state !== "string" || record.state.toLowerCase() !== "open") {
        throw new Error(`GitHub issue list response included non-open issue #${issueNumber}`);
      }
      if (
        !parseIssueLabels(record.labels, "GitHub issue list response").some(
          (actualLabel) => actualLabel.toLowerCase() === safeLabel.toLowerCase(),
        )
      ) {
        throw new Error(
          `GitHub issue list response included issue #${issueNumber} without the requested label`,
        );
      }
      const fullIssue = await fetchIssue(owner, repo, issueNumber, projectRoot);
      if (
        !fullIssue.labels.some(
          (actualLabel) => actualLabel.toLowerCase() === safeLabel.toLowerCase(),
        ) ||
        fullIssue.state !== "open"
      ) {
        throw new Error(
          `GitHub issue #${issueNumber} no longer matches the requested open-label filter`,
        );
      }
      issues.push(fullIssue);
    }

    return issues;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issues with label "${label}": ${message}`);
  }
}

/**
 * Fetch issues by label using config.
 */
export async function fetchIssuesByLabelFromConfig(
  config: GitHubConfig,
  label?: string,
  projectRoot: string = process.cwd(),
): Promise<GitHubIssue[]> {
  const labelToUse = label || config.importLabel || "quack-ready";
  return fetchIssuesByLabel(config.owner, config.repo, labelToUse, projectRoot);
}
