// ─── Dispatch Queue ────────────────────────────────────────────────
// Main orchestrator for dependency-aware task queuing. Processes tasks
// in dependency order, runs independent tasks concurrently up to a limit,
// handles failure propagation, and persists state for crash recovery.

import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

import type { DispatchManager, StartOptions } from "../monitor/dispatch-manager.js";
import type { TaskService, TaskSessionInfo, TaskSummary } from "../monitor/task-service.js";
import type { EventReader } from "../monitor/event-reader.js";
import type { SessionEntry } from "../monitor/event-types.js";
import type { NoopDB, QuackDB } from "../db/index.js";
import type { QueueItem, DispatchQueueConfig, QueueStats } from "./queue-types.js";
import { ConcurrencyGuard } from "./concurrency-guard.js";
import { propagateFailure } from "./failure-propagator.js";
import { QueuePersistence } from "./queue-persistence.js";
import { MANUAL_TAGS } from "../dispatcher/model-router.js";
import { isTaskSuppressedFromAutomation } from "../core/task-hygiene.js";
import { isCompleteStatus } from "../core/task-status.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";
import {
  assertUncontestedClaimant,
  duplicateClaimantRefusal,
  DuplicateClaimantAdmissionError,
  type DuplicateClaimantCheck,
  type DuplicateClaimantRefusal,
} from "../core/duplicate-claimants.js";

// Map priority strings to numeric values
const PRIORITY_WEIGHT: Record<string, number> = {
  "P0-CRITICAL": 0,
  "P1-HIGH": 1,
  "P2-MEDIUM": 2,
  "P3-LOW": 3,
};

const POLL_INTERVAL_MS = 3000;
const DEFAULT_ESTIMATED_COST = 2.0; // Conservative estimate for budget checks

function normalizeTaskId(value: string): string {
  const match = value.match(/\bTASK-\d+(?:-[A-Z]+)?\b/);
  return match ? match[0] : value.trim();
}

// TASK-1317 S5: the private copy of this rule is gone; the shared one
// lives in core/task-status.ts. It accepts the same widened input this
// copy did, so every call site here behaves identically.

function resolveDependencies(
  rawDeps: string[],
  allTasks: TaskSummary[],
  completedQueueIds: ReadonlySet<string> = new Set<string>(),
): { unmet: string[]; satisfiers: string[] } {
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));
  const unmet: string[] = [];
  const satisfiers: string[] = [];

  for (const rawDepId of rawDeps) {
    const depId = normalizeTaskId(rawDepId);
    const dep = taskMap.get(depId);
    if ((dep && isCompleteStatus(dep.effectiveStatus)) || completedQueueIds.has(depId)) {
      satisfiers.push(depId);
      continue;
    }

    const subtaskPrefix = `${depId}-`;
    const subtaskIds = new Set(
      allTasks.filter((task) => task.id.startsWith(subtaskPrefix)).map((task) => task.id),
    );
    for (const completedId of completedQueueIds) {
      if (completedId.startsWith(subtaskPrefix)) subtaskIds.add(completedId);
    }
    if (subtaskIds.size > 0) {
      const incomplete = [...subtaskIds].filter((taskId) => {
        if (completedQueueIds.has(taskId)) return false;
        const task = taskMap.get(taskId);
        return !task || !isCompleteStatus(task.effectiveStatus);
      });
      if (incomplete.length === 0) {
        satisfiers.push(...subtaskIds);
        continue;
      }
      unmet.push(...incomplete);
      continue;
    }

    unmet.push(depId);
  }

  return {
    unmet: [...new Set(unmet)],
    satisfiers: [...new Set(satisfiers)],
  };
}

export interface QueueBatchItems extends Array<QueueItem> {
  refusals: DuplicateClaimantRefusal[];
}

interface RecoveryScanResult {
  available: boolean;
  reason?: string;
}

export type QueueEventCallback = (
  stage: string,
  taskId: string,
  payload: Record<string, unknown>,
) => void;

