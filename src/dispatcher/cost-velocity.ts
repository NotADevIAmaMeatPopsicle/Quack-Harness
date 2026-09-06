// ─── Cost Velocity Monitor ────────────────────────────────────────
// Tracks cost accumulation rate per active dispatch and compares
// against historical baselines to detect runaway agents.

import type { CostVelocityConfig } from "../core/types.js";
import type { CostSummary } from "../monitor/event-types.js";

export interface VelocitySnapshot {
  taskId: string;
  currentCostUsd: number;
  elapsedMinutes: number;
  costPerMinute: number;
  medianCostPerMinute: number;
  multiplier: number;
  status: "normal" | "warning" | "critical";
}

export interface VelocityBaseline {
  medianCostPerMinute: number;
  sampleCount: number;
}

interface ActiveTracking {
  taskId: string;
  startTime: number;
  costUpdates: Array<{ costUsd: number; timestamp: number }>;
  lastWarningEmitted: boolean;
}

const DEFAULT_CONFIG: CostVelocityConfig = {
  enabled: false,
  windowMinutes: 5,
  warnMultiplier: 3,
  killMultiplier: 5,
  minSamplesForBaseline: 5,
};

export class CostVelocityTracker {
  private config: CostVelocityConfig;
  private activeTracking: Map<string, ActiveTracking> = new Map();
  private baseline: VelocityBaseline | null = null;
  private excludedTaskIds: Set<string> = new Set();

  constructor(config?: Partial<CostVelocityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a cost update for an active dispatch.
   * Returns a snapshot with velocity analysis.
   */
  recordCostUpdate(taskId: string, costUsd: number, elapsedMs: number): VelocitySnapshot {
    let tracking = this.activeTracking.get(taskId);
    if (!tracking) {
      tracking = {
        taskId,
        startTime: Date.now() - elapsedMs,
        costUpdates: [],
        lastWarningEmitted: false,
      };
      this.activeTracking.set(taskId, tracking);
    }

    tracking.costUpdates.push({
      costUsd,
      timestamp: Date.now(),
    });

    // Age out old updates outside the rolling window
    const windowMs = this.config.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    tracking.costUpdates = tracking.costUpdates.filter((u) => u.timestamp >= cutoff);

    return this.computeSnapshot(taskId, costUsd, elapsedMs);
  }

  /**
   * Compute the historical baseline from completed task data.
   * Excludes tasks that were killed for velocity anomalies.
   */
  computeBaseline(costSummary: CostSummary): VelocityBaseline {
    const validTasks = costSummary.byTask.filter(
      (t) => t.durationMs > 0 && t.costUsd > 0 && !this.excludedTaskIds.has(t.taskId),
    );

    if (validTasks.length === 0) {
      this.baseline = { medianCostPerMinute: 0, sampleCount: 0 };
      return this.baseline;
    }

    const rates = validTasks.map((t) => t.costUsd / (t.durationMs / 60000)).sort((a, b) => a - b);

    const medianRate = median(rates);

    this.baseline = {
      medianCostPerMinute: medianRate,
      sampleCount: validTasks.length,
    };

    return this.baseline;
  }

  /**
   * Get the current baseline, or null if not yet computed.
   */
  getBaseline(): VelocityBaseline | null {
    return this.baseline;
  }

  /**
   * Get all active velocity snapshots.
   */
  getActiveSnapshots(): VelocitySnapshot[] {
    const snapshots: VelocitySnapshot[] = [];
    for (const tracking of this.activeTracking.values()) {
      const lastUpdate = tracking.costUpdates[tracking.costUpdates.length - 1];
      if (!lastUpdate) continue;

      const elapsedMs = Date.now() - tracking.startTime;
      snapshots.push(this.computeSnapshot(tracking.taskId, lastUpdate.costUsd, elapsedMs));
    }
    return snapshots;
  }

  /**
   * Check if a task's velocity exceeds the kill threshold.
   */
  shouldKill(taskId: string): { kill: boolean; reason: string } {
    if (!this.config.enabled) {
      return { kill: false, reason: "Velocity monitoring disabled" };
    }

    if (!this.baseline || this.baseline.sampleCount < this.config.minSamplesForBaseline) {
      return {
        kill: false,
        reason: `Insufficient baseline samples (${this.baseline?.sampleCount ?? 0}/${this.config.minSamplesForBaseline})`,
      };
    }

    if (this.baseline.medianCostPerMinute === 0) {
      return { kill: false, reason: "Baseline median is zero" };
    }

    const tracking = this.activeTracking.get(taskId);
    if (!tracking) {
      return { kill: false, reason: "Task not being tracked" };
    }

    const lastUpdate = tracking.costUpdates[tracking.costUpdates.length - 1];
    if (!lastUpdate) {
      return { kill: false, reason: "No cost data" };
    }

    const elapsedMs = Date.now() - tracking.startTime;
    const elapsedMinutes = elapsedMs / 60000;
    if (elapsedMinutes <= 0) {
      return { kill: false, reason: "No elapsed time" };
    }

    const costPerMinute = lastUpdate.costUsd / elapsedMinutes;
    const multiplier = costPerMinute / this.baseline.medianCostPerMinute;

    if (multiplier >= this.config.killMultiplier) {
      return {
        kill: true,
        reason: `Cost velocity ${multiplier.toFixed(1)}x exceeds kill threshold ${this.config.killMultiplier}x (${costPerMinute.toFixed(4)}/min vs median ${this.baseline.medianCostPerMinute.toFixed(4)}/min)`,
      };
    }

    return { kill: false, reason: "Within threshold" };
  }

  /**
   * Mark a task as velocity-killed so it's excluded from future baselines.
   */
  markVelocityKilled(taskId: string): void {
    this.excludedTaskIds.add(taskId);
    this.activeTracking.delete(taskId);
  }

  /**
   * Remove a task from active tracking (normal completion).
   */
  removeTracking(taskId: string): void {
    this.activeTracking.delete(taskId);
  }

  /**
   * Get the current config.
   */
  getConfig(): CostVelocityConfig {
    return { ...this.config };
  }

  /**
   * Check whether monitoring is enabled and has sufficient baseline.
   */
  isEnforcing(): boolean {
    return (
      this.config.enabled &&
      this.baseline !== null &&
      this.baseline.sampleCount >= this.config.minSamplesForBaseline &&
      this.baseline.medianCostPerMinute > 0
    );
  }

  private computeSnapshot(
    taskId: string,
    currentCostUsd: number,
    elapsedMs: number,
  ): VelocitySnapshot {
    const elapsedMinutes = elapsedMs / 60000;
    const costPerMinute = elapsedMinutes > 0 ? currentCostUsd / elapsedMinutes : 0;
    const medianCostPerMinute = this.baseline?.medianCostPerMinute ?? 0;

    let multiplier = 0;
    if (medianCostPerMinute > 0) {
      multiplier = costPerMinute / medianCostPerMinute;
    }

    let status: VelocitySnapshot["status"] = "normal";
    if (this.isEnforcing() && multiplier >= this.config.killMultiplier) {
      status = "critical";
    } else if (this.isEnforcing() && multiplier >= this.config.warnMultiplier) {
      status = "warning";
    }

    return {
      taskId,
      currentCostUsd,
      elapsedMinutes,
      costPerMinute,
      medianCostPerMinute,
      multiplier,
      status,
    };
  }
}

/**
 * Compute the median of a sorted array of numbers.
 */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
