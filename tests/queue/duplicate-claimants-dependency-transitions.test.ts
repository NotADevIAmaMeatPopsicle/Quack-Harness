// TASK-1338-C pre-change record: each exact-id and fallback enrichment case
// executed and promoted the dependent to ready. The updateReadiness and both
// unblock arms also consumed contested completion tokens and red at the
// expected queued-plus-reason assertions.

import * as fs from "node:fs";
import * as path from "node:path";

import type { DispatchJob, DispatchManager } from "../../src/monitor/dispatch-manager";
import { EventReader } from "../../src/monitor/event-reader";
import { TaskService } from "../../src/monitor/task-service";
import { QuackDB } from "../../src/db/quack-db";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import type { DispatchQueueConfig, QueueItem } from "../../src/queue/queue-types";
import {
  DUPLICATE_FIXTURE_CASES,
  createSingleClaimantFixture,
  removeFixture,
  taskSpec,
  type DuplicateFixtureKind,
  type DuplicateFixtureOrder,
} from "../helpers/duplicate-claimants-fixture";

type DependencyKind = "exact" | "fallback";
type StructuredQueueItem = QueueItem & { duplicateBlockedBy?: string[] };
const DEPENDENCY_FIXTURE_CASES: ReadonlyArray<
  readonly [DependencyKind, DuplicateFixtureKind, DuplicateFixtureOrder]
> = DUPLICATE_FIXTURE_CASES.flatMap(([duplicateKind, order]) => [
  ["exact", duplicateKind, order] as const,
  ["fallback", duplicateKind, order] as const,
]);

