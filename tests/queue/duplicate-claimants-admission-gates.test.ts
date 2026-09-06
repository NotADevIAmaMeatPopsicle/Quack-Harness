// TASK-1338-C pre-change record: enqueue, retry, enqueueMultiple and
// enqueueSubtasks all executed and admitted contested rows. Each failed at
// the intended duplicate_claimants assertion. The clean batch member is the
// positive mutation oracle.

import * as path from "node:path";

import type { DispatchJob, DispatchManager } from "../../src/monitor/dispatch-manager";
import { EventReader } from "../../src/monitor/event-reader";
import { TaskService } from "../../src/monitor/task-service";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { DispatchQueueConfig, QueueItem } from "../../src/queue/queue-types";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  removeFixture,
  taskSpec,
} from "../helpers/duplicate-claimants-fixture";
import * as fs from "node:fs";

interface ClaimantCheck {
  taskId: string;
  claimants: string[];
}

interface BatchItems extends Array<QueueItem> {
  refusals?: Array<ClaimantCheck & { error: "duplicate_claimants"; message: string }>;
}

function config(): DispatchQueueConfig {
  return {
    maxConcurrent: 1,
    cooldownBetweenTasksMs: 0,
    failurePropagation: "skip_dependents",
    fleetBudgetUsd: 0,
    pauseOnFailure: false,
    persistState: false,
    autoStartOnEnqueue: false,
  };
}

function job(taskId: string): DispatchJob {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    pid: 123,
    startedAt: new Date().toISOString(),
    status: "running",
    output: [],
  };
}

function manager(): jest.Mocked<
  Pick<DispatchManager, "start" | "stop" | "getActiveJob" | "getJob" | "getActiveJobs">
> {
  return {
    start: jest.fn((taskId: string) => job(taskId)),
    stop: jest.fn(),
    getActiveJob: jest.fn(),
    getJob: jest.fn(),
    getActiveJobs: jest.fn().mockReturnValue([]),
  };
}

function makeQueue(root: string, dispatchManager: ReturnType<typeof manager>): DispatchQueue {
  const logDir = path.join(root, ".quack", "logs");
  return new DispatchQueue(
    dispatchManager as unknown as DispatchManager,
    new TaskService(root, "docs/tasks"),
    new EventReader(logDir),
    config(),
    logDir,
  );
}

