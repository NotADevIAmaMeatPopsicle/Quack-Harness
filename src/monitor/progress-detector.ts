// ─── Progress Detector ────────────────────────────────────────────
// Monitors active dispatches for progress and detects stuck agents.
// Consumes JSONL events (agent_turn, agent_tool_use, agent_complete)
// from the existing event stream and tracks per-task health.

import type { StuckDetectionConfig } from "../core/types.js";
import type { QuackEvent } from "./event-types.js";

// ─── Types ───────────────────────────────────────────────────────

export type AgentHealthStatus = "healthy" | "slow" | "warning" | "critical" | "stuck";

export interface AgentHealth {
  taskId: string;
  status: AgentHealthStatus;
  lastActivity: { type: string; detail: string; timestamp: string } | null;
  silentMs: number;
  turnCount: number;
  toolUseCount: number;
  cumulativeCostUsd: number;
  startedAt: string;
  inLlmResponse: boolean;
}

export interface StuckEvent {
  taskId: string;
  sessionId: string;
  level: "warning" | "critical" | "kill";
  silentMs: number;
  lastActivity: string;
  turnNumber: number;
  totalCostUsd: number;
}

interface TaskTracking {
  taskId: string;
  sessionId: string;
  startedAt: number;
  lastActivityTime: number;
  lastActivityType: string;
  lastActivityDetail: string;
  lastFileActivityTime: number;
  turnCount: number;
  toolUseCount: number;
  cumulativeCostUsd: number;
  inLlmResponse: boolean;
  warningEmitted: boolean;
  criticalEmitted: boolean;
}

const DEFAULT_CONFIG: StuckDetectionConfig = {
  enabled: true,
  warningMinutes: 5,
  criticalMinutes: 10,
  killMinutes: 15,
  checkIntervalSeconds: 30,
  fileHeartbeat: true,
};

export type StuckCallback = (event: StuckEvent) => void;

export class ProgressDetector {
  private config: StuckDetectionConfig;
  private tracking: Map<string, TaskTracking> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onStuck: StuckCallback | null = null;

