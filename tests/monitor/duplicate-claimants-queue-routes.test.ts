// TASK-1338-C pre-change record: explicit enqueue, enqueue-all and retry all
// reached their synchronous core call. Explicit and enqueue-all returned 200
// with contested rows; retry returned 200 from the mocked mutation seam.

import * as fs from "node:fs";
import * as path from "node:path";

import { DispatchQueue } from "../../src/queue/dispatch-queue";
import { createMonitorServer } from "../../src/monitor/server";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectPinnedHttpRefusal,
  postJson,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

describe.each(DUPLICATE_FIXTURE_CASES)("queue route claimant scan (%s, %s)", (kind, order) => {
  it("explicit enqueue refuses before the core mutation", async () => {
    const fixture = createDuplicateFixture("quack-queue-route-enqueue-", kind, order);
    let stop: (() => Promise<void>) | undefined;
    try {
      const adapterPath = writeAdapter(fixture.root);
      const monitor = createMonitorServer({
        port: 0,
        host: "127.0.0.1",
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;

      const response = await postJson(started.port, "/api/queue/enqueue", {
        taskIds: ["TASK-100"],
      });

      expectPinnedHttpRefusal(response, fixture.claimants);
      const queueLog = path.join(fixture.root, ".quack", "logs", "dispatch-queue.jsonl");
      expect(fs.existsSync(queueLog) ? fs.readFileSync(queueLog, "utf-8") : "").not.toContain(
        "TASK-100",
      );
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  });

  it("retry refuses before invoking its synchronous mutation", async () => {
    const fixture = createDuplicateFixture("quack-queue-route-retry-", kind, order);
    const retrySpy = jest.spyOn(DispatchQueue.prototype, "retry").mockReturnValue(true);
    let stop: (() => Promise<void>) | undefined;
    try {
      fs.writeFileSync(
        path.join(fixture.root, ".quack", "logs", "dispatch-queue.jsonl"),
        [
          {
            ts: "2026-08-18T00:00:00.000Z",
            type: "task_enqueued",
            taskId: "TASK-100",
            priority: 2,
            blockedBy: [],
          },
          {
            ts: "2026-08-18T00:01:00.000Z",
            type: "task_failed",
            taskId: "TASK-100",
            reason: "fixture",
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
      const adapterPath = writeAdapter(fixture.root);
      const monitor = createMonitorServer({
        port: 0,
        host: "127.0.0.1",
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;

      const response = await postJson(started.port, "/api/queue/tasks/TASK-100/retry", {});

      expectPinnedHttpRefusal(response, fixture.claimants);
      expect(retrySpy).not.toHaveBeenCalled();
    } finally {
      await stop?.();
      retrySpy.mockRestore();
      removeFixture(fixture.root);
    }
  });
});

describe.each(DUPLICATE_FIXTURE_CASES)("enqueue-all route matrix (%s, %s)", (kind, order) => {
  it("enqueue-all inserts clean eligible rows and reports each contested id", async () => {
    const fixture = createDuplicateFixture("quack-queue-route-all-", kind, order, {
      status: "BACKLOG",
    });
    let stop: (() => Promise<void>) | undefined;
    try {
      fs.writeFileSync(
        path.join(fixture.taskDir, "TASK-200-clean.md"),
        taskSpec("TASK-200", { status: "BACKLOG" }),
      );
      const adapterPath = writeAdapter(fixture.root);
      const monitor = createMonitorServer({
        port: 0,
        host: "127.0.0.1",
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;

      const response = await postJson(started.port, "/api/queue/enqueue-all", {});

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        ok: false,
        error: "duplicate_claimants",
        refusals: [expect.objectContaining({ taskId: "TASK-100", claimants: fixture.claimants })],
        items: [expect.objectContaining({ taskId: "TASK-200" })],
      });
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  });
});

it("explicit enqueue preserves the already-queued response after a contest forms", async () => {
  const fixture = createSingleClaimantFixture("quack-queue-route-existing-");
  let stop: (() => Promise<void>) | undefined;
  try {
    const adapterPath = writeAdapter(fixture.root);
    const monitor = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await monitor.start();
    stop = started.stop;
    const first = await postJson(started.port, "/api/queue/enqueue", {
      taskIds: ["TASK-100"],
    });
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-999-late.md"), taskSpec("TASK-100"));

    const second = await postJson(started.port, "/api/queue/enqueue", {
      taskIds: ["TASK-100"],
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      items: [expect.objectContaining({ taskId: "TASK-100" })],
    });
    const queueLog = fs.readFileSync(
      path.join(fixture.root, ".quack", "logs", "dispatch-queue.jsonl"),
      "utf-8",
    );
    expect(queueLog.match(/"type":"task_enqueued"/g)).toHaveLength(1);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});

it("registers typed payloads for both duplicate-admission queue events", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src", "monitor", "event-types.ts"),
    "utf-8",
  );

  expect(source).toContain('| "dispatch_queue_task_refused"');
  expect(source).toContain('| "dispatch_queue_recovery_scan_unavailable"');
  expect(source).toContain("export interface DispatchQueueTaskRefusedPayload");
  expect(source).toContain("export interface DispatchQueueRecoveryScanUnavailablePayload");
  expect(source).toContain("| DispatchQueueTaskRefusedPayload");
  expect(source).toContain("| DispatchQueueRecoveryScanUnavailablePayload");
});

it("renders both duplicate-admission queue events in dashboard activity", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src", "monitor", "public", "index.html"),
    "utf-8",
  );

  expect(source.match(/case 'dispatch_queue_task_refused'/g) ?? []).toHaveLength(2);
  expect(source.match(/case 'dispatch_queue_recovery_scan_unavailable'/g) ?? []).toHaveLength(2);
  expect(source).toContain("Queue admission refused:");
  expect(source).toContain("Queue recovery scan unavailable:");
});
