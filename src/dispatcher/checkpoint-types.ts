// ─── Checkpoint Types ──────────────────────────────────────────────
// Types for stage-level dispatch checkpointing. Allows the dispatcher
// to resume from the last completed stage instead of starting over.

import type { AgentOutputSnapshot, AgentResult, GateResult, JudgeResult } from "../core/types.js";
import type { ModelProvenance } from "../review/reviewer-types.js";

/** Pipeline stages in dispatch order */
export type PipelineStage =
  | "gate"
  | "blueprint"
  | "approve"
  | "branch"
  | "context"
  | "agent"
  | "commit"
  | "judge_review"
  | "judge"
  | "pr";

/** Persisted checkpoint for a dispatch pipeline */
export interface DispatchCheckpoint {
  /** Task ID (e.g., "TASK-039") */
  taskId: string;
  /** Quack session ID for the dispatch run */
  sessionId: string;
  /** Stages that completed successfully */
  completedStages: PipelineStage[];
  /** Claude Agent SDK session ID for the agent worker */
  claudeSessionId?: string;
  /** Agent result (if agent stage completed) */
  agentResult?: AgentResult;
  /**
   * Pipeline-stamped identity of the implementation producer. Optional for
   * legacy checkpoints; absence must fail closed when cross-model review is
   * required rather than being reconstructed from possibly changed config.
   */
  implementationProvenance?: ModelProvenance;
  /** Judge result (if judge stage completed) */
  judgeResult?: JudgeResult;
  /** Gate result (if gate stage completed) */
  gateResult?: GateResult;
  /** Branch name created for this dispatch */
  branchName?: string;
  /** Git diff at last checkpoint */
  gitDiff?: string;
  /** Durable output seals captured after worker/retry attempts */
  outputSnapshots?: AgentOutputSnapshot[];
  /** Total cost accumulated so far */
  totalCostUsd: number;
  /** Number of retries used so far */
  retriesUsed: number;
  /** Timestamp when checkpoint was last saved */
  updatedAt: string;
  /** Timestamp when dispatch started */
  startedAt: string;
  /** Parent task ID (for subtasks in a decomposition) */
  parentTaskId?: string;
  /** Feature branch name (for subtask chains: quack/{parentTaskId}) */
  featureBranch?: string;
}
