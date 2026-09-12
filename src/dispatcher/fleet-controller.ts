// ─── Fleet Controller ──────────────────────────────────────────────
// Manages fleet-wide operational state for agent dispatches.
// Provides emergency stop, pause/resume controls, and state queries.

import type {
  DispatchManager,
  SharedCheckoutShutdownSurvivor,
  WorktreeShutdownSurvivor,
} from "../monitor/dispatch-manager.js";
import type { PrepScheduler } from "../monitor/prep-scheduler.js";
import type { PrepShutdownSurvivor, PrepWorker } from "../monitor/prep-worker.js";
import { runTrustedGitSync } from "./trusted-git.js";

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
  private transitionRevision = 0;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly prepScheduler: PrepScheduler | null,
    private readonly projectRoot: string,
    private readonly prepWorker: PrepWorker | null = null,
  ) {}

  private serializeTransition<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.transitionTail.then(operation, operation);
    this.transitionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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
    if (this.state === "emergency_stopped") {
      throw new Error(
        "Fleet is emergency stopped; complete shutdown recovery with resume before pausing",
      );
    }
    this.transitionRevision += 1;
    this.state = "paused";
    this.reason = reason;
  }

  /**
   * Resume the fleet from paused or emergency_stopped state.
   */
  async resume(): Promise<void> {
    const revision = ++this.transitionRevision;
    return this.serializeTransition(async () => {
      if (revision !== this.transitionRevision) {
        throw new Error("Fleet resume was superseded by a newer control transition");
      }
      const resumingEmergencyStop = this.state === "emergency_stopped";
      if (resumingEmergencyStop) {
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
        if (revision !== this.transitionRevision) {
          this.prepScheduler?.stop();
          throw new Error("Fleet resume was superseded by an emergency stop");
        }
        this.restartPrepSchedulerAfterEmergencyStop = false;
      }
      if (revision !== this.transitionRevision) {
        throw new Error("Fleet resume was superseded by a newer control transition");
      }
      this.state = "running";
      this.reason = undefined;
    });
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
    ownershipId: string,
    reconciliationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    return this.dispatchManager.reconcileSharedCheckoutShutdownSurvivor(
      taskId,
      sessionId,
      ownershipId,
      reconciliationToken,
      processTreeConfirmedStopped,
    );
  }

  getWorktreeShutdownSurvivors(): WorktreeShutdownSurvivor[] {
    return this.dispatchManager.getWorktreeShutdownSurvivors();
  }

  reconcileWorktreeShutdownSurvivor(
    taskId: string,
    sessionId: string,
    ownershipId: string,
    reconciliationToken: string,
    processTreeConfirmedStopped: boolean,
  ): boolean {
    return this.dispatchManager.reconcileWorktreeShutdownSurvivor(
      taskId,
      sessionId,
      ownershipId,
      reconciliationToken,
      processTreeConfirmedStopped,
    );
  }

  /**
   * Emergency stop — stop all active agents and auto-prep through the managers'
   * durable ownership and recovery barriers.
   */
  async emergencyStop(reason = "Emergency stop"): Promise<EmergencyStopResult> {
    const revision = ++this.transitionRevision;
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

    // Stop auto-prep immediately, even when this transition must wait behind
    // an in-flight resume. The revision prevents that resume from publishing a
    // running state after this emergency request.
    if (this.prepScheduler?.isRunning()) {
      try {
        this.prepScheduler.stop();
        result.prepStopped = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to stop prep scheduler: ${msg}`);
      }
    }

    return this.serializeTransition(async () => {
      // Start both shutdowns before awaiting either so one agent class cannot
      // continue through the other's grace period.
      const prepShutdown = this.prepWorker?.shutdownAll({
        gracefulTimeoutMs: 5_000,
        forceTimeoutMs: 5_000,
      });
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

      try {
        runTrustedGitSync(["worktree", "prune"], this.projectRoot, {
          timeoutMs: 30_000,
          maxBuffer: 1024 * 1024,
          errorContext: "Failed to prune worktrees",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to prune worktrees: ${msg}`);
      }

      if (revision !== this.transitionRevision && this.state !== "emergency_stopped") {
        result.errors.push("Emergency stop was followed by a newer fleet control transition");
      }
      return result;
    });
  }
}
