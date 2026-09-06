// ─── Fleet Budget Checker Tests ────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { EventReader } from "../../src/monitor/event-reader.js";
import { FleetBudgetChecker } from "../../src/dispatcher/fleet-budget.js";
import type { FleetBudgetConfig } from "../../src/core/types.js";
import type { SessionEntry } from "../../src/monitor/event-types.js";

describe("FleetBudgetChecker", () => {
  let tmpDir: string;
  let reader: EventReader;
  let config: FleetBudgetConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, "fleet-budget-test-"));
    const logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    reader = new EventReader(logDir);

    config = {
      dailyCapUsd: 25.0,
      hourlyCapUsd: 10.0,
      perWaveCapUsd: 15.0,
      alertThresholds: [50, 75, 90],
      enforceHard: true,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(session: SessionEntry) {
    const sessionsFile = path.join(tmpDir, "logs", "sessions.jsonl");
    fs.appendFileSync(sessionsFile, JSON.stringify(session) + "\n", "utf-8");
  }

  describe("canDispatch", () => {
    test("allows dispatch when no spend", () => {
      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend.daily).toBe(0);
      expect(result.currentSpend.hourly).toBe(0);
    });

    test("allows dispatch when spend below caps", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 2.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend.daily).toBe(2.0);
      expect(result.currentSpend.hourly).toBe(2.0);
    });

    test("excludes claimant diagnostics from budget and spend", () => {
      const now = new Date().toISOString();
      writeSession({
        sessionId: "execution",
        taskId: "TASK-001",
        project: "test",
        startTime: now,
        status: "completed",
        outcome: "approved",
        totalCostUsd: 2,
      });
      writeSession({
        sessionId: "quack-diagnostic-claimant-task-001-budget",
        taskId: "TASK-001",
        project: "test",
        startTime: now,
        status: "completed",
        outcome: "claimant_diagnostic",
        totalCostUsd: 100,
      });

      const result = new FleetBudgetChecker(reader, config).canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend).toMatchObject({ daily: 2, hourly: 2 });
    });

    test("blocks dispatch when daily cap exceeded", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 25.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily budget cap exceeded");
      expect(result.currentSpend.daily).toBe(25.0);
    });

    test("blocks dispatch when hourly cap exceeded", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 10.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Hourly budget cap exceeded");
      expect(result.currentSpend.hourly).toBe(10.0);
    });

    test("ignores sessions from previous days for daily cap", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: yesterday.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 20.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend.daily).toBe(0);
    });

    test("ignores sessions older than 1 hour for hourly cap", () => {
      const twoHoursAgo = new Date();
      twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: twoHoursAgo.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 8.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend.hourly).toBe(0);
    });

    test("ignores active sessions with zero cost", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "active",
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      expect(result.allowed).toBe(true);
      expect(result.currentSpend.daily).toBe(0);
    });
  });

  describe("checkAlertThresholds", () => {
    test("returns no alerts when spend is low", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 2.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const alerts = checker.checkAlertThresholds();

      expect(alerts).toHaveLength(0);
    });

    test("returns yellow alert at 50% threshold", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 12.5, // 50% of daily cap
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const alerts = checker.checkAlertThresholds();

      expect(alerts.length).toBeGreaterThan(0);
      const dailyAlert = alerts.find((a) => a.metric === "daily");
      expect(dailyAlert).toBeDefined();
      expect(dailyAlert?.level).toBe("yellow");
      expect(dailyAlert?.percentUsed).toBe(50);
    });

    test("returns orange alert at 75% threshold", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 18.75, // 75% of daily cap
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const alerts = checker.checkAlertThresholds();

      expect(alerts.length).toBeGreaterThan(0);
      const dailyAlert = alerts.find((a) => a.metric === "daily");
      expect(dailyAlert).toBeDefined();
      expect(dailyAlert?.level).toBe("orange");
    });

    test("returns red alert at 90% threshold", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 22.5, // 90% of daily cap
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const alerts = checker.checkAlertThresholds();

      expect(alerts.length).toBeGreaterThan(0);
      const dailyAlert = alerts.find((a) => a.metric === "daily");
      expect(dailyAlert).toBeDefined();
      expect(dailyAlert?.level).toBe("red");
    });

    test("returns alerts for both daily and hourly when both exceed thresholds", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 15.0, // 60% of daily, exceeded hourly
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const alerts = checker.checkAlertThresholds();

      expect(alerts.length).toBe(2);
      expect(alerts.find((a) => a.metric === "daily")).toBeDefined();
      expect(alerts.find((a) => a.metric === "hourly")).toBeDefined();
    });
  });

  describe("getStatus", () => {
    test("returns current status with limits", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: now.toISOString(),
        status: "completed",
        totalCostUsd: 5.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const status = checker.getStatus();

      expect(status.currentSpend.daily).toBe(5.0);
      expect(status.currentSpend.hourly).toBe(5.0);
      expect(status.limits.daily).toBe(25.0);
      expect(status.limits.hourly).toBe(10.0);
    });
  });

  describe("recordDispatchCost", () => {
    test("updates in-memory running totals", () => {
      const checker = new FleetBudgetChecker(reader, config);

      checker.recordDispatchCost("TASK-001", 2.5);
      checker.recordDispatchCost("TASK-002", 3.0);

      // Wave spend should be tracked in-memory
      const result = checker.canDispatch();
      expect(result.allowed).toBe(true);
    });

    test("blocks dispatch when per-wave cap exceeded", () => {
      const checker = new FleetBudgetChecker(reader, config);

      // Add costs up to the perWaveCapUsd (15.0)
      checker.recordDispatchCost("TASK-001", 7.0);
      checker.recordDispatchCost("TASK-002", 8.0);

      const result = checker.canDispatch();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Per-wave budget cap exceeded");
    });

    test("allows dispatch when wave spend just below cap", () => {
      const checker = new FleetBudgetChecker(reader, config);

      checker.recordDispatchCost("TASK-001", 7.0);
      checker.recordDispatchCost("TASK-002", 7.9);

      const result = checker.canDispatch();
      expect(result.allowed).toBe(true);
    });
  });

  describe("resetWave", () => {
    test("clears in-memory wave costs", () => {
      const checker = new FleetBudgetChecker(reader, config);

      checker.recordDispatchCost("TASK-001", 8.0);
      checker.recordDispatchCost("TASK-002", 8.0);

      let result = checker.canDispatch();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Per-wave budget cap exceeded");

      checker.resetWave();

      result = checker.canDispatch();
      expect(result.allowed).toBe(true);
    });
  });

  describe("midnight reset for daily cap", () => {
    test("excludes sessions from previous day at UTC midnight boundary", () => {
      const now = new Date();
      const utcMidnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
      );
      const justBeforeMidnight = new Date(utcMidnight.getTime() - 1000); // 1 second before midnight
      const justAfterMidnight = new Date(utcMidnight.getTime() + 1000); // 1 second after midnight

      // Session just before midnight on previous day
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: justBeforeMidnight.toISOString(),
        status: "completed",
        totalCostUsd: 20.0,
        durationMs: 60000,
      });

      // Session just after midnight on current day
      writeSession({
        sessionId: "s2",
        taskId: "TASK-002",
        project: "test",
        startTime: justAfterMidnight.toISOString(),
        status: "completed",
        totalCostUsd: 3.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      // Only current day's spend should count (if it's after midnight)
      if (now >= justAfterMidnight) {
        expect(result.currentSpend.daily).toBe(3.0);
      }
    });
  });

  describe("60-minute rolling window for hourly cap", () => {
    test("includes sessions within exact 60-minute window", () => {
      const now = new Date();
      const exactly59MinAgo = new Date(now.getTime() - 59 * 60 * 1000);
      const exactly61MinAgo = new Date(now.getTime() - 61 * 60 * 1000);

      // Session exactly 61 minutes ago (should be excluded)
      writeSession({
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: exactly61MinAgo.toISOString(),
        status: "completed",
        totalCostUsd: 5.0,
        durationMs: 60000,
      });

      // Session 59 minutes ago (should be included)
      writeSession({
        sessionId: "s3",
        taskId: "TASK-003",
        project: "test",
        startTime: exactly59MinAgo.toISOString(),
        status: "completed",
        totalCostUsd: 2.0,
        durationMs: 60000,
      });

      const checker = new FleetBudgetChecker(reader, config);
      const result = checker.canDispatch();

      // Should include only sessions from last 60 minutes (s3 = 2.0)
      // The 61-minute-old session should be excluded
      expect(result.currentSpend.hourly).toBe(2.0);
    });
  });
});
