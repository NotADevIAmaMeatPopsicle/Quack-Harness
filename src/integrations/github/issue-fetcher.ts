/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
// ─── GitHub Issue Fetcher ───────────────────────────────────────────
// Fetch GitHub issues via gh CLI.

import type { GitHubIssue, GitHubConfig } from "./github-types.js";
import { runGh } from "./gh-cli.js";

// ─── gh CLI Validation ──────────────────────────────────────────────

/**
 * Validate that gh CLI is installed and authenticated.
 * Throws a descriptive error if not.
 */
export async function validateGhCli(): Promise<void> {
  try {
    await runGh(["auth", "status"], { timeoutMs: 10_000 });
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

// ─── Fetch Single Issue ─────────────────────────────────────────────

/**
 * Fetch a single GitHub issue by number.
 */
export async function fetchIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubIssue> {
  try {
    const { stdout } = await runGh([
      "issue",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,title,body,labels,assignees,comments,state,url",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = JSON.parse(stdout);

    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      number: data.number,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      title: data.title,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      body: data.body || "",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      labels: data.labels?.map((l: { name: string }) => l.name) || [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      assignees: data.assignees?.map((a: { login: string }) => a.login) || [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      comments:
        data.comments?.map((c: { author: { login: string }; body: string; createdAt: string }) => ({
          author: c.author.login,
          body: c.body,
          createdAt: c.createdAt,
        })) || [],
      referencedFiles: extractFileReferences(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        data.body || "",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        data.comments || [],
      ),
      linkedPRs: [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      state: data.state,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      url: data.url,
    };
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
): Promise<GitHubIssue[]> {
  try {
    const { stdout } = await runGh([
      "issue",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,assignees,state,url",
      "--limit",
      "100",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data: Array<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
      assignees: Array<{ login: string }>;
      state: string;
      url: string;
    }> = JSON.parse(stdout);

    // Fetch full details for each issue (including comments)
    const issues: GitHubIssue[] = [];
    for (const item of data) {
      const fullIssue = await fetchIssue(owner, repo, item.number);
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
): Promise<GitHubIssue[]> {
  const labelToUse = label || config.importLabel || "quack-ready";
  return fetchIssuesByLabel(config.owner, config.repo, labelToUse);
}
