// ─── Task Dispatcher ────────────────────────────────────────────────
// Main dispatch pipeline. Orchestrates the full lifecycle of a task:
// gate -> branch -> agent -> judge -> retry/PR
//
// The dispatcher is stateless and idempotent. State lives in git
// branches and task file statuses.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { JobProvenance } from "../monitor/federation/types.js";
import { listDuplicateClaimants, resolveTaskFile } from "../core/task-file-resolver.js";
import { DuplicateClaimantAdmissionError } from "../core/duplicate-claimants.js";
import { hasUnresolvedRepairMarkers } from "../core/spec-normalizer.js";
import type {
  DispatchResult,
  ParsedTask,
  JudgeResult,
  AgentResult,
  FollowUpItem,
  AgentOutputSnapshot,
  ExecutionMode,
} from "../core/types.js";
import { resolveModel, MANUAL_TAGS } from "./model-router.js";
import { runReadinessGate } from "../gate/gate.js";
import { assembleContext } from "./context-assembler.js";
import { generateBlueprint, createMinimalBlueprint } from "../blueprint/blueprint-agent.js";
import { stampBriefFidelity } from "../blueprint/fidelity.js";
import { resolveCachedBlueprint } from "../blueprint/cached-blueprint.js";
import { formatBlueprintForPrompt } from "../blueprint/blueprint-prompt.js";
import {
  createBranch,
  createFeatureBranch,
  cleanupBranch,
  pushBranch,
  abandonBranch,
  hasSealableProgress,
  getBranchCommitCount,
  buildBranchName,
  mergeBranchToTarget,
  updateTaskFileStatus,
  deleteAfterMerge,
} from "./branch-manager.js";
import { safeUnsetCoreWorktree } from "./worktree-cleanup.js";
import { resolveTargetBranch } from "./branch-resolver.js";
import { sealAgentOutputAttempt } from "./output-snapshot.js";
import { runAgent } from "../worker/agent-worker.js";
import { runJudge, type JudgeInput } from "../judge/llm-judge.js";
import { blueprintToChecks } from "../judge/spec-compliance.js";
import { buildPrBodyWithIssueLink, createPullRequest } from "./pr-creator.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { EventWriter, generateSessionId, createNoOpWriter } from "../monitor/event-emitter.js";
import { discoverTranscripts, copyTranscript } from "../monitor/transcript-linker.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { archivePausedRunState, resolvePausedRunState } from "./paused-run-state.js";
import type { PipelineStage } from "./checkpoint-types.js";
import { PrepCache, computeContentHash } from "../monitor/prep-cache.js";
import {
  clearSpecStaleMarker,
  compareResolvedSpecIdentity,
  detectInHandDivergence,
  foundSpecIdentity,
  inHandDivergenceMessage,
  isContestedSpecIdentity,
  mayConsume,
  resolveCurrentSpecIdentity,
  StaleSpecIdentityError,
  writeSpecStaleMarker,
  type SpecIdentity,
  type SpecIdentityComparison,
  type SpecIdentityVerdict,
  type ResolvedSpecIdentity,
} from "../core/spec-identity.js";
import { ReadinessService } from "../monitor/readiness-service.js";
import { analyzeRun } from "../analytics/post-run-analyzer.js";
import { updateAnalytics } from "../analytics/analytics-updater.js";
import {
  syncDispatchStarted,
  syncDispatchComplete,
  syncPRCreated,
} from "../integrations/github/status-syncer.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import type { Blueprint } from "../blueprint/blueprint-types.js";
import { evaluateLoopReview } from "../review/loop-gate.js";
import {
  buildInjectedSignals as buildSnapshotSignals,
  safetyStopRequested as evaluateSnapshotSafetyStop,
} from "../judgment/producers/snapshot-signals.js";
import {
  checkMachineryIntegrity,
  formatIntegrityFeedback,
  readAuthoritativeSafetyFloor,
  resolveAuthoritativeRoot,
} from "../judgment/producers/machinery-integrity.js";
import type { JudgmentSignal } from "../judgment/judgment-types.js";
import type { ResolvedSafetyFloorConfig } from "../judgment/runner/intent-judgment-config.js";
import {
  projectPostJudgeDecision,
  projectPostJudgeErrorDecision,
} from "../judgment/judgment-adapters.js";
import { emitJudgmentProjection } from "../judgment/judgment-events.js";
import { orchestrateJudgment } from "../judgment/judgment-orchestrator.js";
import { buildJudgeIntentRequest } from "../judgment/intent-request.js";
import { createIntentJudgmentRunner } from "../judgment/runner/intent-judgment-runner.js";

function resolveDispatchEventSessionId(taskId: string): string {
  const assigned = process.env.QUACK_DOCKER_EVENT_SESSION_ID;
  if (!assigned) return generateSessionId(taskId);
  const prefix = `quack-${taskId}-`;
  const ownership = assigned.startsWith(prefix) ? assigned.slice(prefix.length) : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownership)
  ) {
    throw new Error("Invalid host-assigned Docker event session identity");
  }
  return assigned;
}

function resolveDockerAdmittedBranch(taskId: string, expectedBranch: string): string {
  const admitted = process.env.QUACK_DOCKER_ADMITTED_BRANCH;
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);
  if (
    !admitted ||
    admitted !== expectedBranch ||
    admitted.startsWith("-") ||
    admitted.startsWith("/") ||
    admitted.endsWith("/") ||
    admitted.endsWith(".") ||
    admitted.endsWith(".lock") ||
    admitted.includes("..") ||
    admitted.includes("@{") ||
    Array.from(admitted).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || forbidden.has(character);
    })
  ) {
    throw new Error(
      `Invalid host-admitted Docker branch for ${taskId}: received ${JSON.stringify(admitted)}, expected ${JSON.stringify(expectedBranch)}`,
    );
  }
  return admitted;
}

// ─── Options ────────────────────────────────────────────────────────

export interface DispatchOptions {
  /** Skip the readiness gate (assume task is ready) */
  skipGate?: boolean;
  /** Skip depth evaluation and enrichment, but still run deterministic gate checks */
  skipDepthOnly?: boolean;
  /** Skip branch creation (use current branch) */
  skipBranch?: boolean;
  /** Skip PR creation after approval */
  skipPr?: boolean;
  /** Dry run mode — do not execute, just validate */
  dryRun?: boolean;
  /** Disable event logging (default: enabled) */
  disableEvents?: boolean;
  /** Callback for every event emitted (used for stream-json output) */
  onEvent?: (stage: string, payload: Record<string, unknown>) => void;
  /** Resume from a previous checkpoint instead of starting fresh */
  resumeFromCheckpoint?: boolean;
  /** Claude session ID to use for agent resume (passed from auto-resume) */
  resumeSessionId?: string;
  /** Parent task ID (for subtasks in a decomposition) */
  parentTaskId?: string;
  /** Shared branch name (for subtasks reusing parent's branch) */
  sharedBranchName?: string;
  /** Judge feedback from a previous rejected run (for force-retry) */
  retryFeedback?: string;
  /** Force clean start: delete existing branch + checkpoint regardless of state */
  forceClean?: boolean;
  /**
   * TASK-1326 (QPI-042): proceed even though this task is paused at a
   * human gate, archiving the paused run's state first. An EXPLICIT
   * operator decision, never inferred.
   */
  overridePausedRun?: boolean;
  /** Federated scheduler job id when a listener dispatches locally. */
  federatedJobId?: string;
  /** Federated worker/listener host id for provenance. */
  federatedHostId?: string;
  /** Human label for the federated worker, if known. */
  federatedHostAlias?: string;
  /** Base URL or endpoint label for the federated worker, if known. */
  federatedHostEndpoint?: string;
  /** Active scheduler lease id, if known. */
  federatedLeaseId?: string;
  /** TASK-1323: how this dispatch entered the system. Spawning monitors
   *  pass it via QUACK_PROVENANCE env; direct callers set it here; a
   *  bare `quack run` defaults to the cli channel. */
  provenance?: JobProvenance;
}

/**
 * TASK-1323: recover the entry provenance a spawning monitor serialized
 * into QUACK_PROVENANCE. Malformed or channel-less JSON is treated as
 * absent (read tolerance — provenance is data, never control flow).
 */
function parseProvenanceFromEnv(): JobProvenance | undefined {
  const raw = process.env.QUACK_PROVENANCE;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.channel === "string" && parsed.channel.length > 0) {
      return parsed as unknown as JobProvenance;
    }
  } catch {
    // fall through to the caller's default
  }
  return undefined;
}

// ─── Main dispatch function ─────────────────────────────────────────

/**
 * Dispatch a single task through the full pipeline:
 * 1. Parse task file
 * 2. Run readiness gate (skip if options.skipGate)
 * 3. Create branch (skip if options.skipBranch)
 * 4. Assemble context
 * 5. Run agent
 * 6. Get git diff and run judge
 * 7. On APPROVE: push branch, create PR
 * 8. On REVISE: feed feedback to agent, retry once, re-judge
 * 9. On REJECT: cleanup branch, return rejection
 *
 * @param taskId - The task identifier (e.g., "TASK-011")
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional dispatch configuration
 * @returns Structured DispatchResult with outcome and details
 */
