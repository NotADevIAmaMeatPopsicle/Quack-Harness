import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import {
  TASK_CREATION_LOCK_FILE,
  TASK_CREATION_LOCK_OWNER_FILE,
  TaskCreationScanUnavailableError,
  getTaskCreationReservationReleaseError,
  readTaskCreationClaimants,
  withTaskCreationReservation,
} from "../../src/core/task-creation-reservation";

// This module did not exist before TASK-1345. These tests pin the new shared
// critical-section contract, stale-owner recovery, cleanup, and fail-closed scan.

describe("TASK-1345 task creation reservation", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-create-lock-"));
  });

  afterEach(async () => {
    await fs.rm(taskDir, { recursive: true, force: true });
  });

  it("serializes competing creators and removes the reservation", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withTaskCreationReservation(
      taskDir,
      { creator: "planner", requestedIds: ["TASK-100"] },
      async () => {
        order.push("first-enter");
        await firstMayFinish;
        order.push("first-exit");
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const second = withTaskCreationReservation(
      taskDir,
      { creator: "task-watcher", requestedIds: ["TASK-100"] },
      () => {
        order.push("second-enter");
        return Promise.resolve();
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    await expect(fs.access(path.join(taskDir, TASK_CREATION_LOCK_FILE))).rejects.toThrow();
  });

  it("reclaims a stale same-host dead-owner reservation", async () => {
    const lockPath = path.join(taskDir, TASK_CREATION_LOCK_FILE);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "stale",
        pid: 999_999_999,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
        creator: "planner",
        requestedIds: ["TASK-100"],
      }),
    );
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, old, old);

    await expect(
      withTaskCreationReservation(taskDir, { creator: "decompose" }, () => Promise.resolve("ok"), {
        staleMs: 1,
        timeoutMs: 250,
        retryMs: 5,
      }),
    ).resolves.toBe("ok");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("cleans up after a creator failure", async () => {
    await expect(
      withTaskCreationReservation(taskDir, { creator: "validation-intake" }, () =>
        Promise.reject(new Error("write failed")),
      ),
    ).rejects.toThrow("write failed");
    await expect(fs.access(path.join(taskDir, TASK_CREATION_LOCK_FILE))).rejects.toThrow();
  });

  it("preserves the operation error identity while surfacing reservation cleanup failure", async () => {
    const operationError = new Error("primary write failed");
    let caught: unknown;
    try {
      await withTaskCreationReservation(taskDir, { creator: "decompose" }, async () => {
        await fs.writeFile(path.join(taskDir, TASK_CREATION_LOCK_FILE), "not-json\n");
        throw operationError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(operationError);
    expect(getTaskCreationReservationReleaseError(caught)).toBeInstanceOf(SyntaxError);
    expect(
      (caught as { reservationReleaseError?: unknown }).reservationReleaseError,
    ).toBeInstanceOf(SyntaxError);
  });

  it("does not lose cleanup evidence when the release observer also throws", async () => {
    const operationError = new Error("primary write failed");
    const observerError = new Error("cleanup observer failed");
    await expect(
      withTaskCreationReservation(
        taskDir,
        { creator: "decompose" },
        async () => {
          await fs.writeFile(path.join(taskDir, TASK_CREATION_LOCK_FILE), "not-json\n");
          throw operationError;
        },
        {
          onReleaseError: () => {
            throw observerError;
          },
        },
      ),
    ).rejects.toBe(operationError);
    const cleanup = getTaskCreationReservationReleaseError(operationError);
    expect(cleanup).toBeInstanceOf(AggregateError);
    expect((cleanup as AggregateError).errors[0]).toBeInstanceOf(SyntaxError);
    expect((cleanup as AggregateError).errors[1]).toBe(observerError);
  });

  it("never reclaims malformed ownership evidence, even when old", async () => {
    const lockPath = path.join(taskDir, TASK_CREATION_LOCK_FILE);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, TASK_CREATION_LOCK_OWNER_FILE), "not-json\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, old, old);

    await expect(
      withTaskCreationReservation(taskDir, { creator: "decompose" }, () => Promise.resolve(), {
        staleMs: 0,
        timeoutMs: 30,
        retryMs: 5,
      }),
    ).rejects.toThrow("Timed out waiting for task-creation reservation");
    await expect(
      fs.readFile(path.join(lockPath, TASK_CREATION_LOCK_OWNER_FILE), "utf-8"),
    ).resolves.toBe("not-json\n");
  });

  it("serializes multiple reclaimers and an acquirer racing on the same stale owner", async () => {
    const lockPath = path.join(taskDir, TASK_CREATION_LOCK_FILE);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "stale",
        pid: 999_999_999,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
        creator: "planner",
        requestedIds: ["TASK-100"],
      }),
    );
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, old, old);
    let active = 0;
    let maxActive = 0;
    const enter = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      active -= 1;
    };

    await Promise.all([
      withTaskCreationReservation(taskDir, { creator: "decompose" }, enter, {
        staleMs: 0,
        retryMs: 2,
      }),
      withTaskCreationReservation(taskDir, { creator: "dispatch-admission" }, enter, {
        staleMs: 0,
        retryMs: 2,
      }),
      withTaskCreationReservation(taskDir, { creator: "task-watcher" }, enter, {
        staleMs: 0,
        retryMs: 2,
      }),
    ]);

    expect(maxActive).toBe(1);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("publishes complete ownership evidence atomically at the live lock name", async () => {
    const lockPath = path.join(taskDir, TASK_CREATION_LOCK_FILE);
    await withTaskCreationReservation(
      taskDir,
      { creator: "decompose", requestedIds: ["TASK-100"] },
      async () => {
        const stat = await fs.lstat(lockPath);
        expect(stat.isFile()).toBe(true);
        expect(stat.nlink).toBe(1);
        const record = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
          token: string;
          pid: number;
          requestedIds: string[];
        };
        expect(record.token).toEqual(expect.any(String));
        expect(record.pid).toBe(process.pid);
        expect(record.requestedIds).toEqual(["TASK-100"]);
      },
    );
    expect((await fs.readdir(taskDir)).filter((name) => name.includes(".acquire-"))).toEqual([]);
  });

  it("reconciles a verified abandoned acquisition artifact", async () => {
    const fingerprint = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
    const deadPid = 999_999_999;
    const stagingPath = path.join(
      taskDir,
      `${TASK_CREATION_LOCK_FILE}.acquire-${fingerprint}-${deadPid}-0-${randomUUID()}`,
    );
    await fs.writeFile(
      stagingPath,
      `${JSON.stringify({
        token: "abandoned",
        pid: deadPid,
        hostname: os.hostname(),
        createdAt: "2000-01-01T00:00:00.000Z",
        creator: "decompose",
        requestedIds: [],
      })}\n`,
    );

    await expect(
      withTaskCreationReservation(taskDir, { creator: "planner" }, () => Promise.resolve("ok"), {
        staleMs: 0,
      }),
    ).resolves.toBe("ok");
    await expect(fs.access(stagingPath)).rejects.toThrow();
    await expect(fs.access(path.join(taskDir, TASK_CREATION_LOCK_FILE))).rejects.toThrow();
  });

  it("cleans an interrupted empty release tombstone without wedging admission", async () => {
    const fingerprint = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
    const tombstone = path.join(
      taskDir,
      `${TASK_CREATION_LOCK_FILE}.release-${fingerprint}-999999999-0-${randomUUID()}`,
    );
    await fs.mkdir(tombstone);

    await expect(
      withTaskCreationReservation(taskDir, { creator: "planner" }, () => Promise.resolve("ok"), {
        staleMs: 0,
      }),
    ).resolves.toBe("ok");
    await expect(fs.access(tombstone)).rejects.toThrow();
    await expect(fs.access(path.join(taskDir, TASK_CREATION_LOCK_FILE))).rejects.toThrow();
  });

  it("refuses when the strict claimant directory scan is unavailable", async () => {
    const missing = path.join(taskDir, "missing");
    await expect(readTaskCreationClaimants(missing)).rejects.toBeInstanceOf(
      TaskCreationScanUnavailableError,
    );
  });
});
