// ─── Research Analyzer Tests ──────────────────────────────────────

import type { QuackEvent, SessionEntry } from "../../src/monitor/event-types";
import type { DispatchAnalysis, EfficiencyBaseline } from "../../src/research/research-types";
import {
  computeStageTimings,
  computeEfficiencyBaseline,
  computeEfficiencyScore,
  detectAnomalies,
  buildAnalysis,
  inferWorkerProvenance,
  isFederationWrapperAnalysis,
  normalizeResearchAnalyses,
  computeExperimentReadiness,
  computeTrends,
} from "../../src/research/research-analyzer";

// ─── Helpers ──────────────────────────────────────────────────────

function makeEvent(
  stage: string,
  timestamp: string,
  payload: Record<string, unknown> = {},
): QuackEvent {
  return {
    sessionId: "test-session",
    taskId: "TASK-001",
    project: "test",
    timestamp,
    stage: stage as QuackEvent["stage"],
    payload: payload as QuackEvent["payload"],
  };
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session",
    taskId: "TASK-001",
    project: "test",
    startTime: "2026-03-15T10:00:00.000Z",
    status: "completed",
    outcome: "approved",
    totalCostUsd: 1.5,
    durationMs: 600000, // 10 minutes
    turnsUsed: 20,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<DispatchAnalysis> = {}): DispatchAnalysis {
  return {
    sessionId: "test-session",
    taskId: "TASK-001",
    project: "test",
    outcome: "approved",
    startTime: "2026-03-15T10:00:00.000Z",
    durationMs: 600000,
    totalCostUsd: 1.5,
    turnsUsed: 20,
    stageTimings: [],
    codeMetrics: {
      linesAdded: 100,
      linesRemoved: 20,
      linesChanged: 120,
      filesAdded: 2,
      filesModified: 3,
      filesDeleted: 0,
      totalFiles: 5,
      branchName: "quack/TASK-001-test",
    },
    linesPerMinute: 12.0,
    costPerLine: 0.0125,
    efficiencyScore: 50,
    anomalies: [],
    analyzedAt: "2026-03-15T10:10:00.000Z",
    ...overrides,
  };
}

// ─── computeStageTimings ──────────────────────────────────────────

