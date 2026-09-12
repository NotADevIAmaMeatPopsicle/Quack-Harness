import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";

class FakeChild extends EventEmitter {
  pid = 2_000_000_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

interface ShutdownInternals {
  jobs: Map<string, DispatchJob>;
  processes: Map<string, ChildProcess>;
  signalProcessTree(taskId: string, child: ChildProcess, signal: NodeJS.Signals): void;
  persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
  persistWorktreeSurvivor(job: DispatchJob, processId: number): void;
}

function installTimedOutChild(
  manager: DispatchManager,
  taskId: string,
  worktreePath?: string,
): { internals: ShutdownInternals; job: DispatchJob } {
  const child = new FakeChild() as unknown as ChildProcess;
  const job: DispatchJob = {
    taskId,
    sessionId: `session-${taskId}`,
    pid: child.pid ?? 0,
    startedAt: new Date().toISOString(),
    status: "running",
    output: [],
    ...(worktreePath
      ? { worktreePath, worktreeOwnershipId: `owner-${taskId}` }
      : { sharedCheckoutOwnershipId: `owner-${taskId}` }),
  };
  const internals = manager as unknown as ShutdownInternals;
  internals.jobs.set(taskId, job);
  internals.processes.set(taskId, child);
  internals.signalProcessTree = jest.fn();
  return { internals, job };
}

describe("DispatchManager shutdown accounting", () => {
  let projectRoot: string;
  let manager: DispatchManager;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shutdown-accounting-"));
    manager = new DispatchManager(projectRoot, path.join(projectRoot, "fixture.js"));
  });

  afterEach(() => {
    const internals = manager as unknown as ShutdownInternals;
    internals.processes.clear();
    internals.jobs.clear();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("does not attest a timed-out worktree child when survivor persistence fails", async () => {
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-WORKTREE");
    const { internals } = installTimedOutChild(manager, "TASK-WORKTREE", worktreePath);
    internals.persistWorktreeSurvivor = jest.fn(() => {
      throw new Error("simulated worktree marker failure");
    });

    const result = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

    expect(result.timedOut).toEqual(["TASK-WORKTREE"]);
    expect(result.durableAccountingComplete).toBe(false);
  });

  it("does not attest a newly timed-out shared child when pause persistence fails", async () => {
    const { internals } = installTimedOutChild(manager, "TASK-SHARED-FAILED");
    internals.persistSharedCheckoutPause = jest.fn(() => {
      throw new Error("simulated shared marker failure");
    });

    const result = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

    expect(result.timedOut).toEqual(["TASK-SHARED-FAILED"]);
    expect(result.durableAccountingComplete).toBe(false);
  });

  it("attests a newly timed-out shared child only after exact ownership is durable", async () => {
    installTimedOutChild(manager, "TASK-SHARED-DURABLE");

    const result = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

    expect(result.timedOut).toEqual(["TASK-SHARED-DURABLE"]);
    expect(result.durableAccountingComplete).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, ".quack", "logs", "shared-checkout-pause.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      taskId: "TASK-SHARED-DURABLE",
      sessionId: "session-TASK-SHARED-DURABLE",
      status: "running",
      processId: 2_000_000_001,
    });
  });
});
