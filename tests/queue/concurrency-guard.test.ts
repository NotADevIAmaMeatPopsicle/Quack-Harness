import { ConcurrencyGuard } from "../../src/queue/concurrency-guard";

describe("ConcurrencyGuard", () => {
  let guard: ConcurrencyGuard;

  beforeEach(() => {
    guard = new ConcurrencyGuard({
      maxConcurrent: 2,
      cooldownBetweenTasksMs: 1000,
      fleetBudgetUsd: 10,
    });
  });

  describe("canStart", () => {
    it("allows when all guards pass", () => {
      const result = guard.canStart(1);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("blocks when at max concurrent", () => {
      guard.onTaskStart();
      guard.onTaskStart();

      const result = guard.canStart(1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("concurrency_limit");
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it("blocks during cooldown period", () => {
      guard.onTaskStart();

      // Immediately after start, cooldown should block
      const result = guard.canStart(1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cooldown");
      expect(result.waitMs).toBeGreaterThan(0);
      expect(result.waitMs).toBeLessThanOrEqual(1000);
    });

    it("blocks when fleet budget exhausted", () => {
      guard.onTaskComplete(9);

      const result = guard.canStart(2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("fleet_budget_exhausted");
      expect(result.waitMs).toBe(0);
    });

    it("returns correct waitMs for cooldown", () => {
      guard.onTaskStart();

      const result = guard.canStart(1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cooldown");
      // waitMs should be close to cooldownBetweenTasksMs
      expect(result.waitMs).toBeGreaterThan(0);
      expect(result.waitMs).toBeLessThanOrEqual(1000);
    });

    it("allows when budget is zero (unlimited)", () => {
      const unlimitedGuard = new ConcurrencyGuard({
        maxConcurrent: 2,
        cooldownBetweenTasksMs: 0,
        fleetBudgetUsd: 0,
      });

      unlimitedGuard.onTaskComplete(999);
      const result = unlimitedGuard.canStart(100);
      expect(result.allowed).toBe(true);
    });
  });

  describe("onTaskStart / onTaskComplete", () => {
    it("onTaskStart increments running count", () => {
      guard.onTaskStart();
      const state = guard.getState();
      expect(state.runningCount).toBe(1);
    });

    it("onTaskComplete decrements running count and accumulates cost", () => {
      guard.onTaskStart();
      guard.onTaskStart();
      guard.onTaskComplete(3.5);

      const state = guard.getState();
      expect(state.runningCount).toBe(1);
      expect(state.totalSpentUsd).toBe(3.5);
    });

    it("budget tracking accumulates across tasks", () => {
      guard.onTaskComplete(2);
      guard.onTaskComplete(3);
      guard.onTaskComplete(4);

      const state = guard.getState();
      expect(state.totalSpentUsd).toBe(9);
    });

    it("running count does not go below zero", () => {
      guard.onTaskComplete(0);
      const state = guard.getState();
      expect(state.runningCount).toBe(0);
    });
  });

  describe("updateOptions", () => {
    it("updates configuration at runtime", () => {
      guard.updateOptions({ maxConcurrent: 5 });

      // Fill up to old max (2), should still allow
      guard.onTaskStart();
      guard.onTaskStart();

      // With old config this would block, but we updated to 5
      // Need to wait for cooldown though, so create new guard
      const freshGuard = new ConcurrencyGuard({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        fleetBudgetUsd: 0,
      });
      freshGuard.onTaskStart();

      let result = freshGuard.canStart(0);
      expect(result.allowed).toBe(false);

      freshGuard.updateOptions({ maxConcurrent: 3 });
      result = freshGuard.canStart(0);
      expect(result.allowed).toBe(true);
    });
  });

  describe("reset", () => {
    it("resets all state", () => {
      guard.onTaskStart();
      guard.onTaskStart();
      guard.onTaskComplete(5);

      guard.reset();

      const state = guard.getState();
      expect(state.runningCount).toBe(0);
      expect(state.lastStartTime).toBe(0);
      expect(state.totalSpentUsd).toBe(0);
    });
  });
});
