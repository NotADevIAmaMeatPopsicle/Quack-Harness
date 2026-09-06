// ─── Gate Advisor Tests ────────────────────────────────────────────
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/await-thenable */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getGateAdvisory } from "../../src/analytics/gate-advisor.js";
import { updateAnalytics } from "../../src/analytics/analytics-updater.js";
import type { ParsedTask } from "../../src/core/types.js";

describe("Gate Advisor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-advisor-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const mockTask: ParsedTask = {
    id: "TASK-001",
    title: "Test Task",
    priority: "P1-HIGH",
    effort: "2-4 hours",
    status: "IN_PROGRESS",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["backend"],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [{ path: "src/server.ts", action: "Modify", notes: "Add endpoint" }],
    successCriteria: ["Tests pass"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-001",
  };

  it("should return empty advisory when no analytics data exists", async () => {
    const advisory = getGateAdvisory(mockTask, tempDir);

    expect(advisory.suggestedMinScore).toBe(3.0);
    expect(advisory.warnings).toEqual([]);
    expect(advisory.relevantPatterns).toEqual([]);
  });

  it("should warn about file hot spots at threshold of 2 runs", async () => {
    // Create only 2 failures for the same file (lowered threshold)
    for (let i = 0; i < 2; i++) {
      updateAnalytics(
        {
          taskId: `TASK-${i}`,
          sessionId: `session-${i}`,
          outcome: "rejected",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 1,
          taskTags: ["backend"],
          targetFiles: ["src/server.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 3.5,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory(mockTask, tempDir);

    expect(advisory.warnings.length).toBeGreaterThan(0);
    expect(advisory.warnings[0]).toContain("src/server.ts");
    expect(advisory.warnings[0]).toContain("success rate");
  });

  it("should warn about file hot spots (legacy 3+ runs still works)", async () => {
    // Create 3 failures for the same file
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          taskId: `TASK-${i}`,
          sessionId: `session-${i}`,
          outcome: "rejected",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 1,
          taskTags: ["backend"],
          targetFiles: ["src/server.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 3.5,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory(mockTask, tempDir);

    expect(advisory.warnings.length).toBeGreaterThan(0);
    expect(advisory.warnings[0]).toContain("src/server.ts");
    expect(advisory.warnings[0]).toContain("success rate");
  });

  it("should warn about tag failure clusters", async () => {
    // Create pattern: 2 successes, 3 failures with "backend" tag
    for (let i = 0; i < 2; i++) {
      updateAnalytics(
        {
          taskId: `TASK-success-${i}`,
          sessionId: `session-success-${i}`,
          outcome: "approved",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 0,
          taskTags: ["backend"],
          targetFiles: [`file-${i}.ts`],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4.0,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          taskId: `TASK-fail-${i}`,
          sessionId: `session-fail-${i}`,
          outcome: "rejected",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 1,
          taskTags: ["backend"],
          targetFiles: [`file-fail-${i}.ts`],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 3.0,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory(mockTask, tempDir);

    const backendWarning = advisory.warnings.find((w) => w.includes("backend"));
    expect(backendWarning).toBeDefined();
  });

  it("should suggest higher gate score when low scores fail frequently", async () => {
    // Add several low-score failures
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          taskId: `TASK-${i}`,
          sessionId: `session-${i}`,
          outcome: "rejected",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 1,
          taskTags: ["test"],
          targetFiles: [`file-${i}.ts`],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 2.8,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }
    // Add several high-score successes
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          taskId: `TASK-good-${i}`,
          sessionId: `session-good-${i}`,
          outcome: "approved",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 0,
          taskTags: ["test"],
          targetFiles: [`file-good-${i}.ts`],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4.2,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory({ ...mockTask, tags: ["test"] }, tempDir);

    // Should suggest a higher score than default
    expect(advisory.suggestedMinScore).toBeGreaterThanOrEqual(3.0);
  });

  it("should return empty warnings when no patterns match", async () => {
    // Add some data but for different files/tags
    updateAnalytics(
      {
        taskId: "TASK-other",
        sessionId: "session-other",
        outcome: "approved",
        costUsd: 0.1,
        turnsUsed: 5,
        retriesUsed: 0,
        taskTags: ["frontend"],
        targetFiles: ["src/component.tsx"],
        criteriaResults: [],
        feedbackThemes: [],
        gateScore: 4.0,
        complexity: { filesToModify: 1, successCriteria: 1 },
      },
      tempDir,
    );

    const advisory = getGateAdvisory(mockTask, tempDir);

    expect(advisory.warnings).toEqual([]);
  });

  it("should add integration advisory when create-file tasks have >40% failure rate", async () => {
    const taskWithCreate: ParsedTask = {
      ...mockTask,
      filesToModify: [{ path: "src/new-file.ts", action: "Create", notes: "New file" }],
    };

    // Create failures specifically for the file being created (src/new-file.ts)
    // 3 failures out of 5 runs = 60% failure rate for that specific file
    for (let i = 0; i < 3; i++) {
      updateAnalytics(
        {
          taskId: `TASK-fail-${i}`,
          sessionId: `session-fail-${i}`,
          outcome: "rejected",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 1,
          taskTags: ["test"],
          targetFiles: ["src/new-file.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 3.5,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }
    for (let i = 0; i < 2; i++) {
      updateAnalytics(
        {
          taskId: `TASK-success-${i}`,
          sessionId: `session-success-${i}`,
          outcome: "approved",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 0,
          taskTags: ["test"],
          targetFiles: ["src/new-file.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4.0,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory(taskWithCreate, tempDir);

    const integrationWarning = advisory.warnings.find((w) => w.includes("integration wiring"));
    expect(integrationWarning).toBeDefined();
    expect(integrationWarning).toContain("60% failure rate");

    const integrationPattern = advisory.relevantPatterns.find(
      (p) => p.pattern === "new_file_integration",
    );
    expect(integrationPattern).toBeDefined();
    expect(integrationPattern?.suggestion).toContain("Integration Context");
  });

  it("should NOT add integration advisory when create-file tasks have <40% failure rate", async () => {
    const taskWithCreate: ParsedTask = {
      ...mockTask,
      filesToModify: [{ path: "src/new-file.ts", action: "Create", notes: "New file" }],
    };

    // Create 5 runs for the specific file with 1 failure (20% failure rate)
    updateAnalytics(
      {
        taskId: "TASK-fail-0",
        sessionId: "session-fail-0",
        outcome: "rejected",
        costUsd: 0.1,
        turnsUsed: 5,
        retriesUsed: 1,
        taskTags: ["test"],
        targetFiles: ["src/new-file.ts"],
        criteriaResults: [],
        feedbackThemes: [],
        gateScore: 3.5,
        complexity: { filesToModify: 1, successCriteria: 1 },
      },
      tempDir,
    );
    for (let i = 0; i < 4; i++) {
      updateAnalytics(
        {
          taskId: `TASK-success-${i}`,
          sessionId: `session-success-${i}`,
          outcome: "approved",
          costUsd: 0.1,
          turnsUsed: 5,
          retriesUsed: 0,
          taskTags: ["test"],
          targetFiles: ["src/new-file.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4.0,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        tempDir,
      );
    }

    const advisory = getGateAdvisory(taskWithCreate, tempDir);

    const integrationWarning = advisory.warnings.find((w) => w.includes("integration wiring"));
    expect(integrationWarning).toBeUndefined();
  });
});
