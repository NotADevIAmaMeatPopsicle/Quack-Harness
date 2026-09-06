// ─── Failure Propagator ────────────────────────────────────────────
// Handles dependency-aware failure propagation strategies when a task fails.
// Implements three modes: fail_fast, skip_dependents, continue_all.

import type { QueueItem, FailurePropagation } from "./queue-types.js";

export interface FailurePropagationResult {
  /** Items marked as blocked due to upstream failure */
  blocked: string[];
  /** Items marked as skipped (fail_fast mode) */
  skipped: string[];
  /** Reason string for logging */
  reason: string;
}

/**
 * Build a transitive closure of all tasks that depend on failedTaskId.
 * Returns a Set of task IDs that transitively depend on the failed task.
 */
function findAllDependents(failedTaskId: string, allItems: Map<string, QueueItem>): Set<string> {
  const dependents = new Set<string>();
  const queue: string[] = [failedTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const [id, item] of allItems) {
      // Skip already-processed items
      if (dependents.has(id)) continue;

      // Check if this item depends on current
      if (item.blockedBy.includes(current)) {
        dependents.add(id);
        queue.push(id);
      }
    }
  }

  return dependents;
}

/**
 * Apply failure propagation strategy when a task fails.
 * Returns the list of task IDs that should be blocked/skipped.
 */
export function propagateFailure(
  failedTaskId: string,
  allItems: Map<string, QueueItem>,
  strategy: FailurePropagation,
): FailurePropagationResult {
  switch (strategy) {
    case "fail_fast": {
      // Mark ALL remaining queued/ready items as skipped
      const skipped: string[] = [];
      for (const [id, item] of allItems) {
        if (id === failedTaskId) continue;
        if (item.status === "queued" || item.status === "ready") {
          skipped.push(id);
        }
      }
      return {
        blocked: [],
        skipped,
        reason: `fail_fast: ${failedTaskId} failed, skipping all remaining tasks`,
      };
    }

    case "skip_dependents": {
      // Find all tasks that transitively depend on the failed task
      const dependents = findAllDependents(failedTaskId, allItems);
      const blocked: string[] = [];

      for (const id of dependents) {
        const item = allItems.get(id);
        // Only block items that haven't started yet
        if (item && (item.status === "queued" || item.status === "ready")) {
          blocked.push(id);
        }
      }

      return {
        blocked,
        skipped: [],
        reason: `skip_dependents: ${failedTaskId} failed, blocking ${blocked.length} dependent task(s)`,
      };
    }

    case "continue_all": {
      // Don't block anything — treat failure as if task completed
      return {
        blocked: [],
        skipped: [],
        reason: `continue_all: ${failedTaskId} failed, continuing with remaining tasks`,
      };
    }

    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown failure propagation strategy: ${String(_exhaustive)}`);
    }
  }
}
