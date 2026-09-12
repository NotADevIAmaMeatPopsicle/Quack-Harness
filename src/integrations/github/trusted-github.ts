import * as path from "node:path";

import type { GitHubConfig } from "./github-types.js";
import {
  resolveTrustedGitHubRepository,
  runTrustedGitHubIssuePageResult,
  runTrustedGitHubResult,
  GITHUB_ISSUE_PAGE_MAX_BUFFER,
  type TrustedGitHubRepository,
  type TrustedGitResult,
} from "../../worker/trusted-executable.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface TrustedGitHubCommandOptions {
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface TrustedGitHubCommandResult extends TrustedGitResult {
  repository: TrustedGitHubRepository;
}

/**
 * Execute one GitHub CLI command through Quack's trusted executable and Git
 * repository boundary. The adapter-configured owner/repository is treated as
 * an expectation, never as an independent credential-bearing destination.
 */
export async function runBoundGitHubCommand(
  projectRoot: string,
  config: Pick<GitHubConfig, "owner" | "repo">,
  args: readonly string[],
  options: TrustedGitHubCommandOptions = {},
): Promise<TrustedGitHubCommandResult> {
  const canonicalInputRoot = path.resolve(projectRoot);
  const auditOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    trustedBoundaryRoot: canonicalInputRoot,
    expectedRepository: { owner: config.owner, repo: config.repo },
  };
  const repository = await resolveTrustedGitHubRepository(canonicalInputRoot, auditOptions);
  const result = await runTrustedGitHubResult(canonicalInputRoot, args, {
    ...auditOptions,
    expectedRepository: repository,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "GitHub CLI command failed");
  }
  return { ...result, repository };
}

/** A fixed, repository-bound GraphQL read; cursors are data, never CLI options. */
export async function readBoundGitHubIssuePage(
  projectRoot: string,
  config: Pick<GitHubConfig, "owner" | "repo">,
  after: string | undefined,
  timeoutMs: number,
): Promise<TrustedGitHubCommandResult> {
  const canonicalInputRoot = path.resolve(projectRoot);
  const auditOptions = {
    timeoutMs,
    maxBuffer: GITHUB_ISSUE_PAGE_MAX_BUFFER,
    trustedBoundaryRoot: canonicalInputRoot,
    expectedRepository: { owner: config.owner, repo: config.repo },
  };
  const repository = await resolveTrustedGitHubRepository(canonicalInputRoot, auditOptions);
  const result = await runTrustedGitHubIssuePageResult(canonicalInputRoot, after, {
    ...auditOptions,
    expectedRepository: repository,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "GitHub issue page read failed",
    );
  }
  return { ...result, repository };
}

export function assertIssueNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Refusing invalid GitHub issue number: ${String(value)}`);
  }
  return value;
}

function assertBaseGitHubUrl(
  value: unknown,
  repository: TrustedGitHubRepository,
  expectedIssueNumber: number,
): URL {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error("GitHub response did not contain one valid issue URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GitHub response contained an invalid issue URL: ${value}`);
  }
  const expectedPath = `/${repository.owner}/${repository.repo}/issues/${expectedIssueNumber}`;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.host.toLowerCase() !== repository.host.toLowerCase() ||
    url.pathname.toLowerCase() !== expectedPath.toLowerCase()
  ) {
    throw new Error(
      `GitHub response issue URL does not match ${repository.host}/${repository.owner}/${repository.repo}#${expectedIssueNumber}`,
    );
  }
  return url;
}

/** Validate and return an issue URL bound to the audited repository and number. */
export function assertIssueUrl(
  value: unknown,
  repository: TrustedGitHubRepository,
  expectedIssueNumber: number,
): string {
  const url = assertBaseGitHubUrl(value, repository, assertIssueNumber(expectedIssueNumber));
  if (url.hash) {
    throw new Error("GitHub response issue URL unexpectedly contained a fragment");
  }
  return url.toString();
}

/** Validate and return a comment URL bound to the audited issue. */
export function assertIssueCommentUrl(
  value: unknown,
  repository: TrustedGitHubRepository,
  expectedIssueNumber: number,
): string {
  const url = assertBaseGitHubUrl(value, repository, assertIssueNumber(expectedIssueNumber));
  if (!/^#issuecomment-[1-9][0-9]*$/u.test(url.hash)) {
    throw new Error("GitHub response did not contain a valid issue comment URL");
  }
  return url.toString();
}

export function parseJsonObject(stdout: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${description} was not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${description} was not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonArray(stdout: string, description: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${description} was not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${description} was not a JSON array`);
  }
  return parsed;
}

export function parseIssueLabels(value: unknown, description: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} did not contain a labels array`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { name?: unknown }).name !== "string"
    ) {
      throw new Error(`${description} contained an invalid label`);
    }
    return (entry as { name: string }).name;
  });
}

export function assertNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} was not a non-empty string`);
  }
  return value;
}
