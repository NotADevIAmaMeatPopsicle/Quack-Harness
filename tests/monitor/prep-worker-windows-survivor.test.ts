import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { PrepWorker } from "../../src/monitor/prep-worker";

class FakeChild extends EventEmitter {
  pid = 42_424;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

describe("PrepWorker Windows survivor reconciliation", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-win-survivor-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("never retries a failed taskkill PID and requires exact durable reconciliation", async () => {
    const child = new FakeChild();
    const spawnProcess = jest.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    const taskkill = jest.fn(() => {
      throw new Error("simulated taskkill failure");
    });
    const worker = new PrepWorker(projectRoot, "fixture.js", {
      platform: "win32",
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      execFileSync: taskkill as unknown as typeof import("node:child_process").execFileSync,
    });
    worker.start("TASK-PREP-PID");

    const first = await worker.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });
    expect(first.timedOut).toEqual(["TASK-PREP-PID"]);
    expect(taskkill).toHaveBeenCalledTimes(1);
    const [survivor] = worker.getShutdownSurvivors();
    expect(survivor).toMatchObject({ taskId: "TASK-PREP-PID", pid: child.pid });

    await worker.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });
    expect(taskkill).toHaveBeenCalledTimes(1);

    const restartedTaskkill = jest.fn();
    const restarted = new PrepWorker(projectRoot, "fixture.js", {
      platform: "win32",
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      execFileSync:
        restartedTaskkill as unknown as typeof import("node:child_process").execFileSync,
    });
    expect(() => restarted.start("TASK-OTHER")).toThrow(
      "unresolved Windows shutdown survivor evidence",
    );
    const afterRestart = await restarted.shutdownAll({
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
    });
    expect(afterRestart.timedOut).toEqual(["TASK-PREP-PID"]);
    expect(restartedTaskkill).not.toHaveBeenCalled();
    expect(restarted.canResumeAfterShutdown()).toBe(false);
    expect(restarted.resumeAfterShutdown()).toBe(false);
    expect(() => restarted.start("TASK-OTHER")).toThrow("Prep worker is shutting down");

    expect(restarted.reconcileShutdownSurvivor(survivor.taskId, "stale-token", true)).toBe(false);
    expect(
      restarted.reconcileShutdownSurvivor(survivor.taskId, survivor.confirmationToken, false),
    ).toBe(false);
    expect(
      restarted.reconcileShutdownSurvivor(survivor.taskId, survivor.confirmationToken, true),
    ).toBe(true);
    expect(restarted.getShutdownSurvivors()).toEqual([]);
    expect(restarted.resumeAfterShutdown()).toBe(true);
  });
});
