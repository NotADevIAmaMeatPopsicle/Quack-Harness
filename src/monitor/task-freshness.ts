// ─── Task Freshness Monitor ────────────────────────────────────────
// Detects stale directory reads on Windows by periodically comparing
// the on-disk file count (via fs.opendir()) against the last parsed
// task count. Also provides a fresh read path that bypasses any
// OS-level file descriptor caching.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type { ParsedTask } from "../core/types.js";
import type { TaskParseErrorInfo } from "./task-service.js";

const TASK_PATTERN = /^(?:TASK-\d+|SAURUS-REM-\d{3}).*\.md$/;

// ─── Fresh directory count ─────────────────────────────────────────
// Uses fs.opendir() to create a new directory handle, bypassing any
// process-level caching that can cause stale reads on Windows NTFS.

export async function freshDirectoryCount(
  dir: string,
  pattern: RegExp = TASK_PATTERN,
): Promise<number> {
  let count = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (pattern.test(entry.name)) count++;
    }
  } finally {
    // for-await auto-closes on normal completion, but ensure cleanup on error
    try {
      await handle?.close();
    } catch {
      // Already closed by for-await iteration
    }
  }
  return count;
}

// ─── Fresh read all tasks ──────────────────────────────────────────
// Opens a new directory handle and reads every matching file with a
// fresh file descriptor. Returns the same shape as TaskService.listTasks().

export async function freshReadAllTasks(dir: string): Promise<{
  tasks: ParsedTask[];
  parseErrors: TaskParseErrorInfo[];
  taskSources: Array<{ file: string; task: ParsedTask }>;
}> {
  const tasks: ParsedTask[] = [];
  const parseErrors: TaskParseErrorInfo[] = [];
  const taskSources: Array<{ file: string; task: ParsedTask }> = [];

  const fileNames: string[] = [];
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (TASK_PATTERN.test(entry.name)) {
        fileNames.push(entry.name);
      }
    }
  } finally {
    try {
      await handle?.close();
    } catch {
      // Already closed
    }
  }

  fileNames.sort();

  for (const fileName of fileNames) {
    const filePath = path.join(dir, fileName);
    try {
      // Open a new file descriptor for each read
      const fileHandle = await fs.open(filePath, "r");
      try {
        const content = await fileHandle.readFile({ encoding: "utf-8" });
        const parsed = parseTaskFile(content, filePath);
        tasks.push(parsed);
        taskSources.push({ file: fileName, task: parsed });
      } finally {
        await fileHandle.close();
      }
    } catch (err) {
      parseErrors.push({
        file: fileName,
        error: err instanceof TaskParseError ? err.message : String(err),
      });
    }
  }

  return { tasks, parseErrors, taskSources };
}

// ─── Periodic freshness monitor ────────────────────────────────────

export interface FreshnessMonitorOptions {
  taskDir: string;
  intervalMs?: number;
  getLastParsedCount: () => number;
  onDrift: (diskCount: number, parsedCount: number) => void;
}

export function startFreshnessMonitor(opts: FreshnessMonitorOptions): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const diskCount = await freshDirectoryCount(opts.taskDir);
        const parsedCount = opts.getLastParsedCount();
        if (diskCount !== parsedCount) {
          console.log(
            `[task-service] Stale directory detected: ${diskCount} on disk, ${parsedCount} parsed`,
          );
          opts.onDrift(diskCount, parsedCount);
        }
      } catch (err) {
        console.error("[task-freshness] Re-scan error:", err);
      }
    })();
  }, intervalMs);

  // Prevent timer from keeping Jest workers / the process alive
  timer.unref();

  return () => clearInterval(timer);
}

// ─── Startup validation ────────────────────────────────────────────
// Logs diagnostic counts on monitor startup to surface silent failures.

export async function startupValidation(dir: string): Promise<void> {
  let rawCount = 0;
  let matchedCount = 0;

  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      rawCount++;
      if (TASK_PATTERN.test(entry.name)) matchedCount++;
    }
  } catch {
    console.log(`[task-service] Startup scan: task directory not found: ${dir}`);
    return;
  } finally {
    try {
      await handle?.close();
    } catch {
      // Already closed
    }
  }

  const { tasks, parseErrors } = await freshReadAllTasks(dir);
  const parsedCount = tasks.length;
  const errorCount = parseErrors.length;

  console.log(
    `[task-service] Startup scan: ${rawCount} files in dir, ${matchedCount} matched regex, ${parsedCount} parsed OK, ${errorCount} parse errors`,
  );

  if (matchedCount < rawCount * 0.9) {
    console.log(
      `[task-service] WARNING: ${rawCount - matchedCount} files in task dir don't match supported task pattern (TASK-*.md or SAURUS-REM-*.md)`,
    );
  }

  if (parsedCount < matchedCount * 0.8) {
    console.log(`[task-service] WARNING: ${matchedCount - parsedCount} task files failed to parse`);
  }
}
