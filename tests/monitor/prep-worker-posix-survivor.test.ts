import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { PrepWorker } from "../../src/monitor/prep-worker";

class FakeChild extends EventEmitter {
  pid = 52_525;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

describe("PrepWorker POSIX survivor reconciliation", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-posix-survivor-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("persists a timed-out group and never re-signals its numeric id after restart", async () => {
    const child = new FakeChild();
    const spawnProcess = jest.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    const firstKill = jest.fn(() => true) as unknown as typeof process.kill;
    const worker = new PrepWorker(projectRoot, "fixture.js", {
      platform: "linux",
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      killProcess: firstKill,
    });
    worker.start("TASK-PREP-GROUP");

    const first = await worker.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });
    expect(first.timedOut).toEqual(["TASK-PREP-GROUP"]);
    expect(firstKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(firstKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    const [survivor] = worker.getShutdownSurvivors();
    expect(survivor).toMatchObject({
      taskId: "TASK-PREP-GROUP",
      pid: child.pid,
      strategy: "posix-process-group",
    });

    const restartedKill = jest.fn(() => true) as unknown as typeof process.kill;
    const restarted = new PrepWorker(projectRoot, "fixture.js", {
      platform: "linux",
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      killProcess: restartedKill,
    });
    expect(() => restarted.start("TASK-OTHER")).toThrow(
      "unresolved Windows shutdown survivor evidence or POSIX process-group evidence",
    );
    const afterRestart = await restarted.shutdownAll({
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
    });
    expect(afterRestart.timedOut).toEqual(["TASK-PREP-GROUP"]);
    expect(restartedKill).not.toHaveBeenCalled();
    expect(restarted.canResumeAfterShutdown()).toBe(false);
    expect(
      restarted.reconcileShutdownSurvivor(survivor.taskId, survivor.confirmationToken, true),
    ).toBe(true);
    expect(restarted.resumeAfterShutdown()).toBe(true);
  });
});
