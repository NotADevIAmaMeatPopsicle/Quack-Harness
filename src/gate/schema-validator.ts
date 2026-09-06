import { ParsedTask, SchemaCheckResult, TaskPriority, TaskStatus } from "../core/types";
import * as path from "node:path";
import { TASK_STATUSES } from "../core/task-status.js";
import { hasUnresolvedRepairMarkers } from "../core/spec-normalizer.js";

/**
 * Validates a ParsedTask against the required schema.
 * This is Layer 1 of the Task Readiness Gate — pure deterministic logic.
 *
 * Required fields:
 * - title (non-empty string)
 * - priority (valid TaskPriority value)
 * - effort (non-empty string)
 * - status (valid TaskStatus value)
 * - problemStatement (non-empty string)
 * - successCriteria (array with at least 1 item)
 * - testingRequirements (array with at least 1 item)
 *
 * Recommended fields (warnings if missing):
 * - currentState
 * - recommendedApproach
 * - filesToModify (should have at least 1 entry)
 *
 * @param task - The parsed task to validate
 * @param requiredSections - Optional list of recommended sections to promote to required.
 *   When a section name is listed here, an empty value causes a gate failure (missing[]) instead
 *   of a warning. Allowed values: "currentState", "recommendedApproach", "filesToModify".
 * @returns SchemaCheckResult with validation status, missing required fields, and warnings
 */
