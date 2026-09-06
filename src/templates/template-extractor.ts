import type { ParsedTask } from "../core/types.js";
import type { RunAnalysis } from "../analytics/analytics-types.js";
import type { TaskTemplate } from "./template-types.js";
import { categorizeTask } from "./task-categorizer.js";

/**
 * Extracts a reusable template from a completed task and its run history.
 *
 * @param task - The completed task to extract a template from
 * @param runHistory - Historical run data for this task
 * @returns A task template with anonymized structure and success metrics
 */
export function extractTemplate(task: ParsedTask, runHistory: RunAnalysis[]): TaskTemplate {
  const category = categorizeTask(task);

  // Calculate success rate from historical runs
  const totalRuns = runHistory.length;
  const approvedRuns = runHistory.filter((r) => r.outcome === "approved").length;
  const successRate = totalRuns > 0 ? approvedRuns / totalRuns : 0;

  // Calculate average cost
  const totalCost = runHistory.reduce((sum, r) => sum + r.costUsd, 0);
  const avgCostUsd = totalRuns > 0 ? totalCost / totalRuns : 0;

  // Extract file patterns (directory paths only, no specific filenames)
  const filePatterns = extractFilePatterns(task.filesToModify.map((f) => f.path));

  // Anonymize the spec template (replace specific names with placeholders)
  const specTemplate = anonymizeSpec(task);

  return {
    category,
    sourceTaskId: task.id,
    specTemplate,
    successRate,
    avgCostUsd,
    filePatterns,
    fileCount: task.filesToModify.length,
    tags: task.tags,
  };
}

/**
 * Extracts directory patterns from file paths.
 * Example: ["src/templates/foo.ts", "src/templates/bar.ts"] -> ["src/templates"]
 */
function extractFilePatterns(filePaths: string[]): string[] {
  const dirSet = new Set<string>();

  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");

    // Extract top 2 levels (e.g., "src/templates")
    if (parts.length >= 2) {
      dirSet.add(`${parts[0]}/${parts[1]}`);
    } else if (parts.length === 1) {
      dirSet.add(parts[0]);
    }
  }

  return Array.from(dirSet).sort();
}

/**
 * Anonymizes a task spec by replacing specific names with placeholders.
 * This makes the template reusable for similar tasks.
 *
 * Replacements applied:
 * - TASK-NNN references → <TASK_ID>
 * - PascalCase identifiers (e.g., AuthService, UserManager) → <Component>
 * - Specific file paths (e.g., src/foo/bar.ts) → <file_path>
 */
function anonymizeSpec(task: ParsedTask): string {
  let text = `${task.problemStatement}\n\n${task.recommendedApproach}`;

  // Replace TASK-NNN references with placeholder
  text = text.replace(/TASK-\d+/g, "<TASK_ID>");

  // Replace specific file paths (e.g., src/foo/bar.ts, tests/monitor/widget.test.ts)
  text = text.replace(/(?:src|tests|lib|dist)\/[\w/.-]+\.\w+/g, "<file_path>");

  // Replace PascalCase identifiers (2+ capitalized words, e.g., AuthService, UserManager)
  // but not common words or abbreviations
  text = text.replace(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, "<Component>");

  return text.slice(0, 1000);
}