  constructor(config?: Partial<StuckDetectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set callback for stuck detection events.
   */
  setStuckCallback(cb: StuckCallback): void {
    this.onStuck = cb;
  }

  /**
   * Start periodic stuck detection checks.
   */
  startChecking(): void {
    if (this.checkInterval) return;
    if (!this.config.enabled) return;

    this.checkInterval = setInterval(() => {
      this.checkAllTasks();
    }, this.config.checkIntervalSeconds * 1000).unref();
  }

  /**
   * Stop periodic stuck detection checks.
   */
  stopChecking(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Process a JSONL event and update tracking state.
   * Call this for every event from the watcher.
   */
  processEvent(event: QuackEvent): void {
    const { taskId, sessionId, stage } = event;
    if (!taskId) return;

    switch (stage) {
      case "session_start":
        this.startTracking(taskId, sessionId);
        break;

      case "agent_turn":
        this.recordActivity(taskId, sessionId, "turn", this.extractTurnDetail(event));
        break;

      // TASK-833: blueprint generation is a silent multi-minute LLM call.
      // Without these activity records, getHealth() reports the gate
      // checkpoint as the last activity and operators cannot tell the
      // difference between "blueprint working" and "dispatch hung."
      case "blueprint_start":
        this.recordActivity(taskId, sessionId, "blueprint_stage", "Blueprint: start");
        break;
      case "blueprint_warning":
        this.recordActivity(taskId, sessionId, "blueprint_stage", "Blueprint: slow (warning)");
        break;
      case "blueprint_fallback":
        this.recordActivity(taskId, sessionId, "blueprint_stage", "Blueprint: fallback (minimal)");
        break;

      case "agent_tool_use":
        this.recordToolUse(taskId, sessionId, event);
        break;

      case "agent_complete":
        this.recordComplete(taskId, event);
        break;

      case "session_complete":
      case "session_error":
        this.removeTracking(taskId);
        break;
    }
  }

  /**
   * Get health status for a specific task.
   */
  getHealth(taskId: string): AgentHealth | null {
    const t = this.tracking.get(taskId);
    if (!t) return null;

    // Either signal resets the silence timer — use the most recent activity
    const lastAny = Math.max(t.lastActivityTime, t.lastFileActivityTime);
    const silentMs = Date.now() - lastAny;

    return {
      taskId: t.taskId,
      status: this.computeStatus(silentMs, t.inLlmResponse),
      lastActivity: {
        type: t.lastActivityType,
        detail: t.lastActivityDetail,
        timestamp: new Date(t.lastActivityTime).toISOString(),
      },
      silentMs,
      turnCount: t.turnCount,
      toolUseCount: t.toolUseCount,
      cumulativeCostUsd: t.cumulativeCostUsd,
      startedAt: new Date(t.startedAt).toISOString(),
      inLlmResponse: t.inLlmResponse,
    };
  }

  /**
   * Get health status for all tracked tasks.
   */
  getAllHealth(): AgentHealth[] {
    const results: AgentHealth[] = [];
    for (const taskId of this.tracking.keys()) {
      const health = this.getHealth(taskId);
      if (health) results.push(health);
    }
    return results;
  }

  /**
   * Check if a task should be killed due to stuck detection.
   */
  shouldKill(taskId: string): { kill: boolean; reason: string } {
    if (!this.config.enabled) {
      return { kill: false, reason: "Stuck detection disabled" };
    }

    const t = this.tracking.get(taskId);
    if (!t) {
      return { kill: false, reason: "Task not being tracked" };
    }

    const lastAny = Math.max(t.lastActivityTime, t.lastFileActivityTime);
    const silentMs = Date.now() - lastAny;
    const effectiveKillMs = this.getEffectiveThreshold(
      this.config.killMinutes * 60000,
      t.inLlmResponse,
    );

    if (silentMs >= effectiveKillMs) {
      return {
        kill: true,
        reason: `No activity for ${Math.round(silentMs / 60000)} minutes (threshold: ${this.config.killMinutes} min${t.inLlmResponse ? ", extended for LLM response" : ""})`,
      };
    }

    return { kill: false, reason: "Within threshold" };
  }

  /**
   * Get the current config.
   */
  getConfig(): StuckDetectionConfig {
    return { ...this.config };
  }

  /**
   * Record a file modification from the FileHeartbeat.
   * This acts as a secondary signal — if either JSONL events or file
   * modifications are recent, the agent is considered active.
   */
  recordFileActivity(taskId: string): void {
    const t = this.tracking.get(taskId);
    if (!t) return;
    t.lastFileActivityTime = Date.now();
    // File activity resets stuck warning flags (same as event activity)
    t.warningEmitted = false;
    t.criticalEmitted = false;
  }

  /**
   * Remove a task from tracking (e.g., on normal completion).
   */
  removeTracking(taskId: string): void {
    this.tracking.delete(taskId);
  }

  /**
   * Get count of actively tracked tasks.
   */
  getTrackedCount(): number {
    return this.tracking.size;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private startTracking(taskId: string, sessionId: string): void {
    const now = Date.now();
    this.tracking.set(taskId, {
      taskId,
      sessionId,
      startedAt: now,
      lastActivityTime: now,
      lastActivityType: "session_start",
      lastActivityDetail: "Session started",
      lastFileActivityTime: 0,
      turnCount: 0,
      toolUseCount: 0,
      cumulativeCostUsd: 0,
      inLlmResponse: false,
      warningEmitted: false,
      criticalEmitted: false,
    });
  }

  private recordActivity(taskId: string, sessionId: string, type: string, detail: string): void {
    let t = this.tracking.get(taskId);
    if (!t) {
      // Auto-start tracking if we see an event without a session_start
      this.startTracking(taskId, sessionId);
      t = this.tracking.get(taskId)!;
    }

    t.lastActivityTime = Date.now();
    t.lastActivityType = type;
    t.lastActivityDetail = detail;
    t.warningEmitted = false;
    t.criticalEmitted = false;

    if (type === "turn") {
      t.turnCount++;
      // A turn event means the agent completed a response. After tool execution
      // finishes, the SDK sends results back and the LLM starts thinking again.
      // Mark inLlmResponse=true so stuck detection extends the timeout (2x)
      // while the LLM is generating its next response.
      t.inLlmResponse = true;
    }
  }

  private recordToolUse(taskId: string, sessionId: string, event: QuackEvent): void {
    const payload = event.payload as { toolName?: string; filePath?: string; turnNumber?: number };
    const toolName = payload.toolName ?? "unknown";
    const filePath = payload.filePath;
    const detail = filePath ? `${toolName}: ${filePath}` : toolName;

    let t = this.tracking.get(taskId);
    if (!t) {
      this.startTracking(taskId, sessionId);
      t = this.tracking.get(taskId)!;
    }

    t.lastActivityTime = Date.now();
    t.lastActivityType = "tool_use";
    t.lastActivityDetail = detail;
    t.toolUseCount++;
    t.warningEmitted = false;
    t.criticalEmitted = false;
    // Agent is actively using tools — not stuck in LLM response
    t.inLlmResponse = false;
  }

  private recordComplete(taskId: string, event: QuackEvent): void {
    const payload = event.payload as { totalCostUsd?: number; turnsUsed?: number };
    const t = this.tracking.get(taskId);
    if (t) {
      t.cumulativeCostUsd = payload.totalCostUsd ?? t.cumulativeCostUsd;
      t.turnCount = payload.turnsUsed ?? t.turnCount;
    }
    // Don't remove yet — session_complete will clean up
  }

  private extractTurnDetail(event: QuackEvent): string {
    const payload = event.payload as { turnNumber?: number; contentPreview?: string };
    const turn = payload.turnNumber ?? 0;
    const preview = payload.contentPreview ?? "";
    return `Turn ${turn}${preview ? `: ${preview.slice(0, 50)}` : ""}`;
  }

  private computeStatus(silentMs: number, inLlmResponse: boolean): AgentHealthStatus {
    if (!this.config.enabled) return "healthy";

    const warningMs = this.getEffectiveThreshold(this.config.warningMinutes * 60000, inLlmResponse);
    const criticalMs = this.getEffectiveThreshold(
      this.config.criticalMinutes * 60000,
      inLlmResponse,
    );
    const killMs = this.getEffectiveThreshold(this.config.killMinutes * 60000, inLlmResponse);

    if (silentMs >= killMs) return "stuck";
    if (silentMs >= criticalMs) return "critical";
    if (silentMs >= warningMs) return "warning";
    if (silentMs >= warningMs * 0.6) return "slow";
    return "healthy";
  }

  /**
   * If agent is in a long LLM response (turn_start without tool_use/turn_end),
   * extend timeout by 2x since complex reasoning takes time.
   */
  private getEffectiveThreshold(baseMs: number, inLlmResponse: boolean): number {
    return inLlmResponse ? baseMs * 2 : baseMs;
  }

  /**
   * Periodic check: emit stuck events for any tasks exceeding thresholds.
   */
  private checkAllTasks(): void {
    if (!this.config.enabled || !this.onStuck) return;

    for (const t of this.tracking.values()) {
      const lastAny = Math.max(t.lastActivityTime, t.lastFileActivityTime);
      const silentMs = Date.now() - lastAny;

      const warningMs = this.getEffectiveThreshold(
        this.config.warningMinutes * 60000,
        t.inLlmResponse,
      );
      const criticalMs = this.getEffectiveThreshold(
        this.config.criticalMinutes * 60000,
        t.inLlmResponse,
      );
      const killMs = this.getEffectiveThreshold(this.config.killMinutes * 60000, t.inLlmResponse);

      if (silentMs >= killMs) {
        this.onStuck({
          taskId: t.taskId,
          sessionId: t.sessionId,
          level: "kill",
          silentMs,
          lastActivity: t.lastActivityDetail,
          turnNumber: t.turnCount,
          totalCostUsd: t.cumulativeCostUsd,
        });
      } else if (silentMs >= criticalMs && !t.criticalEmitted) {
        t.criticalEmitted = true;
        this.onStuck({
          taskId: t.taskId,
          sessionId: t.sessionId,
          level: "critical",
          silentMs,
          lastActivity: t.lastActivityDetail,
          turnNumber: t.turnCount,
          totalCostUsd: t.cumulativeCostUsd,
        });
      } else if (silentMs >= warningMs && !t.warningEmitted) {
        t.warningEmitted = true;
        this.onStuck({
          taskId: t.taskId,
          sessionId: t.sessionId,
          level: "warning",
          silentMs,
          lastActivity: t.lastActivityDetail,
          turnNumber: t.turnCount,
          totalCostUsd: t.cumulativeCostUsd,
        });
      }
    }
  }
}
