// ─── GitHub Status Syncer ───────────────────────────────────────────
// Sync task lifecycle status to GitHub issue labels and state.

import * as path from "node:path";

import type { GitHubConfig, SyncEvent } from "./github-types.js";
import type { AdapterConfig } from "../../core/types.js";
import { getSyncMap } from "./sync-map.js";
import { postLifecycleComment } from "./comment-thread.js";
import { listDuplicateClaimants, resolveTaskFile } from "../../core/task-file-resolver.js";
import { runGh } from "./gh-cli.js";

// ─── Label Management ───────────────────────────────────────────────

/**
 * Add labels to a GitHub issue.
 */
async function addLabels(
  issueNumber: number,
  labels: string[],
  config: GitHubConfig,
): Promise<void> {
  if (labels.length === 0) return;

  try {
    await runGh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      `${config.owner}/${config.repo}`,
      ...labels.flatMap((label) => ["--add-label", label]),
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to add labels to issue #${issueNumber}: ${message}`);
  }
}

/**
 * Remove labels from a GitHub issue.
 */
async function removeLabels(
  issueNumber: number,
  labels: string[],
  config: GitHubConfig,
): Promise<void> {
  if (labels.length === 0) return;

  try {
    await runGh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      `${config.owner}/${config.repo}`,
      ...labels.flatMap((label) => ["--remove-label", label]),
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to remove labels from issue #${issueNumber}: ${message}`);
  }
}

// ─── Lifecycle Event Sync ───────────────────────────────────────────

/**
 * Sync a lifecycle event to GitHub (labels + comment).
 */
export async function syncLifecycleEvent(
  issueNumber: number,
  event: SyncEvent,
  config: GitHubConfig,
): Promise<void> {
  const labels = config.labels || {};

  // Determine label changes based on event type
  let toAdd: string[] = [];
  let toRemove: string[] = [];

  switch (event.type) {
    case "gate_passed":
      toAdd = [labels.ready || "quack-ready"];
      break;

    case "dispatch_started":
      toAdd = [labels.inProgress || "quack-in-progress"];
      toRemove = [labels.ready || "quack-ready"];
      break;

    case "dispatch_complete":
      toRemove = [labels.inProgress || "quack-in-progress"];
      if (event.data?.outcome === "approved") {
        toAdd = [labels.approved || "quack-approved"];
      } else if (event.data?.outcome === "rejected") {
        toAdd = [labels.rejected || "quack-rejected"];
      }
      break;
  }

  // Apply label changes
  if (toAdd.length > 0) {
    await addLabels(issueNumber, toAdd, config);
  }
  if (toRemove.length > 0) {
    await removeLabels(issueNumber, toRemove, config);
  }

  // Post lifecycle comment
  await postLifecycleComment(issueNumber, event, config);
}

// ─── High-Level Sync Functions ──────────────────────────────────────

/**
 * Sync dispatch started to GitHub.
 */
export async function syncDispatchStarted(
  taskId: string,
  model: string | undefined,
  budget: number | undefined,
  adapterConfig: AdapterConfig,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(adapterConfig);
  const issueNumber = syncMap.getIssueForTask(taskId);
  if (!issueNumber) {
    return;
  }

  const event: SyncEvent = {
    type: "dispatch_started",
    taskId,
    timestamp: new Date().toISOString(),
    data: { model, budget },
  };

  await syncLifecycleEvent(issueNumber, event, githubConfig);
  syncMap.updateSyncTime(taskId);
  await syncMap.save();
}

/**
 * Sync dispatch completion to GitHub.
 */
export async function syncDispatchComplete(
  taskId: string,
  outcome: string,
  feedback: string | undefined,
  adapterConfig: AdapterConfig,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(adapterConfig);
  const issueNumber = syncMap.getIssueForTask(taskId);
  if (!issueNumber) {
    return;
  }

  const event: SyncEvent = {
    type: "dispatch_complete",
    taskId,
    timestamp: new Date().toISOString(),
    data: { outcome, feedback },
  };

  await syncLifecycleEvent(issueNumber, event, githubConfig);
  syncMap.updateSyncTime(taskId);
  await syncMap.save();
}

/**
 * Sync PR creation to GitHub.
 */
export async function syncPRCreated(
  taskId: string,
  prUrl: string,
  adapterConfig: AdapterConfig,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(adapterConfig);
  const issueNumber = syncMap.getIssueForTask(taskId);
  if (!issueNumber) {
    return;
  }

  const event: SyncEvent = {
    type: "pr_created",
    taskId,
    timestamp: new Date().toISOString(),
    data: { prUrl },
  };

  await syncLifecycleEvent(issueNumber, event, githubConfig);
  syncMap.updateSyncTime(taskId);
  await syncMap.save();
}

/**
 * Sync task status to GitHub issue (called from quack sync).
 */
