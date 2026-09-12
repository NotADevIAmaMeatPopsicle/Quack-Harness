import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { DispatchQueueConfig } from "../../src/queue/queue-types";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import type { TaskService, TaskSummary } from "../../src/monitor/task-service";
import type { EventReader } from "../../src/monitor/event-reader";
import type { SessionEntry } from "../../src/monitor/event-types";
import type { ParsedTask } from "../../src/core/types";
import type { DecompositionDispatchAdmission } from "../../src/preflight/decomposition-transaction-journal";

// ─── Mock Helpers ──────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-dq-"));
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function makeConfig(overrides: Partial<DispatchQueueConfig> = {}): DispatchQueueConfig {
  return {
    maxConcurrent: 1,
    cooldownBetweenTasksMs: 0,
    failurePropagation: "skip_dependents",
    fleetBudgetUsd: 0,
    pauseOnFailure: false,
    persistState: false,
    autoStartOnEnqueue: false,
    ...overrides,
  };
}

function makeJob(taskId: string, status: DispatchJob["status"] = "running"): DispatchJob {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    pid: 12345,
    startedAt: new Date().toISOString(),
    status,
    output: [],
  };
}

function makeTaskSummary(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    title: `Task ${id}`,
    priority: "P2-MEDIUM",
    effort: "M",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    effectiveStatus: "BACKLOG",
    blockedBy: [],
    blocks: [],
    tags: [],
    successCriteriaCount: 1,
    needsVerification: false,
    ...overrides,
  };
}

function makeParsedTask(id: string, overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id,
    title: `Task ${id}`,
    priority: "P2-MEDIUM",
    effort: "M",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [],
    successCriteria: ["works"],
    testingRequirements: ["tests pass"],
    contextReferences: [],
    rawContent: "",
    ...overrides,
  };
}

function createMockDispatchManager(): jest.Mocked<
  Pick<DispatchManager, "start" | "stop" | "getActiveJob" | "getJob" | "getActiveJobs">
> {
  return {
    start: jest.fn().mockReturnValue(makeJob("TASK-001")),
    stop: jest.fn().mockReturnValue(true),
    getActiveJob: jest.fn().mockReturnValue(undefined),
    getJob: jest.fn().mockReturnValue(undefined),
    getActiveJobs: jest.fn().mockReturnValue([]),
  };
}

function createMockTaskService(
  taskDir: string,
): jest.Mocked<Pick<TaskService, "listTasks" | "getTask" | "getTaskDirectory">> {
  return {
    listTasks: jest.fn().mockResolvedValue({ tasks: [], parseErrors: [], parseWarnings: [] }),
    getTask: jest.fn().mockResolvedValue(null),
    getTaskDirectory: jest.fn().mockReturnValue(taskDir),
  };
}

function createMockEventReader(): jest.Mocked<
  Pick<EventReader, "getAllSessions" | "getExecutionSessions" | "getSessionEvents">
