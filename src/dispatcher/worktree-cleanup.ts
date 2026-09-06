// ─── Worktree Config Cleanup ────────────────────────────────────────
// Detects and removes rogue `core.worktree` values that the dispatcher
// may leave in the parent repo's local .git/config on crash or kill.
// Only removes values pointing inside .quack/worktrees/ — values set
// for other reasons (operator custom usage) are preserved.

import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { IEventWriter } from "../monitor/event-emitter.js";

const execAsync = promisify(exec);

const MAX_BUFFER = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface CoreWorktreeCleanResult {
  /** Whether a leaked value was found */
  leaked: boolean;
  /** Whether the leaked value was successfully removed */
  cleaned: boolean;
  /** The leaked value that was found (if any) */
  leakedValue?: string;
}

/**
 * Returns true if the given core.worktree value looks like a Quack-managed
 * worktree path (contains .quack/worktrees/ in either slash style).
 */
function isQuackWorktreePath(value: string): boolean {
  return value.includes(".quack/worktrees/") || value.includes(".quack\\worktrees\\");
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
    const { stdout } = await execAsync("git config --local --get core.worktree", {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const value = stdout.trim();
    if (!value) {
      return { leaked: false, cleaned: false };
    }

    // Only clean values that point inside Quack's managed worktrees directory
    if (!isQuackWorktreePath(value)) {
      return { leaked: true, cleaned: false, leakedValue: value };
    }

    // Remove the leaked value
    try {
      await execAsync("git config --local --unset core.worktree", {
        cwd: repoPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
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
    // git config --get exits non-zero when key is not set — that is the normal
    // "no leak" path. Any other error is also treated as no-op.
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
