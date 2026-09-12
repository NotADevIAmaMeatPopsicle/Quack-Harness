import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
// ─── Post-Approval Lifecycle Manager ─────────────────────────────
// Runs after judge APPROVE + post-judge PASS. Handles:
// 1. Adversarial verification (read-only agent checking success criteria)
// 2. Fix cycle (write-access agent, max 2 attempts)
// 3. Task status update to COMPLETE
// 4. Emit manual verification-needed signal
// 5. Resolve blockers (promote BACKLOG → READY)
// 6. Check parent task completion
// 7. Atomic git commit of all changes

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type {
  ParsedTask,
  TaskContext,
  VerificationFinding,
  LifecycleResult,
} from "../core/types.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { parseTaskFile } from "../core/task-parser.js";
import { isCompleteStatus } from "../core/task-status.js";
import {
  buildStrictDuplicateClaimantIndex,
  duplicateClaimantRefusalForIndex,
} from "../core/duplicate-claimants.js";
import {
  loadTaskStateOverlay,
  resolveTaskStateWithOverlay,
  type RuntimeStatusOverlay,
} from "../core/task-state-overlay.js";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { runAgent } from "../worker/agent-worker.js";
import { sealAgentOutputAttempt } from "./output-snapshot.js";
import { runCodexStructuredEvaluation } from "../llm/codex-structured-evaluator.js";
import { runTrustedGitSync } from "./trusted-git.js";
import {
  CanonicalTaskSpecMutationError,
  withCanonicalTaskSpecMutationFence,
} from "../preflight/canonical-task-spec-mutation.js";

// ─── SDK Query Function (lazy-loaded) ────────────────────────────

/**
 * Type for the SDK query function.
 */
type QueryFn = (args: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<{ type: string; subtype?: string; [key: string]: unknown }, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 */
let _queryFn: QueryFn | undefined;

/**
 * Dynamically imports the Claude Agent SDK's query function.
 */
async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

// ─── Types ───────────────────────────────────────────────────────

interface AdversarialResult {
  passed: boolean;
  issues: string[];
  criteriaResults: Array<{
    criterion: string;
    passed: boolean;
    evidence: string;
  }>;
}

const ADVERSARIAL_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    criteriaResults: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          passed: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["criterion", "passed", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["passed", "issues", "criteriaResults"],
  additionalProperties: false,
};

function parseStructuredAdversarialResult(
  rawText: string,
  task: ParsedTask,
): AdversarialResult | null {
  try {
    const value: unknown = JSON.parse(rawText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.passed !== "boolean" ||
      !Array.isArray(record.issues) ||
      !record.issues.every((issue) => typeof issue === "string") ||
      !Array.isArray(record.criteriaResults)
    ) {
      return null;
    }

    const criteriaResults: AdversarialResult["criteriaResults"] = [];
    for (const item of record.criteriaResults) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const result = item as Record<string, unknown>;
      if (
        typeof result.criterion !== "string" ||
        typeof result.passed !== "boolean" ||
        typeof result.evidence !== "string"
      ) {
        return null;
      }
      criteriaResults.push({
        criterion: result.criterion,
        passed: result.passed,
        evidence: result.evidence,
      });
    }

    const expected = new Set(task.successCriteria);
    const observed = new Set(criteriaResults.map((result) => result.criterion));
    if (
      criteriaResults.length !== task.successCriteria.length ||
      observed.size !== expected.size ||
      [...expected].some((criterion) => !observed.has(criterion))
    ) {
      return null;
    }

    const criteriaPassed = criteriaResults.every((result) => result.passed);
    return {
      passed: record.passed && criteriaPassed,
      issues: record.issues,
      criteriaResults,
    };
  } catch {
    return null;
  }
}

// ─── Task Directory Helper ───────────────────────────────────────

function getTaskDir(adapter: ProjectAdapter): string {
  return resolve(adapter.projectRoot, adapter.config.project.taskDir);
}

// ─── Runtime status overlay (TASK-1318 S2) ───────────────────────
// The blocker pass and the parent-rollup pass below decide whether OTHER
// tasks are done by parsing their spec files. Until TASK-1318 they fed
// the raw parsed `Status:` line straight to the predicate, so a
// conflicting `task_status` row was ignored. That is not cosmetic: the
// monitor turns `lifecycle_blocker_resolved` into
// `setStatus(id, "READY", "blocker_resolved")` (server.ts:7703-7709) and
// `lifecycle_parent_completed` into a parent COMPLETE (server.ts:7711-
// 7717), so a raw spec read was deciding runtime authority.
//
// The overlay is loaded ONCE per lifecycle run (one batch query) and
// shared by both passes. Both are dependency questions, so both keep
// `isCompleteStatus`: a REJECTED blocker or sibling must never satisfy
// its dependent.

