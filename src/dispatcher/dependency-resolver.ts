// ─── Dependency Resolver ─────────────────────────────────────────────
// Reads all TASK-*.md files from the task directory, parses each to
// extract status and blockedBy fields, and determines which tasks are
// eligible for dispatch (status=BACKLOG, all blockedBy tasks COMPLETE).
//
// TASK-1202: eligibility honors the DB task_status over the spec Status:
// line when a status overlay is provided (db wins outright, mirroring the
// monitor projection at task-projection.ts:89). Without an overlay,
// behavior is byte-identical to the spec-file-only resolver.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type { ParsedTask, TaskStatus } from "../core/types.js";
import { isCompleteStatus } from "../core/task-status.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface TaskSummary {
  id: string;
  /** Effective status: the overlay (DB) value when present, else the spec value. */
  status: TaskStatus;
  /** Where `status` came from (TASK-1202). Absent means "file". */
  statusSource?: "file" | "db";
  /** The spec-file Status: value, kept for drift display (TASK-1202). */
  specStatus?: TaskStatus;
  blockedBy: string[];
  task: ParsedTask;
}

export interface DependencyResolution {
  eligible: TaskSummary[];
  blocked: TaskSummary[];
  errors: Array<{ file: string; error: string }>;
}

// TASK-1317 S5: the private copy of this rule is gone; the shared one
// lives in core/task-status.ts alongside the status union it guards.

// ─── Status overlay (TASK-1202) ─────────────────────────────────────

/** task_id -> DB task_status value. */
export type StatusOverlay = Map<string, string>;

export interface ResolveOptions {
  statusOverlay?: StatusOverlay | null;
}

// Lazy-load better-sqlite3 the same way quack-db.ts does, so the native
// addon is only required when an overlay read actually happens.
interface ReadonlySqliteDb {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
let _ReadonlyDatabase:
  | (new (
      dbPath: string,
      options: { readonly: boolean; fileMustExist: boolean },
    ) => ReadonlySqliteDb)
  | undefined;
function getReadonlyDatabase(): new (
  dbPath: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => ReadonlySqliteDb {
  if (!_ReadonlyDatabase) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    _ReadonlyDatabase = require("better-sqlite3");
  }
  if (!_ReadonlyDatabase) throw new Error("better-sqlite3 unavailable");
  return _ReadonlyDatabase;
}

/**
 * Read the task_status table from `<projectRoot>/.quack/quack.db`.
 * Returns null when the DB does not exist or cannot be read; the caller
 * falls back to spec-only statuses. Opens strictly READONLY with
 * fileMustExist — never via QuackDB, whose constructor runs migrations
 * and could mutate a live monitor's DB under a version-skewed CLI.
 */
export function loadStatusOverlay(projectRoot: string): StatusOverlay | null {
  const dbPath = path.join(projectRoot, ".quack", "quack.db");
  if (!fsSync.existsSync(dbPath)) return null;
  let db: ReadonlySqliteDb | undefined;
  try {
    const Database = getReadonlyDatabase();
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT task_id, status FROM task_status").all() as Array<{
      task_id?: unknown;
      status?: unknown;
    }>;
    const overlay: StatusOverlay = new Map();
    for (const row of rows) {
      if (typeof row.task_id === "string" && typeof row.status === "string") {
        overlay.set(row.task_id, row.status);
      }
    }
    return overlay;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[dependency-resolver] status overlay unavailable (${msg}); using spec statuses only`,
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function hasErrorCode(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

// ─── Main functions ─────────────────────────────────────────────────

/**
 * Discover all TASK-*.md files in the given directory.
 * Does NOT recurse into subdirectories.
 */
export async function discoverTaskFiles(taskDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(taskDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.startsWith("TASK-") || entry.name.startsWith("SAURUS-REM-")) &&
          entry.name.endsWith(".md"),
      )
      .map((entry) => path.join(taskDir, entry.name))
      .sort();
  } catch (err: unknown) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Parse all task files in a directory and build a summary map.
 * Errors parsing individual files are collected but do not stop processing.
 * When a status overlay is provided (TASK-1202), the DB value wins outright
 * over the spec Status: line, mirroring the monitor projection.
 */
export async function parseAllTasks(
  taskDir: string,
  options: ResolveOptions = {},
): Promise<{ tasks: Map<string, TaskSummary>; errors: Array<{ file: string; error: string }> }> {
  const files = await discoverTaskFiles(taskDir);
  const tasks = new Map<string, TaskSummary>();
  const errors: Array<{ file: string; error: string }> = [];
  const overlay = options.statusOverlay ?? null;

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseTaskFile(content, filePath);
      const overlaid = overlay?.get(parsed.id);
      tasks.set(parsed.id, {
        id: parsed.id,
        // DB statuses are written from the canonical enum set; the cast keeps
        // the summary type strict while letting the DB win.
        status: (overlaid as TaskStatus | undefined) ?? parsed.status,
        statusSource: overlaid !== undefined ? "db" : "file",
        specStatus: parsed.status,
        blockedBy: parsed.blockedBy,
        task: parsed,
      });
    } catch (err: unknown) {
      const message =
        err instanceof TaskParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      errors.push({ file: path.basename(filePath), error: message });
    }
  }

  return { tasks, errors };
}

/**
 * Check whether a task is eligible for dispatch:
 * - Status must be BACKLOG
 * - All blockedBy tasks must have status COMPLETE/VERIFIED
 */
export function isTaskEligible(task: TaskSummary, allTasks: Map<string, TaskSummary>): boolean {
  if (task.status !== "BACKLOG") {
    return false;
  }

  for (const depId of task.blockedBy) {
    const dep = allTasks.get(depId);
    if (!dep || !isCompleteStatus(dep.status)) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve dependencies across all tasks in the task directory.
 * Returns lists of eligible and blocked tasks, plus any parse errors.
 */
export async function resolveDependencies(
  taskDir: string,
  options: ResolveOptions = {},
): Promise<DependencyResolution> {
  const { tasks, errors } = await parseAllTasks(taskDir, options);

  const eligible: TaskSummary[] = [];
  const blocked: TaskSummary[] = [];

  for (const task of tasks.values()) {
    if (task.status !== "BACKLOG") {
      continue; // Skip non-BACKLOG tasks entirely
    }

    if (isTaskEligible(task, tasks)) {
      eligible.push(task);
    } else {
      blocked.push(task);
    }
  }

  return { eligible, blocked, errors };
}
