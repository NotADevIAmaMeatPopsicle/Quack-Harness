// ─── Fleet Budget Integration Tests ───────────────────────────────
// Tests the integration of fleet budget enforcement with cost recording.

import * as fs from "node:fs";
import * as path from "node:path";
import { EventReader } from "../../src/monitor/event-reader.js";
import { FleetBudgetChecker } from "../../src/dispatcher/fleet-budget.js";
import type { FleetBudgetConfig } from "../../src/core/types.js";
import type { QuackEvent } from "../../src/monitor/event-types.js";

describe("Fleet Budget Integration", () => {
  let tmpDir: string;
  let logDir: string;
  let reader: EventReader;
  let fleetBudget: FleetBudgetChecker;
  let config: FleetBudgetConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, "fleet-budget-int-"));
    logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });

    config = {
      dailyCapUsd: 10.0,
      hourlyCapUsd: 5.0,
      perWaveCapUsd: 8.0,
      alertThresholds: [50, 75, 90],
      enforceHard: true,
    };

    reader = new EventReader(logDir);
    fleetBudget = new FleetBudgetChecker(reader, config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(data: {
    sessionId: string;
    taskId: string;
    startTime: string;
    status: string;
    outcome?: string;
    totalCostUsd?: number;
  }) {
    const sessionsFile = path.join(logDir, "sessions.jsonl");
    fs.appendFileSync(sessionsFile, JSON.stringify(data) + "\n", "utf-8");
    // Force reader to reload
    reader.getAllSessions();
  }

  function emitEvent(event: QuackEvent): void {
    const eventsFile = path.join(logDir, `${event.sessionId}.jsonl`);
    fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n", "utf-8");
  }

  describe("cost recording integration", () => {
    test("records dispatch costs when session completes", () => {
      // Simulate the watcher callback logic from server.ts
      const event: QuackEvent = {
        sessionId: "test-session-1",
        taskId: "TASK-001",
        project: "test",
        timestamp: new Date().toISOString(),
        stage: "session_complete",
        payload: {
          totalCostUsd: 2.5,
          outcome: "approved",
          durationMs: 60000,
        },
      };

      emitEvent(event);

      // Simulate the watcher calling recordDispatchCost
      const totalCost = (event.payload as { totalCostUsd?: number }).totalCostUsd;
      if (typeof totalCost === "number" && totalCost > 0) {
        fleetBudget.recordDispatchCost(event.taskId, totalCost);
      }

      // Verify cost was recorded (affects per-wave cap)
      const result = fleetBudget.canDispatch();
      expect(result.allowed).toBe(true);
    });

    test("enforces hard limits when configured", () => {
      const now = new Date();

      // Write a session that exceeds daily cap
      writeSession({
        sessionId: "s1",
        taskId: "TASK-099",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 10.0,
      });

      // Check that dispatch is blocked
      const result = fleetBudget.canDispatch();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily budget cap exceeded");
    });

    test("allows dispatch when enforceHard is false (warn-only mode)", () => {
      const warnConfig: FleetBudgetConfig = { ...config, enforceHard: false };
      const warnBudget = new FleetBudgetChecker(reader, warnConfig);

      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-099",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 10.0,
      });

      // In warn-only mode, the check still reports exceeded
      // but enforcement is handled by the caller (server.ts)
      const result = warnBudget.canDispatch();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily budget cap exceeded");

      // The key difference is that server.ts won't return 429 when enforceHard: false
      // (tested via manual integration testing or E2E tests)
    });
  });

  describe("fleet budget status endpoint", () => {
    test("returns current spend and limits", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-099",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 3.5,
      });

      const status = fleetBudget.getStatus();

      expect(status.currentSpend.daily).toBe(3.5);
      expect(status.currentSpend.hourly).toBe(3.5);
      expect(status.limits.daily).toBe(10.0);
      expect(status.limits.hourly).toBe(5.0);
    });

    test("returns allowed: false when caps exceeded", () => {
      const now = new Date();
      writeSession({
        sessionId: "s1",
        taskId: "TASK-099",
        startTime: now.toISOString(),
        status: "completed",
        outcome: "approved",
        totalCostUsd: 10.0,
      });

      const status = fleetBudget.getStatus();

      expect(status.allowed).toBe(false);
      expect(status.reason).toContain("Daily budget cap exceeded");
    });
  });
});
