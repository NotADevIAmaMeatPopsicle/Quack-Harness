import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { TaskStatusRow } from "../db/types.js";
import { updateTaskStatus } from "../dispatcher/lifecycle-manager.js";
import { normalizeTaskStatus, type TaskStatus } from "../core/task-status.js";

export interface ParsedSpecStatus {
  status: TaskStatus | null;
  rawStatus: string | null;
  onHold: boolean;
  statusLine: string | null;
}

export interface SpecStatusDrift {
  taskId: string;
  dbStatus: string;
  specStatus: TaskStatus | null;
  specOnHold: boolean;
  specPath: string | null;
  reason: "missing_spec" | "missing_status_line" | "status_mismatch";
}

export interface ReconcileSpecStatusResult {
  totalStatuses: number;
  drift: SpecStatusDrift[];
  fixed: string[];
  failedToFix: string[];
  skippedOnHold: string[];
}

export interface ReconcileSpecStatusOptions {
  apply?: boolean;
}

const TASK_FILE_RE = /^(TASK-\d+(?:-[A-Z]+)?)(?=-|\.|$)/;

export function parseSpecStatus(content: string): ParsedSpecStatus {
  const statusLineMatch = content.match(/^\s*-\s*\*\*Status:\*\*\s*(.+)\s*$/im);
  const rawStatus = statusLineMatch?.[1]?.trim() ?? null;
  const onHoldMatch = content.match(/^\s*-\s*\*\*On Hold:\*\*\s*(.+)\s*$/im);
  const rawOnHold = onHoldMatch?.[1]?.trim().toLowerCase() ?? "";

  return {
    status: normalizeTaskStatus(rawStatus),
    rawStatus,
    onHold: rawOnHold === "true" || rawOnHold === "yes" || rawOnHold === "1",
    statusLine: statusLineMatch?.[0] ?? null,
  };
}

function shouldIgnoreOnHoldDrift(
  dbStatus: string,
  specStatus: TaskStatus | null,
  onHold: boolean,
): boolean {
  if (!onHold || dbStatus !== "ON_HOLD") {
    return false;
  }
  return specStatus === "READY" || specStatus === "BACKLOG";
}

async function buildTaskFileIndex(taskDir: string): Promise<Map<string, string>> {
  const entries = await fs.readdir(taskDir, { withFileTypes: true });
  const index = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const match = entry.name.match(TASK_FILE_RE);
    if (!match) continue;
    index.set(match[1].toUpperCase(), path.join(taskDir, entry.name));
  }

  return index;
}

export async function reconcileSpecStatuses(
  taskDir: string,
  statuses: TaskStatusRow[],
  options: ReconcileSpecStatusOptions = {},
): Promise<ReconcileSpecStatusResult> {
  const fileIndex = await buildTaskFileIndex(taskDir);
  const drift: SpecStatusDrift[] = [];
  const fixed: string[] = [];
  const failedToFix: string[] = [];
  const skippedOnHold: string[] = [];

  for (const row of statuses) {
    const taskId = row.task_id.toUpperCase();
    const specPath = fileIndex.get(taskId) ?? null;
    if (!specPath) {
      drift.push({
        taskId,
        dbStatus: row.status,
        specStatus: null,
        specOnHold: false,
        specPath: null,
        reason: "missing_spec",
      });
      continue;
    }

    const content = await fs.readFile(specPath, "utf-8");
    const parsed = parseSpecStatus(content);

    if (shouldIgnoreOnHoldDrift(row.status, parsed.status, parsed.onHold)) {
      skippedOnHold.push(taskId);
      continue;
    }

    if (!parsed.statusLine || !parsed.status) {
      drift.push({
        taskId,
        dbStatus: row.status,
        specStatus: parsed.status,
        specOnHold: parsed.onHold,
        specPath,
        reason: "missing_status_line",
      });
      continue;
    }

    if (parsed.status !== row.status) {
      drift.push({
        taskId,
        dbStatus: row.status,
        specStatus: parsed.status,
        specOnHold: parsed.onHold,
        specPath,
        reason: "status_mismatch",
      });
    }
  }

  if (options.apply) {
    for (const item of drift) {
      if (!item.specPath) {
        failedToFix.push(item.taskId);
        continue;
      }
      const updated = await updateTaskStatus(item.taskId, taskDir, item.dbStatus);
      if (updated) {
        fixed.push(item.taskId);
      } else {
        failedToFix.push(item.taskId);
      }
    }
  }

  drift.sort((a, b) => a.taskId.localeCompare(b.taskId));
  fixed.sort((a, b) => a.localeCompare(b));
  failedToFix.sort((a, b) => a.localeCompare(b));
  skippedOnHold.sort((a, b) => a.localeCompare(b));

  return {
    totalStatuses: statuses.length,
    drift,
    fixed,
    failedToFix,
    skippedOnHold,
  };
}
