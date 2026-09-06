// ─── GitHub Issue Import Pipeline ──────────────────────────────────
// Orchestrate: fetch issue → generate task spec → run gate → sync map.

import * as path from "node:path";

import type { ProjectAdapter } from "../../core/adapter-loader.js";
import type { SyncEntry } from "./github-types.js";
import { fetchIssue, fetchIssuesByLabel } from "./issue-fetcher.js";
import { buildPlannerPrompt } from "./issue-converter.js";
import { planTasks } from "../../planner/planner-agent.js";
import { runReadinessGate } from "../../gate/gate.js";
import { getSyncMap } from "./sync-map.js";
import { postLifecycleComment } from "./comment-thread.js";

// ─── Import Result Types ────────────────────────────────────────────

export interface ImportResult {
  taskId: string;
  issueNumber: number;
  gateResult?: {
    passed: boolean;
    depthScore?: number;
    deficiencies?: string[];
  };
}

// ─── Import Single Issue ────────────────────────────────────────────

/**
 * Import a single GitHub issue as a task spec.
 */
export async function importIssue(
  issueNumber: number,
  adapter: ProjectAdapter,
  autoDispatch: boolean = false,
): Promise<ImportResult> {
  const githubConfig = adapter.config.integrations?.github;
  if (!githubConfig) {
    throw new Error("GitHub integration not configured in adapter.json");
  }

  // Check for duplicates
  const syncMap = await getSyncMap(adapter.config);
  if (syncMap.hasIssue(issueNumber)) {
    const existingTaskId = syncMap.getTaskForIssue(issueNumber);
    throw new Error(`Issue #${issueNumber} already imported as ${existingTaskId}`);
  }

  // Fetch issue
  const issue = await fetchIssue(githubConfig.owner, githubConfig.repo, issueNumber);

  // Check if issue is open
  if (issue.state !== "open") {
    throw new Error(`Issue #${issueNumber} is ${issue.state}, only open issues can be imported`);
  }

  // Build planner prompt
  const prompt = buildPlannerPrompt(issue);

  // Run planner agent
  const plannerResult = await planTasks(prompt, adapter, {
    maxTasks: 1,
    dryRun: false,
  });

  const taskFilePath = plannerResult.filePaths?.[0];
  if (typeof taskFilePath !== "string" || taskFilePath.length === 0) {
    throw new Error(`Planner did not return a task spec path for issue #${issueNumber}`);
  }

  if (plannerResult.taskIds.length === 0) {
    throw new Error(`Planner did not generate any task specs for issue #${issueNumber}`);
  }

  const taskId = plannerResult.taskIds[0];
  const reportedSpecPath = path.relative(adapter.projectRoot, taskFilePath).replace(/\\/g, "/");

  // Add to sync map
  const syncEntry: SyncEntry = {
    taskId,
    issueNumber,
    direction: "imported",
    createdAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    issueState: issue.state,
    taskStatus: "BACKLOG",
  };
  syncMap.addEntry(syncEntry);
  await syncMap.save();

  // Post comment on issue
  if (githubConfig.reportBack) {
    await postLifecycleComment(
      issueNumber,
      {
        type: "task_created",
        taskId,
        timestamp: new Date().toISOString(),
        data: {
          specPath: reportedSpecPath,
        },
      },
      githubConfig,
    );
  }

  // Run readiness gate if requested
  let gateResult: ImportResult["gateResult"];
  if (!autoDispatch) {
    try {
      // Load the task we just created
      const taskContent = await import("node:fs/promises").then((fs) =>
        fs.readFile(taskFilePath, "utf-8"),
      );
      const task = await import("../../core/task-parser.js").then((m) =>
        m.parseTaskFile(taskContent, taskFilePath),
      );

      const gate = await runReadinessGate(task, adapter, {
        skipEnrichment: true,
      });

      const passed = gate.outcome === "pass" || gate.outcome === "enriched";
      gateResult = {
        passed,
        depthScore: undefined,
        deficiencies: undefined,
      };

      // Post gate result comment
      if (githubConfig.reportBack) {
        if (passed) {
          await postLifecycleComment(
            issueNumber,
            {
              type: "gate_passed",
              taskId,
              timestamp: new Date().toISOString(),
              data: {
                depthScore: undefined,
              },
            },
            githubConfig,
          );
        } else {
          await postLifecycleComment(
            issueNumber,
            {
              type: "gate_failed",
              taskId,
              timestamp: new Date().toISOString(),
              data: {
                deficiencies: gate.outcome === "rejected" ? [gate.reason] : [],
              },
            },
            githubConfig,
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Gate check failed for ${taskId}: ${msg}`);
    }
  }

  return {
    taskId,
    issueNumber,
    gateResult,
  };
}

// ─── Import Multiple Issues ─────────────────────────────────────────

/**
 * Import all issues with a specific label.
 */
export async function importIssuesByLabel(
  label: string,
  adapter: ProjectAdapter,
  autoDispatch: boolean = false,
): Promise<ImportResult[]> {
  const githubConfig = adapter.config.integrations?.github;
  if (!githubConfig) {
    throw new Error("GitHub integration not configured in adapter.json");
  }

  const issues = await fetchIssuesByLabel(githubConfig.owner, githubConfig.repo, label);
  const results: ImportResult[] = [];
  const syncMap = await getSyncMap(adapter.config);

  for (const issue of issues) {
    // Skip if already imported
    if (syncMap.hasIssue(issue.number)) {
      console.log(
        `Skipping issue #${issue.number} (already imported as ${syncMap.getTaskForIssue(issue.number)})`,
      );
      continue;
    }

    try {
      const result = await importIssue(issue.number, adapter, autoDispatch);
      results.push(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to import issue #${issue.number}: ${msg}`);
    }
  }

  return results;
}

// ─── Comment Refresh for Subsequent Dispatches ─────────────────────

/**
 * Fetch fresh comments from a GitHub issue and return them as supplementary
 * context for the next dispatch. This pulls new human comments added after
 * the initial import and formats them for injection into the planner/agent
 * context.
 *
 * Called by the dispatcher before running the agent for mapped tasks.
 */
export async function refreshIssueComments(
  taskId: string,
  adapter: ProjectAdapter,
): Promise<string | undefined> {
  const githubConfig = adapter.config.integrations?.github;
  if (!githubConfig) {
    return undefined;
  }

  const syncMap = await getSyncMap(adapter.config);
  const issueNumber = syncMap.getIssueForTask(taskId);
  if (!issueNumber) {
    return undefined;
  }

  try {
    const issue = await fetchIssue(githubConfig.owner, githubConfig.repo, issueNumber);

    // Filter out quack's own comments (they start with ### Quack: or ### 🦆 Quack:)
    const humanComments = issue.comments.filter(
      (c) =>
        !c.body.startsWith("### 🦆 Quack:") &&
        !c.body.startsWith("### Quack:") &&
        !c.body.includes("*🦆 Quack Agent System*"),
    );

    if (humanComments.length === 0) {
      return undefined;
    }

    const lines: string[] = [];
    lines.push("## Supplementary Context from GitHub Issue");
    lines.push("");
    lines.push(
      `The following comments were added to GitHub issue #${issueNumber} after the task was created.`,
    );
    lines.push("Consider this feedback when implementing the task.");
    lines.push("");

    for (const comment of humanComments) {
      lines.push(`### @${comment.author} (${comment.createdAt})`);
      lines.push(comment.body);
      lines.push("");
    }

    return lines.join("\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to refresh comments for ${taskId}: ${msg}`);
    return undefined;
  }
}
