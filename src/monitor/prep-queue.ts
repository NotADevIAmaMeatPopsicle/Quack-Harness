// ─── Prep Queue ────────────────────────────────────────────────────
// Priority queue of task IDs for auto-prep processing.
// Supports configurable ordering: by priority, by ID, or by dependency chain.

import type { TaskSummary } from "./task-service.js";

type PriorityOrder = "priority_then_id" | "id_only" | "dependency_chain";

/** Map priority strings to numeric sort weight (lower = higher priority). */
const PRIORITY_WEIGHT: Record<string, number> = {
  "P0-CRITICAL": 0,
  "P1-HIGH": 1,
  "P2-MEDIUM": 2,
  "P3-LOW": 3,
};

/** Extract numeric ID from a task ID like "TASK-042". */
function numericId(id: string): number {
  const match = id.match(/\d+/);
  return match ? parseInt(match[0], 10) : Infinity;
}

export class PrepQueue {
  private queue: TaskSummary[] = [];
  private order: PriorityOrder = "priority_then_id";

  enqueue(tasks: TaskSummary[]): void {
    // Add only tasks not already in the queue
    const existing = new Set(this.queue.map((t) => t.id));
    for (const task of tasks) {
      if (!existing.has(task.id)) {
        this.queue.push(task);
        existing.add(task.id);
      }
    }
    this.sort();
  }

  dequeue(): TaskSummary | undefined {
    return this.queue.shift();
  }

  remove(taskId: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  peek(): TaskSummary | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  toArray(): string[] {
    return this.queue.map((t) => t.id);
  }

  clear(): void {
    this.queue = [];
  }

  setPriorityOrder(order: PriorityOrder): void {
    this.order = order;
    this.sort();
  }

  private sort(): void {
    switch (this.order) {
      case "priority_then_id":
        this.queue.sort((a, b) => {
          const pa = PRIORITY_WEIGHT[a.priority] ?? 99;
          const pb = PRIORITY_WEIGHT[b.priority] ?? 99;
          if (pa !== pb) return pa - pb;
          return numericId(a.id) - numericId(b.id);
        });
        break;

      case "id_only":
        this.queue.sort((a, b) => numericId(a.id) - numericId(b.id));
        break;

      case "dependency_chain":
        // Tasks with no blockers first, then by priority
        this.queue.sort((a, b) => {
          const aBlocked = a.blockedBy.length > 0 ? 1 : 0;
          const bBlocked = b.blockedBy.length > 0 ? 1 : 0;
          if (aBlocked !== bBlocked) return aBlocked - bBlocked;
          const pa = PRIORITY_WEIGHT[a.priority] ?? 99;
          const pb = PRIORITY_WEIGHT[b.priority] ?? 99;
          if (pa !== pb) return pa - pb;
          return numericId(a.id) - numericId(b.id);
        });
        break;
    }
  }
}