describe("computeStageTimings", () => {
  it("returns empty array for no events", () => {
    expect(computeStageTimings([])).toEqual([]);
  });

  it("computes gate timing from session_start to gate_result", () => {
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("gate_result", "2026-03-15T10:00:30.000Z", { outcome: "pass" }),
    ];
    const timings = computeStageTimings(events);
    const gate = timings.find((t) => t.stage === "gate");
    expect(gate).toBeDefined();
    expect(gate!.durationMs).toBe(30000);
  });

  it("computes agent timing from first agent_turn to agent_complete", () => {
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("agent_turn", "2026-03-15T10:02:00.000Z", { turnNumber: 1 }),
      makeEvent("agent_turn", "2026-03-15T10:03:00.000Z", { turnNumber: 2 }),
      makeEvent("agent_complete", "2026-03-15T10:08:00.000Z", { outcome: "success" }),
    ];
    const timings = computeStageTimings(events);
    const agent = timings.find((t) => t.stage === "agent");
    expect(agent).toBeDefined();
    expect(agent!.durationMs).toBe(360000); // 6 minutes
  });

  it("computes overhead as total minus known stages", () => {
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("gate_result", "2026-03-15T10:00:30.000Z"),
      makeEvent("agent_turn", "2026-03-15T10:01:00.000Z"),
      makeEvent("agent_complete", "2026-03-15T10:09:00.000Z"),
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];
    const timings = computeStageTimings(events);
    const overhead = timings.find((t) => t.stage === "overhead");
    expect(overhead).toBeDefined();
    // Total: 10min = 600000ms, gate: 30s, agent: 8min = 480000ms
    // overhead = 600000 - 30000 - 480000 = 90000
    expect(overhead!.durationMs).toBe(90000);
  });

  it("computes preflight stage timings", () => {
    const events = [
      makeEvent("preflight_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("preflight_gate", "2026-03-15T10:00:10.000Z"),
      makeEvent("preflight_spec_review", "2026-03-15T10:00:25.000Z"),
      makeEvent("preflight_blueprint", "2026-03-15T10:00:45.000Z"),
      makeEvent("preflight_analysis", "2026-03-15T10:01:00.000Z"),
      makeEvent("preflight_complete", "2026-03-15T10:01:05.000Z"),
    ];
    const timings = computeStageTimings(events);

    const total = timings.find((t) => t.stage === "preflight_total");
    expect(total).toBeDefined();
    expect(total!.durationMs).toBe(65000); // 1m5s

    const gate = timings.find((t) => t.stage === "preflight_gate");
    expect(gate).toBeDefined();
    expect(gate!.durationMs).toBe(10000);

    const specReview = timings.find((t) => t.stage === "preflight_spec_review");
    expect(specReview).toBeDefined();
    expect(specReview!.durationMs).toBe(15000);

    const blueprint = timings.find((t) => t.stage === "preflight_blueprint");
    expect(blueprint).toBeDefined();
    expect(blueprint!.durationMs).toBe(20000);

    const analysis = timings.find((t) => t.stage === "preflight_analysis");
    expect(analysis).toBeDefined();
    expect(analysis!.durationMs).toBe(15000);
  });

  it("handles missing stages gracefully", () => {
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];
    const timings = computeStageTimings(events);
    // Should have just overhead (since no known stages matched)
    expect(timings.length).toBe(1);
    expect(timings[0].stage).toBe("overhead");
  });

  it("computes judge timing", () => {
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("judge_start", "2026-03-15T10:08:00.000Z"),
      makeEvent("judge_result", "2026-03-15T10:09:00.000Z"),
      makeEvent("judge_result", "2026-03-15T10:09:30.000Z"), // second result (last wins)
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];
    const timings = computeStageTimings(events);
    const judge = timings.find((t) => t.stage === "judge");
    expect(judge).toBeDefined();
    // From judge_start to last judge_result: 1.5 minutes
    expect(judge!.durationMs).toBe(90000);
  });
});

// ─── computeEfficiencyBaseline ────────────────────────────────────

describe("computeEfficiencyBaseline", () => {
  it("returns null with fewer than 3 qualified analyses", () => {
    const analyses = [makeAnalysis(), makeAnalysis({ sessionId: "s2" })];
    expect(computeEfficiencyBaseline(analyses)).toBeNull();
  });

  it("returns null when no analyses have code metrics", () => {
    const analyses = Array.from({ length: 5 }, (_, i) =>
      makeAnalysis({
        sessionId: `s${i}`,
        codeMetrics: null,
        linesPerMinute: null,
      }),
    );
    expect(computeEfficiencyBaseline(analyses)).toBeNull();
  });

  it("computes baseline from qualified approved analyses", () => {
    const analyses = [
      makeAnalysis({ sessionId: "s1", linesPerMinute: 10 }),
      makeAnalysis({ sessionId: "s2", linesPerMinute: 12 }),
      makeAnalysis({ sessionId: "s3", linesPerMinute: 14 }),
    ];
    const baseline = computeEfficiencyBaseline(analyses);
    expect(baseline).not.toBeNull();
    expect(baseline!.meanLinesPerMinute).toBe(12);
    expect(baseline!.sampleCount).toBe(3);
    expect(baseline!.stdDevLinesPerMinute).toBeGreaterThan(0);
  });

  it("excludes rejected analyses from baseline", () => {
    const analyses = [
      makeAnalysis({ sessionId: "s1", linesPerMinute: 10 }),
      makeAnalysis({ sessionId: "s2", linesPerMinute: 12 }),
      makeAnalysis({ sessionId: "s3", linesPerMinute: 14 }),
      makeAnalysis({ sessionId: "s4", linesPerMinute: 1, outcome: "rejected" }),
    ];
    const baseline = computeEfficiencyBaseline(analyses);
    expect(baseline!.sampleCount).toBe(3); // rejected excluded
    expect(baseline!.meanLinesPerMinute).toBe(12);
  });
});

// ─── computeEfficiencyScore ───────────────────────────────────────

