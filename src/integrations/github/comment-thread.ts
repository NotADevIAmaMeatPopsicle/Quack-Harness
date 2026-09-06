// ─── GitHub Comment Threading ───────────────────────────────────────
// Post structured lifecycle comments on GitHub issues.

import type { GitHubConfig, SyncEvent } from "./github-types.js";
import { runGh } from "./gh-cli.js";

// ─── Comment Formatting ─────────────────────────────────────────────

/**
 * Build a formatted lifecycle comment for an event.
 */
function buildLifecycleComment(event: SyncEvent): string {
  const lines: string[] = [];

  // Header based on event type
  switch (event.type) {
    case "task_created": {
      lines.push("### 🦆 Quack: Task Created");
      lines.push("");
      lines.push(`Quack created **${event.taskId}** from this issue.`);
      if (event.data?.specPath && typeof event.data.specPath === "string") {
        lines.push("");
        lines.push(`[View task spec](${event.data.specPath})`);
      }
      break;
    }

    case "gate_passed": {
      lines.push("### ✅ Quack: Readiness Gate Passed");
      lines.push("");
      lines.push(`**${event.taskId}** passed the readiness gate and is ready for dispatch.`);
      if (event.data?.depthScore && typeof event.data.depthScore === "number") {
        lines.push("");
        lines.push(`**Depth Score:** ${event.data.depthScore}/5`);
      }
      break;
    }

    case "gate_failed": {
      lines.push("### ⚠️ Quack: Readiness Gate Failed");
      lines.push("");
      lines.push(`**${event.taskId}** needs enrichment before dispatch.`);
      if (event.data?.deficiencies) {
        lines.push("");
        lines.push("**Deficiencies:**");
        const deficiencies = event.data.deficiencies as string[];
        for (const def of deficiencies) {
          lines.push(`- ${def}`);
        }
      }
      break;
    }

    case "dispatch_started": {
      lines.push("### 🚀 Quack: Dispatch Started");
      lines.push("");
      lines.push("| Field | Value |");
      lines.push("|-------|-------|");
      lines.push(`| Task | ${event.taskId} |`);
      if (event.data?.model && typeof event.data.model === "string") {
        lines.push(`| Model | ${event.data.model} |`);
      }
      if (event.data?.budget && typeof event.data.budget === "number") {
        lines.push(`| Budget | $${event.data.budget} |`);
      }
      lines.push(`| Started | ${event.timestamp} |`);
      break;
    }

    case "dispatch_complete": {
      const outcome = event.data?.outcome as string;
      if (outcome === "approved") {
        lines.push("### ✅ Quack: Dispatch Approved");
        lines.push("");
        lines.push(`**${event.taskId}** completed successfully and passed judge review.`);
      } else if (outcome === "rejected") {
        lines.push("### ❌ Quack: Dispatch Rejected");
        lines.push("");
        lines.push(`**${event.taskId}** was rejected by the judge.`);
        if (event.data?.feedback) {
          lines.push("");
          lines.push("**Feedback:**");
          lines.push(event.data.feedback as string);
        }
      }
      break;
    }

    case "pr_created": {
      lines.push("### 🎉 Quack: Pull Request Created");
      lines.push("");
      lines.push(`**${event.taskId}** implementation complete.`);
      if (event.data?.prUrl && typeof event.data.prUrl === "string") {
        lines.push("");
        lines.push(`**Pull Request:** ${event.data.prUrl}`);
      }
      break;
    }
  }

  // Footer
  lines.push("");
  lines.push("---");
  lines.push("*🦆 Quack Agent System*");

  return lines.join("\n");
}

// ─── Post Comment ───────────────────────────────────────────────────

/**
 * Post a lifecycle comment on a GitHub issue.
 */
export async function postLifecycleComment(
  issueNumber: number,
  event: SyncEvent,
  config: GitHubConfig,
): Promise<void> {
  const comment = buildLifecycleComment(event);

  try {
    await runGh(
      [
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        `${config.owner}/${config.repo}`,
        "--body-file",
        "-",
      ],
      { input: comment },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to post comment on issue #${issueNumber}: ${message}`);
  }
}
