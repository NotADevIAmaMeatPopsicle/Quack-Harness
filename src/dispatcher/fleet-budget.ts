// ─── Fleet Budget Checker ──────────────────────────────────────────
// Enforces fleet-wide budget caps (daily, hourly, per-wave) across all
// concurrent dispatches. Aggregates costs from session logs and blocks
// new dispatches when caps are exceeded.

import type { EventReader } from "../monitor/event-reader.js";
import type { FleetBudgetConfig } from "../core/types.js";
import type { KeyManager } from "./key-manager.js";

export interface FleetBudgetStatus {
  allowed: boolean;
  reason?: string;
  currentSpend: {
    daily: number;
    hourly: number;
  };
  limits: {
    daily: number;
    hourly: number;
  };
}

export interface FleetBudgetAlert {
  level: string;
  metric: "daily" | "hourly";
  currentUsd: number;
  capUsd: number;
  percentUsed: number;
}

export class FleetBudgetChecker {
  private config: FleetBudgetConfig;
  private reader: EventReader;
  private inMemoryCosts: Map<string, number>; // taskId -> cost
  private waveDispatchCount: number; // Track dispatches in current wave
  private keyManager?: KeyManager;

  constructor(reader: EventReader, config: FleetBudgetConfig, keyManager?: KeyManager) {
    this.reader = reader;
    this.config = config;
    this.inMemoryCosts = new Map();
    this.waveDispatchCount = 0;
    this.keyManager = keyManager;
  }

  /**
   * Hot-reload the fleet budget config (e.g., when adapter.json changes).
   */
  updateConfig(config: FleetBudgetConfig): void {
    this.config = config;
  }

  /**
   * Check if a new dispatch is allowed based on fleet budget caps.
   * Returns allowed: false if daily, hourly, or per-wave cap would be exceeded.
   */
  canDispatch(): FleetBudgetStatus {
    const currentSpend = this.getCurrentSpend();
    const limits = {
      daily: this.config.dailyCapUsd,
      hourly: this.config.hourlyCapUsd,
    };

    // Check daily cap
    if (currentSpend.daily >= limits.daily) {
      return {
        allowed: false,
        reason: `Daily budget cap exceeded ($${currentSpend.daily.toFixed(2)} / $${limits.daily.toFixed(2)})`,
        currentSpend,
        limits,
      };
    }

    // Check hourly cap
    if (currentSpend.hourly >= limits.hourly) {
      return {
        allowed: false,
        reason: `Hourly budget cap exceeded ($${currentSpend.hourly.toFixed(2)} / $${limits.hourly.toFixed(2)})`,
        currentSpend,
        limits,
      };
    }

    // Check per-wave cap (aggregated in-memory costs for current wave)
    const waveSpend = this.getWaveSpend();
    if (waveSpend >= this.config.perWaveCapUsd) {
      return {
        allowed: false,
        reason: `Per-wave budget cap exceeded ($${waveSpend.toFixed(2)} / $${this.config.perWaveCapUsd.toFixed(2)})`,
        currentSpend,
        limits,
      };
    }

    return {
      allowed: true,
      currentSpend,
      limits,
    };
  }

  /**
   * Record the cost of a completed dispatch.
   * Updates in-memory running totals for wave tracking.
   * Optionally forwards cost to key manager for per-key tracking.
   */
  recordDispatchCost(taskId: string, costUsd: number, keyId?: string): void {
    this.inMemoryCosts.set(taskId, costUsd);
    this.waveDispatchCount++;
    if (keyId && this.keyManager) {
      this.keyManager.recordCost(keyId, costUsd);
    }
  }

  /**
   * Reset the wave counter (call when starting a new wave).
   */
  resetWave(): void {
    this.inMemoryCosts.clear();
    this.waveDispatchCount = 0;
  }

  /**
   * Get current fleet budget status (for dashboard display).
   */
  getStatus(): FleetBudgetStatus {
    return this.canDispatch();
  }

  /**
   * Check if any alert thresholds have been crossed.
   * Returns alerts for each metric that exceeds a threshold.
   */
  checkAlertThresholds(): FleetBudgetAlert[] {
    const currentSpend = this.getCurrentSpend();
    const alerts: FleetBudgetAlert[] = [];

    // Check daily thresholds
    const dailyPercent = (currentSpend.daily / this.config.dailyCapUsd) * 100;
    const dailyThreshold = this.getHighestCrossedThreshold(dailyPercent);
    if (dailyThreshold !== null) {
      alerts.push({
        level: this.getAlertLevel(dailyPercent),
        metric: "daily",
        currentUsd: currentSpend.daily,
        capUsd: this.config.dailyCapUsd,
        percentUsed: dailyPercent,
      });
    }

    // Check hourly thresholds
    const hourlyPercent = (currentSpend.hourly / this.config.hourlyCapUsd) * 100;
    const hourlyThreshold = this.getHighestCrossedThreshold(hourlyPercent);
    if (hourlyThreshold !== null) {
      alerts.push({
        level: this.getAlertLevel(hourlyPercent),
        metric: "hourly",
        currentUsd: currentSpend.hourly,
        capUsd: this.config.hourlyCapUsd,
        percentUsed: hourlyPercent,
      });
    }

    return alerts;
  }

  /**
   * Get the current spend for daily and hourly windows.
   */
  private getCurrentSpend(): { daily: number; hourly: number } {
    const sessions = this.reader.getExecutionSessions();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    let dailySpend = 0;
    let hourlySpend = 0;

    for (const session of sessions) {
      const cost = session.totalCostUsd ?? 0;
      if (cost <= 0 && session.status === "active") continue;

      const sessionDate = session.startTime.slice(0, 10);
      const sessionTime = new Date(session.startTime);

      // Daily window: all sessions from today (UTC)
      if (sessionDate === todayStr) {
        dailySpend += cost;
      }

      // Hourly window: rolling 60 minutes
      if (sessionTime >= oneHourAgo) {
        hourlySpend += cost;
      }
    }

    return { daily: dailySpend, hourly: hourlySpend };
  }

  /**
   * Get the highest threshold that has been crossed.
   */
  private getHighestCrossedThreshold(percentUsed: number): number | null {
    const crossed = this.config.alertThresholds.filter((t) => percentUsed >= t);
    return crossed.length > 0 ? Math.max(...crossed) : null;
  }

  /**
   * Map percent-used to alert severity level.
   */
  private getAlertLevel(percentUsed: number): string {
    if (percentUsed >= 90) return "red";
    if (percentUsed >= 75) return "orange";
    if (percentUsed >= 50) return "yellow";
    return "green";
  }

  /**
   * Get the total spend for the current wave (in-memory tracking).
   */
  private getWaveSpend(): number {
    let total = 0;
    for (const cost of this.inMemoryCosts.values()) {
      total += cost;
    }
    return total;
  }
}
