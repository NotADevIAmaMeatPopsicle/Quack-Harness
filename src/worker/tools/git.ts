// ─── Git MCP Tools ──────────────────────────────────────────────────
// Restricted git operations for the agent. These tools allow the agent
// to manage git state within the project, but never force-push, reset
// --hard, or perform other destructive operations.

import { exec } from "node:child_process";
import { promisify } from "node:util";

import { summarizeOutput } from "./output-summarizer.js";

const execAsync = promisify(exec);

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum output size for git commands (1MB) */
const MAX_BUFFER = 1024 * 1024;

/** Timeout for git commands in milliseconds (30 seconds) */
const GIT_TIMEOUT_MS = 30_000;

// ─── Git command execution ──────────────────────────────────────────

interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGitCommand(args: string, cwd: string): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execAsync(`git ${args}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
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
    return { exitCode: 1, stdout: "", stderr: `Git error: ${message}` };
  }
}

interface ExecError {
  code: number | null;
  stdout: string;
  stderr: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null && "stdout" in err && "stderr" in err;
}

// ─── Git tool handlers ──────────────────────────────────────────────

/**
 * Run `git status` and return summarized output.
 */
export async function gitStatus(cwd: string): Promise<string> {
  const result = await runGitCommand("status --short", cwd);
  if (result.exitCode !== 0) {
    return `git status failed: ${result.stderr}`;
  }
  const output = result.stdout.trim();
  return output.length > 0 ? output : "Working tree clean";
}

/**
 * Run `git diff` and return summarized output.
 * @param staged - If true, show staged changes (--cached)
 */
export async function gitDiff(cwd: string, staged: boolean): Promise<string> {
  const flag = staged ? " --cached" : "";
  const result = await runGitCommand(`diff${flag}`, cwd);
  if (result.exitCode !== 0) {
    return `git diff failed: ${result.stderr}`;
  }
  const output = result.stdout.trim();
  if (output.length === 0) {
    return staged ? "No staged changes" : "No unstaged changes";
  }
  return summarizeOutput(output, true);
}

/**
 * @deprecated Quack now commits via the post-worker output sealer
 * (`src/dispatcher/output-snapshot.ts`). Workers should not stage their own
 * changes during execution — the sealer captures the final-state diff and
 * commits with the correct message format after the worker exits. This function
 * is retained only for back-compat with internal scripts/tests; it is no longer
 * registered with the MCP server.
 */
export async function gitAdd(cwd: string, paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return "No paths specified for git add";
  }

  // Prevent adding everything blindly
  const hasWildcard = paths.some((p) => p === "." || p === "-A" || p === "--all");
  if (hasWildcard) {
    return "Refusing to add all files. Specify individual paths.";
  }

  // Escape paths for safety
  const escapedPaths = paths.map((p) => `"${p}"`).join(" ");
  const result = await runGitCommand(`add ${escapedPaths}`, cwd);
  if (result.exitCode !== 0) {
    return `git add failed: ${result.stderr}`;
  }
  return `Added ${paths.length} path(s): ${paths.join(", ")}`;
}

/**
 * @deprecated Quack now commits via the post-worker output sealer
 * (`src/dispatcher/output-snapshot.ts`). Workers should not commit during
 * execution — the sealer captures the final-state diff and commits with the
 * correct message format after the worker exits. Retained only for back-compat;
 * no longer registered with the MCP server.
 */
export async function gitCommit(cwd: string, message: string): Promise<string> {
  if (message.trim().length === 0) {
    return "Commit message cannot be empty";
  }

  // Escape the message for shell safety
  const escapedMessage = message.replace(/"/g, '\\"');
  const result = await runGitCommand(`commit -m "${escapedMessage}"`, cwd);
  if (result.exitCode !== 0) {
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return `git commit failed: ${combined}`;
  }
  return `Committed: ${result.stdout.trim()}`;
}

/**
 * Run `git log` and return recent commit history.
 * @param count - Number of commits to show (default 10)
 */
export async function gitLog(cwd: string, count: number): Promise<string> {
  const safeCount = Math.min(Math.max(count, 1), 50);
  const result = await runGitCommand(`log --oneline -${safeCount}`, cwd);
  if (result.exitCode !== 0) {
    return `git log failed: ${result.stderr}`;
  }
  return result.stdout.trim() || "No commits found";
}

// ─── Tool definitions for MCP server ────────────────────────────────

export interface GitToolDefinition {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Create all READ-ONLY git MCP tool definitions for the given project root.
 *
 * Returns: git_status, git_diff, git_log.
 *
 * Write tools (add/commit) are intentionally not registered. Workers no longer
 * commit during execution; the post-worker output sealer
 * (`src/dispatcher/output-snapshot.ts`) is the canonical writer. See TASK-865
 * for the rationale.
 */
export function createGitToolDefinitions(cwd: string): GitToolDefinition[] {
  return [
    {
      name: "git_status",
      description: "Show the working tree status (modified, staged, untracked files).",
      handler: async () => gitStatus(cwd),
    },
    {
      name: "git_diff",
      description: "Show changes in the working directory. Set staged=true to see staged changes.",
      handler: async (args) => {
        const staged = args.staged === true || args.staged === "true";
        return gitDiff(cwd, staged);
      },
    },
    {
      name: "git_log",
      description: "Show recent commit history. Optionally specify count (default 10, max 50).",
      handler: async (args) => {
        const count = typeof args.count === "number" ? args.count : 10;
        return gitLog(cwd, count);
      },
    },
  ];
}
