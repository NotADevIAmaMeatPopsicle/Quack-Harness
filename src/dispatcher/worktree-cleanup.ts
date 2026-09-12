// ─── Worktree Config Cleanup ────────────────────────────────────────
// Detects and removes rogue `core.worktree` values that the dispatcher
// may leave in the parent repo's local .git/config on crash or kill.
// Only removes values pointing inside .quack/worktrees/ — values set
// for other reasons (operator custom usage) are preserved.

import * as path from "node:path";

import type { IEventWriter } from "../monitor/event-emitter.js";
import { readTrustedCoreWorktree, unsetTrustedCoreWorktree } from "../worker/trusted-executable.js";

export interface CoreWorktreeCleanResult {
  /** Whether a leaked value was found */
  leaked: boolean;
  /** Whether the leaked value was successfully removed */
  cleaned: boolean;
  /** The leaked value that was found (if any) */
  leakedValue?: string;
}

/**
 * Returns true only when the resolved core.worktree value is a child of this
 * project's own managed worktree directory.
 */
function isQuackWorktreePath(value: string, repoPath: string): boolean {
  const managedRoot = path.resolve(repoPath, ".quack", "worktrees");
  const candidate = path.resolve(repoPath, value);
  const relative = path.relative(managedRoot, candidate);
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  return (
    normalized !== "" &&
    normalized !== ".." &&
    !normalized.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(normalized)
  );
}

/**
 * Detect and clean a leaked core.worktree entry in the parent repo.
 * ONLY removes values pointing inside .quack/worktrees/ — preserves
 * operator-set values pointing elsewhere.
 *
 * Never throws. Safe to call in finally blocks.
 */
export async function safeUnsetCoreWorktree(
  repoPath: string,
  events?: IEventWriter,
): Promise<CoreWorktreeCleanResult> {
  try {
    const value = (await Promise.resolve(readTrustedCoreWorktree(repoPath)))?.trim() ?? "";
    if (!value) {
      return { leaked: false, cleaned: false };
    }

    // Only clean values that point inside Quack's managed worktrees directory
    if (!isQuackWorktreePath(value, repoPath)) {
      return { leaked: true, cleaned: false, leakedValue: value };
    }

    // Remove the leaked value
    try {
      if (!(await Promise.resolve(unsetTrustedCoreWorktree(repoPath, value)))) {
        return { leaked: true, cleaned: false, leakedValue: value };
      }
      events?.emit("core_worktree_cleaned", {
        repoPath,
        leakedValue: value,
      });
      return { leaked: true, cleaned: true, leakedValue: value };
    } catch {
      // Unset failed — non-fatal
      return { leaked: true, cleaned: false, leakedValue: value };
    }
  } catch {
    // Cleanup is a best-effort finally-path operation. Missing or unreadable
    // metadata is reported as a bounded no-op rather than masking the run.
    return { leaked: false, cleaned: false };
  }
}

/**
 * Detect and clean a leaked core.worktree entry. Intended for use by
 * `quack repair-state`. Returns the same result shape as safeUnsetCoreWorktree.
 *
 * Never throws.
 */
export async function cleanCoreWorktreeIfLeaked(
  repoPath: string,
): Promise<CoreWorktreeCleanResult> {
  return safeUnsetCoreWorktree(repoPath);
}