describe("computeEfficiencyScore", () => {
  const baseline: EfficiencyBaseline = {
    meanLinesPerMinute: 12,
    stdDevLinesPerMinute: 4,
    meanCostPerLine: 0.01,
    stdDevCostPerLine: 0.005,
    sampleCount: 10,
    lastUpdated: "2026-03-15T00:00:00Z",
  };

  it("returns 50 for mean value", () => {
    const score = computeEfficiencyScore(12, baseline);
    expect(score).toBe(50);
  });

  it("returns higher score for above-mean value", () => {
    const score = computeEfficiencyScore(20, baseline);
    expect(score).toBeGreaterThan(50);
  });

  it("returns lower score for below-mean value", () => {
    const score = computeEfficiencyScore(4, baseline);
    expect(score).toBeLessThan(50);
  });

  it("clamps to 0-100 range", () => {
    const veryHigh = computeEfficiencyScore(100, baseline);
    const veryLow = computeEfficiencyScore(-50, baseline);
    expect(veryHigh).toBeLessThanOrEqual(100);
    expect(veryLow).toBeGreaterThanOrEqual(0);
  });

  it("returns 50 when stdDev is 0", () => {
    const flatBaseline = { ...baseline, stdDevLinesPerMinute: 0 };
    expect(computeEfficiencyScore(20, flatBaseline)).toBe(50);
  });
});

// ─── detectAnomalies ──────────────────────────────────────────────

describe("detectAnomalies", () => {
  const baseline: EfficiencyBaseline = {
    meanLinesPerMinute: 12,
    stdDevLinesPerMinute: 4,
    meanCostPerLine: 0.01,
    stdDevCostPerLine: 0.005,
    sampleCount: 10,
    lastUpdated: "2026-03-15T00:00:00Z",
  };

  it("returns no flags for normal dispatch", () => {
    const analysis = makeAnalysis({ linesPerMinute: 12, durationMs: 600000 });
    expect(detectAnomalies(analysis, baseline)).toEqual([]);
  });

  it("returns no flags when codeMetrics is null", () => {
    const analysis = makeAnalysis({ codeMetrics: null, linesPerMinute: null });
    expect(detectAnomalies(analysis, baseline)).toEqual([]);
  });

  it("returns no flags when baseline has fewer than 3 samples", () => {
    const analysis = makeAnalysis({ linesPerMinute: 0.5, durationMs: 3600000 });
    const weakBaseline = { ...baseline, sampleCount: 2 };
    expect(detectAnomalies(analysis, weakBaseline)).toEqual([]);
  });

  it("flags too_slow when lpm is low and duration > 30min", () => {
    const analysis = makeAnalysis({
      linesPerMinute: 2, // way below mean(12) - 1.5*std(4) = 6
      durationMs: 3600000, // 60 min
    });
    const flags = detectAnomalies(analysis, baseline);
    expect(flags.some((f) => f.type === "too_slow")).toBe(true);
  });

  it("does not flag too_slow for short dispatches", () => {
    const analysis = makeAnalysis({
      linesPerMinute: 2,
      durationMs: 600000, // 10 min, under 30
    });
    const flags = detectAnomalies(analysis, baseline);
    expect(flags.some((f) => f.type === "too_slow")).toBe(false);
  });

  it("flags too_fast when lpm is very high and lines > 200", () => {
    const analysis = makeAnalysis({
      linesPerMinute: 30, // above mean(12) + 2.5*std(4) = 22
      codeMetrics: {
        linesAdded: 300,
        linesRemoved: 0,
        linesChanged: 300,
        filesAdded: 5,
        filesModified: 0,
        filesDeleted: 0,
        totalFiles: 5,
        branchName: "test",
      },
      durationMs: 600000,
    });
    const flags = detectAnomalies(analysis, baseline);
    expect(flags.some((f) => f.type === "too_fast")).toBe(true);
  });

  it("flags high_cost_per_line", () => {
    const analysis = makeAnalysis({
      costPerLine: 0.03, // above mean(0.01) + 2*std(0.005) = 0.02
    });
    const flags = detectAnomalies(analysis, baseline);
    expect(flags.some((f) => f.type === "high_cost_per_line")).toBe(true);
  });

  it("flags low_output for long approved dispatches with few lines", () => {
    const analysis = makeAnalysis({
      outcome: "approved",
      durationMs: 3600000, // 60 min
      linesPerMinute: 0.1,
      codeMetrics: {
        linesAdded: 5,
        linesRemoved: 0,
        linesChanged: 5,
        filesAdded: 1,
        filesModified: 0,
        filesDeleted: 0,
        totalFiles: 1,
        branchName: "test",
      },
    });
    const flags = detectAnomalies(analysis, baseline);
    expect(flags.some((f) => f.type === "low_output")).toBe(true);
  });
});