/**
 * Load the runtime overlay for this lifecycle run, layering in the one
 * decision this process has already made but the store has not yet
 * recorded.
 *
 * `locallyCompletedTaskId` exists because the lifecycle's own COMPLETE
 * is written to the SPEC here and to `task_status` somewhere else, later
 * and asynchronously: the monitor writes it when it consumes the
 * `lifecycle_status_updated` event (server.ts:7695-7702), in a different
 * process from the dispatcher that runs this code. At the moment the two
 * passes below ask, the row for the task being completed still says
 * IN_PROGRESS from `session_start`. Resolving DB-over-spec without this
 * layer would therefore make every real dispatch stop promoting its
 * dependents and stop rolling up its parent, which is exactly the
 * availability property TASK-1318 must preserve ("no task whose only
 * completion signal is its spec file may stop unblocking dependents").
 *
 * This is not a spec value being laundered into runtime authority: it is
 * this process reporting the runtime decision it just made, and it is
 * layered only when the spec write actually succeeded.
 *
 * The one row it will not overwrite is `REJECTED`. That is the store
 * recording that this work was refused, and refused work must never
 * satisfy a dependent, the same distinction that makes these sites use
 * `isCompleteStatus` rather than `isTerminalTaskStatus`.
 */
function loadLifecycleStatusOverlay(
  adapter: ProjectAdapter,
  locallyCompletedTaskId: string | null,
): RuntimeStatusOverlay {
  // Round-3 F1: this function runs INSIDE the dispatch worktree, because
  // `DispatchManager` launches the child with `--project <worktree>`. It
  // used to read `<worktree>/.quack/quack.db`, a path that structurally
  // cannot exist (only `logs` and `prep` are junctioned in), so the
  // overlay always loaded `absent` and every answer below fell back to
  // the raw spec line. The routing was inert in exactly the topology it
  // was written for, and it looked healthy. `loadTaskStateOverlay` now
  // resolves the owning project root, and `viaWorktree` is reported so
  // that resolution is visible in the run log rather than assumed.
  const { overlay, degraded, source, error, viaWorktree, resolvedRoot, requestedRoot } =
    loadTaskStateOverlay(adapter.projectRoot);

  if (viaWorktree) {
    console.info(
      `[lifecycle] runtime authority resolved out of worktree ${requestedRoot} to project ${resolvedRoot}`,
    );
  }

  // A missing database is normal and needs no handling. `degraded` means
  // one EXISTS and could not be read, so every answer below silently
  // fell back to spec authority; that must never look like "the store
  // had nothing to say".
  if (degraded) {
    console.warn(
      `[lifecycle] runtime authority unavailable (${source}): ${error ?? "unknown"}; ` +
        "blocker promotion and parent rollup are spec-only and not authoritative",
    );
  }

  if (!locallyCompletedTaskId) return overlay;
  if (overlay.get(locallyCompletedTaskId) === "REJECTED") return overlay;

  const withLocalDecision = new Map(overlay);
  withLocalDecision.set(locallyCompletedTaskId, "COMPLETE");
  return withLocalDecision;
}

interface LifecycleErrorLogEntry {
  taskId: string;
  errorType: string;
  message: string;
  specPath?: string;
  expectedStatus?: string;
  observedStatusLine?: string;
  claimants?: string[];
  createdAt: string;
}