function withBlockedBy(content: string, blockedBy: string): string {
  return content.replace("- **Blocked By:** []", `- **Blocked By:** [${blockedBy}]`);
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

function dispatchManager(): jest.Mocked<
  Pick<DispatchManager, "start" | "stop" | "getActiveJob" | "getJob" | "getActiveJobs">
> {
  return {
    start: jest.fn(
      (taskId: string): DispatchJob => ({
        taskId,
        sessionId: `session-${taskId}`,
        pid: 20,
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

function fixture(
  kind: DependencyKind,
  duplicateKind: DuplicateFixtureKind = "cross-population",
  order: DuplicateFixtureOrder = "forward",
): { root: string; taskDir: string; satisfiers: string[] } {
  const base = createSingleClaimantFixture(`quack-dependency-${kind}-`);
  fs.rmSync(base.claimantPaths[0]);
  if (kind === "exact") {
    const names =
      duplicateKind === "candidate-scoped"
        ? ["TASK-100-a.md", "TASK-100-b.md"]
        : ["TASK-100-a.md", "TASK-999-b.md"];
    const creationNames = order === "forward" ? names : [...names].reverse();
    for (const name of creationNames) {
      fs.writeFileSync(path.join(base.taskDir, name), taskSpec("TASK-100", { status: "COMPLETE" }));
    }
  } else {
    fs.writeFileSync(
      path.join(base.taskDir, "TASK-100-parent.md"),
      taskSpec("TASK-100", { status: "DECOMPOSED" }),
    );
    const names =
      duplicateKind === "candidate-scoped"
        ? ["TASK-100-A-a.md", "TASK-100-A-b.md"]
        : ["TASK-100-A-a.md", "TASK-998-b.md"];
    const creationNames = order === "forward" ? names : [...names].reverse();
    for (const name of creationNames) {
      fs.writeFileSync(
        path.join(base.taskDir, name),
        taskSpec("TASK-100-A", { status: "COMPLETE" }),
      );
    }
    fs.writeFileSync(
      path.join(base.taskDir, "TASK-100-B.md"),
      taskSpec("TASK-100-B", { status: "COMPLETE" }),
    );
  }
  fs.writeFileSync(
    path.join(base.taskDir, "TASK-200-dependent.md"),
    withBlockedBy(taskSpec("TASK-200", { status: "BACKLOG" }), "TASK-100"),
  );
  return {
    root: base.root,
    taskDir: base.taskDir,
    satisfiers: kind === "exact" ? ["TASK-100"] : ["TASK-100-A", "TASK-100-B"],
  };
}

function queue(root: string, projectionDb?: QuackDB): DispatchQueue {
  const logDir = path.join(root, ".quack", "logs");
  const dispatchQueue = new DispatchQueue(
    dispatchManager() as unknown as DispatchManager,
    new TaskService(root, "docs/tasks"),
    new EventReader(logDir),
    config(),
    logDir,
    undefined,
    projectionDb,
  );
  return dispatchQueue;
}

async function settle(queue: DispatchQueue, taskId = "TASK-200"): Promise<void> {
  const item = queue.getItem(taskId);
  if (!item) throw new Error(`Missing queue item ${taskId}`);
  for (let turn = 0; turn < 200; turn++) {
    if (!item.enrichmentPending) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${taskId} enrichment`);
}

async function tickReadiness(queue: DispatchQueue): Promise<void> {
  const updateReadiness = (
    queue as unknown as {
      updateReadiness: () => Promise<void>;
    }
  ).updateReadiness;
  await updateReadiness.call(queue);
}

describe.each(DEPENDENCY_FIXTURE_CASES)(
  "dependency claimant quarantine (%s, %s, %s)",
  (kind, duplicateKind, order) => {
    it("enrichQueueItem does not admit through contested completed satisfiers", async () => {
      const f = fixture(kind, duplicateKind, order);
      try {
        const listing = await new TaskService(f.root, "docs/tasks").listTasks();
        expect(listing.parseErrors).toEqual([]);
        expect(listing.tasks.map((task) => task.id)).toContain("TASK-200");
        const q = queue(f.root);
        q.enqueue("TASK-200");
        await settle(q);

        expect(q.getItem("TASK-200")?.status).toBe("queued");
        expect(q.getItem("TASK-200")?.blockedReason).toMatch(/duplicate claimants/i);
      } finally {
        removeFixture(f.root);
      }
    });

    it("updateReadiness keeps the dependent quarantined", async () => {
      const f = fixture(kind, duplicateKind, order);
      try {
        const q = queue(f.root);
        const dependent = q.enqueue("TASK-200");
        await settle(q);
        dependent.status = "queued";
        dependent.blockedBy = [...f.satisfiers];
        const items = (q as unknown as { items: Map<string, QueueItem> }).items;
        for (const id of f.satisfiers) {
          items.set(id, {
            taskId: id,
            status: "completed",
            priority: 2,
            blockedBy: [],
            enqueuedAt: new Date().toISOString(),
            retryCount: 0,
          });
        }
        const updateReadiness = (q as unknown as { updateReadiness: () => void | Promise<void> })
          .updateReadiness;

        await Promise.resolve(updateReadiness.call(q));

        expect(dependent.status).toBe("queued");
        expect(dependent.blockedReason).toMatch(/duplicate claimants/i);
      } finally {
        removeFixture(f.root);
      }
    });

    it("external completion does not unblock a contested satisfier", async () => {
      const f = fixture(kind, duplicateKind, order);
      try {
        const q = queue(f.root);
        const dependent = q.enqueue("TASK-200");
        await settle(q);
        dependent.status = "queued";
        dependent.blockedBy = [...f.satisfiers];

        for (const id of f.satisfiers) {
          await Promise.resolve(q.notifyExternalCompletion(id));
        }

        expect(dependent.status).toBe("queued");
        expect(dependent.blockedReason).toMatch(/duplicate claimants/i);
      } finally {
        removeFixture(f.root);
      }
    });

    it("normal queue completion persists itself but does not unblock dependents", async () => {
      const f = fixture(kind, duplicateKind, order);
      try {
        const q = queue(f.root);
        const dependent = q.enqueue("TASK-200");
        await settle(q);
        dependent.status = "queued";
        dependent.blockedBy = [...f.satisfiers];
        const items = (q as unknown as { items: Map<string, QueueItem> }).items;
        const handleTaskSuccess = (
          q as unknown as {
            handleTaskSuccess: (
              item: QueueItem,
              outcome: string,
              costUsd: number,
              durationMs: number,
            ) => void | Promise<void>;
          }
        ).handleTaskSuccess;

        for (const id of f.satisfiers) {
          const completed: QueueItem = {
            taskId: id,
            status: "running",
            priority: 2,
            blockedBy: [],
            enqueuedAt: new Date().toISOString(),
            retryCount: 0,
          };
          items.set(id, completed);
          await Promise.resolve(handleTaskSuccess.call(q, completed, "approved", 1, 10));
          expect(completed.status).toBe("completed");
        }

        expect(dependent.status).toBe("queued");
        expect(dependent.blockedReason).toMatch(/duplicate claimants/i);
      } finally {
        removeFixture(f.root);
      }
    });
  },
);

it("persists a mid-run completion but quarantines its dependent after a late contest", async () => {
  const fixture = createSingleClaimantFixture("quack-dependency-mid-run-");
  try {
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-200-dependent.md"),
      withBlockedBy(taskSpec("TASK-200", { status: "BACKLOG" }), "TASK-100"),
    );
    const q = queue(fixture.root);
    const dependent = q.enqueue("TASK-200");
    await settle(q);
    dependent.status = "queued";
    dependent.blockedBy = ["TASK-100"];
    const completed: QueueItem = {
      taskId: "TASK-100",
      status: "running",
      priority: 2,
      blockedBy: [],
      enqueuedAt: new Date().toISOString(),
      retryCount: 0,
    };
    const items = (q as unknown as { items: Map<string, QueueItem> }).items;
    items.set(completed.taskId, completed);
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-999-late.md"),
      taskSpec("TASK-100", { status: "COMPLETE" }),
    );
    const handleTaskSuccess = (
      q as unknown as {
        handleTaskSuccess: (
          item: QueueItem,
          outcome: string,
          costUsd: number,
          durationMs: number,
        ) => Promise<void>;
      }
    ).handleTaskSuccess;

    await handleTaskSuccess.call(q, completed, "approved", 1, 10);

    expect(completed.status).toBe("completed");
    expect(dependent.status).toBe("queued");
    expect(dependent.blockedBy).toEqual(["TASK-100"]);
    expect(dependent.blockedReason).toMatch(/duplicate claimants/i);
  } finally {
    removeFixture(fixture.root);
  }
});

it("promotes a quarantined row on the next readiness tick after the contest resolves", async () => {
  const f = fixture("exact");
  try {
    const q = queue(f.root);
    const dependent = q.enqueue("TASK-200") as StructuredQueueItem;
    await settle(q);
    const items = (q as unknown as { items: Map<string, QueueItem> }).items;
    items.set("TASK-100", {
      taskId: "TASK-100",
      status: "completed",
      priority: 2,
      blockedBy: [],
      enqueuedAt: new Date().toISOString(),
      retryCount: 0,
    });

    await tickReadiness(q);
    expect(dependent.status).toBe("queued");
    expect(dependent.duplicateBlockedBy).toEqual(["TASK-100"]);

    fs.rmSync(path.join(f.taskDir, "TASK-999-b.md"));
    await tickReadiness(q);

    expect(dependent.status).toBe("ready");
    expect(dependent.duplicateBlockedBy).toBeUndefined();
    expect(dependent.blockedReason).toBeUndefined();
  } finally {
    removeFixture(f.root);
  }
});

// TASK-1338-C round-2 pre-change record: both rows executed and stayed
// queued at the final promotion assertion after the claimant was removed.
it.each(["exact", "fallback"] as const)(
  "promotes a %s effective-status satisfier after its contest resolves",
  async (kind) => {
    const f = fixture(kind);
    try {
      const q = queue(f.root);
      const dependent = q.enqueue("TASK-200") as StructuredQueueItem;
      await settle(q);

      await tickReadiness(q);
      expect(dependent.status).toBe("queued");
      expect(dependent.duplicateBlockedBy).toEqual([kind === "exact" ? "TASK-100" : "TASK-100-A"]);

      fs.rmSync(path.join(f.taskDir, kind === "exact" ? "TASK-999-b.md" : "TASK-998-b.md"));
      await tickReadiness(q);

      expect(dependent.status).toBe("ready");
      expect(dependent.duplicateBlockedBy).toBeUndefined();
      expect(dependent.blockedReason).toBeUndefined();
    } finally {
      removeFixture(f.root);
    }
  },
);

// TASK-1338-C round-3 pre-change record: all four rows executed red because
// the fresh resolver returned DB-complete dependencies as unmet.
describe.each(["exact", "fallback"] as const)("DB-only %s dependency completion", (kind) => {
  it.each([false, true])(
    "refreshes both resolution points and quarantines contested=%s",
    async (contested) => {
      const f = fixture(kind);
      const duplicatePath = path.join(
        f.taskDir,
        kind === "exact" ? "TASK-999-b.md" : "TASK-998-b.md",
      );
      const claimantPaths =
        kind === "exact"
          ? ["TASK-100-a.md", "TASK-999-b.md"]
          : ["TASK-100-A-a.md", "TASK-998-b.md", "TASK-100-B.md"];
      for (const claimantPath of claimantPaths) {
        const taskId = claimantPath.includes("100-B")
          ? "TASK-100-B"
          : kind === "exact"
            ? "TASK-100"
            : "TASK-100-A";
        fs.writeFileSync(
          path.join(f.taskDir, claimantPath),
          taskSpec(taskId, { status: "BACKLOG" }),
        );
      }
      if (!contested) fs.rmSync(duplicatePath);

      const db = new QuackDB(path.join(f.root, ".quack", "quack.db"));
      try {
        for (const satisfier of f.satisfiers) {
          db.setStatus(satisfier, "COMPLETE", "round-3-fixture");
        }
        const q = queue(f.root, db);
        const dependent = q.enqueue("TASK-200") as StructuredQueueItem;
        await settle(q);

        const resolveCurrentDependencies = (
          q as unknown as {
            resolveCurrentDependencies: (
              taskId: string,
            ) => Promise<{ unmet: string[]; satisfiers: string[] }>;
          }
        ).resolveCurrentDependencies;
        await expect(resolveCurrentDependencies.call(q, "TASK-200")).resolves.toEqual({
          unmet: [],
          satisfiers: f.satisfiers,
        });

        await tickReadiness(q);
        expect(dependent.status).toBe(contested ? "queued" : "ready");
        expect(dependent.duplicateBlockedBy).toEqual(
          contested ? [kind === "exact" ? "TASK-100" : "TASK-100-A"] : undefined,
        );
      } finally {
        db.close();
        removeFixture(f.root);
      }
    },
  );
});

it("tracks every contested dependency and keeps the remaining name after one resolves", async () => {
  const base = createSingleClaimantFixture("quack-dependency-multi-contest-");
  try {
    fs.rmSync(base.claimantPaths[0]);
    for (const [name, taskId] of [
      ["TASK-100-a.md", "TASK-100"],
      ["TASK-999-a.md", "TASK-100"],
      ["TASK-300-a.md", "TASK-300"],
      ["TASK-998-a.md", "TASK-300"],
    ] as const) {
      fs.writeFileSync(path.join(base.taskDir, name), taskSpec(taskId, { status: "COMPLETE" }));
    }
    fs.writeFileSync(
      path.join(base.taskDir, "TASK-200-dependent.md"),
      withBlockedBy(taskSpec("TASK-200", { status: "BACKLOG" }), "TASK-100, TASK-300"),
    );
    const q = queue(base.root);
    const dependent = q.enqueue("TASK-200") as StructuredQueueItem;
    await settle(q);
    const items = (q as unknown as { items: Map<string, QueueItem> }).items;
    for (const taskId of ["TASK-100", "TASK-300"]) {
      items.set(taskId, {
        taskId,
        status: "completed",
        priority: 2,
        blockedBy: [],
        enqueuedAt: new Date().toISOString(),
        retryCount: 0,
      });
    }

    await tickReadiness(q);
    expect(dependent.duplicateBlockedBy).toEqual(["TASK-100", "TASK-300"]);
    expect(dependent.blockedReason).toContain("TASK-100");
    expect(dependent.blockedReason).toContain("TASK-300");

    fs.rmSync(path.join(base.taskDir, "TASK-999-a.md"));
    await tickReadiness(q);

    expect(dependent.status).toBe("queued");
    expect(dependent.duplicateBlockedBy).toEqual(["TASK-300"]);
    expect(dependent.blockedReason).not.toContain("TASK-100");
    expect(dependent.blockedReason).toContain("TASK-300");
  } finally {
    removeFixture(base.root);
  }
});
