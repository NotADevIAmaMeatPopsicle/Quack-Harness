import type {
  CostSummaryResponse,
  FederationQueueResponse,
  QueueSummaryResponse,
  ReviewListResponse,
  SessionListResponse,
  TaskListResponse,
  TestingCommandsResponse,
  WorkflowStateResponse,
} from "../../src/monitor/api-contracts";

describe("dashboard API contracts", () => {
  it("accepts representative response shapes for major UI 2.0 endpoint groups", () => {
    const tasks: TaskListResponse = {
      tasks: [],
      parseErrors: [],
      parseWarnings: [],
      taskCount: 0,
      filteredTaskCount: 0,
      lastRefreshed: "2026-04-30T00:00:00.000Z",
      stale: false,
    };

    const sessions: SessionListResponse = {
      sessions: [],
      pagination: {
        page: 1,
        perPage: 50,
        totalItems: 0,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };

    const costs: CostSummaryResponse = {
      totalCostUsd: 0,
      sessionCount: 0,
      avgCostPerSession: 0,
      todayCostUsd: 0,
      last7DaysCostUsd: 0,
      last30DaysCostUsd: 0,
      byDay: [],
      byTask: [],
    };

    const queue: QueueSummaryResponse = {
      state: "idle",
      running: false,
      paused: false,
      activeTaskIds: [],
      config: {
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 5000,
        failurePropagation: "skip_dependents",
        fleetBudgetUsd: 0,
        pauseOnFailure: false,
        persistState: true,
        autoStartOnEnqueue: false,
      },
      stats: {
        total: 0,
        queued: 0,
        ready: 0,
        running: 0,
        awaitingApproval: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        stopped: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
      items: [],
    };

    const federation: FederationQueueResponse = {
      ok: true,
      jobs: [],
      listeners: [],
      summary: {
        total: 0,
        byStatus: {},
        mergeLaneActive: false,
        activeDispatchJobs: 0,
        activeDispatchByHost: {},
        hosts: [],
      },
    };

    const workflow: WorkflowStateResponse = {
      taskId: "TASK-001",
      state: "submitted",
    };

    const reviews: ReviewListResponse = {
      reviews: [],
    };

    const testing: TestingCommandsResponse = {
      commands: [],
    };

    expect({ tasks, sessions, costs, queue, federation, workflow, reviews, testing }).toBeTruthy();
  });
});
