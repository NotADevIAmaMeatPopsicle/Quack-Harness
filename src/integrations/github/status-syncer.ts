// ─── GitHub Status Syncer ───────────────────────────────────────────
// Sync task lifecycle status to GitHub issue labels and state.

import * as path from "node:path";

import type { GitHubConfig, SyncEvent } from "./github-types.js";
import type { AdapterConfig } from "../../core/types.js";
import { getSyncMap, resolveGitHubSyncMapPath, withSyncMapTransaction } from "./sync-map.js";
import { postLifecycleComment } from "./comment-thread.js";
import { listDuplicateClaimants, resolveTaskFile } from "../../core/task-file-resolver.js";
import {
  assertIssueNumber,
  assertIssueUrl,
  parseIssueLabels,
  parseJsonObject,
  runBoundGitHubCommand,
} from "./trusted-github.js";

const syncAllTasksInFlight = new Map<string, Promise<SyncAllTasksOutcome>>();

// ─── Label Management ───────────────────────────────────────────────

/**
 * Add labels to a GitHub issue.
 */
async function addLabels(
  issueNumber: number,
  labels: string[],
  config: GitHubConfig,
  projectRoot: string,
): Promise<void> {
  if (labels.length === 0) return;

  try {
    assertIssueNumber(issueNumber);
    await runBoundGitHubCommand(projectRoot, config, [
      "issue",
      "edit",
      String(issueNumber),
      ...labels.map((label) => `--add-label=${label}`),
    ]);
    await assertLabelsReadback(issueNumber, labels, true, config, projectRoot);
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
  projectRoot: string,
): Promise<void> {
  if (labels.length === 0) return;

  try {
    assertIssueNumber(issueNumber);
    await runBoundGitHubCommand(projectRoot, config, [
      "issue",
      "edit",
      String(issueNumber),
      ...labels.map((label) => `--remove-label=${label}`),
    ]);
    await assertLabelsReadback(issueNumber, labels, false, config, projectRoot);
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
  projectRoot: string = process.cwd(),
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
    await addLabels(issueNumber, toAdd, config, projectRoot);
  }
  if (toRemove.length > 0) {
    await removeLabels(issueNumber, toRemove, config, projectRoot);
  }

  // Post lifecycle comment
  await postLifecycleComment(issueNumber, event, config, projectRoot);
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
  projectRoot: string,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(projectRoot);
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

  await syncLifecycleEvent(issueNumber, event, githubConfig, projectRoot);
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
  projectRoot: string,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(projectRoot);
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

  await syncLifecycleEvent(issueNumber, event, githubConfig, projectRoot);
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
  projectRoot: string,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig || !githubConfig.reportBack) {
    return;
  }

  const syncMap = await getSyncMap(projectRoot);
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

  await syncLifecycleEvent(issueNumber, event, githubConfig, projectRoot);
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
  projectRoot: string,
): Promise<void> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig) {
    return;
  }

  const syncMap = await getSyncMap(projectRoot);
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
export async function syncAllTasks(
  adapterConfig: AdapterConfig,
  projectRoot: string,
): Promise<SyncAllTasksOutcome> {
  const githubConfig = adapterConfig.integrations?.github;
  if (!githubConfig) {
    return { outcomes: [] };
  }

  const syncFilePath = resolveGitHubSyncMapPath(projectRoot);
  const active = syncAllTasksInFlight.get(syncFilePath);
  if (active) return active;

  const run = withSyncMapTransaction(projectRoot, async (syncMap) => {
    const entries = syncMap.getAllEntries();
    const outcomes: TaskSyncOutcome[] = [];
    const taskDir = path.resolve(projectRoot, adapterConfig.project.taskDir);

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
            await addLabels(
              entry.issueNumber,
              [labels.approved || "quack-approved"],
              githubConfig,
              projectRoot,
            );
            await removeLabels(
              entry.issueNumber,
              [labels.inProgress || "quack-in-progress"],
              githubConfig,
              projectRoot,
            );
          } else if (currentStatus === "IN_PROGRESS") {
            await addLabels(
              entry.issueNumber,
              [labels.inProgress || "quack-in-progress"],
              githubConfig,
              projectRoot,
            );
            await removeLabels(
              entry.issueNumber,
              [labels.ready || "quack-ready"],
              githubConfig,
              projectRoot,
            );
          } else if (currentStatus === "READY") {
            await addLabels(
              entry.issueNumber,
              [labels.ready || "quack-ready"],
              githubConfig,
              projectRoot,
            );
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

    return { outcomes };
  });
  syncAllTasksInFlight.set(syncFilePath, run);
  try {
    return await run;
  } finally {
    if (syncAllTasksInFlight.get(syncFilePath) === run) {
      syncAllTasksInFlight.delete(syncFilePath);
    }
  }
}

async function assertLabelsReadback(
  issueNumber: number,
  expectedLabels: string[],
  expectedPresent: boolean,
  config: GitHubConfig,
  projectRoot: string,
): Promise<void> {
  const readback = await runBoundGitHubCommand(projectRoot, config, [
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "number,url,labels",
  ]);
  const data = parseJsonObject(readback.stdout, "GitHub issue label readback");
  if (data.number !== issueNumber) {
    throw new Error("GitHub issue label readback returned the wrong issue number");
  }
  assertIssueUrl(data.url, readback.repository, issueNumber);
  const actualLabels = new Set(
    parseIssueLabels(data.labels, "GitHub issue label readback").map((label) =>
      label.toLowerCase(),
    ),
  );
  const mismatched = expectedLabels.find(
    (label) => actualLabels.has(label.toLowerCase()) !== expectedPresent,
  );
  if (mismatched !== undefined) {
    throw new Error(
      `GitHub issue label readback did not confirm ${expectedPresent ? "addition" : "removal"} of ${JSON.stringify(mismatched)}`,
    );
  }
}

/**
 * Get sync status for all mapped tasks.
 */
export async function getSyncStatus(
  _adapterConfig: AdapterConfig,
  projectRoot: string,
): Promise<{
  totalEntries: number;
  entries: Array<{
    taskId: string;
    issueNumber: number;
    direction: string;
    lastSyncedAt: string;
  }>;
}> {
  const syncMap = await getSyncMap(projectRoot);
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