// ─── buildAnalysis ────────────────────────────────────────────────

describe("buildAnalysis", () => {
  it("builds analysis from session and events (no branch events → null codeMetrics)", () => {
    const session = makeSession();
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("gate_result", "2026-03-15T10:00:30.000Z"),
      makeEvent("agent_turn", "2026-03-15T10:01:00.000Z"),
      makeEvent("agent_complete", "2026-03-15T10:09:00.000Z"),
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];

    const analysis = buildAnalysis(session, events, "/fake/root", null);
    expect(analysis.sessionId).toBe("test-session");
    expect(analysis.taskId).toBe("TASK-001");
    expect(analysis.stageTimings.length).toBeGreaterThan(0);
    expect(analysis.codeMetrics).toBeNull(); // no branch events
    expect(analysis.efficiencyScore).toBeNull(); // no baseline
  });

  it("populates session-level fields correctly", () => {
    const session = makeSession({ totalCostUsd: 2.5, turnsUsed: 30 });
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z"),
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];
    const analysis = buildAnalysis(session, events, "/fake/root", null);
    expect(analysis.totalCostUsd).toBe(2.5);
    expect(analysis.turnsUsed).toBe(30);
    expect(analysis.outcome).toBe("approved");
  });

  it("records federated worker provenance from session events", () => {
    const session = makeSession({ title: "Worker attribution fixture" });
    const events = [
      makeEvent("session_start", "2026-03-15T10:00:00.000Z", {
        jobId: "fed-TASK-001",
        hostId: "laptop",
        hostAlias: "Laptop",
        hostEndpoint: "http://localhost:3333",
        federated: true,
      }),
      makeEvent("federated_job_status", "2026-03-15T10:01:00.000Z", {
        jobId: "fed-TASK-001",
        hostId: "laptop",
        hostAlias: "Laptop",
        status: "running",
        workflowState: "executing",
      }),
      makeEvent("session_complete", "2026-03-15T10:10:00.000Z"),
    ];
    const analysis = buildAnalysis(session, events, "/fake/root", null);

    expect(inferWorkerProvenance(events).executionMode).toBe("federated");
    expect(analysis.workerHostId).toBe("laptop");
    expect(analysis.workerHostAlias).toBe("Laptop");
    expect(analysis.workerHostEndpoint).toBe("http://localhost:3333");
    expect(analysis.federatedJobId).toBe("fed-TASK-001");
    expect(analysis.taskTitle).toBe("Worker attribution fixture");
  });
});

// ─── normalizeResearchAnalyses ───────────────────────────────────

describe("normalizeResearchAnalyses", () => {
  it("drops a federation wrapper when a real worker analysis exists for the same job", () => {
    const wrapper = makeAnalysis({
      sessionId: "federation-fed-task-878-abc123",
      taskId: "TASK-878",
      outcome: "federated_job_completed",
      durationMs: 0,
      totalCostUsd: 0,
      turnsUsed: 0,
      codeMetrics: null,
      linesPerMinute: null,
      costPerLine: null,
      efficiencyScore: null,
      executionMode: "federated",
      federatedJobId: "fed-task-878-abc123",
      workerHostId: "headnode",
      workerHostAlias: "Headnode",
      workerHostEndpoint: "http://127.0.0.1:3333",
    });
    const worker = makeAnalysis({
      sessionId: "quack-TASK-878-worker",
      taskId: "TASK-878",
      outcome: "approved",
      executionMode: "federated",
      federatedJobId: "fed-task-878-abc123",
      workerHostId: undefined,
      workerHostAlias: undefined,
      workerHostEndpoint: undefined,
    });

    const normalized = normalizeResearchAnalyses([wrapper, worker]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].sessionId).toBe("quack-TASK-878-worker");
    expect(normalized[0].workerHostId).toBe("headnode");
    expect(normalized[0].workerHostAlias).toBe("Headnode");
    expect(normalized[0].workerHostEndpoint).toBe("http://127.0.0.1:3333");
  });

  it("keeps an orphan federation wrapper so transport failures remain visible", () => {
    const wrapper = makeAnalysis({
      sessionId: "federation-fed-task-944-a-transport",
      taskId: "TASK-944-A",
      outcome: "federated_job_failed",
      codeMetrics: null,
      linesPerMinute: null,
      costPerLine: null,
      executionMode: "federated",
    });

    const normalized = normalizeResearchAnalyses([wrapper]);

    expect(isFederationWrapperAnalysis(wrapper)).toBe(true);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].sessionId).toBe(wrapper.sessionId);
  });
});

