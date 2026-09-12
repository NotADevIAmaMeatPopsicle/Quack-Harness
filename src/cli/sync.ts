// ─── Sync CLI Command ───────────────────────────────────────────────
// quack sync --github
// quack sync --status

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { syncAllTasks, getSyncStatus } from "../integrations/github/status-syncer.js";

interface SyncOptions {
  github?: boolean;
  status?: boolean;
  project?: string;
}

export async function handleSync(options: SyncOptions): Promise<void> {
  const projectRoot = options.project ? path.resolve(options.project) : process.cwd();
  const adapter = await loadAdapter(projectRoot);

  if (!adapter.config.integrations?.github) {
    console.error("Error: GitHub integration not configured in adapter.json");
    process.exit(1);
  }

  try {
    if (options.status) {
      // Show sync status
      const status = await getSyncStatus(adapter.config, adapter.projectRoot);

      console.log(`\n📊 GitHub Sync Status`);
      console.log(`Total mapped tasks: ${status.totalEntries}`);
      console.log("");

      if (status.entries.length === 0) {
        console.log("No tasks are mapped to GitHub issues yet.");
      } else {
        console.log("Mapped tasks:");
        console.log("");
        console.log("Task ID       | Issue # | Direction | Last Synced");
        console.log("--------------|---------|-----------|---------------------------");
        for (const entry of status.entries) {
          const lastSynced = new Date(entry.lastSyncedAt).toLocaleString();
          console.log(
            `${entry.taskId.padEnd(13)} | #${String(entry.issueNumber).padEnd(6)} | ${entry.direction.padEnd(9)} | ${lastSynced}`,
          );
        }
      }
    } else if (options.github) {
      // Force full sync
      console.log("Syncing all mapped tasks to GitHub...");
      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
      const skipped = outcome.outcomes.filter((row) => row.outcome === "skipped");
      if (skipped.length > 0) {
        for (const row of skipped) {
          if (row.reason === "duplicate_claimants") {
            console.error(
              `Skipped ${row.taskId}: ${row.reason} claimants=${row.claimants.join(", ")}`,
            );
          } else if (row.reason === "sync_failed") {
            console.error(`Skipped ${row.taskId}: ${row.reason} message=${row.message}`);
          } else {
            console.error(`Skipped ${row.taskId}: ${row.reason}`);
          }
        }
        console.error(`Sync incomplete: ${skipped.length} task(s) skipped`);
        process.exit(1);
        return;
      }
      console.log("✅ Sync complete");
    } else {
      console.error("Error: Must provide --github or --status");
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