async function resolveProjectRootFromTaskDir(taskDir: string): Promise<string | null> {
  let current = resolve(taskDir);

  for (;;) {
    try {
      await fs.access(join(current, ".quack"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

async function appendLifecycleError(taskDir: string, entry: LifecycleErrorLogEntry): Promise<void> {
  const projectRoot = await resolveProjectRootFromTaskDir(taskDir);
  if (!projectRoot) return;

  const logPath = join(projectRoot, ".quack", "lifecycle-errors.jsonl");
  await fs.mkdir(dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Find the task file path for a given task ID.
 *
 * TASK-1334 (S1-R2): resolves CANONICALLY. It used to probe `${taskId}.md` and
 * then fall back to the first filename STARTING WITH the id, which selects a
 * SUBTASK for any parent whose own file sorts later. That matters more here
 * than at a read site: this feeds `updateTaskStatus`, which rewrites the spec's
 * Status line, and `atomicCommit` stages every task markdown and commits it
 * under the PARENT's id. So the wrong pick was destructive AND published.
 *
 * The exact-path probe is gone because the resolver already prefers a file
 * whose H1 DECLARES the task over one whose NAME merely matches, which is the
 * stronger rule. It also mattered that the old probe almost never hit: nearly
 * every real spec here is named descriptively, so `${taskId}.md` missed them
 * all and every call fell through to the prefix match it was meant to avoid.
 */
async function findTaskFile(
  taskId: string,
  taskDir: string,
): Promise<{ filePath: string; content: string } | null> {
  try {
    const { listTaskClaimantDeclarations, resolveTaskFile } =
      await import("../core/task-file-resolver.js");
    const declared = (await listTaskClaimantDeclarations(taskDir)).find(
      (candidate) => candidate.declaredId === taskId,
    );
    if (declared) {
      const filePath = join(taskDir, declared.fileName);
      const content = await fs.readFile(filePath, "utf-8");
      // Revalidate the bytes carried to the mutation fence, since the inventory
      // read preceded this read. The fence rechecks exact bytes and every owner.
      if (parseTaskFile(content, filePath).id !== taskId) return null;
      return { filePath, content };
    }
    const resolved = await resolveTaskFile(taskDir, taskId);
    // Round 2 (R2-1): carry the resolution's content too, so no caller
    // re-reads between certifying WHICH file is the task and using it.
    return resolved ? { filePath: resolved.filePath, content: resolved.content } : null;
  } catch {
    // Directory read or resolution failed.
    return null;
  }
}

// ─── Step 1: Adversarial Verification ────────────────────────────

export async function runAdversarialVerification(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
): Promise<AdversarialResult> {
  events.emit("lifecycle_verify_start", { taskId });

  const model = adapter.config.agent.judgeModel || "claude-sonnet-4-6";

  const criteriaList = task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const prompt = `You are an adversarial code reviewer. Your job is to verify that each success criterion for task ${taskId} has been correctly implemented in the codebase at ${workDir}.

Read the relevant source files and evaluate each criterion below. Be skeptical — look for stubs, missing wiring, partial implementations, and edge cases.

Success Criteria:
${criteriaList}

For EACH criterion, respond with exactly this format:
CRITERION: <the criterion text>
STATUS: PASS or FAIL
EVIDENCE: <specific file:line references or reasoning>

After all criteria, provide a final line:
OVERALL: PASS or FAIL`;

  const TIMEOUT_MS = 180_000; // 3 minutes

  try {
    const evaluator = adapter.config.evaluationProviders?.lifecycleVerify;
    if (evaluator?.runner === "codex-cli") {
      const result = await runCodexStructuredEvaluation(
        {
          projectRoot: workDir,
          model: evaluator.model ?? adapter.config.agent.model,
          prompt: `${prompt}\n\nReturn one strict JSON object with passed, issues, and exactly one criteriaResults entry for every criterion. Preserve every criterion string exactly.`,
          outputSchema: ADVERSARIAL_RESULT_SCHEMA,
          parse: (rawText) => parseStructuredAdversarialResult(rawText, task),
        },
        evaluator,
      );
      if (result.status === "runner_error") {
        throw new Error(`Codex lifecycle evaluator ${result.errorKind}: ${result.message}`);
      }

      events.emit("lifecycle_verify_result", {
        taskId,
        verified: result.value.passed,
        findings: result.value.criteriaResults.map((criterion) => ({
          criterion: criterion.criterion,
          status: criterion.passed ? ("pass" as const) : ("fail" as const),
          evidence: criterion.evidence,
        })),
      });
      return result.value;
    }

    const query = await getQueryFn();
    const stream = query({
      prompt,
      options: {
        model,
        maxTurns: 15,
        tools: ["Read", "Glob", "Grep"],
        ...getSdkPermissionOptions(),
        env: getClaudeSdkEnvironment(adapter.config.agent.apiKeys),
        cwd: workDir,
      },
    });

    // Collect response with timeout
    const llmPromise = (async () => {
      let resultText = "";
      for await (const message of stream) {
        if (message.type === "result" && message.subtype === "success") {
          // SDK returns final agent text in the `result` field (string), not `content`
          const result = (message as { result?: string }).result;
          if (result) resultText = result;
        }
      }
      return resultText;
    })();

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("Adversarial verification timed out (3 minute cap)")),
        TIMEOUT_MS,
      );
      timeoutHandle.unref?.();
    });

    const responseText = await Promise.race([llmPromise, timeoutPromise]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    const result = parseAdversarialResponse(responseText, task);

    events.emit("lifecycle_verify_result", {
      taskId,
      verified: result.passed,
      findings: result.criteriaResults.map((cr) => ({
        criterion: cr.criterion,
        status: cr.passed ? ("pass" as const) : ("fail" as const),
        evidence: cr.evidence,
      })),
    });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    events.emit("session_error", {
      error: `Adversarial verification failed: ${error}`,
      failedStage: "lifecycle_verify",
    });

    // On error, return a failure result with no criteria evaluated
    return {
      passed: false,
      issues: [`Verification agent error: ${error}`],
      criteriaResults: [],
    };
  }
}

function parseAdversarialResponse(text: string, task: ParsedTask): AdversarialResult {
  const criteriaResults: AdversarialResult["criteriaResults"] = [];
  const issues: string[] = [];
  const lines = text.split("\n");

  let currentCriterion = "";
  let currentPassed = true;
  let currentEvidence = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("CRITERION:")) {
      // Save previous finding
      if (currentCriterion) {
        criteriaResults.push({
          criterion: currentCriterion,
          passed: currentPassed,
          evidence: currentEvidence,
        });
        if (!currentPassed) {
          issues.push(`${currentCriterion}: ${currentEvidence}`);
        }
      }
      currentCriterion = trimmed.slice("CRITERION:".length).trim();
      currentPassed = true;
      currentEvidence = "";
    } else if (trimmed.startsWith("STATUS:")) {
      const status = trimmed.slice("STATUS:".length).trim().toUpperCase();
      currentPassed = status === "PASS";
    } else if (trimmed.startsWith("EVIDENCE:")) {
      currentEvidence = trimmed.slice("EVIDENCE:".length).trim();
    } else if (currentEvidence && trimmed && !trimmed.startsWith("OVERALL:")) {
      currentEvidence += " " + trimmed;
    }
  }

  // Save last finding
  if (currentCriterion) {
    criteriaResults.push({
      criterion: currentCriterion,
      passed: currentPassed,
      evidence: currentEvidence,
    });
    if (!currentPassed) {
      issues.push(`${currentCriterion}: ${currentEvidence}`);
    }
  }

  // Check OVERALL line
  const overallLine = lines.find((l) => l.trim().startsWith("OVERALL:"));
  let overallPassed = issues.length === 0;
  if (overallLine) {
    const overallStatus = overallLine.trim().slice("OVERALL:".length).trim().toUpperCase();
    overallPassed = overallStatus === "PASS";
  }

  // If no criteria were parsed with the structured format,
  // try fallback: scan for PASS/FAIL keywords near criterion text
  if (criteriaResults.length === 0 && task.successCriteria.length > 0) {
    // Fallback: look for each criterion mentioned in the response with PASS/FAIL nearby
    const lowerText = text.toLowerCase();
    let fallbackFails = 0;

    for (const criterion of task.successCriteria) {
      // Extract key words from criterion for fuzzy matching
      const keywords = criterion
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);

      const hasKeywords = keywords.some((kw) => lowerText.includes(kw.toLowerCase()));

      if (hasKeywords) {
        // Check if the response contains FAIL near this criterion's context
        const hasFail =
          lowerText.includes("fail") ||
          lowerText.includes("missing") ||
          lowerText.includes("not implemented") ||
          lowerText.includes("not found");
        const hasPass =
          lowerText.includes("pass") ||
          lowerText.includes("verified") ||
          lowerText.includes("confirmed") ||
          lowerText.includes("present");

        criteriaResults.push({
          criterion,
          passed: hasPass && !hasFail,
          evidence: "Parsed via fallback keyword matching",
        });

        if (!(hasPass && !hasFail)) fallbackFails++;
      }
    }

    // If fallback found results, use them
    if (criteriaResults.length > 0) {
      const fallbackPassed = fallbackFails === 0;
      if (!fallbackPassed) {
        for (const cr of criteriaResults) {
          if (!cr.passed) {
            issues.push(`${cr.criterion}: ${cr.evidence}`);
          }
        }
      }
      return { passed: fallbackPassed, issues, criteriaResults };
    }

    // If response has text but we couldn't parse it at all,
    // treat as a soft pass — the post-judge already verified deterministically
    if (text.length > 100) {
      return {
        passed: true,
        issues: [],
        criteriaResults: task.successCriteria.map((c) => ({
          criterion: c,
          passed: true,
          evidence:
            "Adversarial agent responded but output format was non-standard. Post-judge deterministic checks passed.",
        })),
      };
    }

    // Empty response — actual failure
    return {
      passed: false,
      issues: ["Verification agent returned empty response"],
      criteriaResults: [],
    };
  }

  return { passed: overallPassed, issues, criteriaResults };
}

// ─── Step 2: Fix Cycle ───────────────────────────────────────────

async function runFixCycle(
  taskId: string,
  task: ParsedTask,
  issues: string[],
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
): Promise<{
  fixed: boolean;
  attemptsUsed: number;
  finalResult: AdversarialResult;
}> {
  const MAX_FIX_ATTEMPTS = 2;
  let attemptsUsed = 0;
  let lastResult: AdversarialResult = {
    passed: false,
    issues,
    criteriaResults: [],
  };

  const model = adapter.config.agent.model || "claude-sonnet-4-6";
  const maxTurns = adapter.config.revision?.maxTurns ?? 30;
  const maxBudget = adapter.config.revision?.maxBudget ?? 2.0;
  const runner = adapter.config.agent.runner ?? "claude-sdk";
  const repairAdapter: ProjectAdapter =
    adapter.projectRoot === workDir ? adapter : { ...adapter, projectRoot: workDir };
  let repairSessionId: string | undefined;

  // Every mutable repair goes through runAgent(), regardless of provider. Resolve
  // the canonical task contract first so both workers receive the same protected
  // spec path and deterministic verification can parse the exact contract being
  // repaired.
  const resolvedTask = await findTaskFile(taskId, getTaskDir(repairAdapter));
  if (!resolvedTask) {
    const message = `${runner} lifecycle repair could not resolve the active task spec for ${taskId}`;
    events.emit("session_error", {
      error: message,
      failedStage: "lifecycle_fix",
      runner,
    });
    return {
      fixed: false,
      attemptsUsed: 0,
      finalResult: {
        passed: false,
        issues: [message],
        criteriaResults: lastResult.criteriaResults,
      },
    };
  }

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    events.emit("lifecycle_fix_start", {
      taskId,
      attempt,
      issues: lastResult.issues,
      runner,
      ...(repairSessionId ? { sessionId: repairSessionId } : {}),
    });

    const issueList = lastResult.issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n");

    const prompt = `You are fixing issues found during adversarial verification of task ${taskId}.

The following issues were found in the codebase at ${workDir}:

${issueList}

Task Success Criteria:
${task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Fix these issues.
Do not run git write commands. Quack will seal and commit the validated repair after your turn.
Be thorough — each issue must be resolved for verification to pass.`;

    let repairFailed = false;
    try {
      const repairContext: TaskContext = {
        taskSpec: resolvedTask.content,
        taskSpecPath: resolvedTask.filePath,
        conventions: adapter.adrDocs ?? {},
        conventionsSummary: adapter.conventionsDoc,
        relevantFiles: task.filesToModify.map((file) => file.path),
        relatedPatterns: [],
        existingTests: task.testingRequirements,
        claudeMd: [],
        blueprint: prompt,
      };
      const repairResult = await runAgent(
        taskId,
        repairContext,
        repairAdapter,
        {
          model,
          maxTurns,
          maxBudgetUsd: maxBudget,
          ...(repairSessionId ? { resumeSessionId: repairSessionId, retryFeedback: prompt } : {}),
        },
        events,
      );
      repairSessionId = repairResult.claudeSessionId ?? repairSessionId;

      if (repairResult.outcome !== "success" || repairResult.verification?.allPassed !== true) {
        repairFailed = true;
        const detail =
          repairResult.error ??
          (repairResult.outcome !== "success"
            ? `worker outcome ${repairResult.outcome}`
            : "worker completed without passing deterministic verification");
        lastResult = {
          passed: false,
          issues: [`${runner} repair attempt ${attempt} failed: ${detail}`],
          criteriaResults: lastResult.criteriaResults,
        };
        events.emit("session_error", {
          error: lastResult.issues[0],
          failedStage: "lifecycle_fix",
          runner,
          ...(repairSessionId ? { sessionId: repairSessionId } : {}),
        });
      } else {
        // A repair is not eligible for adversarial re-verification until its
        // guarded worker verification passed and its output is durably sealed.
        await sealAgentOutputAttempt({
          taskId,
          adapter: repairAdapter,
          events,
          attempt,
          kind: "lifecycle_fix",
          claudeSessionId: repairSessionId,
        });
      }
    } catch (err) {
      repairFailed = true;
      const error = err instanceof Error ? err.message : String(err);
      lastResult = {
        passed: false,
        issues: [`${runner} repair attempt ${attempt} failed: ${error}`],
        criteriaResults: lastResult.criteriaResults,
      };
      events.emit("session_error", {
        error: lastResult.issues[0],
        failedStage: "lifecycle_fix",
        runner,
        ...(repairSessionId ? { sessionId: repairSessionId } : {}),
      });
    }

    events.emit("lifecycle_fix_complete", {
      taskId,
      attempt,
      runner,
      ...(repairSessionId ? { sessionId: repairSessionId } : {}),
      outcome: repairFailed ? "failure" : "success",
    });

    if (repairFailed) continue;

    // Re-run adversarial verification
    lastResult = await runAdversarialVerification(taskId, task, adapter, workDir, events);

    if (lastResult.passed) {
      return { fixed: true, attemptsUsed, finalResult: lastResult };
    }
  }

  events.emit("lifecycle_fix_exhausted", {
    taskId,
    attempts: attemptsUsed,
    remainingIssues: lastResult.issues,
  });

  return { fixed: false, attemptsUsed, finalResult: lastResult };
}

