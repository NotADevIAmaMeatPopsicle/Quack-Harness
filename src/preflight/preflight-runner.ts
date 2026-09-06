// Pre-Flight Runner
// Orchestrates the full pre-flight pipeline:
// gate -> blueprint -> context assembly -> complexity evaluation -> cache
//
// Pre-flight runs BEFORE dispatch to give operators visibility into
// blueprint quality, context size, and complexity. Results are cached
// and reused by the dispatcher to skip redundant blueprint generation.

import * as path from "node:path";

import type { ParsedTask, GateResult, ContextSizeEstimate } from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { PreflightResult, ComplexityThresholds } from "./preflight-types.js";
import { DEFAULT_COMPLEXITY_THRESHOLDS } from "./preflight-types.js";
import { evaluateComplexity } from "./complexity-evaluator.js";
import { runReadinessGate } from "../gate/gate.js";
import { validateTaskSchema } from "../gate/schema-validator.js";
import { generateBlueprint } from "../blueprint/blueprint-agent.js";
import { formatBlueprintForPrompt } from "../blueprint/blueprint-prompt.js";
import { assembleContext } from "../dispatcher/context-assembler.js";
import { PrepCache, computeContentHash } from "../monitor/prep-cache.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { getAdminRunStagePolicy, type AdminRunStage } from "../monitor/admin-run-stage-policy.js";
import type { SpecReviewResult } from "./spec-review-types.js";
import { reviewSpecAmbiguity } from "./spec-reviewer.js";
import { decomposeTask } from "./task-decomposer.js";
import { writeSubtaskSpecs, commitSubtaskSpecs } from "./subtask-writer.js";
import { buildFallbackChildDraft } from "./subtask-materializer.js";
import { runChildQualityGate } from "./subtask-quality-gate.js";
import { toRuntimeDiagnostics, type RuntimeDiagnostics } from "../core/runtime-errors.js";
import { ReadinessService } from "../monitor/readiness-service.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";

export type PreflightStageName = Extract<
  AdminRunStage,
  "gate" | "spec_review" | "blueprint" | "analysis" | "decompose"
>;

export interface PreflightStageReporter {
  started(stage: PreflightStageName, detail?: string): void | Promise<void>;
  heartbeat(stage: PreflightStageName, detail?: string): void | Promise<void>;
  completed(stage: PreflightStageName, detail?: string): void | Promise<void>;
  failed(stage: PreflightStageName, error: string, detail?: string): void | Promise<void>;
}

export interface PreflightOptions {
  /** Skip gate checks (assume ready) */
  skipGate?: boolean;
  /** Force re-run even if cache is fresh */
  force?: boolean;
  /** Pipeline mode. "deterministic" skips runtime-dependent LLM steps. */
  mode?: "auto" | "deterministic";
  /** Event writer for pipeline monitoring */
  events?: IEventWriter;
  /** Optional stage reporter for admin-run checkpoint heartbeats. */
  stageReporter?: PreflightStageReporter;
  /** Heartbeat cadence for long preflight stages. */
  stageHeartbeatIntervalMs?: number;
}

/**
 * Run the full pre-flight pipeline for a task.
 *
 * Steps:
 * 1. Check cache (unless force=true)
 * 2. Run gate checks (schema + depth evaluation)
 * 3. Generate blueprint via Blueprint Agent
 * 4. Format blueprint for prompt inclusion
 * 5. Dry-run context assembly to get size estimates
 * 6. Evaluate complexity against thresholds
 * 7. Cache and return the result
 *
 * @param task - The parsed task specification
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional configuration
 * @returns Full PreflightResult with gate, blueprint, context, and complexity data
 */
