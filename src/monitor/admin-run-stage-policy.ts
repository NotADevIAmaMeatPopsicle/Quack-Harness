export type AdminRunStage =
  | "starting"
  | "inventory"
  | "prep"
  | "gate"
  | "spec_review"
  | "blueprint"
  | "analysis"
  | "enrich"
  | "decompose"
  | "dispatch"
  | "verify"
  | "waiting"
  | "summarizing"
  | "halted"
  | "stopped"
  | "completed"
  | "failed";

export type AdminRunStageProgressStatus = "running" | "completed" | "failed";

export interface AdminRunStageProgress {
  stage: AdminRunStage;
  status: AdminRunStageProgressStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  lastOutputAt?: string;
  staleAfterMs: number;
  recommendedAction: string;
  taskId?: string;
  detail?: string;
  error?: string;
}

export interface AdminRunStagePolicy {
  outputStaleAfterMs: number;
  recommendedAction: string;
}

export const ADMIN_RUN_STAGE_POLICIES: Record<AdminRunStage, AdminRunStagePolicy> = {
  starting: {
    outputStaleAfterMs: 60_000,
    recommendedAction: "Wait for inventory load or checkpoint activity before intervening.",
  },
  inventory: {
    outputStaleAfterMs: 60_000,
    recommendedAction:
      "Check task parsing and branch inventory collection if this stage stops advancing.",
  },
  prep: {
    outputStaleAfterMs: 10 * 60_000,
    recommendedAction:
      "Review prep evidence, depth scoring, and enrichment output before stopping the run.",
  },
  gate: {
    outputStaleAfterMs: 10 * 60_000,
    recommendedAction:
      "Check readiness gate depth/schema evaluation and runtime health before retrying prep.",
  },
  spec_review: {
    outputStaleAfterMs: 10 * 60_000,
    recommendedAction:
      "Review spec-ambiguity analysis output and runtime availability if this stage stalls.",
  },
  blueprint: {
    outputStaleAfterMs: 20 * 60_000,
    recommendedAction:
      "Inspect blueprint generation runtime and recent checkpoint heartbeats before stopping the run.",
  },
  analysis: {
    outputStaleAfterMs: 10 * 60_000,
    recommendedAction:
      "Check context assembly and analysis inputs if this stage remains quiet too long.",
  },
  enrich: {
    outputStaleAfterMs: 20 * 60_000,
    recommendedAction:
      "Review enrichment output and adapter availability before retrying the task.",
  },
  decompose: {
    outputStaleAfterMs: 20 * 60_000,
    recommendedAction: "Inspect decomposition output and subtask writeback before intervening.",
  },
  dispatch: {
    outputStaleAfterMs: 30 * 60_000,
    recommendedAction:
      "Check dispatch queue health, worker availability, and session startup before stopping the run.",
  },
  verify: {
    outputStaleAfterMs: 15 * 60_000,
    recommendedAction:
      "Review verification command progress and evidence before retrying or fixing the task.",
  },
  waiting: {
    outputStaleAfterMs: 5 * 60_000,
    recommendedAction: "Keep polling until a lane opens or dependencies clear.",
  },
  summarizing: {
    outputStaleAfterMs: 2 * 60_000,
    recommendedAction:
      "Wait for the final summary write unless the process has exited unexpectedly.",
  },
  halted: {
    outputStaleAfterMs: 0,
    recommendedAction:
      "Review the halt reason and clear the blocker before starting another admin run.",
  },
  stopped: {
    outputStaleAfterMs: 0,
    recommendedAction: "Review the stopped run before resuming or creating a replacement run.",
  },
  completed: {
    outputStaleAfterMs: 0,
    recommendedAction:
      "Review the final summary, checkpoint, and queued outcomes before starting the next run.",
  },
  failed: {
    outputStaleAfterMs: 0,
    recommendedAction:
      "Inspect the latest checkpoint error and stdout/stderr tail before retrying.",
  },
};

export function isAdminRunStage(value: string): value is AdminRunStage {
  return value in ADMIN_RUN_STAGE_POLICIES;
}

export function getAdminRunStagePolicy(stage: AdminRunStage): AdminRunStagePolicy {
  return ADMIN_RUN_STAGE_POLICIES[stage];
}
