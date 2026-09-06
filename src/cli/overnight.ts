import * as path from "node:path";

import { parseTaskIdList, runOvernightRunner } from "../overnight/runner.js";
import type { OvernightRunnerOptions } from "../overnight/types.js";

export interface OvernightCommandOptions {
  project?: string;
  monitorUrl?: string;
  taskIds?: string;
  sourceBranch?: string;
  targetBranch?: string;
  checkpoint?: string;
  minScore?: string;
  maxPrepAttempts?: string;
  maxEnrichmentAttempts?: string;
  maxDispatchAttempts?: string;
  maxDispatches?: string;
  activeDispatchLimit?: string;
  pollIntervalMs?: string;
  autoEnrich?: boolean;
  autoDecompose?: boolean;
  maxSubtasks?: string;
  noVerifyAfterDispatch?: boolean;
  fullGate?: boolean;
  allowParseErrors?: boolean;
  maxInfraFailures?: string;
  maxBudgetUsd?: string;
  dryRun?: boolean;
  once?: boolean;
  maxCycles?: string;
  model?: string;
  maxTurns?: string;
  maxBudget?: string;
  federationDispatch?: boolean;
  preferredHostId?: string;
  allowLowPreflightOnFederationDispatch?: boolean;
  autoAcknowledgeDecomposeReview?: boolean;
}

export async function overnightCommand(options: OvernightCommandOptions): Promise<void> {
  try {
    const projectRoot = path.resolve(options.project ?? process.cwd());
    const runnerOptions: OvernightRunnerOptions = {
      projectRoot,
      monitorUrl: options.monitorUrl,
      taskIds: parseTaskIdList(options.taskIds),
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      checkpointPath: options.checkpoint ? path.resolve(options.checkpoint) : undefined,
      minDepthScore: parseOptionalFloat(options.minScore),
      maxPrepAttempts: parseOptionalInt(options.maxPrepAttempts),
      maxEnrichmentAttempts: parseOptionalInt(options.maxEnrichmentAttempts),
      maxDispatchAttempts: parseOptionalInt(options.maxDispatchAttempts),
      maxDispatches: parseOptionalInt(options.maxDispatches),
      activeDispatchLimit: parseOptionalInt(options.activeDispatchLimit),
      pollIntervalMs: parseOptionalInt(options.pollIntervalMs),
      verifyAfterDispatch: options.noVerifyAfterDispatch ? false : undefined,
      autoEnrich: options.autoEnrich,
      autoDecompose: options.autoDecompose,
      maxSubtasks: parseOptionalInt(options.maxSubtasks),
      skipGateOnDispatch: options.fullGate ? false : undefined,
      haltOnParseErrors: options.allowParseErrors ? false : undefined,
      maxInfraFailures: parseOptionalInt(options.maxInfraFailures),
      maxBudgetUsd: parseOptionalFloat(options.maxBudgetUsd),
      dryRun: options.dryRun,
      once: options.once,
      maxCycles: parseOptionalInt(options.maxCycles),
      model: options.model,
      maxTurns: parseOptionalInt(options.maxTurns),
      maxBudget: parseOptionalFloat(options.maxBudget),
      federationDispatch: options.federationDispatch,
      preferredHostId: options.preferredHostId,
      allowLowPreflightOnFederationDispatch: options.allowLowPreflightOnFederationDispatch,
      autoAcknowledgeDecomposeReview: options.autoAcknowledgeDecomposeReview,
    };

    const checkpoint = await runOvernightRunner(runnerOptions);
    printSummary(checkpoint);
    process.exit(checkpoint.halted ? 1 : 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer, got ${value}`);
  }
  return parsed;
}

function parseOptionalFloat(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected number, got ${value}`);
  }
  return parsed;
}

function printSummary(checkpoint: Awaited<ReturnType<typeof runOvernightRunner>>): void {
  const counts = new Map<string, number>();
  for (const task of checkpoint.tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }

  console.log("\nOvernight Runner Summary");
  console.log("=".repeat(40));
  console.log(`Run: ${checkpoint.runId}`);
  console.log(`Project: ${checkpoint.settings.projectId}`);
  console.log(`Dispatches started: ${checkpoint.dispatchesStarted}`);
  console.log(`Total cost observed: $${checkpoint.totalCostUsd.toFixed(2)}`);
  if (checkpoint.halted) {
    console.log(`Halted: ${checkpoint.haltReason ?? "unknown"}`);
  }

  console.log("\nTask states:");
  for (const [status, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${status}: ${count}`);
  }

  const attention = checkpoint.tasks.filter(
    (task) =>
      task.status === "failed" ||
      task.status === "manual_review" ||
      task.status === "blocked" ||
      task.status === "needs_decomposition",
  );
  if (attention.length > 0) {
    console.log("\nNeeds attention:");
    for (const task of attention.slice(0, 20)) {
      const reason = task.lastError ? ` - ${task.lastError.split("\n")[0]}` : "";
      console.log(`  ${task.taskId} [${task.status}]${reason}`);
    }
  }
}
