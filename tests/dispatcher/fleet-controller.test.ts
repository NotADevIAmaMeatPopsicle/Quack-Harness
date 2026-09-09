import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { FleetController } from "../../src/dispatcher/fleet-controller";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { PrepScheduler } from "../../src/monitor/prep-scheduler";
import { PrepWorker, type PrepJob } from "../../src/monitor/prep-worker";
import type { DispatchJob } from "../../src/monitor/dispatch-manager";

// ─── Mocks ─────────────────────────────────────────────────────────

class MockDispatchManager {
  private jobs = new Map<string, DispatchJob>();
  private mockPids = new Map<string, number>();

  start(taskId: string, pid = Math.floor(Math.random() * 100000) + 1): DispatchJob {
    const job: DispatchJob = {
      taskId,
      sessionId: `session-${taskId}`,
      pid,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    };
    this.jobs.set(taskId, job);
    this.mockPids.set(taskId, pid);
    return job;
  }

  stop(taskId: string): boolean {
    const job = this.jobs.get(taskId);
    if (job && job.status === "running") {
      job.status = "stopped";
      return true;
    }
    return false;
  }

  getActiveJobs(): DispatchJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.status === "running");
  }

  getAllJobs(): DispatchJob[] {
    return Array.from(this.jobs.values());
  }

  getJob(taskId: string): DispatchJob | undefined {
    return this.jobs.get(taskId);
  }

  getActiveJob(taskId: string): DispatchJob | undefined {
    const job = this.jobs.get(taskId);
    return job?.status === "running" ? job : undefined;
  }

  cleanup(): void {
    // No-op for mock
  }

  cleanupAllContainersCalled = false;
  shutdownAllCalled = false;
  canResumeAfterShutdownResult = true;
  resumeAfterShutdownCalled = false;

  cleanupAllContainers(): Promise<void> {
    this.cleanupAllContainersCalled = true;
    return Promise.resolve();
  }

  shutdownAll(): Promise<{
    requested: string[];
    exited: string[];
    escalated: string[];
    timedOut: string[];
  }> {
    this.shutdownAllCalled = true;
    const requested = this.getActiveJobs().map((job) => job.taskId);
    for (const taskId of requested) this.stop(taskId);
    return Promise.resolve({ requested, exited: requested, escalated: [], timedOut: [] });
  }

  canResumeAfterShutdown(): boolean {
    return this.canResumeAfterShutdownResult;
  }

  resumeAfterShutdown(): boolean {
    this.resumeAfterShutdownCalled = true;
    return this.canResumeAfterShutdownResult;
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      job.status = "stopped";
    }
  }
}

class MockPrepWorker {
  private jobs = new Map<string, PrepJob>();
  shutdownAllCalled = false;
  canResumeAfterShutdownResult = true;
  resumeAfterShutdownCalled = false;
  timedOutTasks: string[] = [];

  start(taskId: string): PrepJob {
    const job: PrepJob = {
      taskId,
      pid: Math.floor(Math.random() * 100000) + 1,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.jobs.set(taskId, job);
    return job;
  }

  shutdownAll(): Promise<{
    requested: string[];
    exited: string[];
    escalated: string[];
    timedOut: string[];
  }> {
    this.shutdownAllCalled = true;
    const requested = Array.from(this.jobs.values())
      .filter((job) => job.status === "running")
      .map((job) => job.taskId);
    const timedOut = requested.filter((taskId) => this.timedOutTasks.includes(taskId));
    const exited = requested.filter((taskId) => !this.timedOutTasks.includes(taskId));
    for (const taskId of exited) {
      const job = this.jobs.get(taskId);
      if (job) job.status = "failed";
    }
    return Promise.resolve({ requested, exited, escalated: [], timedOut });
  }

  canResumeAfterShutdown(): boolean {
    return this.canResumeAfterShutdownResult;
  }

  resumeAfterShutdown(): boolean {
    this.resumeAfterShutdownCalled = true;
    return this.canResumeAfterShutdownResult;
  }
}

class MockPrepScheduler {
  private running = false;

