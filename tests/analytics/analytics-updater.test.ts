// ─── Analytics Updater Tests ───────────────────────────────────────
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { updateAnalytics, rebuildAnalyticsDB } from "../../src/analytics/analytics-updater.js";
import type { RunAnalysis, FailurePatternDB } from "../../src/analytics/analytics-types.js";
import type { EventReader } from "../../src/monitor/event-reader.js";
import type { SessionEntry, QuackEvent } from "../../src/monitor/event-types.js";

describe("Analytics Updater", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-analytics-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const mockAnalysis: RunAnalysis = {
    taskId: "TASK-001",
    sessionId: "session-001",
    outcome: "approved",
    costUsd: 0.25,
    turnsUsed: 10,
    retriesUsed: 0,
    taskTags: ["backend"],
    targetFiles: ["src/server.ts"],
    criteriaResults: [{ criterion: "Tests pass", status: "PASS" }],
    feedbackThemes: [],
    gateScore: 4.0,
    complexity: { filesToModify: 2, successCriteria: 3 },
  };

  it("should create new analytics DB if none exists", async () => {
    updateAnalytics(mockAnalysis, tempDir);

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    expect(fs.existsSync(analyticsPath)).toBe(true);

    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));
    expect(db.totalRuns).toBe(1);
    expect(db.totalApproved).toBe(1);
    expect(db.totalRejected).toBe(0);
    expect(db.totalErrors).toBe(0);
  });

  it("should update counters for approved run", async () => {
    updateAnalytics(mockAnalysis, tempDir);

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.totalRuns).toBe(1);
    expect(db.totalApproved).toBe(1);
    expect(db.byTag["backend"]).toEqual({ runs: 1, approved: 1, rejected: 0, rate: 1.0 });
    expect(db.byFile["src/server.ts"]).toEqual({ runs: 1, approved: 1, rejected: 0, rate: 1.0 });
  });

  it("should update counters for rejected run", async () => {
    const rejectedAnalysis: RunAnalysis = {
      ...mockAnalysis,
      outcome: "rejected",
    };

    updateAnalytics(rejectedAnalysis, tempDir);

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.totalRuns).toBe(1);
    expect(db.totalApproved).toBe(0);
    expect(db.totalRejected).toBe(1);
    expect(db.byTag["backend"]).toEqual({ runs: 1, approved: 0, rejected: 1, rate: 0.0 });
  });

  it("should detect file hot spot pattern (3+ rejected runs)", async () => {
    // Add 3 rejected runs for the same file
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          ...mockAnalysis,
          sessionId: `session-${i}`,
          outcome: "rejected",
        },
        tempDir,
      );
    }

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    const hotspotPattern = db.knownPatterns.find((p) =>
      p.pattern.startsWith("file_hotspot:src/server.ts"),
    );
    expect(hotspotPattern).toBeDefined();
    expect(hotspotPattern!.occurrences).toBeGreaterThanOrEqual(1);
    expect(db.byFile["src/server.ts"].rejected).toBe(3);
  });

  it("should NOT detect file hot spot for error outcomes (only rejected)", async () => {
    // Add 2 rejected + 1 error — should NOT trigger hot spot (only 2 rejected)
    for (let i = 0; i < 2; i++) {
      updateAnalytics(
        {
          ...mockAnalysis,
          sessionId: `session-reject-${i}`,
          outcome: "rejected",
        },
        tempDir,
      );
    }
    updateAnalytics(
      {
        ...mockAnalysis,
        sessionId: "session-error",
        outcome: "error",
      },
      tempDir,
    );

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    // Should NOT have a hot spot pattern since only 2 rejected (not 3)
    const hotspotPattern = db.knownPatterns.find((p) =>
      p.pattern.startsWith("file_hotspot:src/server.ts"),
    );
    expect(hotspotPattern).toBeUndefined();
    expect(db.byFile["src/server.ts"].rejected).toBe(2);
    expect(db.byFile["src/server.ts"].runs).toBe(3);
  });

  it("should detect tag failure cluster (<50% success rate)", async () => {
    // Add 2 successes and 3 failures for same tag
    for (let i = 0; i < 2; i++) {
      updateAnalytics(
        {
          ...mockAnalysis,
          sessionId: `session-success-${i}`,
          outcome: "approved",
        },
        tempDir,
      );
    }
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          ...mockAnalysis,
          sessionId: `session-fail-${i}`,
          outcome: "rejected",
        },
        tempDir,
      );
    }

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.byTag["backend"].runs).toBe(5);
    expect(db.byTag["backend"].approved).toBe(2);
    expect(db.byTag["backend"].rate).toBe(0.4);

    const clusterPattern = db.knownPatterns.find((p) =>
      p.pattern.startsWith("tag_cluster:backend"),
    );
    expect(clusterPattern).toBeDefined();
  });

  it("should track feedback themes", async () => {
    updateAnalytics(
      {
        ...mockAnalysis,
        feedbackThemes: ["test_failures", "lint_errors"],
      },
      tempDir,
    );
    updateAnalytics(
      {
        ...mockAnalysis,
        sessionId: "session-002",
        feedbackThemes: ["test_failures"],
      },
      tempDir,
    );

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.topFeedbackThemes).toContainEqual({ theme: "test_failures", count: 2 });
    expect(db.topFeedbackThemes).toContainEqual({ theme: "lint_errors", count: 1 });
  });

  it("should classify complexity buckets correctly", async () => {
    updateAnalytics(
      { ...mockAnalysis, complexity: { filesToModify: 1, successCriteria: 3 } },
      tempDir,
    );

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.byComplexity.simple.runs).toBe(1);
  });

  it("should classify gate score buckets correctly", async () => {
    updateAnalytics({ ...mockAnalysis, gateScore: 3.2 }, tempDir);

    const analyticsPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(analyticsPath, "utf-8"));

    expect(db.byGateScore["3.0-3.5"]).toBeDefined();
    expect(db.byGateScore["3.0-3.5"].runs).toBe(1);
  });
});

