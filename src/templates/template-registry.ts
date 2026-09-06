import { isCompleteStatus } from "../core/task-status.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TemplateRegistry, TaskCategory } from "./template-types.js";
import type { RunAnalysis } from "../analytics/analytics-types.js";
import { parseTaskFile } from "../core/task-parser.js";
import { listDuplicateClaimants, resolveTaskFile } from "../core/task-file-resolver.js";
import { DuplicateClaimantAdmissionError } from "../core/duplicate-claimants.js";
import {
  loadTaskStateOverlay,
  resolveTaskStateWithOverlay,
  type TaskStateOverlayLoad,
} from "../core/task-state-overlay.js";
import { extractTemplate } from "./template-extractor.js";

/**
 * Builds a complete template registry from all completed tasks in the project.
 *
 * @param projectRoot - The project root directory
 * @param taskDir - Relative path to the task directory (default: "docs/tasks")
 * @param sessionLogPath - Path to the session log file (default: ".quack/logs/sessions.jsonl")
 * @returns The built template registry
 */
export async function buildRegistry(
  projectRoot: string,
  taskDir = "docs/tasks",
  sessionLogPath = ".quack/logs/sessions.jsonl",
): Promise<TemplateRegistry> {
  const tasksPath = path.join(projectRoot, taskDir);
  const sessionLog = path.join(projectRoot, sessionLogPath);

  // Read all task files
  const files = await listTaskFiles(tasksPath);

  // Load session history
  const sessionHistory = await loadSessionHistory(sessionLog);

  // TASK-1318 S2: "is this run worth copying" is a RUNTIME question, so
  // it is answered from the runtime store with the spec as fallback,
  // never from the spec alone. Loaded ONCE here, outside the loop: one
  // batch query for the whole build rather than one open per task file.
  const runtimeState = loadTaskStateOverlay(projectRoot);
  warnIfRuntimeAuthorityDegraded(runtimeState, "buildRegistry");

  // Build registry
  const templates: TemplateRegistry["templates"] = [];
  const categoryStats: TemplateRegistry["categoryStats"] = {} as TemplateRegistry["categoryStats"];

  // Initialize category stats
  const categories: TaskCategory[] = [
    "new-module",
    "integration",
    "bug-fix",
    "refactor",
    "dashboard-feature",
    "api-endpoint",
    "testing",
    "configuration",
    "infrastructure",
  ];
  for (const category of categories) {
    categoryStats[category] = { count: 0, avgSuccessRate: 0, avgCostUsd: 0 };
  }

  for (const file of files) {
    try {
      const filePath = path.join(tasksPath, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFile(content, filePath);

      // Resolve DB-over-spec BEFORE the predicate runs. Changing the
      // predicate while still feeding it raw spec status was a rename,
      // not a retirement (TASK-1318 round-2 F1): a run the runtime store
      // holds as REJECTED would still have become a template on the
      // strength of a markdown line claiming COMPLETE.
      const state = resolveTaskStateWithOverlay({
        taskId: task.id,
        specStatus: task.status,
        overlay: runtimeState.overlay,
      });

      // Only extract templates from completed tasks.
      // isCompleteStatus, not isTerminalTaskStatus (TASK-1318 S2 predicate
      // map): REJECTED is finished work, but a rejected run is the last
      // thing that should be mined as a pattern for others to copy.
      if (!isCompleteStatus(state.status)) {
        continue;
      }

      // Find run history for this task
      const taskHistory = sessionHistory.filter((s) => s.taskId === task.id);
      if (taskHistory.length === 0) {
        continue;
      }

      // Extract template
      const template = extractTemplate(task, taskHistory);
      templates.push(template);

      // Update category stats
      const stats = categoryStats[template.category];
      stats.count++;
      stats.avgSuccessRate += template.successRate;
      stats.avgCostUsd += template.avgCostUsd;
    } catch (err) {
      // Skip tasks that fail to parse
      console.warn(`[template-registry] Failed to process ${file}:`, err);
    }
  }

  // Compute category averages
  for (const category of categories) {
    const stats = categoryStats[category];
    if (stats.count > 0) {
      stats.avgSuccessRate /= stats.count;
      stats.avgCostUsd /= stats.count;
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    templates,
    categoryStats,
  };
}

/**
 * Loads a template registry from disk.
 *
 * @param projectRoot - The project root directory
 * @param registryPath - Relative path to registry file (default: ".quack/templates/task-templates.json")
 * @returns The loaded registry, or an empty registry if the file doesn't exist
 */
export async function loadRegistry(
  projectRoot: string,
  registryPath = ".quack/templates/task-templates.json",
): Promise<TemplateRegistry> {
  const fullPath = path.join(projectRoot, registryPath);

  try {
    const content = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(content) as TemplateRegistry;
  } catch (err) {
    // Return empty registry if file doesn't exist
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return createEmptyRegistry();
    }
    throw err;
  }
}

/**
 * Saves a template registry to disk.
 *
 * @param registry - The registry to save
 * @param projectRoot - The project root directory
 * @param registryPath - Relative path to registry file (default: ".quack/templates/task-templates.json")
 */
export async function saveRegistry(
  registry: TemplateRegistry,
  projectRoot: string,
  registryPath = ".quack/templates/task-templates.json",
  taskDir = "docs/tasks",
): Promise<void> {
  const absoluteTaskDir = path.join(projectRoot, taskDir);
  const sourceTaskIds = new Set(registry.templates.map((template) => template.sourceTaskId));
  for (const taskId of sourceTaskIds) {
    const claimants = await listDuplicateClaimants(absoluteTaskDir, taskId);
    if (claimants.length > 1) {
      throw new DuplicateClaimantAdmissionError({ taskId, claimants });
    }
  }

  const fullPath = path.join(projectRoot, registryPath);
  const dirPath = path.dirname(fullPath);

  // Ensure directory exists
  await fs.mkdir(dirPath, { recursive: true });

  // Write registry
  await fs.writeFile(fullPath, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Updates the template registry incrementally by adding a newly completed task.
 * Loads the existing registry, adds or replaces the template for the given task,
 * and recalculates category stats without rebuilding from scratch.
 *
 * @param projectRoot - The project root directory
 * @param taskId - The task ID to add
 * @param taskDir - Relative path to the task directory (default: "docs/tasks")
 * @param sessionLogPath - Path to the session log file (default: ".quack/logs/sessions.jsonl")
 * @param registryPath - Relative path to registry file
 */
export async function updateRegistry(
  projectRoot: string,
  taskId: string,
  taskDir = "docs/tasks",
  sessionLogPath = ".quack/logs/sessions.jsonl",
  registryPath = ".quack/templates/task-templates.json",
): Promise<void> {
  // Load existing registry
  const registry = await loadRegistry(projectRoot, registryPath);

  // Parse the specific task
  const absoluteTaskDir = path.join(projectRoot, taskDir);
  const resolved = await resolveTaskFile(absoluteTaskDir, taskId);
  if (!resolved) {
    throw new Error(`Task file not found for ${taskId}`);
  }
  const task = resolved.task ?? parseTaskFile(resolved.content, resolved.filePath);
  const claimants = await listDuplicateClaimants(absoluteTaskDir, task.id);
  if (claimants.length > 1) {
    throw new DuplicateClaimantAdmissionError({ taskId: task.id, claimants });
  }

  // Same resolution as buildRegistry, on the one task this call names.
  // Keyed on the PARSED id because that is the identity the dispatcher
  // writes task_status rows under, not the filename the caller happened
  // to pass.
  const runtimeState = loadTaskStateOverlay(projectRoot);
  warnIfRuntimeAuthorityDegraded(runtimeState, `updateRegistry(${taskId})`);
  const state = resolveTaskStateWithOverlay({
    taskId: task.id,
    specStatus: task.status,
    overlay: runtimeState.overlay,
  });

  if (!isCompleteStatus(state.status)) {
    // The authority is named because the answer can now differ from what
    // the operator reads in the markdown, and "status: REJECTED" with no
    // provenance would look like the spec file was misread.
    throw new Error(
      `Task ${taskId} is not COMPLETE (status: ${state.status}, authority: ${state.authority})`,
    );
  }

  // Load session history for this task
  const sessionLog = path.join(projectRoot, sessionLogPath);
  const allHistory = await loadSessionHistory(sessionLog);
  const taskHistory = allHistory.filter((s) => s.taskId === taskId);
  if (taskHistory.length === 0) {
    throw new Error(`No run history found for ${taskId}`);
  }

  // Extract new template
  const newTemplate = extractTemplate(task, taskHistory);

  // Remove existing template for this task (if any) and add the new one
  registry.templates = registry.templates.filter((t) => t.sourceTaskId !== taskId);
  registry.templates.push(newTemplate);

  // Recalculate category stats from all templates
  const categories: TaskCategory[] = [
    "new-module",
    "integration",
    "bug-fix",
    "refactor",
    "dashboard-feature",
    "api-endpoint",
    "testing",
    "configuration",
    "infrastructure",
  ];
  for (const category of categories) {
    const catTemplates = registry.templates.filter((t) => t.category === category);
    const count = catTemplates.length;
    registry.categoryStats[category] = {
      count,
      avgSuccessRate: count > 0 ? catTemplates.reduce((s, t) => s + t.successRate, 0) / count : 0,
      avgCostUsd: count > 0 ? catTemplates.reduce((s, t) => s + t.avgCostUsd, 0) / count : 0,
    };
  }

  registry.updatedAt = new Date().toISOString();
  await saveRegistry(registry, projectRoot, registryPath, taskDir);
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Surface a runtime store that EXISTS but could not be read.
 *
 * A missing database (`source === "absent"`) is the normal case for a
 * project that never dispatched, and spec fallback is the correct and
 * complete answer there. `degraded` is the other thing entirely: the
 * store is present, it was not readable, and every eligibility answer
 * below silently reverted to spec authority. From the outside that is
 * indistinguishable from a healthy build, which is exactly why it is
 * said out loud.
 *
 * This does not fail the build. The registry is a suggestion surface,
 * not a gate, so an unreadable database should not take template
 * rebuilds down with it. The cost of that choice is stated in the
 * message rather than left for someone to discover.
 *
 * `loadTaskStateOverlay` emits its own warning naming the path and the
 * underlying error; this one names the decision that was affected.
 */
function warnIfRuntimeAuthorityDegraded(load: TaskStateOverlayLoad, site: string): void {
  if (!load.degraded) return;
  console.warn(
    `[template-registry] ${site}: runtime authority unavailable (${load.source}): ` +
      `${load.error ?? "unknown"}; template eligibility fell back to spec status, ` +
      "so a run the store holds as REJECTED can still be admitted as a template",
  );
}

function hasErrorCode(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

async function listTaskFiles(tasksPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(tasksPath);
    return entries.filter((f) => f.match(/^TASK-\d+.*\.md$/));
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function loadSessionHistory(sessionLogPath: string): Promise<RunAnalysis[]> {
  try {
    const content = await fs.readFile(sessionLogPath, "utf-8");
    const lines = content.trim().split("\n");
    const sessions: RunAnalysis[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const session = JSON.parse(line) as RunAnalysis;
        sessions.push(session);
      } catch {
        // Skip malformed lines
      }
    }

    return sessions;
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function createEmptyRegistry(): TemplateRegistry {
  const categories: TaskCategory[] = [
    "new-module",
    "integration",
    "bug-fix",
    "refactor",
    "dashboard-feature",
    "api-endpoint",
    "testing",
    "configuration",
    "infrastructure",
  ];

  const categoryStats: TemplateRegistry["categoryStats"] = {} as TemplateRegistry["categoryStats"];
  for (const category of categories) {
    categoryStats[category] = { count: 0, avgSuccessRate: 0, avgCostUsd: 0 };
  }

  return {
    updatedAt: new Date().toISOString(),
    templates: [],
    categoryStats,
  };
}
