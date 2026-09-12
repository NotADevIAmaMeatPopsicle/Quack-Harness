// ─── Bash Guard Hook ────────────────────────────────────────────────
// PreToolUse hook that enforces adapter.sandbox.allowedBashPatterns
// and deniedBashPatterns on Bash tool invocations.
//
// Pattern matching uses simple glob-like patterns:
//   - "*" matches any sequence of characters
//   - Patterns are matched against the full command string
//
// Logic:
//   1. If deniedBashPatterns is non-empty, check if command matches any.
//      If yes, BLOCK the command.
//   2. If allowedBashPatterns is non-empty, check if command matches any.
//      If no match, BLOCK the command.
//   3. If both lists are empty, ALLOW all commands (no restrictions).

import * as path from "node:path";
import type { AdapterSandboxConfig } from "../core/types.js";

/**
 * Result of a bash guard check.
 */
export interface BashGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Converts a simple glob pattern to a RegExp.
 * Supports "*" as a wildcard matching any characters.
 *
 * @param pattern - The glob pattern (e.g., "npm test *", "rm *")
 * @returns A RegExp that matches the pattern
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex special characters, then replace \* with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`);
}

/**
 * Check whether a bash command matches any of the given patterns.
 *
 * @param command - The bash command to check
 * @param patterns - Array of glob patterns to match against
 * @returns true if the command matches at least one pattern
 */
function matchesAnyPattern(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(command));
}

/**
 * Check whether a bash command is allowed by the sandbox config.
 *
 * @param command - The bash command the agent wants to execute
 * @param sandbox - The adapter sandbox configuration
 * @returns BashGuardResult indicating whether the command is allowed
 */
export function checkBashCommand(command: string, sandbox: AdapterSandboxConfig): BashGuardResult {
  const trimmedCommand = command.trim();

  // Check denied patterns first (deny takes priority)
  if (sandbox.deniedBashPatterns.length > 0) {
    if (matchesAnyPattern(trimmedCommand, sandbox.deniedBashPatterns)) {
      const matchedPattern = sandbox.deniedBashPatterns.find((p) =>
        globToRegex(p).test(trimmedCommand),
      );
      return {
        allowed: false,
        reason: `Command blocked by denied pattern: "${matchedPattern}"`,
      };
    }
  }

  // Check allowed patterns (if specified, command must match at least one)
  if (sandbox.allowedBashPatterns.length > 0) {
    if (!matchesAnyPattern(trimmedCommand, sandbox.allowedBashPatterns)) {
      return {
        allowed: false,
        reason: `Command not in allowed patterns. Allowed: ${sandbox.allowedBashPatterns.join(", ")}`,
      };
    }
  }

  // No restrictions or command passed all checks
  return { allowed: true };
}

// ─── Write/Edit Path Guard ──────────────────────────────────────────
// Checks whether a file path is allowed by the sandbox writablePaths
// and deniedPaths configuration.

export interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a file write/edit is allowed by the sandbox config.
 *
 * @param filePath - The file path the agent wants to write/edit
 * @param sandbox - The adapter sandbox configuration
 * @param projectRoot - The project root for resolving relative paths
 * @returns WriteGuardResult indicating whether the write is allowed
 */
export function checkWritePath(
  filePath: string,
  sandbox: AdapterSandboxConfig,
  projectRoot: string,
): WriteGuardResult {
  // Normalize to a relative path from project root
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const relativePath = path.relative(projectRoot, absolutePath);

  // Reject paths that escape the project root
  if (relativePath.startsWith("..")) {
    return {
      allowed: false,
      reason: `Path "${filePath}" is outside the project root`,
    };
  }

  // Normalize separators to forward slashes for matching
  const normalizedPath = relativePath.replace(/\\/g, "/");

  // Check denied paths first
  if (sandbox.deniedPaths.length > 0) {
    for (const denied of sandbox.deniedPaths) {
      if (normalizedPath === denied || normalizedPath.startsWith(denied)) {
        return {
          allowed: false,
          reason: `Path "${normalizedPath}" is in denied paths: "${denied}"`,
        };
      }
    }
  }

  // PROGRESS.md is Quack-owned worker state. The worker prompt requires it
  // even when an adapter intentionally narrows writablePaths to product code.
  // Keep explicit deniedPaths authoritative, but do not make every adapter
  // repeat this pipeline-managed exception.
  if (normalizedPath.toLowerCase() === "progress.md") {
    return { allowed: true };
  }

  // Check writable paths (if specified, file must be under at least one)
  if (sandbox.writablePaths.length > 0) {
    const isWritable = sandbox.writablePaths.some((wp) => {
      const normalizedWritable = wp
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      return (
        normalizedPath === normalizedWritable || normalizedPath.startsWith(`${normalizedWritable}/`)
      );
    });
    if (!isWritable) {
      return {
        allowed: false,
        reason: `Path "${normalizedPath}" is not under any writable path. Writable: ${sandbox.writablePaths.join(", ")}`,
      };
    }
  }

  return { allowed: true };
}
