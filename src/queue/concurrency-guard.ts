// ─── Concurrency Guard ─────────────────────────────────────────────
// Multi-layered pre-dispatch checks: concurrency limit, cooldown,
// fleet budget, fleet controller state. Returns whether a task can
// start and how long to wait if blocked.

export interface GuardOptions {
  maxConcurrent: number;
  cooldownBetweenTasksMs: number;
  fleetBudgetUsd: number;
}

export interface GuardState {
  runningCount: number;
  lastStartTime: number;
  totalSpentUsd: number;
}

export interface CanStartResult {
  allowed: boolean;
  reason?: string;
  waitMs?: number;
}

export class ConcurrencyGuard {
  private state: GuardState = {
    runningCount: 0,
    lastStartTime: 0,
    totalSpentUsd: 0,
  };

  constructor(private options: GuardOptions) {}

  /**
   * Check if a task can start. Returns blocking reason and wait time if not.
   */
  canStart(estimatedBudget: number = 0): CanStartResult {
    const now = Date.now();

    // 1. Concurrency limit
    if (this.state.runningCount >= this.options.maxConcurrent) {
      return {
        allowed: false,
        reason: "concurrency_limit",
        waitMs: 3000, // Poll every 3 seconds
      };
    }

    // 2. Cooldown
    if (this.state.lastStartTime > 0) {
      const elapsed = now - this.state.lastStartTime;
      if (elapsed < this.options.cooldownBetweenTasksMs) {
        return {
          allowed: false,
          reason: "cooldown",
          waitMs: this.options.cooldownBetweenTasksMs - elapsed,
        };
      }
    }

    // 3. Fleet budget
    if (this.options.fleetBudgetUsd > 0) {
      const projected = this.state.totalSpentUsd + estimatedBudget;
      if (projected >= this.options.fleetBudgetUsd) {
        return {
          allowed: false,
          reason: "fleet_budget_exhausted",
          waitMs: 0, // Pause indefinitely
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Notify guard that a task has started.
   */
  onTaskStart(): void {
    this.state.runningCount++;
    this.state.lastStartTime = Date.now();
  }

  /**
   * Notify guard that a task has completed.
   */
  onTaskComplete(costUsd: number = 0): void {
    if (this.state.runningCount > 0) {
      this.state.runningCount--;
    }
    this.state.totalSpentUsd += costUsd;
  }

  /**
   * Update configuration at runtime.
   */
  updateOptions(options: Partial<GuardOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current guard state (for debugging).
   */
  getState(): Readonly<GuardState> {
    return { ...this.state };
  }

  /**
   * Reset state (for testing or queue restart).
   */
  reset(): void {
    this.state = {
      runningCount: 0,
      lastStartTime: 0,
      totalSpentUsd: 0,
    };
  }
}
