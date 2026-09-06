import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ProjectAdapter } from "../core/adapter-loader.js";
import { matchTaskHeading, parseTaskFile, TaskParseError } from "../core/task-parser.js";
import { validateTaskSchema } from "../gate/schema-validator.js";
import type { FileModification, TaskPriority, TaskStatus } from "../core/types.js";

/**
 * Parsed task spec structure from planner agent.
 */
export interface TaskSpec {
  id: string;
  content: string;
}

/**
 * Validation error for a task spec.
 */
export interface TaskValidationError {
  taskId: string;
  errors: string[];
}

export interface TaskCreateInput {
  id: string;
  title: string;
  priority: TaskPriority;
  effort: string;
  status: TaskStatus;
  blockedBy?: string[];
  blocks?: string[];
  tags?: string[];
  conventions?: string[];
  problemStatement: string;
  currentState?: string;
  recommendedApproach?: string;
  filesToModify?: Array<{
    path: string;
    action: FileModification["action"];
    notes?: string;
  }>;
  successCriteria: string[];
  testingRequirements: string[];
  contextReferences?: string[];
}

export interface TaskCreateFieldError {
  index: number;
  field: string;
  message: string;
}

export class TaskCreateValidationError extends Error {
  constructor(public readonly fieldErrors: TaskCreateFieldError[]) {
    super("Task creation payload validation failed");
    this.name = "TaskCreateValidationError";
  }
}

export class TaskCreateConflictError extends Error {
  constructor(public readonly conflictIds: string[]) {
    super(`Task ID conflict: ${conflictIds.join(", ")}`);
    this.name = "TaskCreateConflictError";
  }
}

export interface TaskWriteResult {
  taskIds: string[];
  filePaths: string[];
}

const VALID_TASK_PRIORITIES = new Set(["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"]);
const VALID_TASK_STATUSES = new Set([
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "ON_HOLD",
  "DECOMPOSED",
  "VERIFYING",
  "COMPLETE",
  "VERIFIED",
  "REJECTED",
]);

/**
 * Writes generated task specifications to files.
 * Validates each spec before writing.
 *
 * @param taskSpecs - Array of task specs to write
 * @param adapter - The project adapter
 * @returns Array of task IDs that were successfully written
 * @throws Error if validation fails for any spec
 */
export async function writeTaskFiles(
  taskSpecs: TaskSpec[],
  adapter: ProjectAdapter,
): Promise<string[]> {
  return (await writeTaskFilesWithResult(taskSpecs, adapter)).taskIds;
}

/**
 * Writes generated task specifications and returns the exact paths written.
 * The public writeTaskFiles compatibility contract remains Promise<string[]>.
 */
