// ─── Checkpoint Manager ──────────────────────────────────────────
// Saves and loads stage-level dispatch checkpoints so failed dispatches
// can resume from where they left off instead of starting over.
//
// Checkpoints are stored as JSON files in .quack/logs/checkpoint-TASK-NNN.json

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DispatchCheckpoint, PipelineStage } from "./checkpoint-types.js";

export class CheckpointManager {
  private readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  /** Build the file path for a task's checkpoint */
  private checkpointPath(taskId: string): string {
    return path.join(this.logDir, `checkpoint-${taskId}.json`);
  }

  /**
   * Save a checkpoint for a dispatch pipeline.
   * Overwrites any existing checkpoint for the same task.
   */
  async save(checkpoint: DispatchCheckpoint): Promise<void> {
    const filePath = this.checkpointPath(checkpoint.taskId);
    await fs.mkdir(this.logDir, { recursive: true });
    const data = JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2);
    await fs.writeFile(filePath, data, "utf-8");
  }

  /**
   * Load a checkpoint for a task, if one exists.
   * Returns null if no checkpoint is found.
   */
  async load(taskId: string): Promise<DispatchCheckpoint | null> {
    const filePath = this.checkpointPath(taskId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as DispatchCheckpoint;
    } catch {
      return null;
    }
  }

  /**
   * Delete a checkpoint (e.g., after successful dispatch completion).
   */
  async delete(taskId: string): Promise<boolean> {
    const filePath = this.checkpointPath(taskId);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all checkpoints in the log directory.
   */
  async list(): Promise<DispatchCheckpoint[]> {
    try {
      const entries = await fs.readdir(this.logDir);
      const checkpoints: DispatchCheckpoint[] = [];

      for (const entry of entries) {
        if (entry.startsWith("checkpoint-") && entry.endsWith(".json")) {
          try {
            const data = await fs.readFile(path.join(this.logDir, entry), "utf-8");
            checkpoints.push(JSON.parse(data) as DispatchCheckpoint);
          } catch {
            // Skip corrupted checkpoint files
          }
        }
      }

      return checkpoints;
    } catch {
      return [];
    }
  }

  /**
   * Update a specific stage as completed in the checkpoint.
   * Creates a new checkpoint if one doesn't exist.
   */
  async markStageComplete(
    taskId: string,
    stage: PipelineStage,
    updates: Partial<DispatchCheckpoint>,
  ): Promise<DispatchCheckpoint> {
    let checkpoint = await this.load(taskId);
    if (!checkpoint) {
      checkpoint = {
        taskId,
        sessionId: updates.sessionId ?? "",
        completedStages: [],
        totalCostUsd: 0,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: updates.startedAt ?? new Date().toISOString(),
      };
    }

    if (!checkpoint.completedStages.includes(stage)) {
      checkpoint.completedStages.push(stage);
    }

    // Merge updates
    Object.assign(checkpoint, updates);

    await this.save(checkpoint);
    return checkpoint;
  }

  /**
   * Rewind a checkpoint to a stage so the stage and everything after it reruns.
   * Loop revision currently supports rewinding from the worker (`agent`) stage.
   */
  async rewindFrom(
    taskId: string,
    stage: "agent" | "judge_review",
  ): Promise<DispatchCheckpoint | null> {
    const checkpoint = await this.load(taskId);
    if (!checkpoint) {
      return null;
    }

    const stageOrder: PipelineStage[] = [
      "gate",
      "blueprint",
      "approve",
      "branch",
      "context",
      "agent",
      "commit",
      "judge_review",
      "judge",
      "pr",
    ];
    const rewindIndex = stageOrder.indexOf(stage);
    checkpoint.completedStages = checkpoint.completedStages.filter(
      (completed) => stageOrder.indexOf(completed) < rewindIndex,
    );

    if (stage === "agent") {
      delete checkpoint.agentResult;
      delete checkpoint.gitDiff;
      delete checkpoint.outputSnapshots;
      checkpoint.retriesUsed = 0;
      checkpoint.totalCostUsd = 0;
    }
    delete checkpoint.judgeResult;

    await this.save(checkpoint);
    return checkpoint;
  }

  /**
   * Determine which stage to resume from based on completed stages.
   * Returns the first stage not in the completed set.
   */
  getResumeStage(checkpoint: DispatchCheckpoint): PipelineStage {
    const stageOrder: PipelineStage[] = [
      "gate",
      "blueprint",
      "approve",
      "branch",
      "context",
      "agent",
      "commit",
      "judge_review",
      "judge",
      "pr",
    ];

    for (const stage of stageOrder) {
      if (!checkpoint.completedStages.includes(stage)) {
        return stage;
      }
    }

    return "pr"; // All stages complete
  }

  /**
   * Evaluate whether a checkpoint is usable for resume/retry.
   * Returns false if:
   * - Judge flagged work as fundamentally unusable (REJECT)
   * - Retries exhausted with no viable work (retriesUsed >= maxRetries and no gitDiff)
   * - Checkpoint is stale (older than 7 days)
   * - Missing required fields (corrupted)
   *
   * @param checkpoint The checkpoint to evaluate
   * @param maxRetries Max retries from adapter config (optional — when provided, enables retry exhaustion detection)
   */
  isUsable(checkpoint: DispatchCheckpoint, maxRetries?: number): boolean {
    // Check for corrupted data
    if (!checkpoint.taskId || !checkpoint.sessionId || !checkpoint.completedStages) {
      return false;
    }

    // Check for stale checkpoint (older than 7 days)
    const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(checkpoint.updatedAt).getTime();
    if (age > STALE_THRESHOLD_MS) {
      return false;
    }

    // Check judge verdict for unusable flag (not just REVISE, but flagged as wrong approach)
    if (checkpoint.judgeResult?.verdict === "REJECT") {
      return false;
    }

    // Check if retries are exhausted with no viable work
    // When maxRetries is available, use it for proper exhaustion detection
    if (maxRetries !== undefined && checkpoint.retriesUsed >= maxRetries) {
      // Retries exhausted — only usable if there's actual work (gitDiff) to build on
      if (!checkpoint.gitDiff || checkpoint.gitDiff.trim().length === 0) {
        return false;
      }
    }

    // Fallback: no maxRetries provided, check for REVISE with no progress
    if (checkpoint.judgeResult?.verdict === "REVISE" && !checkpoint.gitDiff) {
      return false;
    }

    return true;
  }
}
