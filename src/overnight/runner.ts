import { isCompleteStatus } from "../core/task-status.js";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  loadTaskStateOverlay,
  resolveTaskStateWithOverlay,
  type RuntimeStatusOverlay,
  type TaskStateOverlaySource,
} from "../core/task-state-overlay.js";
import { isTerminalTaskStatus } from "../monitor/task-projection.js";
import type { QuackEvent } from "../monitor/event-types.js";
import { loadAdapter } from "../core/adapter-loader.js";
import {
  applyResolvedStatusHygiene,
  buildStructuralBacklogHygieneReport,
  isTaskSuppressedFromAutomation,
} from "../core/task-hygiene.js";
import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import { resolveTaskFile } from "../core/task-file-resolver.js";
import { validateTaskSchema } from "../gate/schema-validator.js";
import { evaluateTaskDepth } from "../gate/depth-evaluator.js";
import { runPreflight, type PreflightStageReporter } from "../preflight/preflight-runner.js";
import { PrepCache } from "../monitor/prep-cache.js";
import { computeContentHash } from "../monitor/prep-cache.js";
import { ReadinessService } from "../monitor/readiness-service.js";
import { generateProjectId } from "../monitor/project-registry.js";
import {
  getAdminRunStagePolicy,
  type AdminRunStage,
  type AdminRunStageProgress,
} from "../monitor/admin-run-stage-policy.js";
import type { ParsedTask, TaskBacklogHygiene } from "../core/types.js";
import type {
  OvernightDispatchJob,
  OvernightEvent,
  OvernightFailureClass,
  OvernightInventoryItem,
  OvernightPrepResult,
  OvernightRunCheckpoint,
  OvernightRunnerOptions,
  OvernightRunSettings,
  OvernightSessionEntry,
  OvernightTaskRecord,
  OvernightVerificationResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const TASK_ID_RE = /\bTASK-\d+(?:-[A-Z])?\b/;
const RUNNER_SCHEMA_VERSION = 1;

// ─── TASK-1318 S2: doneness, per site, over resolved status ─────────
//
// `TERMINAL_TASK_STATUSES` used to live here. It was a set of
// {COMPLETE, VERIFIED} that both decisions below shared, and the name
// lied about its contents: nothing in it was terminal-but-rejected. A
// single shared notion is the actual defect, because this file asks two
// DIFFERENT questions and they must disagree on exactly one status:
//
//   - `initialStatusForInventory` asks "is this task finished as WORK",
//     so REJECTED counts and the answer is `isTerminalTaskStatus`.
//     Without it, explicitly naming a REJECTED task on the command line
//     queues it for prep and redispatch.
//   - `areParsedDependenciesSatisfied` asks "does this DEPENDENCY
//     satisfy its dependent", where REJECTED must never count, so the
//     answer is `isCompleteStatus`.
//
// This reverses the deviation an earlier TASK-1318 round recorded here.
// That round argued isTerminalTaskStatus would "NEWLY treat REJECTED
// work as finished"; round 2 established the premise was backwards. Not
// skipping it is the defect, not the safeguard.
//
// The predicate is only half of it. Both sites feed the predicate the
// RESOLVED status (runtime row over spec line) rather than the raw spec
// `Status:` value, because changing the predicate while still reading
// the spec is a rename, not a retirement.

/**
 * Resolved status for one parsed task: the DB `task_status` row when the
 * overlay holds one, the spec `Status:` line otherwise.
 *
 * `ResolvedTaskState.status` is raw and byte-identical to what these
 * predicates received before, so routing changes only the INPUT. Alias
 * acceptance via `typedStatus` would be a second, separate behavior
 * change and is deliberately not taken here.
 */
function resolvedTaskStatus(task: ParsedTask, overlay: RuntimeStatusOverlay): string {
  return resolveTaskStateWithOverlay({
    taskId: task.id,
    specStatus: task.status,
    overlay,
  }).status;
}

/**
 * One inventory pass: the items plus the single runtime overlay read
 * that every doneness answer in the pass is resolved against.
 *
 * The overlay travels WITH the items because the two consumers sit in
 * different functions (`buildInventory` judges dependencies,
 * `mergeInventory` judges the task itself) and loading it twice, or
 * once per task, would reintroduce the per-task query this batch read
 * exists to avoid.
 */
interface OvernightInventoryPass {
  items: OvernightInventoryItem[];
  overlay: RuntimeStatusOverlay;
  /**
   * True ONLY when a database exists and could not be read. An absent
   * database is the normal rowless case and is not degraded. When this
   * is true every status below silently fell back to spec authority, so
   * it is surfaced rather than swallowed.
   */
  overlayDegraded: boolean;
  overlaySource: TaskStateOverlaySource;
  overlayError?: string;
}

type RunnerAction =
  | { type: "prep"; task: OvernightTaskRecord }
  | { type: "dispatch"; task: OvernightTaskRecord }
  | { type: "wait"; reason: string }
  | { type: "done"; reason: string }
  | { type: "halt"; reason: string };

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface TaskParseInventory {
  tasksById: Map<string, ParsedTask>;
  taskFilesById: Map<string, string>;
  parseErrors: Array<{ file: string; error: string }>;
  hygieneByTaskId: Map<string, TaskBacklogHygiene>;
}

export interface NormalizedOptions {
  projectRoot: string;
  monitorUrl: string;
  taskIds: string[];
  sourceBranch?: string;
  targetBranch: string;
  checkpointPath?: string;
  minDepthScore: number;
  maxPrepAttempts: number;
  maxEnrichmentAttempts: number;
  maxDispatchAttempts: number;
  maxDispatches: number;
  activeDispatchLimit: number;
  pollIntervalMs: number;
  verifyAfterDispatch: boolean;
  autoEnrich: boolean;
  autoDecompose: boolean;
  maxSubtasks: number;
  skipGateOnDispatch: boolean;
  haltOnParseErrors: boolean;
  maxInfraFailures: number;
  maxBudgetUsd?: number;
  dryRun: boolean;
  once: boolean;
  maxCycles: number;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  logger: (message: string) => void;
  federationDispatch: boolean;
  preferredHostId?: string;
  allowLowPreflightOnFederationDispatch: boolean;
  autoAcknowledgeDecomposeReview: boolean;
}

export function parseTaskIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index);
}

export function classifyPrepResult(
  result: OvernightPrepResult,
  minDepthScore: number,
): { ready: boolean; reason?: string; needsDecomposition?: boolean } {
  if (!result.schemaValid) {
    return {
      ready: false,
      reason: `schema invalid: ${result.schemaErrors.join(", ") || "unknown schema error"}`,
    };
  }
  if (!result.depthReady) {
    return {
      ready: false,
      reason: `depth gate rejected at ${result.depthScore.toFixed(1)}`,
    };
  }
  if (result.depthScore < minDepthScore) {
    return {
      ready: false,
      reason: `depth score ${result.depthScore.toFixed(1)} below ${minDepthScore.toFixed(1)}`,
    };
  }
  if (result.recommendDecomposition) {
    return {
      ready: false,
      needsDecomposition: true,
      reason: `decomposition recommended: ${result.decompositionReason ?? "complexity thresholds exceeded"}`,
    };
  }
  if (result.outcome !== "pass") {
    return {
      ready: false,
      reason: `prep outcome ${result.outcome}`,
    };
  }
  return { ready: true };
}

export function classifyFailure(message: string | undefined): OvernightFailureClass {
  const text = (message ?? "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (
    /0\/0|no tests found|zero tests|adapter|verify|verification script|node_modules|dependency|worktree|monitor|dispatch not available|no \.quack|docker is required|permission bypass|direct_dispatch_blocked|direct task dispatch is disabled/.test(
      text,
    )
  ) {
    return "quack_infra";
  }
  if (/parse|schema|invalid task|missing required/.test(text)) {
    return "parse_error";
  }
  if (/unmet depend|blocked by|subtasks incomplete/.test(text)) {
    return "dependency_blocked";
  }
  if (/verification failed|test failed|build failed/.test(text)) {
    return "verification_failed";
  }
  return "task_failure";
}

export function selectNextAction(
  checkpoint: OvernightRunCheckpoint,
  activeJobs: OvernightDispatchJob[],
): RunnerAction {
  if (checkpoint.halted) {
    return { type: "halt", reason: checkpoint.haltReason ?? "checkpoint is halted" };
  }

  const settings = checkpoint.settings;
  if (settings.maxBudgetUsd !== undefined && checkpoint.totalCostUsd >= settings.maxBudgetUsd) {
    return {
      type: "halt",
      reason: `budget cap reached ($${checkpoint.totalCostUsd.toFixed(2)} / $${settings.maxBudgetUsd.toFixed(2)})`,
    };
  }

  const infraFailures = checkpoint.tasks.filter(
    (task) => task.failureClass === "quack_infra",
  ).length;
  if (infraFailures >= settings.maxInfraFailures) {
    return {
      type: "halt",
      reason: `quack infrastructure failure limit reached (${infraFailures})`,
    };
  }

  if (activeJobs.length > settings.activeDispatchLimit) {
    return {
      type: "halt",
      reason: `active dispatch limit exceeded (${activeJobs.length} > ${settings.activeDispatchLimit})`,
    };
  }

  const prepCandidate = checkpoint.tasks.find(
    (task) => task.status === "pending_prep" && task.prepAttempts < settings.maxPrepAttempts,
  );
  if (prepCandidate) {
    return { type: "prep", task: prepCandidate };
  }

  if (activeJobs.length >= settings.activeDispatchLimit) {
    return { type: "wait", reason: "dispatch lane occupied" };
  }

  if (checkpoint.dispatchesStarted >= settings.maxDispatches) {
    return {
      type: "wait",
      reason: `dispatch start cap reached (${settings.maxDispatches})`,
    };
  }

  const dispatchCandidate = checkpoint.tasks.find(
    (task) =>
      task.status === "ready_for_dispatch" && task.dispatchAttempts < settings.maxDispatchAttempts,
  );
  if (dispatchCandidate) {
    return { type: "dispatch", task: dispatchCandidate };
  }

  const unfinished = checkpoint.tasks.filter(
    (task) =>
      task.status === "pending_prep" ||
      task.status === "ready_for_dispatch" ||
      task.status === "running",
  );
  if (unfinished.length > 0) {
    return { type: "wait", reason: "tasks remain but no lane is currently available" };
  }

  return { type: "done", reason: "all queued tasks reached a terminal state" };
}