export async function syncTaskStatusToIssue(
  taskId: string,
  status: string,
  adapterConfig: AdapterConfig,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig) {
    return;
  }

  const syncMap = await getSyncMap(adapterConfig);
  syncMap.updateTaskStatus(taskId, status);
  await syncMap.save();
}

export interface SyncedTaskOutcome {
  taskId: string;
  issueNumber: number;
  outcome: "synced";
  taskStatus: string;
  statusChanged: boolean;
}

export interface UnresolvableTaskSyncOutcome {
  taskId: string;
  issueNumber: number;
  outcome: "skipped";
  reason: "task_file_unresolvable";
}

export interface DuplicateClaimantsTaskSyncOutcome {
  taskId: string;
  issueNumber: number;
  outcome: "skipped";
  reason: "duplicate_claimants";
  claimants: string[];
}

export interface FailedTaskSyncOutcome {
  taskId: string;
  issueNumber: number;
  outcome: "skipped";
  reason: "sync_failed";
  message: string;
}

export type SkippedTaskOutcome =
  | UnresolvableTaskSyncOutcome
  | DuplicateClaimantsTaskSyncOutcome
  | FailedTaskSyncOutcome;

export type TaskSyncOutcome = SyncedTaskOutcome | SkippedTaskOutcome;

export interface SyncAllTasksOutcome {
  outcomes: TaskSyncOutcome[];
}

/**
 * Sync all mapped tasks (called from quack sync --github).
 * Reads the current task file status and syncs labels to GitHub.
 */
export async function syncAllTasks(adapterConfig: AdapterConfig): Promise<SyncAllTasksOutcome> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig) {
    return { outcomes: [] };
  }

  const syncMap = await getSyncMap(adapterConfig);
  const entries = syncMap.getAllEntries();
  const outcomes: TaskSyncOutcome[] = [];
  const taskDir = path.resolve(adapterConfig.project.root, adapterConfig.project.taskDir);

  for (const entry of entries) {
    try {
      const resolved = await resolveTaskFile(taskDir, entry.taskId);
      if (!resolved) {
        outcomes.push({
          taskId: entry.taskId,
          issueNumber: entry.issueNumber,
          outcome: "skipped",
          reason: "task_file_unresolvable",
        });
        continue;
      }

      const claimants = await listDuplicateClaimants(taskDir, entry.taskId);
      if (claimants.length > 1) {
        outcomes.push({
          taskId: entry.taskId,
          issueNumber: entry.issueNumber,
          outcome: "skipped",
          reason: "duplicate_claimants",
          claimants,
        });
        continue;
      }

      const statusMatch = resolved.content.match(/\*\*Status:\*\*\s*(\S+)/);
      const currentStatus = statusMatch ? statusMatch[1] : entry.taskStatus;
      const statusChanged = currentStatus !== entry.taskStatus;

      if (statusChanged && githubConfig.reportBack) {
        const labels = githubConfig.labels || {};
        if (currentStatus === "COMPLETE") {
          await addLabels(entry.issueNumber, [labels.approved || "quack-approved"], githubConfig);
          await removeLabels(
            entry.issueNumber,
            [labels.inProgress || "quack-in-progress"],
            githubConfig,
          );
        } else if (currentStatus === "IN_PROGRESS") {
          await addLabels(
            entry.issueNumber,
            [labels.inProgress || "quack-in-progress"],
            githubConfig,
          );
          await removeLabels(entry.issueNumber, [labels.ready || "quack-ready"], githubConfig);
        } else if (currentStatus === "READY") {
          await addLabels(entry.issueNumber, [labels.ready || "quack-ready"], githubConfig);
        }
      }

      if (statusChanged) {
        syncMap.updateTaskStatus(entry.taskId, currentStatus);
      } else {
        syncMap.updateSyncTime(entry.taskId);
      }
      outcomes.push({
        taskId: entry.taskId,
        issueNumber: entry.issueNumber,
        outcome: "synced",
        taskStatus: currentStatus,
        statusChanged,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to sync ${entry.taskId}: ${msg}`);
      outcomes.push({
        taskId: entry.taskId,
        issueNumber: entry.issueNumber,
        outcome: "skipped",
        reason: "sync_failed",
        message: msg,
      });
    }
  }

  await syncMap.save();
  return { outcomes };
}

/**
 * Get sync status for all mapped tasks.
 */
export async function getSyncStatus(adapterConfig: AdapterConfig): Promise<{
  totalEntries: number;
  entries: Array<{
    taskId: string;
    issueNumber: number;
    direction: string;
    lastSyncedAt: string;
  }>;
}> {
  const syncMap = await getSyncMap(adapterConfig);
  const entries = syncMap.getAllEntries();

  return {
    totalEntries: entries.length,
    entries: entries.map((e) => ({
      taskId: e.taskId,
      issueNumber: e.issueNumber,
      direction: e.direction,
      lastSyncedAt: e.lastSyncedAt,
    })),
  };
}
