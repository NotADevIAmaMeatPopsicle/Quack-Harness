// ─── Queue Module Exports ──────────────────────────────────────────

export { DispatchQueue } from "./dispatch-queue.js";
export { ConcurrencyGuard } from "./concurrency-guard.js";
export { QueuePersistence } from "./queue-persistence.js";
export { propagateFailure } from "./failure-propagator.js";

export type {
  QueueItem,
  QueueItemStatus,
  FailurePropagation,
  DispatchQueueConfig,
  QueueStats,
} from "./queue-types.js";

export type { QueueEventCallback } from "./dispatch-queue.js";
export type { FailurePropagationResult } from "./failure-propagator.js";
export type { GuardOptions, GuardState, CanStartResult } from "./concurrency-guard.js";
export type { QueueEventType, QueueEvent } from "./queue-persistence.js";
