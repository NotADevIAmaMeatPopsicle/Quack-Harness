import type { ParsedTask } from "../../src/core/types";
import { buildTaskProjection } from "../../src/monitor/task-projection";

const baseTask = (overrides: Partial<ParsedTask> = {}): ParsedTask => ({
  id: "TASK-001",
  title: "Projection Test",
  priority: "P1-HIGH",
  effort: "2-4 hours",
  status: "READY",
  blockedBy: ["TASK-000"],
  blocks: ["TASK-002"],
  conventions: [],
  tags: ["ui"],
  problemStatement: "Need projection.",
  currentState: "",
  recommendedApproach: "",
  filesToModify: [],
  successCriteria: ["Projection exists", "Projection is stable"],
  testingRequirements: ["Unit tests"],
  contextReferences: [],
  supersededBy: [],
  supersedes: [],
  relevanceReview: "",
  rawContent: "# TASK-001",
  ...overrides,
});

describe("buildTaskProjection", () => {
  it("uses file status when there is no fresher state", () => {
    const projection = buildTaskProjection(baseTask());

    expect(projection.effectiveStatus).toBe("READY");
    expect(projection.statusSource).toBe("file");
    expect(projection.dependencyCount).toBe(2);
    expect(projection.successCriteriaCount).toBe(2);
    expect(projection.needsVerification).toBe(false);
  });

  it("upgrades approved session state and marks unverified approvals", () => {
    const projection = buildTaskProjection(baseTask(), {
      session: { outcome: "approved", costUsd: 1.25, status: "completed" },
    });

    expect(projection.effectiveStatus).toBe("COMPLETE");
    expect(projection.statusSource).toBe("session");
    expect(projection.needsVerification).toBe(true);
    expect(projection.lastOutcome).toBe("approved");
    expect(projection.lastCostUsd).toBe(1.25);
  });

  it("lets DB status overlays take precedence over session-derived state", () => {
    const projection = buildTaskProjection(baseTask(), {
      session: { outcome: "approved", costUsd: 1.25, status: "completed" },
      dbStatus: {
        task_id: "TASK-001",
        status: "ON_HOLD",
        updated_at: "2026-04-30T00:00:00.000Z",
        updated_by: "dashboard",
        previous_status: "READY",
      },
    });

    expect(projection.effectiveStatus).toBe("ON_HOLD");
    expect(projection.statusSource).toBe("db");
    expect(projection.needsVerification).toBe(true);
  });

  it("does not mark approved sessions as needing verification when verified", () => {
    const projection = buildTaskProjection(baseTask(), {
      session: { outcome: "approved", costUsd: 1.25, status: "completed" },
      verifiedIndex: {
        "TASK-001": {
          verified: "2026-04-30T00:00:00.000Z",
          commit: "abc123",
          method: "verify-task",
          verdict: "VERIFIED",
          criteriaChecked: 2,
          criteriaPassed: 2,
          notes: "",
        },
      },
    });

    expect(projection.needsVerification).toBe(false);
  });
});