export async function dispatchTask(
  taskId: string,
  adapter: ProjectAdapter,
  options?: DispatchOptions,
): Promise<DispatchResult> {
  const dockerHostPromotion = process.env.QUACK_DOCKER_HOST_PROMOTION === "1";
  if (dockerHostPromotion) {
    const parentTaskId = process.env.QUACK_DOCKER_PARENT_TASK_ID;
    const sharedBranchName = process.env.QUACK_DOCKER_SHARED_BRANCH;
    options = {
      ...(options ?? {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(sharedBranchName ? { sharedBranchName } : {}),
    };
  }
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const claimants = await listDuplicateClaimants(taskDir, taskId);
  if (claimants.length > 1) {
    throw new DuplicateClaimantAdmissionError({ taskId, claimants });
  }

  const maxRetries = adapter.config.agent.maxRetries;
  const totalBudget = adapter.config.agent.maxBudgetPerTask;
  const startTime = Date.now();

  // Checkpoint manager for stage-level resume
  const checkpointMgr = new CheckpointManager(
    path.resolve(adapter.projectRoot, adapter.config.logging.dir),
  );

  // Create event writer
  const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
  const baseWriter: IEventWriter = options?.disableEvents
    ? createNoOpWriter()
    : new EventWriter({
        sessionId: resolveDispatchEventSessionId(taskId),
        taskId,
        project: adapter.config.project.name,
        logDir,
      });

  // Wrap event writer to also call onEvent callback (for stream-json output)
  const events: IEventWriter = options?.onEvent
    ? {
        sessionId: baseWriter.sessionId,
        taskId: baseWriter.taskId,
        project: baseWriter.project,
        get title() {
          return baseWriter.title;
        },
        set title(v) {
          baseWriter.title = v;
        },
        emit(stage, payload) {
          baseWriter.emit(stage, payload);
          options.onEvent!(stage, payload as Record<string, unknown>);
        },
        recordSession(status, extra) {
          baseWriter.recordSession(status, extra);
        },
      }
    : baseWriter;

  events.recordSession("active");

  // ── Pre-dispatch sanity check: clean any leaked core.worktree ──
  // Defensive guard against state left by prior crashes or kills.
  // safeUnsetCoreWorktree never throws.
  await safeUnsetCoreWorktree(adapter.projectRoot, events);

  // Resolve models early so we can log the initial worker model
  const initialWorkerModel = resolveModel(adapter.config.modelRouting, adapter.config.agent, {
    stage: "worker",
    taskTags: [],
    retryAttempt: 0,
  });
  const federatedJobId = options?.federatedJobId ?? process.env.QUACK_FEDERATED_JOB_ID;
  const federatedHostId = options?.federatedHostId ?? process.env.QUACK_FEDERATED_HOST_ID;
  const federatedHostAlias = options?.federatedHostAlias ?? process.env.QUACK_FEDERATED_HOST_ALIAS;
  const federatedHostEndpoint =
    options?.federatedHostEndpoint ?? process.env.QUACK_FEDERATED_HOST_ENDPOINT;
  const federatedLeaseId = options?.federatedLeaseId ?? process.env.QUACK_FEDERATED_LEASE_ID;
  // TASK-1323: options beat env beat the cli default — a monitor-spawned
  // child carries the server-derived channel; a bare `quack run` is cli.
  const provenance: JobProvenance = options?.provenance ??
    parseProvenanceFromEnv() ?? { channel: "cli", principal: "local-cli" };

  events.emit("session_start", {
    model: initialWorkerModel,
    maxTurns: adapter.config.agent.maxTurns,
    maxBudget: adapter.config.agent.maxBudgetPerTask,
    taskId,
    jobId: federatedJobId,
    hostId: federatedHostId,
    hostAlias: federatedHostAlias,
    hostEndpoint: federatedHostEndpoint,
    federated: Boolean(federatedJobId || federatedHostId),
    ...(federatedLeaseId ? { leaseId: federatedLeaseId } : {}),
    provenance,
  });

  // Track metrics for analytics
  let gateDepthScore = 0;
  let blueprintFileAnalyses = 0;
  let blueprintCodeExamples = 0;
  const outputSnapshots: AgentOutputSnapshot[] = [];

  // Capture gate depth score from events
  const originalEmit = events.emit.bind(events);
  type EventEmitFn = typeof events.emit;
  events.emit = ((stage, payload) => {
    if (stage === "gate_depth" && typeof payload === "object" && payload !== null) {
      gateDepthScore = (payload as { overallScore?: number }).overallScore ?? 0;
    }
    if (stage === "blueprint_generated" && typeof payload === "object" && payload !== null) {
      const bp = payload as { fileAnalyses?: number; codeExamples?: number };
      blueprintFileAnalyses = bp.fileAnalyses ?? 0;
      blueprintCodeExamples = bp.codeExamples ?? 0;
    }
    return originalEmit(stage, payload);
  }) as EventEmitFn;

  try {
    // ── Load checkpoint (if resuming) ──────────────────────────
    const existingCheckpoint = options?.resumeFromCheckpoint
      ? await checkpointMgr.load(taskId)
      : null;
    const completedStages = new Set<PipelineStage>(existingCheckpoint?.completedStages ?? []);
    const resumeSessionId = options?.resumeSessionId ?? existingCheckpoint?.claudeSessionId;

    if (existingCheckpoint) {
      if (existingCheckpoint.outputSnapshots) {
        outputSnapshots.push(...existingCheckpoint.outputSnapshots);
      }
      events.emit("checkpoint_loaded", {
        taskId,
        completedStages: existingCheckpoint.completedStages,
        resumeFromStage: checkpointMgr.getResumeStage(existingCheckpoint),
      });
    }

    // ── Step 1: Parse the task file ──────────────────────────────
    const loadedTask = await loadTaskWithPath(taskId, adapter);
    let task = loadedTask.task;
    const taskSpecRelativePath = path
      .relative(adapter.projectRoot, loadedTask.specPath)
      .split(path.sep)
      .join("/");
    events.title = task.title;

    // ── TASK-1332 / QPI-045 ────────────────────────────────────────
    // The identity of the spec any artifact saved by this run was built
    // from. Read from the OWNING clone on every call, never cached and
    // never taken from `task.rawContent`:
    //
    //  - `task.rawContent` on a resumed run comes from the REUSED
    //    dispatch worktree, cut from origin/<base> before any later
    //    amendment, so hashing it compares a stale brief against a
    //    stale spec and reports "match" (round 1, R1-1).
    //  - readiness enrichment replaces `task` in memory only, so the
    //    in-memory content would report "stale" for a task nobody
    //    amended.
    //
    // Not cached, because a gate can sit open for hours and noticing
    // the file move underneath it is the entire point. `undefined` is
    // an honest UNKNOWN and is never read as either verdict.
    //
    // Round 5 (R5-2): the SOURCE is captured HERE, once, before readiness
    // enrichment can replace `task` in memory further down. Passing the
    // live `task.rawContent` at stamp time was the defect: after an
    // enrichment the stamp compared authoritative SOURCE against ENRICHED
    // DERIVATION, differed by construction, and every enriched dispatch
    // was born `diverged` and refused at its next consumption, with
    // advice telling the operator to push an amendment that never
    // existed. Divergence is a question about SOURCE. What the brief was
    // actually synthesized from is recorded separately and decides
    // nothing.
    const inHandSourceContent = task.rawContent;
    const currentSpecResolution = (): ResolvedSpecIdentity =>
      resolveCurrentSpecIdentity(
        adapter.projectRoot,
        adapter.config.project.taskDir,
        taskId,
        inHandSourceContent,
        task.rawContent !== inHandSourceContent ? task.rawContent : undefined,
      );
    // ── TASK-1332 round-5 (R5-6): ONE refusal exit, used by all three sites ──
    // A spec-identity refusal is a deliberate, recoverable stop, and every
    // site that performs one has to report it identically or the control
    // plane learns a different story depending on where it fired.
    //
    // It deliberately does NOT emit `session_error`. That emit was the
    // remaining half of R3-1: the federation boundary was taught to read the
    // refusal as `blocked`/`pending_manual_handoff`, while locally the event
    // watcher wrote an ERROR row from the `session_error`, and the session
    // APIs prefer the DB row over the session log's `spec_changed`. So the
    // one control plane the operator actually looks at kept calling a
    // deliberate refusal a crash, QPI-041's mistake about a pause, one
    // task later, in the surface that was supposed to have fixed it.
    const refuseForSpecIdentity = (args: {
      surface: string;
      stage: string;
      verdict: SpecIdentityVerdict;
      reason: string;
      message: string;
    }): DispatchResult => {
      writeSpecStaleMarker(logDir, {
        taskId,
        surface: args.surface,
        verdict: args.verdict,
        reason: args.reason,
        refusedAt: new Date().toISOString(),
      });
      events.emit("spec_identity_stale", {
        taskId,
        stage: args.stage,
        verdict: args.verdict,
        reason: args.reason,
        recoverable: true,
      });
      // Round 6 (R6-2): the TERMINAL signal, through the channel every
      // consumer already handles. Dropping `session_error` in round 5
      // removed the crash misreport and, with it, the only terminal event
      // these runs emitted, so `ProgressDetector` kept the task and could
      // later raise a stuck-warning or a kill for a run that had already
      // deliberately stopped, the dashboard left it visibly active until
      // reload, and the workflow projector never left its previous state.
      //
      // `gate_failed` is the established precedent for exactly this shape:
      // a deliberate, non-crash, terminal stop reports
      // `session_complete` with its own outcome. Reusing it means the DB
      // row, the tracker cleanup (velocity, heartbeat, progress watcher)
      // and the dashboard transition all come from the path that already
      // does them, instead of a second bespoke handler that has to be
      // kept in sync. `spec_changed` matches neither the `approved` nor
      // the `rejected`/`agent_failed` status branch, so no task status is
      // written from here; the restore is the watcher's job (R3-6).
      events.emit("session_complete", {
        outcome: "spec_changed",
        durationMs: Date.now() - startTime,
        totalCostUsd: 0,
      });
      events.recordSession("completed", {
        outcome: "spec_changed",
        durationMs: Date.now() - startTime,
      });
      return {
        taskId,
        outcome: "spec_changed" as const,
        retriesUsed: 0,
        error: args.message,
      };
    };
    const identityForApprovalSave = (
      surface: string,
      stage: "approve" | "judge_review" = "approve",
    ): { identity: SpecIdentity | undefined } | { refusal: DispatchResult } => {
      const resolution = currentSpecResolution();
      if (!isContestedSpecIdentity(resolution)) {
        return { identity: foundSpecIdentity(resolution) };
      }
      const comparison: SpecIdentityComparison = {
        verdict: "contested",
        reason: resolution.reason,
      };
      return {
        refusal: refuseForSpecIdentity({
          surface,
          stage,
          verdict: "contested",
          reason: resolution.reason,
          message: new StaleSpecIdentityError(taskId, surface, comparison).message,
        }),
      };
    };

    // ── TASK-1332 round-3 (R3-2): refuse a wrong-source run BEFORE spending ──
    // Deliberately here: after the task is loaded, before the readiness gate
    // and before enrichment replaces `task` in memory (which would itself look
    // like divergence). `resolveCurrentSpecIdentity` is called WITHOUT the
    // in-hand content so it returns pure authority to compare against.
    //
    // Without this, a worktree cut from origin/<base> before an amendment
    // builds a brief from the old contract, gets stamped from the owning clone
    // at the new one, is born `diverged`, and refuses at every consumption. The
    // advertised replan regenerates from the same worktree and reproduces it,
    // so the recovery loops. Catching it at the source names the real cause and
    // costs nothing rather than a full gate-plus-blueprint spend.
    {
      const authoritativeResolution = resolveCurrentSpecIdentity(
        adapter.projectRoot,
        adapter.config.project.taskDir,
        taskId,
      );
      if (isContestedSpecIdentity(authoritativeResolution)) {
        const comparison: SpecIdentityComparison = {
          verdict: "contested",
          reason: authoritativeResolution.reason,
        };
        const message = new StaleSpecIdentityError(taskId, "pre-gate source check", comparison)
          .message;
        return refuseForSpecIdentity({
          surface: "pre-gate source check",
          stage: "pre_gate",
          verdict: "contested",
          reason: authoritativeResolution.reason,
          message,
        });
      }
      const authoritative = foundSpecIdentity(authoritativeResolution);
      // `inHandSourceContent`, not `task.rawContent`: identical here today
      // because enrichment has not run yet, but stating the invariant means
      // a later reordering cannot silently turn this into the R5-2 defect.
      const divergence = detectInHandDivergence(inHandSourceContent, authoritative);
      if (divergence) {
        const message = inHandDivergenceMessage(taskId, divergence, {
          ...(authoritative?.taskSpecRelativePath
            ? { taskSpecRelativePath: authoritative.taskSpecRelativePath }
            : {}),
        });
        return refuseForSpecIdentity({
          surface: "pre-gate source check",
          stage: "pre_gate",
          verdict: "diverged",
          reason: message,
          message,
        });
      }
    }

    const effectiveExecutionMode: ExecutionMode =
      task.executionMode ?? adapter.config.executionMode ?? "dispatch";
    const loopConfig = effectiveExecutionMode === "loop" ? adapter.config.loop : undefined;

    if (effectiveExecutionMode === "loop" && !loopConfig) {
      const reason = "Effective execution mode is loop, but the adapter has no loop configuration";
      events.emit("session_error", { error: reason, failedStage: "execution_mode" });
      events.recordSession("error");
      return {
        taskId,
        outcome: "error",
        retriesUsed: 0,
        error: reason,
      };
    }

    // ── Step 1a1: paused-run guard (TASK-1326 / QPI-042) ──────────
    // The second seam. The monitor's guard protects the branch and
    // worktree before they are destroyed; this one protects the
    // CHECKPOINT and the operator's wallet, and it is the ONLY guard on
    // the direct paths (`quack run`, any programmatic dispatchTask).
    //
    // It sits here, before the gate, deliberately: the pre-existing
    // stale-pend early returns live BELOW the blueprint stage, so a
    // re-encounter already paid for a fresh gate + blueprint (4-5
    // minutes and real money) before pausing again — the exact waste
    // chain QPI-042 records four times over. Unlike those returns this
    // one is not loop-only, which is what closes the dispatch-mode
    // pending-record overwrite.
    //
    // Re-saving the pend is not optional bookkeeping: the monitor
    // classifies a non-zero exit as awaiting_approval only when the
    // pending record was created during THIS dispatch (QPI-043), so a
    // refusal that skipped the re-save would read as a silent death.
    // Round-2 F1: resumeFromCheckpoint does NOT bypass either — see the
    // DispatchManager twin. A resume whose gate is still pending is the
    // clobber path, not the approve path.
    if (!options?.overridePausedRun) {
      const paused = resolvePausedRunState(logDir, taskId);
      if (paused) {
        const pendingOutcome =
          paused.gate === "judge"
            ? ("awaiting_judge_approval" as const)
            : ("awaiting_approval" as const);
        const reason =
          `Task is paused at the ${paused.gate} gate (opened ${paused.createdAt}); ` +
          `this dispatch stopped before re-running the gate rather than overwrite it`;
        if (paused.gate === "judge") {
          const { loadJudgeApproval, resavePendingJudgeApproval } =
            await import("./judge-approval.js");
          const existing = await loadJudgeApproval(taskId, logDir);
          if (existing) await resavePendingJudgeApproval(existing, logDir);
          events.emit("judge_pending_approval", {
            taskId,
            filesChanged: existing
              ? existing.filesModified.length + existing.filesCreated.length
              : 0,
            diffLines: existing ? existing.diff.split("\n").length : 0,
            reason,
          });
        } else {
          const { loadApproval, resavePendingApproval } = await import("./blueprint-approval.js");
          const existing = await loadApproval(taskId, logDir);
          if (existing) await resavePendingApproval(existing, logDir);
          events.emit("blueprint_pending_approval", {
            taskId,
            autoApproveAttempted: false,
            reason,
          });
        }
        events.recordSession("completed", {
          outcome: pendingOutcome,
          durationMs: Date.now() - startTime,
        });
        return {
          taskId,
          outcome: pendingOutcome,
          retriesUsed: 0,
          error: reason,
        };
      }
    } else if (options?.overridePausedRun) {
      // Fail-closed: an override that cannot archive does not proceed.
      const paused = resolvePausedRunState(logDir, taskId);
      if (paused) {
        const archived = archivePausedRunState(adapter.projectRoot, logDir, taskId, paused);
        events.emit("paused_run_archived", {
          taskId,
          gate: paused.gate,
          pendOpenedAt: paused.createdAt,
          ...archived,
        });
      }
    }

    // ── Step 1a2: Safety-floor wiring (TASK-1313) ─────────────────
    // Config is read from the AUTHORITATIVE root, never the worktree
    // copy (round-1 F7): a worktree tamper must not be able to disable
    // the checks that would catch it. Absent config = all off.
    const dispatchAuthoritativeRoot = resolveAuthoritativeRoot(adapter.projectRoot);
    const safetyFloorConfig: ResolvedSafetyFloorConfig =
      await readAuthoritativeSafetyFloor(dispatchAuthoritativeRoot);

    // Resume-time machinery validation (TASK-1313 S4): a resumed
    // dispatch reuses a worktree whose policy files the prior session's
    // agent could have modified.
    // Round-2 F4: keyed on the WORKTREE CONTEXT, never on checkpoint
    // parseability — an unreadable checkpoint or a reused worktree
    // without resume state must not disarm the check. Fresh worktrees
    // are clean by construction, so validating every worktree dispatch
    // closes every reuse path.
    if (
      safetyFloorConfig.resumeValidationMode !== "off" &&
      dispatchAuthoritativeRoot !== adapter.projectRoot
    ) {
      const resumeIntegrity = await checkMachineryIntegrity(
        adapter.projectRoot,
        dispatchAuthoritativeRoot,
      );
      if (!resumeIntegrity.clean) {
        const feedback = formatIntegrityFeedback(resumeIntegrity);
        events.emit("safety_fact", {
          taskId,
          origin: "resume_validation",
          facts: [],
          integrityMismatches: resumeIntegrity.mismatches,
        });
        if (safetyFloorConfig.resumeValidationMode === "enforce") {
          events.emit("session_error", {
            error: `Resume blocked by machinery integrity: ${feedback}`,
            failedStage: "safety_floor",
          });
          events.recordSession("error");
          return {
            taskId,
            outcome: "safety_stop",
            retriesUsed: existingCheckpoint?.retriesUsed ?? 0,
            error: feedback,
          };
        }
      }
    }

    // Round-2 F2 (narrow): a standing enforce-mode integrity failure in
    // the worker's LAST verification converts to safety_stop before the
    // pipeline seals or judges on tampered machinery.
    const integrityFailureStanding = (verification: AgentResult["verification"]): boolean =>
      safetyFloorConfig.preVerificationIntegrityMode === "enforce" &&
      verification !== null &&
      verification.commands.some(
        (command) => command.name === "machinery-integrity" && !command.passed,
      );

    // TASK-1313 S2/S4 helpers (round-2 F10: bodies live in
    // judgment/producers/snapshot-signals.ts so checkpoint re-derivation
    // is testable directly; these wrappers bind the resolved mode).
    const buildInjectedSignals = (
      stage: "loop_diff" | "judge",
      snapshot: AgentOutputSnapshot,
      workerFacts: AgentResult["safetyFacts"],
    ): Promise<JudgmentSignal[]> =>
      buildSnapshotSignals(stage, snapshot, workerFacts, safetyFloorConfig.signalsMode);
    const safetyStopRequested = (
      decision: { action: string } | undefined,
      injected: JudgmentSignal[],
    ): boolean => evaluateSnapshotSafetyStop(decision, injected, safetyFloorConfig.signalsMode);

    // ── Step 1b: Manual tag guard ─────────────────────────────────
    const manualTag = task.tags.find((t) => MANUAL_TAGS.includes(t.toLowerCase()));
    if (manualTag) {
      const reason = `Task has "${manualTag}" tag — requires a manual/interactive session, not automated dispatch`;
      events.emit("dispatch_rejected", { taskId, reason, tag: manualTag });
      events.recordSession("error");
      return {
        taskId,
        outcome: "rejected",
        retriesUsed: 0,
        error: reason,
      };
    }

    // ── Step 1c: Unresolved repair-placeholder guard ─────────────────
    // Auto-repaired specs carrying defaults/TBD placeholders are tracked
    // but never dispatchable (deliberately unaffected by skipGate); a human
    // must resolve every placeholder first. See core/spec-normalizer.ts.
    if (hasUnresolvedRepairMarkers(task.rawContent)) {
      const reason =
        "Task spec contains unresolved repair placeholders (auto-repair inserted defaults/TBDs); the submitter must fill and confirm them before dispatch";
      events.emit("dispatch_rejected", { taskId, reason });
      events.recordSession("error");
      return {
        taskId,
        outcome: "rejected",
        retriesUsed: 0,
        error: reason,
      };
    }

    // ── Step 2: Readiness gate ──────────────────────────────────
    if (completedStages.has("gate")) {
      events.emit("stage_skipped", {
        taskId,
        stage: "gate",
        reason: "completed in previous checkpoint",
      });
    }

    // Auto-skip gate when cached preflight score is high enough
    let gateAutoSkipped = false;
    if (!options?.skipGate && !completedStages.has("gate")) {
      const preflightPrepCache = new PrepCache(adapter.projectRoot);
      try {
        // TASK-1332 round-10 (R10-2): use the spec path THIS RUN resolved,
        // not a reconstructed `${taskId}.md`. Most specs in this repo are
        // named descriptively, so the reconstructed path usually does not
        // exist and this silently fell back to `task.rawContent`, and
        // where a bare `TASK-NNN.md` DID exist alongside the real spec, it
        // hashed the wrong file. Same wrong-file class the pre-gate check
        // exists to catch, inside the dispatcher itself.
        let taskContent: string;
        try {
          taskContent = await fs.readFile(loadedTask.specPath, "utf-8");
        } catch {
          taskContent = task.rawContent;
        }
        const preflightHash = computeContentHash(taskContent);
        // TASK-1315 (round-1b F2): the gate-skip is an AUTHORITY read —
        // a readiness-mode flip must force a live gate run.
        const preflightForGate = await preflightPrepCache.readPreflight(
          taskId,
          preflightHash,
          adapter.config.judgment?.stages.readiness.mode ?? "off",
        );
        // TASK-1315 r2-F1: score alone is not authority — the cached
        // gate must have actually RUN, been ready, and not carry a
        // (possibly intent-confirmed) rejected active outcome.
        if (
          preflightForGate &&
          preflightForGate.gate.score >= 4.5 &&
          preflightForGate.gate.ready === true &&
          preflightForGate.gate.gateSkipped !== true &&
          preflightForGate.gate.activeOutcome !== "rejected"
        ) {
          gateAutoSkipped = true;
          gateDepthScore = preflightForGate.gate.score;
          events.emit("stage_skipped", {
            taskId,
            stage: "gate",
            reason: `Gate skipped: preflight score ${preflightForGate.gate.score} >= 4.5 threshold`,
          });
        }
      } catch {
        // Cache read failed — proceed with normal gate
      }
    }

    if (!options?.skipGate && !completedStages.has("gate") && !gateAutoSkipped) {
      const gateResult = await runReadinessGate(
        task,
        adapter,
        {
          skipDepthOnly: options?.skipDepthOnly,
          allowEnrichmentFailureFallback: true,
        },
        events,
      );

      if (gateResult.outcome === "rejected") {
        events.emit("session_complete", {
          outcome: "gate_failed",
          durationMs: Date.now() - startTime,
          totalCostUsd: 0,
        });
        events.recordSession("completed", {
          outcome: "gate_failed",
          durationMs: Date.now() - startTime,
        });
        return {
          taskId,
          outcome: "gate_failed",
          gateResult,
          retriesUsed: 0,
          error: `Readiness gate rejected: ${gateResult.reason}`,
        };
      }

      // Auto-approve enriched specs and use the enriched content for dispatch.
      // The enrichment agent is read-only and only adds detail/specificity —
      // it cannot change the task's intent or scope.
      if (gateResult.outcome === "enriched") {
        let readiness: ReadinessService | null = null;
        try {
          readiness = new ReadinessService({
            projectRoot: adapter.projectRoot,
          });
          readiness.persistEffectiveSpec({
            taskId,
            baseSpecContent: gateResult.task.original.rawContent,
            effectiveContent: gateResult.task.enriched.rawContent,
            status: "accepted",
            source: "dispatch_auto_enrich",
          });
        } catch {
          // Effective-spec persistence is best-effort during dispatch.
        } finally {
          readiness?.close();
        }
        task = gateResult.task.enriched;
        events.emit("gate_result", {
          outcome: "enriched_auto_approved",
          originalScore: gateDepthScore,
        });
      }
    }

    // Save gate checkpoint
    if (!completedStages.has("gate")) {
      await checkpointMgr.markStageComplete(taskId, "gate", {
        sessionId: events.sessionId,
        startedAt: new Date(startTime).toISOString(),
        parentTaskId: options?.parentTaskId,
      });
      events.emit("checkpoint_saved", {
        taskId,
        stage: "gate",
        completedStages: ["gate"],
      });
    }

    // ── Step 2.5: Generate blueprint (or use cached preflight) ────
    let blueprint: {
      fileAnalyses: unknown[];
      codeExamples: unknown[];
      verificationPatterns: unknown[];
      antiPatterns: unknown[];
    } = {
      fileAnalyses: [],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: [],
    };
    let blueprintMarkdown = "";
    let usedCachedBlueprint = false;
    const prepCache = new PrepCache(adapter.projectRoot);

    // A resumed approval/revision must use the exact Brief that was reviewed.
    // Loop approval persistence is the durable copy for completed blueprint
    // checkpoints, so restore it before consulting cache or an LLM.
    let staleBriefRefusal: { message: string; comparison: SpecIdentityComparison } | undefined;
    if (completedStages.has("blueprint")) {
      try {
        const { loadApproval } = await import("./blueprint-approval.js");
        const savedApproval = await loadApproval(taskId, logDir);
        if (savedApproval?.blueprint) {
          // ── TASK-1332 / QPI-045: the damage seam ──────────────────
          // THIS is where a stale brief becomes executed work, not the
          // approve click. The blueprint checkpoint is marked before
          // the gate, so every gate-paused run reaches here on resume,
          // and restoring wins over the cache/generation path below.
          // The TASK-1324 fidelity verdict travels with the restored
          // brief reading `passed` against the spec it was audited on,
          // so the one machine check for brief-versus-spec agreement is
          // bypassed by exactly this mechanism.
          //
          // Refuse, do not repair: nothing here deletes the record or
          // writes `rejected`. TASK-1326 hardened this seam against
          // destruction and a `rejected` write would additionally wedge
          // the task behind a replan. UNKNOWN proceeds, deliberately —
          // treating unstamped records as stale would strand every pend
          // alive on the deploy that ships this.
          const comparison = compareResolvedSpecIdentity(
            savedApproval.specIdentity,
            currentSpecResolution(),
            // R5-3: the record itself, so "no stamp" can be told apart
            // from "no stamp AND written before stamping existed".
            savedApproval,
          );
          // Round 2 (R2-1/R2-2): only `match` and `unknown_legacy` may
          // proceed. The first cut let every non-`stale` verdict through,
          // so a DELETED or unreadable owner spec admitted the worktree's
          // stale brief, and an artifact built from a different spec than
          // the one stamped on it was certified current. `mayConsume` is
          // the single predicate so a new verdict cannot default to open.
          if (!mayConsume(comparison.verdict)) {
            staleBriefRefusal = {
              message: new StaleSpecIdentityError(taskId, "blueprint resume", comparison).message,
              comparison,
            };
          } else {
            blueprint = savedApproval.blueprint;
            blueprintMarkdown = formatBlueprintForPrompt(savedApproval.blueprint);
            usedCachedBlueprint = true;
            events.emit("stage_skipped", {
              taskId,
              stage: "blueprint",
              reason:
                comparison.verdict === "unknown_legacy"
                  ? `reviewed Brief restored from approval checkpoint (spec identity UNKNOWN, pre-1332 record: ${comparison.reason})`
                  : comparison.operationalOnlyChange
                    ? "reviewed Brief restored from approval checkpoint (spec contract unchanged; only the Status line moved)"
                    : "reviewed Brief restored from approval checkpoint",
            });
          }
        }
      } catch {
        // Fall through to the normal cache/generation path for legacy records.
      }
    }

    // Outside the try, so a refusal cannot be swallowed by the
    // legacy-record catch above and silently fall through to
    // regenerating the very brief we just refused to trust.
    if (staleBriefRefusal) {
      // Round 2 (R2-5): a refusal is NOT a crash, and reporting it as one
      // repeats QPI-041's mistake about a pause. It gets its own outcome,
      // its own event, and a DURABLE marker so the monitor can classify a
      // non-zero child exit from disk rather than from a lifecycle
      // callback (QPI-043: an SSE-only signal is not a signal).
      return refuseForSpecIdentity({
        surface: "blueprint resume",
        stage: "blueprint",
        verdict: staleBriefRefusal.comparison.verdict,
        reason: staleBriefRefusal.comparison.reason,
        message: staleBriefRefusal.message,
      });
    }
    // Got past the check: an older refusal must never explain this run.
    clearSpecStaleMarker(logDir, taskId);

    // Check for cached preflight result to skip blueprint generation.
    // TASK-1306: when the cache carries a persisted `structured` blueprint,
    // rehydrate the REAL object so the approval gate evaluates real counts,
    // the approval file shows humans the real plan, and blueprint-derived
    // judge checks survive the cache hit. Legacy caches (no `structured`)
    // keep the old empty-stub behavior exactly.
    if (!usedCachedBlueprint) {
      try {
        const taskContent = task.rawContent;
        const contentHash = computeContentHash(taskContent);
        const cachedPreflight = await prepCache.readPreflight(taskId, contentHash);

        const resolved = resolveCachedBlueprint(cachedPreflight);
        if (resolved) {
          blueprintMarkdown = resolved.blueprintMarkdown;
          blueprint = resolved.blueprint;
          usedCachedBlueprint = true;
          events.emit("blueprint_generated", {
            taskId,
            fileAnalyses: cachedPreflight!.blueprint.fileAnalyses,
            codeExamples: cachedPreflight!.blueprint.codeExamples,
            verificationPatterns: cachedPreflight!.blueprint.verificationPatterns,
            antiPatterns: cachedPreflight!.blueprint.antiPatterns,
            cached: true,
            structured: resolved.structured,
          });
        }
      } catch {
        // Cache read failed — fall through to normal generation
      }
    }

    if (!usedCachedBlueprint) {
      // TASK-833: inline blueprint generation is a silent up-to-10-min LLM
      // call. Without dedicated stage events operators cannot distinguish
      // "blueprint still working" from "dispatch hung," and the dispatcher
      // used to block here until the old 600_000 ms outer timeout fired.
      // We now emit a blueprint_start event up front, fire a soft warning
      // at WARNING_MS, and fall back to createMinimalBlueprint at
      // TIMEOUT_MS so the session still reaches branch/worktree creation.
      const WARNING_MS = Number(process.env.QUACK_BLUEPRINT_WARNING_MS) || 120_000;
      const TIMEOUT_MS = Number(process.env.QUACK_BLUEPRINT_TIMEOUT_MS) || 300_000;
      const blueprintStartedAt = Date.now();

      events.emit("blueprint_start", {
        taskId,
        cached: false,
        mode: effectiveExecutionMode,
        warningMs: WARNING_MS,
        timeoutMs: TIMEOUT_MS,
      });

      const warningTimer: NodeJS.Timeout = setTimeout(() => {
        events.emit("blueprint_warning", {
          taskId,
          reason: "inline_blueprint_slow",
          // Timer callbacks can run a millisecond before Date.now() reflects the
          // requested delay on some platforms. A warning event must never report
          // an elapsed duration below the threshold that caused it.
          elapsedMs: Math.max(WARNING_MS, Date.now() - blueprintStartedAt),
        });
      }, WARNING_MS);
      // Don't keep the event loop alive purely for timer bookkeeping —
      // matches the .unref() convention used elsewhere for server-side
      // setInterval/setTimeout (CLAUDE.md "Timer .unref() pattern").
      if (typeof warningTimer.unref === "function") warningTimer.unref();

      type TimeoutSentinel = { __blueprintTimeout: true };
      const timeoutSentinel: TimeoutSentinel = { __blueprintTimeout: true };
      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<TimeoutSentinel>((resolve) => {
        timeoutTimer = setTimeout(() => resolve(timeoutSentinel), TIMEOUT_MS);
        if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
      });

      const raceResult = await Promise.race([
        generateBlueprint(
          task,
          adapter,
          loopConfig?.models?.investigate ? { model: loopConfig.models.investigate } : undefined,
        ),
        timeoutPromise,
      ]);

      clearTimeout(warningTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);

      let freshBlueprint: Awaited<ReturnType<typeof generateBlueprint>>;
      if ((raceResult as TimeoutSentinel).__blueprintTimeout) {
        // TASK-1324: this stub is minted OUTSIDE generateBlueprint's
        // fidelity seam, so it stamps its own audit — which marks the
        // empty shape fidelity: failed instead of letting a timeout
        // launder into an approvable brief.
        freshBlueprint = stampBriefFidelity(createMinimalBlueprint(taskId), adapter.projectRoot);
        events.emit("blueprint_fallback", {
          taskId,
          reason: "dispatch_timeout_minimal_blueprint",
          elapsedMs: Date.now() - blueprintStartedAt,
        });
      } else {
        freshBlueprint = raceResult as Awaited<ReturnType<typeof generateBlueprint>>;
      }

      blueprint = freshBlueprint;
      blueprintMarkdown = formatBlueprintForPrompt(freshBlueprint);
      events.emit("blueprint_generated", {
        taskId,
        fileAnalyses: freshBlueprint.fileAnalyses.length,
        codeExamples: freshBlueprint.codeExamples.length,
        verificationPatterns: freshBlueprint.verificationPatterns.length,
        antiPatterns: freshBlueprint.antiPatterns.length,
        cached: false,
      });
    }

    // Save blueprint checkpoint
    if (!completedStages.has("blueprint")) {
      await checkpointMgr.markStageComplete(taskId, "blueprint", {});
      events.emit("checkpoint_saved", {
        taskId,
        stage: "blueprint",
        completedStages: [...completedStages, "blueprint"],
      });
    }

    // ── Step 2.6: Blueprint approval gate ──────────────────────
    const blueprintApprovalConfig = adapter.config.preflight?.blueprintApproval;
    const blueprintGateEnabled =
      effectiveExecutionMode === "loop" || blueprintApprovalConfig?.enabled === true;
    if (blueprintGateEnabled && !options?.dryRun && !completedStages.has("approve")) {
      const {
        evaluateAutoApprove,
        saveBlueprintApproval,
        savePendingApproval,
        loadApproval,
        isApprovalExpired,
        updateApprovalState,
        DEFAULT_APPROVAL_TIMEOUT_MS,
      } = await import("./blueprint-approval.js");

      // Check if a human already approved this blueprint (resume after approval)
      const existingApproval = await loadApproval(taskId, logDir);

      // Check for expired pending approvals — auto-reject if timed out
      if (existingApproval?.state === "pending") {
        const timeoutMs = blueprintApprovalConfig?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
        if (isApprovalExpired(existingApproval, timeoutMs)) {
          await updateApprovalState(taskId, "rejected", logDir, undefined, "Approval timed out");
          events.emit("blueprint_rejected", {
            taskId,
            rejectionReason: "Approval timed out",
          });
          return {
            taskId,
            outcome: "error" as const,
            retriesUsed: 0,
            error: "Blueprint approval timed out. Re-run preflight to generate a new blueprint.",
          };
        }
        if (effectiveExecutionMode === "loop") {
          // ── QPI-043 ROOT CAUSE ────────────────────────────────────
          // This early-return was silent four ways at once: no fresh
          // approval save (createdAt stayed at the ORIGINAL pend), no
          // blueprint_pending_approval emit, no session record, and the
          // CLI's final result print is discarded by process.exit when
          // stdout is a POSIX pipe. The monitor's recency check
          // (isGateApprovalPending: createdAt >= job.startedAt) then
          // classified the exit as FAILED — a run that was waiting for
          // a human read as a vanished child. Five TASK-1273 dispatches
          // died exactly here, each re-billing gate + blueprint first.
          //
          // Re-save the pending record with its evidence preserved: the
          // fresh createdAt is what lets the monitor classify THIS exit
          // as awaiting_approval. Deliberate side effect: each
          // re-encounter restarts the 24h expiry — a re-dispatch is
          // evidence an operator is still driving the task.
          const { resavePendingApproval } = await import("./blueprint-approval.js");
          await resavePendingApproval(existingApproval, logDir);
          events.emit("blueprint_pending_approval", {
            taskId,
            autoApproveAttempted: false,
            reason: `Blueprint approval has been pending since ${existingApproval.createdAt}; this fresh dispatch re-encountered it and is pausing again`,
          });
          events.recordSession("completed", {
            outcome: "awaiting_approval",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "awaiting_approval" as const,
            retriesUsed: 0,
            error: "Awaiting blueprint approval",
          };
        }
      }

      const existingApprovalCarriesLoopEvidence =
        existingApproval?.executionMode === "loop" &&
        existingApproval.review !== undefined &&
        existingApproval.reviewGate !== undefined;
      if (
        (existingApproval?.state === "approved" || existingApproval?.state === "auto-approved") &&
        (effectiveExecutionMode === "dispatch" || existingApprovalCarriesLoopEvidence)
      ) {
        // ── TASK-1332 round-5 (R5-1): the SECOND consumption seam ──────
        // The restore check above only runs when the blueprint checkpoint
        // is present, i.e. on a RESUME. This branch is reached on a FRESH
        // dispatch, where a brand-new brief has just been generated from
        // the current spec while the previous run's approval record is
        // still live in the shared `.quack/logs`. Without this check that
        // old record authorizes the new brief and the human gate is
        // skipped entirely.
        //
        // Round 4's own recovery advice walks an operator straight into
        // it: "push the amended spec, then start a FRESH dispatch" does
        // terminate the refusal loop, but it terminated it by BYPASSING
        // the gate. A fix for QPI-045 that quietly launders one approval
        // onto a different brief is the defect it was written to close.
        //
        // Same rules as the restore seam: refuse, never repair. `stale`
        // is the expected verdict here (the brief is fresh, the approval
        // is not), and its existing advice, replan, which deletes the
        // record, is the correct and already-working cure.
        const approvalComparison = compareResolvedSpecIdentity(
          existingApproval.specIdentity,
          currentSpecResolution(),
          existingApproval,
        );
        if (!mayConsume(approvalComparison.verdict)) {
          return refuseForSpecIdentity({
            surface: "blueprint approval reuse",
            stage: "approve",
            verdict: approvalComparison.verdict,
            reason: approvalComparison.reason,
            message: new StaleSpecIdentityError(
              taskId,
              "blueprint approval reuse",
              approvalComparison,
            ).message,
          });
        }
        // Already approved — mark checkpoint and skip
        await checkpointMgr.markStageComplete(taskId, "approve", {});
        events.emit("stage_skipped", {
          taskId,
          stage: "approve",
          reason: "blueprint already approved",
        });
      } else if (existingApproval?.state === "rejected") {
        // Blueprint was rejected — do not proceed
        events.emit("session_error", {
          error: `Blueprint was rejected: ${existingApproval.rejectionReason ?? "No reason provided"}`,
          stage: "approve",
        });
        return {
          taskId,
          outcome: "error" as const,
          retriesUsed: 0,
          error: `Blueprint was rejected. Run preflight again to generate a new blueprint.`,
        };
      } else {
        const autoApproveRules =
          effectiveExecutionMode === "loop"
            ? loopConfig?.briefReview.autoApproveWhen
            : blueprintApprovalConfig?.autoApproveWhen;

        // Load preflight result if available
        let preflightResult: PreflightResult | undefined;
        try {
          const taskContent = task.rawContent;
          const contentHash = computeContentHash(taskContent);
          const cachedPreflight = await prepCache.readPreflight(taskId, contentHash);
          preflightResult = cachedPreflight ?? undefined;
        } catch {
          // No preflight result available
        }

        let loopReview: Awaited<ReturnType<typeof evaluateLoopReview>> | undefined;
        if (effectiveExecutionMode === "loop" && loopConfig) {
          loopReview = await evaluateLoopReview(
            loopConfig.briefReview.reviewer,
            loopConfig.briefReview.requireCrossModel,
            {
              kind: "brief",
              taskId,
              taskSpec: task.rawContent,
              artifact: blueprintMarkdown,
              constraints: [
                ...((blueprint as Blueprint).constraints ?? []),
                adapter.conventionsDoc.slice(0, 4_000),
              ]
                .filter(Boolean)
                .join("\n"),
              projectRoot: adapter.projectRoot,
            },
            undefined,
            [],
            // TASK-1316: the brief-gate intent cutover.
            {
              mode: adapter.config.judgment?.stages?.loopBrief?.mode ?? "off",
              runnerConfig: adapter.config.judgment?.runner,
            },
            // TASK-1324: the brief's pipeline-stamped fidelity audit
            // joins the gate facts (brief gate only).
            (blueprint as Blueprint).fidelity,
          );
        }

        const thresholdsPass =
          autoApproveRules !== undefined &&
          evaluateAutoApprove(blueprint as Blueprint, preflightResult, autoApproveRules);
        const shouldAutoApprove =
          effectiveExecutionMode === "loop"
            ? loopReview?.reviewGate.eligibleForAutoApproval === true && thresholdsPass
            : thresholdsPass;

        if (loopReview) {
          const nextState = shouldAutoApprove ? "auto-approved" : "pending";
          const approvalIdentity = identityForApprovalSave("loop blueprint approval save");
          if ("refusal" in approvalIdentity) return approvalIdentity.refusal;
          await saveBlueprintApproval(
            taskId,
            blueprint as Blueprint,
            preflightResult,
            logDir,
            nextState,
            {
              review: loopReview.result,
              reviewedAt: new Date().toISOString(),
              reviewGate: loopReview.reviewGate,
            },
            approvalIdentity.identity,
          );
          events.emit("loop_brief_review", {
            taskId,
            executionMode: "loop",
            reviewKind: "brief",
            runnerKind: loopReview.runnerKind,
            result: loopReview.result,
            reviewGate: loopReview.reviewGate,
            nextState,
          });
          if (loopReview.judgmentDecision) {
            events.emit("judgment_decision", {
              taskId,
              stage: "loop_brief",
              sequence: 0,
              final: true,
              decision: loopReview.judgmentDecision,
            });
          } else if (loopReview.judgmentProjectionFailure) {
            events.emit("judgment_projection_failed", {
              taskId,
              stage: "loop_brief",
              ...loopReview.judgmentProjectionFailure,
            });
          }
          // TASK-1316: evaluation rides ATTEMPTED orchestrations only.
          if (loopReview.judgmentOrchestration?.attempted) {
            events.emit("judgment_evaluation", {
              taskId,
              stage: "loop_brief",
              sequence: 0,
              final: false,
              orchestration: loopReview.judgmentOrchestration,
            });
          }
        }

        if (shouldAutoApprove) {
          // Auto-approved — mark checkpoint and continue
          await checkpointMgr.markStageComplete(taskId, "approve", {});
          events.emit("checkpoint_saved", {
            taskId,
            stage: "approve",
            completedStages: [...completedStages, "blueprint", "approve"],
          });
        } else {
          // Needs human approval - save pending state and pause
          if (!loopReview) {
            const approvalIdentity = identityForApprovalSave("pending blueprint approval save");
            if ("refusal" in approvalIdentity) return approvalIdentity.refusal;
            await savePendingApproval(
              taskId,
              blueprint as Blueprint,
              preflightResult,
              logDir,
              approvalIdentity.identity,
            );
          }
          // TASK-1324: name the fidelity failure when it is the refusal
          // cause — "complexity exceeds thresholds" would be a lie.
          const fidelityFailed = (blueprint as Blueprint).fidelity?.status === "failed";
          const fidelitySummary = fidelityFailed
            ? ((blueprint as Blueprint).fidelity?.violations ?? [])
                .slice(0, 3)
                .map((v) => v.detail)
                .join("; ")
            : "";
          events.emit("blueprint_pending_approval", {
            taskId,
            autoApproveAttempted: true,
            reason: loopReview
              ? loopReview.reviewGate.reasons.join("; ") ||
                "Loop auto-approval rules are absent or thresholds failed"
              : fidelityFailed
                ? `Brief failed the deterministic fidelity audit${fidelitySummary ? `: ${fidelitySummary}` : ""}`
                : "Task complexity exceeds auto-approve thresholds",
          });
          events.recordSession("completed", {
            outcome: "awaiting_approval",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "awaiting_approval" as const,
            retriesUsed: 0,
            error: "Awaiting blueprint approval",
          };
        }
      }
    } else if (completedStages.has("approve")) {
      events.emit("stage_skipped", {
        taskId,
        stage: "approve",
        reason: "completed in previous checkpoint",
      });
    }

    // ── Dry run exits here ──────────────────────────────────────
    if (options?.dryRun) {
      events.emit("session_complete", {
        outcome: "dry_run",
        durationMs: Date.now() - startTime,
        totalCostUsd: 0,
      });
      events.recordSession("completed", {
        outcome: "dry_run",
        durationMs: Date.now() - startTime,
      });
      return {
        taskId,
        outcome: "approved",
        retriesUsed: 0,
      };
    }

    // ── Step 2.9: Create parent feature branch (for subtask chains) ──
    let featureBranch: string | undefined;
    if (options?.parentTaskId && !options?.sharedBranchName) {
      const fbResult = await createFeatureBranch(options.parentTaskId, adapter);
      if (fbResult.success) {
        featureBranch = fbResult.branchName;
      } else {
        events.emit("session_error", {
          error: fbResult.error ?? "Feature branch creation failed",
          failedStage: "branch",
        });
        events.recordSession("error", {
          outcome: "error",
          durationMs: Date.now() - startTime,
        });
        return {
          taskId,
          outcome: "error",
          retriesUsed: 0,
          error: fbResult.error ?? "Feature branch creation failed",
        };
      }
    }

    const resolvedBranchTarget = resolveTargetBranch(taskId, task.targetBranch, adapter.config.git);
    const dispatchBaseBranch = featureBranch ?? resolvedBranchTarget.baseBranch;
    const mergeTargetBranch = featureBranch ?? resolvedBranchTarget.autoMergeTarget;
    const branchCreateOptions = featureBranch
      ? { fromBranch: featureBranch }
      : { baseBranch: dispatchBaseBranch };
    events.emit("branch_target_resolved", {
      taskId,
      dispatchBaseBranch,
      mergeTargetBranch,
      branchGroup: resolvedBranchTarget.groupName ?? null,
      explicitTargetBranch: task.targetBranch ?? null,
    });

    // ── Step 3: Create branch (branch-aware) ───────────────────
    let branchName: string | undefined = existingCheckpoint?.branchName;
    if (completedStages.has("branch")) {
      events.emit("stage_skipped", {
        taskId,
        stage: "branch",
        reason: "completed in previous checkpoint",
      });
    }
    // Docker receives one host-admitted private ref and no authoritative Git
    // metadata. Do not run ordinary checkout/fetch/delete logic in that child.
    if (dockerHostPromotion) {
      const expectedBranch = options?.sharedBranchName ?? buildBranchName(taskId, adapter);
      branchName = resolveDockerAdmittedBranch(taskId, expectedBranch);
      if (!completedStages.has("branch")) {
        await checkpointMgr.markStageComplete(taskId, "branch", { branchName });
      }
      events.emit("stage_skipped", {
        taskId,
        stage: "branch",
        reason: "using host-admitted Docker private branch",
      });
    }
    // Use shared branch if provided (for subtasks sharing a worktree)
    else if (options?.sharedBranchName) {
      branchName = options.sharedBranchName;
      // Ensure we're on the shared branch and have the latest commits
      // from prior subtasks. This is critical for context continuity:
      // subtask B must see files committed by subtask A.
      await ensureSharedBranchCheckout(branchName, adapter, events);
      events.emit("stage_skipped", {
        taskId,
        stage: "branch",
        reason: "using shared branch from parent task",
      });
    } else if (!options?.skipBranch && !completedStages.has("branch")) {
      const { execSync } = await import("node:child_process");
      const expectedBranchName = buildBranchName(taskId, adapter);

      // Check if branch already exists
      let branchExists = false;
      try {
        execSync(`git rev-parse --verify ${expectedBranchName}`, {
          cwd: adapter.projectRoot,
          stdio: "pipe",
        });
        branchExists = true;
      } catch {
        // Branch doesn't exist - normal case
      }

      if (branchExists) {
        // Decide action based on checkpoint + branch state
        if (options?.forceClean) {
          // Explicit clean start: delete branch + checkpoint
          await cleanupBranch(taskId, adapter, events);
          await checkpointMgr.delete(taskId);
          events.emit("branch_cleaned", { branchName: expectedBranchName, reason: "force_clean" });

          // Create fresh branch
          const branchResult = await createBranch(taskId, adapter, branchCreateOptions, events);
          if (!branchResult.success) {
            events.emit("session_error", {
              error: branchResult.error ?? "Branch creation failed after clean",
              failedStage: "branch_created",
            });
            events.recordSession("error", {
              outcome: "error",
              durationMs: Date.now() - startTime,
            });
            return {
              taskId,
              outcome: "error",
              retriesUsed: 0,
              error: branchResult.error ?? "Branch creation failed after clean",
            };
          }
          branchName = branchResult.branchName;
          events.emit("branch_created", { branchName });
        } else if (existingCheckpoint && checkpointMgr.isUsable(existingCheckpoint, maxRetries)) {
          // Resume path: checkpoint with incomplete stages or retry path
          if (existingCheckpoint.judgeResult?.verdict === "REVISE") {
            // Retry path: checkout branch and inject judge feedback
            execSync(`git checkout ${expectedBranchName}`, {
              cwd: adapter.projectRoot,
              stdio: "pipe",
            });
            branchName = expectedBranchName;
            events.emit("branch_resumed", { branchName, reason: "retry_after_revise" });
            // Note: Judge feedback injection is handled later via existingCheckpoint.judgeResult
          } else {
            // Resume from incomplete stages
            execSync(`git checkout ${expectedBranchName}`, {
              cwd: adapter.projectRoot,
              stdio: "pipe",
            });
            branchName = expectedBranchName;
            events.emit("branch_resumed", { branchName, reason: "incomplete_checkpoint" });
          }
        } else if (!existingCheckpoint) {
          // Reuse path: no checkpoint but branch exists - reuse from agent stage
          execSync(`git checkout ${expectedBranchName}`, {
            cwd: adapter.projectRoot,
            stdio: "pipe",
          });
          branchName = expectedBranchName;
          events.emit("branch_reused", { branchName, reason: "no_checkpoint" });
        } else {
          // Clean start: checkpoint is unusable (REJECT verdict, stale, or corrupted)
          await cleanupBranch(taskId, adapter, events);
          await checkpointMgr.delete(taskId);
          events.emit("branch_cleaned", {
            branchName: expectedBranchName,
            reason: "unusable_checkpoint",
          });

          // Create fresh branch
          const branchResult = await createBranch(taskId, adapter, branchCreateOptions, events);
          if (!branchResult.success) {
            events.emit("session_error", {
              error: branchResult.error ?? "Branch creation failed after cleanup",
              failedStage: "branch_created",
            });
            events.recordSession("error", {
              outcome: "error",
              durationMs: Date.now() - startTime,
            });
            return {
              taskId,
              outcome: "error",
              retriesUsed: 0,
              error: branchResult.error ?? "Branch creation failed after cleanup",
            };
          }
          branchName = branchResult.branchName;
          events.emit("branch_created", { branchName });
        }

        // Save checkpoint for resumed/reused branches
        if (
          !options?.forceClean &&
          ((existingCheckpoint && checkpointMgr.isUsable(existingCheckpoint, maxRetries)) ||
            !existingCheckpoint)
        ) {
          await checkpointMgr.markStageComplete(taskId, "branch", {
            branchName,
          });
        } else if (
          options?.forceClean ||
          (existingCheckpoint && !checkpointMgr.isUsable(existingCheckpoint, maxRetries))
        ) {
          // Fresh checkpoint for cleaned branches
          await checkpointMgr.markStageComplete(taskId, "branch", {
            branchName,
          });
        }
      } else {
        // Normal case: branch doesn't exist, create it
        const branchResult = await createBranch(taskId, adapter, branchCreateOptions, events);
        if (!branchResult.success) {
          events.emit("session_error", {
            error: branchResult.error ?? "Branch creation failed",
            failedStage: "branch_created",
          });
          events.recordSession("error", {
            outcome: "error",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "error",
            retriesUsed: 0,
            error: branchResult.error ?? "Branch creation failed",
          };
        }
        branchName = branchResult.branchName;
        events.emit("branch_created", { branchName });

        await checkpointMgr.markStageComplete(taskId, "branch", {
          branchName,
        });
      }
    }

    // ── Step 3.5: Capture test baseline ─────────────────────────
    const smartTestConfig = adapter.config.verification.smartTesting;
    if (smartTestConfig?.enabled && smartTestConfig.baselineEnabled) {
      try {
        events.emit("test_baseline_start", { taskId });
        const { captureBaseline } = await import("../testing/test-baseline.js");
        const workDir = adapter.projectRoot;
        const baseline = captureBaseline(
          workDir,
          dispatchBaseBranch,
          smartTestConfig.outputDir,
          taskId,
          120_000,
        );
        events.emit("test_baseline_complete", {
          taskId,
          totalTests: baseline.totalTests,
          failedTests: baseline.failed,
          cachedPath: `${smartTestConfig.outputDir}/${taskId}-baseline.json`,
        });
      } catch (err) {
        // Non-blocking: proceed without baseline
        const msg = err instanceof Error ? err.message : String(err);
        events.emit("session_error", {
          error: `Baseline capture failed (non-fatal): ${msg}`,
          failedStage: "test_baseline",
        });
      }
    }

    // ── Step 3.6: Docker warm-up ─────────────────────────────────
    // Warm up Docker services when any verification command has docker.warmUp: true.
    // Non-blocking: emit warning and continue if Docker is unavailable.
    const dockerWarmupCmds = adapter.config.verification.commands.filter(
      (c) => c.environment === "docker" && c.docker?.warmUp,
    );
    if (dockerWarmupCmds.length > 0) {
      try {
        const { isDockerAvailable: checkDocker, warmUp: dockerWarmUp } =
          await import("../testing/docker-test-runner.js");
        if (checkDocker()) {
          // Group by compose file
          const byComposeFile = new Map<string, { dependsOn: string[]; workDir: string }>();
          for (const cmd of dockerWarmupCmds) {
            if (!cmd.docker) continue;
            const key = cmd.docker.composeFile;
            const existing = byComposeFile.get(key) ?? {
              dependsOn: [],
              workDir: adapter.projectRoot,
            };
            existing.dependsOn.push(...(cmd.docker.dependsOn ?? []));
            byComposeFile.set(key, existing);
          }

          for (const [composeFile, { dependsOn, workDir }] of byComposeFile) {
            const uniqueServices = [...new Set(dependsOn)];
            const warmupStart = Date.now();
            events.emit("docker_warmup_start", {
              taskId,
              composeFile,
              services: uniqueServices,
            });
            dockerWarmUp(composeFile, uniqueServices, workDir, 120_000);
            events.emit("docker_warmup_complete", {
              taskId,
              composeFile,
              services: uniqueServices,
              durationMs: Date.now() - warmupStart,
            });
          }
        } else {
          events.emit("session_error", {
            error: "Docker unavailable: skipping Docker warm-up (will fall back to host commands)",
            failedStage: "docker_warmup",
          });
        }
      } catch (warmupErr) {
        // Non-blocking: Docker warm-up failure does not abort dispatch
        const msg = warmupErr instanceof Error ? warmupErr.message : String(warmupErr);
        events.emit("session_error", {
          error: `Docker warm-up failed (non-fatal): ${msg}`,
          failedStage: "docker_warmup",
        });
      }
    }

    // ── Step 4: Assemble context ────────────────────────────────
    const context = await assembleContext(task, adapter, blueprintMarkdown);
    context.taskSpecPath = taskSpecRelativePath;

    // ── Step 4b: Inject progress file on resume ─────────────────
    if (options?.resumeFromCheckpoint && branchName) {
      const { ProgressWatcher } = await import("./progress-watcher.js");
      const worktreePath = adapter.projectRoot;
      const progress = ProgressWatcher.readProgress(worktreePath);
      if (progress) {
        context.taskSpec += `\n\n---\n\n## Previous Session Progress\n\n${progress.rawContent}`;
        events.emit("agent_progress_update", progress);
      }
    }
    // Attach blueprint verification patterns for pre-judge compliance checks.
    // TASK-1306: whenever real patterns exist — fresh generation OR a
    // rehydrated structured cache. A legacy cache stub has zero patterns and
    // attaches nothing (unchanged behavior).
    if (blueprint.verificationPatterns.length > 0) {
      context.blueprintPatterns =
        blueprint.verificationPatterns as import("../core/types.js").VerificationPattern[];
    }

    // ── Step 4a-patterns: Always-on pattern extraction ──────────
    // Deterministic, <2s, zero LLM cost. Extracts codebase conventions
    // (exports, naming, wrappers, error patterns) from filesToModify.
    // Previously gated behind enrichment; now runs unconditionally.
    try {
      const { extractPatterns, formatPatternsForPrompt } =
        await import("../gate/pattern-extractor.js");
      const patternResult = await extractPatterns(task, adapter.projectRoot);
      const hasPatterns =
        patternResult.patterns.length > 0 || patternResult.siblingPatterns.length > 0;
      if (hasPatterns) {
        context.codebasePatterns = formatPatternsForPrompt(patternResult);
      }
    } catch {
      // Non-fatal: pattern extraction failure doesn't block dispatch
    }

    events.emit("context_assembled", {
      conventionsCount: Object.keys(context.conventions).length,
      relevantFilesCount: context.relevantFiles.length,
      relatedPatternsCount: context.relatedPatterns.length,
      existingTestsCount: context.existingTests.length,
      claudeMdCount: context.claudeMd.length,
    });

    // Emit context size breakdown for observability
    if (context.contextSizeEstimate) {
      events.emit("context_size", {
        taskSpec: context.contextSizeEstimate.taskSpec,
        blueprint: context.contextSizeEstimate.blueprint,
        repoMap: context.contextSizeEstimate.repoMap,
        relevantFiles: context.contextSizeEstimate.relevantFiles,
        relatedPatterns: context.contextSizeEstimate.relatedPatterns,
        existingTests: context.contextSizeEstimate.existingTests,
        conventions: context.contextSizeEstimate.conventions,
        claudeMd: context.contextSizeEstimate.claudeMd,
        total: context.contextSizeEstimate.total,
        withinBudget: context.contextSizeEstimate.withinBudget,
      });
    }

    // ── Step 4c: Inject retry feedback if provided (force-retry) ──
    if (options?.retryFeedback) {
      context.taskSpec += `\n\n---\n\n## REVISION REQUIRED (from previous attempt)\n\nA previous agent attempt was reviewed by the judge and found deficient. You MUST address the following feedback. The branch already contains the prior attempt's code — review it, fix the issues, and ensure all criteria pass.\n\n${options.retryFeedback}\n`;
    }

    // ── Step 4d: Inject fresh GitHub issue comments if mapped ──
    if (adapter.config.integrations?.github) {
      try {
        const { refreshIssueComments } = await import("../integrations/github/import-pipeline.js");
        const freshComments = await refreshIssueComments(taskId, adapter);
        if (freshComments) {
          context.taskSpec += `\n\n---\n\n${freshComments}`;
        }
      } catch {
        // Non-fatal: skip comment refresh if it fails
      }
    }

    // ── Step 5: Run agent ───────────────────────────────────────
    const workerModel =
      loopConfig?.models?.build ??
      resolveModel(adapter.config.modelRouting, adapter.config.agent, {
        stage: "worker",
        taskTags: task.tags,
        retryAttempt: 0,
      });
    const agentRunStart = Date.now();

    // Sync dispatch started to GitHub if configured
    if (adapter.config.integrations?.github?.reportBack) {
      await syncDispatchStarted(
        taskId,
        workerModel,
        totalBudget > 0 ? totalBudget : undefined,
        adapter.config,
      ).catch((err) => {
        // Non-fatal: log but don't block dispatch
        console.error(`GitHub sync (dispatch_started) failed: ${err}`);
      });
    }

    let agentResult: AgentResult;
    if (completedStages.has("agent") && existingCheckpoint?.agentResult) {
      agentResult = existingCheckpoint.agentResult;
      events.emit("stage_skipped", {
        taskId,
        stage: "agent",
        reason: "completed in previous checkpoint",
      });
    } else {
      // If resuming an incomplete worker stage with a session ID, resume it.
      agentResult = await runAgent(
        taskId,
        context,
        adapter,
        {
          model: workerModel,
          ...(totalBudget > 0 ? { maxBudgetUsd: totalBudget } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
        },
        events,
      );
      await linkTranscripts(taskId, adapter, events, agentRunStart, 0);

      // Save checkpoint with session ID regardless of outcome
      await checkpointMgr.markStageComplete(taskId, "agent", {
        agentResult,
        claudeSessionId: agentResult.claudeSessionId,
        totalCostUsd: agentResult.totalCostUsd,
      });
    }

    if (agentResult.outcome !== "success") {
      // ── Auto-resume on recoverable errors ──────────────────────
      // If the agent hit budget_exceeded or timeout, check if there are
      // commits on the branch and remaining budget. If so, resume the
      // session instead of failing — this does NOT count as a retry.
      const isRecoverable =
        agentResult.outcome === "budget_exceeded" ||
        agentResult.outcome === "timeout" ||
        // TASK-1314: turn exhaustion is the most resumable class — a
        // resumed session gets a fresh maxTurns allotment.
        agentResult.outcome === "max_turns";
      const hasSessionId = !!agentResult.claudeSessionId;
      const remainingBudget = totalBudget > 0 ? totalBudget - agentResult.totalCostUsd : 0;
      const hasRemainingBudget = remainingBudget > 0.5;

      if (isRecoverable && hasSessionId && hasRemainingBudget) {
        // TASK-1314: workers cannot commit (git floor + read-only MCP
        // git; the sealer commits post-worker), so progress = committed
        // branch diff OR sealable dirty work per the sealer's own
        // status classification.
        const progressed = await hasSealableProgress(adapter, dispatchBaseBranch);
        if (progressed) {
          events.emit("agent_resume", {
            taskId,
            reason: agentResult.outcome,
            claudeSessionId: agentResult.claudeSessionId!,
            remainingBudgetUsd: remainingBudget,
          });

          // Resume the agent session with remaining budget
          const resumeStart = Date.now();
          agentResult = await runAgent(
            taskId,
            context,
            adapter,
            {
              model: workerModel,
              maxBudgetUsd: remainingBudget,
              resumeSessionId: agentResult.claudeSessionId,
            },
            events,
          );
          await linkTranscripts(taskId, adapter, events, resumeStart, 0);

          // Update checkpoint with new result
          await checkpointMgr.markStageComplete(taskId, "agent", {
            agentResult,
            claudeSessionId: agentResult.claudeSessionId,
            totalCostUsd: agentResult.totalCostUsd,
          });
        }
      }

      // If still not successful after resume attempt, fail
      if (agentResult.outcome !== "success") {
        if (branchName) {
          // TASK-1314: a dirty tree can block the abandon checkout —
          // surface the failure instead of ignoring it.
          const abandonResult = await abandonBranch(taskId, adapter);
          if (!abandonResult.success) {
            console.warn(
              `[dispatch] abandonBranch failed for ${taskId}: ${abandonResult.error ?? "unknown"}`,
            );
            events.emit("session_error", {
              error: `abandonBranch failed: ${abandonResult.error ?? "unknown"}`,
              failedStage: "abandon_branch",
            });
          }
        }
        events.emit("session_complete", {
          outcome: "agent_failed",
          durationMs: Date.now() - startTime,
          totalCostUsd: agentResult.totalCostUsd,
        });
        events.recordSession("completed", {
          outcome: "agent_failed",
          totalCostUsd: agentResult.totalCostUsd,
          durationMs: Date.now() - startTime,
          turnsUsed: agentResult.turnsUsed,
        });
        return {
          taskId,
          outcome: "agent_failed",
          branchName,
          agentResult,
          retriesUsed: 0,
          error: agentResult.error ?? `Agent failed with outcome: ${agentResult.outcome}`,
        };
      }
    }

    // ── Step 6: Get diff (auto-commit if agent forgot) ─────────
    // Round-2 F2: a standing enforce-mode machinery-integrity failure
    // ends the dispatch here — nothing seals or judges on tampered
    // verification machinery.
    if (integrityFailureStanding(agentResult.verification)) {
      const stopReason =
        "Safety floor stop: machinery integrity failed in enforce mode and was not restored";
      events.emit("session_error", { error: stopReason, failedStage: "safety_floor" });
      events.recordSession("error");
      return {
        taskId,
        outcome: "safety_stop",
        branchName,
        agentResult,
        retriesUsed: existingCheckpoint?.retriesUsed ?? 0,
        error: stopReason,
        outputSnapshots,
      };
    }

    let outputSnapshot: AgentOutputSnapshot;
    let gitDiff: string;
    const preservedSnapshot = outputSnapshots.at(-1);
    if (completedStages.has("commit") && existingCheckpoint?.gitDiff && preservedSnapshot) {
      outputSnapshot = preservedSnapshot;
      gitDiff = existingCheckpoint.gitDiff;
      events.emit("stage_skipped", {
        taskId,
        stage: "commit",
        reason: "sealed output restored from previous checkpoint",
      });
    } else {
      outputSnapshot = await sealAgentOutputAttempt({
        taskId,
        adapter,
        events,
        attempt: 1,
        kind: "worker",
        diffBase: dispatchBaseBranch,
        branchName,
        claudeSessionId: agentResult.claudeSessionId,
      });
      outputSnapshots.push(outputSnapshot);
      gitDiff = outputSnapshot.gitDiff;
      await checkpointMgr.markStageComplete(taskId, "commit", {
        gitDiff,
        outputSnapshots,
      });
    }
    if (gitDiff.trim().length === 0) {
      if (branchName) {
        await abandonBranch(taskId, adapter);
      }
      events.emit("session_complete", {
        outcome: "no_changes",
        durationMs: Date.now() - startTime,
        totalCostUsd: agentResult.totalCostUsd,
      });
      events.recordSession("completed", {
        outcome: "no_changes",
        totalCostUsd: agentResult.totalCostUsd,
        durationMs: Date.now() - startTime,
        turnsUsed: agentResult.turnsUsed,
      });
      return {
        taskId,
        outcome: "no_changes",
        branchName,
        agentResult,
        retriesUsed: 0,
        error: "Agent produced no committed changes",
        outputSnapshots,
      };
    }

    // ── Step 6.5: Judge review gate ──────────────────────────
    const judgeApprovalConfig = adapter.config.preflight?.judgeApproval;
    const judgeReviewGateEnabled =
      effectiveExecutionMode === "loop" || judgeApprovalConfig?.enabled === true;
    if (judgeReviewGateEnabled && !options?.dryRun && !completedStages.has("judge_review")) {
      const {
        evaluateJudgeAutoApprove,
        saveJudgeApproval,
        savePendingJudgeApproval,
        loadJudgeApproval,
        isApprovalExpired,
        updateJudgeApprovalState,
        DEFAULT_APPROVAL_TIMEOUT_MS,
      } = await import("./judge-approval.js");

      // Check if a human already approved this judge review (resume after approval)
      const existingApproval = await loadJudgeApproval(taskId, logDir);

      // Check for expired pending approvals — auto-reject if timed out
      if (existingApproval?.state === "pending") {
        const timeoutMs = judgeApprovalConfig?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
        if (isApprovalExpired(existingApproval, timeoutMs)) {
          await updateJudgeApprovalState(
            taskId,
            "rejected",
            logDir,
            undefined,
            "Approval timed out",
          );
          events.emit("judge_rejected", {
            taskId,
            rejectionReason: "Approval timed out",
          });
          return {
            taskId,
            outcome: "error" as const,
            retriesUsed: 0,
            error: "Judge review approval timed out. Re-run dispatch to generate new changes.",
          };
        }
        if (effectiveExecutionMode === "loop") {
          // QPI-043 twin of the blueprint-gate stale-pend early-return:
          // same four silences, same monitor misclassification. Re-save
          // with evidence AND the persisted intent hold preserved —
          // dropping the TASK-1316 JudgeIntentHold here would break its
          // release mechanism. filesChanged is reconstructed in the raw
          // prefixed form saveJudgeApproval re-splits.
          const { resavePendingJudgeApproval } = await import("./judge-approval.js");
          await resavePendingJudgeApproval(existingApproval, logDir);
          events.emit("judge_pending_approval", {
            taskId,
            filesChanged:
              existingApproval.filesModified.length + existingApproval.filesCreated.length,
            diffLines: existingApproval.diff.split("\n").length,
            reason: `Judge approval has been pending since ${existingApproval.createdAt}; this fresh dispatch re-encountered it and is pausing again`,
          });
          events.recordSession("completed", {
            outcome: "awaiting_judge_approval",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "awaiting_judge_approval" as const,
            retriesUsed: 0,
            outputSnapshots,
          };
        }
      }

      const existingApprovalCarriesLoopEvidence =
        existingApproval?.executionMode === "loop" &&
        existingApproval.review !== undefined &&
        existingApproval.reviewGate !== undefined;
      if (
        (existingApproval?.state === "approved" || existingApproval?.state === "auto-approved") &&
        (effectiveExecutionMode === "dispatch" || existingApprovalCarriesLoopEvidence)
      ) {
        // Already approved — mark checkpoint and skip
        await checkpointMgr.markStageComplete(taskId, "judge_review", {});
        events.emit("stage_skipped", {
          taskId,
          stage: "judge_review",
          reason: "judge review already approved",
        });
      } else if (existingApproval?.state === "rejected") {
        // Judge review was rejected — do not proceed (retry is triggered by the reject API endpoint)
        events.emit("session_error", {
          error: `Judge review was rejected: ${existingApproval.rejectionReason ?? "No reason provided"}`,
          stage: "judge_review",
        });
        return {
          taskId,
          outcome: "error" as const,
          retriesUsed: 0,
          error: `Judge review was rejected. Use the dashboard reject button to re-dispatch agent with feedback.`,
        };
      } else {
        const filesChanged = outputSnapshot.changedFiles;
        const verificationPassed = agentResult.verification?.allPassed ?? false;
        const autoApproveRules =
          effectiveExecutionMode === "loop"
            ? loopConfig?.diffReview.autoApproveWhen
            : judgeApprovalConfig?.autoApproveWhen;

        let loopReview: Awaited<ReturnType<typeof evaluateLoopReview>> | undefined;
        const loopInjectedSignals = await buildInjectedSignals(
          "loop_diff",
          outputSnapshot,
          agentResult.safetyFacts,
        );
        if (effectiveExecutionMode === "loop" && loopConfig) {
          const verificationSummary = agentResult.verification
            ? JSON.stringify(agentResult.verification).slice(0, 8_000)
            : "No deterministic verification result was reported.";
          loopReview = await evaluateLoopReview(
            loopConfig.diffReview.reviewer,
            loopConfig.diffReview.requireCrossModel,
            {
              kind: "diff",
              taskId,
              taskSpec: task.rawContent,
              artifact: gitDiff,
              verification: verificationSummary,
              constraints: ((blueprint as Blueprint).constraints ?? []).join("\n"),
              projectRoot: adapter.projectRoot,
            },
            undefined,
            loopInjectedSignals,
            // TASK-1316: the diff-gate intent cutover.
            {
              mode: adapter.config.judgment?.stages?.loopDiff?.mode ?? "off",
              runnerConfig: adapter.config.judgment?.runner,
            },
          );
        }

        const thresholdsPass =
          autoApproveRules !== undefined &&
          evaluateJudgeAutoApprove(
            gitDiff,
            filesChanged.length,
            verificationPassed,
            autoApproveRules,
          );
        const shouldAutoApprove =
          effectiveExecutionMode === "loop"
            ? loopReview?.reviewGate.eligibleForAutoApproval === true && thresholdsPass
            : thresholdsPass;

        if (loopReview) {
          const nextState = shouldAutoApprove ? "auto-approved" : "pending";
          const approvalIdentity = identityForApprovalSave(
            "loop judge approval save",
            "judge_review",
          );
          if ("refusal" in approvalIdentity) return approvalIdentity.refusal;
          await saveJudgeApproval(
            taskId,
            gitDiff,
            filesChanged,
            verificationPassed,
            logDir,
            nextState,
            {
              review: loopReview.result,
              reviewedAt: new Date().toISOString(),
              reviewGate: loopReview.reviewGate,
              agentSessionId: agentResult.claudeSessionId,
            },
            undefined,
            approvalIdentity.identity,
          );
          events.emit("loop_diff_review", {
            taskId,
            executionMode: "loop",
            reviewKind: "diff",
            runnerKind: loopReview.runnerKind,
            result: loopReview.result,
            reviewGate: loopReview.reviewGate,
            nextState,
          });
          if (loopReview.judgmentDecision) {
            events.emit("judgment_decision", {
              taskId,
              stage: "loop_diff",
              attempt: 0,
              sequence: 0,
              final: true,
              decision: loopReview.judgmentDecision,
            });
          } else if (loopReview.judgmentProjectionFailure) {
            events.emit("judgment_projection_failed", {
              taskId,
              stage: "loop_diff",
              attempt: 0,
              sequence: 0,
              ...loopReview.judgmentProjectionFailure,
            });
          }
          if (loopReview.judgmentOrchestration?.attempted) {
            events.emit("judgment_evaluation", {
              taskId,
              stage: "loop_diff",
              attempt: 0,
              sequence: 0,
              final: false,
              orchestration: loopReview.judgmentOrchestration,
            });
          }
        }

        // TASK-1313 S2: enforce-mode safety stop — the dispatch ends
        // here; checkpoint and worktree stay for operator triage, no
        // retry is consumed, and nothing downstream (PR, judge,
        // post-judge, finalize) can run.
        if (
          effectiveExecutionMode === "loop" &&
          safetyStopRequested(loopReview?.judgmentDecision, loopInjectedSignals)
        ) {
          const stopReason = "Safety floor stop at loop_diff: producer safety signals present";
          events.emit("session_error", {
            error: stopReason,
            failedStage: "safety_floor",
          });
          events.recordSession("error");
          return {
            taskId,
            outcome: "safety_stop",
            branchName,
            agentResult,
            retriesUsed: 0,
            error: stopReason,
            outputSnapshots,
          };
        }

        if (shouldAutoApprove) {
          // Auto-approved — mark checkpoint and continue
          await checkpointMgr.markStageComplete(taskId, "judge_review", {});
          events.emit("judge_review_auto_approved", { taskId });
          events.emit("checkpoint_saved", {
            taskId,
            stage: "judge_review",
            completedStages: [...completedStages, "judge_review"],
          });
        } else {
          // Needs human approval - save pending state and pause
          if (!loopReview) {
            const approvalIdentity = identityForApprovalSave(
              "pending judge approval save",
              "judge_review",
            );
            if ("refusal" in approvalIdentity) return approvalIdentity.refusal;
            await savePendingJudgeApproval(
              taskId,
              gitDiff,
              filesChanged,
              verificationPassed,
              logDir,
              approvalIdentity.identity,
            );
          }
          events.emit("judge_pending_approval", {
            taskId,
            filesChanged: filesChanged.length,
            diffLines: gitDiff.split("\n").length,
          });
          events.recordSession("completed", {
            outcome: "awaiting_judge_approval",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "awaiting_judge_approval" as const,
            retriesUsed: 0,
            outputSnapshots,
          };
        }
      }
    } else if (completedStages.has("judge_review")) {
      events.emit("stage_skipped", {
        taskId,
        stage: "judge_review",
        reason: "completed in previous checkpoint",
      });
    }

    // ── Step 7: Pre-judge scope check + Run judge ──────────────
    const judgeModel =
      loopConfig?.models?.judge ??
      resolveModel(adapter.config.modelRouting, adapter.config.agent, { stage: "judge" });
    const judgeRunStart = Date.now();
    const changedFiles = outputSnapshot.changedFiles;

    // Pre-judge scope check: compare changed files against spec's filesToModify
    const scopeWarnings: string[] = [];
    if (task.filesToModify && task.filesToModify.length > 0) {
      const specFiles = new Set(task.filesToModify.map((f) => f.path));
      const extraFiles = changedFiles.filter((f) => {
        // Check exact match or basename match (for monorepo path differences)
        const basename = f.split("/").pop() ?? f;
        return (
          !specFiles.has(f) &&
          ![...specFiles].some((sf) => {
            const sfBase = sf.split("/").pop() ?? sf;
            return sfBase === basename;
          })
        );
      });
      if (extraFiles.length > 0) {
        for (const f of extraFiles) {
          scopeWarnings.push(`Agent modified "${f}" which is not in task's Files to Modify`);
        }
        events.emit("scope_check", {
          taskId,
          extraFiles,
          specFiles: [...specFiles],
          changedFiles,
        });
      }
    }

    events.emit("judge_start", { model: judgeModel, scopeWarnings: scopeWarnings.length });

    // Build compact backlog summary for judge follow-up dedup (non-blocking, best-effort)
    let recentBacklogSummary: string | undefined;
    try {
      const { loadBacklogEntries } = await import("./follow-up-dedup.js");
      const backlogTaskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
      const backlogEntries = await loadBacklogEntries(backlogTaskDir);
      if (backlogEntries.length > 0) {
        recentBacklogSummary = backlogEntries
          .map(
            (e) => `- ${e.taskId}: ${e.title}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""}`,
          )
          .join("\n");
      }
    } catch {
      // Non-fatal: backlog summary is best-effort
    }

    // Convert blueprint verification patterns into compliance checks
    const blueprintChecks = context.blueprintPatterns
      ? blueprintToChecks(context.blueprintPatterns)
      : [];

    // TASK-894: load the pre-dispatch spec-review findings from the preflight
    // cache (if any) so the judge can give the worker the benefit of any
    // reasonable interpretation on criteria flagged ambiguous before dispatch.
    // Best-effort; never fail the dispatch if the cache is missing.
    let specReviewForJudge: JudgeInput["specReview"];
    try {
      const judgePrepCache = new PrepCache(adapter.projectRoot);
      const judgeContentHash = computeContentHash(task.rawContent);
      const judgePreflight = await judgePrepCache.readPreflight(taskId, judgeContentHash);
      const judgeSpecReview = judgePreflight?.specReview;
      if (
        judgeSpecReview &&
        Array.isArray(judgeSpecReview.findings) &&
        judgeSpecReview.findings.length > 0
      ) {
        specReviewForJudge = {
          riskLevel: judgeSpecReview.riskLevel,
          findings: judgeSpecReview.findings.map((f) => ({
            criterionIndex: f.criterionIndex,
            criterionText: f.criterionText,
            dimension: f.dimension,
            severity: f.severity,
            explanation: f.explanation,
            suggestedClarification: f.clarificationQuestion,
          })),
        };
      }
    } catch {
      // Non-fatal: judge runs without specReview if cache load fails.
    }

    const judgeInjectedSignals = await buildInjectedSignals(
      "judge",
      outputSnapshot,
      agentResult.safetyFacts,
    );

    // ── TASK-1316: the judge intent cutover ────────────────────────
    // Runs at BOTH judge seams (initial + retry) over the judge's own
    // FINAL trace decision — before post-judge, so the deterministic
    // verifier's authority (decision D1) is never what an intent model
    // reacts to. Enforce is HOLD-OR-DEMOTE only:
    //   continue      → no-op (confirms the pipeline)
    //   repair        → APPROVE demotes to REVISE with an
    //                   [INTENT DEMOTION] feedback prefix; the run
    //                   enters the SAME retry loop as a native REVISE
    //   human_review  → the existing judge-review pause path
    // No mapping ever RAISES a verdict: REVISE and REJECT are returned
    // untouched, so the TASK-1200 enforcement demotions upstream in the
    // trace stay un-undoable.
    // The optional chain past `stages` is deliberate: the schema fills
    // all five stage keys on parse, but a config that predates 1316
    // (or any programmatically-built one) can carry a partial `stages`
    // object, and an absent key means OFF — it must never crash a
    // dispatch that opted into nothing.
    const judgeIntentMode = adapter.config.judgment?.stages?.judge?.mode ?? "off";
    const applyJudgeIntentCutover = async (
      current: JudgeResult,
      attempt: number,
    ): Promise<{
      judgeResult: JudgeResult;
      pause: boolean;
      refusal?: DispatchResult;
    }> => {
      const unchanged = { judgeResult: current, pause: false };
      if (judgeIntentMode === "off") return unchanged;
      const legacy = current.judgmentTrace?.at(-1)?.decision;
      // No trace decision means the projection already failed and was
      // reported; the runner is never constructed on that path.
      if (!legacy) return unchanged;

      // Round-2 F1: an intent hold must be CLEARABLE. Re-opening the
      // judge-review gate is not enough on its own — a resume re-runs
      // the judge, re-asks the intent model, gets the same answer, and
      // pauses again forever. Worse, in plain dispatch mode the gate
      // block is disabled entirely (`judgeReviewGateEnabled`), so the
      // pending record would never even be read.
      //
      // So the hold is bound to the exact diff a human cleared: an
      // APPROVED record whose fingerprint still matches means this work
      // was already reviewed and released, and the cutover stands down
      // for this attempt. A different diff re-arms it.
      const { loadJudgeApproval, saveJudgeApproval } = await import("./judge-approval.js");
      const diffFingerprint = computeContentHash(gitDiff);
      const priorApproval = await loadJudgeApproval(taskId, logDir);
      if (
        priorApproval?.state === "approved" &&
        priorApproval.intentHold?.diffFingerprint === diffFingerprint
      ) {
        events.emit("judgment_hold_cleared", {
          taskId,
          stage: "judge",
          attempt,
          clearedBy: priorApproval.approvedBy ?? "human",
          rationale: priorApproval.intentHold.rationale,
        });
        return unchanged;
      }

      const intentRequest = buildJudgeIntentRequest(taskId, task.rawContent, current, legacy);
      const orchestration = await orchestrateJudgment({
        mode: judgeIntentMode,
        legacyDecision: legacy,
        request: intentRequest,
        runner: intentRequest
          ? createIntentJudgmentRunner(adapter.config.judgment?.runner)
          : undefined,
        // A second model's outage must not fail the run closed — the
        // judge verdict is itself already bounded by the 1200 caps
        // (spec decision D2).
        onRunnerError: "preserve_legacy",
        outcomePolicy: "monotonic_hold_or_demote",
        // A clean APPROVE is exactly the case worth reading intent on.
        signalGate: "always_evaluate",
      });

      const sequence = nextTraceSequence(current);
      events.emit("judgment_decision", {
        taskId,
        stage: "judge",
        attempt,
        sequence,
        final: true,
        decision: orchestration.activeDecision,
      });
      if (orchestration.attempted) {
        events.emit("judgment_evaluation", {
          taskId,
          stage: "judge",
          attempt,
          sequence,
          final: false,
          orchestration,
        });
      }

      // Shadow observes only; degradation and refusals leave the legacy
      // verdict alone by construction.
      if (judgeIntentMode !== "enforce" || orchestration.reason !== "enforced_candidate") {
        return unchanged;
      }

      const action = orchestration.activeDecision.action;
      const rationale = orchestration.activeDecision.rationale.join("; ");

      if (action === "human_review") {
        const approvalIdentity = identityForApprovalSave(
          "judge intent hold approval save",
          "judge_review",
        );
        if ("refusal" in approvalIdentity) {
          return {
            judgeResult: current,
            pause: false,
            refusal: approvalIdentity.refusal,
          };
        }
        // The judge (and everything after it) must not stand on a
        // decision a human has not seen: rewind so the resume comes
        // back through the judge-review gate.
        await checkpointMgr.rewindFrom(taskId, "judge_review");
        // In loop mode this record already carries the diff review's
        // findings and gate facts. Re-saving as pending must PRESERVE
        // that evidence — the human arriving at the gate needs the
        // reviewer's output, not a bare pending stub — and must carry
        // the intent rationale plus the diff fingerprint that lets the
        // hold be cleared exactly once, for exactly this work.
        await saveJudgeApproval(
          taskId,
          gitDiff,
          outputSnapshot.changedFiles,
          agentResult.verification?.allPassed ?? false,
          logDir,
          "pending",
          priorApproval?.review && priorApproval.reviewedAt && priorApproval.reviewGate
            ? {
                review: priorApproval.review,
                reviewedAt: priorApproval.reviewedAt,
                reviewGate: priorApproval.reviewGate,
                ...(priorApproval.agentSessionId
                  ? { agentSessionId: priorApproval.agentSessionId }
                  : {}),
              }
            : undefined,
          {
            rationale: orchestration.activeDecision.rationale,
            diffFingerprint,
            heldAt: new Date().toISOString(),
            // TASK-1319 (R1-2): record WHICH action opened the hold.
            // This branch only runs under `human_review`, so the value
            // is known here; recording it rather than letting a reader
            // infer it is what stops the advisory detector from
            // treating a referral-to-a-human as advice AGAINST the
            // human's decision.
            action,
          },
          approvalIdentity.identity,
        );
        events.emit("judge_pending_approval", {
          taskId,
          filesChanged: outputSnapshot.changedFiles.length,
          diffLines: gitDiff.split("\n").length,
          reason: `INTENT HOLD: ${rationale}`,
        });
        events.recordSession("completed", {
          outcome: "awaiting_judge_approval",
          durationMs: Date.now() - startTime,
        });
        return { judgeResult: current, pause: true };
      }

      if (action === "repair" && current.verdict === "APPROVE") {
        const demoted: JudgeResult = {
          ...current,
          verdict: "REVISE",
          feedback: `[INTENT DEMOTION] ${rationale}\n\n${current.feedback}`,
        };
        // The judge checkpoint was written with the pre-demotion verdict
        // a few lines above, so re-save the withdrawn one (the Pattern H5
        // staleness concern the retry site cites).
        //
        // This IS load-bearing, verified in source (round-2b): a resume
        // reads `existingCheckpoint.judgeResult?.verdict === "REVISE"`
        // (dispatcher.ts:1003) to take the `retry_after_revise` branch
        // and inject the judge feedback. Leaving the stale APPROVE would
        // send a resumed dispatch down the incomplete-checkpoint path
        // instead, losing the demotion entirely.
        //
        // What it does NOT fix, stated honestly: the worker is still
        // skipped on resume (`completedStages.has("agent")`, :1270), so a
        // crash between the demotion and the retry loop resumes by
        // rejudging the unchanged diff. That is identical to a NATIVE
        // REVISE, which writes this same shape at this same point — a
        // pre-existing resume weakness this cutover mirrors rather than
        // introduces. Named as a residual.
        //
        // The write is deliberately the native shape (judgeResult +
        // gitDiff only): `markStageComplete` merges, so `retriesUsed`
        // and `totalCostUsd` already on the checkpoint are preserved,
        // and this save cannot perturb them.
        await checkpointMgr.markStageComplete(taskId, "judge", {
          judgeResult: demoted,
          gitDiff,
        });
        return { judgeResult: demoted, pause: false };
      }

      return unchanged;
    };

    let judgeAttempt = 0;
    let judgeResult = await runJudge(
      {
        taskSpec:
          task.rawContent +
          (scopeWarnings.length > 0
            ? `\n\n---\n\n## Pre-Judge Scope Check\n\nThe following files were modified but are NOT in the task's "Files to Modify" section:\n${scopeWarnings.map((w) => `- ${w}`).join("\n")}\n\nDetermine if these are necessary scaffolding or true scope violations.`
            : ""),
        gitDiff,
        verificationResults: agentResult.verification ?? {
          allPassed: false,
          commands: [],
          conventionChecks: [],
        },
        task,
        changedFiles,
        recentBacklogSummary,
        specReview: specReviewForJudge,
      },
      adapter,
      {
        model: judgeModel,
        blueprintChecks,
        injectedSignals: judgeInjectedSignals,
      },
    );
    // TASK-1316: when the judge cutover is on it emits the stage's FINAL
    // decision (the active one), so the trace must not also claim final.
    emitJudgeTrace(
      taskId,
      judgeAttempt,
      judgeResult,
      events,
      judgeResult.verdict === "REVISE" && judgeIntentMode === "off",
    );
    await linkTranscripts(taskId, adapter, events, judgeRunStart, 0);
    events.emit("judge_result", {
      verdict: judgeResult.verdict,
      confidence: judgeResult.confidence,
      scopeViolations: judgeResult.scopeViolations,
      criteriaGaps: judgeResult.criteriaGaps,
      qualityIssues: judgeResult.qualityIssues,
      feedback: judgeResult.feedback,
    });

    // Save judge checkpoint
    await checkpointMgr.markStageComplete(taskId, "judge", {
      judgeResult,
      gitDiff,
    });

    // TASK-1313 S2: enforce-mode safety stop at the judge stage —
    // before post-judge, PR creation, or any retry consumption.
    if (safetyStopRequested(judgeResult.judgmentTrace?.at(-1)?.decision, judgeInjectedSignals)) {
      const stopReason = "Safety floor stop at judge: producer safety signals present";
      events.emit("session_error", { error: stopReason, failedStage: "safety_floor" });
      events.recordSession("error");
      return {
        taskId,
        outcome: "safety_stop",
        branchName,
        agentResult,
        retriesUsed: existingCheckpoint?.retriesUsed ?? 0,
        error: stopReason,
        outputSnapshots,
      };
    }

    // TASK-1316: the intent cutover sits between the judge and
    // post-judge so it reacts to the JUDGE's decision, never to the
    // deterministic verifier's (decision D1).
    {
      const cutover = await applyJudgeIntentCutover(judgeResult, judgeAttempt);
      if (cutover.refusal) return cutover.refusal;
      judgeResult = cutover.judgeResult;
      if (cutover.pause) {
        return {
          taskId,
          outcome: "awaiting_judge_approval" as const,
          retriesUsed: existingCheckpoint?.retriesUsed ?? 0,
          outputSnapshots,
        };
      }
    }

    // ── Step 8: Post-judge verification + Retry loop on REVISE ──
    // Run post-judge verification after each judge APPROVE to catch
    // quality gaps (build/test failures, integration issues, stubs).
    // If verification fails, convert to REVISE so the agent retries.
    // Anti-pattern guard: don't re-run verification on retries triggered
    // by the verifier itself, to avoid infinite loops.
    let postJudgeTriggeredRevise = false;

    // Run post-judge verification on initial judge APPROVE
    if (judgeResult.verdict === "APPROVE") {
      const verifyConversion = await runPostJudgeVerifyAndConvert(
        taskId,
        task,
        adapter,
        events,
        judgeResult,
        judgeAttempt,
      );
      judgeResult = verifyConversion.judgeResult;
      if (verifyConversion.triggeredRevise) {
        postJudgeTriggeredRevise = true;
      }
    }

    let retriesUsed = existingCheckpoint?.retriesUsed ?? 0;
    let totalAgentCostUsd = agentResult.totalCostUsd;
    let lastAlertLevel: string | undefined;

    // Emit cost alerts at thresholds (50%, 75%, 90%)
    const emitCostAlerts = (currentCost: number): void => {
      if (totalBudget <= 0) return;
      const pct = (currentCost / totalBudget) * 100;
      const levels: Array<{ threshold: number; level: "yellow" | "orange" | "red" }> = [
        { threshold: 90, level: "red" },
        { threshold: 75, level: "orange" },
        { threshold: 50, level: "yellow" },
      ];
      for (const { threshold, level } of levels) {
        if (pct >= threshold && lastAlertLevel !== level) {
          // Only emit if we haven't already emitted this level or a higher one
          if (
            !lastAlertLevel ||
            levels.findIndex((l) => l.level === lastAlertLevel) >
              levels.findIndex((l) => l.level === level)
          ) {
            lastAlertLevel = level;
            events.emit("cost_alert", {
              level,
              currentCostUsd: currentCost,
              budgetUsd: totalBudget,
              percentUsed: Math.round(pct),
              message: `Cost alert: $${currentCost.toFixed(2)} of $${totalBudget.toFixed(2)} budget used (${Math.round(pct)}%)`,
            });
          }
          break;
        }
      }
    };

    // Check initial run cost
    emitCostAlerts(totalAgentCostUsd);

    while (judgeResult.verdict === "REVISE" && retriesUsed < maxRetries) {
      // ── Circuit breaker: stop retries if budget exhausted ────
      if (totalBudget > 0) {
        const remainingBudget = totalBudget - totalAgentCostUsd;
        if (remainingBudget <= 0) {
          events.emit("budget_circuit_break", {
            totalCostUsd: totalAgentCostUsd,
            budgetUsd: totalBudget,
            retriesUsed,
            maxRetries,
            message: `Budget exhausted ($${totalAgentCostUsd.toFixed(2)} of $${totalBudget.toFixed(2)}). Stopping retries.`,
          });
          break;
        }
        // Warn if remaining budget is very low (< 10% of original)
        if (remainingBudget < totalBudget * 0.1) {
          events.emit("cost_alert", {
            level: "red",
            currentCostUsd: totalAgentCostUsd,
            budgetUsd: totalBudget,
            percentUsed: Math.round((totalAgentCostUsd / totalBudget) * 100),
            message: `Only $${remainingBudget.toFixed(2)} remaining for retry ${retriesUsed + 1}. May not be enough.`,
          });
        }
      }

      retriesUsed++;

      // Resolve model for this retry attempt (may escalate tier)
      const retryWorkerModel =
        loopConfig?.models?.build ??
        resolveModel(adapter.config.modelRouting, adapter.config.agent, {
          stage: "worker",
          taskTags: task.tags,
          retryAttempt: retriesUsed,
        });

      // Emit model_escalated event if the model changed
      const previousModel =
        loopConfig?.models?.build ??
        resolveModel(adapter.config.modelRouting, adapter.config.agent, {
          stage: "worker",
          taskTags: task.tags,
          retryAttempt: retriesUsed - 1,
        });
      if (retryWorkerModel !== previousModel) {
        events.emit("model_escalated", {
          taskId,
          fromModel: previousModel,
          toModel: retryWorkerModel,
          retryAttempt: retriesUsed,
          reason: `Retry escalation: attempt ${retriesUsed}`,
        });
      }

      events.emit("retry_start", {
        attempt: retriesUsed,
        maxRetries,
        feedbackSummary: judgeResult.feedback.slice(0, 200),
      });

      // Feed judge feedback to agent for another attempt
      // Pass remaining budget so the SDK enforces it per-attempt
      const remainingBudget = totalBudget > 0 ? totalBudget - totalAgentCostUsd : 0;

      // Session resume for retries: if the agent has a session ID and the
      // model hasn't changed (no escalation), resume the session with just
      // the judge feedback. The agent remembers its previous work and can
      // make surgical fixes instead of rewriting from scratch.
      const canResumeSession = !!agentResult.claudeSessionId && retryWorkerModel === previousModel;

      const retryAgentStart = Date.now();
      if (canResumeSession) {
        events.emit("retry_resume", {
          taskId,
          claudeSessionId: agentResult.claudeSessionId!,
          reason: "judge_revise",
        });

        agentResult = await runAgent(
          taskId,
          context,
          adapter,
          {
            model: retryWorkerModel,
            ...(remainingBudget > 0 ? { maxBudgetUsd: remainingBudget } : {}),
            resumeSessionId: agentResult.claudeSessionId,
            retryFeedback: buildRetryResumePrompt(judgeResult, agentResult),
          },
          events,
        );
      } else {
        // Fresh session fallback: model escalation or no session ID
        if (agentResult.claudeSessionId && retryWorkerModel !== previousModel) {
          events.emit("retry_resume_skipped", {
            taskId,
            reason: "model_escalation",
            fromModel: previousModel,
            toModel: retryWorkerModel,
          });
        }

        const retryContext = {
          ...context,
          taskSpec: buildRetryPrompt(context.taskSpec, judgeResult, context.blueprint, agentResult),
        };

        agentResult = await runAgent(
          taskId,
          retryContext,
          adapter,
          {
            model: retryWorkerModel,
            ...(remainingBudget > 0 ? { maxBudgetUsd: remainingBudget } : {}),
          },
          events,
        );
      }
      await linkTranscripts(taskId, adapter, events, retryAgentStart, retriesUsed);
      totalAgentCostUsd += agentResult.totalCostUsd;
      emitCostAlerts(totalAgentCostUsd);

      // Reset the post-judge verification guard: the agent produced new work,
      // so verification should run fresh on the next judge APPROVE.
      postJudgeTriggeredRevise = false;

      if (agentResult.outcome !== "success") {
        if (branchName) {
          await abandonBranch(taskId, adapter);
        }
        events.emit("session_complete", {
          outcome: "agent_failed",
          durationMs: Date.now() - startTime,
          totalCostUsd: totalAgentCostUsd,
        });
        events.recordSession("completed", {
          outcome: "agent_failed",
          totalCostUsd: totalAgentCostUsd,
          durationMs: Date.now() - startTime,
        });
        return {
          taskId,
          outcome: "agent_failed",
          branchName,
          agentResult,
          judgeResult,
          retriesUsed,
          error:
            agentResult.error ??
            `Agent failed on retry ${retriesUsed} with outcome: ${agentResult.outcome}`,
          outputSnapshots,
        };
      }

      await checkpointMgr.markStageComplete(taskId, "agent", {
        agentResult,
        claudeSessionId: agentResult.claudeSessionId,
        retriesUsed,
        totalCostUsd: totalAgentCostUsd,
      });

      // Re-judge after retry using a fresh durable output seal.
      outputSnapshot = await sealAgentOutputAttempt({
        taskId,
        adapter,
        events,
        attempt: retriesUsed + 1,
        kind: "retry",
        diffBase: dispatchBaseBranch,
        branchName,
        claudeSessionId: agentResult.claudeSessionId,
      });
      outputSnapshots.push(outputSnapshot);
      gitDiff = outputSnapshot.gitDiff;
      await checkpointMgr.markStageComplete(taskId, "commit", {
        gitDiff,
        outputSnapshots,
        retriesUsed,
        totalCostUsd: totalAgentCostUsd,
      });
      if (gitDiff.trim().length === 0) {
        if (branchName) {
          await abandonBranch(taskId, adapter);
        }
        events.emit("session_complete", {
          outcome: "no_changes",
          durationMs: Date.now() - startTime,
          totalCostUsd: totalAgentCostUsd,
        });
        events.recordSession("completed", {
          outcome: "no_changes",
          totalCostUsd: totalAgentCostUsd,
          durationMs: Date.now() - startTime,
          turnsUsed: agentResult.turnsUsed,
        });
        return {
          taskId,
          outcome: "no_changes",
          branchName,
          agentResult,
          retriesUsed,
          error: `Agent produced no committed changes after retry ${retriesUsed}`,
          outputSnapshots,
        };
      }

      if (effectiveExecutionMode === "loop" && loopConfig) {
        const { evaluateJudgeAutoApprove, saveJudgeApproval } = await import("./judge-approval.js");
        const retryFilesChanged = outputSnapshot.changedFiles;
        const verificationPassed = agentResult.verification?.allPassed ?? false;
        const retryInjectedSignals = await buildInjectedSignals(
          "loop_diff",
          outputSnapshot,
          agentResult.safetyFacts,
        );
        const retryReview = await evaluateLoopReview(
          loopConfig.diffReview.reviewer,
          loopConfig.diffReview.requireCrossModel,
          {
            kind: "diff",
            taskId,
            taskSpec: task.rawContent,
            artifact: gitDiff,
            verification: agentResult.verification
              ? JSON.stringify(agentResult.verification).slice(0, 8_000)
              : "No deterministic verification result was reported.",
            constraints: ((blueprint as Blueprint).constraints ?? []).join("\n"),
            projectRoot: adapter.projectRoot,
          },
          undefined,
          retryInjectedSignals,
          // TASK-1316: the retry-side diff review is the SAME loop_diff
          // stage — one mount, stage derived from request.kind.
          {
            mode: adapter.config.judgment?.stages?.loopDiff?.mode ?? "off",
            runnerConfig: adapter.config.judgment?.runner,
          },
        );
        const autoRules = loopConfig.diffReview.autoApproveWhen;
        const thresholdsPass =
          autoRules !== undefined &&
          evaluateJudgeAutoApprove(
            gitDiff,
            retryFilesChanged.length,
            verificationPassed,
            autoRules,
          );
        const shouldAutoApprove = retryReview.reviewGate.eligibleForAutoApproval && thresholdsPass;
        const nextState = shouldAutoApprove ? "auto-approved" : "pending";
        const approvalIdentity = identityForApprovalSave(
          "retry loop judge approval save",
          "judge_review",
        );
        if ("refusal" in approvalIdentity) return approvalIdentity.refusal;
        await saveJudgeApproval(
          taskId,
          gitDiff,
          retryFilesChanged,
          verificationPassed,
          logDir,
          nextState,
          {
            review: retryReview.result,
            reviewedAt: new Date().toISOString(),
            reviewGate: retryReview.reviewGate,
            agentSessionId: agentResult.claudeSessionId,
          },
          undefined,
          approvalIdentity.identity,
        );
        events.emit("loop_diff_review", {
          taskId,
          executionMode: "loop",
          reviewKind: "diff",
          runnerKind: retryReview.runnerKind,
          result: retryReview.result,
          reviewGate: retryReview.reviewGate,
          nextState,
        });
        if (retryReview.judgmentDecision) {
          events.emit("judgment_decision", {
            taskId,
            stage: "loop_diff",
            attempt: retriesUsed,
            sequence: 0,
            final: true,
            decision: retryReview.judgmentDecision,
          });
        } else if (retryReview.judgmentProjectionFailure) {
          events.emit("judgment_projection_failed", {
            taskId,
            stage: "loop_diff",
            attempt: retriesUsed,
            sequence: 0,
            ...retryReview.judgmentProjectionFailure,
          });
        }
        if (retryReview.judgmentOrchestration?.attempted) {
          events.emit("judgment_evaluation", {
            taskId,
            stage: "loop_diff",
            attempt: retriesUsed,
            sequence: 0,
            final: false,
            orchestration: retryReview.judgmentOrchestration,
          });
        }
        if (safetyStopRequested(retryReview.judgmentDecision, retryInjectedSignals)) {
          const stopReason =
            "Safety floor stop at loop_diff (retry): producer safety signals present";
          events.emit("session_error", { error: stopReason, failedStage: "safety_floor" });
          events.recordSession("error");
          return {
            taskId,
            outcome: "safety_stop",
            branchName,
            agentResult,
            retriesUsed,
            error: stopReason,
            outputSnapshots,
          };
        }
        if (!shouldAutoApprove) {
          // The first judge-review checkpoint belongs to the prior sealed diff.
          // Preserve the new worker output but force resume through this fresh
          // pending approval before another judge call.
          await checkpointMgr.rewindFrom(taskId, "judge_review");
          events.emit("judge_pending_approval", {
            taskId,
            filesChanged: retryFilesChanged.length,
            diffLines: gitDiff.split("\n").length,
          });
          events.recordSession("completed", {
            outcome: "awaiting_judge_approval",
            durationMs: Date.now() - startTime,
          });
          return {
            taskId,
            outcome: "awaiting_judge_approval",
            retriesUsed,
            outputSnapshots,
          };
        }
      }

      events.emit("judge_start", { model: judgeModel });
      const retryJudgeStart = Date.now();
      const retryChangedFiles = outputSnapshot.changedFiles;
      // Compute blueprint checks from context (same as initial judge)
      const retryBlueprintChecks = context.blueprintPatterns
        ? blueprintToChecks(context.blueprintPatterns)
        : [];
      const retryJudgeInjectedSignals = await buildInjectedSignals(
        "judge",
        outputSnapshot,
        agentResult.safetyFacts,
      );
      judgeAttempt += 1;
      judgeResult = await runJudge(
        {
          taskSpec: task.rawContent,
          gitDiff,
          verificationResults: agentResult.verification ?? {
            allPassed: false,
            commands: [],
            conventionChecks: [],
          },
          task,
          changedFiles: retryChangedFiles,
          recentBacklogSummary,
        },
        adapter,
        {
          model: judgeModel,
          blueprintChecks: retryBlueprintChecks,
          injectedSignals: retryJudgeInjectedSignals,
        },
      );
      emitJudgeTrace(
        taskId,
        judgeAttempt,
        judgeResult,
        events,
        (judgeResult.verdict === "REVISE" ||
          (judgeResult.verdict === "APPROVE" && postJudgeTriggeredRevise)) &&
          judgeIntentMode === "off",
      );
      await linkTranscripts(taskId, adapter, events, retryJudgeStart, retriesUsed);
      events.emit("judge_result", {
        verdict: judgeResult.verdict,
        confidence: judgeResult.confidence,
        scopeViolations: judgeResult.scopeViolations,
        criteriaGaps: judgeResult.criteriaGaps,
        qualityIssues: judgeResult.qualityIssues,
        feedback: judgeResult.feedback,
      });

      // Update checkpoint with latest judge result so on-disk state reflects
      // the most recent attempt (Pattern H5 fix: stale checkpoint after retry)
      await checkpointMgr.markStageComplete(taskId, "judge", {
        judgeResult,
        gitDiff,
        retriesUsed,
        totalCostUsd: totalAgentCostUsd,
      });

      // TASK-1313 round-2 F1: the retry judge gets the same safety-stop
      // transition as the initial judge — before post-judge, PR work, or
      // further retry consumption.
      if (
        safetyStopRequested(judgeResult.judgmentTrace?.at(-1)?.decision, retryJudgeInjectedSignals)
      ) {
        const stopReason = "Safety floor stop at judge (retry): producer safety signals present";
        events.emit("session_error", { error: stopReason, failedStage: "safety_floor" });
        events.recordSession("error");
        return {
          taskId,
          outcome: "safety_stop",
          branchName,
          agentResult,
          retriesUsed,
          error: stopReason,
          outputSnapshots,
        };
      }

      // TASK-1316: same cutover at the retry seam, same hold-or-demote
      // mapping, before post-judge.
      {
        const cutover = await applyJudgeIntentCutover(judgeResult, judgeAttempt);
        if (cutover.refusal) return cutover.refusal;
        judgeResult = cutover.judgeResult;
        if (cutover.pause) {
          return {
            taskId,
            outcome: "awaiting_judge_approval" as const,
            retriesUsed,
            outputSnapshots,
          };
        }
      }

      // Run post-judge verification on retry judge APPROVE, but only if
      // this retry was NOT triggered by the verifier itself (anti-pattern guard)
      if (judgeResult.verdict === "APPROVE" && !postJudgeTriggeredRevise) {
        const verifyConversion = await runPostJudgeVerifyAndConvert(
          taskId,
          task,
          adapter,
          events,
          judgeResult,
          judgeAttempt,
        );
        judgeResult = verifyConversion.judgeResult;
        if (verifyConversion.triggeredRevise) {
          postJudgeTriggeredRevise = true;
        }
      }
    }

    if (judgeResult.verdict === "APPROVE") {
      // ── Final integration judge for decomposed subtasks ────
      // If this is the final subtask in a decomposition, run an additional
      // judge pass using the parent task's full success criteria. This catches
      // cross-cutting issues that per-subtask judges might miss.
      //
      // TASK-1316 CALL-SITE EXCLUSION (deliberate, see
      // INTENT_CUTOVER_CALL_SITE_EXCLUSIONS): the intent cutover is NOT
      // applied here. A non-APPROVE verdict at this site abandons the
      // branch and ends the run as `rejected` — terminal, not the
      // recoverable retry the hold-or-demote mapping assumes. Wiring it
      // would convert "demote toward review" into "throw the work away",
      // which is an escalation this task explicitly does not grant.
      if (
        options?.parentTaskId &&
        isFinalSubtask(taskId, options.parentTaskId) &&
        hasFinalSubtaskCriterion(task)
      ) {
        try {
          const parentTask = await loadTask(options.parentTaskId, adapter);
          events.emit("judge_start", {
            model: judgeModel,
            integration: true,
            parentTaskId: options.parentTaskId,
          });

          judgeAttempt += 1;
          const integrationJudgeResult = await runJudge(
            {
              taskSpec: parentTask.rawContent,
              gitDiff,
              verificationResults: agentResult.verification ?? {
                allPassed: false,
                commands: [],
                conventionChecks: [],
              },
              task: parentTask,
              changedFiles: outputSnapshot.changedFiles,
            },
            adapter,
            { model: judgeModel },
          );
          emitJudgeTrace(taskId, judgeAttempt, integrationJudgeResult, events, true);

          events.emit("judge_result", {
            verdict: integrationJudgeResult.verdict,
            confidence: integrationJudgeResult.confidence,
            integration: true,
            parentTaskId: options.parentTaskId,
            criteriaGaps: integrationJudgeResult.criteriaGaps,
            feedback: integrationJudgeResult.feedback,
          });

          if (integrationJudgeResult.verdict !== "APPROVE") {
            // Integration judge failed — treat as rejection
            if (branchName) {
              await abandonBranch(taskId, adapter);
            }
            events.emit("session_complete", {
              outcome: "rejected",
              durationMs: Date.now() - startTime,
              totalCostUsd: totalAgentCostUsd,
              reason: "Final integration judge rejected against parent criteria",
            });
            events.recordSession("completed", {
              outcome: "rejected",
              totalCostUsd: totalAgentCostUsd,
              durationMs: Date.now() - startTime,
            });
            return {
              taskId,
              outcome: "rejected",
              branchName,
              agentResult,
              judgeResult: integrationJudgeResult,
              retriesUsed,
              error: `Integration judge verdict: ${integrationJudgeResult.verdict}. ${integrationJudgeResult.feedback}`,
              outputSnapshots,
            };
          }
        } catch (err) {
          // Parent task not found or judge error — log but don't block
          const msg = err instanceof Error ? err.message : String(err);
          events.emit("session_error", {
            error: `Integration judge failed: ${msg}`,
            failedStage: "integration_judge",
          });
        }
      }

      // Clean up checkpoint on success
      await checkpointMgr.delete(taskId);
    }

    // Only proceed to PR/GitHub sync if verified
    if (judgeResult.verdict === "APPROVE") {
      // ── Runtime validation for frontend tasks (warnings only) ────
      if (adapter.config.runtimeCheck) {
        try {
          const { runRuntimeValidation } = await import("./runtime-validator.js");
          const runtimeResult = await runRuntimeValidation(
            taskId,
            task,
            adapter,
            adapter.projectRoot,
            events,
          );
          if (runtimeResult.warnings.length > 0) {
            events.emit("session_error", {
              error: `Runtime check warnings: ${runtimeResult.warnings.join("; ")}`,
              failedStage: "runtime_check",
            });
          }
        } catch {
          // Runtime validation is non-fatal
        }
      }

      // ── Post-approval lifecycle: verify → fix → finalize ─────────
      let lifecycleResult: import("../core/types.js").LifecycleResult | undefined;
      try {
        const { runPostApprovalLifecycle } = await import("./lifecycle-manager.js");
        lifecycleResult = await runPostApprovalLifecycle(
          taskId,
          task,
          adapter,
          adapter.projectRoot,
          events,
        );
      } catch {
        // Lifecycle failure is non-fatal — dispatch still proceeds
      }

      // Sync dispatch completion to GitHub if configured
      if (!dockerHostPromotion && adapter.config.integrations?.github?.reportBack) {
        await syncDispatchComplete(taskId, "approved", undefined, adapter.config).catch((err) => {
          // Non-fatal: log but don't block
          console.error(`GitHub sync failed: ${err}`);
        });
      }

      const result = await handleApproval(
        taskId,
        task,
        adapter,
        branchName,
        agentResult,
        judgeResult,
        retriesUsed,
        options,
        featureBranch,
        dispatchBaseBranch,
        mergeTargetBranch,
        events,
      );
      if (result.prUrl) {
        events.emit("pr_created", {
          prUrl: result.prUrl,
          branchName: branchName ?? "",
        });

        // Sync PR creation to GitHub if configured
        if (adapter.config.integrations?.github?.reportBack) {
          await syncPRCreated(taskId, result.prUrl, adapter.config).catch((err) => {
            console.error(`GitHub sync failed: ${err}`);
          });
        }
      }
      // Emit subtask merge event when merged to feature branch
      if (featureBranch && options?.parentTaskId && result.autoMerged) {
        events.emit("subtask_merged_to_feature_branch", {
          taskId,
          parentTaskId: options.parentTaskId,
          featureBranch,
        });
      }

      // Emit auto-merge events for dashboard/SSE observability
      if (result.autoMerged && !featureBranch) {
        events.emit("auto_merge_complete", {
          taskId,
          targetBranch: mergeTargetBranch,
          strategy: adapter.config.git.autoMergeStrategy ?? "squash",
          mergeCommitSha: result.mergeCommitSha,
        });
      } else if (!dockerHostPromotion && adapter.config.git.autoMerge && branchName) {
        // autoMerge was enabled but merge didn't succeed
        events.emit("auto_merge_failed", {
          taskId,
          targetBranch: mergeTargetBranch,
          worktreePath: adapter.projectRoot,
        });
      }

      // Create follow-up task specs from judge suggestions (non-blocking)
      if (judgeResult.followUpItems && judgeResult.followUpItems.length > 0) {
        createFollowUpTasks(taskId, task, adapter, judgeResult.followUpItems, events).catch(
          (err) => {
            console.error(`Follow-up task creation failed: ${err}`);
          },
        );
      }

      events.emit("session_complete", {
        outcome: "approved",
        durationMs: Date.now() - startTime,
        totalCostUsd: totalAgentCostUsd,
        executionMode: effectiveExecutionMode,
        lifecycleVerified: lifecycleResult?.verified === true,
        autoMerged: result.autoMerged,
        mergeCommitSha: result.mergeCommitSha,
        recordOnFinalize: loopConfig?.recordOnFinalize ?? false,
      });
      events.recordSession("completed", {
        outcome: "approved",
        totalCostUsd: totalAgentCostUsd,
        durationMs: Date.now() - startTime,
        turnsUsed: agentResult.turnsUsed,
      });

      // Update analytics database (non-blocking)
      updateRunAnalytics(
        task,
        events.sessionId,
        "approved",
        totalAgentCostUsd,
        Date.now() - startTime,
        retriesUsed,
        adapter,
        agentResult,
        judgeResult,
        gateDepthScore,
        blueprintFileAnalyses > 0 || blueprintCodeExamples > 0
          ? { fileAnalyses: blueprintFileAnalyses, codeExamples: blueprintCodeExamples }
          : undefined,
      );

      // Attach lifecycle result if available
      if (lifecycleResult) {
        result.lifecycleResult = lifecycleResult;
      }
      result.outputSnapshots = outputSnapshots;
      return result;
    }

    // ── Authority Inversion: deterministic PASS overrides LLM REJECT ──
    // When the LLM judge says REJECT but deterministic checks (build/test/lint)
    // all pass, the outcome is needs_review instead of rejected. This prevents
    // judge hallucination (Pattern 26) from auto-rejecting correct work.
    if (judgeResult.verdict === "REJECT") {
      try {
        const { runPostJudgeVerification } = await import("./post-judge-verifier.js");
        const deterministicResult = await runPostJudgeVerification(
          taskId,
          task,
          adapter,
          adapter.projectRoot,
          events,
        );
        const authorityDecision = emitJudgmentProjection(
          events,
          {
            taskId,
            stage: "post_judge",
            attempt: judgeAttempt,
            sequence: nextPostJudgeSequence(judgeResult),
            final: true,
          },
          () => projectPostJudgeDecision(deterministicResult, "REJECT"),
        );
        if (authorityDecision) {
          judgeResult = { ...judgeResult, judgmentDecision: authorityDecision };
        }
        if (deterministicResult.buildPassed && deterministicResult.testsPassed) {
          // Deterministic checks pass but judge says REJECT — authority inversion
          events.emit("needs_review", {
            taskId,
            reason: "Deterministic checks PASS but LLM judge REJECT — surfacing for human review",
            judgeVerdict: judgeResult.verdict,
            judgeConfidence: judgeResult.confidence,
            judgeFeedback: judgeResult.feedback,
            buildPassed: true,
            testsPassed: true,
            lintPassed: deterministicResult.lintPassed,
          });

          // Push branch so human can review
          if (branchName) {
            try {
              await pushBranch(taskId, adapter);
            } catch {
              // Non-fatal: branch may already be pushed
            }
          }

          events.emit("session_complete", {
            outcome: "needs_review",
            durationMs: Date.now() - startTime,
            totalCostUsd: totalAgentCostUsd,
          });
          events.recordSession("completed", {
            outcome: "needs_review",
            totalCostUsd: totalAgentCostUsd,
            durationMs: Date.now() - startTime,
            turnsUsed: agentResult.turnsUsed,
          });

          return {
            taskId,
            outcome: "needs_review",
            branchName,
            agentResult,
            judgeResult,
            retriesUsed,
            error: `Authority inversion: judge REJECT overridden — deterministic checks pass. ${judgeResult.feedback}`,
          };
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const authorityDecision = emitJudgmentProjection(
          events,
          {
            taskId,
            stage: "post_judge",
            attempt: judgeAttempt,
            sequence: nextPostJudgeSequence(judgeResult),
            final: true,
          },
          () => projectPostJudgeErrorDecision(message),
        );
        if (authorityDecision) {
          judgeResult = { ...judgeResult, judgmentDecision: authorityDecision };
        }
        // Deterministic check failed to run — fall through to normal rejection
      }
    }

    // REJECT or REVISE after retries exhausted
    if (branchName) {
      await abandonBranch(taskId, adapter);
    }

    // Sync rejection to GitHub if configured
    if (adapter.config.integrations?.github?.reportBack) {
      await syncDispatchComplete(taskId, "rejected", judgeResult.feedback, adapter.config).catch(
        (err) => {
          console.error(`GitHub sync failed: ${err}`);
        },
      );
    }

    events.emit("session_complete", {
      outcome: "rejected",
      durationMs: Date.now() - startTime,
      totalCostUsd: totalAgentCostUsd,
    });
    events.recordSession("completed", {
      outcome: "rejected",
      totalCostUsd: totalAgentCostUsd,
      durationMs: Date.now() - startTime,
      turnsUsed: agentResult.turnsUsed,
    });

    // Update analytics database (non-blocking)
    updateRunAnalytics(
      task,
      events.sessionId,
      "rejected",
      totalAgentCostUsd,
      Date.now() - startTime,
      retriesUsed,
      adapter,
      agentResult,
      judgeResult,
      gateDepthScore,
      blueprintFileAnalyses > 0 || blueprintCodeExamples > 0
        ? { fileAnalyses: blueprintFileAnalyses, codeExamples: blueprintCodeExamples }
        : undefined,
    );

    return {
      taskId,
      outcome: "rejected",
      branchName,
      agentResult,
      judgeResult,
      retriesUsed,
      error: `Judge verdict: ${judgeResult.verdict}. ${judgeResult.feedback}`,
      outputSnapshots,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    events.emit("session_error", {
      error: message,
      failedStage: "unknown",
    });
    events.recordSession("error", {
      outcome: "error",
      durationMs: Date.now() - startTime,
    });

    // Update analytics for error outcomes (non-blocking, best-effort)
    // task may not be defined if error occurred before parsing
    try {
      const errorTask = await loadTask(taskId, adapter);
      updateRunAnalytics(
        errorTask,
        events.sessionId,
        "error",
        0,
        Date.now() - startTime,
        0,
        adapter,
      );
    } catch {
      // Analytics on error path is best-effort
    }

    // Clean up stale artifacts from infrastructure failures (0 turns, $0).
    // Only cleans checkpoint + branch when the agent never did any work.
    // If the agent ran (1+ turns), the branch is preserved for manual
    // merge — many dispatches produce 80-95% correct code worth salvaging.
    await cleanupEarlyFailureArtifacts(taskId, adapter, checkpointMgr);

    return {
      taskId,
      outcome: "error",
      retriesUsed: 0,
      error: `Dispatch error: ${message}`,
    };
  } finally {
    // Tear down Docker services on all exit paths (success + failure).
    // This block runs for every return path (happy path, reject, error).
    // Best-effort: failure here is non-fatal.
    try {
      const dockerCmds = adapter.config.verification.commands.filter(
        (c) => c.environment === "docker" && c.docker?.warmUp,
      );
      if (dockerCmds.length > 0) {
        const { tearDown: dockerTearDownFinally } =
          await import("../testing/docker-test-runner.js");
        const uniqueComposeFiles = [...new Set(dockerCmds.map((c) => c.docker!.composeFile))];
        for (const composeFile of uniqueComposeFiles) {
          events.emit("docker_teardown", { taskId, composeFile });
          dockerTearDownFinally(composeFile, adapter.projectRoot, 30_000);
        }
      }
    } catch {
      // Docker teardown failure is non-fatal
    }
    // Clean up any leaked core.worktree from the parent repo's git config.
    // Runs on ALL exit paths: success, failure, kill, timeout, judge_reject.
    // safeUnsetCoreWorktree never throws.
    await safeUnsetCoreWorktree(adapter.projectRoot, events);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Run post-judge verification and conditionally convert an APPROVE verdict
 * to REVISE with specific findings as feedback.
 *
 * Returns the (potentially mutated) judgeResult and a flag indicating
 * whether the verifier triggered the REVISE.
 */
async function runPostJudgeVerifyAndConvert(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  events: IEventWriter,
  judgeResult: JudgeResult,
  attempt: number,
): Promise<{ judgeResult: JudgeResult; triggeredRevise: boolean }> {
  events.emit("post_judge_verify_start", { taskId });
  // Round-2 F2b: post-judge deterministic checks execute worktree-local
  // verification config; under enforce-mode integrity, tampered
  // machinery must stop the run before those checks read or execute it.
  {
    const authoritativeRoot = resolveAuthoritativeRoot(adapter.projectRoot);
    if (authoritativeRoot !== adapter.projectRoot) {
      const floor = await readAuthoritativeSafetyFloor(authoritativeRoot);
      if (floor.preVerificationIntegrityMode === "enforce") {
        const integrity = await checkMachineryIntegrity(adapter.projectRoot, authoritativeRoot);
        if (!integrity.clean) {
          const feedback = formatIntegrityFeedback(integrity);
          events.emit("safety_fact", {
            taskId,
            origin: "verification_integrity",
            facts: [],
            integrityMismatches: integrity.mismatches,
          });
          return {
            judgeResult: {
              ...judgeResult,
              verdict: "REJECT",
              feedback: `[MACHINERY INTEGRITY] ${feedback}`,
            },
            triggeredRevise: false,
          };
        }
      }
    }
  }
  const { runPostJudgeVerification } = await import("./post-judge-verifier.js");
  const verifyResult = await runPostJudgeVerification(
    taskId,
    task,
    adapter,
    adapter.projectRoot,
    events,
  );
  events.emit("post_judge_verify_result", {
    taskId,
    verified: verifyResult.verified,
    findings: verifyResult.findings,
    needsReview: verifyResult.needsReview,
  });
  const judgmentDecision = emitJudgmentProjection(
    events,
    {
      taskId,
      stage: "post_judge",
      attempt,
      sequence: nextPostJudgeSequence(judgeResult),
      final: true,
    },
    () => projectPostJudgeDecision(verifyResult, judgeResult.verdict),
  );

  // Authority inversion: deterministic checks all pass but LLM-based layers
  // flagged issues. Proceed to approval but emit a warning for human review.
  if (verifyResult.needsReview) {
    events.emit("needs_review", {
      taskId,
      reason:
        "Deterministic checks PASS but LLM-based verification flagged issues — proceeding with human review flag",
      buildPassed: verifyResult.buildPassed,
      testsPassed: verifyResult.testsPassed,
      lintPassed: verifyResult.lintPassed,
      flaggedIssues: verifyResult.findings
        .filter((f) => f.status === "fail")
        .map((f) => `${f.criterion}: ${f.evidence}`),
    });
    return {
      judgeResult: judgmentDecision ? { ...judgeResult, judgmentDecision } : judgeResult,
      triggeredRevise: false,
    };
  }

  if (!verifyResult.verified) {
    return {
      judgeResult: {
        ...judgeResult,
        verdict: "REVISE",
        feedback: verifyResult.summary,
        criteriaGaps: verifyResult.findings
          .filter((f) => f.status === "fail")
          .map((f) => f.criterion),
        ...(judgmentDecision ? { judgmentDecision } : {}),
      },
      triggeredRevise: true,
    };
  }

  return {
    judgeResult: judgmentDecision ? { ...judgeResult, judgmentDecision } : judgeResult,
    triggeredRevise: false,
  };
}

function emitJudgeTrace(
  taskId: string,
  attempt: number,
  result: JudgeResult,
  events: IEventWriter,
  final: boolean,
): void {
  const trace = result.judgmentTrace ?? [];
  const lastSequence = trace[trace.length - 1]?.sequence;
  for (const entry of trace) {
    events.emit("judgment_decision", {
      taskId,
      stage: "judge",
      attempt,
      sequence: entry.sequence,
      final: final && entry.sequence === lastSequence,
      decision: entry.decision,
    });
  }
  if (result.judgmentProjectionFailure) {
    events.emit("judgment_projection_failed", {
      taskId,
      stage: "judge",
      attempt,
      sequence: nextTraceSequence(result),
      ...result.judgmentProjectionFailure,
    });
  }
}

function nextTraceSequence(result: JudgeResult): number {
  return Math.max(-1, ...(result.judgmentTrace ?? []).map((entry) => entry.sequence)) + 1;
}

function nextPostJudgeSequence(result: JudgeResult): number {
  return nextTraceSequence(result) + (result.judgmentProjectionFailure ? 1 : 0);
}

/**
 * Load and parse a task file from the adapter's task directory.
 */
async function loadTask(taskId: string, adapter: ProjectAdapter): Promise<ParsedTask> {
  return (await loadTaskWithPath(taskId, adapter)).task;
}

/** TASK-1313 S6: loadTask variant that also returns the spec file path. */
async function loadTaskWithPath(
  taskId: string,
  adapter: ProjectAdapter,
): Promise<{ task: ParsedTask; specPath: string }> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

  const resolved = await resolveTaskFile(taskDir, taskId);
  if (!resolved?.task) {
    throw new Error(`Task file not found for ${taskId} in ${taskDir}`);
  }
  // TASK-1332 round 8 (R8-1): defense in depth. The resolver no longer
  // returns a mismatched parse, but this is the seam where executing the
  // wrong task's contract would actually happen, and a guard that costs
  // one comparison belongs at the seam as well as at the source. It fails
  // LOUD deliberately: silently continuing under the wrong id is the
  // outcome being prevented.
  if (resolved.task.id !== taskId) {
    throw new Error(
      `Task file for ${taskId} in ${taskDir} resolved to ${resolved.fileName}, ` +
        `which declares itself ${resolved.task.id}. Refusing to dispatch one task ` +
        `under another task's id.`,
    );
  }

  return { task: resolved.task, specPath: resolved.filePath };
}

/**
 * Build a retry prompt that includes the original task spec plus
 * the judge's feedback for the agent to address.
 */
function buildRetryPrompt(
  originalTaskSpec: string,
  judgeResult: JudgeResult,
  blueprint?: string,
  priorAgentResult?: AgentResult,
): string {
  const feedbackLines: string[] = [];

  feedbackLines.push("## ⚠️ REVISION REQUIRED (READ THIS FIRST)");
  feedbackLines.push("");
  feedbackLines.push("This is a RETRY. The previous attempt was reviewed and found deficient.");
  feedbackLines.push("Focus ONLY on addressing the issues below. Do NOT start over.");
  feedbackLines.push("");

  if (judgeResult.scopeViolations.length > 0) {
    feedbackLines.push("### Scope Violations");
    for (const violation of judgeResult.scopeViolations) {
      feedbackLines.push(`- ${violation}`);
    }
    feedbackLines.push("");
  }

  if (judgeResult.criteriaGaps.length > 0) {
    feedbackLines.push("### Criteria Gaps");
    for (const gap of judgeResult.criteriaGaps) {
      feedbackLines.push(`- ${gap}`);
    }
    feedbackLines.push("");
  }

  if (judgeResult.qualityIssues.length > 0) {
    feedbackLines.push("### Quality Issues");
    for (const issue of judgeResult.qualityIssues) {
      feedbackLines.push(`- ${issue}`);
    }
    feedbackLines.push("");
  }

  if (judgeResult.feedback) {
    feedbackLines.push("### Judge Feedback");
    feedbackLines.push(judgeResult.feedback);
    feedbackLines.push("");
  }

  // Per-criterion evaluation (shows exactly which criteria passed/failed)
  if (judgeResult.criteriaEvaluation && judgeResult.criteriaEvaluation.length > 0) {
    feedbackLines.push("### Per-Criterion Results");
    for (const crit of judgeResult.criteriaEvaluation) {
      const icon = crit.status === "PASS" ? "✓" : crit.status === "PARTIAL" ? "◐" : "✗";
      feedbackLines.push(`- ${icon} **${crit.status}**: ${crit.criterion}`);
      if (crit.status !== "PASS" && crit.reasoning) {
        feedbackLines.push(`  Reason: ${crit.reasoning}`);
      }
    }
    feedbackLines.push("");
  }

  // Prior run artifacts (verification failures, files modified)
  if (priorAgentResult) {
    if (priorAgentResult.verification && !priorAgentResult.verification.allPassed) {
      feedbackLines.push("### Failed Verification Commands (Prior Run)");
      for (const cmd of priorAgentResult.verification.commands) {
        if (!cmd.passed) {
          feedbackLines.push(`- **${cmd.name}**: FAILED`);
          if (cmd.output) {
            feedbackLines.push(`  \`\`\`\n  ${cmd.output.slice(0, 500)}\n  \`\`\``);
          }
        }
      }
      feedbackLines.push("");
    }

    if (priorAgentResult.filesModified.length > 0 || priorAgentResult.filesCreated.length > 0) {
      feedbackLines.push("### Files Modified in Prior Attempt");
      for (const f of [...priorAgentResult.filesModified, ...priorAgentResult.filesCreated]) {
        feedbackLines.push(`- ${f}`);
      }
      feedbackLines.push("");
    }
  }

  // Include original blueprint so retry agent remembers the plan
  if (blueprint) {
    feedbackLines.push("### Original Implementation Blueprint");
    feedbackLines.push("");
    feedbackLines.push(
      "The following blueprint was provided for this task. " +
        "Review it alongside the judge feedback above — the blueprint " +
        "shows what SHOULD have been implemented; the feedback shows what went wrong.",
    );
    feedbackLines.push("");
    feedbackLines.push(blueprint);
    feedbackLines.push("");
  }

  return `${originalTaskSpec}\n\n---\n\n${feedbackLines.join("\n")}`;
}

/**
 * Build a lean retry prompt for session resume after REVISE.
 *
 * Unlike buildRetryPrompt(), this does NOT include the full task spec or
 * blueprint — those are already in the agent's session history. This prompt
 * only carries the judge's specific complaints for surgical fixes.
 */
function buildRetryResumePrompt(judgeResult: JudgeResult, priorAgentResult?: AgentResult): string {
  const lines: string[] = [];

  lines.push("## REVISION REQUIRED");
  lines.push("");
  lines.push("The judge reviewed your changes and found issues. Fix ONLY the items below.");
  lines.push("Do NOT rewrite code that is already working.");
  lines.push("");

  if (judgeResult.scopeViolations.length > 0) {
    lines.push("### Scope Violations");
    for (const violation of judgeResult.scopeViolations) {
      lines.push(`- ${violation}`);
    }
    lines.push("");
  }

  if (judgeResult.criteriaGaps.length > 0) {
    lines.push("### Criteria Gaps");
    for (const gap of judgeResult.criteriaGaps) {
      lines.push(`- ${gap}`);
    }
    lines.push("");
  }

  if (judgeResult.qualityIssues.length > 0) {
    lines.push("### Quality Issues");
    for (const issue of judgeResult.qualityIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  if (judgeResult.feedback) {
    lines.push("### Judge Feedback");
    lines.push(judgeResult.feedback);
    lines.push("");
  }

  // Per-criterion evaluation for targeted fixes
  if (judgeResult.criteriaEvaluation && judgeResult.criteriaEvaluation.length > 0) {
    const failed = judgeResult.criteriaEvaluation.filter((c) => c.status !== "PASS");
    if (failed.length > 0) {
      lines.push("### Criteria Needing Fixes");
      for (const crit of failed) {
        lines.push(`- **${crit.status}**: ${crit.criterion}`);
        if (crit.reasoning) {
          lines.push(`  Reason: ${crit.reasoning}`);
        }
        if (crit.evidence && crit.evidence !== "not found") {
          lines.push(`  Evidence: ${crit.evidence}`);
        }
      }
      lines.push("");
    }
  }

  // Prior verification failures
  if (priorAgentResult?.verification && !priorAgentResult.verification.allPassed) {
    lines.push("### Failed Verification (Prior Run)");
    for (const cmd of priorAgentResult.verification.commands) {
      if (!cmd.passed) {
        lines.push(`- **${cmd.name}**: FAILED`);
        if (cmd.output) {
          lines.push(`  Output: ${cmd.output.slice(0, 300)}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Handle an APPROVE verdict: push branch, create PR, return result.
 */
async function handleApproval(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  branchName: string | undefined,
  agentResult: AgentResult,
  judgeResult: JudgeResult,
  retriesUsed: number,
  options?: DispatchOptions,
  featureBranch?: string,
  dispatchBaseBranch?: string,
  mergeTargetBranch?: string,
  eventWriter?: IEventWriter,
): Promise<DispatchResult> {
  // Determine diff base for content validation
  const diffBase = dispatchBaseBranch ?? featureBranch ?? adapter.config.git.baseBranch;

  // Docker runs use an isolated private gitdir with no authoritative refs,
  // remotes, config, or hooks. Publishing from that untrusted process would
  // either fail or require restoring the authority boundary this isolation is
  // designed to enforce. A successful child therefore stops at a committed,
  // judged result; the monitor promotes it with an exact old-ref CAS and then
  // performs configured push/PR/merge actions from the trusted host.
  if (process.env.QUACK_DOCKER_HOST_PROMOTION === "1") {
    return {
      taskId,
      outcome: "approved",
      branchName,
      agentResult,
      judgeResult,
      retriesUsed,
    };
  }

  // Push branch (skip if autoPush is disabled in adapter config)
  if (branchName && adapter.config.git.autoPush !== false) {
    // Content validation: verify branch has commits before pushing.
    // Pass branchName explicitly — after worktree teardown, HEAD points to
    // the base branch, so base..HEAD would always be 0 commits.
    const commitCount = await getBranchCommitCount(adapter, diffBase, branchName);
    if (commitCount === 0) {
      return {
        taskId,
        outcome: "error",
        branchName,
        agentResult,
        judgeResult,
        retriesUsed,
        error: `Branch has no commits relative to base — agent work may not have been committed. Worktree preserved for recovery at: ${adapter.projectRoot}`,
      };
    }

    const pushResult = await pushBranch(taskId, adapter);
    if (!pushResult.success) {
      return {
        taskId,
        outcome: "error",
        branchName,
        agentResult,
        judgeResult,
        retriesUsed,
        error: pushResult.error ?? "Failed to push branch",
      };
    }
  }

  // For subtasks with a feature branch, merge to the feature branch
  // instead of the normal autoMergeTarget
  if (featureBranch && options?.parentTaskId && branchName) {
    const { execSync } = await import("node:child_process");
    const cwd = adapter.projectRoot;

    try {
      // Checkout feature branch
      execSync(`git checkout ${featureBranch}`, { cwd, stdio: "pipe" });
      // Merge subtask branch
      execSync(`git merge --no-ff ${branchName} -m "[${taskId}] merge subtask to feature branch"`, {
        cwd,
        stdio: "pipe",
      });

      return {
        taskId,
        outcome: "approved",
        branchName,
        agentResult,
        judgeResult,
        retriesUsed,
        autoMerged: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[subtask-merge] Merge to feature branch failed for ${taskId}: ${msg}`);
      // Non-fatal: branch is pushed, can be merged manually
      return {
        taskId,
        outcome: "approved",
        branchName,
        agentResult,
        judgeResult,
        retriesUsed,
      };
    }
  }

  // Create PR
  let prUrl: string | undefined;
  if (adapter.config.git.autoCreatePr && !options?.skipPr) {
    const prBody = await buildPrBodyWithIssueLink(
      taskId,
      task.rawContent,
      agentResult.verification,
      judgeResult,
      adapter,
    );

    const prResult = await createPullRequest(
      {
        taskId,
        title: `[${taskId}] ${task.title}`,
        body: prBody,
        baseBranch: mergeTargetBranch ?? adapter.config.git.baseBranch,
      },
      adapter,
    );

    if (prResult.success) {
      prUrl = prResult.prUrl;
    }
    // PR creation failure is non-fatal — the branch is pushed
  }

  // Auto-merge to target branch if enabled
  let autoMerged = false;
  let mergeCommitSha: string | undefined;
  if (adapter.config.git.autoMerge && branchName) {
    const targetBranch =
      mergeTargetBranch ?? adapter.config.git.autoMergeTarget ?? adapter.config.git.baseBranch;
    const mergeResult = await mergeBranchToTarget(
      taskId,
      adapter,
      prUrl,
      targetBranch,
      eventWriter,
    );

    if (mergeResult.success) {
      autoMerged = true;
      mergeCommitSha = mergeResult.mergeCommitSha;

      // Update task file status to COMPLETE on the target branch
      const statusResult = await updateTaskFileStatus(taskId, adapter, targetBranch);
      if (!statusResult.success) {
        // Non-fatal: merge succeeded, just couldn't update task file
        console.warn(`[auto-merge] Status update failed for ${taskId}: ${statusResult.error}`);
      }

      // Post-merge branch cleanup (TASK-898)
      if (branchName) {
        const deleteResult = await deleteAfterMerge(branchName, adapter, {
          eventWriter,
        });
        if (!deleteResult.deleted) {
          // Non-fatal — log and continue
          console.warn(
            `[branch-cleanup] deleteAfterMerge skipped for ${branchName}: ${deleteResult.reason}`,
          );
        }
      }
    } else {
      // Merge failed — non-fatal, PR still exists for manual merge
      console.warn(`[auto-merge] Merge failed for ${taskId}: ${mergeResult.error}`);
    }
  }

  return {
    taskId,
    outcome: "approved",
    prUrl,
    branchName,
    agentResult,
    judgeResult,
    retriesUsed,
    autoMerged: autoMerged || undefined,
    mergeCommitSha,
  };
}

/**
 * Clean up stale artifacts from early infrastructure failures.
 *
 * Only cleans up when the checkpoint shows 0 agent turns were completed.
 * If the agent ran (1+ turns), the branch and checkpoint are preserved —
 * many dispatches produce 80-95% correct code that can be manually merged.
 *
 * Artifacts cleaned:
 * - Checkpoint file (.quack/logs/checkpoint-TASK-NNN.json)
 * - Git branch (quack/TASK-NNN-slug) — only if agent never ran
 *
 * Worktree cleanup is handled by DispatchManager's exit handlers, not here.
 */
async function cleanupEarlyFailureArtifacts(
  taskId: string,
  adapter: ProjectAdapter,
  checkpointMgr: CheckpointManager,
): Promise<void> {
  try {
    // Load checkpoint to check if agent did any work
    const checkpoint = await checkpointMgr.load(taskId);

    // If no checkpoint exists, nothing to clean up
    if (!checkpoint) return;

    // If the agent completed any turns, preserve everything for manual review
    const agentRan = checkpoint.completedStages.includes("agent");
    if (agentRan) return;

    // Agent never ran — this was a pure infrastructure failure.
    // Safe to clean up checkpoint and branch.

    // 1. Delete the stale checkpoint
    const deleted = await checkpointMgr.delete(taskId);
    if (deleted) {
      console.log(`[cleanup] Deleted stale checkpoint for ${taskId} (agent never ran)`);
    }

    // 2. Delete the stale branch (only if branch stage completed)
    if (checkpoint.completedStages.includes("branch")) {
      const result = await cleanupBranch(taskId, adapter, undefined);
      if (result.success) {
        console.log(
          `[cleanup] Deleted stale branch ${result.branchName} for ${taskId} (agent never ran)`,
        );
      }
      // Branch cleanup failure is non-fatal — may already be deleted
    }
  } catch (err) {
    // Cleanup is best-effort — never throw from here
    console.error(`[cleanup] Error cleaning up artifacts for ${taskId}: ${String(err)}`);
  }
}

/**
 * Create follow-up task specs from judge's non-blocking suggestions.
 * Generates TASK-{parentId}-FU{N}.md files in the task directory.
 * These are BACKLOG tasks blocked by the parent — they won't auto-dispatch.
 * Runs dedup check: if a similar task already exists in the backlog,
 * appends a linked-from comment to the existing task instead of creating a new spec.
 */
export async function createFollowUpTasks(
  parentTaskId: string,
  parentTask: ParsedTask,
  adapter: ProjectAdapter,
  followUpItems: FollowUpItem[],
  events: IEventWriter,
): Promise<string[]> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await fs.mkdir(taskDir, { recursive: true });

  const createdPaths: string[] = [];

  // Load backlog entries and ignore list once for the whole batch
  const {
    loadBacklogEntries,
    loadIgnoreList,
    findSimilarTask,
    appendLinkedFromComment,
    combinedSimilarity,
  } = await import("./follow-up-dedup.js");
  const backlogEntries = await loadBacklogEntries(taskDir).catch(() => []);
  const ignoredPatterns = await loadIgnoreList(adapter.projectRoot).catch(() => []);

  let claimantQuery: Promise<string[]> | undefined;
  let followUpRefused = false;
  const allowMutation = async (): Promise<boolean> => {
    claimantQuery ??= listDuplicateClaimants(taskDir, parentTaskId);
    const claimants = await claimantQuery;
    if (claimants.length === 0) return true;

    if (!followUpRefused) {
      followUpRefused = true;
      events.emit("follow_up_tasks_refused", {
        parentTaskId,
        errorType: "duplicate_claimants",
        claimants,
      });
    }
    return false;
  };

  let fuIndex = 1;
  for (const item of followUpItems) {
    try {
      // Check if this follow-up matches an ignored pattern
      const ignoredMatch = ignoredPatterns.some(
        (pattern) => combinedSimilarity(item.title, pattern) >= 0.7,
      );
      if (ignoredMatch) {
        console.error(
          `[follow-up] Suppressed "${item.title}" — matched operator ignore list for ${parentTaskId}`,
        );
        continue;
      }

      // Dedup check: find a similar existing task
      const similar = findSimilarTask(item.title, backlogEntries);
      if (similar) {
        // Append a reference to the existing task instead of creating a new one
        await appendLinkedFromComment(similar.filePath, parentTaskId, allowMutation).catch(() => {
          // Non-fatal: append failure should not block the rest
        });
        if (followUpRefused) break;
        continue;
      }
    } catch (dedupErr) {
      // Dedup errors are non-fatal — fall through to create the spec normally
      console.error(
        `[follow-up] Dedup check failed for "${item.title}" (parent ${parentTaskId}): ${String(dedupErr)}`,
      );
    }

    const subtaskId = `${parentTaskId}-FU${fuIndex++}`;
    const slug = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
    const fileName = `${subtaskId}-${slug}.md`;
    const filePath = path.join(taskDir, fileName);

    const spec = buildFollowUpSpec(subtaskId, item, parentTaskId, parentTask);

    if (!(await allowMutation())) break;
    await fs.writeFile(filePath, spec, "utf-8");
    createdPaths.push(filePath);
  }

  if (followUpRefused) return [];

  if (createdPaths.length > 0) {
    events.emit("follow_up_tasks_created", {
      parentTaskId,
      count: createdPaths.length,
      taskIds: createdPaths.map((p) => path.basename(p, ".md")),
    });
  }

  return createdPaths;
}

/**
 * Build a follow-up task spec from a judge suggestion.
 */
function buildFollowUpSpec(
  taskId: string,
  item: FollowUpItem,
  parentTaskId: string,
  parentTask: ParsedTask,
): string {
  const lines: string[] = [];

  lines.push(`# ${taskId}: ${item.title}`);
  lines.push("");
  lines.push("## Metadata");
  lines.push(`- **Priority:** P3-LOW`);
  lines.push(`- **Effort:** ${item.estimatedEffort ?? "1-2 hours"}`);
  lines.push(`- **Status:** BACKLOG`);
  lines.push(`- **Blocked By:** [${parentTaskId}]`);
  lines.push(`- **Blocks:** []`);
  lines.push(`- **Tags:** follow-up, ${item.type}, auto-generated`);
  lines.push("");
  lines.push("## Problem Statement");
  lines.push("");
  lines.push(
    `This follow-up was identified during the judge review of ${parentTaskId} (${parentTask.title}).`,
  );
  lines.push(`The parent task was APPROVED — this is a non-blocking improvement.`);
  lines.push("");
  lines.push(item.description);
  lines.push("");
  lines.push("## Files to Modify");
  lines.push("| File | Action | Notes |");
  lines.push("|------|--------|-------|");
  lines.push("| TBD | Modify | Determine during implementation |");
  lines.push("");
  lines.push("## Success Criteria");
  lines.push(`- [ ] ${item.description}`);
  lines.push("");
  lines.push("## Testing Requirements");
  lines.push("- [ ] All existing tests still pass");
  lines.push("- [ ] New tests added for any changed behavior");
  lines.push("");
  lines.push("## Anti-Patterns");
  lines.push("- Do NOT modify unrelated code — this is a focused follow-up");
  lines.push("");
  lines.push("## Context References");
  lines.push(`- Parent task: ${parentTaskId}`);
  lines.push(`- Category: ${item.type}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Discover and copy Claude Code transcripts for a completed agent/judge run.
 * Emits a transcript_linked event if transcripts are found.
 */
async function linkTranscripts(
  taskId: string,
  adapter: ProjectAdapter,
  events: IEventWriter,
  runStartTime: number,
  attemptNumber: number,
): Promise<void> {
  try {
    const transcripts = await discoverTranscripts(
      adapter.projectRoot,
      taskId,
      runStartTime,
      Date.now(),
    );

    if (transcripts.length === 0) return;

    const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
    const claudeSessionIds: string[] = [];
    const transcriptPaths: string[] = [];

    for (const transcript of transcripts) {
      const result = await copyTranscript(
        transcript.sourcePath,
        logDir,
        events.sessionId,
        attemptNumber,
      );
      claudeSessionIds.push(transcript.claudeSessionId);
      if (result.success && result.destPath) {
        transcriptPaths.push(result.destPath);
      }
      // Only link one transcript per attempt (closest match is first)
      break;
    }

    if (claudeSessionIds.length > 0) {
      events.emit("transcript_linked", {
        claudeSessionIds,
        transcriptPaths,
      });
    }
  } catch {
    // Transcript linking is non-fatal — don't break the pipeline
  }
}

/**
 * Update analytics database with run results (non-blocking).
 * Called after session completion to build failure pattern history.
 */
function updateRunAnalytics(
  task: ParsedTask,
  sessionId: string,
  outcome: "approved" | "rejected" | "error",
  totalCostUsd: number,
  durationMs: number,
  retriesUsed: number,
  adapter: ProjectAdapter,
  agentResult?: AgentResult,
  judgeResult?: JudgeResult,
  gateScore?: number,
  blueprintMetrics?: { fileAnalyses: number; codeExamples: number },
): void {
  try {
    const runAnalysis = analyzeRun({
      sessionId,
      task,
      agentResult,
      judgeResult,
      outcome,
      totalCostUsd,
      durationMs,
      retriesUsed,
      gateScore,
      blueprintMetrics,
    });
    updateAnalytics(runAnalysis, adapter.projectRoot);
  } catch {
    // Analytics update failure is non-fatal
  }
}

/**
 * Get the branch diff, auto-committing any uncommitted changes first.
 * This is a safety net for when the agent forgets to commit.
 */
export async function ensureDiffOrAutoCommit(
  taskId: string,
  adapter: ProjectAdapter,
  events: IEventWriter,
  diffBase?: string,
): Promise<string> {
  const snapshot = await sealAgentOutputAttempt({
    taskId,
    adapter,
    events,
    attempt: 1,
    kind: "worker",
    diffBase,
  });
  return snapshot.gitDiff;
}

/**
 * Ensure the working directory is on the shared branch with latest commits.
 * This guarantees that later subtasks see code committed by earlier subtasks.
 * Called before each subtask starts when using a shared branch.
 */
async function ensureSharedBranchCheckout(
  branchName: string,
  adapter: ProjectAdapter,
  events: IEventWriter,
): Promise<void> {
  const { execSync } = await import("node:child_process");
  const cwd = adapter.projectRoot;

  try {
    // Check current branch
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
    }).trim();

    if (currentBranch !== branchName) {
      // Check if the branch exists
      try {
        execSync(`git rev-parse --verify ${branchName}`, {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Branch exists — checkout to it
        execSync(`git checkout ${branchName}`, { cwd, encoding: "utf-8" });
      } catch {
        // Branch doesn't exist yet — create it (first subtask in chain)
        execSync(`git checkout -b ${branchName}`, { cwd, encoding: "utf-8" });
      }
    }

    events.emit("branch_created", {
      branchName,
      shared: true,
      action: "checkout",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    events.emit("session_error", {
      error: `Failed to checkout shared branch ${branchName}: ${msg}`,
      failedStage: "shared_branch_checkout",
    });
    // Non-fatal — proceed with current branch state
  }
}

/**
 * Determine if a subtask is the final subtask in a decomposition.
 * The final subtask is identified by the "All parent task success criteria verified"
 * criterion in its success criteria, which is added by the decomposer.
 *
 * @param taskId - Current subtask ID (e.g., "TASK-042-C")
 * @param parentTaskId - Parent task ID (e.g., "TASK-042")
 * @returns true if this is the final subtask
 */
function isFinalSubtask(taskId: string, parentTaskId: string): boolean {
  // Check if taskId matches the subtask pattern TASK-NNN-X
  const subtaskPattern = new RegExp(
    `^${parentTaskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Z]$`,
  );
  return subtaskPattern.test(taskId);
}

/**
 * Check if a parsed task contains the final subtask integration criterion.
 * Used to definitively identify the final subtask in a decomposition.
 */
export function hasFinalSubtaskCriterion(task: ParsedTask): boolean {
  return task.successCriteria.some((c) =>
    c.toLowerCase().includes("all parent task success criteria verified"),
  );
}
