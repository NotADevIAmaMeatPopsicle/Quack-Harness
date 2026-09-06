import type { ParsedTask } from "../core/types.js";
import type { TaskCategory } from "./template-types.js";

/**
 * Categorizes a task based on its tags, file patterns, and problem statement.
 * This is a deterministic classification - no LLM needed.
 *
 * @param task - The parsed task to categorize
 * @returns The task category
 */
export function categorizeTask(task: ParsedTask): TaskCategory {
  const tags = new Set(task.tags.map((t) => t.toLowerCase()));
  const problemLower = task.problemStatement.toLowerCase();
  const files = task.filesToModify.map((f) => f.path.toLowerCase());

  // Check tags first (most explicit)
  if (tags.has("dashboard") || tags.has("ui")) return "dashboard-feature";
  if (tags.has("api") || tags.has("endpoint")) return "api-endpoint";
  if (tags.has("testing") || tags.has("test")) return "testing";
  if (tags.has("bug") || tags.has("fix")) return "bug-fix";
  if (tags.has("refactor")) return "refactor";
  if (tags.has("config") || tags.has("configuration")) return "configuration";
  if (tags.has("infra") || tags.has("ci") || tags.has("build")) return "infrastructure";
  if (tags.has("integration") || tags.has("wiring")) return "integration";

  // Check file patterns
  const hasTests = files.some((f) => f.includes("test") || f.includes("spec"));
  if (
    hasTests &&
    task.filesToModify.length <= 2 &&
    files.every((f) => f.includes("test") || f.includes("spec"))
  )
    return "testing";

  const hasDashboard = files.some((f) => f.includes("dashboard") || f.includes("monitor/public"));
  if (hasDashboard) return "dashboard-feature";

  const hasApi = files.some((f) => f.includes("api") || f.includes("endpoint"));
  if (hasApi) return "api-endpoint";

  const hasConfig = files.some(
    (f) => f.includes("config") || f.includes(".json") || f.includes(".yaml"),
  );
  if (hasConfig && task.filesToModify.length <= 3) return "configuration";

  // Check action - all creates = new module
  const allCreates = task.filesToModify.every((f) => f.action === "Create");
  if (allCreates && task.filesToModify.length >= 2) return "new-module";

  // Check problem statement keywords
  if (problemLower.includes("integrate") || problemLower.includes("wire")) return "integration";
  if (
    problemLower.includes("bug") ||
    problemLower.includes("broken") ||
    problemLower.includes("fix")
  )
    return "bug-fix";
  if (problemLower.includes("refactor") || problemLower.includes("restructur")) return "refactor";
  if (problemLower.includes("dashboard") || problemLower.includes("ui")) return "dashboard-feature";
  if (problemLower.includes("endpoint") || problemLower.includes("api")) return "api-endpoint";
  if (problemLower.includes("config")) return "configuration";
  if (
    problemLower.includes("build") ||
    problemLower.includes("deploy") ||
    problemLower.includes("ci")
  )
    return "infrastructure";

  // Don't check for 'test' keyword in problem statement as it's too broad

  // Default to integration if modifying existing files, new-module otherwise
  if (task.filesToModify.length > 0) {
    const hasModify = task.filesToModify.some((f) => f.action === "Modify");
    return hasModify ? "integration" : "new-module";
  }

  return "new-module";
}