export async function writeTaskFilesWithResult(
  taskSpecs: TaskSpec[],
  adapter: ProjectAdapter,
): Promise<TaskWriteResult> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

  // Ensure task directory exists
  await fs.mkdir(taskDir, { recursive: true });

  // Phase 1: Validate individual specs
  const validationErrors: TaskValidationError[] = [];
  for (const spec of taskSpecs) {
    const errors = validateTaskSpec(spec, adapter);
    if (errors.length > 0) {
      validationErrors.push({ taskId: spec.id, errors });
    }
  }

  // Phase 2: Cross-validate dependency references against existing + generated IDs
  if (validationErrors.length === 0) {
    const existingIds = await getExistingTaskIds(taskDir);
    const generatedIds = new Set(taskSpecs.map((s) => s.id));
    const allValidIds = new Set([...existingIds, ...generatedIds]);

    for (const spec of taskSpecs) {
      const parsed = parseTaskFile(spec.content);
      const depErrors: string[] = [];
      for (const dep of [...parsed.blockedBy, ...parsed.blocks]) {
        if (!allValidIds.has(dep)) {
          depErrors.push(`Dependency ${dep} references non-existent task ID`);
        }
      }
      if (depErrors.length > 0) {
        validationErrors.push({ taskId: spec.id, errors: depErrors });
      }
    }
  }

  if (validationErrors.length > 0) {
    const errorMessages = validationErrors
      .map((err) => `${err.taskId}:\n  ${err.errors.join("\n  ")}`)
      .join("\n\n");
    throw new Error(
      `Task validation failed for ${validationErrors.length} task(s):\n\n${errorMessages}`,
    );
  }

  // Phase 3: Write with lock to prevent concurrent ID collisions
  const lockPath = path.join(taskDir, ".plan.lock");
  try {
    await fs.writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
  } catch {
    throw new Error(`Another plan operation is in progress. If stale, delete ${lockPath}`);
  }

  const plannedWrites = taskSpecs.map((spec) => {
    const fileName = `${spec.id}-${slugify(extractTitle(spec.content))}.md`;
    const filePath = path.join(taskDir, fileName);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    return { spec, filePath, tempPath };
  });
  const createdFinalPaths: string[] = [];

  try {
    const writtenIds: string[] = [];

    const conflictIds = new Set<string>();
    for (const planned of plannedWrites) {
      try {
        await fs.stat(planned.filePath);
        conflictIds.add(planned.spec.id);
      } catch {
        // file doesn't exist
      }
    }
    if (conflictIds.size > 0) {
      throw new TaskCreateConflictError(Array.from(conflictIds).sort());
    }

    for (const planned of plannedWrites) {
      await fs.writeFile(planned.tempPath, planned.spec.content, "utf-8");
    }

    for (const planned of plannedWrites) {
      await fs.rename(planned.tempPath, planned.filePath);
      writtenIds.push(planned.spec.id);
      createdFinalPaths.push(planned.filePath);
    }
    return { taskIds: writtenIds, filePaths: [...createdFinalPaths] };
  } catch (err) {
    for (const planned of plannedWrites) {
      await fs.unlink(planned.tempPath).catch(() => {});
    }
    for (const filePath of createdFinalPaths) {
      await fs.unlink(filePath).catch(() => {});
    }
    throw err;
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function createTaskFilesFromInput(
  inputs: unknown[],
  adapter: ProjectAdapter,
): Promise<TaskWriteResult> {
  const fieldErrors: TaskCreateFieldError[] = [];
  const normalizedInputs: TaskCreateInput[] = [];

  inputs.forEach((input, index) => {
    const { value, errors } = normalizeTaskCreateInput(input, index);
    fieldErrors.push(...errors);
    if (value) {
      normalizedInputs.push(value);
    }
  });

  if (fieldErrors.length > 0) {
    throw new TaskCreateValidationError(fieldErrors);
  }

  const duplicateIds = findDuplicates(normalizedInputs.map((item) => item.id));
  if (duplicateIds.length > 0) {
    throw new TaskCreateConflictError(duplicateIds);
  }

  const taskSpecs = normalizedInputs.map((input) => buildTaskSpecFromInput(input));

  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await fs.mkdir(taskDir, { recursive: true });
  const existingIds = await getExistingTaskIds(taskDir);
  const existingConflicts = taskSpecs.map((spec) => spec.id).filter((id) => existingIds.has(id));
  if (existingConflicts.length > 0) {
    throw new TaskCreateConflictError(Array.from(new Set(existingConflicts)).sort());
  }

  return writeTaskFilesWithResult(taskSpecs, adapter);
}

/**
 * Scan existing task files to build a set of known task IDs.
 */
async function getExistingTaskIds(taskDir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(taskDir);
    const ids = new Set<string>();
    for (const entry of entries) {
      const match = entry.match(/^((?:TASK-\d{3}|SAURUS-REM-\d{3}))/);
      if (match) ids.add(match[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function normalizeTaskCreateInput(
  input: unknown,
  index: number,
): { value?: TaskCreateInput; errors: TaskCreateFieldError[] } {
  const errors: TaskCreateFieldError[] = [];
  if (!input || typeof input !== "object") {
    errors.push({
      index,
      field: "$",
      message: "Task payload must be an object",
    });
    return { errors };
  }

  const record = input as Record<string, unknown>;
  const id = readRequiredString(record, "id", index, errors);
  const title = readRequiredString(record, "title", index, errors);
  const priority = readRequiredString(record, "priority", index, errors);
  const effort = readRequiredString(record, "effort", index, errors);
  const status = readRequiredString(record, "status", index, errors);
  const problemStatement = readRequiredString(record, "problemStatement", index, errors);

  const successCriteria = readStringArray(record, "successCriteria", index, errors, true);
  const testingRequirements = readStringArray(record, "testingRequirements", index, errors, true);
  const blockedBy = readStringArray(record, "blockedBy", index, errors, false);
  const blocks = readStringArray(record, "blocks", index, errors, false);
  const tags = readStringArray(record, "tags", index, errors, false);
  const conventions = readStringArray(record, "conventions", index, errors, false);
  const contextReferences = readStringArray(record, "contextReferences", index, errors, false);
  const currentState = readOptionalString(record, "currentState", index, errors);
  const recommendedApproach = readOptionalString(record, "recommendedApproach", index, errors);
  const filesToModify = readFilesToModify(record, index, errors);

  if (id && !/^(?:TASK-\d{3}(?:-[A-Z]+)?|SAURUS-REM-\d{3})$/.test(id)) {
    errors.push({
      index,
      field: "id",
      message: "Task ID must match TASK-NNN, TASK-NNN-X, or SAURUS-REM-NNN format",
    });
  }
  if (priority && !VALID_TASK_PRIORITIES.has(priority)) {
    errors.push({
      index,
      field: "priority",
      message: `Priority must be one of ${Array.from(VALID_TASK_PRIORITIES).join(", ")}`,
    });
  }
  if (status && !VALID_TASK_STATUSES.has(status)) {
    errors.push({
      index,
      field: "status",
      message: `Status must be one of ${Array.from(VALID_TASK_STATUSES).join(", ")}`,
    });
  }

  if (!id || !title || !priority || !effort || !status || !problemStatement) {
    return { errors };
  }
  if (successCriteria.length === 0) {
    errors.push({
      index,
      field: "successCriteria",
      message: "Provide at least one success criterion",
    });
  }
  if (testingRequirements.length === 0) {
    errors.push({
      index,
      field: "testingRequirements",
      message: "Provide at least one testing requirement",
    });
  }
  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    value: {
      id,
      title,
      priority: priority as TaskPriority,
      effort,
      status: status as TaskStatus,
      blockedBy,
      blocks,
      tags,
      conventions,
      problemStatement,
      currentState,
      recommendedApproach,
      filesToModify,
      successCriteria,
      testingRequirements,
      contextReferences,
    },
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  index: number,
  errors: TaskCreateFieldError[],
): string | undefined {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      index,
      field,
      message: "Field is required and must be a non-empty string",
    });
    return undefined;
  }
  return value.trim();
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  index: number,
  errors: TaskCreateFieldError[],
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push({
      index,
      field,
      message: "Field must be a string when provided",
    });
    return undefined;
  }
  return value.trim();
}

function readStringArray(
  record: Record<string, unknown>,
  field: string,
  index: number,
  errors: TaskCreateFieldError[],
  required: boolean,
): string[] {
  const value = record[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push({
      index,
      field,
      message: "Field must be an array of strings",
    });
    return [];
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (required && normalized.length === 0) {
    errors.push({
      index,
      field,
      message: "Field must contain at least one non-empty string",
    });
  }
  if (normalized.length !== value.length) {
    errors.push({
      index,
      field,
      message: "Field must contain only non-empty strings",
    });
  }
  return normalized;
}

function readFilesToModify(
  record: Record<string, unknown>,
  index: number,
  errors: TaskCreateFieldError[],
): TaskCreateInput["filesToModify"] {
  const value = record.filesToModify;
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push({
      index,
      field: "filesToModify",
      message: "filesToModify must be an array",
    });
    return [];
  }
  const normalized: TaskCreateInput["filesToModify"] = [];
  value.forEach((item, fileIndex) => {
    if (!item || typeof item !== "object") {
      errors.push({
        index,
        field: `filesToModify[${fileIndex}]`,
        message: "Each file entry must be an object",
      });
      return;
    }
    const rec = item as Record<string, unknown>;
    const pathValue = typeof rec.path === "string" ? rec.path.trim() : "";
    const actionValue = typeof rec.action === "string" ? rec.action.trim() : "";
    const notesValue = typeof rec.notes === "string" ? rec.notes.trim() : "";
    if (!pathValue) {
      errors.push({
        index,
        field: `filesToModify[${fileIndex}].path`,
        message: "path is required",
      });
      return;
    }
    if (!["Create", "Modify", "Delete"].includes(actionValue)) {
      errors.push({
        index,
        field: `filesToModify[${fileIndex}].action`,
        message: "action must be Create, Modify, or Delete",
      });
      return;
    }
    normalized.push({
      path: pathValue,
      action: actionValue as FileModification["action"],
      notes: notesValue,
    });
  });
  return normalized;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      dups.add(value);
    }
    seen.add(value);
  }
  return Array.from(dups).sort();
}

