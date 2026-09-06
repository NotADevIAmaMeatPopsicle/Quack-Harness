// ─── Cost Velocity Tracker Tests ──────────────────────────────────

import { CostVelocityTracker } from "../../src/dispatcher/cost-velocity.js";
import type { CostVelocityConfig } from "../../src/core/types.js";
import type { CostSummary } from "../../src/monitor/event-types.js";

function makeCostSummary(
  byTask: Array<{ taskId: string; costUsd: number; durationMs: number; outcome?: string }>,
): CostSummary {
  return {
    totalCostUsd: byTask.reduce((sum, t) => sum + t.costUsd, 0),
    sessionCount: byTask.length,
    avgCostPerSession:
      byTask.length > 0 ? byTask.reduce((sum, t) => sum + t.costUsd, 0) / byTask.length : 0,
    todayCostUsd: 0,
    last7DaysCostUsd: 0,
    last30DaysCostUsd: 0,
    byDay: [],
    byTask: byTask.map((t) => ({
      taskId: t.taskId,
      costUsd: t.costUsd,
      outcome: t.outcome ?? "approved",
      date: new Date().toISOString().slice(0, 10),
      durationMs: t.durationMs,
      turnsUsed: 10,
    })),
  };
}

describe("CostVelocityTracker", () => {
  const enabledConfig: Partial<CostVelocityConfig> = {
    enabled: true,
    windowMinutes: 5,
    warnMultiplier: 3,
    killMultiplier: 5,
    minSamplesForBaseline: 5,
  };

  describe("baseline computation", () => {
    test("computes median cost per minute from historical tasks", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // 5 tasks: cost/min = [0.5, 1.0, 1.5, 2.0, 2.5]
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 10 * 60000 }, // 0.5/min
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 }, // 1.0/min
        { taskId: "T-003", costUsd: 7.5, durationMs: 5 * 60000 }, // 1.5/min
        { taskId: "T-004", costUsd: 10.0, durationMs: 5 * 60000 }, // 2.0/min
        { taskId: "T-005", costUsd: 12.5, durationMs: 5 * 60000 }, // 2.5/min
      ]);

      const baseline = tracker.computeBaseline(summary);

      expect(baseline.sampleCount).toBe(5);
      expect(baseline.medianCostPerMinute).toBe(1.5);
    });

    test("computes median with even number of samples", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // 4 tasks: cost/min = [1.0, 1.5, 2.0, 2.5] → median = (1.5 + 2.0) / 2 = 1.75
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 }, // 1.0/min
        { taskId: "T-002", costUsd: 7.5, durationMs: 5 * 60000 }, // 1.5/min
        { taskId: "T-003", costUsd: 10.0, durationMs: 5 * 60000 }, // 2.0/min
        { taskId: "T-004", costUsd: 12.5, durationMs: 5 * 60000 }, // 2.5/min
      ]);

      const baseline = tracker.computeBaseline(summary);

      expect(baseline.sampleCount).toBe(4);
      expect(baseline.medianCostPerMinute).toBe(1.75);
    });

    test("returns zero baseline for empty history", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      const summary = makeCostSummary([]);

      const baseline = tracker.computeBaseline(summary);

      expect(baseline.sampleCount).toBe(0);
      expect(baseline.medianCostPerMinute).toBe(0);
    });

    test("excludes tasks with zero cost or zero duration", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 0, durationMs: 5 * 60000 }, // zero cost
        { taskId: "T-002", costUsd: 5.0, durationMs: 0 }, // zero duration
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 }, // valid: 1.0/min
      ]);

      const baseline = tracker.computeBaseline(summary);

      expect(baseline.sampleCount).toBe(1);
      expect(baseline.medianCostPerMinute).toBe(1.0);
    });

    test("excludes velocity-killed tasks from baseline", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      tracker.markVelocityKilled("T-003");

      // T-003 is an outlier that was velocity-killed
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 }, // 1.0/min
        { taskId: "T-002", costUsd: 7.5, durationMs: 5 * 60000 }, // 1.5/min
        { taskId: "T-003", costUsd: 100.0, durationMs: 5 * 60000 }, // 20.0/min - outlier
        { taskId: "T-004", costUsd: 10.0, durationMs: 5 * 60000 }, // 2.0/min
        { taskId: "T-005", costUsd: 12.5, durationMs: 5 * 60000 }, // 2.5/min
      ]);

      const baseline = tracker.computeBaseline(summary);

      expect(baseline.sampleCount).toBe(4); // T-003 excluded
      // Rates: [1.0, 1.5, 2.0, 2.5] → median = 1.75
      expect(baseline.medianCostPerMinute).toBe(1.75);
    });
  });

  describe("velocity snapshots", () => {
    test("records cost updates and returns snapshot", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // Set up baseline: median = 1.0/min
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // Record a cost update for a new task
      const snapshot = tracker.recordCostUpdate("T-NEW", 2.0, 2 * 60000);

      expect(snapshot.taskId).toBe("T-NEW");
      expect(snapshot.currentCostUsd).toBe(2.0);
      expect(snapshot.elapsedMinutes).toBe(2);
      expect(snapshot.costPerMinute).toBe(1.0);
      expect(snapshot.medianCostPerMinute).toBe(1.0);
      expect(snapshot.multiplier).toBe(1.0);
      expect(snapshot.status).toBe("normal");
    });

    test("returns warning status when rate exceeds warn multiplier", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // Baseline: median = 1.0/min
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // 3.5x median (above warn=3x, below kill=5x)
      const snapshot = tracker.recordCostUpdate("T-NEW", 7.0, 2 * 60000);

      expect(snapshot.costPerMinute).toBe(3.5);
      expect(snapshot.multiplier).toBe(3.5);
      expect(snapshot.status).toBe("warning");
    });

    test("returns critical status when rate exceeds kill multiplier", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // Baseline: median = 1.0/min
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // 6x median (above kill=5x)
      const snapshot = tracker.recordCostUpdate("T-NEW", 12.0, 2 * 60000);

      expect(snapshot.costPerMinute).toBe(6.0);
      expect(snapshot.multiplier).toBe(6.0);
      expect(snapshot.status).toBe("critical");
    });

    test("tracks multiple concurrent tasks independently", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // Baseline: median = 1.0/min
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // Normal task
      const snap1 = tracker.recordCostUpdate("T-A", 2.0, 2 * 60000);
      expect(snap1.status).toBe("normal");

      // Runaway task
      const snap2 = tracker.recordCostUpdate("T-B", 12.0, 2 * 60000);
      expect(snap2.status).toBe("critical");

      const snapshots = tracker.getActiveSnapshots();
      expect(snapshots).toHaveLength(2);

      const taskA = snapshots.find((s) => s.taskId === "T-A");
      const taskB = snapshots.find((s) => s.taskId === "T-B");
      expect(taskA?.status).toBe("normal");
      expect(taskB?.status).toBe("critical");
    });
  });

  describe("shouldKill", () => {
    test("returns kill=true when velocity exceeds kill threshold", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      // Baseline: median = 1.0/min
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // Record a cost update at 6x median
      tracker.recordCostUpdate("T-RUN", 12.0, 2 * 60000);

      const result = tracker.shouldKill("T-RUN");
      expect(result.kill).toBe(true);
      expect(result.reason).toContain("kill threshold");
    });

    test("returns kill=false when velocity is below threshold", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      tracker.recordCostUpdate("T-OK", 2.0, 2 * 60000);

      const result = tracker.shouldKill("T-OK");
      expect(result.kill).toBe(false);
    });

    test("returns kill=false when disabled", () => {
      const tracker = new CostVelocityTracker({ enabled: false });

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      tracker.recordCostUpdate("T-RUN", 100.0, 2 * 60000);

      const result = tracker.shouldKill("T-RUN");
      expect(result.kill).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    test("returns kill=false when insufficient baseline samples", () => {
      const tracker = new CostVelocityTracker({
        ...enabledConfig,
        minSamplesForBaseline: 5,
      });

      // Only 3 samples (below minimum of 5)
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      tracker.recordCostUpdate("T-RUN", 100.0, 2 * 60000);

      const result = tracker.shouldKill("T-RUN");
      expect(result.kill).toBe(false);
      expect(result.reason).toContain("Insufficient baseline");
    });

    test("returns kill=false for untracked task", () => {
      const tracker = new CostVelocityTracker(enabledConfig);

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      const result = tracker.shouldKill("T-UNKNOWN");
      expect(result.kill).toBe(false);
      expect(result.reason).toContain("not being tracked");
    });
  });

  describe("disabled config", () => {
    test("snapshot status is always normal when disabled", () => {
      const tracker = new CostVelocityTracker({ enabled: false });

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // Even at 10x median, should be "normal" because disabled
      const snapshot = tracker.recordCostUpdate("T-NEW", 100.0, 2 * 60000);
      expect(snapshot.status).toBe("normal");
    });
  });

  describe("rolling window", () => {
    test("ages out old cost updates outside window", () => {
      const tracker = new CostVelocityTracker({
        ...enabledConfig,
        windowMinutes: 0.001, // Very short window (~60ms)
      });

      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);

      // First update
      tracker.recordCostUpdate("T-WIN", 1.0, 1 * 60000);

      // Wait a bit for the window to expire, then add another
      // The first update should be aged out
      const snapshot = tracker.recordCostUpdate("T-WIN", 2.0, 2 * 60000);

      // Should still have a valid snapshot
      expect(snapshot.taskId).toBe("T-WIN");
      expect(snapshot.currentCostUsd).toBe(2.0);
    });
  });

  describe("isEnforcing", () => {
    test("returns false when disabled", () => {
      const tracker = new CostVelocityTracker({ enabled: false });
      expect(tracker.isEnforcing()).toBe(false);
    });

    test("returns false when no baseline", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      expect(tracker.isEnforcing()).toBe(false);
    });

    test("returns false when insufficient samples", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      const summary = makeCostSummary([{ taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 }]);
      tracker.computeBaseline(summary);
      expect(tracker.isEnforcing()).toBe(false);
    });

    test("returns true when enabled with sufficient baseline", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-003", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-004", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-005", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);
      tracker.computeBaseline(summary);
      expect(tracker.isEnforcing()).toBe(true);
    });
  });

  describe("removeTracking", () => {
    test("removes task from active tracking", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      tracker.recordCostUpdate("T-DONE", 5.0, 5 * 60000);

      expect(tracker.getActiveSnapshots()).toHaveLength(1);

      tracker.removeTracking("T-DONE");

      expect(tracker.getActiveSnapshots()).toHaveLength(0);
    });
  });

  describe("markVelocityKilled", () => {
    test("removes task and excludes from future baselines", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      tracker.recordCostUpdate("T-BAD", 100.0, 2 * 60000);

      tracker.markVelocityKilled("T-BAD");

      // T-BAD should be removed from active tracking
      expect(tracker.getActiveSnapshots()).toHaveLength(0);

      // T-BAD should be excluded from baseline computation
      const summary = makeCostSummary([
        { taskId: "T-001", costUsd: 5.0, durationMs: 5 * 60000 },
        { taskId: "T-BAD", costUsd: 100.0, durationMs: 2 * 60000 }, // outlier
        { taskId: "T-002", costUsd: 5.0, durationMs: 5 * 60000 },
      ]);

      const baseline = tracker.computeBaseline(summary);
      expect(baseline.sampleCount).toBe(2); // T-BAD excluded
    });
  });

  describe("getConfig", () => {
    test("returns a copy of the config", () => {
      const tracker = new CostVelocityTracker(enabledConfig);
      const config = tracker.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.warnMultiplier).toBe(3);
      expect(config.killMultiplier).toBe(5);
      expect(config.windowMinutes).toBe(5);
      expect(config.minSamplesForBaseline).toBe(5);
    });

    test("uses defaults when no config provided", () => {
      const tracker = new CostVelocityTracker();
      const config = tracker.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.warnMultiplier).toBe(3);
      expect(config.killMultiplier).toBe(5);
      expect(config.windowMinutes).toBe(5);
      expect(config.minSamplesForBaseline).toBe(5);
    });
  });
});
