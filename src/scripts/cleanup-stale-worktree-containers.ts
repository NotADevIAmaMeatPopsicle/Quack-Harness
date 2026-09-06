#!/usr/bin/env node
// ─── Stale Worktree Container Cleanup ───────────────────────────────
// One-shot script to clean up Docker containers left behind by
// dispatches that exited without calling tearDown().
//
// Usage:
//   npx ts-node src/scripts/cleanup-stale-worktree-containers.ts
//     → dry-run: lists stale containers, shows what would be cleaned
//   npx ts-node src/scripts/cleanup-stale-worktree-containers.ts --apply
//     → actually runs docker compose down for each stale project

import { execSync } from "node:child_process";

const DRY_RUN = !process.argv.includes("--apply");

function listRunningContainers(): string[] {
  try {
    const out = execSync('docker ps --format "{{.Names}}"', {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    });
    return out
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter(Boolean);
  } catch (err) {
    console.error("[cleanup] docker ps failed:", (err as Error).message);
    return [];
  }
}

/** Extract compose project name prefix from container name (e.g. task-807-e from task-807-e-redis-1) */
function extractProjectName(containerName: string): string | null {
  // Matches: task-<id>-<service>-<index>
  // e.g. task-807-e-redis-1 → project = task-807-e
  //      task-826-postgres-1 → project = task-826
  const m = containerName.match(/^(task-[\w-]+?)-[\w]+-\d+$/);
  return m ? m[1] : null;
}

function main(): void {
  console.log(`[cleanup] Running in ${DRY_RUN ? "DRY-RUN" : "APPLY"} mode`);

  const allContainers = listRunningContainers();
  const taskContainers = allContainers.filter((n) => /^task-/i.test(n));

  if (taskContainers.length === 0) {
    console.log("[cleanup] No task-* containers found. Nothing to clean.");
    return;
  }

  console.log(
    `[cleanup] Found ${taskContainers.length} task-* container(s): ${taskContainers.join(", ")}`,
  );

  // Deduplicate by compose project name
  const projects = new Set<string>();
  for (const name of taskContainers) {
    const project = extractProjectName(name);
    if (project) {
      projects.add(project);
    } else {
      console.warn(`[cleanup] Could not extract project name from container: ${name}`);
    }
  }

  if (projects.size === 0) {
    console.log("[cleanup] No actionable compose projects found.");
    return;
  }

  console.log(
    `[cleanup] ${DRY_RUN ? "Would clean" : "Cleaning"} ${projects.size} compose project(s): ${[...projects].join(", ")}`,
  );

  if (DRY_RUN) {
    console.log("[cleanup] Dry-run complete. Re-run with --apply to actually clean up.");
    return;
  }

  let cleaned = 0;
  let failed = 0;

  for (const project of projects) {
    console.log(`[cleanup] Running: docker compose -p ${project} down --remove-orphans`);
    try {
      execSync(`docker compose -p "${project}" down --remove-orphans`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 60_000,
      });
      console.log(`[cleanup] Cleaned project: ${project}`);
      cleaned += 1;
    } catch (err) {
      console.error(`[cleanup] Failed to clean project ${project}: ${(err as Error).message}`);
      failed += 1;
    }
  }

  console.log(`[cleanup] Done. Cleaned: ${cleaned}, Failed: ${failed}`);
}

try {
  main();
} catch (err: unknown) {
  console.error("[cleanup] Unexpected error:", err);
  process.exit(1);
}
