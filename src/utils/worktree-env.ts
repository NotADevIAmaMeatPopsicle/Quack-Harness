// ─── Worktree Environment Utility ─────────────────────────────────
// Shared helper for building environment variables that work correctly
// in both regular git repos and git worktrees.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Build environment variables for running commands in a git worktree.
 * Worktrees use a `.git` file (not directory) pointing to the main repo's
 * worktree data. Some tools fail because they check `isDirectory('.git')`.
 * Setting GIT_DIR and GIT_WORK_TREE explicitly fixes this.
 */
export function worktreeEnv(workDir: string): NodeJS.ProcessEnv {
  const gitPath = join(workDir, ".git");
  // Only apply worktree env when .git is a file (worktree) not a directory (real repo)
  try {
    if (existsSync(gitPath) && !statSync(gitPath).isDirectory()) {
      // .git file contains "gitdir: <path>" — resolve it
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitDir = resolve(workDir, match[1]);
        return {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: workDir,
        };
      }
    }
  } catch {
    // Fall through to default env
  }
  return { ...process.env };
}
