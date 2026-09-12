// ─── Queue Types ───────────────────────────────────────────────────
// Type definitions for the dependency-aware dispatch queue system.
// Defines queue item lifecycle, failure propagation modes, and queue stats.

import type { StartOptions } from "../monitor/dispatch-manager.js";

export type QueueItemStatus =
  | "recovered_pending_scan" // Replayed row awaiting strict claimant scan
  | "queued" // In queue, dependencies may not yet be met
  | "ready" // All dependencies met, waiting for concurrency slot
  | "running" // Currently dispatching
  | "awaiting_approval" // Dispatch paused at a blueprint or judge human gate
  | "completed" // Judge approved
  | "failed" // Agent error, judge reject, or gate failure
  | "blocked" // Upstream task failed, cannot proceed
  | "skipped" // Skipped due to failure propagation
  | "stopped"; // Manually stopped by operator

export type FailurePropagation =
  | "fail_fast" // Block ALL remaining tasks on any failure
  | "skip_dependents" // Block only direct dependents, continue independent tasks
  | "continue_all"; // Ignore failures, attempt all tasks regardless

export interface QueueItem {
  taskId: string;
  status: QueueItemStatus;
  priority: number; // Numeric (0=P0-CRITICAL, 3=P3-LOW)
  blockedBy: string[]; // Task IDs this depends on
  enqueuedAt: string;
  startedAt?: string;
  awaitingApprovalAt?: string;
  completedAt?: string;
  outcome?: string; // "approved", "rejected", "gate_failed", etc.
  costUsd?: number;
  durationMs?: number;
  retryCount: number;
  error?: string;
  blockedReason?: string;
  enrichmentPending?: boolean;
  duplicateBlockedBy?: string[];
  dispatchOptions?: StartOptions;
}

export interface DispatchQueueConfig {
  maxConcurrent: number; // Default: 1
  cooldownBetweenTasksMs: number; // Default: 5000 (avoid API acceleration limits)
  failurePropagation: FailurePropagation; // Default: "skip_dependents"
  fleetBudgetUsd: number; // 0 = defer to TASK-031 fleet budget
  pauseOnFailure: boolean; // Default: false (pause queue on any failure)
  persistState: boolean; // Default: true (JSONL event log)
  autoStartOnEnqueue: boolean; // Default: false
}

export interface QueueStats {
  total: number;
  queued: number;
  ready: number;
  running: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  blocked: number;
  skipped: number;
  stopped: number;
  recoveredPendingScan: number;
  recoveryScanUnavailableReason?: string;
  totalCostUsd: number;
  totalDurationMs: number;
  startedAt?: string;
  completedAt?: string;
}