> {
  return {
    getAllSessions: jest.fn().mockReturnValue([]),
    getExecutionSessions: jest.fn().mockReturnValue([]),
    getSessionEvents: jest.fn().mockReturnValue([]),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("DispatchQueue", () => {
  let tmpDir: string;
  let dispatchManager: ReturnType<typeof createMockDispatchManager>;
  let taskService: ReturnType<typeof createMockTaskService>;
  let eventReader: ReturnType<typeof createMockEventReader>;
  let events: Array<{ stage: string; taskId: string; payload: Record<string, unknown> }>;
  let activeQueue: DispatchQueue | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir();
    dispatchManager = createMockDispatchManager();
    taskService = createMockTaskService(tmpDir);
    eventReader = createMockEventReader();
    events = [];
    activeQueue = null;
  });

  afterEach(() => {
    if (activeQueue) {
      activeQueue.abort();
      activeQueue = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function createQueue(
    configOverrides: Partial<DispatchQueueConfig> = {},
    dispatchAdmissionFence?: <T>(
      taskId: string,
      dispatch: (admission: DecompositionDispatchAdmission) => T,
    ) => Promise<T>,
  ): DispatchQueue {
    const queue = new DispatchQueue(
      dispatchManager as unknown as DispatchManager,
      taskService as unknown as TaskService,
      eventReader as unknown as EventReader,
      makeConfig(configOverrides),
      tmpDir,
      (stage, taskId, payload) => {
        events.push({ stage, taskId, payload });
      },
      undefined,
      dispatchAdmissionFence,
    );
    activeQueue = queue;
    return queue;
  }

  // ─── Enqueue Tests ─────────────────────────────────────────────

  describe("enqueue", () => {
    it("creates QueueItem with correct fields", () => {
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      const queue = createQueue();

      const item = queue.enqueue("TASK-001");

      expect(item.taskId).toBe("TASK-001");
      expect(item.status).toBe("queued");
      expect(item.retryCount).toBe(0);
      expect(item.enqueuedAt).toBeDefined();
      expect(typeof item.enqueuedAt).toBe("string");
    });

    it("throws if task is already in the queue", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      expect(() => queue.enqueue("TASK-001")).toThrow("already in the queue");
    });

    it("throws if task is already running outside the queue", () => {
      dispatchManager.getActiveJob.mockReturnValue(makeJob("TASK-001"));
      const queue = createQueue();

      expect(() => queue.enqueue("TASK-001")).toThrow("already running");
    });

    it("emits dispatch_queue_task_enqueued event", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      const enqueueEvent = events.find((e) => e.stage === "dispatch_queue_task_enqueued");
      expect(enqueueEvent).toBeDefined();
      expect(enqueueEvent!.taskId).toBe("TASK-001");
    });
  });

  describe("enqueueMultiple", () => {
    it("adds all items, no duplicates", () => {
      const queue = createQueue();

      const items = queue.enqueueMultiple(["TASK-001", "TASK-002", "TASK-003"]);

      expect(items).toHaveLength(3);
      expect(queue.getItems()).toHaveLength(3);
    });

    it("skips already-queued tasks and returns existing item", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      const items = queue.enqueueMultiple(["TASK-001", "TASK-002"]);

      expect(items).toHaveLength(2);
      expect(queue.getItems()).toHaveLength(2);
    });
  });

  describe("enqueueAllEligible", () => {
    it("adds only BACKLOG tasks with met dependencies", async () => {
      taskService.listTasks.mockResolvedValue({
        tasks: [
          makeTaskSummary("TASK-001", { effectiveStatus: "BACKLOG", blockedBy: [] }),
          makeTaskSummary("TASK-002", { effectiveStatus: "BACKLOG", blockedBy: ["TASK-001"] }),
          makeTaskSummary("TASK-003", { effectiveStatus: "COMPLETE", blockedBy: [] }),
          makeTaskSummary("TASK-004", { effectiveStatus: "BACKLOG", blockedBy: [] }),
        ],
        parseErrors: [],
        parseWarnings: [],
      });

      const queue = createQueue();
      const items = await queue.enqueueAllEligible();

      // TASK-001 and TASK-004 are eligible (BACKLOG, no unmet deps)
      // TASK-002 has unmet dep (TASK-001 not COMPLETE), TASK-003 is COMPLETE
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.taskId)).toContain("TASK-001");
      expect(items.map((i) => i.taskId)).toContain("TASK-004");
    });

    it("skips backlog tasks suppressed by backlog hygiene", async () => {
      taskService.listTasks.mockResolvedValue({
        tasks: [
          makeTaskSummary("TASK-001", {
            effectiveStatus: "BACKLOG",
            backlogHygiene: {
              dispatchBlocked: true,
              reasons: [{ code: "superseded", message: "superseded" }],
            },
          }),
          makeTaskSummary("TASK-002", {
            status: "ON_HOLD",
            effectiveStatus: "BACKLOG",
            backlogHygiene: {
              dispatchBlocked: true,
              reasons: [{ code: "status_on_hold", message: "on hold" }],
            },
          }),
          makeTaskSummary("TASK-003", { effectiveStatus: "BACKLOG" }),
        ],
        parseErrors: [],
        parseWarnings: [],
      });

      const queue = createQueue();
      const items = await queue.enqueueAllEligible();

      expect(items.map((item) => item.taskId)).toEqual(["TASK-003"]);
    });
  });

  // ─── Dependency Resolution Tests ──────────────────────────────

  describe("dependency resolution", () => {
    it("task with no dependencies enriched as ready", async () => {
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001", { blockedBy: [] }));

      const queue = createQueue();
      queue.enqueue("TASK-001");

      // Wait for async enrichment
      await new Promise((r) => setTimeout(r, 50));

      const item = queue.getItem("TASK-001");
      expect(item).toBeDefined();
      expect(item!.status).toBe("ready");
    });

    it("task with unmet dependencies stays queued", async () => {
      taskService.getTask.mockResolvedValue(
        makeParsedTask("TASK-002", { blockedBy: ["TASK-001"] }),
      );

      const queue = createQueue();
      queue.enqueue("TASK-002");

      await new Promise((r) => setTimeout(r, 50));

      const item = queue.getItem("TASK-002");
      expect(item).toBeDefined();
      expect(item!.status).toBe("queued");
      expect(item!.blockedBy).toContain("TASK-001");
    });

    it("external dependency already COMPLETE is excluded from blockedBy", async () => {
      // TASK-001 is already complete in session history
      eventReader.getExecutionSessions.mockReturnValue([
        {
          sessionId: "s1",
          taskId: "TASK-001",
          project: "test",
          startTime: "2024-01-01",
          status: "completed",
          outcome: "approved",
        } as SessionEntry,
      ]);
      taskService.getTask.mockResolvedValue(
        makeParsedTask("TASK-002", { blockedBy: ["TASK-001"] }),
      );

      const queue = createQueue();
      queue.enqueue("TASK-002");

      await new Promise((r) => setTimeout(r, 50));

      const item = queue.getItem("TASK-002");
      expect(item).toBeDefined();
      // TASK-001 is already complete, so blockedBy should be empty and status ready
      expect(item!.blockedBy).toEqual([]);
      expect(item!.status).toBe("ready");
    });

    it("file-level VERIFIED dependency is excluded from blockedBy even without a session", async () => {
      taskService.listTasks.mockResolvedValue({
        tasks: [
          makeTaskSummary("TASK-001", { effectiveStatus: "VERIFIED", status: "VERIFIED" }),
          makeTaskSummary("TASK-002", { effectiveStatus: "BACKLOG", blockedBy: ["TASK-001"] }),
        ],
        parseErrors: [],
        parseWarnings: [],
      });
      taskService.getTask.mockResolvedValue(
        makeParsedTask("TASK-002", { blockedBy: ["TASK-001"] }),
      );

      const queue = createQueue();
      queue.enqueue("TASK-002");

      await new Promise((r) => setTimeout(r, 50));

      const item = queue.getItem("TASK-002");
      expect(item).toBeDefined();
      expect(item!.blockedBy).toEqual([]);
      expect(item!.status).toBe("ready");
    });

    it("ignores an older retained diagnostic that would overwrite a later approved execution", async () => {
      const approved = {
        sessionId: "execution-approved",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-08-18T10:00:00.000Z",
        status: "completed",
        outcome: "approved",
      } as SessionEntry;
      const diagnostic = {
        sessionId: "quack-diagnostic-claimant-task-001-older",
        taskId: "TASK-001",
        project: "test",
        startTime: "2026-08-18T09:00:00.000Z",
        status: "completed",
        outcome: "claimant_diagnostic",
      } as SessionEntry;
      eventReader.getAllSessions.mockReturnValue([approved, diagnostic]);
      eventReader.getExecutionSessions.mockReturnValue([approved]);
      taskService.getTask.mockResolvedValue(
        makeParsedTask("TASK-002", { blockedBy: ["TASK-001"] }),
      );

      const queue = createQueue();
      queue.enqueue("TASK-002");
      await new Promise((r) => setTimeout(r, 50));

      const legacyMap = new Map<string, SessionEntry>();
      for (const session of eventReader.getAllSessions()) legacyMap.set(session.taskId, session);
      expect(legacyMap.get("TASK-001")?.outcome).toBe("claimant_diagnostic");
      expect(eventReader.getExecutionSessions).toHaveBeenCalled();
      expect(queue.getItem("TASK-002")).toMatchObject({ status: "ready", blockedBy: [] });
    });
  });

  describe("completion dispositions", () => {
    async function complete(queue: DispatchQueue, taskId: string): Promise<void> {
      await (
        queue as unknown as { checkTaskCompletion(id: string): Promise<void> }
      ).checkTaskCompletion(taskId);
    }

    it("blocks spec_changed with its refusal reason and does not propagate dependent failure", async () => {
      const queue = createQueue({ failurePropagation: "skip_dependents" });
      const owner = queue.enqueue("TASK-001");
      const dependent = queue.enqueue("TASK-002");
      owner.status = "running";
      dependent.status = "ready";
      dependent.blockedBy = ["TASK-001"];
      dispatchManager.getJob.mockReturnValue(makeJob("TASK-001", "completed"));
      eventReader.getExecutionSessions.mockReturnValue([
        {
          sessionId: "spec-refusal",
          taskId: "TASK-001",
          project: "test",
          startTime: "2026-08-18T10:00:00.000Z",
          status: "completed",
          outcome: "spec_changed",
        } as SessionEntry,
      ]);
      eventReader.getSessionEvents.mockReturnValue([
        {
          sessionId: "spec-refusal",
          taskId: "TASK-001",
          project: "test",
          timestamp: "2026-08-18T10:00:01.000Z",
          stage: "spec_identity_stale",
          payload: { reason: "contested id claimed by two files" },
        } as never,
      ]);

      await complete(queue, "TASK-001");

      expect(owner).toMatchObject({
        status: "blocked",
        outcome: "spec_changed",
        blockedReason: "contested id claimed by two files",
      });
      expect(dependent.status).toBe("ready");
      expect(
        events.some(
          (event) => event.stage === "dispatch_queue_task_failed" && event.taskId === "TASK-001",
        ),
      ).toBe(false);
    });

    it("keeps rejected completion failure propagation byte-compatible", async () => {
      const queue = createQueue({ failurePropagation: "skip_dependents" });
      const owner = queue.enqueue("TASK-001");
      const dependent = queue.enqueue("TASK-002");
      owner.status = "running";
      dependent.status = "ready";
      dependent.blockedBy = ["TASK-001"];
      dispatchManager.getJob.mockReturnValue(makeJob("TASK-001", "completed"));
      eventReader.getExecutionSessions.mockReturnValue([
        {
          sessionId: "rejected-run",
          taskId: "TASK-001",
          project: "test",
          startTime: "2026-08-18T10:00:00.000Z",
          status: "completed",
          outcome: "rejected",
        } as SessionEntry,
      ]);

      await complete(queue, "TASK-001");

      expect(owner).toMatchObject({ status: "failed", outcome: "rejected", error: "rejected" });
      expect(dependent).toMatchObject({
        status: "blocked",
        blockedReason: "Upstream TASK-001 failed",
      });
    });
  });

  describe("human approval pauses", () => {
    async function checkCompletion(queue: DispatchQueue, taskId: string): Promise<void> {
      await (
        queue as unknown as { checkTaskCompletion(id: string): Promise<void> }
      ).checkTaskCompletion(taskId);
    }

    function runningLaneCount(queue: DispatchQueue): number {
      return (
        queue as unknown as {
          guard: { getState(): { runningCount: number } };
        }
      ).guard.getState().runningCount;
    }

    it.each([
      ["reject", "rejected"],
      ["replan", "blueprint_replan_requested"],
    ] as const)(
      "releases a maxConcurrent=1 lane after blueprint %s so the next item starts",
      async (_decision, outcome) => {
        const currentJobs = new Map<string, DispatchJob>();
        dispatchManager.start.mockImplementation((taskId) => {
          const job = makeJob(taskId, "running");
          currentJobs.set(taskId, job);
          return job;
        });
        dispatchManager.getJob.mockImplementation((taskId) => currentJobs.get(taskId));
        taskService.getTask.mockImplementation((taskId) => Promise.resolve(makeParsedTask(taskId)));
        taskService.listTasks.mockResolvedValue({
          tasks: [makeTaskSummary("TASK-001"), makeTaskSummary("TASK-002")],
          parseErrors: [],
          parseWarnings: [],
        });

        const queue = createQueue({
          maxConcurrent: 1,
          cooldownBetweenTasksMs: 0,
          persistState: true,
        });
        const first = queue.enqueue("TASK-001");
        const second = queue.enqueue("TASK-002");
        await waitForCondition(
          () => first.status === "ready" && second.status === "ready",
          "both queue items to become ready",
        );
        await queue.start();
        await waitForCondition(() => first.status === "running", "the first queue item to start");
        expect(dispatchManager.start).toHaveBeenCalledTimes(1);
        expect(runningLaneCount(queue)).toBe(1);

        const paused = makeJob("TASK-001", "awaiting_approval");
        paused.exitCode = 1;
        currentJobs.set("TASK-001", paused);
        await checkCompletion(queue, "TASK-001");
        expect(first.status).toBe("awaiting_approval");

        // The rejection route releases the manager job first. Without an
        // explicit queue transition, getJob() returns undefined forever and
        // this maxConcurrent=1 slot strands TASK-002.
        currentJobs.delete("TASK-001");
        expect(
          queue.settleApprovalRejection("TASK-001", `Blueprint ${_decision} requested`, outcome),
        ).toBe(true);

        await waitForCondition(
          () => dispatchManager.start.mock.calls.some(([taskId]) => taskId === "TASK-002"),
          "the second queue item to start",
        );
        expect(first).toMatchObject({
          status: "failed",
          outcome,
          error: `Blueprint ${_decision} requested`,
        });
        expect(second.status).toBe("running");
        expect(runningLaneCount(queue)).toBe(1);
        expect(
          (
            queue as unknown as {
              pollTimers: Map<string, ReturnType<typeof setInterval>>;
            }
          ).pollTimers.has("TASK-001"),
        ).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, "dispatch-queue.jsonl"), "utf-8")).toContain(
          `"outcome":"${outcome}"`,
        );
        const firstTaskStopCalls = dispatchManager.stop.mock.calls.filter(
          ([taskId]) => taskId === "TASK-001",
        ).length;
        expect(queue.cancel("TASK-001")).toBe(true);
        expect(
          dispatchManager.stop.mock.calls.filter(([taskId]) => taskId === "TASK-001"),
        ).toHaveLength(firstTaskStopCalls);
      },
    );

    it("settles a still-running queue row only with proof that the real manager released its pause", async () => {
      const realManager = new DispatchManager(
        tmpDir,
        path.join(tmpDir, "quack.js"),
        undefined,
        undefined,
        tmpDir,
      );
      const realQueue = new DispatchQueue(
        realManager,
        taskService as unknown as TaskService,
        eventReader as unknown as EventReader,
        makeConfig({ maxConcurrent: 1, cooldownBetweenTasksMs: 0, persistState: true }),
        tmpDir,
      );
      const managerJobs = (realManager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      const queueInternals = realQueue as unknown as {
        running: boolean;
        guard: { onTaskStart(): void; getState(): { runningCount: number } };
        pollTimers: Map<string, ReturnType<typeof setInterval>>;
      };

      try {
        taskService.getTask.mockImplementation((taskId) => Promise.resolve(makeParsedTask(taskId)));
        taskService.listTasks.mockResolvedValue({
          tasks: [makeTaskSummary("TASK-001"), makeTaskSummary("TASK-002")],
          parseErrors: [],
          parseWarnings: [],
        });
        const first = realQueue.enqueue("TASK-001");
        const second = realQueue.enqueue("TASK-002");
        await waitForCondition(
          () => first.status === "ready" && second.status === "ready",
          "real queue items to become ready",
        );

        first.status = "running";
        second.status = "ready";
        queueInternals.running = true;
        queueInternals.guard.onTaskStart();

        const startedAt = new Date(Date.now() - 60_000).toISOString();
        const approvalCreatedAt = new Date().toISOString();
        managerJobs.set("TASK-001", {
          taskId: "TASK-001",
          sessionId: "real-manager-paused",
          pid: 4242,
          startedAt,
          status: "awaiting_approval",
          exitCode: 1,
          output: [],
        });
        fs.mkdirSync(path.join(tmpDir, "approvals"), { recursive: true });
        fs.writeFileSync(
          path.join(tmpDir, "approvals", "TASK-001.json"),
          JSON.stringify({
            taskId: "TASK-001",
            state: "pending",
            createdAt: approvalCreatedAt,
            blueprint: {},
          }),
          "utf-8",
        );

        const startSpy = jest.spyOn(realManager, "start").mockImplementation((taskId) => {
          const job = makeJob(taskId, "running");
          managerJobs.set(taskId, job);
          return job;
        });
        const resolution = await realManager.resolveApprovalPauseDecision(
          "TASK-001",
          "blueprint",
          "rejected",
          () => {
            fs.writeFileSync(
              path.join(tmpDir, "approvals", "TASK-001.json"),
              JSON.stringify({
                taskId: "TASK-001",
                state: "rejected",
                createdAt: approvalCreatedAt,
                decidedAt: new Date().toISOString(),
                blueprint: {},
              }),
              "utf-8",
            );
            return Promise.resolve();
          },
        );

        expect(first.status).toBe("running");
        expect(resolution.released).toBe(true);
        expect(realManager.getJob("TASK-001")).toBeUndefined();
        expect(
          realQueue.settleApprovalRejection(
            "TASK-001",
            "Blueprint rejected",
            "rejected",
            resolution.released,
          ),
        ).toBe(true);

        await waitForCondition(
          () => startSpy.mock.calls.some(([taskId]) => taskId === "TASK-002"),
          "the next real queue item to start",
        );
        expect(first).toMatchObject({ status: "failed", outcome: "rejected" });
        expect(second.status).toBe("running");
        expect(queueInternals.guard.getState().runningCount).toBe(1);
      } finally {
        realQueue.stop();
        for (const timer of queueInternals.pollTimers.values()) clearInterval(timer);
        queueInternals.pollTimers.clear();
        managerJobs.clear();
      }
    });

    it("does not settle a running queue row without an exact manager release proof", () => {
      const queue = createQueue();
      const item = queue.enqueue("TASK-001");
      item.status = "running";

      expect(queue.settleApprovalRejection("TASK-001", "Rejected", "rejected")).toBe(false);
      expect(item.status).toBe("running");
    });

    it("write-ahead records approval resume when the queue poll lags a real manager release", async () => {
      const realManager = new DispatchManager(
        tmpDir,
        path.join(tmpDir, "quack.js"),
        undefined,
        undefined,
        tmpDir,
      );
      const realQueue = new DispatchQueue(
        realManager,
        taskService as unknown as TaskService,
        eventReader as unknown as EventReader,
        makeConfig({ maxConcurrent: 1, cooldownBetweenTasksMs: 0, persistState: true }),
        tmpDir,
      );
      let recoveredQueue: DispatchQueue | undefined;
      const managerJobs = (realManager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      const queueInternals = realQueue as unknown as {
        running: boolean;
        guard: { onTaskStart(): void; getState(): { runningCount: number } };
        pollTimers: Map<string, ReturnType<typeof setInterval>>;
      };

      try {
        taskService.getTask.mockImplementation((taskId) => Promise.resolve(makeParsedTask(taskId)));
        taskService.listTasks.mockResolvedValue({
          tasks: [makeTaskSummary("TASK-001"), makeTaskSummary("TASK-002")],
          parseErrors: [],
          parseWarnings: [],
        });
        const first = realQueue.enqueue("TASK-001");
        const second = realQueue.enqueue("TASK-002");
        await waitForCondition(
          () => first.status === "ready" && second.status === "ready",
          "real queue items to become ready",
        );
        first.status = "running";
        queueInternals.running = true;
        queueInternals.guard.onTaskStart();

        // The child has exited at the gate, but the queue's three-second poll
        // has not yet observed that transition: its row is still `running`.
        const approvalCreatedAt = new Date().toISOString();
        managerJobs.set("TASK-001", {
          taskId: "TASK-001",
          sessionId: "real-manager-approve-paused",
          pid: 4242,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          status: "awaiting_approval",
          exitCode: 1,
          output: [],
        });
        fs.mkdirSync(path.join(tmpDir, "approvals"), { recursive: true });
        fs.writeFileSync(
          path.join(tmpDir, "approvals", "TASK-001.json"),
          JSON.stringify({
            taskId: "TASK-001",
            state: "pending",
            createdAt: approvalCreatedAt,
            blueprint: {},
          }),
          "utf-8",
        );
        const resolution = await realManager.resolveApprovalPauseDecision(
          "TASK-001",
          "blueprint",
          "approved",
          () => {
            fs.writeFileSync(
              path.join(tmpDir, "approvals", "TASK-001.json"),
              JSON.stringify({
                taskId: "TASK-001",
                state: "approved",
                createdAt: approvalCreatedAt,
                blueprint: {},
              }),
              "utf-8",
            );
            return Promise.resolve();
          },
        );

        expect(first.status).toBe("running");
        expect(resolution.released).toBe(true);
        expect(realQueue.recordApprovalResume("TASK-001")).toBe(false);
        expect(realQueue.recordApprovalResume("TASK-001", resolution.released)).toBe(true);
        expect(first).toMatchObject({ status: "running", dispatchOptions: { resume: true } });
        expect(queueInternals.guard.getState().runningCount).toBe(1);
        expect(fs.readFileSync(path.join(tmpDir, "dispatch-queue.jsonl"), "utf-8")).toContain(
          '"type":"task_resumed"',
        );

        // Simulate a monitor death before the route starts the replacement.
        // Replay must resume TASK-001 and keep TASK-002 behind the same lane.
        queueInternals.running = false;
        const startSpy = jest.spyOn(realManager, "start").mockImplementation((taskId) => {
          const job = makeJob(taskId, "running");
          managerJobs.set(taskId, job);
          return job;
        });
        recoveredQueue = new DispatchQueue(
          realManager,
          taskService as unknown as TaskService,
          eventReader as unknown as EventReader,
          makeConfig({ maxConcurrent: 1, cooldownBetweenTasksMs: 0, persistState: true }),
          tmpDir,
        );
        await recoveredQueue.start();
        await waitForCondition(() => startSpy.mock.calls.length === 1, "approval resume replay");

        expect(startSpy).toHaveBeenCalledWith(
          "TASK-001",
          expect.objectContaining({ resume: true }),
          expect.objectContaining({ taskId: "TASK-001", claimants: [] }),
        );
        expect(startSpy.mock.calls.some(([taskId]) => taskId === "TASK-002")).toBe(false);
        expect(recoveredQueue.getItem("TASK-001")?.status).toBe("running");
      } finally {
        realQueue.stop();
        recoveredQueue?.stop();
        for (const timer of queueInternals.pollTimers.values()) clearInterval(timer);
        queueInternals.pollTimers.clear();
        managerJobs.clear();
      }
    });

    it.each(["blueprint", "judge"] as const)(
      "keeps a %s gate pause nonterminal and finishes after the approval restart",
      async (gate) => {
        let currentJob = makeJob("TASK-001", "running");
        currentJob.sessionId = `${gate}-initial`;
        dispatchManager.start.mockImplementation(() => currentJob);
        dispatchManager.getJob.mockImplementation(() => currentJob);
        taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));

        const queue = createQueue({
          maxConcurrent: 1,
          cooldownBetweenTasksMs: 0,
          persistState: true,
        });
        const item = queue.enqueue("TASK-001");
        await new Promise((resolve) => setTimeout(resolve, 25));
        await queue.start();

        expect(dispatchManager.start).toHaveBeenCalledTimes(1);
        expect(item.status).toBe("running");
        expect(runningLaneCount(queue)).toBe(1);

        currentJob = makeJob("TASK-001", "awaiting_approval");
        currentJob.sessionId = `${gate}-pending`;
        currentJob.output = [`[dispatch] ${gate} approval pending`];
        eventReader.getExecutionSessions.mockReturnValue([
          {
            sessionId: `${gate}-pending`,
            taskId: "TASK-001",
            project: "test",
            startTime: "2026-09-08T11:00:00.000Z",
            status: "completed",
            outcome: gate === "blueprint" ? "awaiting_approval" : "awaiting_judge_approval",
          } as SessionEntry,
        ]);
        await checkCompletion(queue, "TASK-001");

        expect(item).toMatchObject({
          status: "awaiting_approval",
          retryCount: 0,
        });
        expect(item.completedAt).toBeUndefined();
        expect(queue.getStats()).toMatchObject({
          awaitingApproval: 1,
          running: 0,
          failed: 0,
        });
        expect(queue.retry("TASK-001")).toBe(false);
        expect(runningLaneCount(queue)).toBe(1);
        expect(
          events.some(
            (event) => event.stage === "dispatch_queue_task_failed" && event.taskId === "TASK-001",
          ),
        ).toBe(false);
        expect(
          events.some(
            (event) =>
              event.stage === "dispatch_queue_task_awaiting_approval" &&
              event.taskId === "TASK-001",
          ),
        ).toBe(true);

        const persistedPause = fs.readFileSync(path.join(tmpDir, "dispatch-queue.jsonl"), "utf-8");
        expect(persistedPause).toContain('"type":"task_awaiting_approval"');

        // The approval route owns the DispatchManager restart. The queue only
        // observes it and must not invoke start() a second time or claim a new lane.
        currentJob = makeJob("TASK-001", "running");
        currentJob.sessionId = `${gate}-resumed`;
        await checkCompletion(queue, "TASK-001");

        expect(item.status).toBe("running");
        expect(dispatchManager.start).toHaveBeenCalledTimes(1);
        expect(runningLaneCount(queue)).toBe(1);
        expect(
          events.some(
            (event) => event.stage === "dispatch_queue_task_resumed" && event.taskId === "TASK-001",
          ),
        ).toBe(true);

        currentJob = makeJob("TASK-001", "completed");
        currentJob.sessionId = `${gate}-resumed`;
        eventReader.getExecutionSessions.mockReturnValue([
          {
            sessionId: `${gate}-resumed`,
            taskId: "TASK-001",
            project: "test",
            startTime: "2026-09-08T12:00:00.000Z",
            status: "completed",
            outcome: "approved",
            totalCostUsd: 1.25,
            durationMs: 5000,
          } as SessionEntry,
        ]);
        await checkCompletion(queue, "TASK-001");

        expect(item).toMatchObject({
          status: "completed",
          outcome: "approved",
          retryCount: 0,
          costUsd: 1.25,
        });
        expect(runningLaneCount(queue)).toBe(0);
        expect(dispatchManager.start).toHaveBeenCalledTimes(1);
      },
    );

    it("rehydrates a persisted approval pause with its lane and completion watcher", async () => {
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(
        logPath,
        [
          {
            ts: "2026-09-08T10:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-001",
            priority: 2,
            blockedBy: [],
          },
          { ts: "2026-09-08T10:01:00.000Z", type: "task_started", taskId: "TASK-001" },
          { ts: "2026-09-08T10:02:00.000Z", type: "task_awaiting_approval", taskId: "TASK-001" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
        "utf-8",
      );

      let currentJob: DispatchJob | undefined;
      dispatchManager.getJob.mockImplementation(() => currentJob);
      const queue = createQueue({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        persistState: true,
      });

      expect(queue.getItem("TASK-001")).toMatchObject({
        status: "awaiting_approval",
        retryCount: 0,
      });
      expect(runningLaneCount(queue)).toBe(1);
      expect(dispatchManager.start).not.toHaveBeenCalled();

      currentJob = makeJob("TASK-001", "running");
      currentJob.sessionId = "resumed-after-restart";
      await checkCompletion(queue, "TASK-001");
      expect(queue.getItem("TASK-001")?.status).toBe("running");
      expect(runningLaneCount(queue)).toBe(1);
      expect(dispatchManager.start).not.toHaveBeenCalled();

      currentJob = makeJob("TASK-001", "completed");
      currentJob.sessionId = "resumed-after-restart";
      eventReader.getExecutionSessions.mockReturnValue([
        {
          sessionId: "resumed-after-restart",
          taskId: "TASK-001",
          project: "test",
          startTime: "2026-09-08T12:00:00.000Z",
          status: "completed",
          outcome: "approved",
        } as SessionEntry,
      ]);
      await checkCompletion(queue, "TASK-001");

      expect(queue.getItem("TASK-001")?.status).toBe("completed");
      expect(runningLaneCount(queue)).toBe(0);
      expect(dispatchManager.start).not.toHaveBeenCalled();
    });

    it("restarts an interrupted post-approval dispatch in resume mode", async () => {
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(
        logPath,
        [
          {
            ts: "2026-09-08T10:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-001",
            priority: 2,
            blockedBy: [],
          },
          { ts: "2026-09-08T10:01:00.000Z", type: "task_started", taskId: "TASK-001" },
          { ts: "2026-09-08T10:02:00.000Z", type: "task_awaiting_approval", taskId: "TASK-001" },
          {
            ts: "2026-09-08T10:03:00.000Z",
            type: "task_resumed",
            taskId: "TASK-001",
            dispatchOptions: { resume: true },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
        "utf-8",
      );
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));

      const queue = createQueue({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        persistState: true,
      });
      await queue.start();

      expect(dispatchManager.start).toHaveBeenCalledTimes(1);
      expect(dispatchManager.start).toHaveBeenCalledWith(
        "TASK-001",
        expect.objectContaining({ resume: true }),
        expect.objectContaining({ taskId: "TASK-001", claimants: [] }),
      );
      expect(queue.getItem("TASK-001")?.status).toBe("running");
      expect(runningLaneCount(queue)).toBe(1);
    });

    it("writes resume intent before a replacement child starts so a crash cannot restore the gate pause", async () => {
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(
        logPath,
        [
          {
            ts: "2026-09-08T10:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-001",
            priority: 2,
            blockedBy: [],
          },
          { ts: "2026-09-08T10:01:00.000Z", type: "task_started", taskId: "TASK-001" },
          { ts: "2026-09-08T10:02:00.000Z", type: "task_awaiting_approval", taskId: "TASK-001" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
        "utf-8",
      );

      const pausedQueue = createQueue({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        persistState: true,
      });
      expect(pausedQueue.recordApprovalResume("TASK-001")).toBe(true);
      expect(dispatchManager.start).not.toHaveBeenCalled();
      expect(pausedQueue.getItem("TASK-001")).toMatchObject({
        status: "running",
        dispatchOptions: { resume: true },
      });
      expect(fs.readFileSync(logPath, "utf-8")).toContain('"type":"task_resumed"');

      // Simulate a process death at this exact boundary: the route has
      // durably recorded resume intent, but has not started the child yet.
      const timers = (
        pausedQueue as unknown as {
          pollTimers: Map<string, ReturnType<typeof setInterval>>;
        }
      ).pollTimers;
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();

      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      const recoveredQueue = createQueue({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        persistState: true,
      });
      await recoveredQueue.start();

      expect(dispatchManager.start).toHaveBeenCalledTimes(1);
      expect(dispatchManager.start).toHaveBeenCalledWith(
        "TASK-001",
        expect.objectContaining({ resume: true }),
        expect.objectContaining({ taskId: "TASK-001", claimants: [] }),
      );
      expect(recoveredQueue.getItem("TASK-001")?.status).toBe("running");
      expect(runningLaneCount(recoveredQueue)).toBe(1);
    });

    it("requeues a write-ahead resume when the replacement start throws", async () => {
      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      fs.writeFileSync(
        logPath,
        [
          {
            ts: "2026-09-08T10:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-001",
            priority: 2,
            blockedBy: [],
          },
          { ts: "2026-09-08T10:01:00.000Z", type: "task_started", taskId: "TASK-001" },
          { ts: "2026-09-08T10:02:00.000Z", type: "task_awaiting_approval", taskId: "TASK-001" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
        "utf-8",
      );

      const queue = createQueue({
        maxConcurrent: 1,
        cooldownBetweenTasksMs: 0,
        persistState: true,
      });
      expect(runningLaneCount(queue)).toBe(1);
      expect(queue.recordApprovalResume("TASK-001")).toBe(true);

      expect(queue.requeueApprovalResume("TASK-001", "spawn refused")).toBe(true);
      expect(queue.getItem("TASK-001")).toMatchObject({
        status: "ready",
        retryCount: 0,
        dispatchOptions: { resume: true },
      });
      expect(runningLaneCount(queue)).toBe(0);

      const eventsOnDisk = fs
        .readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; reason?: string });
      expect(eventsOnDisk.at(-2)?.type).toBe("task_resumed");
      expect(eventsOnDisk.at(-1)?.type).toBe("task_ready");
      expect(eventsOnDisk.at(-1)?.reason).toContain("spawn refused");

      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      await queue.start();
      expect(dispatchManager.start).toHaveBeenCalledWith(
        "TASK-001",
        expect.objectContaining({ resume: true }),
        expect.objectContaining({ taskId: "TASK-001", claimants: [] }),
      );
      expect(queue.getItem("TASK-001")?.status).toBe("running");
      expect(runningLaneCount(queue)).toBe(1);
    });
  });

  // ─── Lifecycle Tests ──────────────────────────────────────────

  describe("start / pause / resume", () => {
    it("holds queued dispatch inside the configured admission fence", async () => {
      let releaseFence!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      const fenceCalls: string[] = [];
      const fence = async <T>(
        taskId: string,
        dispatch: (admission: DecompositionDispatchAdmission) => T,
      ): Promise<T> => {
        fenceCalls.push(taskId);
        await held;
        return dispatch({ taskId, fileName: `${taskId}.md`, contentHash: "admitted-hash" });
      };
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      const queue = createQueue({}, fence);
      queue.enqueue("TASK-001");

      const starting = queue.start();
      await waitForCondition(() => fenceCalls.length === 1, "admission fence");
      expect(fenceCalls).toEqual(["TASK-001"]);
      expect(dispatchManager.start).not.toHaveBeenCalled();

      releaseFence();
      await starting;
      expect(dispatchManager.start).toHaveBeenCalledTimes(1);
      expect(dispatchManager.start).toHaveBeenCalledWith(
        "TASK-001",
        expect.objectContaining({ admittedTaskContentHash: "admitted-hash" }),
        expect.anything(),
      );
    });

    it("does not dispatch an item cancelled while its admission fence is waiting", async () => {
      let releaseFence!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      const fence = async <T>(
        taskId: string,
        dispatch: (admission: DecompositionDispatchAdmission) => T,
      ): Promise<T> => {
        await held;
        return dispatch({ taskId, fileName: `${taskId}.md`, contentHash: "admitted-hash" });
      };
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      const queue = createQueue({}, fence);
      queue.enqueue("TASK-001");

      const starting = queue.start();
      await waitForCondition(() => queue.getItem("TASK-001")?.status === "ready", "ready item");
      expect(queue.cancel("TASK-001")).toBe(true);
      releaseFence();
      await starting;

      expect(dispatchManager.start).not.toHaveBeenCalled();
      expect(queue.getItem("TASK-001")?.status).toBe("stopped");
    });

    it.each(["abort", "cancel"] as const)(
      "%s stops a job started inside the fence before reservation release",
      async (lifecycle) => {
        let releaseFence!: () => void;
        let dispatchStarted!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseFence = resolve;
        });
        const started = new Promise<void>((resolve) => {
          dispatchStarted = resolve;
        });
        const fence = async <T>(
          taskId: string,
          dispatch: (admission: DecompositionDispatchAdmission) => T,
        ): Promise<T> => {
          const result = dispatch({
            taskId,
            fileName: `${taskId}.md`,
            contentHash: "admitted-hash",
          });
          dispatchStarted();
          await held;
          return result;
        };
        taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
        const queue = createQueue({}, fence);
        queue.enqueue("TASK-001");

        const starting = queue.start();
        await started;
        expect(queue.getItem("TASK-001")?.status).toBe("running");
        expect(dispatchManager.start).toHaveBeenCalledTimes(1);

        expect(lifecycle === "abort" ? queue.abort() : queue.cancel("TASK-001")).toBe(true);
        expect(dispatchManager.stop).toHaveBeenCalledWith("TASK-001");
        releaseFence();
        await starting;
        expect(queue.getItem("TASK-001")?.status).toBe("stopped");
      },
    );

    it("skips a parent decomposed at admission without recording a dispatch failure", async () => {
      const refusal = Object.assign(new Error("parent is now decomposed"), {
        details: { admissionDisposition: "decomposed" },
      });
      const fence = <T>(
        _taskId: string,
        _dispatch: (admission: DecompositionDispatchAdmission) => T,
      ): Promise<T> => Promise.reject(refusal);
      taskService.getTask.mockResolvedValue(makeParsedTask("TASK-001"));
      const queue = createQueue({}, fence);
      queue.enqueue("TASK-001");

      await queue.start();
      await waitForCondition(
        () => queue.getItem("TASK-001")?.status === "skipped",
        "decomposed admission skip",
      );

      expect(dispatchManager.start).not.toHaveBeenCalled();
      expect(queue.getItem("TASK-001")).toMatchObject({
        status: "skipped",
        outcome: "decomposed",
        blockedReason: "parent is now decomposed",
      });
      expect(events.some((event) => event.stage === "dispatch_queue_task_failed")).toBe(false);
    });

    it("start sets running state", async () => {
      const queue = createQueue();
      // Enqueue a task first so the queue has something to process
      // (an empty queue immediately drains and sets running=false)
      queue.enqueue("TASK-001");
      await queue.start();

      expect(queue.isRunning()).toBe(true);
      expect(queue.isPaused()).toBe(false);
    });

    it("pause stops new dispatches", async () => {
      const queue = createQueue();
      await queue.start();
      queue.pause("test pause");

      expect(queue.isPaused()).toBe(true);

      const pauseEvent = events.find((e) => e.stage === "dispatch_queue_paused");
      expect(pauseEvent).toBeDefined();
    });

    it("resume from paused state", async () => {
      const queue = createQueue();
      await queue.start();
      queue.pause("test");
      await queue.resume();

      expect(queue.isPaused()).toBe(false);

      const resumeEvent = events.find((e) => e.stage === "dispatch_queue_resumed");
      expect(resumeEvent).toBeDefined();
    });

    it("stop waits for running tasks, doesn't start new ones", async () => {
      const queue = createQueue();
      await queue.start();
      queue.stop();

      expect(queue.isRunning()).toBe(false);
    });
  });

  describe("abort", () => {
    it("kills running tasks immediately", async () => {
      const queue = createQueue();

      // Add an item then start and abort
      queue.enqueue("TASK-001");
      await queue.start();
      queue.abort();

      expect(queue.isRunning()).toBe(false);
    });

    it("reports an incomplete abort and retains the active lane when stop is refused", () => {
      const queue = createQueue();
      const item = queue.enqueue("TASK-001");
      (item as { status: string }).status = "running";
      dispatchManager.stop.mockReturnValue(false);

      expect(queue.abort()).toBe(false);
      expect(queue.isRunning()).toBe(false);
      expect(queue.getItem("TASK-001")?.status).toBe("running");

      dispatchManager.stop.mockReturnValue(true);
      expect(queue.abort()).toBe(true);
    });
  });

  // ─── Cancel / Retry / Remove Tests ────────────────────────────

  describe("cancel", () => {
    it("stops a queued task and marks as stopped", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      const result = queue.cancel("TASK-001");

      expect(result).toBe(true);
      expect(queue.getItem("TASK-001")!.status).toBe("stopped");
    });

    it("returns false for non-existent task", () => {
      const queue = createQueue();
      expect(queue.cancel("TASK-999")).toBe(false);
    });

    it("retains a running task and its lane when durable stop is refused", () => {
      const queue = createQueue();
      const item = queue.enqueue("TASK-001");
      (item as { status: string }).status = "running";
      dispatchManager.stop.mockReturnValue(false);

      expect(queue.cancel("TASK-001")).toBe(false);
      expect(queue.getItem("TASK-001")?.status).toBe("running");

      dispatchManager.stop.mockReturnValue(true);
      expect(queue.cancel("TASK-001")).toBe(true);
    });
  });

  describe("retry", () => {
    it("re-queues a failed task", () => {
      const queue = createQueue();
      const item = queue.enqueue("TASK-001");
      // Manually set to failed state for testing
      (item as { status: string }).status = "failed";

      const result = queue.retry("TASK-001");

      expect(result).toBe(true);
      expect(queue.getItem("TASK-001")!.status).toBe("queued");
      expect(queue.getItem("TASK-001")!.retryCount).toBe(1);
    });

    it("returns false for non-failed task", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      expect(queue.retry("TASK-001")).toBe(false);
    });
  });

  describe("remove", () => {
    it("removes a non-running task from the queue", () => {
      const queue = createQueue();
      queue.enqueue("TASK-001");

      const result = queue.remove("TASK-001");

      expect(result).toBe(true);
      expect(queue.getItem("TASK-001")).toBeUndefined();
    });

    it("returns false for non-existent task", () => {
      const queue = createQueue();
      expect(queue.remove("TASK-999")).toBe(false);
    });

    it("returns false for running task", () => {
      const queue = createQueue();
      const item = queue.enqueue("TASK-001");
      (item as { status: string }).status = "running";

      expect(queue.remove("TASK-001")).toBe(false);
    });
  });

  // ─── Stats Tests ──────────────────────────────────────────────

  describe("getStats", () => {
    it("returns correct statistics", () => {
      const queue = createQueue();
      const item1 = queue.enqueue("TASK-001");
      const item2 = queue.enqueue("TASK-002");
      const item3 = queue.enqueue("TASK-003");

      (item1 as { status: string }).status = "completed";
      (item1 as { costUsd: number }).costUsd = 1.5;
      (item1 as { durationMs: number }).durationMs = 60000;
      (item2 as { status: string }).status = "running";
      (item3 as { status: string }).status = "queued";

      const stats = queue.getStats();

      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.queued).toBe(1);
      expect(stats.totalCostUsd).toBe(1.5);
      expect(stats.totalDurationMs).toBe(60000);
    });
  });

  // ─── Concurrent Dispatch Tests ────────────────────────────────

  describe("concurrent dispatch", () => {
    it("respects maxConcurrent=1 (sequential)", async () => {
      // With maxConcurrent=1, only one task should be dispatched at a time
      // even when multiple tasks are ready
      const startedTaskIds: string[] = [];
      dispatchManager.start.mockImplementation((taskId: string) => {
        startedTaskIds.push(taskId);
        return makeJob(taskId, "running");
      });

      const queue = createQueue({ maxConcurrent: 1, cooldownBetweenTasksMs: 0 });

      // Enqueue 3 independent tasks (no dependencies)
      queue.enqueue("TASK-001");
      queue.enqueue("TASK-002");
      queue.enqueue("TASK-003");

      // Wait for enrichment (they become "ready")
      await new Promise((r) => setTimeout(r, 50));

      // Start processing
      await queue.start();

      // Give the scheduling loop a tick
      await new Promise((r) => setTimeout(r, 50));

      // Only one task should have been dispatched (guard blocks at maxConcurrent=1)
      expect(startedTaskIds).toHaveLength(1);
      expect(dispatchManager.start).toHaveBeenCalledTimes(1);

      // The running count in the queue should be 1
      const stats = queue.getStats();
      expect(stats.running).toBe(1);
      // The other two should still be ready, not running
      expect(stats.ready).toBe(2);
    });

    it("respects maxConcurrent=3 (parallel independent tasks)", async () => {
      // With maxConcurrent=3, up to 3 tasks should be dispatched concurrently
      const startedTaskIds: string[] = [];
      dispatchManager.start.mockImplementation((taskId: string) => {
        startedTaskIds.push(taskId);
        return makeJob(taskId, "running");
      });

      const queue = createQueue({ maxConcurrent: 3, cooldownBetweenTasksMs: 0 });

      // Enqueue 5 independent tasks (no dependencies)
      queue.enqueue("TASK-001");
      queue.enqueue("TASK-002");
      queue.enqueue("TASK-003");
      queue.enqueue("TASK-004");
      queue.enqueue("TASK-005");

      // Wait for enrichment (they become "ready")
      await new Promise((r) => setTimeout(r, 50));

      // Start processing
      await queue.start();

      // Give the scheduling loop time to dispatch
      await new Promise((r) => setTimeout(r, 50));

      // Exactly 3 tasks should have been dispatched (capped at maxConcurrent=3)
      expect(startedTaskIds).toHaveLength(3);
      expect(dispatchManager.start).toHaveBeenCalledTimes(3);

      // The running count should be 3
      const stats = queue.getStats();
      expect(stats.running).toBe(3);
      // The remaining 2 should still be ready
      expect(stats.ready).toBe(2);
    });
  });

  // ─── Queue Drained Event ──────────────────────────────────────

  describe("queue drained", () => {
    it("emits queue:drained when all items processed (via start with empty queue)", async () => {
      const queue = createQueue();
      await queue.start();

      // With no items, the queue should check drained immediately
      // The scheduleNext call finds no ready tasks and checks drained
      const drainedEvent = events.find((e) => e.stage === "dispatch_queue_drained");
      // Queue is empty so it should drain
      expect(drainedEvent).toBeDefined();
    });
  });

  // ─── Config Update Tests ──────────────────────────────────────

  describe("updateConfig", () => {
    it("updates maxConcurrent at runtime", () => {
      const queue = createQueue({ maxConcurrent: 1 });

      queue.updateConfig({ maxConcurrent: 5 });

      // Verify config was updated (reflected in behavior)
      expect(queue.isRunning()).toBe(false); // Doesn't affect running state
    });
  });

  // ─── Persistence Integration Tests ────────────────────────────

  describe("persistence", () => {
    it("writes events to JSONL when persistState is true", () => {
      const queue = createQueue({ persistState: true });
      queue.enqueue("TASK-001");

      const logPath = path.join(tmpDir, "dispatch-queue.jsonl");
      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf-8").trim();
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const firstEvent = JSON.parse(lines[0]) as { type: string; taskId: string };
      expect(firstEvent.type).toBe("task_enqueued");
      expect(firstEvent.taskId).toBe("TASK-001");
    });
  });

  // ─── Auto-Start on Enqueue ────────────────────────────────────

  describe("autoStartOnEnqueue", () => {
    it("starts queue automatically when autoStartOnEnqueue is true", () => {
      const queue = createQueue({ autoStartOnEnqueue: true });

      queue.enqueue("TASK-001");

      expect(queue.isRunning()).toBe(true);
    });

    it("does not auto-start when autoStartOnEnqueue is false", () => {
      const queue = createQueue({ autoStartOnEnqueue: false });

      queue.enqueue("TASK-001");

      expect(queue.isRunning()).toBe(false);
    });
  });
});
