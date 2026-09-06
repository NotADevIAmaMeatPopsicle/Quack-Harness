// ─── Worktree Lifecycle ─────────────────────────────────────────────
// Single entry point for worktree removal AND dep-prep for worktrees.
// Tears down compose services before removing the git worktree.
// Symlinks gitignored dep directories (frontend(s)/node_modules) after creation.
// Never throws — failures are logged.

import { existsSync, symlinkSync, mkdirSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execSync } from "node:child_process";
import { tearDown } from "../testing/docker-test-runner.js";

function frontendNodeModulesSources(
  projectRoot: string,
): Array<{ source: string; relativeTarget: string }> {
  const sources: Array<{ source: string; relativeTarget: string }> = [];

  const legacy = join(projectRoot, "frontend", "node_modules");
  if (existsSync(legacy)) {
    sources.push({ source: legacy, relativeTarget: join("frontend", "node_modules") });
  }

  const frontendsRoot = join(projectRoot, "frontends");
  if (existsSync(frontendsRoot)) {
    try {
      for (const entry of readdirSync(frontendsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(frontendsRoot, entry.name, "node_modules");
        if (existsSync(source)) {
          sources.push({
            source,
            relativeTarget: join("frontends", entry.name, "node_modules"),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worktree-lifecycle] failed to inspect frontends/ node_modules directories: ${msg}`,
      );
    }
  }

  return sources;
}

/**
 * Prepare frontend dependencies in a freshly-created worktree by creating
 * symlinks (junctions on Windows) from worktree frontend node_modules paths to
 * the matching parent repo node_modules directories. Supports both legacy
 * frontend/node_modules and multi-app frontends/<app>/node_modules layouts.
 *
 * Idempotent — safe to call multiple times. Never throws.
 *
 * @param worktreePath Absolute path to the worktree directory
 * @param projectRoot  Absolute path to the parent (main) repo root
 * @param taskId       Task ID for log messages
 * @returns true if the symlink was created or already existed, false if source missing
 */
export function prepareWorktreeFrontendDeps(
  worktreePath: string,
  projectRoot: string,
  taskId: string,
): boolean {
  const sources = frontendNodeModulesSources(projectRoot);

  if (sources.length === 0) {
    console.warn(
      `[worktree-lifecycle] no frontend node_modules found under frontend/ or frontends/* for ${taskId}. ` +
        `Run the relevant frontend npm install on the host to resolve.`,
    );
    return false;
  }

  let linked = 0;
  for (const { source, relativeTarget } of sources) {
    const target = join(worktreePath, relativeTarget);
    const displayPath = relative(projectRoot, source).replace(/\\/g, "/");

    // Idempotent — if target already exists (symlink or real dir), skip
    try {
      lstatSync(target); // throws if not exists
      console.info(
        `[worktree-lifecycle] ${displayPath} already present in worktree for ${taskId} — skipping symlink`,
      );
      linked++;
      continue;
    } catch {
      // Target does not exist — proceed with symlink creation
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worktree-lifecycle] failed to create ${dirname(relativeTarget)} dir in worktree for ${taskId}: ${msg}`,
      );
      continue;
    }

    try {
      symlinkSync(source, target, "junction");
      console.info(`[worktree-lifecycle] symlinked ${displayPath} into worktree for ${taskId}`);
      linked++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[worktree-lifecycle] failed to symlink ${displayPath} for ${taskId}: ${msg}. ` +
          `Frontend build may fail. Run the relevant frontend npm install on the host.`,
      );
    }
  }

  return linked > 0;
}

const COMPOSE_CANDIDATES = [
  "docker-compose.yml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yaml",
] as const;

/**
 * Tear down compose services and then remove the git worktree.
 * Safe to call multiple times. Does not throw on cleanup failure.
 *
 * @param worktreePath Absolute path to the worktree directory
 * @param taskId Task ID for log messages
 * @param projectRoot Project root for git commands (defaults to worktreePath)
 * @param dockerCleanup Whether to attempt Docker compose cleanup (default true)
 */
export function removeWorktree(
  worktreePath: string,
  taskId: string,
  projectRoot?: string,
  dockerCleanup = true,
): void {
  // 1. Compose cleanup if a compose file is present
  if (dockerCleanup) {
    for (const cf of COMPOSE_CANDIDATES) {
      const full = join(worktreePath, cf);
      if (existsSync(full)) {
        console.info(`[worktree-lifecycle] tearing down compose for ${taskId} (${cf})`);
        tearDown(full, worktreePath, 60_000);
        break;
      }
    }
  }

  // 2. Git worktree remove
  const cwd = projectRoot ?? worktreePath;
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.info(`[worktree-lifecycle] removed worktree ${worktreePath} for ${taskId}`);
  } catch (err) {
    console.error(
      `[worktree-lifecycle] git worktree remove failed for ${taskId} at ${worktreePath}: ${(err as Error).message}`,
    );
    // Do not throw — surface the failure via log; operator must investigate.
    // Do NOT auto-retry: the worktree may be locked or corrupt.
  }
}