  start(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus() {
    return {
      enabled: true,
      running: this.running,
      queueSize: 0,
      activePreps: 0,
      prepsThisHour: 0,
      maxPerHour: 20,
      costThisHour: 0,
      maxBudgetPerHour: 2.0,
      totalProcessed: 0,
    };
  }

  getQueue(): string[] {
    return [];
  }

  updateConfig(): void {
    // No-op
  }
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("FleetController", () => {
  let tmpDir: string;
  let dispatchManager: MockDispatchManager;
  let prepScheduler: MockPrepScheduler;
  let prepWorker: MockPrepWorker;
  let controller: FleetController;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-fleet-test-"));
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    dispatchManager = new MockDispatchManager();
    prepScheduler = new MockPrepScheduler();
    prepWorker = new MockPrepWorker();
    controller = new FleetController(
      dispatchManager as unknown as DispatchManager,
      prepScheduler as unknown as PrepScheduler,
      tmpDir,
      prepWorker as unknown as PrepWorker,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("State management", () => {
    it("should initialize in running state", () => {
      expect(controller.getState()).toBe("running");
    });

    it("should allow pause and resume", async () => {
      dispatchManager.start("TASK-ACTIVE");
      controller.pause("Test pause");
      expect(controller.getState()).toBe("paused");

      const status = controller.getStatus();
      expect(status.state).toBe("paused");
      expect(status.reason).toBe("Test pause");

      await controller.resume();
      expect(controller.getState()).toBe("running");
      expect(controller.getStatus().reason).toBeUndefined();
      expect(dispatchManager.resumeAfterShutdownCalled).toBe(false);
    });

    it("should block dispatch when paused", () => {
      controller.pause();
      const check = controller.canDispatch();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("paused");
    });

    it("should block dispatch when emergency stopped", async () => {
      await controller.emergencyStop();
      const check = controller.canDispatch();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("emergency stop");
    });

    it("should allow dispatch when running", () => {
      const check = controller.canDispatch();
      expect(check.allowed).toBe(true);
      expect(check.reason).toBeUndefined();
    });
  });

  describe("Emergency stop", () => {
    it("should kill all active dispatches", async () => {
      // Start some jobs
      dispatchManager.start("TASK-001");
      dispatchManager.start("TASK-002");
      dispatchManager.start("TASK-003");

      expect(dispatchManager.getActiveJobs().length).toBe(3);

      const result = await controller.emergencyStop("Test emergency");
      expect(result.killedTasks).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
      expect(result.killedPids.length).toBe(3);

      // All jobs should be stopped
      expect(dispatchManager.getActiveJobs().length).toBe(0);
    });

    it("should stop prep scheduler if running", async () => {
      await prepScheduler.start();
      expect(prepScheduler.isRunning()).toBe(true);

      const result = await controller.emergencyStop();
      expect(result.prepStopped).toBe(true);
      expect(prepScheduler.isRunning()).toBe(false);
    });

    it("should await and account for active prep agents", async () => {
      prepWorker.start("TASK-PREP-1");
      prepWorker.start("TASK-PREP-2");

      const result = await controller.emergencyStop();

      expect(prepWorker.shutdownAllCalled).toBe(true);
      expect(result.prepStopped).toBe(true);
      expect(result.prepKilledTasks).toEqual(["TASK-PREP-1", "TASK-PREP-2"]);
      expect(result.prepTimedOutTasks).toEqual([]);
    });

    it("does not complete emergency stop before prep shutdown settles", async () => {
      let releasePrepShutdown!: () => void;
      const prepMayFinish = new Promise<void>((resolve) => {
        releasePrepShutdown = resolve;
      });
      jest.spyOn(prepWorker, "shutdownAll").mockImplementation(() =>
        prepMayFinish.then(() => ({
          requested: ["TASK-PREP-WAIT"],
          exited: ["TASK-PREP-WAIT"],
          escalated: [],
          timedOut: [],
        })),
      );
      let settled = false;

      const emergencyStop = controller.emergencyStop().then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releasePrepShutdown();
      await expect(emergencyStop).resolves.toMatchObject({
        prepKilledTasks: ["TASK-PREP-WAIT"],
      });
      expect(settled).toBe(true);
    });

    it("reports unconfirmed prep agents and refuses emergency resume", async () => {
      prepWorker.start("TASK-PREP-STUCK");
      prepWorker.timedOutTasks = ["TASK-PREP-STUCK"];
      prepWorker.canResumeAfterShutdownResult = false;

      const result = await controller.emergencyStop();

      expect(result.prepTimedOutTasks).toEqual(["TASK-PREP-STUCK"]);
      expect(result.errors).toContain("Timed out stopping prep resources for: TASK-PREP-STUCK");
      await expect(controller.resume()).rejects.toThrow(
        "Fleet cannot resume while agent resources are still shutting down",
      );
      expect(dispatchManager.resumeAfterShutdownCalled).toBe(false);
      expect(prepWorker.resumeAfterShutdownCalled).toBe(false);
    });

    it("should handle case when no jobs are running", async () => {
      const result = await controller.emergencyStop();
      expect(result.killedTasks).toEqual([]);
      expect(result.killedPids).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("should set state to emergency_stopped", async () => {
      await controller.emergencyStop();
      expect(controller.getState()).toBe("emergency_stopped");
    });

    it("should include reason in status", async () => {
      await controller.emergencyStop("Cost overrun detected");
      const status = controller.getStatus();
      expect(status.state).toBe("emergency_stopped");
      expect(status.reason).toBe("Cost overrun detected");
    });

    it("should use bounded dispatch shutdown during emergency stop", async () => {
      dispatchManager.start("TASK-001");
      await controller.emergencyStop();
      expect(dispatchManager.shutdownAllCalled).toBe(true);
    });

    it("never probes or kills pid zero for a pending container start", async () => {
      dispatchManager.start("TASK-PENDING-DOCKER", 0);
      const killSpy = jest.spyOn(process, "kill");

      try {
        const result = await controller.emergencyStop();

        expect(result.killedTasks).toEqual(["TASK-PENDING-DOCKER"]);
        expect(result.killedPids).toEqual([]);
        expect(killSpy).not.toHaveBeenCalledWith(0, expect.anything());
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("Pause and resume", () => {
    it("should pause fleet without stopping active jobs", () => {
      dispatchManager.start("TASK-001");
      dispatchManager.start("TASK-002");

      controller.pause("Manual pause");
      expect(controller.getState()).toBe("paused");

      // Jobs should still be running
      expect(dispatchManager.getActiveJobs().length).toBe(2);
    });

    it("should resume from paused state", async () => {
      controller.pause();
      expect(controller.getState()).toBe("paused");

      await controller.resume();
      expect(controller.getState()).toBe("running");
      expect(controller.canDispatch().allowed).toBe(true);
    });

    it("should resume from emergency_stopped state", async () => {
      await controller.emergencyStop();
      expect(controller.getState()).toBe("emergency_stopped");

      await controller.resume();
      expect(controller.getState()).toBe("running");
      expect(controller.canDispatch().allowed).toBe(true);
    });

    it("restarts prep scheduling only when it was running before emergency stop", async () => {
      await prepScheduler.start();
      await controller.emergencyStop();
      expect(prepScheduler.isRunning()).toBe(false);

      await controller.resume();
      expect(prepScheduler.isRunning()).toBe(true);

      const initiallyStopped = new MockPrepScheduler();
      const stoppedController = new FleetController(
        dispatchManager as unknown as DispatchManager,
        initiallyStopped as unknown as PrepScheduler,
        tmpDir,
        prepWorker as unknown as PrepWorker,
      );
      await stoppedController.emergencyStop();
      await stoppedController.resume();
      expect(initiallyStopped.isRunning()).toBe(false);
    });

    it("does not let an in-flight resume overwrite a later emergency stop", async () => {
      await prepScheduler.start();
      await controller.emergencyStop("first stop");

      let releaseStart!: () => void;
      const mayStart = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const originalStart = prepScheduler.start.bind(prepScheduler);
      jest.spyOn(prepScheduler, "start").mockImplementation(async () => {
        await mayStart;
        await originalStart();
      });

      const resume = controller.resume();
      await Promise.resolve();
      const laterEmergency = controller.emergencyStop("later stop");
      expect(controller.getState()).toBe("emergency_stopped");

      releaseStart();
      await expect(resume).rejects.toThrow("superseded by an emergency stop");
      await expect(laterEmergency).resolves.toBeDefined();
      expect(controller.getState()).toBe("emergency_stopped");
      expect(controller.getStatus().reason).toBe("later stop");
      expect(prepScheduler.isRunning()).toBe(false);
    });
  });

  describe("Fleet status", () => {
    it("should report active job count", () => {
      dispatchManager.start("TASK-001");
      dispatchManager.start("TASK-002");

      const status = controller.getStatus();
      expect(status.activeJobs).toBe(2);
      expect(status.state).toBe("running");
    });

    it("should report zero jobs when none active", () => {
      const status = controller.getStatus();
      expect(status.activeJobs).toBe(0);
    });
  });
});