export function validateTaskSchema(
  task: ParsedTask,
  requiredSections: string[] = [],
): SchemaCheckResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Valid priority values
  const validPriorities: TaskPriority[] = ["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"];

  // Valid status values
  const validStatuses: readonly TaskStatus[] = TASK_STATUSES;

  // Check required fields
  if (!task.title || task.title.trim().length === 0) {
    missing.push("title");
  }

  if (!task.priority || !validPriorities.includes(task.priority)) {
    missing.push("priority");
  }

  if (!task.effort || task.effort.trim().length === 0) {
    missing.push("effort");
  }

  if (!task.status || !validStatuses.includes(task.status)) {
    missing.push("status");
  }

  if (!task.problemStatement || task.problemStatement.trim().length === 0) {
    missing.push("problem_statement");
  }

  if (!task.successCriteria || task.successCriteria.length === 0) {
    missing.push("success_criteria (minimum 1 required)");
  }

  if (!task.testingRequirements || task.testingRequirements.length === 0) {
    missing.push("testing_requirements (minimum 1 required)");
  }

  // Check recommended fields — promoted to missing[] if listed in requiredSections
  if (!task.currentState || task.currentState.trim().length === 0) {
    if (requiredSections.includes("currentState")) {
      missing.push("current_state (required by project config)");
    } else {
      warnings.push("current_state");
    }
  }

  if (!task.recommendedApproach || task.recommendedApproach.trim().length === 0) {
    if (requiredSections.includes("recommendedApproach")) {
      missing.push("recommended_approach (required by project config)");
    } else {
      warnings.push("recommended_approach");
    }
  }

  // Count ALL filesToModify entries regardless of action — Reference entries
  // are valid table rows and must be included in the length check.
  if (!task.filesToModify || task.filesToModify.length === 0) {
    if (requiredSections.includes("filesToModify")) {
      missing.push("files_to_modify (required by project config)");
    } else {
      warnings.push("files_to_modify (minimum 1 recommended)");
    }
  }

  const unsafeTaskPaths = (task.filesToModify ?? [])
    .map((file) => file.path.trim())
    .filter((filePath) => {
      const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
      return (
        filePath.length === 0 ||
        path.posix.isAbsolute(normalized) ||
        path.win32.isAbsolute(filePath) ||
        normalized === ".." ||
        normalized.startsWith("../")
      );
    });
  if (unsafeTaskPaths.length > 0) {
    missing.push(
      `files_to_modify contains path(s) outside the project root: ${unsafeTaskPaths.join(", ")}`,
    );
  }

  // Integration wiring check
  // Filter to Create/Modify only — Reference entries are intentionally excluded:
  // they are context-only files the agent reads but does not create or modify.
  const filesToCreate =
    task.filesToModify?.filter((f) => f.action === "Create")?.map((f) => f.path) ?? [];

  const filesToModify =
    task.filesToModify?.filter((f) => f.action === "Modify")?.map((f) => f.path) ?? [];

  if (filesToCreate.length > 0) {
    // CLI commands must register in index.ts
    if (filesToCreate.some((f) => f.startsWith("src/cli/"))) {
      if (!filesToModify.some((f) => f.includes("index.ts"))) {
        warnings.push(
          "New CLI command file created but src/index.ts not in filesToModify — command will not be registered",
        );
      }
    }

    // API route files must integrate into server.ts
    if (filesToCreate.some((f) => f.includes("routes/") || f.includes("server"))) {
      if (!filesToModify.some((f) => f.includes("server.ts"))) {
        warnings.push(
          "New route/endpoint file created but server.ts not in filesToModify — endpoints will not be mounted",
        );
      }
    }

    // New type files should be imported somewhere
    if (filesToCreate.some((f) => f.includes("-types.ts") || f.includes("/types/"))) {
      warnings.push(
        "New type definition file created — verify it is imported by the modules that use it",
      );
    }

    // Event type additions need event-types.ts
    if (
      task.successCriteria?.some(
        (c) => c.toLowerCase().includes("event") && c.toLowerCase().includes("emit"),
      )
    ) {
      if (!filesToModify.some((f) => f.includes("event-types.ts"))) {
        warnings.push(
          "Success criteria mention emitting events but event-types.ts not in filesToModify",
        );
      }
    }
  }

  // Multi-layer completeness check
  // Only check if filesToModify is not empty (to avoid duplicating the recommended field warning)
  if (task.filesToModify && task.filesToModify.length > 0) {
    const rawContent = task.rawContent ?? "";
    const problemStatement = task.problemStatement ?? "";
    const allText = `${rawContent}\n${problemStatement}`;

    // Detect frontend mentions in spec content
    const frontendKeywords =
      /\b(frontend|react|component|\.tsx|\.jsx|page|view|widget|sidebar|navigation|dashboard|form\s*field|modal|dialog|popover|tooltip)\b/i;
    const frontendFilesPatterns =
      /frontends?\/|src\/components\/|client\/|app\/|pages\/|views\/|\.tsx$/i;

    const mentionsFrontend = frontendKeywords.test(allText);
    const hasFrontendFiles = task.filesToModify.some((f) => frontendFilesPatterns.test(f.path));

    if (mentionsFrontend && !hasFrontendFiles) {
      warnings.push(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    }

    // Detect backend mentions when only frontend files listed
    const backendKeywords =
      /\b(route|controller|service|repository|migration|model|endpoint|API\s*endpoint)\b/i;
    const backendFilesPatterns =
      /\bsrc\/src\/|routes\/|controllers\/|services\/|repositories\/|migrations?\//i;

    const mentionsBackend = backendKeywords.test(allText);
    const hasBackendFiles = task.filesToModify.some((f) => backendFilesPatterns.test(f.path));

    if (mentionsBackend && !hasBackendFiles && hasFrontendFiles) {
      warnings.push(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    }
  }

  // Unresolved repair placeholders gate the task: auto-repair may promote a
  // spec from unparseable to tracked, but never to dispatchable. A human
  // must resolve every repair-inserted default/TBD before the gate passes.
  if (hasUnresolvedRepairMarkers(task.rawContent)) {
    missing.push(
      "unresolved_repair_placeholders (auto-repair inserted defaults/TBDs; the submitter must fill and confirm them before dispatch)",
    );
  }

  // Determine validity
  const valid = missing.length === 0;

  return {
    valid,
    missing,
    warnings,
  };
}