export async function runPreflight(
  task: ParsedTask,
  adapter: ProjectAdapter,
  options?: PreflightOptions,
): Promise<PreflightResult> {
  const events = options?.events;
  const stageReporter = options?.stageReporter;
  const stageHeartbeatIntervalMs = options?.stageHeartbeatIntervalMs ?? 30_000;

  events?.emit("preflight_start", { taskId: task.id });

  // Compute content hash for cache validation
  const taskContent = task.rawContent;
  const contentHash = computeContentHash(taskContent);

  // TASK-1315: gate authority is mode-scoped; a flip invalidates.
  const readinessJudgmentMode = adapter.config.judgment?.stages.readiness.mode ?? "off";

  // Check cache (unless force)
  if (!options?.force) {
    const cache = new PrepCache(adapter.projectRoot);
    const cached = await cache.readPreflight(task.id, contentHash, readinessJudgmentMode);
    if (cached) {
      events?.emit("preflight_complete", {
        taskId: task.id,
        cached: true,
        recommendDecomposition: cached.complexity.recommendDecomposition,
      });
      return cached;
    }
  }

  // Get complexity thresholds from adapter config
  const thresholds: ComplexityThresholds =
    adapter.config.preflight?.complexityThresholds ?? DEFAULT_COMPLEXITY_THRESHOLDS;
  const requestedMode = options?.mode ?? "auto";
  let executionMode: "full" | "deterministic" =
    requestedMode === "deterministic" ? "deterministic" : "full";
  let fallbackDiagnostics: RuntimeDiagnostics | undefined;
  const degradedChecksRun = new Set<string>();
  const degradedChecksSkipped = new Set<string>();

  const runStage = async <T>(
    stage: PreflightStageName,
    detail: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const policy = getAdminRunStagePolicy(stage);
    events?.emit("stage_started", {
      taskId: task.id,
      scope: "preflight",
      stage,
      staleAfterMs: policy.outputStaleAfterMs,
      recommendedAction: policy.recommendedAction,
      detail,
    });
    await Promise.resolve(stageReporter?.started(stage, detail));

    let heartbeatTimer: NodeJS.Timeout | undefined;
    if (stageHeartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        events?.emit("stage_heartbeat", {
          taskId: task.id,
          scope: "preflight",
          stage,
          staleAfterMs: policy.outputStaleAfterMs,
          recommendedAction: policy.recommendedAction,
          detail,
        });
        void Promise.resolve(stageReporter?.heartbeat(stage, detail));
      }, stageHeartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    try {
      const result = await work();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      events?.emit("stage_completed", {
        taskId: task.id,
        scope: "preflight",
        stage,
        detail,
      });
      await Promise.resolve(stageReporter?.completed(stage, detail));
      return result;
    } catch (err: unknown) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const message = err instanceof Error ? err.message : String(err);
      events?.emit("stage_failed", {
        taskId: task.id,
        scope: "preflight",
        stage,
        error: message,
        recommendedAction: policy.recommendedAction,
        detail,
      });
      await Promise.resolve(stageReporter?.failed(stage, message, detail));
      throw err;
    }
  };

  // Step 1: Gate checks
  let gateReady = true;
  let gateScore = 5;
  let gateDimensions: Record<string, number> = {};
  let gateAdvisories: string[] = [];
  let gateActiveOutcome: "pass" | "enriched" | "rejected" | undefined;
  let gateOrchestration: NonNullable<PreflightResult["gate"]["orchestration"]> | undefined;

  if (!options?.skipGate) {
    await runStage("gate", "Evaluating readiness gate.", async () => {
      events?.emit("preflight_gate", { taskId: task.id });
      if (executionMode === "deterministic") {
        const deterministicGate = runDeterministicGate(task);
        gateReady = deterministicGate.ready;
        gateScore = deterministicGate.score;
        gateDimensions = deterministicGate.dimensions;
        degradedChecksRun.add("gate.schema");
        degradedChecksSkipped.add("gate.depth");
        return;
      }

      try {
        const gateResult: GateResult = await runReadinessGate(
          task,
          adapter,
          { skipEnrichment: true },
          events,
        );
        degradedChecksRun.add("gate.schema");
        degradedChecksRun.add("gate.depth");

        gateActiveOutcome = gateResult.outcome;
        if (gateResult.judgmentOrchestration) {
          const orchestration = gateResult.judgmentOrchestration;
          gateOrchestration = {
            mode: orchestration.mode,
            attempted: orchestration.attempted,
            reason: orchestration.reason,
            diverged: orchestration.diverged,
            ...(orchestration.attempted
              ? { rationale: [...orchestration.activeDecision.judgment.rationale] }
              : {}),
          };
        }

        if (gateResult.outcome === "rejected") {
          gateReady = false;
          if ("details" in gateResult && gateResult.details) {
            if ("overallScore" in gateResult.details) {
              gateScore = gateResult.details.overallScore;
              gateDimensions = gateResult.details.scores as unknown as Record<string, number>;
              gateAdvisories = (gateResult.details.deficiencies ?? []).filter((deficiency) =>
                deficiency.startsWith("ADVISORY:"),
              );
            } else {
              gateScore = 0;
            }
          }
        } else if (gateResult.outcome === "pass" || gateResult.outcome === "enriched") {
          gateReady = true;
          gateScore = 5;
          gateAdvisories = gateResult.advisories ?? [];
        }
      } catch (err: unknown) {
        fallbackDiagnostics = toRuntimeDiagnostics(err, "preflight.gate");
        executionMode = "deterministic";
        const deterministicGate = runDeterministicGate(task);
        gateReady = deterministicGate.ready;
        gateScore = deterministicGate.score;
        gateDimensions = deterministicGate.dimensions;
        degradedChecksRun.add("gate.schema");
        degradedChecksSkipped.add("gate.depth");

        events?.emit("preflight_runtime_unavailable", {
          taskId: task.id,
          stage: fallbackDiagnostics.stage,
          kind: fallbackDiagnostics.kind,
          retryable: fallbackDiagnostics.retryable,
        });
        events?.emit("preflight_degraded", {
          taskId: task.id,
          mode: executionMode,
          reason: "runtime_unavailable",
        });
      }
    });
  }

  // Step 1.5: Spec ambiguity review
  let specReview: SpecReviewResult | undefined;
  const reviewConfig = adapter.config.preflight?.specReview;
  const reviewEnabled = reviewConfig?.enabled ?? true;
  if (reviewEnabled && executionMode === "full") {
    await runStage("spec_review", "Reviewing spec ambiguity.", async () => {
      try {
        specReview = await reviewSpecAmbiguity(task, {
          model: reviewConfig?.model,
        });
        degradedChecksRun.add("spec_review");
        events?.emit("preflight_spec_review", {
          taskId: task.id,
          riskLevel: specReview.riskLevel,
          ambiguityCount: specReview.ambiguityCount,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        events?.emit("preflight_spec_review_failed", {
          taskId: task.id,
          error: msg,
        });
        // Non-fatal - continue preflight without spec review
      }
    });
  } else if (reviewEnabled) {
    degradedChecksSkipped.add("spec_review");
  }

  // Step 2: Generate blueprint
  let blueprint: Awaited<ReturnType<typeof generateBlueprint>> | undefined;
  let blueprintMarkdown = buildDeterministicBlueprint(task);
  let blueprintSummary: {
    fileAnalyses: number;
    codeExamples: number;
    verificationPatterns: number;
    antiPatterns: number;
  } = {
    fileAnalyses: task.filesToModify.length,
    codeExamples: 0,
    verificationPatterns: task.successCriteria.length,
    antiPatterns: 0,
  };

  await runStage("blueprint", "Generating implementation blueprint.", async () => {
    events?.emit("preflight_blueprint", { taskId: task.id });
    if (executionMode === "deterministic") {
      blueprintMarkdown = buildDeterministicBlueprint(task);
      blueprintSummary = {
        fileAnalyses: task.filesToModify.length,
        codeExamples: 0,
        verificationPatterns: task.successCriteria.length,
        antiPatterns: 0,
      };
      degradedChecksRun.add("blueprint.deterministic");
      degradedChecksSkipped.add("blueprint.llm");
      return;
    }

    try {
      blueprint = await generateBlueprint(task, adapter);
      blueprintMarkdown = formatBlueprintForPrompt(blueprint);
      blueprintSummary = {
        fileAnalyses: blueprint.fileAnalyses.length,
        codeExamples: blueprint.codeExamples.length,
        verificationPatterns: blueprint.verificationPatterns.length,
        antiPatterns: blueprint.antiPatterns.length,
      };
      degradedChecksRun.add("blueprint.llm");
    } catch (err: unknown) {
      fallbackDiagnostics ??= toRuntimeDiagnostics(err, "preflight.blueprint");
      executionMode = "deterministic";
      blueprintMarkdown = buildDeterministicBlueprint(task);
      blueprintSummary = {
        fileAnalyses: task.filesToModify.length,
        codeExamples: 0,
        verificationPatterns: task.successCriteria.length,
        antiPatterns: 0,
      };
      degradedChecksRun.add("blueprint.deterministic");
      degradedChecksSkipped.add("blueprint.llm");

      events?.emit("preflight_runtime_unavailable", {
        taskId: task.id,
        stage: fallbackDiagnostics.stage,
        kind: fallbackDiagnostics.kind,
        retryable: fallbackDiagnostics.retryable,
      });
      events?.emit("preflight_degraded", {
        taskId: task.id,
        mode: executionMode,
        reason: "runtime_unavailable",
      });
    }
  });

  // Step 3: Context assembly (dry-run for estimates)
  let contextEstimate: ContextSizeEstimate = estimateDeterministicContext(task, blueprintMarkdown);
  await runStage("analysis", "Assembling context and complexity estimates.", async () => {
    events?.emit("preflight_analysis", { taskId: task.id });
    try {
      const context = await assembleContext(task, adapter, blueprintMarkdown);
      contextEstimate =
        context.contextSizeEstimate ?? estimateDeterministicContext(task, blueprintMarkdown);
      degradedChecksRun.add("context.assembly");
    } catch (err: unknown) {
      if (executionMode !== "deterministic") {
        throw err;
      }
      fallbackDiagnostics ??= toRuntimeDiagnostics(err, "preflight.context");
      contextEstimate = estimateDeterministicContext(task, blueprintMarkdown);
      degradedChecksRun.add("context.estimate");
      degradedChecksSkipped.add("context.assembly");
    }
  });

  // Step 4: Complexity evaluation
  const complexity = evaluateComplexity(task, contextEstimate, thresholds);

  // Step 5: Auto-decomposition (if enabled and recommended)
  let decomposition: PreflightResult["decomposition"];
  let autoDecomposeRefused = false;
  const autoDecomposeConfig = adapter.config.preflight?.autoDecompose;
  const blueprintForDecompose = blueprint;
  // Skip auto-decompose if the task is itself an auto-decomposed subtask:
  // matches `TASK-NNN-A`, `TASK-NNN-B`, etc. The subtask-writer suffixes
  // children with single uppercase letters; preventing recursion here keeps
  // us from emitting TASK-NNN-A-A / TASK-NNN-A-B noise specs that pollute
  // the working tree on every preflight of an already-decomposed parent.
  const isAutoDecomposedSubtask = /^TASK-\d+-[A-Z]$/.test(task.id);
  // Skip auto-decompose when the blueprint has no fileAnalyses: the
  // decomposer has nothing concrete to slice along, so subtasks come back
  // vague and fail the readiness gate. Better to surface the empty
  // blueprint to the operator than to emit low-quality subtask specs.
  const blueprintEmpty = !blueprintForDecompose || blueprintSummary.fileAnalyses === 0;
  if (
    executionMode === "full" &&
    autoDecomposeConfig?.enabled &&
    complexity.recommendDecomposition &&
    gateReady &&
    !isAutoDecomposedSubtask &&
    blueprintEmpty
  ) {
    events?.emit("preflight_auto_decompose_skipped", {
      taskId: task.id,
      reason: "empty_blueprint",
      blueprintFileAnalyses: blueprintSummary.fileAnalyses,
    });
  } else if (
    executionMode === "full" &&
    blueprintForDecompose &&
    autoDecomposeConfig?.enabled &&
    complexity.recommendDecomposition &&
    gateReady &&
    !isAutoDecomposedSubtask
  ) {
    await runStage("decompose", "Auto-decomposing complex task.", async () => {
      events?.emit("preflight_auto_decompose", {
        taskId: task.id,
        reason: complexity.reason,
      });

      try {
        const plan = await decomposeTask(task, adapter, blueprintForDecompose, {
          maxSubtasks: autoDecomposeConfig.maxSubtasks,
        });

        let subtaskFiles: string[] = [];
        if (autoDecomposeConfig.writeSpecs && plan.subtasks.length > 0) {
          const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
          const claimants = await listDuplicateClaimants(taskDir, task.id);
          if (claimants.length > 0) {
            autoDecomposeRefused = true;
            decomposition = {
              decomposed: false,
              subtaskIds: plan.subtasks.map((subtask) => subtask.id),
              subtaskFiles: [],
              refused: {
                errorType: "duplicate_claimants",
                claimants,
              },
            };
            events?.emit("preflight_auto_decompose_refused", {
              taskId: task.id,
              errorType: "duplicate_claimants",
              claimants,
            });
            return;
          }
          // Convert topology subtasks to ChildDraft[] using fallback drafts
          // (auto-decompose does not go through the materializer LLM step)
          const fallbackDrafts = plan.subtasks.map((subtask) => {
            const markdown = buildFallbackChildDraft(subtask, task);
            const gate = runChildQualityGate(subtask.id, markdown);
            return {
              subtaskId: subtask.id,
              title: subtask.title,
              markdown,
              sectionsPresent: gate.sectionsPresent,
              prepScore: gate.prepScore,
              prepReady: gate.prepReady,
              deficiencies: gate.deficiencies,
              parseError: gate.parseError,
            };
          });
          subtaskFiles = await writeSubtaskSpecs(fallbackDrafts, adapter);

          // TASK-900: auto-commit subtask specs so dispatcher worktrees
          // (which materialize from the object database via `git worktree
          // add`) can resolve them at session_start.
          try {
            const commitResult = await commitSubtaskSpecs(adapter, subtaskFiles, task.id);
            events?.emit("preflight_auto_decompose_specs_committed", {
              taskId: task.id,
              committed: commitResult.committed,
              sha: commitResult.sha,
              staged: commitResult.staged,
            });
          } catch (commitErr) {
            const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
            events?.emit("preflight_auto_decompose_specs_commit_failed", {
              taskId: task.id,
              error: commitMsg,
              subtaskFiles,
            });
            // Non-fatal — disk writes succeeded; operator can commit manually.
          }
        }

        // QPI-048 leg (e): `decomposed` means CHILDREN EXIST. With
        // writeSpecs suppressed the plan is ADVISORY — before this, the
        // record claimed a decomposition whose children were never
        // written, and the dispatch gate then refused the parent for
        // phantom subtasks (structurally undispatched without cache
        // surgery — the opposite of the advisory flip's intent).
        decomposition = {
          decomposed: subtaskFiles.length > 0,
          subtaskIds: plan.subtasks.map((s) => s.id),
          subtaskFiles,
          ...(plan.subtasks.length > 0 && subtaskFiles.length === 0 ? { advisoryOnly: true } : {}),
        };

        events?.emit("preflight_auto_decompose_complete", {
          taskId: task.id,
          subtaskCount: plan.subtasks.length,
          subtaskIds: decomposition.subtaskIds,
          filesWritten: subtaskFiles.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        events?.emit("preflight_auto_decompose_failed", {
          taskId: task.id,
          error: msg,
        });
        // Non-fatal - preflight continues without decomposition
      }
    });
  } else if (autoDecomposeConfig?.enabled && executionMode !== "full") {
    degradedChecksSkipped.add("auto_decompose");
  }

  // TASK-1306: persist the STRUCTURED blueprint (LLM path only — the
  // deterministic path has no structured object; honesty over stubs).
  // Defensive size guard: past 256KB (~8x the formatter's prompt cap,
  // pathological) store it absent with an event note — a truncated brief
  // would lie, so omission is the honest degradation.
  const STRUCTURED_MAX_CHARS = 256_000;
  let structuredForStore: typeof blueprint;
  if (blueprint) {
    const structuredSize = JSON.stringify(blueprint).length;
    if (structuredSize <= STRUCTURED_MAX_CHARS) {
      structuredForStore = blueprint;
    } else {
      events?.emit("blueprint_structured_omitted", {
        taskId: task.id,
        bytes: structuredSize,
        limit: STRUCTURED_MAX_CHARS,
      });
    }
  }

  // Build result
  const result: PreflightResult = {
    taskId: task.id,
    timestamp: new Date().toISOString(),
    contentHash,
    gate: {
      ready: gateReady,
      score: gateScore,
      dimensions: gateDimensions,
      ...(gateAdvisories.length > 0 ? { advisories: gateAdvisories } : {}),
      readinessJudgmentMode,
      ...(options?.skipGate ? { gateSkipped: true } : {}),
      ...(gateActiveOutcome ? { activeOutcome: gateActiveOutcome } : {}),
      ...(gateOrchestration ? { orchestration: gateOrchestration } : {}),
    },
    blueprint: {
      fileAnalyses: blueprintSummary.fileAnalyses,
      codeExamples: blueprintSummary.codeExamples,
      verificationPatterns: blueprintSummary.verificationPatterns,
      antiPatterns: blueprintSummary.antiPatterns,
      formattedMarkdown: blueprintMarkdown,
      ...(structuredForStore ? { structured: structuredForStore } : {}),
      // TASK-1324 round-2 F1: the verdict persists even when the
      // structured object is dropped for size — the cached path must
      // never read an audited brief as unchecked.
      ...(blueprint?.fidelity ? { fidelity: blueprint.fidelity } : {}),
    },
    contextEstimate,
    complexity,
    specReview,
    decomposition,
    mode: executionMode,
    degraded: fallbackDiagnostics
      ? {
          reason: "Runtime-dependent stages unavailable; deterministic fallback executed",
          diagnostics: fallbackDiagnostics,
          checksRun: Array.from(degradedChecksRun),
          checksSkipped: Array.from(degradedChecksSkipped),
        }
      : undefined,
  };

  // A duplicate-claimant refusal is not a readiness result. Skipping the
  // entire persistence block preserves both a clean store and any prior entry.
  if (!autoDecomposeRefused) {
    const cache = new PrepCache(adapter.projectRoot);
    await cache.writePreflight(result);

    const readiness = new ReadinessService({
      projectRoot: adapter.projectRoot,
    });
    try {
      readiness.persistPreflightResult(task.id, taskContent, result);
    } finally {
      readiness.close();
    }
  }

  events?.emit("preflight_complete", {
    taskId: task.id,
    cached: false,
    recommendDecomposition: complexity.recommendDecomposition,
    mode: executionMode,
    degraded: Boolean(fallbackDiagnostics),
  });

  return result;
}

function runDeterministicGate(task: ParsedTask): {
  ready: boolean;
  score: number;
  dimensions: Record<string, number>;
} {
  const schema = validateTaskSchema(task);
  if (!schema.valid) {
    return {
      ready: false,
      score: 0,
      dimensions: {},
    };
  }
  return {
    ready: true,
    score: 3,
    dimensions: {},
  };
}

function buildDeterministicBlueprint(task: ParsedTask): string {
  const files =
    task.filesToModify.length > 0
      ? task.filesToModify.map((f) => `- ${f.path} (${f.action})`).join("\n")
      : "- No file targets declared in spec";
  const checks =
    task.successCriteria.length > 0
      ? task.successCriteria.map((criterion) => `- ${criterion}`).join("\n")
      : "- No explicit success criteria";
  return [
    "## Deterministic Blueprint (Degraded Mode)",
    "",
    "Runtime-dependent blueprint generation was unavailable. This fallback keeps deterministic execution moving.",
    "",
    "### Files to Touch",
    files,
    "",
    "### Verification Targets",
    checks,
  ].join("\n");
}

function estimateDeterministicContext(
  task: ParsedTask,
  blueprintMarkdown: string,
): ContextSizeEstimate {
  const taskSpec = Math.ceil(task.rawContent.length / 4);
  const blueprint = Math.ceil(blueprintMarkdown.length / 4);
  const total = taskSpec + blueprint;
  return {
    taskSpec,
    blueprint,
    repoMap: 0,
    relevantFiles: 0,
    relatedPatterns: 0,
    existingTests: 0,
    conventions: 0,
    claudeMd: 0,
    total,
    withinBudget: total <= 35_000,
  };
}
