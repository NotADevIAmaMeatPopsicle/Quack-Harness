// TASK-1338-C pre-change record: all recovery cases executed. Replayed rows
// installed as runnable queued items, immediate start dispatched them, missing
// task directories were treated as clean, and QueueStats had no pending count.

import * as fs from "node:fs";
import * as path from "node:path";

import type { DispatchJob, DispatchManager } from "../../src/monitor/dispatch-manager";
import { EventReader } from "../../src/monitor/event-reader";
import { TaskService } from "../../src/monitor/task-service";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { DispatchQueueConfig, QueueItem } from "../../src/queue/queue-types";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  removeFixture,
  taskSpec,
  type DuplicateFixtureKind,
  type DuplicateFixtureOrder,
} from "../helpers/duplicate-claimants-fixture";

function config(): DispatchQueueConfig {
  return {
    maxConcurrent: 1,
    cooldownBetweenTasksMs: 0,
    failurePropagation: "skip_dependents",
    fleetBudgetUsd: 0,
    pauseOnFailure: false,
    persistState: true,
    autoStartOnEnqueue: false,
  };
}

type StructuredQueueItem = QueueItem & { duplicateBlockedBy?: string[] };

function manager(): jest.Mocked<
  Pick<DispatchManager, "start" | "stop" | "getActiveJob" | "getJob" | "getActiveJobs">
> {
  return {
    start: jest.fn(
      (taskId: string): DispatchJob => ({
        taskId,
        sessionId: `session-${taskId}`,
        pid: 10,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
      }),
    ),
    stop: jest.fn(),
    getActiveJob: jest.fn(),
    getJob: jest.fn(),
    getActiveJobs: jest.fn().mockReturnValue([]),
  };
}

function persistRows(logDir: string, taskIds: string[]): void {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "dispatch-queue.jsonl"),
    taskIds
      .map((taskId) =>
        JSON.stringify({
          ts: "2026-08-18T00:00:00.000Z",
          type: "task_enqueued",
          taskId,
          priority: 2,
          blockedBy: [],
        }),
      )
      .join("\n") + "\n",
  );
  fs.writeFileSync(path.join(logDir, "sessions.jsonl"), "");
}

function queueFor(
  root: string,
  dispatchManager: ReturnType<typeof manager>,
  taskService = new TaskService(root, "docs/tasks"),
): DispatchQueue {
  const logDir = path.join(root, ".quack", "logs");
  return new DispatchQueue(
    dispatchManager as unknown as DispatchManager,
    taskService,
    new EventReader(logDir),
    config(),
    logDir,
  );
}

