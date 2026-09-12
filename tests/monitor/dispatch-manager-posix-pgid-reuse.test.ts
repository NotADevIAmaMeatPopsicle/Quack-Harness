import type { ChildProcess } from "node:child_process";

import { DispatchManager } from "../../src/monitor/dispatch-manager";

describe("DispatchManager POSIX survivor process-group safety", () => {
  it("keeps timed-out evidence admission-blocking without re-signalling a recycled group id", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const manager = new DispatchManager("/fixture/project", "/fixture/quack.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const internals = manager as unknown as {
      retainUnconfirmedProcessGroup(taskId: string, processGroupId: number): void;
      signalProcessTree(
        taskId: string,
        child: ChildProcess,
        signal: NodeJS.Signals,
        windowsTimeoutMs: number,
      ): void;
      scheduleForcedTreeTermination(taskId: string, child: ChildProcess, delayMs: number): void;
    };
    const recycledProcessGroupId = 41_337;
    const childKill = jest.fn(() => true);
    const recycledChild = {
      pid: recycledProcessGroupId,
      kill: childKill,
    } as unknown as ChildProcess;
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    try {
      jest.useFakeTimers();
      // Inject the state reached only after the original group's bounded
      // TERM/KILL attempt has expired. The same numeric PGID may now identify
      // an unrelated process group.
      internals.retainUnconfirmedProcessGroup("TASK-PGID-REUSE", recycledProcessGroupId);

      expect(() =>
        internals.signalProcessTree("TASK-PGID-REUSE", recycledChild, "SIGKILL", 1_000),
      ).toThrow("numeric ID may have been recycled");
      internals.scheduleForcedTreeTermination("TASK-PGID-REUSE", recycledChild, 0);
      await jest.advanceTimersByTimeAsync(5_000);

      const repeatedShutdown = await manager.shutdownAll({
        gracefulTimeoutMs: 0,
        forceTimeoutMs: 0,
      });

      expect(repeatedShutdown.requested).toEqual(["TASK-PGID-REUSE"]);
      expect(repeatedShutdown.timedOut).toEqual(["TASK-PGID-REUSE"]);
      expect(manager.canResumeAfterShutdown()).toBe(false);
      expect(killSpy).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("cancels a delayed group kill when the root identity exits before escalation", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const manager = new DispatchManager("/fixture/project", "/fixture/quack.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const internals = manager as unknown as {
      processes: Map<string, ChildProcess>;
      unconfirmedProcessGroups: Map<string, number>;
      scheduleForcedTreeTermination(taskId: string, child: ChildProcess, delayMs: number): void;
    };
    const processGroupId = 51_337;
    const child = {
      pid: processGroupId,
      exitCode: null,
      signalCode: null,
      kill: jest.fn(() => true),
    } as unknown as ChildProcess;
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    try {
      jest.useFakeTimers();
      internals.processes.set("TASK-PRE-TIMEOUT-REUSE", child);
      internals.scheduleForcedTreeTermination("TASK-PRE-TIMEOUT-REUSE", child, 1_000);

      // The original root exits and its numeric PGID can now be recycled before
      // the delayed force timer fires.
      internals.processes.delete("TASK-PRE-TIMEOUT-REUSE");
      (child as { exitCode: number | null }).exitCode = 0;
      await jest.advanceTimersByTimeAsync(1_000);

      expect(killSpy).not.toHaveBeenCalled();
      expect(internals.unconfirmedProcessGroups.get("TASK-PRE-TIMEOUT-REUSE")).toBe(processGroupId);

      const shutdown = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });
      expect(shutdown.timedOut).toContain("TASK-PRE-TIMEOUT-REUSE");
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("never re-signals a timer-only process group during shutdown", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const manager = new DispatchManager("/fixture/project", "/fixture/quack.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const internals = manager as unknown as {
      stopEscalationTimers: Map<
        string,
        { timer: ReturnType<typeof setTimeout>; processGroupId?: number }
      >;
      unconfirmedProcessGroups: Map<string, number>;
    };
    const processGroupId = 61_337;
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    try {
      jest.useFakeTimers();
      const timer = setTimeout(() => undefined, 60_000);
      timer.unref();
      internals.stopEscalationTimers.set("TASK-ORPHAN-TIMER", { timer, processGroupId });

      const shutdown = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

      expect(shutdown.requested).toContain("TASK-ORPHAN-TIMER");
      expect(shutdown.timedOut).toContain("TASK-ORPHAN-TIMER");
      expect(internals.unconfirmedProcessGroups.get("TASK-ORPHAN-TIMER")).toBe(processGroupId);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("does not send shutdown SIGKILL after the tracked root exits on SIGTERM", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const manager = new DispatchManager("/fixture/project", "/fixture/quack.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const internals = manager as unknown as {
      processes: Map<string, ChildProcess>;
      unconfirmedProcessGroups: Map<string, number>;
    };
    const taskId = "TASK-SHUTDOWN-ROOT-EXIT";
    const processGroupId = 71_337;
    const child = {
      pid: processGroupId,
      exitCode: null,
      signalCode: null,
      kill: jest.fn(() => true),
    } as unknown as ChildProcess;
    const killSpy = jest.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === -processGroupId && signal === "SIGTERM") {
        (child as { exitCode: number | null }).exitCode = 0;
        internals.processes.delete(taskId);
      }
      // A descendant (or a recycled group) still appears at the number.
      return true;
    }) as typeof process.kill);

    try {
      jest.useFakeTimers();
      internals.processes.set(taskId, child);
      const shutdown = await manager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

      expect(killSpy).toHaveBeenCalledWith(-processGroupId, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-processGroupId, "SIGKILL");
      expect(internals.unconfirmedProcessGroups.get(taskId)).toBe(processGroupId);
      expect(shutdown.timedOut).toContain(taskId);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});