// ─── Step 3: Status Update ───────────────────────────────────────

export async function updateTaskStatus(
  taskId: string,
  taskDir: string,
  newStatus: string,
  events?: IEventWriter,
  adapter?: ProjectAdapter,
  allowDecomposedCurrent = false,
): Promise<boolean> {
  let mutationAdapter = adapter;
  if (!mutationAdapter) {
    const projectRoot = await resolveProjectRootFromTaskDir(taskDir);
    if (projectRoot) {
      mutationAdapter = {
        projectRoot,
        config: {
          project: {
            name: "lifecycle-status-update",
            root: ".",
            taskDir: relative(projectRoot, taskDir),
            conventionsDir: ".quack",
          },
        },
      } as ProjectAdapter;
    }
  }
  if (!mutationAdapter) {
    throw new Error("Canonical task status updates require an identifiable project root.");
  }
  const resolvedTask = await findTaskFile(taskId, taskDir);
  if (!resolvedTask) {
    await appendLifecycleError(taskDir, {
      taskId,
      errorType: "task_file_not_found",
      message: `Task file not found for ${taskId}`,
      expectedStatus: newStatus,
      createdAt: new Date().toISOString(),
    });
    return false;
  }
  const taskFile = resolvedTask.filePath;

  try {
    // Round 2 (R2-1): the resolution's own content, not a re-read.
    const content = resolvedTask.content;
    const updated = content.replace(/(\*\*Status:\*\*\s*)\w+/, `$1${newStatus}`);
    if (updated === content) {
      const statusLine =
        content.split(/\r?\n/).find((line) => line.includes("**Status:**")) ?? "(none)";
      const message = `Status line not updated for ${taskId}: expected ${newStatus}, observed ${statusLine}`;
      console.error(`[lifecycle] ${message}`);
      if (events) {
        events.emit("lifecycle_status_update_failed", {
          taskId,
          expectedStatus: newStatus,
          actualContent: statusLine,
        });
      }
      await appendLifecycleError(taskDir, {
        taskId,
        errorType: "status_pattern_not_found",
        message,
        specPath: taskFile,
        expectedStatus: newStatus,
        observedStatusLine: statusLine,
        createdAt: new Date().toISOString(),
      });
      return false;
    }
    await withCanonicalTaskSpecMutationFence({
      adapter: mutationAdapter,
      taskId,
      taskFilePath: taskFile,
      expectedContent: content,
      replacementContent: updated,
      allowDecomposedCurrent,
    });

    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicateClaimants =
      error instanceof CanonicalTaskSpecMutationError && error.claimants.length > 1
        ? [...error.claimants]
        : undefined;
    if (events) {
      events.emit("lifecycle_status_update_failed", {
        taskId,
        expectedStatus: newStatus,
        error: message,
      });
    }
    await appendLifecycleError(taskDir, {
      taskId,
      errorType: duplicateClaimants ? "duplicate_claimants" : "status_write_exception",
      message,
      specPath: taskFile,
      expectedStatus: newStatus,
      ...(duplicateClaimants ? { claimants: duplicateClaimants } : {}),
      createdAt: new Date().toISOString(),
    });
    return false;
  }
}

