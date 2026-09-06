import type { AutoPrepConfig } from "../../src/core/types";
import type { PrepWorker, PrepJob } from "../../src/monitor/prep-worker";
import type { PrepCache } from "../../src/monitor/prep-cache";
import type { TaskService, TaskSummary } from "../../src/monitor/task-service";
import type { EventStage, EventPayload } from "../../src/monitor/event-types";
import { PrepScheduler } from "../../src/monitor/prep-scheduler";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  const status = overrides.status ?? "READY";
  return {
    id: "TASK-001",
    title: "Test task",
    priority: "P2-MEDIUM",
    effort: "M",
    status,
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    effectiveStatus: overrides.effectiveStatus ?? status,
    blockedBy: [],
    blocks: [],
    tags: [],
    successCriteriaCount: 3,
    needsVerification: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AutoPrepConfig> = {}): AutoPrepConfig {
  return {
    enabled: true,
    maxConcurrent: 2,
    cooldownSeconds: 30,
    maxPerHour: 10,
    maxBudgetPerHour: 1.0,
    priorityOrder: "priority_then_id",
    skipPrepped: true,
    ...overrides,
  };
}

function makeJob(taskId: string, overrides: Partial<PrepJob> = {}): PrepJob {
  return {
    taskId,
    pid: 12345,
    startedAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

// ─── Mock factories ──────────────────────────────────────────────────

function createMockPrepWorker(): jest.Mocked<
  Pick<PrepWorker, "start" | "getActiveJob" | "getActiveJobs" | "getJob" | "killAll">
> {
  return {
    start: jest.fn(),
    getActiveJob: jest.fn().mockReturnValue(undefined),
    getActiveJobs: jest.fn().mockReturnValue([]),
    getJob: jest.fn().mockReturnValue(undefined),
    killAll: jest.fn(),
  };
}

function createMockPrepCache(): jest.Mocked<Pick<PrepCache, "exists" | "read" | "invalidate">> {
  return {
    exists: jest.fn().mockReturnValue(false),
    read: jest.fn().mockResolvedValue(null),
    invalidate: jest.fn().mockResolvedValue(false),
  };
}

function createMockTaskService(): jest.Mocked<Pick<TaskService, "listTasks" | "getTask">> {
  return {
    listTasks: jest.fn().mockResolvedValue({ tasks: [], parseErrors: [], parseWarnings: [] }),
    getTask: jest.fn().mockResolvedValue(null),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("PrepScheduler", () => {
  let worker: ReturnType<typeof createMockPrepWorker>;
  let cache: ReturnType<typeof createMockPrepCache>;
  let taskService: ReturnType<typeof createMockTaskService>;
  let config: AutoPrepConfig;
  let events: Array<{ stage: EventStage; payload: EventPayload }>;
  let onEvent: (stage: EventStage, payload: EventPayload) => void;

  beforeEach(() => {
    jest.useFakeTimers();

    worker = createMockPrepWorker();
    cache = createMockPrepCache();
    taskService = createMockTaskService();
    config = makeConfig();
    events = [];
    onEvent = (stage, payload) => events.push({ stage, payload });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createScheduler(configOverrides?: Partial<AutoPrepConfig>): PrepScheduler {
    const merged = configOverrides ? makeConfig(configOverrides) : config;
    return new PrepScheduler(
      worker as unknown as PrepWorker,
      cache as unknown as PrepCache,
      taskService as unknown as TaskService,
      merged,
      onEvent,
    );
  }

  // ─── start() ─────────────────────────────────────────────────────

  describe("start()", () => {
    it("scans tasks, builds queue, and starts processing", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "BACKLOG" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler();
      await scheduler.start();

      expect(taskService.listTasks).toHaveBeenCalledTimes(1);
      expect(scheduler.isRunning()).toBe(true);

      // Should emit auto_prep_started with queueSize
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "auto_prep_started",
          payload: { queueSize: 2 },
        }),
      );

      // Should have started processing the first task
      expect(worker.start).toHaveBeenCalled();
    });

    it("skips already prepped tasks when skipPrepped=true", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      cache.exists.mockImplementation((id: string) => id === "TASK-001");
      worker.start.mockReturnValue(makeJob("TASK-002"));

      const scheduler = createScheduler({ skipPrepped: true });
      await scheduler.start();

      // Queue should only have TASK-002 since TASK-001 is already prepped
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "auto_prep_started",
          payload: { queueSize: 1 },
        }),
      );
    });

    it("skips COMPLETE tasks", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "COMPLETE" }),
        makeTask({ id: "TASK-002", status: "READY" }),
        makeTask({ id: "TASK-003", status: "COMPLETE" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-002"));

      const scheduler = createScheduler({ skipPrepped: false });
      await scheduler.start();

      // Only TASK-002 should be in the queue
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "auto_prep_started",
          payload: { queueSize: 1 },
        }),
      );
    });

    it("skips stale automation-blocked tasks", async () => {
      const tasks = [
        makeTask({
          id: "TASK-001",
          status: "READY",
          backlogHygiene: {
            dispatchBlocked: true,
            reasons: [{ code: "superseded", message: "superseded" }],
          },
        }),
        makeTask({
          id: "TASK-002",
          status: "ON_HOLD",
          backlogHygiene: {
            dispatchBlocked: true,
            reasons: [{ code: "status_on_hold", message: "on hold" }],
          },
        }),
        makeTask({ id: "TASK-003", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-003"));

      const scheduler = createScheduler();
      await scheduler.start();

      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "auto_prep_started",
          payload: { queueSize: 1 },
        }),
      );
      expect(worker.start).toHaveBeenCalledWith("TASK-003");
    });

    it("surfaces parse errors while still queuing valid tasks", async () => {
      const tasks = [makeTask({ id: "TASK-001", status: "READY" })];
      const parseErrors = [{ file: "TASK-999-bad.md", error: "Missing required field: status" }];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors, parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler({ skipPrepped: false });
      await scheduler.start();

      expect(scheduler.getStatus()).toEqual(
        expect.objectContaining({
          parseErrorCount: 1,
          parseErrors,
        }),
      );
      const parseErrorEvent = events.find((event) => event.stage === "auto_prep_parse_errors");
      expect(parseErrorEvent).toBeDefined();
      expect(parseErrorEvent?.payload).toEqual({
        parseErrorCount: 1,
        parseErrors,
      });
      expect(worker.start).toHaveBeenCalled();
    });

    it("is idempotent (calling twice does nothing extra)", async () => {
      const tasks = [makeTask({ id: "TASK-001", status: "READY" })];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler();
      await scheduler.start();
      await scheduler.start(); // second call

      // listTasks should only be called once
      expect(taskService.listTasks).toHaveBeenCalledTimes(1);
    });
  });

  // ─── stop() ───────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stops the scheduler and clears timers", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // Return running job so a poll timer is started
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler();
      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);

      // Should emit auto_prep_paused
      const pausedEvent = events.find((e) => e.stage === "auto_prep_paused");
      expect(pausedEvent).toBeDefined();
      expect(pausedEvent!.payload).toEqual(expect.objectContaining({ reason: "stopped" }));
    });

    it("is idempotent (calling twice does nothing extra)", async () => {
      const tasks = [makeTask({ id: "TASK-001", status: "READY" })];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler();
      await scheduler.start();

      scheduler.stop();
      const pausedCount = events.filter((e) => e.stage === "auto_prep_paused").length;

      scheduler.stop(); // second call
      const pausedCountAfter = events.filter((e) => e.stage === "auto_prep_paused").length;

      // Should not emit a second paused event
      expect(pausedCountAfter).toBe(pausedCount);
    });
  });

  // ─── isRunning() ──────────────────────────────────────────────────

  describe("isRunning()", () => {
    it("returns correct state before and after start/stop", async () => {
      const tasks = [makeTask({ id: "TASK-001", status: "READY" })];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));

      const scheduler = createScheduler();

      expect(scheduler.isRunning()).toBe(false);

      await scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // ─── getStatus() ──────────────────────────────────────────────────

  describe("getStatus()", () => {
    it("returns proper status object", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });
      worker.start.mockReturnValue(makeJob("TASK-001"));
      worker.getActiveJobs.mockReturnValue([makeJob("TASK-001")]);

      const scheduler = createScheduler();
      await scheduler.start();

      const status = scheduler.getStatus();

      expect(status).toEqual(
        expect.objectContaining({
          enabled: true,
          running: true,
          activePreps: 1,
          maxPerHour: 10,
          maxBudgetPerHour: 1.0,
          totalProcessed: 0,
        }),
      );
      // queueSize should reflect tasks remaining after dequeue
      expect(typeof status.queueSize).toBe("number");
      expect(typeof status.prepsThisHour).toBe("number");
      expect(typeof status.costThisHour).toBe("number");
    });
  });

  // ─── getQueue() ───────────────────────────────────────────────────

  describe("getQueue()", () => {
    it("returns ordered task IDs", async () => {
      const tasks = [
        makeTask({ id: "TASK-003", status: "READY", priority: "P3-LOW" }),
        makeTask({ id: "TASK-001", status: "READY", priority: "P0-CRITICAL" }),
        makeTask({ id: "TASK-002", status: "READY", priority: "P1-HIGH" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // Block processing so all tasks stay in queue
      worker.getActiveJobs.mockReturnValue([makeJob("TASK-X")]);
      // maxConcurrent=1 so the concurrent limit will block immediately
      const scheduler = createScheduler({ maxConcurrent: 1 });
      await scheduler.start();

      const queue = scheduler.getQueue();

      // With priority_then_id order: P0 first, then P1, then P3
      // TASK-001 was dequeued but blocked at concurrent check,
      // actually scheduleNext will still dequeue before checking limits...
      // Let's verify the queue contains task IDs in priority order
      // Since the concurrent limit blocks BEFORE dequeue, the queue should be intact
      // Actually: scheduleNext checks rate limits first, then dequeues
      // Wait — no: looking at the code, rate limits are checked first, and if blocked,
      // no dequeue happens. So all three should be in queue.
      expect(queue).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    });
  });

  // ─── updateConfig() ───────────────────────────────────────────────

  describe("updateConfig()", () => {
    it("updates config and re-sorts queue", async () => {
      const tasks = [
        makeTask({ id: "TASK-002", status: "READY", priority: "P1-HIGH" }),
        makeTask({
          id: "TASK-001",
          status: "READY",
          priority: "P3-LOW",
          blockedBy: [],
        }),
        makeTask({
          id: "TASK-003",
          status: "READY",
          priority: "P0-CRITICAL",
          blockedBy: ["TASK-001"],
        }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // Block processing at concurrent limit
      worker.getActiveJobs.mockReturnValue([makeJob("X")]);
      const scheduler = createScheduler({
        maxConcurrent: 1,
        priorityOrder: "priority_then_id",
      });
      await scheduler.start();

      // Before update: priority_then_id => TASK-003 (P0), TASK-002 (P1), TASK-001 (P3)
      expect(scheduler.getQueue()).toEqual(["TASK-003", "TASK-002", "TASK-001"]);

      // Switch to dependency_chain: unblocked first
      scheduler.updateConfig(makeConfig({ priorityOrder: "dependency_chain" }));

      // dependency_chain: unblocked first => TASK-002 (P1, no blockers), TASK-001 (P3, no blockers),
      // then TASK-003 (P0, has blocker)
      const reordered = scheduler.getQueue();
      expect(reordered).toEqual(["TASK-002", "TASK-001", "TASK-003"]);
    });
  });

  // ─── Rate limiting: concurrent ────────────────────────────────────

  describe("rate limit: concurrent", () => {
    it("blocks when maxConcurrent is reached", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // Simulate maxConcurrent already reached
      worker.getActiveJobs.mockReturnValue([makeJob("TASK-X")]);

      const scheduler = createScheduler({ maxConcurrent: 1 });
      await scheduler.start();

      // Should NOT have called start since concurrent limit hit
      expect(worker.start).not.toHaveBeenCalled();

      // Should emit rate_limited event
      const rateLimited = events.find((e) => e.stage === "auto_prep_rate_limited");
      expect(rateLimited).toBeDefined();
      expect(rateLimited!.payload).toEqual(expect.objectContaining({ limitType: "concurrent" }));
    });
  });

  // ─── Rate limiting: cooldown ──────────────────────────────────────

  describe("rate limit: cooldown", () => {
    it("waits cooldownSeconds between preps", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // First prep starts successfully
      worker.start.mockReturnValueOnce(makeJob("TASK-001"));
      // After first job completes, the scheduler will try to schedule next
      // Simulate the first job completing: getJob returns completed
      worker.getJob.mockImplementation((id: string) => {
        if (id === "TASK-001") {
          return makeJob("TASK-001", { status: "completed" });
        }
        return undefined;
      });

      const scheduler = createScheduler({ cooldownSeconds: 60 });
      await scheduler.start();

      // First task should have started
      expect(worker.start).toHaveBeenCalledWith("TASK-001");

      // Advance past the poll interval to trigger completion detection
      jest.advanceTimersByTime(2000);

      // Now scheduleNext fires again for TASK-002 but cooldown should block it
      // because the last prep started < 60s ago
      const rateLimited = events.find(
        (e) =>
          e.stage === "auto_prep_rate_limited" &&
          (e.payload as { limitType: string }).limitType === "cooldown",
      );
      expect(rateLimited).toBeDefined();
    });
  });

  // ─── Rate limiting: hourly count ──────────────────────────────────

  describe("rate limit: hourly count", () => {
    it("blocks at maxPerHour", async () => {
      // Set maxPerHour=1, and have already started one task
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // First job starts and immediately completes
      worker.start.mockReturnValueOnce(makeJob("TASK-001"));
      worker.getJob.mockImplementation((id: string) => {
        if (id === "TASK-001") {
          return makeJob("TASK-001", { status: "completed" });
        }
        return undefined;
      });

      const scheduler = createScheduler({
        maxPerHour: 1,
        cooldownSeconds: 0, // Disable cooldown so hourly count is the binding limit
      });
      await scheduler.start();

      // First task starts
      expect(worker.start).toHaveBeenCalledWith("TASK-001");

      // Poll timer fires, detects completion, scheduleNext runs
      jest.advanceTimersByTime(2000);

      // Now the hourly count should block TASK-002
      const rateLimited = events.find(
        (e) =>
          e.stage === "auto_prep_rate_limited" &&
          (e.payload as { limitType: string }).limitType === "hourly_count",
      );
      expect(rateLimited).toBeDefined();

      // worker.start should have been called only once (for TASK-001)
      expect(worker.start).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Rate limiting: budget ────────────────────────────────────────

  describe("rate limit: budget", () => {
    it("blocks at maxBudgetPerHour", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // First job starts and completes with a result (which triggers cost recording)
      worker.start.mockReturnValueOnce(makeJob("TASK-001"));
      worker.getJob.mockImplementation((id: string) => {
        if (id === "TASK-001") {
          return makeJob("TASK-001", {
            status: "completed",
            result: {
              schemaValid: true,
              schemaErrors: [],
              depthScore: 4,
              depthReady: true,
              deficiencies: [],
              outcome: "pass",
            },
          });
        }
        return undefined;
      });

      // Set budget to 0 so even the first recorded cost (0) would still be at the limit
      // Actually, the code pushes 0 as cost. To trigger budget exceeded we need
      // maxBudgetPerHour=0 (any cost >= 0 triggers it)
      const scheduler = createScheduler({
        maxBudgetPerHour: 0,
        cooldownSeconds: 0,
        maxPerHour: 100, // high so hourly count doesn't trigger first
      });
      await scheduler.start();

      // First task starts (budget is checked before start, and at that point
      // prepCosts is empty so sum is 0, and 0 >= 0 triggers the budget block)
      // Actually: the initial check has hourlyCost=0 and maxBudgetPerHour=0,
      // and the check is hourlyCost >= maxBudgetPerHour, so 0 >= 0 = true.
      // This means even the first task gets blocked.

      const budgetEvent = events.find((e) => e.stage === "auto_prep_budget_exceeded");
      expect(budgetEvent).toBeDefined();
      expect(budgetEvent!.payload).toEqual(
        expect.objectContaining({
          hourlySpend: 0,
          hourlyLimit: 0,
        }),
      );
    });
  });

  // ─── Event emission ───────────────────────────────────────────────

  describe("event emission", () => {
    it("emits correct events via callback", async () => {
      // Empty task list => queue is empty immediately => emits queue_empty
      taskService.listTasks.mockResolvedValue({ tasks: [], parseErrors: [], parseWarnings: [] });

      const scheduler = createScheduler();
      await scheduler.start();

      const stages = events.map((e) => e.stage);

      // Should emit auto_prep_started (with queueSize 0) followed by
      // auto_prep_queue_empty since there are no tasks
      expect(stages).toContain("auto_prep_started");
      expect(stages).toContain("auto_prep_queue_empty");

      const startedPayload = events.find((e) => e.stage === "auto_prep_started")!.payload as {
        queueSize: number;
      };
      expect(startedPayload.queueSize).toBe(0);

      const emptyPayload = events.find((e) => e.stage === "auto_prep_queue_empty")!.payload as {
        totalProcessed: number;
      };
      expect(emptyPayload.totalProcessed).toBe(0);
    });

    it("emits auto_prep_paused with queue remaining count on stop", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
        makeTask({ id: "TASK-003", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // Block at concurrent limit so tasks stay in queue
      worker.getActiveJobs.mockReturnValue([makeJob("X")]);

      const scheduler = createScheduler({ maxConcurrent: 1 });
      await scheduler.start();

      scheduler.stop();

      const pausedEvent = events.find((e) => e.stage === "auto_prep_paused");
      expect(pausedEvent).toBeDefined();
      expect(pausedEvent!.payload).toEqual(
        expect.objectContaining({
          reason: "stopped",
          queueRemaining: 3,
        }),
      );
    });

    it("does not emit when no callback is provided", async () => {
      taskService.listTasks.mockResolvedValue({ tasks: [], parseErrors: [], parseWarnings: [] });

      // Create scheduler without an event callback
      const scheduler = new PrepScheduler(
        worker as unknown as PrepWorker,
        cache as unknown as PrepCache,
        taskService as unknown as TaskService,
        config,
        // no onEvent
      );

      // Should not throw
      await scheduler.start();
      scheduler.stop();
    });
  });

  // ─── Queue drains and sets running=false ──────────────────────────

  describe("queue drain", () => {
    it("sets running=false when queue is empty", async () => {
      taskService.listTasks.mockResolvedValue({ tasks: [], parseErrors: [], parseWarnings: [] });

      const scheduler = createScheduler();
      await scheduler.start();

      // Empty queue triggers scheduleNext -> queue empty -> running = false
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // ─── Skips tasks already running ──────────────────────────────────

  describe("skip already running tasks", () => {
    it("skips a task that is already running and continues to next", async () => {
      const tasks = [
        makeTask({ id: "TASK-001", status: "READY" }),
        makeTask({ id: "TASK-002", status: "READY" }),
      ];
      taskService.listTasks.mockResolvedValue({ tasks, parseErrors: [], parseWarnings: [] });

      // TASK-001 is already actively running
      worker.getActiveJob.mockImplementation((id: string) =>
        id === "TASK-001" ? makeJob("TASK-001") : undefined,
      );
      worker.start.mockReturnValue(makeJob("TASK-002"));

      const scheduler = createScheduler({ cooldownSeconds: 0 });
      await scheduler.start();

      // Should skip TASK-001 and start TASK-002
      expect(worker.start).toHaveBeenCalledWith("TASK-002");
      expect(worker.start).not.toHaveBeenCalledWith("TASK-001");
    });
  });
});