export async function runOvernightRunner(
  rawOptions: OvernightRunnerOptions,
): Promise<OvernightRunCheckpoint> {
  const options = normalizeOptions(rawOptions);
  const adapter = await loadAdapter(options.projectRoot);
  const projectId = generateProjectId(adapter.config.project.name);
  const settings = buildSettings(options, projectId);
  const checkpointPath = options.checkpointPath ?? defaultCheckpointPath(options.projectRoot);

  let checkpoint = await loadCheckpoint(checkpointPath);
  if (!checkpoint) {
    checkpoint = createCheckpoint(settings);
  } else {
    checkpoint.settings = { ...checkpoint.settings, ...settings };
    checkpoint.updatedAt = nowIso();
  }

  await updateCurrentStage(checkpointPath, checkpoint, options, "inventory", "running", {
    detail: "Loading overnight queue inventory.",
  });
  const inventory = await buildInventory(
    options.projectRoot,
    adapter.config.project.taskDir,
    {
      taskIds: options.taskIds,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
    },
    options.logger,
  );
  mergeInventory(checkpoint, inventory);
  addEvent(
    checkpoint,
    "inventory",
    `loaded ${inventory.items.length} task(s) into overnight queue`,
  );
  recordOverlayDegradation(checkpoint, inventory);
  await updateCurrentStage(checkpointPath, checkpoint, options, "inventory", "completed", {
    detail: `Loaded ${inventory.items.length} task(s) into overnight queue.`,
  });

  let cycles = 0;
  while (cycles < options.maxCycles) {
    cycles++;
    checkpoint.updatedAt = nowIso();

    await persistCheckpointIfEnabled(checkpointPath, checkpoint, options);

    if (options.haltOnParseErrors) {
      const parseInventory = await parseAllCurrentTasks(
        options.projectRoot,
        adapter.config.project.taskDir,
      );
      if (parseInventory.parseErrors.length > 0) {
        await updateCurrentStage(checkpointPath, checkpoint, options, "halted", "failed", {
          detail: `task parse errors present: ${parseInventory.parseErrors.length}`,
          error: `task parse errors present: ${parseInventory.parseErrors.length}`,
        });
        halt(checkpoint, `task parse errors present: ${parseInventory.parseErrors.length}`, {
          parseErrors: parseInventory.parseErrors.slice(0, 10),
        });
        break;
      }
    }

    const health = await safeRequestJson<Record<string, unknown>>(
      `${options.monitorUrl}/api/health`,
      "GET",
    );
    if (!health.ok) {
      await updateCurrentStage(checkpointPath, checkpoint, options, "halted", "failed", {
        detail: `monitor health check failed: ${health.error}`,
        error: `monitor health check failed: ${health.error}`,
      });
      halt(checkpoint, `monitor health check failed: ${health.error}`);
      break;
    }

    await reconcileRunningTasks(checkpoint, options, checkpointPath);
    refreshBlockedTasks(checkpoint);
    const jobsResult = await safeRequestJson<OvernightDispatchJob[]>(
      projectUrl(options.monitorUrl, "/api/dispatch/jobs", projectId),
      "GET",
    );
    if (!jobsResult.ok) {
      await updateCurrentStage(checkpointPath, checkpoint, options, "halted", "failed", {
        detail: `dispatch job check failed: ${jobsResult.error}`,
        error: `dispatch job check failed: ${jobsResult.error}`,
      });
      halt(checkpoint, `dispatch job check failed: ${jobsResult.error}`);
      break;
    }

    const activeJobs = jobsResult.value.filter(
      (job) => job.status === "running" || job.status === "awaiting_approval",
    );
    const action = selectNextAction(checkpoint, activeJobs);

    if (action.type === "halt") {
      await updateCurrentStage(checkpointPath, checkpoint, options, "halted", "failed", {
        detail: action.reason,
        error: action.reason,
      });
      halt(checkpoint, action.reason);
      break;
    }
    if (action.type === "done") {
      addEvent(checkpoint, "done", action.reason);
      await updateCurrentStage(checkpointPath, checkpoint, options, "summarizing", "completed", {
        detail: action.reason,
      });
      break;
    }
    if (action.type === "wait") {
      addEvent(checkpoint, "wait", action.reason);
      await updateCurrentStage(checkpointPath, checkpoint, options, "waiting", "running", {
        detail: action.reason,
      });
      options.logger(`[overnight] waiting: ${action.reason}`);
      if (options.once) break;
      await sleep(options.pollIntervalMs);
      continue;
    }
    if (action.type === "prep") {
      await prepTask(
        checkpoint,
        action.task,
        options,
        adapter.conventionsDoc,
        adapter.config.project.taskDir,
        checkpointPath,
      );
      if (options.once) break;
      continue;
    }
    if (action.type === "dispatch") {
      await dispatchTask(checkpoint, action.task, options, projectId, checkpointPath);
      if (options.once) break;
      continue;
    }
  }

  if (cycles >= options.maxCycles && !checkpoint.halted) {
    await updateCurrentStage(checkpointPath, checkpoint, options, "halted", "failed", {
      detail: `max cycles reached (${options.maxCycles})`,
      error: `max cycles reached (${options.maxCycles})`,
    });
    halt(checkpoint, `max cycles reached (${options.maxCycles})`);
  }
  checkpoint.updatedAt = nowIso();
  if (checkpoint.halted) {
    applyCurrentStageUpdate(checkpoint, "halted", "failed", {
      detail: checkpoint.haltReason ?? "Overnight run halted.",
      error: checkpoint.haltReason,
    });
  } else {
    applyCurrentStageUpdate(checkpoint, "completed", "completed", {
      detail: "Overnight run completed.",
    });
  }
  await persistCheckpointIfEnabled(checkpointPath, checkpoint, options);
  return checkpoint;
}

function normalizeOptions(options: OvernightRunnerOptions): NormalizedOptions {
  return {
    projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
    monitorUrl: (options.monitorUrl ?? "http://localhost:3333").replace(/\/+$/, ""),
    taskIds: options.taskIds ?? [],
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch ?? "dev",
    checkpointPath: options.checkpointPath,
    minDepthScore: options.minDepthScore ?? 4.5,
    maxPrepAttempts: options.maxPrepAttempts ?? 2,
    maxEnrichmentAttempts: options.maxEnrichmentAttempts ?? 1,
    maxDispatchAttempts: options.maxDispatchAttempts ?? 1,
    maxDispatches: options.maxDispatches ?? Number.MAX_SAFE_INTEGER,
    activeDispatchLimit: options.activeDispatchLimit ?? 1,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    verifyAfterDispatch: options.verifyAfterDispatch ?? true,
    autoEnrich: options.autoEnrich ?? false,
    autoDecompose: options.autoDecompose ?? true,
    maxSubtasks: options.maxSubtasks ?? 4,
    skipGateOnDispatch: options.skipGateOnDispatch ?? true,
    haltOnParseErrors: options.haltOnParseErrors ?? true,
    maxInfraFailures: options.maxInfraFailures ?? 1,
    maxBudgetUsd: options.maxBudgetUsd,
    dryRun: options.dryRun ?? false,
    once: options.once ?? false,
    maxCycles: options.maxCycles ?? Number.MAX_SAFE_INTEGER,
    model: options.model,
    maxTurns: options.maxTurns,
    maxBudget: options.maxBudget,
    logger: options.logger ?? console.log,
    federationDispatch: options.federationDispatch ?? Boolean(process.env.QUACK_SERVICE_TOKEN),
    preferredHostId: options.preferredHostId,
    allowLowPreflightOnFederationDispatch: options.allowLowPreflightOnFederationDispatch ?? false,
    autoAcknowledgeDecomposeReview: options.autoAcknowledgeDecomposeReview ?? false,
  };
}

function buildSettings(options: NormalizedOptions, projectId: string): OvernightRunSettings {
  return {
    projectRoot: options.projectRoot,
    projectId,
    monitorUrl: options.monitorUrl,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    minDepthScore: options.minDepthScore,
    maxPrepAttempts: options.maxPrepAttempts,
    maxEnrichmentAttempts: options.maxEnrichmentAttempts,
    maxDispatchAttempts: options.maxDispatchAttempts,
    maxDispatches: options.maxDispatches,
    activeDispatchLimit: options.activeDispatchLimit,
    pollIntervalMs: options.pollIntervalMs,
    verifyAfterDispatch: options.verifyAfterDispatch,
    autoEnrich: options.autoEnrich,
    autoDecompose: options.autoDecompose,
    maxSubtasks: options.maxSubtasks,
    skipGateOnDispatch: options.skipGateOnDispatch,
    haltOnParseErrors: options.haltOnParseErrors,
    maxInfraFailures: options.maxInfraFailures,
    maxBudgetUsd: options.maxBudgetUsd,
    federationDispatch: options.federationDispatch,
    preferredHostId: options.preferredHostId,
    allowLowPreflightOnFederationDispatch: options.allowLowPreflightOnFederationDispatch,
    autoAcknowledgeDecomposeReview: options.autoAcknowledgeDecomposeReview,
  };
}

function createCheckpoint(settings: OvernightRunSettings): OvernightRunCheckpoint {
  const createdAt = nowIso();
  return {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    runId: `overnight-${createdAt.replace(/[:.]/g, "-")}`,
    createdAt,
    updatedAt: createdAt,
    settings,
    tasks: [],
    events: [],
    dispatchesStarted: 0,
    totalCostUsd: 0,
    halted: false,
  };
}