// ─── computeExperimentReadiness ───────────────────────────────────

describe("computeExperimentReadiness", () => {
  it("returns all areas with zero data points when no analyses", () => {
    const readiness = computeExperimentReadiness([]);
    expect(readiness.length).toBe(10); // 5 dispatch + 5 preflight
    expect(readiness.every((r) => r.dataPoints === 0)).toBe(true);
    expect(readiness.every((r) => !r.baselineReady)).toBe(true);
  });

  it("marks area as ready when 5+ data points", () => {
    const analyses = Array.from({ length: 6 }, (_, i) =>
      makeAnalysis({
        sessionId: `s${i}`,
        stageTimings: [
          {
            stage: "gate",
            startTime: "2026-03-15T10:00:00Z",
            endTime: "2026-03-15T10:00:30Z",
            durationMs: 30000,
          },
          {
            stage: "agent",
            startTime: "2026-03-15T10:01:00Z",
            endTime: "2026-03-15T10:09:00Z",
            durationMs: 480000,
          },
        ],
      }),
    );

    const readiness = computeExperimentReadiness(analyses);
    const gate = readiness.find((r) => r.area === "gate");
    expect(gate!.baselineReady).toBe(true);
    expect(gate!.dataPoints).toBe(6);

    const blueprint = readiness.find((r) => r.area === "blueprint");
    expect(blueprint!.baselineReady).toBe(false);
    expect(blueprint!.dataPoints).toBe(0);
  });
});

// ─── computeTrends ────────────────────────────────────────────────

describe("computeTrends", () => {
  it("returns empty array for no analyses", () => {
    expect(computeTrends([])).toEqual([]);
  });

  it("groups analyses by day", () => {
    const analyses = [
      makeAnalysis({ sessionId: "s1", startTime: "2026-03-15T10:00:00Z", linesPerMinute: 10 }),
      makeAnalysis({ sessionId: "s2", startTime: "2026-03-15T14:00:00Z", linesPerMinute: 14 }),
      makeAnalysis({ sessionId: "s3", startTime: "2026-03-16T10:00:00Z", linesPerMinute: 8 }),
    ];

    const trends = computeTrends(analyses);
    expect(trends.length).toBe(2);
    expect(trends[0].date).toBe("2026-03-15");
    expect(trends[0].dispatches).toBe(2);
    expect(trends[0].avgLinesPerMinute).toBe(12); // (10+14)/2
    expect(trends[1].date).toBe("2026-03-16");
    expect(trends[1].dispatches).toBe(1);
  });

  it("counts anomalies per day", () => {
    const analyses = [
      makeAnalysis({
        sessionId: "s1",
        startTime: "2026-03-15T10:00:00Z",
        anomalies: [{ type: "too_slow", message: "test", value: 1, threshold: 5 }],
      }),
      makeAnalysis({
        sessionId: "s2",
        startTime: "2026-03-15T14:00:00Z",
        anomalies: [
          { type: "too_fast", message: "test", value: 30, threshold: 20 },
          { type: "high_cost_per_line", message: "test", value: 0.05, threshold: 0.02 },
        ],
      }),
    ];

    const trends = computeTrends(analyses);
    expect(trends[0].anomalyCount).toBe(3);
  });
});