async function startQueue(queue: DispatchQueue): Promise<void> {
  await Promise.resolve(queue.start());
  for (let turn = 0; turn < 20; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settleQueueItem(queue: DispatchQueue, taskId: string): Promise<void> {
  const item = queue.getItem(taskId);
  if (!item) throw new Error(`Missing queue item ${taskId}`);
  for (let turn = 0; turn < 200; turn++) {
    if (!item.enrichmentPending) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${taskId} enrichment`);
}

it("holds an immediately-started recovered contested row behind the scan", async () => {
  const fixture = createDuplicateFixture(
    "quack-recovery-contested-",
    "cross-population",
    "forward",
  );
  try {
    persistRows(path.join(fixture.root, ".quack", "logs"), ["TASK-100"]);
    const dispatchManager = manager();
    const queue = queueFor(fixture.root, dispatchManager);

    expect(queue.getItem("TASK-100")?.status).toBe("recovered_pending_scan");
    await startQueue(queue);

    expect(dispatchManager.start).not.toHaveBeenCalled();
    expect(queue.getItem("TASK-100")?.status).toBe("blocked");
    expect(queue.getItem("TASK-100")?.blockedReason).toMatch(/duplicate claimants/i);
  } finally {
    removeFixture(fixture.root);
  }
});

it("promotes and dispatches a clean recovered row after a successful scan", async () => {
  const fixture = createSingleClaimantFixture("quack-recovery-clean-");
  try {
    persistRows(path.join(fixture.root, ".quack", "logs"), ["TASK-100"]);
    const dispatchManager = manager();
    const queue = queueFor(fixture.root, dispatchManager);

    await startQueue(queue);

    expect(dispatchManager.start).toHaveBeenCalledWith(
      "TASK-100",
      expect.objectContaining({ duplicateClaimantCheck: { taskId: "TASK-100", claimants: [] } }),
      { taskId: "TASK-100", claimants: [] },
    );
    expect(queue.getItem("TASK-100")?.status).toBe("running");
    queue.stop();
  } finally {
    removeFixture(fixture.root);
  }
});

it("settles unavailable without dispatch, reports it, then retries cleanly", async () => {
  const fixture = createSingleClaimantFixture("quack-recovery-unavailable-");
  try {
    const logDir = path.join(fixture.root, ".quack", "logs");
    persistRows(logDir, ["TASK-100", "TASK-200"]);
    fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    const dispatchManager = manager();
    const queue = queueFor(fixture.root, dispatchManager);

    await startQueue(queue);

    const unavailable = queue.getStats();
    expect(dispatchManager.start).not.toHaveBeenCalled();
    expect(unavailable.recoveredPendingScan).toBe(2);
    expect(unavailable.recoveryScanUnavailableReason).toMatch(/task directory.*unavailable/i);
    expect(queue.isRunning()).toBe(false);

    fs.mkdirSync(fixture.taskDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-100-clean.md"), taskSpec("TASK-100"));
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-200-a.md"), taskSpec("TASK-200"));
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-999-b.md"), taskSpec("TASK-200"));

    await startQueue(queue);

    expect(dispatchManager.start).toHaveBeenCalledWith(
      "TASK-100",
      expect.objectContaining({ duplicateClaimantCheck: { taskId: "TASK-100", claimants: [] } }),
      { taskId: "TASK-100", claimants: [] },
    );
    expect(queue.getItem("TASK-200")?.status).toBe("blocked");
    expect(queue.getItem("TASK-200")?.blockedReason).toMatch(/duplicate claimants/i);
    expect(queue.getStats().recoveryScanUnavailableReason).toBeUndefined();
    queue.stop();
  } finally {
    removeFixture(fixture.root);
  }
});

describe.each(DUPLICATE_FIXTURE_CASES)(
  "fresh target check before deferred dispatch (%s, %s)",
  (kind, order) => {
    it("refuses a claimant that lands after enqueue", async () => {
      const fixture = createDuplicateFixture("quack-deferred-dispatch-", kind, order);
      const latePath = order === "forward" ? fixture.claimantPaths[1] : fixture.claimantPaths[0];
      const lateContent = fs.readFileSync(latePath, "utf-8");
      fs.rmSync(latePath);
      try {
        const dispatchManager = manager();
        const queue = queueFor(fixture.root, dispatchManager);
        queue.enqueue("TASK-100");
        await settleQueueItem(queue, "TASK-100");
        fs.writeFileSync(latePath, lateContent);

        await startQueue(queue);

        expect(dispatchManager.start).not.toHaveBeenCalled();
        expect(queue.getItem("TASK-100")?.status).toBe("blocked");
        expect(queue.getItem("TASK-100")?.blockedReason).toMatch(/duplicate claimants/i);
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

// TASK-1338-C round-2 mutation record: removing both enrichment-pending
// decision guards called resolveCurrentDependencies once before this gate settled.
it("never enters dispatch resolution before initial enrichment settles", async () => {
  const fixture = createSingleClaimantFixture("quack-enrichment-pending-");
  let releaseEnrichment = (): void => undefined;
  let queue: DispatchQueue | undefined;
  try {
    const taskService = new TaskService(fixture.root, "docs/tasks");
    const originalListTasks = taskService.listTasks.bind(taskService);
    const enrichmentGate = new Promise<void>((resolve) => {
      releaseEnrichment = resolve;
    });
    jest.spyOn(taskService, "listTasks").mockImplementationOnce(async () => {
      await enrichmentGate;
      return originalListTasks();
    });
    const dispatchManager = manager();
    queue = queueFor(fixture.root, dispatchManager, taskService);
    const dispatchResolution = jest.spyOn(
      queue as unknown as {
        resolveCurrentDependencies: (
          taskId: string,
        ) => Promise<{ unmet: string[]; satisfiers: string[] }>;
      },
      "resolveCurrentDependencies",
    );

    queue.enqueue("TASK-100");
    await startQueue(queue);
    for (let turn = 0; turn < 20 && dispatchResolution.mock.calls.length === 0; turn++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(dispatchResolution).not.toHaveBeenCalled();
    expect(dispatchManager.start).not.toHaveBeenCalled();
    expect(queue.getItem("TASK-100")?.status).toBe("queued");

    releaseEnrichment();
    await settleQueueItem(queue, "TASK-100");
    for (let turn = 0; turn < 200 && dispatchManager.start.mock.calls.length === 0; turn++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(dispatchResolution).toHaveBeenCalledTimes(1);
    expect(dispatchManager.start).toHaveBeenCalledTimes(1);
  } finally {
    releaseEnrichment();
    queue?.abort();
    removeFixture(fixture.root);
  }
});

function lateDependencyFixture(
  dependencyKind: "exact" | "fallback",
  duplicateKind: DuplicateFixtureKind,
  order: DuplicateFixtureOrder,
): {
  root: string;
  taskDir: string;
  latePath: string;
  lateContent: string;
  contestedId: string;
} {
  const fixture = createDuplicateFixture(
    `quack-late-${dependencyKind}-dependency-`,
    duplicateKind,
    order,
    { status: "COMPLETE" },
  );
  if (dependencyKind === "fallback") {
    for (const claimantPath of fixture.claimantPaths) fs.rmSync(claimantPath);
    const names =
      duplicateKind === "candidate-scoped"
        ? ["TASK-100-A-a.md", "TASK-100-A-b.md"]
        : ["TASK-100-A-a.md", "TASK-999-b.md"];
    const creationNames = order === "forward" ? names : [...names].reverse();
    for (const name of creationNames) {
      fs.writeFileSync(
        path.join(fixture.taskDir, name),
        taskSpec("TASK-100-A", { status: "COMPLETE" }),
      );
    }
    fixture.claimantPaths = names.map((name) => path.join(fixture.taskDir, name));
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-100-parent.md"),
      taskSpec("TASK-100", { status: "DECOMPOSED" }),
    );
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-100-B.md"),
      taskSpec("TASK-100-B", { status: "COMPLETE" }),
    );
  }
  const latePath = order === "forward" ? fixture.claimantPaths[1] : fixture.claimantPaths[0];
  const lateContent = fs.readFileSync(latePath, "utf-8");
  fs.rmSync(latePath);
  fs.writeFileSync(
    path.join(fixture.taskDir, "TASK-200-dependent.md"),
    taskSpec("TASK-200", { status: "BACKLOG" }).replace(
      "- **Blocked By:** []",
      "- **Blocked By:** [TASK-100]",
    ),
  );
  return {
    root: fixture.root,
    taskDir: fixture.taskDir,
    latePath,
    lateContent,
    contestedId: dependencyKind === "exact" ? "TASK-100" : "TASK-100-A",
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "fresh dependency check before deferred dispatch (%s, %s)",
  (duplicateKind, order) => {
    it.each(["exact", "fallback"] as const)(
      "refuses a late %s satisfier contest",
      async (dependencyKind) => {
        const fixture = lateDependencyFixture(dependencyKind, duplicateKind, order);
        try {
          const dispatchManager = manager();
          const queue = queueFor(fixture.root, dispatchManager);
          queue.enqueue("TASK-200");
          await settleQueueItem(queue, "TASK-200");
          expect(queue.getItem("TASK-200")?.status).toBe("ready");
          fs.writeFileSync(fixture.latePath, fixture.lateContent);

          await startQueue(queue);

          expect(dispatchManager.start).not.toHaveBeenCalled();
          expect(queue.getItem("TASK-200")?.status).toBe("blocked");
          expect(
            (queue.getItem("TASK-200") as StructuredQueueItem | undefined)?.duplicateBlockedBy,
          ).toEqual([fixture.contestedId]);
          expect(queue.getItem("TASK-200")?.blockedReason).toContain(fixture.contestedId);
        } finally {
          removeFixture(fixture.root);
        }
      },
    );
  },
);