export class DispatchQueue extends EventEmitter {
  private items = new Map<string, QueueItem>();
  private guard: ConcurrencyGuard;
  private persistence: QueuePersistence;
  private running = false;
  private paused = false;
  private pauseReason?: string;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private startedAt?: string;
  private completedAt?: string;
  private recoveryScan?: Promise<RecoveryScanResult>;
  private recoveryScanUnavailableReason?: string;
  private dispatchChecks = new Set<string>();

  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly taskService: TaskService,
    private readonly eventReader: EventReader,
    private config: DispatchQueueConfig,
    logDir: string,
    private readonly onEvent?: QueueEventCallback,
    private readonly projectionDb?: QuackDB | NoopDB,
  ) {
    super();

    this.guard = new ConcurrencyGuard({
      maxConcurrent: config.maxConcurrent,
      cooldownBetweenTasksMs: config.cooldownBetweenTasksMs,
      fleetBudgetUsd: config.fleetBudgetUsd,
    });

    this.persistence = new QueuePersistence(logDir);

    // Recover state from persistent log
    if (config.persistState) {
      this.recoverState();
    }
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Enqueue a single task. Returns the created QueueItem.
   */
  enqueue(
    taskId: string,
    options?: StartOptions,
    claimantCheck?: DuplicateClaimantCheck,
  ): QueueItem {
    if (this.items.has(taskId)) {
      throw new Error(`Task ${taskId} is already in the queue`);
    }

    // Check if task is already running in DispatchManager
    const activeJob = this.dispatchManager.getActiveJob(taskId);
    if (activeJob) {
      throw new Error(`Task ${taskId} is already running outside the queue`);
    }

    assertUncontestedClaimant(claimantCheck);

    const item: QueueItem = {
      taskId,
      status: "queued",
      priority: 99, // Will be updated when we fetch task details
      blockedBy: [], // Will be populated below
      enrichmentPending: true,
      enqueuedAt: new Date().toISOString(),
      retryCount: 0,
      dispatchOptions: options,
    };

    this.items.set(taskId, item);

    // Fetch task details without blocking the route response. The pending
    // marker keeps lifecycle triggers from treating the provisional empty
    // blockedBy list as satisfied.
    this.beginEnrichment(item);

    if (this.config.persistState) {
      this.persistence.append({
        ts: item.enqueuedAt,
        type: "task_enqueued",
        taskId,
        priority: item.priority,
        blockedBy: item.blockedBy,
        dispatchOptions: item.dispatchOptions,
      });
    }

    this.emitQueueEvent("dispatch_queue_task_enqueued", taskId, {
      position: this.items.size,
      priority: item.priority,
    });

    // Auto-start if configured
    if (this.config.autoStartOnEnqueue && !this.running && !this.paused) {
      void this.start();
    } else if (this.running) {
      // Trigger processing to pick up new item
      this.scheduleNext();
    }

    return item;
  }

  /**
   * Enqueue multiple tasks. Returns array of created QueueItems.
   */
  enqueueMultiple(
    taskIds: string[],
    options?: StartOptions,
    claimantChecks?: ReadonlyMap<string, DuplicateClaimantCheck>,
  ): QueueBatchItems {
    const items = [] as unknown as QueueBatchItems;
    items.refusals = [];
    for (const taskId of taskIds) {
      const existing = this.items.get(taskId);
      if (existing) {
        items.push(existing);
        continue;
      }
      const claimantCheck = claimantChecks?.get(taskId);
      if (claimantCheck && claimantCheck.claimants.length > 1) {
        items.refusals.push(duplicateClaimantRefusal(claimantCheck));
        continue;
      }
      try {
        items.push(this.enqueue(taskId, options, claimantCheck));
      } catch (err) {
        if (err instanceof DuplicateClaimantAdmissionError) {
          items.refusals.push(
            duplicateClaimantRefusal({
              taskId: err.taskId,
              claimants: err.claimants,
            }),
          );
          continue;
        }
        // Skip already-queued tasks
        const existing = this.items.get(taskId);
        if (existing) {
          items.push(existing);
          continue;
        }
        throw err;
      }
    }
    return items;
  }

  /**
   * Enqueue a batch of subtasks with automatic dependency chaining.
   * Each subtask depends on the previous one in the array.
   * All subtasks share a single branch from the parent task.
   *
   * @param subtaskPlan - The decomposition plan with ordered subtasks
   * @param options - Optional start options
   * @returns Array of created QueueItems
   */
  enqueueSubtasks(
    subtaskPlan: { parentTaskId: string; subtasks: Array<{ id: string; dependsOn: string[] }> },
    options?: StartOptions,
    claimantChecks?: ReadonlyMap<string, DuplicateClaimantCheck>,
  ): QueueBatchItems {
    const items = [] as unknown as QueueBatchItems;
    items.refusals = [];
    const sharedBranchName = `quack/${subtaskPlan.parentTaskId}`;

    for (const subtask of subtaskPlan.subtasks) {
      const existing = this.items.get(subtask.id);
      if (existing) {
        items.push(existing);
        continue;
      }
      const subtaskOptions: StartOptions = {
        ...options,
        parentTaskId: subtaskPlan.parentTaskId,
        sharedBranchName,
      };
      const claimantCheck = claimantChecks?.get(subtask.id);
      if (claimantCheck && claimantCheck.claimants.length > 1) {
        items.refusals.push(duplicateClaimantRefusal(claimantCheck));
        continue;
      }
      items.push(this.enqueue(subtask.id, subtaskOptions, claimantCheck));
    }

    return items;
  }

  /**
   * Enqueue all eligible tasks (BACKLOG status, dependencies met).
   */
  async enqueueAllEligible(
    options?: StartOptions,
    claimantChecks?: ReadonlyMap<string, DuplicateClaimantCheck>,
  ): Promise<QueueBatchItems> {
    const sessions = this.buildSessionMap();
    const { tasks } = await this.taskService.listTasks(sessions);

    const eligible = tasks.filter((t) => {
      // Only BACKLOG tasks that aren't already queued/running
      if (t.effectiveStatus !== "BACKLOG") return false;
      const hasNonDuplicateSuppression = t.backlogHygiene
        ? t.backlogHygiene.reasons.some((reason) => reason.code !== "duplicate_id")
        : isTaskSuppressedFromAutomation(t);
      if (hasNonDuplicateSuppression) return false;
      if (this.items.has(t.id)) return false;
      if (this.dispatchManager.getActiveJob(t.id)) return false;

      // Skip manual tasks — they require interactive sessions
      if (t.tags.some((tag) => MANUAL_TAGS.includes(tag.toLowerCase()))) return false;

      // Check dependencies
      for (const depId of t.blockedBy) {
        const dep = tasks.find((d) => d.id === depId);
        if (!dep || !isCompleteStatus(dep.effectiveStatus)) {
          return false;
        }
      }

      return true;
    });

    const ids = [...new Set(eligible.map((task) => task.id))];
    const checks = claimantChecks ?? (await this.scanDuplicateClaimants(ids));
    return this.enqueueMultiple(ids, options, checks);
  }

  async scanDuplicateClaimants(
    taskIds: readonly string[],
  ): Promise<Map<string, DuplicateClaimantCheck>> {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) return new Map();
    const taskDir = this.taskService.getTaskDirectory();
    const entries = await Promise.all(
      uniqueTaskIds.map(
        async (taskId) =>
          [taskId, { taskId, claimants: await listDuplicateClaimants(taskDir, taskId) }] as const,
      ),
    );
    return new Map(entries);
  }

  async scanEnqueueClaimants(
    taskIds: readonly string[],
  ): Promise<Map<string, DuplicateClaimantCheck>> {
    return this.scanDuplicateClaimants(
      taskIds.filter(
        (taskId) => !this.items.has(taskId) && !this.dispatchManager.getActiveJob(taskId),
      ),
    );
  }

  /**
   * Start processing the queue.
   */
  async start(): Promise<void> {
    if (this.hasRecoveredPendingRows()) {
      const scan = await this.ensureRecoveryScan();
      if (!scan.available) return;
    }
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.pauseReason = undefined;
    this.startedAt = new Date().toISOString();

    if (this.config.persistState) {
      this.persistence.append({
        ts: this.startedAt,
        type: "queue_started",
        config: this.config,
      });
    }

    this.emitQueueEvent("dispatch_queue_started", "", {
      taskCount: this.items.size,
      config: this.config,
    });

    if (this.items.size === 0) {
      this.checkDrained();
      return;
    }
    await this.scheduleNextAfterReadiness();
  }

  /**
   * Pause the queue. Running tasks continue, but no new tasks start.
   */
  pause(reason?: string): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseReason = reason;

    if (this.config.persistState) {
      this.persistence.append({
        ts: new Date().toISOString(),
        type: "queue_paused",
        reason,
      });
    }

    // Cancel the loop timer
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    this.emitQueueEvent("dispatch_queue_paused", "", {
      reason: reason ?? "manual pause",
      stats: this.getStats(),
    });
  }

  /**
   * Resume from paused state.
   */
  async resume(): Promise<void> {
    if (this.hasRecoveredPendingRows()) {
      const scan = await this.ensureRecoveryScan();
      if (!scan.available) return;
    }
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = undefined;

    if (this.config.persistState) {
      this.persistence.append({
        ts: new Date().toISOString(),
        type: "queue_resumed",
      });
    }

    this.emitQueueEvent("dispatch_queue_resumed", "", {});

    if (this.running) {
      await this.scheduleNextAfterReadiness();
    }
  }

  /**
   * Stop processing. Wait for running tasks to complete, then stop.
   */
  stop(): void {
    this.running = false;
    this.paused = false;

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    if (this.config.persistState) {
      this.persistence.append({
        ts: new Date().toISOString(),
        type: "queue_stopped",
      });
    }

    this.emitQueueEvent("dispatch_queue_stopped", "", {
      stats: this.getStats(),
    });
  }

  /**
   * Abort immediately: stop queue and kill all running tasks.
   */
  abort(): void {
    this.running = false;
    this.paused = false;

    // Clear timers
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Stop all running tasks
    for (const [taskId, item] of this.items) {
      if (item.status === "running") {
        this.dispatchManager.stop(taskId);
        item.status = "stopped";
        item.completedAt = new Date().toISOString();

        if (this.config.persistState) {
          this.persistence.append({
            ts: item.completedAt,
            type: "task_stopped",
            taskId,
          });
        }
      }
    }

    this.emitQueueEvent("dispatch_queue_stopped", "", {
      stats: this.getStats(),
    });
  }

  /**
   * Cancel a queued task (remove from queue, stop if running).
   */
  cancel(taskId: string): boolean {
    const item = this.items.get(taskId);
    if (!item) return false;

    if (item.status === "running") {
      this.dispatchManager.stop(taskId);
      const timer = this.pollTimers.get(taskId);
      if (timer) {
        clearInterval(timer);
        this.pollTimers.delete(taskId);
      }
      this.guard.onTaskComplete(item.costUsd ?? 0);
    }

    item.status = "stopped";
    item.completedAt = new Date().toISOString();

    if (this.config.persistState) {
      this.persistence.append({
        ts: item.completedAt,
        type: "task_stopped",
        taskId,
      });
    }

    return true;
  }

  /**
   * Re-queue a failed task.
   */
  retry(taskId: string, claimantCheck?: DuplicateClaimantCheck): boolean {
    const item = this.items.get(taskId);
    if (!item || item.status !== "failed") return false;

    assertUncontestedClaimant(claimantCheck);

    item.status = "queued";
    item.retryCount++;
    item.error = undefined;
    item.outcome = undefined;

    if (this.config.persistState) {
      this.persistence.append({
        ts: new Date().toISOString(),
        type: "task_enqueued",
        taskId,
        priority: item.priority,
        blockedBy: item.blockedBy,
        dispatchOptions: item.dispatchOptions,
      });
    }

    if (this.running && !this.paused) {
      this.scheduleNext();
    }

    return true;
  }

  /**
   * Remove a task from the queue entirely.
   */
  remove(taskId: string): boolean {
    const item = this.items.get(taskId);
    if (!item) return false;

    // Can't remove running tasks — must cancel first
    if (item.status === "running") return false;

    this.items.delete(taskId);
    return true;
  }

  /**
   * Get a specific queue item.
   */
  getItem(taskId: string): QueueItem | undefined {
    return this.items.get(taskId);
  }

  /**
   * Get all queue items.
   */
  getItems(): QueueItem[] {
    return Array.from(this.items.values());
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    const items = Array.from(this.items.values());
    const stats: QueueStats = {
      total: items.length,
      queued: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      stopped: 0,
      recoveredPendingScan: 0,
      recoveryScanUnavailableReason: this.recoveryScanUnavailableReason,
      totalCostUsd: 0,
      totalDurationMs: 0,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };

    for (const item of items) {
      if (item.status === "recovered_pending_scan") {
        stats.recoveredPendingScan++;
      } else {
        stats[item.status]++;
      }
      stats.totalCostUsd += item.costUsd ?? 0;
      stats.totalDurationMs += item.durationMs ?? 0;
    }

    return stats;
  }

  /**
   * Check if queue is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if queue is paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Return the current pause reason, if the queue is paused.
   */
  getPauseReason(): string | undefined {
    return this.pauseReason;
  }

  /**
   * Return the current runtime queue configuration.
   */
  getConfig(): DispatchQueueConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<DispatchQueueConfig>): void {
    this.config = { ...this.config, ...config };

    this.guard.updateOptions({
      maxConcurrent: this.config.maxConcurrent,
      cooldownBetweenTasksMs: this.config.cooldownBetweenTasksMs,
      fleetBudgetUsd: this.config.fleetBudgetUsd,
    });

    if (this.config.persistState) {
      this.persistence.append({
        ts: new Date().toISOString(),
        type: "config_updated",
        config: this.config,
      });
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Main scheduling loop. Called whenever state changes.
   */
  private scheduleNext(): void {
    if (!this.running || this.paused) return;
    void this.scheduleNextAfterReadiness();
  }

  private async scheduleNextAfterReadiness(): Promise<void> {
    if (!this.running || this.paused) return;

    // 1. Update readiness: transition queued → ready if dependencies met
    await this.updateReadiness();

    // 2. Check if we can start a task
    const guardResult = this.guard.canStart(DEFAULT_ESTIMATED_COST);

    if (!guardResult.allowed) {
      if (guardResult.reason === "fleet_budget_exhausted") {
        this.pause("Fleet budget exhausted");
        return;
      }

      // Wait and retry
      this.loopTimer = setTimeout(() => {
        this.loopTimer = null;
        this.scheduleNext();
      }, guardResult.waitMs ?? POLL_INTERVAL_MS).unref();
      return;
    }

    // 3. Find highest-priority ready task
    const nextTask = this.selectNextTask();
    if (!nextTask) {
      // No ready tasks — check if queue is drained
      this.checkDrained();
      return;
    }

    // 4. Dispatch the task
    if (this.dispatchChecks.has(nextTask.taskId)) return;
    this.dispatchChecks.add(nextTask.taskId);
    await this.dispatchTask(nextTask);
  }

  /**
   * Update readiness of queued items. Transition to "ready" if all dependencies met.
   */
  private async updateReadiness(): Promise<void> {
    const sessions = this.buildSessionMap();
    const { tasks } = await this.taskService.listTasks(sessions, undefined, this.projectionDb);
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const completedQueueIds = new Set(
      [...this.items.values()]
        .filter((item) => item.status === "completed")
        .map((item) => item.taskId),
    );

    for (const item of this.items.values()) {
      const duplicateQuarantined = (item.duplicateBlockedBy?.length ?? 0) > 0;
      if (item.status !== "queued" && !(item.status === "blocked" && duplicateQuarantined)) {
        continue;
      }
      if (item.enrichmentPending) continue;

      const summary = taskMap.get(item.taskId);
      const dependencyState = summary
        ? resolveDependencies(summary.blockedBy, tasks, completedQueueIds)
        : this.resolveTrackedDependencies(item.blockedBy, sessions);

      const claimantIds = [
        ...new Set([...dependencyState.satisfiers, ...(item.duplicateBlockedBy ?? [])]),
      ];
      const claimantChecks = await this.scanDuplicateClaimants(claimantIds);
      const contested = claimantIds
        .map((id) => claimantChecks.get(id))
        .filter((check): check is DuplicateClaimantCheck =>
          Boolean(check && check.claimants.length > 1),
        );
      if (contested.length > 0) {
        item.blockedBy = [
          ...new Set([
            ...dependencyState.unmet,
            ...contested.map((check) => check.taskId).filter((taskId) => taskId !== item.taskId),
          ]),
        ];
        this.setDuplicateQuarantine(item, contested);
        continue;
      }

      if (duplicateQuarantined) {
        this.clearDuplicateQuarantine(item);
        if (item.status === "blocked") item.status = "queued";
      }

      item.blockedBy = dependencyState.unmet;
      if (dependencyState.unmet.length === 0) {
        item.status = "ready";

        if (this.config.persistState) {
          this.persistence.append({
            ts: new Date().toISOString(),
            type: "task_ready",
            taskId: item.taskId,
          });
        }

        this.emitQueueEvent("dispatch_queue_task_ready", item.taskId, {
          reason: "dependencies met",
        });
      }
    }
  }

  private resolveTrackedDependencies(
    dependencyIds: string[],
    sessions: Map<string, TaskSessionInfo>,
  ): { unmet: string[]; satisfiers: string[] } {
    const unmet: string[] = [];
    const satisfiers: string[] = [];
    for (const depId of dependencyIds) {
      const dep = this.items.get(depId);
      const session = sessions.get(depId);
      if (dep?.status === "completed" || session?.outcome === "approved") {
        satisfiers.push(depId);
      } else {
        unmet.push(depId);
      }
    }
    return { unmet, satisfiers };
  }

  /**
   * Select the highest-priority ready task.
   */
  private selectNextTask(): QueueItem | undefined {
    const ready = Array.from(this.items.values()).filter(
      (item) => item.status === "ready" && !item.enrichmentPending,
    );

    if (ready.length === 0) return undefined;

    // Sort by priority (lower number = higher priority), then by enqueue time
    ready.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
    });

    return ready[0];
  }

  /**
   * Dispatch a task via DispatchManager and watch for completion.
   */
  private async dispatchTask(item: QueueItem): Promise<void> {
    try {
      const dependencyState = await this.resolveCurrentDependencies(item.taskId);
      if (dependencyState.unmet.length > 0) {
        item.status = "queued";
        item.blockedBy = dependencyState.unmet;
        return;
      }

      const claimantIds = [item.taskId, ...dependencyState.satisfiers];
      const claimantChecks = await this.scanDuplicateClaimants(claimantIds);
      const contested = claimantIds
        .map((id) => claimantChecks.get(id))
        .filter((check): check is DuplicateClaimantCheck =>
          Boolean(check && check.claimants.length > 1),
        );
      if (contested.length > 0) {
        item.status = "blocked";
        item.blockedBy = [
          ...new Set([
            ...dependencyState.unmet,
            ...contested.map((check) => check.taskId).filter((taskId) => taskId !== item.taskId),
          ]),
        ];
        this.setDuplicateQuarantine(item, contested);
        this.emitQueueEvent("dispatch_queue_task_refused", item.taskId, {
          error: "duplicate_claimants",
          claimants: [...new Set(contested.flatMap((check) => check.claimants))],
          message: item.blockedReason,
          duplicateBlockedBy: item.duplicateBlockedBy,
        });
        return;
      }

      if (item.duplicateBlockedBy) this.clearDuplicateQuarantine(item);
      item.blockedBy = [];
      const claimantCheck = claimantChecks.get(item.taskId);
      assertUncontestedClaimant(claimantCheck);
      const dispatchOptions: StartOptions = {
        ...item.dispatchOptions,
        duplicateClaimantCheck: claimantCheck,
      };
      const job = this.dispatchManager.start(item.taskId, dispatchOptions, claimantCheck);

      item.status = "running";
      item.startedAt = new Date().toISOString();

      this.guard.onTaskStart();

      if (this.config.persistState) {
        this.persistence.append({
          ts: item.startedAt,
          type: "task_started",
          taskId: item.taskId,
        });
      }

      this.emitQueueEvent("dispatch_queue_task_started", item.taskId, {
        pid: job.pid,
      });

      // Poll for completion
      const pollTimer = setInterval(() => {
        void this.checkTaskCompletion(item.taskId);
      }, POLL_INTERVAL_MS).unref();

      this.pollTimers.set(item.taskId, pollTimer);

      // Schedule next task (for concurrent dispatch)
      this.scheduleNext();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DuplicateClaimantAdmissionError) {
        item.status = "blocked";
        this.setDuplicateQuarantine(item, [
          {
            taskId: err.taskId,
            claimants: err.claimants,
          },
        ]);
        this.emitQueueEvent("dispatch_queue_task_refused", item.taskId, {
          error: err.code,
          claimants: err.claimants,
          message: item.blockedReason,
          duplicateBlockedBy: item.duplicateBlockedBy,
        });
      } else {
        this.handleTaskFailure(item, msg, "dispatch_error");
      }
    } finally {
      this.dispatchChecks.delete(item.taskId);
    }
  }

  /**
   * Check if a running task has completed.
   */
  private async checkTaskCompletion(taskId: string): Promise<void> {
    const item = this.items.get(taskId);
    if (!item || item.status !== "running") return;

    const job = this.dispatchManager.getJob(taskId);
    if (!job || job.status === "running") return;

    // Task finished
    const timer = this.pollTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(taskId);
    }

    // Read session outcome
    const sessions = this.eventReader.getExecutionSessions();
    const session = sessions.find((s) => s.taskId === taskId);

    const costUsd = session?.totalCostUsd ?? 0;
    const durationMs = session?.durationMs ?? 0;
    const outcome = session?.outcome ?? (job.status === "completed" ? "completed" : "failed");

    this.guard.onTaskComplete(costUsd);

    if (outcome === "approved") {
      await this.handleTaskSuccess(item, outcome, costUsd, durationMs);
    } else if (outcome === "spec_changed") {
      this.handleTaskBlocked(item, this.specChangedReason(session), outcome, costUsd, durationMs);
    } else {
      this.handleTaskFailure(item, outcome, outcome, costUsd, durationMs);
    }

    // Schedule next task
    this.scheduleNext();
  }

  /**
   * Handle successful task completion.
   */
  private async handleTaskSuccess(
    item: QueueItem,
    outcome: string,
    costUsd: number,
    durationMs: number,
  ): Promise<void> {
    item.status = "completed";
    item.completedAt = new Date().toISOString();
    item.outcome = outcome;
    item.costUsd = costUsd;
    item.durationMs = durationMs;

    if (this.config.persistState) {
      this.persistence.append({
        ts: item.completedAt,
        type: "task_completed",
        taskId: item.taskId,
        outcome,
        costUsd,
        durationMs,
      });
    }

    this.emitQueueEvent("dispatch_queue_task_completed", item.taskId, {
      outcome,
      costUsd,
      durationMs,
    });

    // Unblock dependent tasks
    await this.unblockDependents(item.taskId);
  }

  /**
   * Handle task failure.
   */
  private handleTaskFailure(
    item: QueueItem,
    error: string,
    outcome: string,
    costUsd = 0,
    durationMs = 0,
  ): void {
    item.status = "failed";
    item.completedAt = new Date().toISOString();
    item.error = error;
    item.outcome = outcome;
    item.costUsd = costUsd;
    item.durationMs = durationMs;

    if (this.config.persistState) {
      this.persistence.append({
        ts: item.completedAt,
        type: "task_failed",
        taskId: item.taskId,
        outcome,
        reason: error,
      });
    }

    this.emitQueueEvent("dispatch_queue_task_failed", item.taskId, {
      error,
      willRetry: false,
    });

    // Apply failure propagation
    const result = propagateFailure(item.taskId, this.items, this.config.failurePropagation);

    // Block dependent tasks
    for (const taskId of result.blocked) {
      const dep = this.items.get(taskId);
      if (dep) {
        dep.status = "blocked";
        dep.blockedReason = `Upstream ${item.taskId} failed`;

        if (this.config.persistState) {
          this.persistence.append({
            ts: new Date().toISOString(),
            type: "task_blocked",
            taskId,
            reason: dep.blockedReason,
          });
        }

        this.emitQueueEvent("dispatch_queue_task_blocked", taskId, {
          blockedBy: item.taskId,
          reason: dep.blockedReason,
        });
      }
    }

    // Skip tasks (fail_fast mode)
    for (const taskId of result.skipped) {
      const dep = this.items.get(taskId);
      if (dep) {
        dep.status = "skipped";
        dep.blockedReason = result.reason;

        if (this.config.persistState) {
          this.persistence.append({
            ts: new Date().toISOString(),
            type: "task_skipped",
            taskId,
            reason: result.reason,
          });
        }
      }
    }

    // Pause on failure if configured
    if (this.config.pauseOnFailure) {
      this.pause(`Task ${item.taskId} failed`);
    }
  }

  /**
   * External-completion notification (TASK-1201): lets ledger writers that
   * complete a task OUTSIDE a queue-run dispatch (record-on-merge scanner,
   * backfill) refresh already-enqueued dependents. Queue items track
   * blockedBy internally and only react to queue events, not DB writes.
   */
  async notifyExternalCompletion(completedTaskId: string): Promise<void> {
    await this.unblockDependents(completedTaskId);
  }

  /**
   * Unblock tasks that were waiting on the completed task.
   */
  private async unblockDependents(completedTaskId: string): Promise<void> {
    const [claimantCheck] = (await this.scanDuplicateClaimants([completedTaskId])).values();
    if (claimantCheck && claimantCheck.claimants.length > 1) {
      for (const item of this.items.values()) {
        if (
          (item.status === "queued" || (item.duplicateBlockedBy?.length ?? 0) > 0) &&
          item.blockedBy.includes(completedTaskId)
        ) {
          await this.refreshDuplicateQuarantine(item, [completedTaskId]);
        }
      }
      return;
    }

    for (const item of this.items.values()) {
      if (item.status !== "queued" && (item.duplicateBlockedBy?.length ?? 0) === 0) continue;

      const idx = item.blockedBy.indexOf(completedTaskId);
      if (idx >= 0) {
        item.blockedBy.splice(idx, 1);
        const stillQuarantined = await this.refreshDuplicateQuarantine(
          item,
          (item.duplicateBlockedBy ?? []).filter((taskId) => taskId !== completedTaskId),
          true,
        );
        if (!stillQuarantined && item.status === "blocked") item.status = "queued";

        if (this.config.persistState) {
          this.persistence.append({
            ts: new Date().toISOString(),
            type: "task_unblocked",
            taskId: item.taskId,
            reason: completedTaskId,
          });
        }

        this.emitQueueEvent("dispatch_queue_task_unblocked", item.taskId, {
          unblockedBy: completedTaskId,
        });

        // Check if task is now ready
        if (item.blockedBy.length === 0 && !stillQuarantined) {
          item.status = "ready";

          if (this.config.persistState) {
            this.persistence.append({
              ts: new Date().toISOString(),
              type: "task_ready",
              taskId: item.taskId,
            });
          }

          this.emitQueueEvent("dispatch_queue_task_ready", item.taskId, {
            reason: `${completedTaskId} completed`,
          });
        }
      }
    }
  }

  /**
   * Check if queue is fully drained (no pending work).
   */
  private checkDrained(): void {
    const hasWork = Array.from(this.items.values()).some(
      (item) =>
        item.status === "recovered_pending_scan" ||
        item.status === "queued" ||
        item.status === "ready" ||
        item.status === "running",
    );

    if (!hasWork) {
      this.running = false;
      this.completedAt = new Date().toISOString();

      if (this.config.persistState) {
        this.persistence.append({
          ts: this.completedAt,
          type: "queue_drained",
        });
      }

      const stats = this.getStats();
      this.emitQueueEvent("dispatch_queue_drained", "", { stats });

      // Compact log if needed
      if (this.config.persistState) {
        this.persistence.compact(this.items);
      }
    }
  }

  private handleTaskBlocked(
    item: QueueItem,
    reason: string,
    outcome: string,
    costUsd: number,
    durationMs: number,
  ): void {
    item.status = "blocked";
    item.completedAt = new Date().toISOString();
    item.blockedReason = reason;
    item.outcome = outcome;
    item.costUsd = costUsd;
    item.durationMs = durationMs;

    if (this.config.persistState) {
      this.persistence.append({
        ts: item.completedAt,
        type: "task_blocked",
        taskId: item.taskId,
        outcome,
        reason,
      });
    }

    this.emitQueueEvent("dispatch_queue_task_blocked", item.taskId, {
      outcome,
      reason,
    });
  }

  private specChangedReason(session: SessionEntry | undefined): string {
    if (!session) return "spec_changed";
    const stale = this.eventReader
      .getSessionEvents(session.sessionId)
      .filter((event) => event.stage === "spec_identity_stale")
      .at(-1);
    const reason = (stale?.payload as { reason?: unknown } | undefined)?.reason;
    return typeof reason === "string" && reason.length > 0 ? reason : "spec_changed";
  }

  private async resolveCurrentDependencies(
    taskId: string,
  ): Promise<{ unmet: string[]; satisfiers: string[] }> {
    const sessions = this.buildSessionMap();
    const { tasks } = await this.taskService.listTasks(sessions, undefined, this.projectionDb);
    const summary = tasks.find((task) => task.id === taskId);
    if (summary) return resolveDependencies(summary.blockedBy, tasks);

    const task = await this.taskService.getTask(taskId);
    if (!task) return { unmet: [], satisfiers: [] };

    const unmet: string[] = [];
    const satisfiers: string[] = [];
    for (const rawDepId of task.blockedBy) {
      const depId = normalizeTaskId(rawDepId);
      const queuedDep = this.items.get(depId);
      const session = sessions.get(depId);
      if (queuedDep?.status === "completed" || session?.outcome === "approved") {
        satisfiers.push(depId);
      } else {
        unmet.push(depId);
      }
    }
    return { unmet, satisfiers };
  }

  private setDuplicateQuarantine(item: QueueItem, checks: DuplicateClaimantCheck[]): void {
    const contested = checks.filter((check) => check.claimants.length > 1);
    item.duplicateBlockedBy = [...new Set(contested.map((check) => check.taskId))];
    item.blockedReason = contested
      .map((check) => duplicateClaimantRefusal(check).message)
      .join(" ");
  }

  private clearDuplicateQuarantine(item: QueueItem): void {
    if (!item.duplicateBlockedBy) return;
    item.duplicateBlockedBy = undefined;
    item.blockedReason = undefined;
  }

  private async refreshDuplicateQuarantine(
    item: QueueItem,
    taskIds: string[],
    replace = false,
  ): Promise<boolean> {
    const ids = replace
      ? [...new Set(taskIds)]
      : [...new Set([...(item.duplicateBlockedBy ?? []), ...taskIds])];
    if (ids.length === 0) {
      this.clearDuplicateQuarantine(item);
      return false;
    }

    const claimantChecks = await this.scanDuplicateClaimants(ids);
    const contested = ids
      .map((id) => claimantChecks.get(id))
      .filter((check): check is DuplicateClaimantCheck =>
        Boolean(check && check.claimants.length > 1),
      );
    if (contested.length === 0) {
      this.clearDuplicateQuarantine(item);
      return false;
    }

    this.setDuplicateQuarantine(item, contested);
    return true;
  }

  /**
   * Enrich a queue item with task details (priority, blockedBy).
   */
  private beginEnrichment(item: QueueItem): void {
    void this.enrichTrackedItem(item).then(
      () => {
        if (this.running && !this.paused) this.scheduleNext();
      },
      (err: unknown) => {
        item.status = "blocked";
        item.blockedReason = err instanceof Error ? err.message : String(err);
        if (this.running && !this.paused) this.scheduleNext();
      },
    );
  }

  private async enrichTrackedItem(item: QueueItem): Promise<void> {
    item.enrichmentPending = true;
    try {
      await this.enrichQueueItem(item);
    } finally {
      item.enrichmentPending = false;
    }
  }

  private async enrichQueueItem(item: QueueItem): Promise<void> {
    const sessions = this.buildSessionMap();
    const { tasks } = await this.taskService.listTasks(sessions);
    const summary = tasks.find((task) => task.id === item.taskId);
    const task = summary ? undefined : await this.taskService.getTask(item.taskId);
    if (!summary && !task) return;

    item.priority = PRIORITY_WEIGHT[summary?.priority ?? task!.priority] ?? 99;

    // Only keep unmet dependencies. Prefer listTasks() because it includes
    // effective statuses from task files and prior approved sessions. The
    // readiness refresh applies the runtime DB overlay before any admission
    // decision, while this asynchronous enrichment remains conservative.
    let unmet: string[];
    if (summary) {
      const resolved = resolveDependencies(summary.blockedBy, tasks);
      const claimantChecks = await this.scanDuplicateClaimants(resolved.satisfiers);
      const contested = resolved.satisfiers
        .map((id) => claimantChecks.get(id))
        .filter((check): check is DuplicateClaimantCheck =>
          Boolean(check && check.claimants.length > 1),
        );
      unmet = [...new Set([...resolved.unmet, ...contested.map((check) => check.taskId)])];
      if (contested.length > 0) {
        this.setDuplicateQuarantine(item, contested);
      } else if (item.duplicateBlockedBy) {
        this.clearDuplicateQuarantine(item);
      }
    } else {
      unmet = [];
      for (const rawDepId of task!.blockedBy) {
        const depId = normalizeTaskId(rawDepId);

        // Check if already complete in queue
        const queuedDep = this.items.get(depId);
        if (queuedDep && queuedDep.status === "completed") continue;

        // Check if already complete via session
        const session = sessions.get(depId);
        if (session && session.outcome === "approved") continue;

        unmet.push(depId);
      }
    }

    item.blockedBy = unmet;

    // Transition to ready if no unmet dependencies
    if (unmet.length === 0 && item.status === "queued") {
      item.status = "ready";

      if (this.config.persistState) {
        this.persistence.append({
          ts: new Date().toISOString(),
          type: "task_ready",
          taskId: item.taskId,
        });
      }

      this.emitQueueEvent("dispatch_queue_task_ready", item.taskId, {
        reason: "no dependencies",
      });
    }
  }

  /**
   * Build a map of taskId → session info for dependency resolution.
   */
  private buildSessionMap(): Map<string, TaskSessionInfo> {
    const sessions = this.eventReader.getExecutionSessions();
    const map = new Map<string, TaskSessionInfo>();

    for (const session of sessions) {
      map.set(session.taskId, {
        outcome: session.outcome ?? session.status,
        costUsd: session.totalCostUsd ?? 0,
        status: session.status,
      });
    }

    return map;
  }

  /**
   * Recover queue state from persistent log.
   */
  private recoverState(): void {
    const items = this.persistence.replay();
    if (items.size === 0) return;

    this.items = items;

    // Replayed runnable rows stay inert until the strict claimant scan settles.
    for (const item of items.values()) {
      if (item.status === "queued" || item.status === "ready" || item.status === "running") {
        item.status = "recovered_pending_scan";
      }
    }

    void this.ensureRecoveryScan();

    this.emitQueueEvent("dispatch_queue_recovered", "", {
      recoveredCount: items.size,
    });
  }

  private hasRecoveredPendingRows(): boolean {
    return Array.from(this.items.values()).some((item) => item.status === "recovered_pending_scan");
  }

  private ensureRecoveryScan(): Promise<RecoveryScanResult> {
    if (this.recoveryScan) return this.recoveryScan;
    const scan = this.scanRecoveredRows();
    this.recoveryScan = scan;
    void scan.then(
      () => {
        if (this.recoveryScan === scan) this.recoveryScan = undefined;
      },
      () => {
        if (this.recoveryScan === scan) this.recoveryScan = undefined;
      },
    );
    return scan;
  }

  private async scanRecoveredRows(): Promise<RecoveryScanResult> {
    const taskDir = this.taskService.getTaskDirectory();
    try {
      const stat = await fs.stat(taskDir);
      if (!stat.isDirectory()) throw new Error("not a directory");
      await fs.access(taskDir, fsConstants.R_OK);
      const handle = await fs.opendir(taskDir);
      await handle.close();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = `Task directory unavailable for recovery scan: ${taskDir} (${detail})`;
      this.recoveryScanUnavailableReason = reason;
      this.emitQueueEvent("dispatch_queue_recovery_scan_unavailable", "", { reason });
      return { available: false, reason };
    }

    this.recoveryScanUnavailableReason = undefined;
    const pending = Array.from(this.items.values()).filter(
      (item) => item.status === "recovered_pending_scan",
    );
    const claimantChecks = await this.scanDuplicateClaimants(pending.map((item) => item.taskId));
    for (const item of pending) {
      const claimantCheck = claimantChecks.get(item.taskId);
      if (claimantCheck && claimantCheck.claimants.length > 1) {
        item.status = "blocked";
        this.setDuplicateQuarantine(item, [claimantCheck]);
        this.emitQueueEvent("dispatch_queue_task_refused", item.taskId, {
          error: "duplicate_claimants",
          claimants: claimantCheck.claimants,
          message: item.blockedReason,
          duplicateBlockedBy: item.duplicateBlockedBy,
        });
        continue;
      }
      item.status = "queued";
      if (item.duplicateBlockedBy) this.clearDuplicateQuarantine(item);
      await this.enrichTrackedItem(item);
    }
    return { available: true };
  }

  /**
   * Emit a queue event via the callback.
   */
  private emitQueueEvent(stage: string, taskId: string, payload: Record<string, unknown>): void {
    this.onEvent?.(stage, taskId, payload);
  }
}