async function loadCheckpoint(filePath: string): Promise<OvernightRunCheckpoint | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OvernightRunCheckpoint> & {
      schemaVersion?: number;
    };
    if (parsed.schemaVersion !== RUNNER_SCHEMA_VERSION) {
      throw new Error(`Unsupported overnight checkpoint schema ${parsed.schemaVersion}`);
    }
    return parsed as OvernightRunCheckpoint;
  } catch (err: unknown) {
    if (hasErrorCode(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

async function saveCheckpoint(filePath: string, checkpoint: OvernightRunCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(trimEvents(checkpoint), null, 2) + "\n", "utf-8");
}

function trimEvents(checkpoint: OvernightRunCheckpoint): OvernightRunCheckpoint {
  return {
    ...checkpoint,
    events: checkpoint.events.slice(-500),
  };
}

async function persistCheckpointIfEnabled(
  checkpointPath: string,
  checkpoint: OvernightRunCheckpoint,
  options: NormalizedOptions,
): Promise<void> {
  if (options.dryRun) return;
  await saveCheckpoint(checkpointPath, checkpoint);
}

export function applyCurrentStageUpdate(
  checkpoint: OvernightRunCheckpoint,
  stage: AdminRunStage,
  status: AdminRunStageProgress["status"],
  details: {
    taskId?: string;
    detail?: string;
    error?: string;
  } = {},
): void {
  const now = nowIso();
  const policy = getAdminRunStagePolicy(stage);
  const existing = checkpoint.currentStage;
  const preserveStartedAt =
    existing?.stage === stage &&
    existing.startedAt &&
    (existing.status === "running" || status !== "running");
  const startedAt = preserveStartedAt ? existing.startedAt : now;
  checkpoint.currentStage = {
    stage,
    status,
    startedAt,
    lastHeartbeatAt: now,
    lastOutputAt: now,
    staleAfterMs: policy.outputStaleAfterMs,
    recommendedAction: policy.recommendedAction,
    taskId: details.taskId,
    detail: details.detail,
    error: details.error,
  };
  checkpoint.updatedAt = now;
}

async function updateCurrentStage(
  checkpointPath: string,
  checkpoint: OvernightRunCheckpoint,
  options: NormalizedOptions,
  stage: AdminRunStage,
  status: AdminRunStageProgress["status"],
  details: {
    taskId?: string;
    detail?: string;
    error?: string;
  } = {},
): Promise<void> {
  applyCurrentStageUpdate(checkpoint, stage, status, details);
  await persistCheckpointIfEnabled(checkpointPath, checkpoint, options);
}

function createPreflightStageReporter(
  checkpointPath: string,
  checkpoint: OvernightRunCheckpoint,
  options: NormalizedOptions,
  taskId: string,
): PreflightStageReporter {
  return {
    started(stage, detail) {
      return updateCurrentStage(checkpointPath, checkpoint, options, stage, "running", {
        taskId,
        detail,
      });
    },
    heartbeat(stage, detail) {
      return updateCurrentStage(checkpointPath, checkpoint, options, stage, "running", {
        taskId,
        detail,
      });
    },
    completed(stage, detail) {
      return updateCurrentStage(checkpointPath, checkpoint, options, stage, "completed", {
        taskId,
        detail,
      });
    },
    failed(stage, error, detail) {
      return updateCurrentStage(checkpointPath, checkpoint, options, stage, "failed", {
        taskId,
        detail,
        error,
      });
    },
  };
}

async function startStageHeartbeat(
  checkpointPath: string,
  checkpoint: OvernightRunCheckpoint,
  options: NormalizedOptions,
  stage: AdminRunStage,
  details: {
    taskId?: string;
    detail?: string;
  } = {},
): Promise<() => void> {
  await updateCurrentStage(checkpointPath, checkpoint, options, stage, "running", details);
  const policy = getAdminRunStagePolicy(stage);
  const intervalMs = Math.max(
    5_000,
    Math.min(30_000, Math.floor(policy.outputStaleAfterMs / 3) || 5_000),
  );
  const timer = setInterval(() => {
    void updateCurrentStage(checkpointPath, checkpoint, options, stage, "running", details);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function buildInventory(
  projectRoot: string,
  taskDir: string,
  source: { taskIds: string[]; sourceBranch?: string; targetBranch: string },
  logger: (message: string) => void,
): Promise<OvernightInventoryPass> {
  // TASK-1318 S2, step 1: ONE batch read for the whole pass, before any
  // loop. Every doneness answer in this pass resolves against this Map,
  // so no task triggers I/O of its own. The module's own degraded
  // warning is routed through the run logger so it lands in the
  // overnight log rather than on a stray console.
  const overlayLoad = loadTaskStateOverlay(projectRoot, { warn: logger });

  // Round-3 F3: parsed ONCE. This used to run twice per pass with
  // identical arguments, and the two copies could only ever agree, so
  // hoisting it costs nothing and is what lets discovery below and the
  // item mapping further down share one overlay-resolved hygiene view
  // instead of computing hygiene from two different status inputs.
  const current = await parseAllCurrentTasks(projectRoot, taskDir, overlayLoad.overlay);

  const ids = new Map<string, OvernightInventoryItem>();
  for (const taskId of source.taskIds) {
    ids.set(taskId, { taskId });
  }

  if (source.sourceBranch) {
    for (const item of await taskIdsFromBranchDiff(
      projectRoot,
      taskDir,
      source.sourceBranch,
      source.targetBranch,
    )) {
      if (!ids.has(item.taskId)) ids.set(item.taskId, item);
    }
  }

  if (ids.size === 0) {
    // Round-3 F3: AUTOMATIC discovery, the path taken when no task ids
    // were named and no source branch was given. It gated on the raw
    // spec `Status:` line and on spec-only hygiene, BEFORE anything
    // routed ran, so a task whose runtime row disagreed with its
    // markdown never entered the inventory at all and never reached the
    // resolved predicates downstream. Every existing test passed
    // explicit ids and so never crossed this branch.
    //
    // `READY` stays an exact match on the raw resolved value rather than
    // becoming a `typedStatus` comparison: accepting aliases here would
    // be a second, separate behavior change, and this fix is about WHICH
    // status is read, not which spellings count.
    for (const [taskId, task] of current.tasksById) {
      const status = resolvedTaskStatus(task, overlayLoad.overlay);
      if (status !== "READY") continue;
      if (
        isTaskSuppressedFromAutomation({
          status,
          backlogHygiene: current.hygieneByTaskId.get(taskId),
        })
      ) {
        continue;
      }
      ids.set(taskId, {
        taskId,
        task,
        taskFile: current.taskFilesById.get(taskId),
      });
    }
  }

  const verifiedTaskIds = await loadVerifiedTaskIds(projectRoot);
  const items = [...ids.values()].map((item) => {
    const currentTask = current.tasksById.get(item.taskId);
    const taskFile = current.taskFilesById.get(item.taskId);
    const parseError = current.parseErrors.find((err) => err.file.startsWith(item.taskId))?.error;
    return {
      ...item,
      task: currentTask ?? item.task,
      taskFile: taskFile ?? item.taskFile,
      parseError,
      verified: verifiedTaskIds.has(item.taskId),
      dependenciesSatisfied: currentTask
        ? areParsedDependenciesSatisfied(
            currentTask.blockedBy,
            current.tasksById,
            verifiedTaskIds,
            overlayLoad.overlay,
          )
        : item.dependenciesSatisfied,
    };
  });
  return {
    items,
    overlay: overlayLoad.overlay,
    overlayDegraded: overlayLoad.degraded,
    overlaySource: overlayLoad.source,
    overlayError: overlayLoad.error,
  };
}

async function taskIdsFromBranchDiff(
  projectRoot: string,
  taskDir: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<OvernightInventoryItem[]> {
  const taskDirForGit = taskDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const result = await runGit(projectRoot, [
    "diff",
    "--name-only",
    `${targetBranch}...${sourceBranch}`,
    "--",
    `${taskDirForGit}/TASK-*.md`,
  ]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<OvernightInventoryItem[]>((items, sourcePath) => {
      const match = path.basename(sourcePath).match(TASK_ID_RE);
      if (match) {
        items.push({ taskId: match[0], sourcePath });
      }
      return items;
    }, []);
}

/**
 * Parse every task spec in the directory and evaluate backlog hygiene
 * for it.
 *
 * `overlay` is what makes the hygiene half honest (round-3 F3). Status
 * hygiene asks "is this task ON_HOLD or REJECTED", which is the runtime
 * store's question; evaluating it from the spec line let a markdown edit
 * veto automation for a task the store had already spoken for. With the
 * overlay supplied, structural hygiene (duplicate ids, supersession)
 * still comes from the files, where it belongs, and status hygiene is
 * folded on afterwards from the resolved status.
 *
 * Omitting `overlay` keeps the pre-round-3 spec-only behavior, and the
 * spec-only input is then explicit in the call rather than hidden.
 */
async function parseAllCurrentTasks(
  projectRoot: string,
  taskDir: string,
  overlay?: RuntimeStatusOverlay,
): Promise<TaskParseInventory> {
  const absoluteTaskDir = path.resolve(projectRoot, taskDir);
  const tasksById = new Map<string, ParsedTask>();
  const taskFilesById = new Map<string, string>();
  const parseErrors: Array<{ file: string; error: string }> = [];
  const taskSources: Array<{ file: string; task: ParsedTask }> = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(absoluteTaskDir);
  } catch {
    return {
      tasksById,
      taskFilesById,
      parseErrors,
      hygieneByTaskId: new Map<string, TaskBacklogHygiene>(),
    };
  }

  const taskFiles = entries.filter((entry) => /^TASK-\d+.*\.md$/.test(entry)).sort();
  for (const file of taskFiles) {
    const filePath = path.join(absoluteTaskDir, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFile(content, filePath);
      tasksById.set(task.id, task);
      taskFilesById.set(task.id, filePath);
      taskSources.push({ file, task });
    } catch (err: unknown) {
      parseErrors.push({
        file,
        error: err instanceof TaskParseError ? err.message : String(err),
      });
    }
  }
  const structural = buildStructuralBacklogHygieneReport(taskSources);
  const { byTaskId: hygieneByTaskId } = applyResolvedStatusHygiene(
    structural,
    taskSources.map(({ task }) => ({
      taskId: task.id,
      title: task.title,
      status: overlay ? resolvedTaskStatus(task, overlay) : task.status,
      specStatus: task.status,
    })),
  );
  return { tasksById, taskFilesById, parseErrors, hygieneByTaskId };
}

function mergeInventory(
  checkpoint: OvernightRunCheckpoint,
  inventory: OvernightInventoryPass,
): void {
  const existing = new Map(checkpoint.tasks.map((task) => [task.taskId, task]));
  for (const item of inventory.items) {
    const current = existing.get(item.taskId);
    if (current) {
      current.title = item.task?.title ?? current.title;
      current.taskFile = item.taskFile ?? current.taskFile;
      current.sourcePath = item.sourcePath ?? current.sourcePath;
      current.blockedBy = item.task?.blockedBy ?? current.blockedBy;
      current.updatedAt = nowIso();
      continue;
    }

    const initial = initialStatusForInventory(item, inventory.overlay);
    checkpoint.tasks.push({
      taskId: item.taskId,
      title: item.task?.title,
      taskFile: item.taskFile,
      sourcePath: item.sourcePath,
      status: initial.status,
      prepAttempts: 0,
      dispatchAttempts: 0,
      enrichmentAttempts: 0,
      deficiencies: [],
      blockedBy: item.task?.blockedBy ?? [],
      failureClass: item.parseError ? "parse_error" : undefined,
      lastError: initial.lastError,
      updatedAt: nowIso(),
    });
  }
  checkpoint.tasks.sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
}

/**
 * Put a degraded overlay read in the checkpoint, not only in the log.
 *
 * A missing database is normal and says nothing. A database that EXISTS
 * and could not be read is the dangerous case: the whole pass quietly
 * reverted to spec authority, and from the outside that is
 * indistinguishable from a healthy run. The operator reading the
 * checkpoint afterwards needs to know which one they got.
 */
function recordOverlayDegradation(
  checkpoint: OvernightRunCheckpoint,
  inventory: OvernightInventoryPass,
): void {
  if (!inventory.overlayDegraded) return;
  addEvent(
    checkpoint,
    "task_state_overlay_degraded",
    `runtime task state was unreadable (${inventory.overlaySource}); queue decisions in this pass used spec status, which is not authoritative`,
    {
      overlaySource: inventory.overlaySource,
      error: inventory.overlayError,
    },
  );
}

/**
 * The reason recorded on a task skipped for being REJECTED.
 *
 * Not decoration. `isDependencySatisfied` treats the runner's `skipped`
 * state as satisfying a dependent, which was safe while `skipped` could
 * only mean COMPLETE, VERIFIED or externally verified. Routing the
 * own-task skip onto `isTerminalTaskStatus` lets REJECTED reach
 * `skipped` for the first time, and without this marker a REJECTED
 * dependency in the same inventory would unblock its dependent through
 * `refreshBlockedTasks`. That is a back door around the
 * `isCompleteStatus` rule the dependency site above exists to enforce.
 *
 * `OvernightTaskRecord` has no skip-reason field and lives in
 * `types.ts`, so the reason rides on `lastError`, which is the record's
 * human-readable "why is it in this state" field and is never
 * overwritten for a skipped record. Both the writer and the reader use
 * this one constant so they cannot drift.
 */
const SKIPPED_REJECTED_REASON = "skipped: resolved status is REJECTED";

interface InitialInventoryState {
  status: OvernightTaskRecord["status"];
  lastError?: string;
}

function initialStatusForInventory(
  item: OvernightInventoryItem,
  overlay: RuntimeStatusOverlay,
): InitialInventoryState {
  if (item.parseError) return { status: "manual_review", lastError: item.parseError };
  if (!item.task) return { status: "manual_review" };
  if (item.verified) return { status: "skipped" };
  // TASK-1318 S2: "is this task finished as work", so REJECTED counts.
  // Resolved, not raw: a task the store has already closed must not be
  // requeued because its markdown still says READY.
  const resolved = resolvedTaskStatus(item.task, overlay);
  if (isTerminalTaskStatus(resolved)) {
    return isCompleteStatus(resolved)
      ? { status: "skipped" }
      : { status: "skipped", lastError: SKIPPED_REJECTED_REASON };
  }
  if (item.task.status === "BLOCKED" || item.task.blockedBy.length > 0) {
    return { status: item.dependenciesSatisfied ? "pending_prep" : "blocked" };
  }
  return { status: "pending_prep" };
}

async function loadVerifiedTaskIds(projectRoot: string): Promise<Set<string>> {
  const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
  try {
    const raw = await fs.readFile(verifiedPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      tasks?: Record<string, { verdict?: string; verified?: string } | undefined>;
      [taskId: string]: unknown;
    };
    const records = parsed.tasks ?? parsed;
    const ids = new Set<string>();
    for (const [taskId, value] of Object.entries(records)) {
      if (!/^TASK-\d+(?:-[A-Z]+)?$/.test(taskId)) continue;
      if (typeof value !== "object" || value === null) continue;
      const record = value as { verdict?: string; verified?: string };
      if (record.verdict === "VERIFIED" || typeof record.verified === "string") {
        ids.add(taskId);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

// TASK-1318 S2: "does this DEPENDENCY satisfy its dependent", so
// REJECTED must never count and the predicate stays `isCompleteStatus`.
// The overlay is passed in rather than loaded here: this runs once per
// inventory item, and a load inside would be exactly the per-task query
// the batch read exists to avoid.
function areParsedDependenciesSatisfied(
  blockedBy: string[],
  tasksById: Map<string, ParsedTask>,
  verifiedTaskIds: Set<string>,
  overlay: RuntimeStatusOverlay,
): boolean {
  if (blockedBy.length === 0) return true;
  return blockedBy.every((rawDepId) => {
    const depId = extractTaskId(rawDepId);
    if (!depId) return false;
    if (verifiedTaskIds.has(depId)) return true;
    const dep = tasksById.get(depId);
    if (dep && isCompleteStatus(resolvedTaskStatus(dep, overlay))) return true;
    const subtasks = [...tasksById.values()].filter((task) => task.id.startsWith(`${depId}-`));
    return (
      subtasks.length > 0 &&
      subtasks.every(
        (task) =>
          isCompleteStatus(resolvedTaskStatus(task, overlay)) || verifiedTaskIds.has(task.id),
      )
    );
  });
}

async function prepTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  conventionsDoc: string,
  taskDir: string,
  checkpointPath: string,
): Promise<void> {
  task.prepAttempts += 1;
  task.updatedAt = nowIso();
  addEvent(checkpoint, "prep_start", `prep attempt ${task.prepAttempts} for ${task.taskId}`, {
    taskId: task.taskId,
  });
  const stopHeartbeat = await startStageHeartbeat(checkpointPath, checkpoint, options, "prep", {
    taskId: task.taskId,
    detail: `Prep attempt ${task.prepAttempts} for ${task.taskId}.`,
  });
  options.logger(`[overnight] prep ${task.taskId} (attempt ${task.prepAttempts})`);

  if (options.dryRun) {
    addEvent(checkpoint, "dry_run", `would prep ${task.taskId}`, { taskId: task.taskId });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "prep", "completed", {
      taskId: task.taskId,
      detail: `Dry-run prep for ${task.taskId}.`,
    });
    return;
  }

  try {
    const result = await runPrepEvaluation(
      options.projectRoot,
      task.taskId,
      conventionsDoc,
      createPreflightStageReporter(checkpointPath, checkpoint, options, task.taskId),
    );
    task.depthScore = result.depthScore;
    task.depthReady = result.depthReady;
    task.deficiencies = result.deficiencies;
    task.recommendDecomposition = result.recommendDecomposition;
    task.decompositionReason = result.decompositionReason;
    const classification = classifyPrepResult(result, options.minDepthScore);
    if (classification.ready) {
      task.status = "ready_for_dispatch";
      task.lastError = undefined;
      task.failureClass = undefined;
      addEvent(
        checkpoint,
        "prep_pass",
        `${task.taskId} passed prep at ${result.depthScore.toFixed(1)}`,
        {
          taskId: task.taskId,
          depthScore: result.depthScore,
        },
      );
      stopHeartbeat();
      await updateCurrentStage(checkpointPath, checkpoint, options, "prep", "completed", {
        taskId: task.taskId,
        detail: `${task.taskId} passed prep at ${result.depthScore.toFixed(1)}.`,
      });
      return;
    }

    task.lastError = classification.reason;
    if (classification.needsDecomposition) {
      if (options.autoDecompose) {
        await decomposeRecommendedTask(checkpoint, task, options, taskDir, checkpointPath);
        return;
      }
      task.status = "needs_decomposition";
      task.failureClass = undefined;
      addEvent(
        checkpoint,
        "decomposition_required",
        `${task.taskId} requires decomposition before dispatch`,
        {
          taskId: task.taskId,
          reason: classification.reason,
        },
      );
      stopHeartbeat();
      await updateCurrentStage(checkpointPath, checkpoint, options, "prep", "completed", {
        taskId: task.taskId,
        detail: `${task.taskId} requires decomposition before dispatch.`,
      });
      return;
    }

    if (options.autoEnrich && task.enrichmentAttempts < options.maxEnrichmentAttempts) {
      stopHeartbeat();
      await enrichTask(checkpoint, task, options, checkpointPath);
      task.status = "pending_prep";
      return;
    }

    task.status = task.prepAttempts >= options.maxPrepAttempts ? "manual_review" : "pending_prep";
    task.failureClass = task.status === "manual_review" ? "task_failure" : undefined;
    addEvent(
      checkpoint,
      "prep_rejected",
      `${task.taskId} needs ${task.status === "manual_review" ? "manual review" : "another prep pass"}: ${classification.reason}`,
      { taskId: task.taskId, deficiencies: result.deficiencies },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "prep", "completed", {
      taskId: task.taskId,
      detail: `${task.taskId} ${task.status === "manual_review" ? "needs manual review" : "needs another prep pass"}.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    task.lastError = message;
    task.failureClass = classifyFailure(message);
    task.status = "manual_review";
    addEvent(checkpoint, "prep_error", `${task.taskId} prep failed: ${message}`, {
      taskId: task.taskId,
      failureClass: task.failureClass,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "prep", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} prep failed.`,
      error: message,
    });
  }
}

async function runPrepEvaluation(
  projectRoot: string,
  taskId: string,
  conventionsDoc: string,
  stageReporter?: PreflightStageReporter,
): Promise<OvernightPrepResult> {
  const adapter = await loadAdapter(projectRoot);
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const resolved = await resolveTaskFile(taskDir, taskId);
  if (!resolved) {
    throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
  }

  const { content, filePath } = resolved;
  const parsed = resolved.task ?? parseTaskFile(content, filePath);
  const schema = validateTaskSchema(parsed);
  if (!schema.valid) {
    const result: OvernightPrepResult = {
      schemaValid: false,
      schemaErrors: schema.missing,
      depthScore: 0,
      depthReady: false,
      deficiencies: schema.missing,
      outcome: "rejected",
    };
    await writePrepCache(projectRoot, taskId, content, result);
    return result;
  }

  const depth = await evaluateTaskDepth(parsed, conventionsDoc);
  let recommendDecomposition = false;
  let decompositionReason: string | undefined;

  if (depth.ready) {
    const preflight = await runPreflight(parsed, adapter, {
      skipGate: true,
      stageReporter,
    });
    recommendDecomposition = preflight.complexity.recommendDecomposition;
    decompositionReason = preflight.complexity.reason;
  }

  const result: OvernightPrepResult = {
    schemaValid: true,
    schemaErrors: [],
    depthScore: depth.overallScore,
    depthReady: depth.ready,
    deficiencies: depth.deficiencies,
    outcome: depth.ready ? "pass" : "rejected",
    recommendDecomposition,
    decompositionReason,
  };
  await writePrepCache(projectRoot, taskId, content, result);
  return result;
}

async function writePrepCache(
  projectRoot: string,
  taskId: string,
  taskContent: string,
  result: OvernightPrepResult,
): Promise<void> {
  const cache = new PrepCache(projectRoot);
  const preparedAt = nowIso();
  const contentHash = computeContentHash(taskContent);
  await cache.write({
    taskId,
    preparedAt,
    schemaValid: result.schemaValid,
    schemaErrors: result.schemaErrors,
    depthScore: result.depthScore,
    depthReady: result.depthReady,
    deficiencies: result.deficiencies,
    outcome: result.outcome,
    recommendDecomposition: result.recommendDecomposition,
    decompositionReason: result.decompositionReason,
    contentHash,
  });

  const readiness = new ReadinessService({
    projectRoot,
  });
  try {
    readiness.persistPrepResult(taskId, taskContent, {
      taskId,
      preparedAt,
      schemaValid: result.schemaValid,
      schemaErrors: result.schemaErrors,
      depthScore: result.depthScore,
      depthReady: result.depthReady,
      deficiencies: result.deficiencies,
      outcome: result.outcome,
      recommendDecomposition: result.recommendDecomposition,
      decompositionReason: result.decompositionReason,
      contentHash,
    });
  } finally {
    readiness.close();
  }
}

interface DecomposePlanResponse {
  ok?: boolean;
  topology?: Record<string, unknown>;
  subtaskIds?: string[];
  coverageReport?: { clean?: boolean; gaps?: string[] };
  parentReadiness?: Record<string, unknown>;
  error?: string;
  refusalCode?: string;
  refusalMessage?: string;
}

interface DecomposeMaterializeResponse {
  ok?: boolean;
  topology?: Record<string, unknown>;
  drafts?: Array<{ taskId?: string; path?: string; [key: string]: unknown }>;
  subtaskIds?: string[];
  failedDraftIds?: string[];
  deficiencies?: string[];
  error?: string;
  refusalCode?: string;
  refusalMessage?: string;
}

interface DecomposeFinalizeResponse {
  ok?: boolean;
  subtaskIds?: string[];
  writtenPaths?: string[];
  error?: string;
  refusalCode?: string;
  refusalMessage?: string;
}

interface DecomposeStepSuccess<T> {
  ok: true;
  value: T;
}

interface DecomposeStepFailure {
  ok: false;
  error: string;
  refusalCode?: string;
  refusalMessage?: string;
}

type DecomposeStepResult<T> = DecomposeStepSuccess<T> | DecomposeStepFailure;

async function postDecomposeStep<
  T extends { ok?: boolean; error?: string; refusalCode?: string; refusalMessage?: string },
>(
  options: NormalizedOptions,
  checkpoint: OvernightRunCheckpoint,
  taskId: string,
  body: Record<string, unknown>,
): Promise<DecomposeStepResult<T>> {
  const url = projectUrl(
    options.monitorUrl,
    `/api/tasks/${encodeURIComponent(taskId)}/decompose`,
    checkpoint.settings.projectId,
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, error: `HTTP ${res.status}: non-JSON response` };
    }
    const data = parsed as T;
    if (res.ok && data.ok !== false) {
      return { ok: true, value: data };
    }
    const errMsg = data.error ?? `HTTP ${res.status}`;
    return {
      ok: false,
      error: errMsg,
      refusalCode: data.refusalCode,
      refusalMessage: data.refusalMessage,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function decomposeRecommendedTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  taskDir: string,
  checkpointPath: string,
): Promise<void> {
  addEvent(checkpoint, "decomposition_start", `decomposing ${task.taskId}`, {
    taskId: task.taskId,
    reason: task.decompositionReason,
  });
  const stopHeartbeat = await startStageHeartbeat(
    checkpointPath,
    checkpoint,
    options,
    "decompose",
    {
      taskId: task.taskId,
      detail: `Decomposing ${task.taskId}.`,
    },
  );
  options.logger(`[overnight] decompose ${task.taskId}`);

  // ── Step 1: plan ──────────────────────────────────────────────────────────
  const planResult = await postDecomposeStep<DecomposePlanResponse>(
    options,
    checkpoint,
    task.taskId,
    { mode: "plan", maxSubtasks: options.maxSubtasks },
  );

  if (!planResult.ok) {
    const refusalCode = planResult.refusalCode;
    const refusalMessage = planResult.refusalMessage ?? planResult.error;
    task.status = "manual_review";
    task.lastError = refusalMessage;
    task.failureClass = classifyFailure(refusalMessage);
    task.decomposeRefusalCode = refusalCode;
    task.decomposeRefusalMessage = refusalMessage;
    addEvent(
      checkpoint,
      "decomposition_error",
      `${task.taskId} decompose plan failed: ${planResult.error}`,
      {
        taskId: task.taskId,
        failureClass: task.failureClass,
        refusalCode,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} decompose plan failed.`,
      error: planResult.error,
    });
    return;
  }

  const planData = planResult.value;
  const planSubtaskIds: string[] = planData.subtaskIds ?? [];
  const coverageClean = planData.coverageReport?.clean ?? false;
  const coverageGaps: string[] = planData.coverageReport?.gaps ?? [];

  addEvent(
    checkpoint,
    "decomposition_plan_ready",
    `${task.taskId} decompose plan ready with ${planSubtaskIds.length} subtask(s)`,
    {
      taskId: task.taskId,
      subtaskIds: planSubtaskIds,
      coverageClean,
      coverageGaps,
    },
  );

  // ── Step 2: materialize ───────────────────────────────────────────────────
  const materializeResult = await postDecomposeStep<DecomposeMaterializeResponse>(
    options,
    checkpoint,
    task.taskId,
    { mode: "materialize", plan: planData.topology, maxSubtasks: options.maxSubtasks },
  );

  if (!materializeResult.ok) {
    const refusalCode = materializeResult.refusalCode;
    const refusalMessage = materializeResult.refusalMessage ?? materializeResult.error;
    task.status = "manual_review";
    task.lastError = refusalMessage;
    task.failureClass = classifyFailure(refusalMessage);
    task.decomposeRefusalCode = refusalCode;
    task.decomposeRefusalMessage = refusalMessage;
    task.subtaskIds = planSubtaskIds.length > 0 ? planSubtaskIds : undefined;
    task.decomposePlan = planData.topology;
    addEvent(
      checkpoint,
      "decomposition_error",
      `${task.taskId} decompose materialize failed: ${materializeResult.error}`,
      {
        taskId: task.taskId,
        failureClass: task.failureClass,
        refusalCode,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} decompose materialize failed.`,
      error: materializeResult.error,
    });
    return;
  }

  const materializeData = materializeResult.value;
  const materializeSubtaskIds: string[] = materializeData.subtaskIds ?? planSubtaskIds;
  const draftCount = materializeData.drafts?.length ?? 0;
  const failedDraftIds: string[] = materializeData.failedDraftIds ?? [];
  const deficiencies: string[] = materializeData.deficiencies ?? [];

  addEvent(
    checkpoint,
    "decomposition_drafts_materialized",
    `${task.taskId} ${draftCount} draft(s) materialized`,
    {
      taskId: task.taskId,
      subtaskIds: materializeSubtaskIds,
      draftCount,
      failedDraftIds,
      deficiencies,
    },
  );

  // ── Step 3: finalize (only when explicitly acknowledged) ──────────────────
  if (!options.autoAcknowledgeDecomposeReview) {
    // Record plan/materialize evidence and stop — operator must review.
    task.status = "manual_review";
    task.subtaskIds = materializeSubtaskIds;
    task.decomposePlan = planData.topology;
    task.decomposeDraftCount = draftCount;
    task.decomposeCoverageClean = coverageClean;
    task.lastError = "decompose review required; materialized drafts are ready for operator review";
    task.failureClass = undefined;
    addEvent(
      checkpoint,
      "decomposition_review_required",
      `${task.taskId} decompose review required`,
      {
        taskId: task.taskId,
        subtaskIds: materializeSubtaskIds,
        draftCount,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "completed", {
      taskId: task.taskId,
      detail: `${task.taskId} decompose review required; ${draftCount} draft(s) ready.`,
    });
    return;
  }

  // Auto-acknowledge: guard against bad quality before proceeding to finalize.
  // The runner enforces these client-side so that a failing materialize result
  // never reaches the finalize step even when autoAcknowledgeDecomposeReview
  // is enabled.
  if (failedDraftIds.length > 0 || !coverageClean) {
    task.status = "manual_review";
    task.subtaskIds = materializeSubtaskIds;
    task.decomposePlan = planData.topology;
    task.decomposeDraftCount = draftCount;
    task.decomposeCoverageClean = coverageClean;
    task.lastError =
      failedDraftIds.length > 0
        ? `${failedDraftIds.length} draft(s) failed quality gates and cannot be auto-finalized: ${failedDraftIds.join(", ")}`
        : "coverage is not clean — cannot auto-finalize; operator review required";
    task.failureClass = undefined;
    addEvent(
      checkpoint,
      "decomposition_review_required",
      `${task.taskId} decompose auto-finalize blocked: quality gates not met`,
      {
        taskId: task.taskId,
        subtaskIds: materializeSubtaskIds,
        draftCount,
        failedDraftIds,
        deficiencies,
        coverageClean,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "completed", {
      taskId: task.taskId,
      detail: `${task.taskId} decompose auto-finalize blocked; ${failedDraftIds.length} failed draft(s), coverageClean=${coverageClean}.`,
    });
    return;
  }

  // Quality gates passed — proceed to finalize.
  const finalizeResult = await postDecomposeStep<DecomposeFinalizeResponse>(
    options,
    checkpoint,
    task.taskId,
    {
      mode: "finalize",
      plan: planData.topology,
      drafts: materializeData.drafts,
      reviewAcknowledged: true,
    },
  );

  if (!finalizeResult.ok) {
    const refusalCode = finalizeResult.refusalCode;
    const refusalMessage = finalizeResult.refusalMessage ?? finalizeResult.error;
    task.status = "manual_review";
    task.lastError = refusalMessage;
    task.failureClass = classifyFailure(refusalMessage);
    task.decomposeRefusalCode = refusalCode;
    task.decomposeRefusalMessage = refusalMessage;
    task.subtaskIds = materializeSubtaskIds;
    task.decomposePlan = planData.topology;
    task.decomposeDraftCount = draftCount;
    task.decomposeCoverageClean = coverageClean;
    addEvent(
      checkpoint,
      "decomposition_finalize_refused",
      `${task.taskId} decompose finalize refused: ${refusalCode ?? finalizeResult.error}`,
      {
        taskId: task.taskId,
        refusalCode,
        refusalMessage,
        subtaskIds: materializeSubtaskIds,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} decompose finalize refused.`,
      error: refusalMessage,
    });
    return;
  }

  const finalizeData = finalizeResult.value;
  const subtaskIds: string[] = finalizeData.subtaskIds ?? materializeSubtaskIds;

  task.status = "decomposed";
  task.subtaskIds = subtaskIds;
  task.decomposePlan = planData.topology;
  task.decomposeDraftCount = draftCount;
  task.decomposeCoverageClean = coverageClean;
  task.lastError = undefined;
  task.failureClass = undefined;

  const subtaskInventory = await buildInventory(
    options.projectRoot,
    taskDir,
    {
      taskIds: subtaskIds,
      targetBranch: options.targetBranch,
    },
    options.logger,
  );
  mergeInventory(checkpoint, subtaskInventory);
  recordOverlayDegradation(checkpoint, subtaskInventory);
  refreshBlockedTasks(checkpoint);

  addEvent(
    checkpoint,
    "decomposition_complete",
    `${task.taskId} decomposed into ${subtaskIds.length} subtasks`,
    {
      taskId: task.taskId,
      subtaskIds,
      writtenPaths: finalizeData.writtenPaths ?? [],
    },
  );
  stopHeartbeat();
  await updateCurrentStage(checkpointPath, checkpoint, options, "decompose", "completed", {
    taskId: task.taskId,
    detail: `${task.taskId} decomposed into ${subtaskIds.length} subtasks.`,
  });
}

async function enrichTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  checkpointPath: string,
): Promise<void> {
  task.enrichmentAttempts += 1;
  addEvent(checkpoint, "enrich_start", `enriching ${task.taskId}`, { taskId: task.taskId });
  const stopHeartbeat = await startStageHeartbeat(checkpointPath, checkpoint, options, "enrich", {
    taskId: task.taskId,
    detail: `Enriching ${task.taskId}.`,
  });
  options.logger(`[overnight] enrich ${task.taskId}`);

  const result = await safeRequestJson<Record<string, unknown>>(
    projectUrl(
      options.monitorUrl,
      `/api/tasks/${encodeURIComponent(task.taskId)}/enrich`,
      checkpoint.settings.projectId,
    ),
    "POST",
    {},
  );
  if (!result.ok) {
    task.lastError = result.error;
    task.failureClass = classifyFailure(result.error);
    task.status = "manual_review";
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "enrich", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} enrichment failed.`,
      error: result.error,
    });
    return;
  }

  if (result.value.outcome === "enriched" && typeof result.value.enrichedContent === "string") {
    const approve = await safeRequestJson<Record<string, unknown>>(
      projectUrl(
        options.monitorUrl,
        `/api/tasks/${encodeURIComponent(task.taskId)}/enrich/approve`,
        checkpoint.settings.projectId,
      ),
      "POST",
      { content: result.value.enrichedContent },
    );
    if (!approve.ok) {
      task.lastError = approve.error;
      task.failureClass = classifyFailure(approve.error);
      task.status = "manual_review";
      return;
    }
    addEvent(checkpoint, "enrich_applied", `applied enrichment for ${task.taskId}`, {
      taskId: task.taskId,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "enrich", "completed", {
      taskId: task.taskId,
      detail: `Applied enrichment for ${task.taskId}.`,
    });
    return;
  }

  if (result.value.outcome === "pass") {
    task.status = "ready_for_dispatch";
    task.lastError = undefined;
    addEvent(checkpoint, "enrich_pass", `${task.taskId} passed during enrich`, {
      taskId: task.taskId,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "enrich", "completed", {
      taskId: task.taskId,
      detail: `${task.taskId} passed during enrich.`,
    });
    return;
  }

  task.lastError =
    typeof result.value.reason === "string" ? result.value.reason : "enrichment rejected";
  task.failureClass = "task_failure";
  task.status = "manual_review";
  stopHeartbeat();
  await updateCurrentStage(checkpointPath, checkpoint, options, "enrich", "failed", {
    taskId: task.taskId,
    detail: `${task.taskId} enrichment was rejected.`,
    error: task.lastError,
  });
}

export function resolveDispatchMode(options: {
  federationDispatch: boolean;
}): "direct" | "federation" {
  if (options.federationDispatch) return "federation";
  return "direct";
}

export async function dispatchTaskDirect(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  projectId: string,
  stopHeartbeat: () => void,
  checkpointPath: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    skipGate: options.skipGateOnDispatch,
  };
  if (options.model) body.model = options.model;
  if (options.maxTurns !== undefined) body.maxTurns = options.maxTurns;
  if (options.maxBudget !== undefined) body.maxBudget = options.maxBudget;

  const result = await safeRequestJson<{ sessionId?: string; error?: string }>(
    projectUrl(
      options.monitorUrl,
      `/api/tasks/${encodeURIComponent(task.taskId)}/start`,
      projectId,
    ),
    "POST",
    body,
  );

  if (!result.ok) {
    // Classify headnode direct-start rejection as quack_infra with an actionable message.
    const isDirectBlocked = /direct_dispatch_blocked|direct task dispatch is disabled/i.test(
      result.error ?? "",
    );
    task.lastError = isDirectBlocked
      ? "direct dispatch blocked on headnode; set QUACK_SERVICE_TOKEN and use --federation-dispatch"
      : result.error;
    task.failureClass = isDirectBlocked ? "quack_infra" : classifyFailure(result.error);
    task.status = task.failureClass === "dependency_blocked" ? "blocked" : "failed";
    addEvent(checkpoint, "dispatch_error", `${task.taskId} dispatch failed: ${task.lastError}`, {
      taskId: task.taskId,
      failureClass: task.failureClass,
      errorCode: isDirectBlocked ? "direct_dispatch_blocked" : undefined,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} dispatch failed.`,
      error: task.lastError,
    });
    return;
  }

  task.sessionId = result.value.sessionId;
  task.dispatchMode = "direct";
  task.status = "running";
  checkpoint.dispatchesStarted += 1;
  addEvent(checkpoint, "dispatch_started", `${task.taskId} started`, {
    taskId: task.taskId,
    sessionId: task.sessionId,
  });
  stopHeartbeat();
  await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "completed", {
    taskId: task.taskId,
    detail: `${task.taskId} started in session ${task.sessionId}.`,
  });
}

export interface FederationQueueResponse {
  job?: { jobId?: string; status?: string; assignedHostId?: string; hostId?: string };
  queued?: { jobId?: string; status?: string };
  scheduler?: { assignments?: Array<{ hostId?: string }> };
  error?: string;
}

export async function dispatchTaskViaFederation(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  projectId: string,
  stopHeartbeat: () => void,
  checkpointPath: string,
): Promise<void> {
  const serviceToken = process.env.QUACK_SERVICE_TOKEN;
  if (!serviceToken) {
    task.status = "failed";
    task.failureClass = "quack_infra";
    task.lastError =
      "missing_federation_service_token: set QUACK_SERVICE_TOKEN to use federation dispatch";
    addEvent(
      checkpoint,
      "dispatch_error",
      `${task.taskId} federation dispatch failed: missing service token`,
      {
        taskId: task.taskId,
        failureClass: task.failureClass,
        errorCode: "missing_federation_service_token",
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} federation dispatch failed: missing service token.`,
      error: task.lastError,
    });
    return;
  }

  const body: Record<string, unknown> = {
    taskId: task.taskId,
    jobType: "dispatch",
    requiredCapabilities: ["dispatch"],
    allowLowPreflight: options.allowLowPreflightOnFederationDispatch,
    autoSchedule: true,
  };
  if (options.preferredHostId) body.preferredHostId = options.preferredHostId;

  const result = await safeRequestJsonWithHeaders<FederationQueueResponse>(
    projectUrl(options.monitorUrl, "/v1/federation/queue", projectId),
    "POST",
    body,
    { "X-Quack-Service-Token": serviceToken },
  );

  if (!result.ok) {
    task.lastError = result.error;
    task.failureClass = classifyFailure(result.error);
    task.status = "failed";
    addEvent(
      checkpoint,
      "dispatch_error",
      `${task.taskId} federation dispatch failed: ${result.error}`,
      {
        taskId: task.taskId,
        failureClass: task.failureClass,
      },
    );
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} federation dispatch failed.`,
      error: result.error,
    });
    return;
  }

  const response = result.value;
  const jobId = response.job?.jobId ?? response.queued?.jobId;
  const hostId =
    response.job?.assignedHostId ??
    response.job?.hostId ??
    response.scheduler?.assignments?.[0]?.hostId;
  const jobStatus = response.job?.status ?? response.queued?.status;

  task.dispatchMode = "federation";
  task.federatedJobId = jobId;
  task.federatedHostId = hostId;
  task.status = "running";
  checkpoint.dispatchesStarted += 1;

  addEvent(checkpoint, "federation_dispatch_queued", `${task.taskId} queued via federation`, {
    taskId: task.taskId,
    jobId,
    hostId,
    status: jobStatus,
    preferredHostId: options.preferredHostId,
  });
  stopHeartbeat();
  await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "completed", {
    taskId: task.taskId,
    detail: `${task.taskId} queued in federation job ${jobId ?? "unknown"}.`,
  });
}

async function dispatchTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  projectId: string,
  checkpointPath: string,
): Promise<void> {
  task.dispatchAttempts += 1;
  task.updatedAt = nowIso();
  addEvent(checkpoint, "dispatch_start", `dispatching ${task.taskId}`, { taskId: task.taskId });
  const stopHeartbeat = await startStageHeartbeat(checkpointPath, checkpoint, options, "dispatch", {
    taskId: task.taskId,
    detail: `Dispatching ${task.taskId}.`,
  });
  options.logger(`[overnight] dispatch ${task.taskId}`);

  if (options.dryRun) {
    addEvent(checkpoint, "dry_run", `would dispatch ${task.taskId}`, { taskId: task.taskId });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "dispatch", "completed", {
      taskId: task.taskId,
      detail: `Dry-run dispatch for ${task.taskId}.`,
    });
    return;
  }

  const mode = resolveDispatchMode(options);
  if (mode === "federation") {
    await dispatchTaskViaFederation(
      checkpoint,
      task,
      options,
      projectId,
      stopHeartbeat,
      checkpointPath,
    );
  } else {
    await dispatchTaskDirect(checkpoint, task, options, projectId, stopHeartbeat, checkpointPath);
  }
}

export interface FederatedJobDetail {
  jobId?: string;
  taskId?: string;
  status?: string;
  hostId?: string;
  assignedHostId?: string;
  nextAction?: string;
  verified?: boolean;
  mergeReady?: boolean;
  autoMerged?: boolean;
  workerCompletion?: {
    verified?: boolean;
    verificationVerdict?: string;
    autoMerged?: boolean;
  };
  error?: string;
}

export async function loadFederationJob(
  options: NormalizedOptions,
  projectId: string,
  jobId: string,
): Promise<{ ok: true; value: FederatedJobDetail } | { ok: false; error: string }> {
  const serviceToken = process.env.QUACK_SERVICE_TOKEN ?? "";
  // First try the direct job endpoint.
  const direct = await safeRequestJsonWithHeaders<FederatedJobDetail>(
    projectUrl(options.monitorUrl, `/v1/federation/jobs/${encodeURIComponent(jobId)}`, projectId),
    "GET",
    {},
    serviceToken ? { "X-Quack-Service-Token": serviceToken } : {},
  );
  if (direct.ok) return direct;

  // Fall back to scanning the queue.
  const queue = await safeRequestJsonWithHeaders<{ jobs?: FederatedJobDetail[] }>(
    projectUrl(options.monitorUrl, "/v1/federation/queue", projectId),
    "GET",
    {},
    serviceToken ? { "X-Quack-Service-Token": serviceToken } : {},
  );
  if (!queue.ok) return queue;
  const found = (queue.value.jobs ?? []).find((j) => j.jobId === jobId);
  if (!found) return { ok: false, error: `federation job ${jobId} not found in queue` };
  return { ok: true, value: found };
}

export function isFederationJobVerified(job: FederatedJobDetail): boolean {
  return !!(
    job.verified ||
    job.mergeReady ||
    job.autoMerged ||
    job.workerCompletion?.verified ||
    job.workerCompletion?.autoMerged ||
    job.workerCompletion?.verificationVerdict === "VERIFIED"
  );
}

async function reconcileRunningTasks(
  checkpoint: OvernightRunCheckpoint,
  options: NormalizedOptions,
  checkpointPath: string,
): Promise<void> {
  for (const task of checkpoint.tasks.filter((record) => record.status === "running")) {
    if (task.federatedJobId) {
      await reconcileFederatedTask(checkpoint, task, options, checkpointPath);
    } else {
      await reconcileDirectTask(checkpoint, task, options, checkpointPath);
    }
  }
}

export async function reconcileFederatedTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  checkpointPath: string,
): Promise<void> {
  const jobResult = await loadFederationJob(
    options,
    checkpoint.settings.projectId,
    task.federatedJobId!,
  );
  if (!jobResult.ok) {
    task.lastError = jobResult.error;
    task.failureClass = classifyFailure(jobResult.error);
    addEvent(
      checkpoint,
      "federation_dispatch_progress",
      `${task.taskId} federation job lookup failed: ${jobResult.error}`,
      {
        taskId: task.taskId,
        federatedJobId: task.federatedJobId,
      },
    );
    return;
  }

  const job = jobResult.value;
  const jobStatus = job.status ?? "unknown";
  const hostId = job.assignedHostId ?? job.hostId ?? task.federatedHostId;
  if (hostId && !task.federatedHostId) {
    task.federatedHostId = hostId;
  }

  // Active states — still running, no transition needed.
  if (
    jobStatus === "queued" ||
    jobStatus === "assigned" ||
    jobStatus === "running" ||
    jobStatus === "leased" ||
    jobStatus === "verifying" ||
    jobStatus === "fixing"
  ) {
    addEvent(
      checkpoint,
      "federation_dispatch_progress",
      `${task.taskId} federation job is ${jobStatus}`,
      {
        taskId: task.taskId,
        federatedJobId: task.federatedJobId,
        federatedHostId: hostId,
        jobStatus,
      },
    );
    return;
  }

  // Terminal: completed — require verification/merge evidence.
  if (jobStatus === "completed") {
    if (isFederationJobVerified(job)) {
      if (options.verifyAfterDispatch) {
        await verifyCompletedTask(checkpoint, task, options, checkpointPath);
      } else {
        task.status = "completed";
      }
      addEvent(
        checkpoint,
        "federation_dispatch_completed",
        `${task.taskId} federation job completed`,
        {
          taskId: task.taskId,
          federatedJobId: task.federatedJobId,
          federatedHostId: hostId,
          jobStatus,
        },
      );
    } else {
      // Completed without evidence → manual_review.
      task.status = "manual_review";
      task.lastError = "federation job completed without verified/merge evidence";
      task.failureClass = "task_failure";
      addEvent(
        checkpoint,
        "federation_dispatch_completed",
        `${task.taskId} federation job completed (no evidence)`,
        {
          taskId: task.taskId,
          federatedJobId: task.federatedJobId,
          federatedHostId: hostId,
          jobStatus,
          noEvidence: true,
        },
      );
    }
    return;
  }

  // Terminal: failed.
  if (jobStatus === "failed" || jobStatus === "rejected") {
    task.status = "failed";
    task.lastError = job.error ?? `federation job ${jobStatus}`;
    task.failureClass = classifyFailure(task.lastError);
    addEvent(checkpoint, "federation_dispatch_failed", `${task.taskId} federation job failed`, {
      taskId: task.taskId,
      federatedJobId: task.federatedJobId,
      federatedHostId: hostId,
      jobStatus,
      error: task.lastError,
      failureClass: task.failureClass,
    });
    return;
  }

  // Terminal: blocked.
  if (jobStatus === "blocked") {
    const nextAction = job.nextAction ?? "";
    // TASK-1332 round-4 (R4-2): `manual_handoff` is what the federation route
    // ACTUALLY emits for a blocked job (routes/federation.ts), and matching
    // only `manual_review` dropped it into ordinary dependency-blocked work.
    // `refreshBlockedTasks` then resets any blocked task with no unmet
    // dependencies to `pending_prep`, so an operator-held refusal was
    // AUTO-REDISPATCHED on the next loop. `manual_review` is the operator-held
    // state and it is deliberately not touched by that sweep.
    if (/manual_review|manual_handoff/.test(nextAction)) {
      task.status = "manual_review";
    } else {
      task.status = "blocked";
    }
    task.lastError = `federation job blocked${nextAction ? `: ${nextAction}` : ""}`;
    task.failureClass = "dependency_blocked";
    addEvent(checkpoint, "federation_dispatch_blocked", `${task.taskId} federation job blocked`, {
      taskId: task.taskId,
      federatedJobId: task.federatedJobId,
      federatedHostId: hostId,
      jobStatus,
      nextAction,
    });
    return;
  }

  // Terminal: canceled.
  if (jobStatus === "canceled") {
    task.status = "failed";
    task.lastError = "federation job canceled";
    task.failureClass = "quack_infra";
    addEvent(checkpoint, "federation_dispatch_failed", `${task.taskId} federation job canceled`, {
      taskId: task.taskId,
      federatedJobId: task.federatedJobId,
      federatedHostId: hostId,
      jobStatus,
    });
  }
}

export async function reconcileDirectTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  checkpointPath: string,
): Promise<void> {
  const runs = await safeRequestJson<OvernightSessionEntry[]>(
    projectUrl(
      options.monitorUrl,
      `/api/tasks/${encodeURIComponent(task.taskId)}/runs`,
      checkpoint.settings.projectId,
    ),
    "GET",
  );
  if (!runs.ok) {
    task.lastError = runs.error;
    task.failureClass = classifyFailure(runs.error);
    return;
  }

  const latest = latestSession(runs.value, task.sessionId);
  if (!latest || latest.status === "active") return;

  task.lastOutcome = latest.outcome ?? latest.status;
  task.lastCostUsd = latest.totalCostUsd ?? 0;
  checkpoint.totalCostUsd += latest.totalCostUsd ?? 0;

  if (latest.status === "completed" && latest.outcome === "approved") {
    if (options.verifyAfterDispatch) {
      await verifyCompletedTask(checkpoint, task, options, checkpointPath);
    } else {
      task.status = "completed";
    }
    addEvent(checkpoint, "dispatch_completed", `${task.taskId} approved`, {
      taskId: task.taskId,
      sessionId: latest.sessionId,
      costUsd: latest.totalCostUsd ?? 0,
    });
    return;
  }

  if (latest.outcome === "spec_changed") {
    const events = await safeRequestJson<QuackEvent[]>(
      projectUrl(
        options.monitorUrl,
        `/api/sessions/${encodeURIComponent(latest.sessionId)}/events`,
        checkpoint.settings.projectId,
      ),
      "GET",
    );
    const stale = events.ok
      ? events.value.filter((event) => event.stage === "spec_identity_stale").at(-1)
      : undefined;
    const eventReason = (stale?.payload as { reason?: unknown } | undefined)?.reason;
    const reason =
      typeof eventReason === "string" && eventReason.length > 0 ? eventReason : "spec_changed";
    task.status = "blocked";
    task.lastError = reason;
    task.failureClass = undefined;
    addEvent(checkpoint, "dispatch_blocked", `${task.taskId} requires spec ownership repair`, {
      taskId: task.taskId,
      sessionId: latest.sessionId,
      reason,
      outcome: latest.outcome,
    });
    return;
  }

  const message = latest.outcome ?? latest.status;
  task.status = "failed";
  task.lastError = message;
  task.failureClass = classifyFailure(message);
  addEvent(checkpoint, "dispatch_failed", `${task.taskId} finished with ${message}`, {
    taskId: task.taskId,
    failureClass: task.failureClass,
  });
}

async function verifyCompletedTask(
  checkpoint: OvernightRunCheckpoint,
  task: OvernightTaskRecord,
  options: NormalizedOptions,
  checkpointPath: string,
): Promise<void> {
  const stopHeartbeat = await startStageHeartbeat(checkpointPath, checkpoint, options, "verify", {
    taskId: task.taskId,
    detail: `Verifying ${task.taskId}.`,
  });
  const result = await safeRequestJson<OvernightVerificationResult>(
    projectUrl(
      options.monitorUrl,
      `/api/tasks/${encodeURIComponent(task.taskId)}/verify`,
      checkpoint.settings.projectId,
    ),
    "POST",
    {},
  );
  if (!result.ok) {
    task.status = "failed";
    task.lastError = result.error;
    task.failureClass = classifyFailure(result.error);
    addEvent(checkpoint, "verify_error", `${task.taskId} verify API failed: ${result.error}`, {
      taskId: task.taskId,
      failureClass: task.failureClass,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "verify", "failed", {
      taskId: task.taskId,
      detail: `${task.taskId} verify API failed.`,
      error: result.error,
    });
    return;
  }

  if (result.value.allPassed === true) {
    task.status = "completed";
    task.lastError = undefined;
    task.failureClass = undefined;
    addEvent(checkpoint, "verify_pass", `${task.taskId} verification passed`, {
      taskId: task.taskId,
    });
    stopHeartbeat();
    await updateCurrentStage(checkpointPath, checkpoint, options, "verify", "completed", {
      taskId: task.taskId,
      detail: `${task.taskId} verification passed.`,
    });
    return;
  }

  const failedCommands = [
    ...(result.value.commands ?? []),
    ...(result.value.conventionChecks ?? []),
  ].filter((command) => !command.passed);
  const message =
    failedCommands.length > 0
      ? failedCommands.map((command) => `${command.name}: ${command.output ?? "failed"}`).join("\n")
      : "verification did not pass";
  task.status = "failed";
  task.lastError = message;
  task.failureClass =
    classifyFailure(message) === "quack_infra" ? "quack_infra" : "verification_failed";
  addEvent(checkpoint, "verify_failed", `${task.taskId} verification failed`, {
    taskId: task.taskId,
    failureClass: task.failureClass,
  });
  stopHeartbeat();
  await updateCurrentStage(checkpointPath, checkpoint, options, "verify", "failed", {
    taskId: task.taskId,
    detail: `${task.taskId} verification failed.`,
    error: message,
  });
}

function refreshBlockedTasks(checkpoint: OvernightRunCheckpoint): void {
  const byId = new Map(checkpoint.tasks.map((task) => [task.taskId, task]));
  for (const task of checkpoint.tasks) {
    if (task.status !== "blocked") continue;
    if (task.lastOutcome === "spec_changed") continue;

    const blockedBy = task.blockedBy ?? [];
    if (blockedBy.length === 0) {
      task.status = "pending_prep";
      task.lastError = undefined;
      task.failureClass = undefined;
      addEvent(checkpoint, "dependency_unblocked", `${task.taskId} is no longer blocked`, {
        taskId: task.taskId,
      });
      continue;
    }

    const unmet = blockedBy
      .map(extractTaskId)
      .filter((depId): depId is string => !!depId)
      .filter((depId) => !isDependencySatisfied(depId, byId));
    if (unmet.length === 0) {
      task.status = "pending_prep";
      task.lastError = undefined;
      task.failureClass = undefined;
      addEvent(checkpoint, "dependency_unblocked", `${task.taskId} dependencies are complete`, {
        taskId: task.taskId,
        blockedBy,
      });
    } else {
      task.lastError = `blocked by ${unmet.join(", ")}`;
    }
  }
}

/**
 * The in-run half of the dependency question, over runner lifecycle
 * states rather than task statuses: a dependency counts once it has
 * finished successfully during this run, or was skipped because it was
 * already done before it started.
 *
 * A skip recorded as REJECTED is the one skip that must NOT count, for
 * the same reason `areParsedDependenciesSatisfied` uses
 * `isCompleteStatus`: rejected work satisfies nothing. See
 * `SKIPPED_REJECTED_REASON`.
 */
function isDependencySatisfied(depId: string, byId: Map<string, OvernightTaskRecord>): boolean {
  const dep = byId.get(depId);
  if (dep && countsAsFinishedDependency(dep)) return true;
  const subtasks = [...byId.values()].filter((task) => task.taskId.startsWith(`${depId}-`));
  return subtasks.length > 0 && subtasks.every(countsAsFinishedDependency);
}

function countsAsFinishedDependency(task: OvernightTaskRecord): boolean {
  if (task.status === "completed") return true;
  return task.status === "skipped" && task.lastError !== SKIPPED_REJECTED_REASON;
}

function extractTaskId(raw: string): string | undefined {
  return raw.match(/\bTASK-\d+(?:-[A-Z]+)?\b/)?.[0];
}

function latestSession(
  sessions: OvernightSessionEntry[],
  preferredSessionId?: string,
): OvernightSessionEntry | undefined {
  const matching = preferredSessionId
    ? sessions.filter((session) => session.sessionId === preferredSessionId)
    : sessions;
  return matching.sort((a, b) => b.startTime.localeCompare(a.startTime))[0];
}

function projectUrl(baseUrl: string, pathname: string, projectId: string): string {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("project", projectId);
  return url.toString();
}

async function safeRequestJson<T>(
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await requestJson<T>(url, method, body) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeRequestJsonWithHeaders<T>(
  url: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fetchJson<T>(url, method, body, headers) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchJson<T>(
  url: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<T> {
  const hasBody = method === "POST" || Object.keys(body).length > 0;
  const res = await fetch(url, {
    method,
    headers: hasBody ? { "Content-Type": "application/json", ...headers } : { ...headers },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON response`);
  }
  if (res.ok) return parsed as T;
  const maybeError =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${res.status}`;
  throw new Error(maybeError);
}

function requestJson<T>(
  urlString: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  return requestJsonWithHeaders<T>(urlString, method, body ?? {}, {});
}

function requestJsonWithHeaders<T>(
  urlString: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;
    const transport = url.protocol === "https:" ? https : http;
    const contentHeaders: Record<string, string | number> = data
      ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        }
      : {};
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { ...contentHeaders, ...extraHeaders },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed as T);
            return;
          }
          const maybeError =
            parsed && typeof parsed === "object" && "error" in parsed
              ? String((parsed as { error: unknown }).error)
              : raw;
          reject(new Error(maybeError || `HTTP ${res.statusCode}`));
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err && "stderr" in err) {
      const ex = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(ex.stderr || ex.stdout || ex.message || "git command failed");
    }
    throw err;
  }
}

function addEvent(
  checkpoint: OvernightRunCheckpoint,
  type: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const event: OvernightEvent = {
    timestamp: nowIso(),
    type,
    message,
  };
  if (details) event.details = details;
  const taskId = typeof details?.taskId === "string" ? details.taskId : undefined;
  if (taskId) event.taskId = taskId;
  checkpoint.events.push(event);
  checkpoint.updatedAt = event.timestamp;
}

function halt(
  checkpoint: OvernightRunCheckpoint,
  reason: string,
  details?: Record<string, unknown>,
): void {
  checkpoint.halted = true;
  checkpoint.haltReason = reason;
  addEvent(checkpoint, "halt", reason, details);
}

function defaultCheckpointPath(projectRoot: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(projectRoot, ".quack", "overnight-runs", `${stamp}-overnight-run.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasErrorCode(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}
