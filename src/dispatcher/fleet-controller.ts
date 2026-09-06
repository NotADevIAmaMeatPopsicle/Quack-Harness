// ─── Fleet Controller ──────────────────────────────────────────────
// Manages fleet-wide operational state for agent dispatches.
// Provides emergency stop, pause/resume controls, and state queries.

import type { DispatchManager } from "../monitor/dispatch-manager.js";
import type { PrepScheduler } from "../monitor/prep-scheduler.js";
import { execSync } from "node:child_process";

export type FleetState = "running" | "paused" | "emergency_stopped";

export interface EmergencyStopResult {
  killedTasks: string[];
  killedPids: number[];
  prepStopped: boolean;
  errors: string[];
}

export interface FleetStatus {
  state: FleetState;
  activeJobs: number;
  reason?: string;
}

const SIGKILL_TIMEOUT_MS = 5000;

export class FleetController {
  private state: FleetState = "running";
  private reason?: string;

  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly prepScheduler: PrepScheduler | null,
    private readonly projectRoot: string,
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
  resume(): void {
    this.state = "running";
    this.reason = undefined;
  }

  /**
   * Emergency stop — kill all active agents and stop auto-prep.
   * This is the nuclear option: SIGTERM all processes, then SIGKILL
   * after timeout if they don't exit gracefully.
   */
  async emergencyStop(reason = "Emergency stop"): Promise<EmergencyStopResult> {
    this.state = "emergency_stopped";
    this.reason = reason;

    const result: EmergencyStopResult = {
      killedTasks: [],
      killedPids: [],
      prepStopped: false,
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

    // Get all active jobs before killing
    const activeJobs = this.dispatchManager.getActiveJobs();
    if (activeJobs.length === 0) {
      return result;
    }

    // Track PIDs for SIGKILL timeout
    const pidsToKill = new Map<number, string>(); // pid → taskId

    // Send SIGTERM to all active dispatches
    for (const job of activeJobs) {
      try {
        const stopped = this.dispatchManager.stop(job.taskId);
        if (stopped) {
          result.killedTasks.push(job.taskId);
          result.killedPids.push(job.pid);
          pidsToKill.set(job.pid, job.taskId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to stop ${job.taskId}: ${msg}`);
      }
    }

    // Wait for processes to exit or timeout after 5s
    if (pidsToKill.size > 0) {
      await this.waitForProcessesOrKill(pidsToKill, result);
    }

    // Clean up all Docker containers (catches any not tracked in active jobs)
    try {
      await this.dispatchManager.cleanupAllContainers();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to clean up containers: ${msg}`);
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

  /**
   * Wait for processes to exit gracefully, or send SIGKILL after timeout.
   */
  private async waitForProcessesOrKill(
    pidsToKill: Map<number, string>,
    result: EmergencyStopResult,
  ): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;

        // Check which processes are still running
        for (const [pid] of Array.from(pidsToKill.entries())) {
          if (!this.isProcessRunning(pid)) {
            pidsToKill.delete(pid);
          }
        }

        // All processes exited
        if (pidsToKill.size === 0) {
          clearInterval(checkInterval);
          resolve();
          return;
        }

        // Timeout — send SIGKILL
        if (elapsed >= SIGKILL_TIMEOUT_MS) {
          clearInterval(checkInterval);
          for (const [pid, taskId] of pidsToKill) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              result.errors.push(`Failed to SIGKILL ${taskId} (pid ${pid}): ${msg}`);
            }
          }
          resolve();
        }
      }, 100).unref(); // Check every 100ms
    });
  }

  /**
   * Check if a process is still running by PID.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if the process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