describe("rebuildAnalyticsDB", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-rebuild-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createMockReader(
    sessions: SessionEntry[],
    eventsBySession: Record<string, QuackEvent[]> = {},
  ): EventReader {
    return {
      logDir: path.join(tempDir, ".quack", "logs"),
      getAllSessions: () => sessions,
      getExecutionSessions: () =>
        sessions.filter(
          (session) =>
            session.outcome !== "claimant_diagnostic" &&
            !session.sessionId.startsWith("quack-diagnostic-claimant-"),
        ),
      getSessionEvents: (sessionId: string) => eventsBySession[sessionId] ?? [],
    } as unknown as EventReader;
  }

  it("should rebuild DB from completed sessions", () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-01-01T00:00:00Z",
        status: "completed",
        outcome: "approved",
        totalCostUsd: 1.5,
      },
      {
        sessionId: "s2",
        taskId: "TASK-002",
        project: "test",
        startTime: "2026-01-02T00:00:00Z",
        status: "completed",
        outcome: "rejected",
        totalCostUsd: 2.0,
      },
    ];

    const reader = createMockReader(sessions);
    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    expect(fs.existsSync(dbPath)).toBe(true);

    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db.totalRuns).toBe(2);
    expect(db.totalApproved).toBe(1);
    expect(db.totalRejected).toBe(1);
    expect(db.totalErrors).toBe(0);
  });

  it("should skip active sessions without outcome", () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-01-01T00:00:00Z",
        status: "active",
      },
      {
        sessionId: "s2",
        taskId: "TASK-002",
        project: "test",
        startTime: "2026-01-02T00:00:00Z",
        status: "completed",
        outcome: "approved",
        totalCostUsd: 1.0,
      },
    ];

    const reader = createMockReader(sessions);
    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db.totalRuns).toBe(1);
    expect(db.totalApproved).toBe(1);
  });

  it("should extract gate score from session events", () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-01-01T00:00:00Z",
        status: "completed",
        outcome: "approved",
        totalCostUsd: 1.0,
      },
    ];

    const eventsBySession: Record<string, QuackEvent[]> = {
      s1: [
        {
          sessionId: "s1",
          taskId: "TASK-001",
          project: "test",
          timestamp: "2026-01-01T00:00:01Z",
          stage: "gate_depth",
          payload: { overallScore: 4.2 },
        },
      ],
    };

    const reader = createMockReader(sessions, eventsBySession);
    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db.byGateScore["4.0-4.5"]).toBeDefined();
    expect(db.byGateScore["4.0-4.5"].runs).toBe(1);
  });

  it("should count error outcomes correctly", () => {
    const sessions: SessionEntry[] = [
      {
        sessionId: "s1",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-01-01T00:00:00Z",
        status: "error",
        outcome: "error",
        totalCostUsd: 0.5,
      },
    ];

    const reader = createMockReader(sessions);
    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db.totalRuns).toBe(1);
    expect(db.totalErrors).toBe(1);
    expect(db.totalApproved).toBe(0);
    expect(db.totalRejected).toBe(0);
  });

  it("should produce empty DB when no sessions exist", () => {
    const reader = createMockReader([]);
    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db.totalRuns).toBe(0);
    expect(db.totalApproved).toBe(0);
    expect(db.knownPatterns).toEqual([]);
  });

  it("does not normalize a claimant diagnostic into an analytics error", () => {
    const reader = createMockReader([
      {
        sessionId: "quack-diagnostic-claimant-task-001-kind",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-08-18T00:00:00Z",
        status: "completed",
        outcome: "claimant_diagnostic",
      },
    ]);

    rebuildAnalyticsDB(reader, tempDir);

    const dbPath = path.join(tempDir, ".quack", "analytics", "failure-patterns.json");
    const db: FailurePatternDB = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(db).toMatchObject({ totalRuns: 0, totalErrors: 0 });
  });
});
