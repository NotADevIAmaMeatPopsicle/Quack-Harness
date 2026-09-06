export const TASK_STATUSES = [
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
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

export const TASK_STATUS_ALIASES: Readonly<Record<string, TaskStatus>> = {
  "ON-HOLD": "ON_HOLD",
  "ON HOLD": "ON_HOLD",
  INPROGRESS: "IN_PROGRESS",
  "IN PROGRESS": "IN_PROGRESS",
  "IN-PROGRESS": "IN_PROGRESS",
};

export function stripTaskStatusAnnotation(rawStatus: string): string {
  const trimmed = rawStatus.trim();
  const withSuffix = trimmed.match(/^([A-Za-z0-9_\-\s]+)\s*\(([^)]*)\)\s*$/);
  return (withSuffix ? withSuffix[1] : trimmed).trim().toUpperCase();
}

export function normalizeTaskStatus(rawStatus: string | null | undefined): TaskStatus | null {
  if (!rawStatus) return null;
  const base = stripTaskStatusAnnotation(rawStatus);
  const normalized = TASK_STATUS_ALIASES[base] ?? base;
  return TASK_STATUS_SET.has(normalized) ? normalized : null;
}

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUS_SET.has(value);
}

/**
 * "This dependency is satisfied." TASK-1317 S5: the single home for a
 * rule that was maintained as two byte-identical private copies, in
 * `dependency-resolver.ts` and `dispatch-queue.ts` — the two modules
 * that decide whether a dependency unblocks its dependents.
 *
 * The input is deliberately wider than `TaskStatus` because the two
 * former copies had different signatures (`TaskStatus` and
 * `string | undefined`) and both call sites must keep behaving exactly
 * as they did.
 *
 * NOT the same as `isTerminalTaskStatus`, which also counts `REJECTED`.
 * A rejected task is finished; a rejected DEPENDENCY must never satisfy
 * its dependents. Collapsing the two would silently unblock rejected
 * work, so `tests/core/task-state.test.ts` pins the distinction.
 */
export function isCompleteStatus(status: string | null | undefined): boolean {
  return status === "COMPLETE" || status === "VERIFIED";
}
