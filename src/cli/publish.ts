// ─── Publish CLI Command ────────────────────────────────────────────
// quack publish TASK-051
// quack publish --all-backlog

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { publishTask, publishAllBacklog } from "../integrations/github/issue-publisher.js";
import { getSyncMap } from "../integrations/github/sync-map.js";

export async function handlePublish(argv: {
  taskId?: string;
  allBacklog?: boolean;
  project?: string;
}): Promise<void> {
  const projectRoot = argv.project ? path.resolve(argv.project) : process.cwd();
  const adapter = await loadAdapter(projectRoot);

  const githubConfig = adapter.config.integrations?.github;
  if (!githubConfig) {
    console.error("Error: GitHub integration not configured in adapter.json");
    console.error("Add an 'integrations.github' section with owner and repo.");
    process.exit(1);
  }

  const syncMap = await getSyncMap(adapter.config);

  try {
    if (argv.allBacklog) {
      // Publish all BACKLOG tasks
      console.log("Publishing all BACKLOG tasks to GitHub...");
      const outcome = await publishAllBacklog(
        projectRoot,
        adapter.config.project.taskDir,
        githubConfig,
      );

      // Update sync map
      for (const result of outcome.published) {
        if (!syncMap.hasTask(result.taskId)) {
          syncMap.addEntry({
            taskId: result.taskId,
            issueNumber: result.issueNumber,
            direction: "published",
            createdAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
            issueState: "open",
            taskStatus: "BACKLOG",
          });
        }
      }
      await syncMap.save();

      if (outcome.published.length === 0 && outcome.skipped.length === 0) {
        console.log("No BACKLOG tasks to publish.");
      } else if (outcome.published.length > 0) {
        console.log(`✅ Published ${outcome.published.length} task(s):`);
        for (const result of outcome.published) {
          console.log(`   - ${result.taskId} → ${result.url}`);
        }
      }
      for (const row of outcome.skipped) {
        if (row.reason === "duplicate_claimants") {
          console.error(
            `Skipped taskId=${row.taskId} file=${row.file} reason=${row.reason} claimants=${row.claimants.join(", ")}`,
          );
        } else {
          console.error(
            `Skipped taskId=${row.taskId} file=${row.file} reason=${row.reason} message=${row.message}`,
          );
        }
      }
      if (outcome.skipped.length > 0) {
        process.exit(1);
        return;
      }
    } else if (argv.taskId) {
      // Publish single task
      const taskId = argv.taskId;

      // Check for duplicates
      if (syncMap.hasTask(taskId)) {
        const existingIssue = syncMap.getIssueForTask(taskId);
        console.error(`Error: ${taskId} already published as issue #${existingIssue}`);
        process.exit(1);
      }

      console.log(`Publishing ${taskId} to GitHub...`);
      const result = await publishTask(
        taskId,
        projectRoot,
        githubConfig,
        adapter.config.project.taskDir,
      );

      // Update sync map
      syncMap.addEntry({
        taskId,
        issueNumber: result.issueNumber,
        direction: "published",
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
        issueState: "open",
        taskStatus: "BACKLOG",
      });
      await syncMap.save();

      console.log(`✅ Published to GitHub: ${result.url}`);
    } else {
      console.error("Error: Must provide taskId or --all-backlog");
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