function buildTaskSpecFromInput(input: TaskCreateInput): TaskSpec {
  const lines: string[] = [
    `# ${input.id}: ${input.title}`,
    "",
    "## Metadata",
    `- **Priority:** ${input.priority}`,
    `- **Effort:** ${input.effort}`,
    `- **Status:** ${input.status}`,
    `- **Blocked By:** ${formatList(input.blockedBy)}`,
    `- **Blocks:** ${formatList(input.blocks)}`,
    `- **Tags:** ${formatList(input.tags)}`,
  ];

  if (input.conventions && input.conventions.length > 0) {
    lines.push(`- **Conventions:** ${formatList(input.conventions)}`);
  }

  lines.push(
    "",
    "## Problem Statement",
    input.problemStatement,
    "",
    "## Current State",
    input.currentState?.trim() || "N/A",
    "",
    "## Recommended Approach",
    input.recommendedApproach?.trim() || "N/A",
  );

  if (input.filesToModify && input.filesToModify.length > 0) {
    lines.push("", "## Files to Modify", "| File | Action | Notes |", "|------|--------|-------|");
    for (const file of input.filesToModify) {
      lines.push(`| ${file.path} | ${file.action} | ${file.notes?.trim() || ""} |`);
    }
  }

  lines.push(
    "",
    "## Success Criteria",
    ...input.successCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Testing Requirements",
    ...input.testingRequirements.map((requirement) => `- [ ] ${requirement}`),
  );

  if (input.contextReferences && input.contextReferences.length > 0) {
    lines.push("", "## Context References", ...input.contextReferences.map((ref) => `- ${ref}`));
  }

  lines.push("");

  return {
    id: input.id,
    content: lines.join("\n"),
  };
}