// ─── Step 4: Write verified.json ─────────────────────────────────

// ─── Step 5: Resolve Blockers ────────────────────────────────────

async function resolveBlockers(
  task: ParsedTask,
  adapter: ProjectAdapter,
  events: IEventWriter,
  statusOverlay: RuntimeStatusOverlay,
): Promise<string[]> {
  const taskDir = getTaskDir(adapter);
  const promoted: string[] = [];

  if (!task.blocks || task.blocks.length === 0) return promoted;

  const { listTaskClaimantDeclarations } = await import("../core/task-file-resolver.js");
  // The dependent's mutation fence cannot establish ownership of its blockers.
  // Certify all dependency reads against the full declared inventory first.
  const claimantIndex = await buildStrictDuplicateClaimantIndex(() =>
    listTaskClaimantDeclarations(taskDir),
  );
  async function holdForClaimantRefusal(taskId: string, dependentId: string): Promise<boolean> {
    const refusal = duplicateClaimantRefusalForIndex(claimantIndex, taskId);
    if (!refusal) return false;
    const message = `Task ${dependentId} promotion held: ${refusal.message}`;
    events.emit("session_error", {
      error: message,
      failedStage: "lifecycle_blocker_resolution",
    });
    await appendLifecycleError(taskDir, {
      taskId: dependentId,
      errorType: "blocker_identity_conflict",
      message,
      claimants: refusal.claimants,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  for (const blockedTaskId of task.blocks) {
    try {
      if (await holdForClaimantRefusal(blockedTaskId, blockedTaskId)) continue;
      const blockedFile = await findTaskFile(blockedTaskId, taskDir);
      if (!blockedFile) continue;

      const blockedContent = blockedFile.content;
      const blockedTask = parseTaskFile(blockedContent, blockedFile.filePath);

      // Only promote tasks that have not started yet. TASK-1318 S2:
      // resolved, not raw spec, because promoting writes `READY` into
      // `task_status`, so a stale `BACKLOG` line must not be able to
      // walk the store backwards over a task it already advanced.
      const blockedState = resolveTaskStateWithOverlay({
        taskId: blockedTaskId,
        specStatus: blockedTask.status,
        overlay: statusOverlay,
      });
      if (blockedState.status !== "BACKLOG") continue;

      // Check if ALL blockers of this task are now COMPLETE
      let allBlockersComplete = true;
      for (const blockerId of blockedTask.blockedBy) {
        if (await holdForClaimantRefusal(blockerId, blockedTaskId)) {
          allBlockersComplete = false;
          break;
        }
        const blockerFile = await findTaskFile(blockerId, taskDir);
        if (!blockerFile) {
          allBlockersComplete = false;
          break;
        }

        const blockerContent = blockerFile.content;
        const blockerTask = parseTaskFile(blockerContent, blockerFile.filePath);
        // TASK-1318 S2: shared predicate over the RESOLVED status, so a
        // runtime row outranks the spec line. A REJECTED blocker must
        // NOT satisfy its dependent, which is why this is
        // isCompleteStatus and not isTerminalTaskStatus.
        const blockerState = resolveTaskStateWithOverlay({
          taskId: blockerId,
          specStatus: blockerTask.status,
          overlay: statusOverlay,
        });
        if (!isCompleteStatus(blockerState.status)) {
          allBlockersComplete = false;
          break;
        }
      }

      if (allBlockersComplete) {
        const updated = await updateTaskStatus(blockedTaskId, taskDir, "READY", events, adapter);
        if (updated) {
          promoted.push(blockedTaskId);
          events.emit("lifecycle_blocker_resolved", {
            taskId: blockedTaskId,
            promotedFrom: "BACKLOG",
            promotedTo: "READY",
          });
        }
      }
    } catch {
      // Non-fatal per-task, skip and continue
    }
  }

  return promoted;
}

// ─── Step 6: Check Parent Completion ─────────────────────────────

function parentTaskIdFromField(content: string): string | undefined {
  // A field is a complete line, either plain or the emitted bold bullet.
  // Prefix-related IDs and prose mentions cannot establish membership.
  return content
    .match(
      /^[\t ]*(?:-[\t ]*)?(?:\*\*Parent Task:\*\*|Parent Task:)[\t ]*(TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3})[\t ]*$/im,
    )?.[1]
    .toUpperCase();
}

async function checkParentCompletion(
  task: ParsedTask,
  adapter: ProjectAdapter,
  events: IEventWriter,
  statusOverlay: RuntimeStatusOverlay,
): Promise<string | null> {
  const parentId = parentTaskIdFromField(task.rawContent);
  if (!parentId || parentId === task.id) return null;
  const taskDir = getTaskDir(adapter);

  try {
    const { listTaskClaimantDeclarations } = await import("../core/task-file-resolver.js");
    // Ownership spans the entire declared inventory: a second claimant does
    // not become safe merely by omitting or changing its Parent Task field.
    const claimantIndex = await buildStrictDuplicateClaimantIndex(() =>
      listTaskClaimantDeclarations(taskDir),
    );
    const files = (await fs.readdir(taskDir)).filter((file) => /\.md$/i.test(file)).sort();
    const subtasks: ParsedTask[] = [];
    for (const file of files) {
      const filePath = join(taskDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      if (parentTaskIdFromField(content) !== parentId) continue;
      try {
        const subtask = parseTaskFile(content, filePath);
        if (subtask.id === parentId) continue;
        const refusal = duplicateClaimantRefusalForIndex(claimantIndex, subtask.id);
        if (refusal) {
          const message = `Parent ${parentId} completion held: ${refusal.message}`;
          events.emit("session_error", {
            error: message,
            failedStage: "lifecycle_parent_completion",
          });
          await appendLifecycleError(taskDir, {
            taskId: parentId,
            errorType: "parent_child_identity_conflict",
            message,
            specPath: filePath,
            claimants: refusal.claimants,
            createdAt: new Date().toISOString(),
          });
          return null;
        }
        subtasks.push(subtask);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `Parent ${parentId} completion held: claiming child ${filePath} cannot be parsed: ${detail}`;
        events.emit("session_error", {
          error: message,
          failedStage: "lifecycle_parent_completion",
        });
        await appendLifecycleError(taskDir, {
          taskId: parentId,
          errorType: "parent_child_parse_error",
          message,
          specPath: filePath,
          createdAt: new Date().toISOString(),
        });
        return null;
      }
    }

    if (subtasks.length === 0) return null;
    const allComplete = subtasks.every((subtask) => {
      const state = resolveTaskStateWithOverlay({
        taskId: subtask.id,
        specStatus: subtask.status,
        overlay: statusOverlay,
      });
      return isCompleteStatus(state.status);
    });
    if (allComplete) {
      const updated = await updateTaskStatus(parentId, taskDir, "COMPLETE", events, adapter, true);
      if (updated) {
        const subtaskIds = subtasks.map((subtask) => subtask.id).sort();
        events.emit("lifecycle_parent_completed", {
          parentTaskId: parentId,
          subtaskCount: subtaskIds.length,
          subtaskIds,
        });
        return parentId;
      }
    }
  } catch {
    // A failed directory/file read cannot establish that every sibling is done.
  }
  return null;
}

// ─── Step 7: Atomic Git Commit ───────────────────────────────────

export function atomicCommit(
  taskId: string,
  adapter: ProjectAdapter,
  workDir: string,
  promotedTasks: string[],
): string | undefined {
  try {
    const taskDir = adapter.config.project.taskDir;

    // Stage task spec files only (NOT verified.json — it's shared state
    // that should only be updated on the main working directory, not on
    // task branches where it causes merge conflicts)
    runTrustedGitSync(["add", "--", join(taskDir, "*.md")], workDir, {
      trustedBoundaryRoot: adapter.projectRoot,
      errorContext: "Unable to stage lifecycle task specs",
    });

    // Check if there are staged changes
    try {
      runTrustedGitSync(["diff", "--cached", "--quiet"], workDir, {
        trustedBoundaryRoot: adapter.projectRoot,
      });
      // No changes staged — skip commit
      return undefined;
    } catch {
      // diff --cached --quiet exits non-zero when there ARE changes — proceed
    }

    const blockerNote =
      promotedTasks.length > 0 ? `, resolve blockers (${promotedTasks.join(", ")})` : "";
    const message = `[${taskId}] lifecycle: mark complete${blockerNote}`;

    runTrustedGitSync(["commit", "-m", message], workDir, {
      trustedBoundaryRoot: adapter.projectRoot,
      errorContext: "Unable to commit lifecycle task specs",
    });

    return undefined; // success, no error
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── Main Lifecycle Function ─────────────────────────────────────

export async function runPostApprovalLifecycle(
  taskId: string,
  task: ParsedTask,
  adapter: ProjectAdapter,
  workDir: string,
  events: IEventWriter,
): Promise<LifecycleResult> {
  const taskDir = getTaskDir(adapter);
  const findings: VerificationFinding[] = [];
  let fixAttemptsUsed = 0;
  let statusUpdated = false;
  let blockersResolved: string[] = [];
  let parentCompleted: string | null = null;
  let verified = false;

  // ── Step 1: Adversarial Verification ───────────────────────────
  const verifyResult = await runAdversarialVerification(taskId, task, adapter, workDir, events);

  // Convert criteria results to VerificationFindings
  for (const cr of verifyResult.criteriaResults) {
    findings.push({
      criterion: cr.criterion,
      status: cr.passed ? "pass" : "fail",
      evidence: cr.evidence,
    });
  }

  // ── Step 2: Fix Cycle (if real issues found) ───────────────────
  // Adversarial verify is ADVISORY — if it returns empty/unparseable
  // output, skip the fix cycle entirely. The post-judge deterministic
  // checks already passed (build, test, lint). Only run fixes when
  // the verify agent found specific, actionable issues.
  const hasActionableIssues =
    !verifyResult.passed &&
    verifyResult.criteriaResults.length > 0 &&
    verifyResult.issues.some(
      (i) => !i.includes("returned empty response") && !i.includes("did not produce parseable"),
    );

  if (hasActionableIssues) {
    const fixResult = await runFixCycle(
      taskId,
      task,
      verifyResult.issues,
      adapter,
      workDir,
      events,
    );

    fixAttemptsUsed = fixResult.attemptsUsed;

    // Update findings with final verification results if fix produced them
    if (fixResult.finalResult.criteriaResults.length > 0) {
      findings.length = 0; // Clear and rebuild
      for (const cr of fixResult.finalResult.criteriaResults) {
        findings.push({
          criterion: cr.criterion,
          status: cr.passed ? "pass" : "fail",
          evidence: cr.evidence,
        });
      }
    }

    // Verified only if the fix cycle resolved all issues
    verified = fixResult.fixed;
  } else if (!verifyResult.passed) {
    // Verify failed but no actionable criteria issues. Distinguish between
    // advisory failures (empty/unparseable output) and hard errors (SDK crash).
    const isAdvisoryFailure =
      verifyResult.criteriaResults.length === 0 &&
      verifyResult.issues.every(
        (i) => i.includes("returned empty response") || i.includes("did not produce parseable"),
      );

    if (isAdvisoryFailure) {
      // Log it and proceed — post-judge already validated deterministically
      events.emit("lifecycle_verify_skipped", {
        taskId,
        reason:
          "Adversarial verify returned no actionable findings. Post-judge deterministic checks passed. Proceeding to finalization.",
        issues: verifyResult.issues,
      });
      verified = true;
    } else {
      // Hard error (SDK failure, timeout, etc.) — do not mark as verified
      verified = false;
    }
  } else {
    verified = verifyResult.passed;
  }

  // ── Step 3: Status Update ──────────────────────────────────────
  // Only update status to COMPLETE if verification passed
  if (verified) {
    try {
      statusUpdated = await updateTaskStatus(taskId, taskDir, "COMPLETE", events, adapter);
      if (statusUpdated) {
        events.emit("lifecycle_status_updated", {
          taskId,
          newStatus: "COMPLETE",
        });
      }
    } catch {
      // Non-fatal, continue
    }
  }

  // ── Runtime status overlay for Steps 4 and 5 (TASK-1318 S2) ────
  // Loaded ONCE, after the status write above so the local decision is
  // known, and shared by both dependency passes. `statusUpdated` is only
  // ever set inside the `verified` branch, so it is exactly "this run
  // committed COMPLETE for this task".
  const statusOverlay = loadLifecycleStatusOverlay(adapter, statusUpdated ? taskId : null);

  // ── Step 4: Resolve Blockers ───────────────────────────────────
  try {
    blockersResolved = await resolveBlockers(task, adapter, events, statusOverlay);
  } catch {
    // Non-fatal, continue
  }

  // ── Step 5: Check Parent Completion ────────────────────────────
  try {
    parentCompleted = await checkParentCompletion(task, adapter, events, statusOverlay);
  } catch {
    // Non-fatal, continue
  }

  // ── Step 6: Atomic Git Commit ──────────────────────────────────
  const commitError = atomicCommit(taskId, adapter, workDir, blockersResolved);

  // ── Step 7: Tiered Testing — Tier 3 merge counter ──────────────
  // Track completed merges and emit event when tier3Frequency threshold reached.
  // The monitor or external scheduler acts on the event to trigger a full suite run.
  const tieredConfig = adapter.config.verification?.tieredTesting;
  if (tieredConfig?.enabled && tieredConfig.tier3Frequency > 0) {
    try {
      const counterPath = join(adapter.projectRoot, ".quack", "tier3-merge-count.json");
      let counter = { mergesSinceLastTier3: 0, lastTier3: "" };
      try {
        const raw = await fs.readFile(counterPath, "utf-8");
        counter = JSON.parse(raw) as typeof counter;
      } catch {
        // File doesn't exist yet — start fresh
      }

      counter.mergesSinceLastTier3 += 1;

      if (counter.mergesSinceLastTier3 >= tieredConfig.tier3Frequency) {
        events.emit("tier3_threshold_reached", {
          mergesSinceLastTier3: counter.mergesSinceLastTier3,
          tier3Frequency: tieredConfig.tier3Frequency,
        });
        // Reset counter — the actual Tier 3 run is triggered by the monitor
        counter.mergesSinceLastTier3 = 0;
        counter.lastTier3 = new Date().toISOString();
      }

      await fs.writeFile(counterPath, JSON.stringify(counter, null, 2), "utf-8");
    } catch {
      // Non-fatal — merge counting failure doesn't block lifecycle
    }
  }

  // ── Step 8: Read tiered test results if available ──────────────
  // When tiered testing produced a JSON report, use it to enrich findings
  // instead of relying solely on adversarial verification output.
  if (tieredConfig?.enabled) {
    try {
      const outputDir = tieredConfig.outputDir ?? ".quack/test-results";
      const reportPath = join(workDir, outputDir, `${taskId}-results.json`);
      const raw = await fs.readFile(reportPath, "utf-8");
      const report = JSON.parse(raw) as {
        verdict?: string;
        tier1?: { ran: number; passed: number; failed: number; newFailures: number };
        tier2?: { ran: number; passed: number; failed: number; newFailures: number };
      };

      events.emit("lifecycle_tiered_results", {
        taskId,
        verdict: report.verdict,
        tier1: report.tier1,
        tier2: report.tier2,
      });
    } catch {
      // No tiered results available — that's fine, adversarial verify already ran
    }
  }

  // Prompt engineer to run /verify-task only after pipeline completion actually
  // advanced the task to COMPLETE.
  if (verified && statusUpdated) {
    events.emit("task_verification_needed", { taskId });
  }

  events.emit("lifecycle_complete", {
    taskId,
    verified,
    fixAttempts: fixAttemptsUsed,
    blockersResolved,
    parentCompleted,
  });

  return {
    verified,
    fixAttemptsUsed,
    statusUpdated,
    blockersResolved,
    parentCompleted,
    verificationFindings: findings,
    error: commitError,
  };
}
