// ─── Issue to Planner Prompt Converter ─────────────────────────────
// Convert a GitHub issue into a planner prompt.

import type { GitHubIssue } from "./github-types.js";

/**
 * Build a planner prompt from a GitHub issue.
 * Enriches the issue with metadata, comments, and file references.
 */
export function buildPlannerPrompt(issue: GitHubIssue): string {
  const lines: string[] = [];

  lines.push(`# GitHub Issue #${issue.number}: ${issue.title}`);
  lines.push("");
  lines.push("## Issue Description");
  lines.push(issue.body || "(no description provided)");
  lines.push("");

  // Add labels as tags
  if (issue.labels.length > 0) {
    lines.push("## Labels");
    lines.push(issue.labels.map((l) => `- ${l}`).join("\n"));
    lines.push("");
  }

  // Add assignees
  if (issue.assignees.length > 0) {
    lines.push("## Assignees");
    lines.push(issue.assignees.map((a) => `- @${a}`).join("\n"));
    lines.push("");
  }

  // Add comments as conversation context
  if (issue.comments.length > 0) {
    lines.push("## Discussion");
    for (const comment of issue.comments) {
      lines.push(`### @${comment.author} (${comment.createdAt})`);
      lines.push(comment.body);
      lines.push("");
    }
  }

  // Add referenced files
  if (issue.referencedFiles.length > 0) {
    lines.push("## Referenced Files");
    lines.push(issue.referencedFiles.map((f) => `- \`${f}\``).join("\n"));
    lines.push("");
  }

  // Add issue URL for traceability
  lines.push("## Source");
  lines.push(`GitHub Issue: ${issue.url}`);
  lines.push("");

  // Instructions for the planner
  lines.push("---");
  lines.push("");
  lines.push(
    "Please generate a comprehensive task specification (TASK-*.md) for this GitHub issue.",
  );
  lines.push("Include:");
  lines.push("- A clear problem statement based on the issue description");
  lines.push("- Recommended approach considering the discussion and referenced files");
  lines.push("- All files that need to be created or modified");
  lines.push("- Comprehensive success criteria as a checklist");
  lines.push("- Testing requirements");
  lines.push("- Any context references from the codebase");
  lines.push("");

  // Map labels to tags
  if (issue.labels.length > 0) {
    const tagCandidates = issue.labels.filter((l) => !l.startsWith("quack-")).slice(0, 5);
    if (tagCandidates.length > 0) {
      lines.push(`Suggested tags: ${tagCandidates.join(", ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