function check(claimants: string[]): ClaimantCheck {
  return { taskId: "TASK-100", claimants };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "queue synchronous admission defence (%s, %s)",
  (kind, order) => {
    it("enqueue refuses a supplied contested claimant result before row insertion", () => {
      const fixture = createDuplicateFixture("quack-queue-enqueue-", kind, order);
      try {
        const queue = makeQueue(fixture.root, manager());
        expect(() => queue.enqueue("TASK-100", undefined, check(fixture.claimants))).toThrow(
          /duplicate claimants/i,
        );
        expect(queue.getItem("TASK-100")).toBeUndefined();
      } finally {
        removeFixture(fixture.root);
      }
    });

    it("retry preserves its failed-only no-op, then refuses before mutation", () => {
      const fixture = createDuplicateFixture("quack-queue-retry-", kind, order);
      try {
        const queue = makeQueue(fixture.root, manager());
        const item = queue.enqueue("TASK-100");
        expect(queue.retry("TASK-100", check(fixture.claimants))).toBe(false);
        expect(item.status).toBe("queued");

        item.status = "failed";
        item.error = "fixture failure";
        expect(() => queue.retry("TASK-100", check(fixture.claimants))).toThrow(
          /duplicate claimants/i,
        );
        expect(item.status).toBe("failed");
        expect(item.retryCount).toBe(0);
        expect(item.error).toBe("fixture failure");
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

describe.each(DUPLICATE_FIXTURE_CASES)("enqueueMultiple matrix (%s, %s)", (kind, order) => {
  it("enqueueMultiple pre-scans and reports refusals while inserting clean rows", () => {
    const fixture = createDuplicateFixture("quack-queue-batch-", kind, order, {
      status: "BACKLOG",
    });
    try {
      fs.writeFileSync(
        path.join(fixture.taskDir, "TASK-200-clean.md"),
        taskSpec("TASK-200", { status: "BACKLOG" }),
      );
      const queue = makeQueue(fixture.root, manager());
      const checks = new Map<string, ClaimantCheck>([
        ["TASK-100", check(fixture.claimants)],
        ["TASK-200", { taskId: "TASK-200", claimants: [] }],
      ]);

      const result = queue.enqueueMultiple(
        ["TASK-100", "TASK-200"],
        undefined,
        checks,
      ) as BatchItems;

      expect(result.map((item) => item.taskId)).toEqual(["TASK-200"]);
      expect(result.refusals).toEqual([
        expect.objectContaining({
          error: "duplicate_claimants",
          taskId: "TASK-100",
          claimants: fixture.claimants,
        }),
      ]);
      expect(queue.getItem("TASK-100")).toBeUndefined();
      expect(queue.getItem("TASK-200")).toBeDefined();
    } finally {
      removeFixture(fixture.root);
    }
  });
});

it("enqueueMultiple preserves the already-queued no-op ahead of a contested check", () => {
  const fixture = createDuplicateFixture("quack-queue-existing-", "cross-population", "forward");
  try {
    const queue = makeQueue(fixture.root, manager());
    const existing = queue.enqueue("TASK-200");

    const result = queue.enqueueMultiple(
      ["TASK-200"],
      undefined,
      new Map([["TASK-200", { taskId: "TASK-200", claimants: fixture.claimants }]]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(existing);
    expect(result.refusals).toEqual([]);
  } finally {
    removeFixture(fixture.root);
  }
});

describe.each(DUPLICATE_FIXTURE_CASES)("enqueueSubtasks matrix (%s, %s)", (kind, order) => {
  it("enqueueSubtasks applies the same batch pre-scan before any contested row", () => {
    const fixture = createDuplicateFixture("quack-queue-subtasks-", kind, order);
    try {
      fs.writeFileSync(path.join(fixture.taskDir, "TASK-200-clean.md"), taskSpec("TASK-200"));
      const queue = makeQueue(fixture.root, manager());
      const result = queue.enqueueSubtasks(
        {
          parentTaskId: "TASK-900",
          subtasks: [
            { id: "TASK-100", dependsOn: [] },
            { id: "TASK-200", dependsOn: ["TASK-100"] },
          ],
        },
        undefined,
        new Map([
          ["TASK-100", check(fixture.claimants)],
          ["TASK-200", { taskId: "TASK-200", claimants: [] }],
        ]),
      ) as BatchItems;

      expect(result.map((item) => item.taskId)).toEqual(["TASK-200"]);
      expect(result.refusals?.[0]).toMatchObject({
        error: "duplicate_claimants",
        taskId: "TASK-100",
        claimants: fixture.claimants,
      });
      expect(queue.getItem("TASK-100")).toBeUndefined();
    } finally {
      removeFixture(fixture.root);
    }
  });
});

describe.each(DUPLICATE_FIXTURE_CASES)("enqueueAllEligible matrix (%s, %s)", (kind, order) => {
  it("enqueueAllEligible reports contested ids and admits the clean eligible row", async () => {
    const fixture = createDuplicateFixture("quack-queue-all-eligible-", kind, order, {
      status: "BACKLOG",
    });
    try {
      fs.writeFileSync(
        path.join(fixture.taskDir, "TASK-200-clean.md"),
        taskSpec("TASK-200", { status: "BACKLOG" }),
      );
      const queue = makeQueue(fixture.root, manager());

      const result = await queue.enqueueAllEligible();

      expect(result.map((item) => item.taskId)).toEqual(["TASK-200"]);
      expect(result.refusals).toEqual([
        expect.objectContaining({
          error: "duplicate_claimants",
          taskId: "TASK-100",
          claimants: fixture.claimants,
        }),
      ]);
      expect(queue.getItem("TASK-100")).toBeUndefined();
      expect(queue.getItem("TASK-200")).toBeDefined();
    } finally {
      removeFixture(fixture.root);
    }
  });
});
