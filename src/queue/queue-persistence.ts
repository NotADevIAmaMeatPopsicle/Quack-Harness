// ─── Queue Persistence ─────────────────────────────────────────────
// JSONL append-only log for queue state persistence. Allows recovery
// after monitor restart. Compacts log when it grows too large.

import * as fs from "node:fs";
import * as path from "node:path";

import type { QueueItem, DispatchQueueConfig } from "./queue-types.js";

export type QueueEventType =
  | "task_enqueued"
  | "task_ready"
  | "task_started"
  | "task_awaiting_approval"
  | "task_resumed"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "task_skipped"
  | "task_stopped"
  | "task_unblocked"
  | "queue_started"
  | "queue_paused"
  | "queue_resumed"
  | "queue_stopped"
  | "queue_drained"
  | "config_updated";

export interface QueueEvent {
  ts: string;
  type: QueueEventType;
  taskId?: string;
  priority?: number;
  blockedBy?: string[];
  outcome?: string;
  costUsd?: number;
  durationMs?: number;
  reason?: string;
  config?: DispatchQueueConfig;
  /** TASK-1323 (round-2 F3): persisted so a monitor restart does not
   *  strip the enqueue-time options — before this, replay() rebuilt
   *  items with no dispatchOptions and recovered dispatches lost their
   *  stamped provenance (and parentTaskId/sharedBranchName) to the
   *  unattributed fallback. Absent on pre-1323 log lines. */
  dispatchOptions?: QueueItem["dispatchOptions"];
}

const MAX_LOG_LINES = 10000;

export class QueuePersistence {
  private logPath: string;
  private snapshotPath: string;

  constructor(logDir: string) {
    this.logPath = path.join(logDir, "dispatch-queue.jsonl");
    this.snapshotPath = path.join(logDir, "dispatch-queue-snapshot.json");
  }

  /**
   * Append an event to the JSONL log.
   */
  append(event: QueueEvent): void {
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(this.logPath, line, "utf-8");
  }

  /**
   * Read all events from the log.
   */
  readEvents(): QueueEvent[] {
    if (!fs.existsSync(this.logPath)) return [];

    const content = fs.readFileSync(this.logPath, "utf-8");
    const events: QueueEvent[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as QueueEvent);
      } catch {
        // Skip malformed lines
      }
    }

    return events;
  }

  /**
   * Replay events to reconstruct queue state.
   * Returns a map of taskId → QueueItem.
   *
   * TASK-1323 (round-2b C3): seeded from the compaction snapshot FIRST,
   * then log events apply on top. compact() empties the log after
   * snapshotting, and before this seed the snapshot was never read —
   * a compaction-then-restart lost the ENTIRE recovered queue state
   * (pre-existing; surfaced because it also broke the provenance
   * durability claim). Log events overwrite snapshot entries, so the
   * newest state always wins.
   */
  replay(): Map<string, QueueItem> {
    const events = this.readEvents();
    const items = this.loadSnapshot();

    for (const event of events) {
      if (!event.taskId) continue;

      switch (event.type) {
        case "task_enqueued": {
          items.set(event.taskId, {
            taskId: event.taskId,
            status: "queued",
            priority: event.priority ?? 99,
            blockedBy: event.blockedBy ?? [],
            enqueuedAt: event.ts,
            retryCount: 0,
            dispatchOptions: event.dispatchOptions,
          });
          break;
        }

        case "task_ready": {
          const item = items.get(event.taskId);
          if (item) item.status = "ready";
          break;
        }

        case "task_started": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "running";
            item.startedAt = event.ts;
          }
          break;
        }

        case "task_awaiting_approval": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "awaiting_approval";
            item.awaitingApprovalAt = event.ts;
          }
          break;
        }

        case "task_resumed": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "running";
            if (event.dispatchOptions) item.dispatchOptions = event.dispatchOptions;
          }
          break;
        }

        case "task_completed": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "completed";
            item.completedAt = event.ts;
            item.outcome = event.outcome;
            item.costUsd = event.costUsd;
            item.durationMs = event.durationMs;
          }
          break;
        }

        case "task_failed": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "failed";
            item.completedAt = event.ts;
            item.outcome = event.outcome;
            item.error = event.reason;
          }
          break;
        }

        case "task_blocked": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "blocked";
            item.blockedReason = event.reason;
            item.outcome = event.outcome;
          }
          break;
        }

        case "task_skipped": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "skipped";
            item.blockedReason = event.reason;
          }
          break;
        }

        case "task_stopped": {
          const item = items.get(event.taskId);
          if (item) {
            item.status = "stopped";
            item.completedAt = event.ts;
          }
          break;
        }

        case "task_unblocked": {
          const item = items.get(event.taskId);
          if (item && event.reason) {
            // Remove the completed dependency from blockedBy list
            const idx = item.blockedBy.indexOf(event.reason);
            if (idx >= 0) {
              item.blockedBy.splice(idx, 1);
            }
          }
          break;
        }
      }
    }

    // Reset "running" items to "queued" (child process is dead after restart)
    for (const item of items.values()) {
      if (item.status === "running") {
        item.status = "queued";
      }
    }

    return items;
  }

  /**
   * Seed state from the compaction snapshot, if one exists.
   * A corrupt snapshot degrades to log-only recovery rather than throwing.
   */
  private loadSnapshot(): Map<string, QueueItem> {
    const items = new Map<string, QueueItem>();
    if (!fs.existsSync(this.snapshotPath)) return items;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.snapshotPath, "utf-8")) as QueueItem[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.taskId === "string") {
            items.set(item.taskId, item);
          }
        }
      }
    } catch {
      // Corrupt snapshot — recover from the log alone.
    }
    return items;
  }

  /**
   * Compact the log by writing a snapshot and starting a new log.
   * Called when the log exceeds MAX_LOG_LINES.
   */
  compact(items: Map<string, QueueItem>): void {
    const lineCount = this.countLines();
    if (lineCount < MAX_LOG_LINES) return;

    // Write snapshot
    const snapshot = Array.from(items.values());
    fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

    // Archive old log
    const archivePath = this.logPath.replace(".jsonl", `-${Date.now()}.jsonl`);
    if (fs.existsSync(this.logPath)) {
      fs.renameSync(this.logPath, archivePath);
    }

    // Start fresh log
    fs.writeFileSync(this.logPath, "", "utf-8");
  }

  /**
   * Count lines in the current log file.
   */
  private countLines(): number {
    if (!fs.existsSync(this.logPath)) return 0;
    const content = fs.readFileSync(this.logPath, "utf-8");
    return content.split("\n").filter((line) => line.trim()).length;
  }

  /**
   * Clear all persisted state (for testing).
   */
  clear(): void {
    if (fs.existsSync(this.logPath)) {
      fs.unlinkSync(this.logPath);
    }
    if (fs.existsSync(this.snapshotPath)) {
      fs.unlinkSync(this.snapshotPath);
    }
  }
}
