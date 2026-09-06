// ─── Progress Detector Tests ──────────────────────────────────────

import { ProgressDetector, type StuckEvent } from "../../src/monitor/progress-detector.js";
import type { StuckDetectionConfig } from "../../src/core/types.js";
import type { QuackEvent } from "../../src/monitor/event-types.js";

function makeEvent(
  stage: QuackEvent["stage"],
  taskId: string,
  payload: Record<string, unknown> = {},
  sessionId = "session-1",
): QuackEvent {
  return {
    sessionId,
    taskId,
    project: "test",
    timestamp: new Date().toISOString(),
    stage,
    payload: payload as QuackEvent["payload"],
  };
}

describe("ProgressDetector", () => {
  const defaultConfig: Partial<StuckDetectionConfig> = {
    enabled: true,
    warningMinutes: 5,
    criticalMinutes: 10,
    killMinutes: 15,
    checkIntervalSeconds: 30,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("event processing", () => {
    test("starts tracking on session_start", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(
        makeEvent("session_start", "TASK-001", { model: "sonnet", maxTurns: 50, maxBudget: 5 }),
      );

      expect(detector.getTrackedCount()).toBe(1);
      const health = detector.getHealth("TASK-001");
      expect(health).not.toBeNull();
      expect(health!.turnCount).toBe(0);
      expect(health!.status).toBe("healthy");
    });

    test("increments turn count on agent_turn", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("agent_turn", "TASK-001", {
          turnNumber: 1,
          role: "assistant",
          contentPreview: "Starting work",
        }),
      );
      detector.processEvent(
        makeEvent("agent_turn", "TASK-001", {
          turnNumber: 2,
          role: "assistant",
          contentPreview: "Editing file",
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.turnCount).toBe(2);
    });

    test("tracks tool usage on agent_tool_use", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("agent_tool_use", "TASK-001", {
          toolName: "Edit",
          filePath: "src/foo.ts",
          turnNumber: 1,
        }),
      );
      detector.processEvent(
        makeEvent("agent_tool_use", "TASK-001", {
          toolName: "Write",
          filePath: "src/bar.ts",
          turnNumber: 1,
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.toolUseCount).toBe(2);
      expect(health!.lastActivity?.type).toBe("tool_use");
      expect(health!.lastActivity?.detail).toContain("Write");
    });

    test("updates cost on agent_complete", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("agent_complete", "TASK-001", {
          totalCostUsd: 2.5,
          turnsUsed: 15,
          outcome: "success",
          filesModified: [],
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.cumulativeCostUsd).toBe(2.5);
      expect(health!.turnCount).toBe(15);
    });

    test("removes tracking on session_complete", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      expect(detector.getTrackedCount()).toBe(1);

      detector.processEvent(
        makeEvent("session_complete", "TASK-001", {
          outcome: "approved",
          durationMs: 60000,
          totalCostUsd: 2.0,
        }),
      );
      expect(detector.getTrackedCount()).toBe(0);
      expect(detector.getHealth("TASK-001")).toBeNull();
    });

    test("removes tracking on session_error", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("session_error", "TASK-001", { error: "boom", failedStage: "agent" }),
      );

      expect(detector.getTrackedCount()).toBe(0);
    });

    test("auto-starts tracking if event arrives without session_start", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("agent_turn", "TASK-001", { turnNumber: 1 }));

      expect(detector.getTrackedCount()).toBe(1);
      const health = detector.getHealth("TASK-001");
      expect(health!.turnCount).toBe(1);
    });

    test("ignores events without taskId", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", ""));

      expect(detector.getTrackedCount()).toBe(0);
    });

    // TASK-833: blueprint generation is a silent multi-minute LLM call.
    // Without these activity records, getHealth() reports the gate
    // checkpoint as last activity during the entire blueprint window
    // and stuck-detection cannot distinguish "blueprint working" from
    // "dispatch hung."
    test("records blueprint_start as blueprint_stage activity (TASK-833)", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("blueprint_start", "TASK-001", {
          cached: false,
          mode: "dispatch",
          warningMs: 120000,
          timeoutMs: 300000,
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.lastActivity?.type).toBe("blueprint_stage");
      expect(health!.lastActivity?.detail).toContain("Blueprint:");
    });

    test("records blueprint_warning as blueprint_stage activity (TASK-833)", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("blueprint_warning", "TASK-001", {
          reason: "inline_blueprint_slow",
          elapsedMs: 150000,
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.lastActivity?.type).toBe("blueprint_stage");
      expect(health!.lastActivity?.detail).toContain("Blueprint:");
    });

    test("records blueprint_fallback as blueprint_stage activity (TASK-833)", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("blueprint_fallback", "TASK-001", {
          reason: "dispatch_timeout_minimal_blueprint",
          elapsedMs: 300000,
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.lastActivity?.type).toBe("blueprint_stage");
      expect(health!.lastActivity?.detail).toContain("Blueprint:");
    });
  });

  describe("health status computation", () => {
    test("returns healthy when activity is recent", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const health = detector.getHealth("TASK-001");
      expect(health!.status).toBe("healthy");
      expect(health!.silentMs).toBeLessThan(1000);
    });

    test("returns correct status based on silence duration", () => {
      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 0.001, // ~60ms
        criticalMinutes: 0.002, // ~120ms
        killMinutes: 0.003, // ~180ms
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      // Simulate time passing by manipulating the tracking
      const health = detector.getHealth("TASK-001");
      expect(health).not.toBeNull();
      // Immediately after processing, status should be healthy
      expect(health!.status).toBe("healthy");
    });

    test("returns null for untracked task", () => {
      const detector = new ProgressDetector(defaultConfig);

      expect(detector.getHealth("TASK-UNKNOWN")).toBeNull();
    });
  });

  describe("multiple concurrent tasks", () => {
    test("tracks tasks independently", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-A", {}, "session-A"));
      detector.processEvent(makeEvent("session_start", "TASK-B", {}, "session-B"));

      detector.processEvent(makeEvent("agent_turn", "TASK-A", { turnNumber: 1 }, "session-A"));
      detector.processEvent(makeEvent("agent_turn", "TASK-A", { turnNumber: 2 }, "session-A"));
      detector.processEvent(makeEvent("agent_turn", "TASK-B", { turnNumber: 1 }, "session-B"));

      expect(detector.getTrackedCount()).toBe(2);

      const healthA = detector.getHealth("TASK-A");
      const healthB = detector.getHealth("TASK-B");

      expect(healthA!.turnCount).toBe(2);
      expect(healthB!.turnCount).toBe(1);
    });

    test("getAllHealth returns all tracked tasks", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-A", {}, "s-a"));
      detector.processEvent(makeEvent("session_start", "TASK-B", {}, "s-b"));
      detector.processEvent(makeEvent("session_start", "TASK-C", {}, "s-c"));

      const allHealth = detector.getAllHealth();
      expect(allHealth).toHaveLength(3);
      expect(allHealth.map((h) => h.taskId).sort()).toEqual(["TASK-A", "TASK-B", "TASK-C"]);
    });
  });

  describe("shouldKill", () => {
    test("returns kill=false when within threshold", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const result = detector.shouldKill("TASK-001");
      expect(result.kill).toBe(false);
    });

    test("returns kill=false when disabled", () => {
      const detector = new ProgressDetector({ enabled: false });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const result = detector.shouldKill("TASK-001");
      expect(result.kill).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    test("returns kill=false for untracked task", () => {
      const detector = new ProgressDetector(defaultConfig);

      const result = detector.shouldKill("TASK-UNKNOWN");
      expect(result.kill).toBe(false);
      expect(result.reason).toContain("not being tracked");
    });

    test("returns kill=true when silent beyond threshold", () => {
      const detector = new ProgressDetector({
        ...defaultConfig,
        killMinutes: 0.0001, // ~6ms
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      // Wait a tiny bit for threshold to pass
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 100);

      const result = detector.shouldKill("TASK-001");
      expect(result.kill).toBe(true);
      expect(result.reason).toContain("No activity");
    });
  });

  describe("stuck detection callbacks", () => {
    test("fires warning callback at warning threshold", () => {
      jest.useFakeTimers();
      const stuckEvents: StuckEvent[] = [];

      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 0.0001, // ~6ms
        criticalMinutes: 100, // won't fire
        killMinutes: 200, // won't fire
        checkIntervalSeconds: 0.01,
      });

      detector.setStuckCallback((event) => stuckEvents.push(event));
      detector.processEvent(makeEvent("session_start", "TASK-001"));

      // Start checking and advance time
      detector.startChecking();
      jest.advanceTimersByTime(100);

      detector.stopChecking();
      jest.useRealTimers();

      const warnings = stuckEvents.filter((e) => e.level === "warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].taskId).toBe("TASK-001");
    });

    test("fires kill callback at kill threshold", () => {
      jest.useFakeTimers();
      const stuckEvents: StuckEvent[] = [];

      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 0.00001,
        criticalMinutes: 0.00002,
        killMinutes: 0.00003, // ~1.8ms
        checkIntervalSeconds: 0.001,
      });

      detector.setStuckCallback((event) => stuckEvents.push(event));
      detector.processEvent(makeEvent("session_start", "TASK-001"));

      detector.startChecking();
      jest.advanceTimersByTime(100);

      detector.stopChecking();
      jest.useRealTimers();

      const kills = stuckEvents.filter((e) => e.level === "kill");
      expect(kills.length).toBeGreaterThanOrEqual(1);
      expect(kills[0].taskId).toBe("TASK-001");
    });

    test("does not fire when disabled", () => {
      jest.useFakeTimers();
      const stuckEvents: StuckEvent[] = [];

      const detector = new ProgressDetector({
        enabled: false,
        warningMinutes: 0.00001,
        criticalMinutes: 0.00002,
        killMinutes: 0.00003,
        checkIntervalSeconds: 0.001,
      });

      detector.setStuckCallback((event) => stuckEvents.push(event));
      detector.processEvent(makeEvent("session_start", "TASK-001"));

      detector.startChecking(); // Should be a no-op when disabled
      jest.advanceTimersByTime(100);

      detector.stopChecking();
      jest.useRealTimers();

      expect(stuckEvents).toHaveLength(0);
    });

    test("resets warning on new activity", () => {
      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 0.00001, // tiny
        criticalMinutes: 100,
        killMinutes: 200,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      // New activity resets the warning flag
      detector.processEvent(makeEvent("agent_turn", "TASK-001", { turnNumber: 1 }));

      const health = detector.getHealth("TASK-001");
      expect(health!.status).toBe("healthy");
      expect(health!.silentMs).toBeLessThan(1000);
    });

    test("warning only emitted once until activity resets it", () => {
      jest.useFakeTimers();
      const stuckEvents: StuckEvent[] = [];

      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 0.00001,
        criticalMinutes: 100,
        killMinutes: 200,
        checkIntervalSeconds: 0.001,
      });

      detector.setStuckCallback((event) => stuckEvents.push(event));
      detector.processEvent(makeEvent("session_start", "TASK-001"));

      detector.startChecking();

      // First check — should emit warning
      jest.advanceTimersByTime(10);
      const warningCount1 = stuckEvents.filter((e) => e.level === "warning").length;

      // Advance more — should NOT emit another warning (already emitted)
      jest.advanceTimersByTime(10);
      const warningCount2 = stuckEvents.filter((e) => e.level === "warning").length;

      expect(warningCount2).toBe(warningCount1);

      detector.stopChecking();
      jest.useRealTimers();
    });
  });

  describe("LLM response timeout extension", () => {
    test("agent_turn sets inLlmResponse to true", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(
        makeEvent("agent_turn", "TASK-001", {
          turnNumber: 1,
          role: "assistant",
          contentPreview: "thinking",
        }),
      );

      const health = detector.getHealth("TASK-001");
      expect(health!.inLlmResponse).toBe(true);
    });

    test("tool use clears inLlmResponse flag", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(makeEvent("agent_turn", "TASK-001", { turnNumber: 1 }));
      expect(detector.getHealth("TASK-001")!.inLlmResponse).toBe(true);

      detector.processEvent(
        makeEvent("agent_tool_use", "TASK-001", { toolName: "Edit", filePath: "foo.ts" }),
      );
      expect(detector.getHealth("TASK-001")!.inLlmResponse).toBe(false);
    });

    test("inLlmResponse doubles stuck detection thresholds", () => {
      const warningMs = 100;
      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: warningMs / 60000,
        criticalMinutes: 1000, // won't fire
        killMinutes: 2000, // won't fire
        checkIntervalSeconds: 30,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const baseNow = Date.now();
      const spy = jest.spyOn(Date, "now");

      // Trigger agent_turn to set inLlmResponse = true
      detector.processEvent(makeEvent("agent_turn", "TASK-001", { turnNumber: 1 }));

      // At 1.5x the warning threshold — normally would be "warning" but
      // with inLlmResponse=true, effective threshold is 2x, so still "slow"
      spy.mockReturnValue(baseNow + warningMs * 1.5);
      expect(detector.getHealth("TASK-001")!.status).toBe("slow");

      // At 2.1x — now exceeds the doubled threshold → warning
      spy.mockReturnValue(baseNow + warningMs * 2.1);
      expect(detector.getHealth("TASK-001")!.status).toBe("warning");
    });

    test("shouldKill uses doubled threshold when inLlmResponse is true", () => {
      const killMs = 60;
      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: 0.00001,
        criticalMinutes: 0.00002,
        killMinutes: killMs / 60000,
        checkIntervalSeconds: 30,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      detector.processEvent(makeEvent("agent_turn", "TASK-001", { turnNumber: 1 }));

      const spy = jest.spyOn(Date, "now");

      // At 1.5x kill threshold — would kill normally, but inLlmResponse doubles it
      spy.mockReturnValue(Date.now() + killMs * 1.5);
      const result1 = detector.shouldKill("TASK-001");
      expect(result1.kill).toBe(false);

      // At 2.1x kill threshold — exceeds doubled threshold → kill
      spy.mockReturnValue(Date.now() + killMs * 2.1);
      const result2 = detector.shouldKill("TASK-001");
      expect(result2.kill).toBe(true);
      expect(result2.reason).toContain("extended for LLM response");
    });
  });

  describe("removeTracking", () => {
    test("removes task from tracking", () => {
      const detector = new ProgressDetector(defaultConfig);

      detector.processEvent(makeEvent("session_start", "TASK-001"));
      expect(detector.getTrackedCount()).toBe(1);

      detector.removeTracking("TASK-001");
      expect(detector.getTrackedCount()).toBe(0);
    });
  });

  describe("getConfig", () => {
    test("returns config copy", () => {
      const detector = new ProgressDetector(defaultConfig);
      const config = detector.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.warningMinutes).toBe(5);
      expect(config.criticalMinutes).toBe(10);
      expect(config.killMinutes).toBe(15);
    });

    test("uses defaults when no config provided", () => {
      const detector = new ProgressDetector();
      const config = detector.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.warningMinutes).toBe(5);
      expect(config.criticalMinutes).toBe(10);
      expect(config.killMinutes).toBe(15);
      expect(config.checkIntervalSeconds).toBe(30);
    });
  });

  describe("startChecking / stopChecking", () => {
    test("does not start interval when disabled", () => {
      const detector = new ProgressDetector({ enabled: false });

      detector.startChecking();
      // No error, just a no-op
      detector.stopChecking();
    });

    test("stops cleanly even without starting", () => {
      const detector = new ProgressDetector(defaultConfig);
      detector.stopChecking(); // Should not throw
    });

    test("idempotent start", () => {
      jest.useFakeTimers();
      const detector = new ProgressDetector({
        ...defaultConfig,
        checkIntervalSeconds: 1,
      });

      detector.startChecking();
      detector.startChecking(); // Should be no-op

      detector.stopChecking();
      jest.useRealTimers();
    });
  });

  describe("file heartbeat integration", () => {
    test("file activity resets stuck timer", () => {
      const killMs = 100;
      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: (killMs / 60000) * 0.5,
        criticalMinutes: (killMs / 60000) * 0.8,
        killMinutes: killMs / 60000,
        checkIntervalSeconds: 30,
        fileHeartbeat: true,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const baseNow = Date.now();
      const spy = jest.spyOn(Date, "now");

      // Advance past kill threshold — would normally be stuck
      spy.mockReturnValue(baseNow + killMs + 10);
      expect(detector.getHealth("TASK-001")!.status).toBe("stuck");

      // Record file activity — this should reset the silence timer
      spy.mockReturnValue(baseNow + killMs + 20);
      detector.recordFileActivity("TASK-001");

      // Immediately after file activity — should be healthy again
      spy.mockReturnValue(baseNow + killMs + 25);
      expect(detector.getHealth("TASK-001")!.status).toBe("healthy");
    });

    test("file activity prevents shouldKill", () => {
      const killMs = 100;
      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: 0.00001,
        criticalMinutes: 0.00002,
        killMinutes: killMs / 60000,
        checkIntervalSeconds: 30,
        fileHeartbeat: true,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const baseNow = Date.now();
      const spy = jest.spyOn(Date, "now");

      // Past kill threshold with no event activity
      spy.mockReturnValue(baseNow + killMs + 10);
      expect(detector.shouldKill("TASK-001").kill).toBe(true);

      // Record file activity
      spy.mockReturnValue(baseNow + killMs + 20);
      detector.recordFileActivity("TASK-001");

      // Shortly after file activity — should NOT kill
      spy.mockReturnValue(baseNow + killMs + 30);
      expect(detector.shouldKill("TASK-001").kill).toBe(false);
    });

    test("either signal prevents stuck classification", () => {
      const warningMs = 100;
      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: warningMs / 60000,
        criticalMinutes: 10,
        killMinutes: 20,
        checkIntervalSeconds: 30,
        fileHeartbeat: true,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const baseNow = Date.now();
      const spy = jest.spyOn(Date, "now");

      // Past warning with no JSONL events — but file activity is recent
      spy.mockReturnValue(baseNow + warningMs + 50);
      detector.recordFileActivity("TASK-001");

      spy.mockReturnValue(baseNow + warningMs + 60);
      // File activity was 10ms ago, JSONL activity was warningMs+60 ago
      // Since file activity is recent, should be healthy
      expect(detector.getHealth("TASK-001")!.status).toBe("healthy");
    });

    test("recordFileActivity is no-op for untracked tasks", () => {
      const detector = new ProgressDetector(defaultConfig);
      // Should not throw
      detector.recordFileActivity("TASK-UNKNOWN");
      expect(detector.getHealth("TASK-UNKNOWN")).toBeNull();
    });
  });

  describe("status thresholds", () => {
    test("computes slow status at 60% of warning threshold", () => {
      // Warning at 5 min, slow at 60% = 3 min
      // We'll use very short thresholds and mock Date.now
      const detector = new ProgressDetector({
        ...defaultConfig,
        warningMinutes: 1, // 60000ms warning
        criticalMinutes: 10,
        killMinutes: 15,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      // Mock 40 seconds elapsed (> 60% of 60s = 36s → slow)
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 40000);

      const health = detector.getHealth("TASK-001");
      expect(health!.status).toBe("slow");
    });

    test("status progression: healthy → slow → warning → critical → stuck", () => {
      const warningMs = 100;
      const criticalMs = 200;
      const killMs = 300;

      const detector = new ProgressDetector({
        enabled: true,
        warningMinutes: warningMs / 60000,
        criticalMinutes: criticalMs / 60000,
        killMinutes: killMs / 60000,
        checkIntervalSeconds: 30,
      });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      const baseNow = Date.now();
      const spy = jest.spyOn(Date, "now");

      // Just started — healthy
      spy.mockReturnValue(baseNow + 10);
      expect(detector.getHealth("TASK-001")!.status).toBe("healthy");

      // At 60% of warning — slow
      spy.mockReturnValue(baseNow + warningMs * 0.7);
      expect(detector.getHealth("TASK-001")!.status).toBe("slow");

      // At warning — warning
      spy.mockReturnValue(baseNow + warningMs + 1);
      expect(detector.getHealth("TASK-001")!.status).toBe("warning");

      // At critical — critical
      spy.mockReturnValue(baseNow + criticalMs + 1);
      expect(detector.getHealth("TASK-001")!.status).toBe("critical");

      // At kill — stuck
      spy.mockReturnValue(baseNow + killMs + 1);
      expect(detector.getHealth("TASK-001")!.status).toBe("stuck");
    });

    test("always returns healthy when disabled", () => {
      const detector = new ProgressDetector({ enabled: false });

      detector.processEvent(makeEvent("session_start", "TASK-001"));

      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 999999);

      const health = detector.getHealth("TASK-001");
      expect(health!.status).toBe("healthy");
    });
  });
});
