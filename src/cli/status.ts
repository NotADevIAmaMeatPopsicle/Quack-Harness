// ─── CLI: quack status ──────────────────────────────────────────────
// Show task backlog summary: counts by status and priority,
// and list eligible (unblocked) tasks.

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import {
  parseAllTasks,
  isTaskEligible,
  loadStatusOverlay,
} from "../dispatcher/dependency-resolver.js";
import type { TaskSummary } from "../dispatcher/dependency-resolver.js";
import type { TaskPriority, TaskStatus } from "../core/types.js";

// ─── Formatting helpers ───────────────────────────────────────────

const PRIORITY_ORDER: TaskPriority[] = ["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"];

const STATUS_ORDER: TaskStatus[] = [
  "IN_PROGRESS",
  "READY",
  "BACKLOG",
  "BLOCKED",
  "ON_HOLD",
  "DECOMPOSED",
  "VERIFYING",
  "COMPLETE",
  "VERIFIED",
  "REJECTED",
];

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Main status handler ────────────────────────────────────────────

export async function statusCommand(options: { project?: string }): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  try {
    const adapter = await loadAdapter(projectPath);
    const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

    console.log(`\nQuack Status — ${adapter.config.project.name}\n${"=".repeat(40)}\n`);
    const canonicalBaseUrl = process.env.QUACK_BASE_URL;
    console.log("State authority: local spec/cache view only");
    console.log(
      canonicalBaseUrl
        ? `Canonical shared state: ${canonicalBaseUrl}/api/tasks`
        : "Canonical shared state: use the Headnode monitor API, not this local DB/spec view",
    );
    console.log();

    // TASK-1202: statuses honor DB task_status over spec Status: lines.
    const statusOverlay = loadStatusOverlay(adapter.projectRoot);
    if (statusOverlay) {
      console.log(
        `Status overlay: .quack/quack.db (${statusOverlay.size} rows; db wins over spec)\n`,
      );
    }

    const { tasks, errors } = await parseAllTasks(taskDir, { statusOverlay });

    if (tasks.size === 0 && errors.length === 0) {
      console.log(`No tasks found in ${taskDir}`);
      process.exit(0);
    }

    // Count by status
    const statusCounts = new Map<TaskStatus, number>();
    for (const task of tasks.values()) {
      const count = statusCounts.get(task.status) ?? 0;
      statusCounts.set(task.status, count + 1);
    }

    // Count by priority
    const priorityCounts = new Map<TaskPriority, number>();
    for (const task of tasks.values()) {
      const count = priorityCounts.get(task.task.priority) ?? 0;
      priorityCounts.set(task.task.priority, count + 1);
    }

    // Summary
    console.log(`Total tasks: ${tasks.size}\n`);

    // Status breakdown
    console.log("By status:");
    for (const status of STATUS_ORDER) {
      const count = statusCounts.get(status);
      if (count && count > 0) {
        console.log(`  ${padRight(status, 14)} ${count}`);
      }
    }
    console.log();

    // TASK-1202: surface db/spec disagreements instead of silently overriding.
    const TERMINAL_STATUSES = new Set<TaskStatus>(["COMPLETE", "VERIFIED", "REJECTED"]);
    const drifted = [...tasks.values()].filter(
      (t) => t.statusSource === "db" && t.specStatus !== undefined && t.status !== t.specStatus,
    );
    if (drifted.length > 0) {
      console.log("Status drift (db wins over spec):");
      for (const t of drifted) {
        const staleTerminalRow =
          TERMINAL_STATUSES.has(t.status) && !TERMINAL_STATUSES.has(t.specStatus as TaskStatus);
        console.log(`  ${padRight(t.id, 12)} ${t.status} (db; spec says ${t.specStatus})`);
        if (staleTerminalRow) {
          console.log(
            "               ^ stale terminal DB row? Update task_status via the monitor API or Headnode sqlite (docs/TROUBLESHOOTING.md).",
          );
        }
      }
      console.log();
    }

    // Priority breakdown
    console.log("By priority:");
    for (const priority of PRIORITY_ORDER) {
      const count = priorityCounts.get(priority);
      if (count && count > 0) {
        console.log(`  ${padRight(priority, 14)} ${count}`);
      }
    }
    console.log();

    // Find eligible tasks
    const eligible: TaskSummary[] = [];
    for (const task of tasks.values()) {
      if (isTaskEligible(task, tasks)) {
        eligible.push(task);
      }
    }

    if (eligible.length > 0) {
      console.log(`Eligible tasks (unblocked, BACKLOG): ${eligible.length}`);
      // Sort by priority
      eligible.sort((a, b) => {
        const aIdx = PRIORITY_ORDER.indexOf(a.task.priority);
        const bIdx = PRIORITY_ORDER.indexOf(b.task.priority);
        return aIdx - bIdx;
      });

      for (const task of eligible) {
        const blockerNote =
          task.blockedBy.length > 0 ? ` (was blocked by: ${task.blockedBy.join(", ")})` : "";
        console.log(
          `  ${padRight(task.id, 12)} [${task.task.priority}] ${task.task.title}${blockerNote}`,
        );
      }
      console.log();
    } else {
      console.log("No eligible tasks (all BACKLOG tasks are blocked).\n");
    }

    // Show errors if any
    if (errors.length > 0) {
      console.log(`Parse errors (${errors.length}):`);
      for (const err of errors) {
        console.log(`  ${err.file}: ${err.error}`);
      }
      console.log();
    }

    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