function formatList(items?: string[]): string {
  if (!items || items.length === 0) return "[]";
  return `[${items.join(", ")}]`;
}

/**
 * Validates a task spec.
 * Returns an array of error messages (empty if valid).
 */
function validateTaskSpec(spec: TaskSpec, adapter: ProjectAdapter): string[] {
  const errors: string[] = [];

  // Parse the task spec
  let parsedTask;
  try {
    parsedTask = parseTaskFile(spec.content);
  } catch (err: unknown) {
    if (err instanceof TaskParseError) {
      errors.push(`Parse error: ${err.message}`);
      return errors;
    }
    throw err;
  }

  // Validate schema
  const schemaResult = validateTaskSchema(parsedTask);
  if (!schemaResult.valid) {
    errors.push(...schemaResult.missing.map((field) => `Missing required field: ${field}`));
  }

  // Validate task ID matches
  if (parsedTask.id !== spec.id) {
    errors.push(`Task ID mismatch: expected ${spec.id}, got ${parsedTask.id}`);
  }

  // Validate filesToModify paths are within sandbox writable paths
  const writablePaths = adapter.config.sandbox.writablePaths;
  for (const fileMod of parsedTask.filesToModify) {
    const normalizedPath = fileMod.path.replace(/\\/g, "/");
    const isWritable = writablePaths.some((writable) => {
      const normalizedWritable = writable.replace(/\\/g, "/");
      // Handle wildcards
      if (normalizedWritable.endsWith("/**")) {
        const prefix = normalizedWritable.slice(0, -3);
        return normalizedPath.startsWith(prefix);
      }
      if (normalizedWritable.endsWith("/*")) {
        const prefix = normalizedWritable.slice(0, -2);
        return normalizedPath.startsWith(prefix);
      }
      return (
        normalizedPath === normalizedWritable || normalizedPath.startsWith(normalizedWritable + "/")
      );
    });

    if (!isWritable) {
      errors.push(
        `File path ${fileMod.path} is not within writable paths: ${writablePaths.join(", ")}`,
      );
    }
  }

  // Validate dependency references (must reference valid task IDs)
  // For now, we only validate format (TASK-NNN)
  for (const dep of parsedTask.blockedBy) {
    if (!dep.match(/^TASK-\d{3}$/)) {
      errors.push(`Invalid blockedBy reference: ${dep} (must be TASK-NNN format)`);
    }
  }
  for (const dep of parsedTask.blocks) {
    if (!dep.match(/^TASK-\d{3}$/)) {
      errors.push(`Invalid blocks reference: ${dep} (must be TASK-NNN format)`);
    }
  }

  return errors;
}

/**
 * Extract the title from a task spec content.
 */
function extractTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("# ")) continue;

    const matched = matchTaskHeading(line.slice(2));
    if (matched?.title) return matched.title;
  }

  return "untitled";
}

/**
 * Convert a title to a URL-safe slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50); // Limit length for file system compatibility
}
