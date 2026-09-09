// ─── Fleet Controller ──────────────────────────────────────────────
// Manages fleet-wide operational state for agent dispatches.
// Provides emergency stop, pause/resume controls, and state queries.

import type {
  DispatchManager,
  SharedCheckoutShutdownSurvivor,
} from "../monitor/dispatch-manager.js";
import type { PrepScheduler } from "../monitor/prep-scheduler.js";
import type { PrepShutdownSurvivor, PrepWorker } from "../monitor/prep-worker.js";
import { execSync } from "node:child_process";

export type FleetState = "running" | "paused" | "emergency_stopped";

export interface EmergencyStopResult {
  killedTasks: string[];
  killedPids: number[];
  prepStopped: boolean;
  prepKilledTasks: string[];
  prepTimedOutTasks: string[];
  errors: string[];
}

export interface FleetStatus {
  state: FleetState;
  activeJobs: number;
  reason?: string;
}

export class FleetController {
  private state: FleetState = "running";
  private reason?: string;
  private restartPrepSchedulerAfterEmergencyStop = false;

  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly prepScheduler: PrepScheduler | null,
    private readonly projectRoot: string,
    private readonly prepWorker: PrepWorker | null = null,
  ) {}

  /**
   * Get current fleet state.
   */
  getState(): FleetState {
    return this.state;
  }

  /**
   * Get fleet status with active job count.
   */
  getStatus(): FleetStatus {
    return {
      state: this.state,
      activeJobs: this.dispatchManager.getActiveJobs().length,
      reason: this.reason,
    };
  }

  /**
   * Check if new dispatches are allowed.
   */
  canDispatch(): { allowed: boolean; reason?: string } {
    if (this.state === "paused") {
      return { allowed: false, reason: "Fleet is paused" };
    }
    if (this.state === "emergency_stopped") {
      return { allowed: false, reason: "Fleet is in emergency stop mode" };
    }
    return { allowed: true };
  }

  /**
   * Pause the fleet — prevent new dispatches while active ones continue.
   */
  pause(reason = "Manual pause"): void {
    this.state = "paused";
    this.reason = reason;
  }

  /**
   * Resume the fleet from paused or emergency_stopped state.
   */
  async resume(): Promise<void> {
    if (this.state === "emergency_stopped") {
      if (
        !this.dispatchManager.canResumeAfterShutdown() ||
        (this.prepWorker !== null && !this.prepWorker.canResumeAfterShutdown())
      ) {
        throw new Error("Fleet cannot resume while agent resources are still shutting down");
      }
      // The readiness checks above make reopening both managers atomic from
      // the controller's perspective: neither admission surface is reopened
      // when either manager still has unconfirmed children.
      if (
        !this.dispatchManager.resumeAfterShutdown() ||
        (this.prepWorker !== null && !this.prepWorker.resumeAfterShutdown())
      ) {
        throw new Error("Fleet cannot resume while agent resources are still shutting down");
      }
      if (this.restartPrepSchedulerAfterEmergencyStop && this.prepScheduler) {
        try {
          await this.prepScheduler.start();
        } catch (error) {
          this.prepScheduler.stop();
          throw error;
        }
      }
      this.restartPrepSchedulerAfterEmergencyStop = false;
    }
    this.state = "running";
    this.reason = undefined;
  }

  getPrepShutdownSurvivors(): PrepShutdownSurvivor[] {
    return this.prepWorker?.getShutdownSurvivors() ?? [];
  }

  reconcilePrepShutdownSurvivor(
    taskId: string,
    confirmationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    return (
      this.prepWorker?.reconcileShutdownSurvivor(
        taskId,
        confirmationToken,
        processTreeConfirmedStopped,
      ) ?? false
    );
  }

  getSharedCheckoutShutdownSurvivor(): SharedCheckoutShutdownSurvivor | undefined {
    return this.dispatchManager.getSharedCheckoutShutdownSurvivor();
  }

  reconcileSharedCheckoutShutdownSurvivor(
    taskId: string,
    sessionId: string,
    reconciliationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    return this.dispatchManager.reconcileSharedCheckoutShutdownSurvivor(
      taskId,
      sessionId,
      reconciliationToken,
      processTreeConfirmedStopped,
    );
  }

  /**
   * Emergency stop — kill all active agents and stop auto-prep.
   * This is the nuclear option: SIGTERM all processes, then SIGKILL
   * after timeout if they don't exit gracefully.
   */
  async emergencyStop(reason = "Emergency stop"): Promise<EmergencyStopResult> {
    if (this.state !== "emergency_stopped") {
      this.restartPrepSchedulerAfterEmergencyStop = this.prepScheduler?.isRunning() ?? false;
    }
    this.state = "emergency_stopped";
    this.reason = reason;

    const result: EmergencyStopResult = {
      killedTasks: [],
      killedPids: [],
      prepStopped: false,
      prepKilledTasks: [],
      prepTimedOutTasks: [],
      errors: [],
    };

    // Stop auto-prep scheduler if running
    if (this.prepScheduler?.isRunning()) {
      try {
        this.prepScheduler.stop();
        result.prepStopped = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to stop prep scheduler: ${msg}`);
      }
    }

    // Start prep termination before awaiting dispatch shutdown so neither
    // agent class is allowed to keep running during the other's grace period.
    const prepShutdown = this.prepWorker?.shutdownAll({
      gracefulTimeoutMs: 5_000,
      forceTimeoutMs: 5_000,
    });

    // Snapshot active jobs for operator-facing PID evidence, then delegate the
    // actual termination/confirmation to DispatchManager. This also covers
    // pending Docker creates (pid 0), approval pauses, descendants, and
    // orphaned tracked containers that the legacy PID loop could not see.
    const activeJobs = this.dispatchManager.getActiveJobs();
    const dispatchShutdown = this.dispatchManager.shutdownAll({
      gracefulTimeoutMs: 5_000,
      forceTimeoutMs: 5_000,
    });
    try {
      const shutdown = await dispatchShutdown;
      result.killedTasks = shutdown.requested;
      result.killedPids = activeJobs.map((job) => job.pid).filter((pid) => pid > 0);
      if (shutdown.timedOut.length > 0) {
        result.errors.push(
          `Timed out stopping dispatch resources for: ${shutdown.timedOut.join(", ")}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to stop dispatch resources: ${msg}`);
    }

    if (prepShutdown) {
      try {
        const shutdown = await prepShutdown;
        result.prepKilledTasks = shutdown.requested;
        result.prepTimedOutTasks = shutdown.timedOut;
        if (shutdown.requested.length > 0) result.prepStopped = true;
        if (shutdown.timedOut.length > 0) {
          result.errors.push(
            `Timed out stopping prep resources for: ${shutdown.timedOut.join(", ")}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to stop prep resources: ${msg}`);
      }
    }

    // Prune orphaned worktrees
    try {
      execSync("git worktree prune", {
        cwd: this.projectRoot,
        stdio: "ignore",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to prune worktrees: ${msg}`);
    }

    return result;
  }
}
