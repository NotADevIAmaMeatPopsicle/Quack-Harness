// Shared revision admission and durable-state preparation.
//
// `quack revise` and POST /api/tasks/:id/revise intentionally remain two
// entry points: the HTTP route owns HTTP status codes, federation admission,
// and its in-memory DispatchManager job map; the CLI must work without a
// monitor. Everything persisted for a revision is decided here so those
// unavoidable surface differences cannot change checkpoint or approval state.

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveParsedTaskFile, type ResolvedTaskFile } from "../core/task-file-resolver.js";
import type { ExecutionMode } from "../core/types.js";
import type { ReviewRunResult } from "../review/reviewer-types.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { deleteJudgeApproval, loadJudgeApproval } from "./judge-approval.js";

export type RevisionPreparationErrorCode = "task_not_found" | "already_running" | "no_prior_runs";

export class RevisionPreparationError extends Error {
  constructor(
    readonly code: RevisionPreparationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RevisionPreparationError";
  }
}

export interface RevisionSession {
  sessionId: string;
  taskId: string;
  status: "active" | "completed" | "error";
}

export interface RevisionEvent {
  stage: string;
  payload: unknown;
}

export interface RevisionRuntimeContext {
  projectRoot: string;
  logDir: string;
}

export interface RevisionPreparationInput {
  taskId: string;
  resolvedTask: ResolvedTaskFile;
  adapterExecutionMode: ExecutionMode;
  runtimeLogDir: string;
  sessions: readonly RevisionSession[];
  getSessionEvents: (sessionId: string) => readonly RevisionEvent[];
  humanFeedback: string;
  /** HTTP-only evidence from DispatchManager; false for the standalone CLI. */
  inMemoryRunning?: boolean;
}

export interface RevisionPreparation {
  executionMode: ExecutionMode;
  mergedFeedback: string;
  resuming: boolean;
}

/**
 * Resolve the project root and configured log directory used by the dispatch
 * that a revision will continue. A prior worktree is reused by both doors.
 */
export function resolveRevisionRuntimeContext(
  projectRoot: string,
  taskId: string,
  configuredLogDir: string,
  managedWorktree?: string,
): RevisionRuntimeContext {
  const conventionalWorktree = path.join(projectRoot, ".quack", "worktrees", taskId);
  const runtimeRoot =
    managedWorktree ?? (fs.existsSync(conventionalWorktree) ? conventionalWorktree : projectRoot);

  if (runtimeRoot === projectRoot) {
    return { projectRoot: runtimeRoot, logDir: configuredLogDir };
  }

  const relativeLogDir = path.relative(projectRoot, configuredLogDir);
  const logDir =
    !relativeLogDir || relativeLogDir.startsWith("..") || path.isAbsolute(relativeLogDir)
      ? configuredLogDir
      : path.resolve(runtimeRoot, relativeLogDir);
  return { projectRoot: runtimeRoot, logDir };
}

/** Resolve only a valid, parsed task before either door may write session state. */
export async function resolveRevisionTask(
  taskDir: string,
  taskId: string,
): Promise<ResolvedTaskFile> {
  const resolved = await resolveParsedTaskFile(taskDir, taskId);
  if (!resolved?.task) {
    throw new RevisionPreparationError("task_not_found", `Task ${taskId} not found`);
  }
  return resolved;
}

export function formatLoopReviewFeedback(review: ReviewRunResult | undefined): string {
  if (!review) return "";
  if (review.status === "runner_error") {
    return `### Loop reviewer environment failure\n- ${review.errorKind}: ${review.message}`;
  }
  if (review.findings.length === 0) {
    return `### Loop reviewer verdict: ${review.verdict}\n${review.summary}`;
  }
  return [
    `### Loop reviewer verdict: ${review.verdict}`,
    review.summary,
    ...review.findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.summary}${finding.detail ? ` — ${finding.detail}` : ""}`,
    ),
  ].join("\n");
}

function latestJudgeFeedback(
  session: RevisionSession,
  getSessionEvents: RevisionPreparationInput["getSessionEvents"],
): string {
  const judgeEvent = getSessionEvents(session.sessionId).find(
    (event) => event.stage === "judge_result",
  );
  if (!judgeEvent || typeof judgeEvent.payload !== "object" || judgeEvent.payload === null) {
    return "";
  }
  const feedback = (judgeEvent.payload as Record<string, unknown>).feedback;
  return typeof feedback === "string" ? feedback : "";
}

/**
 * Perform revision admission and every revision-specific durable mutation.
 * Callers must pass sessions newest-first, matching EventReader.
 */
export async function prepareRevisionState(
  input: RevisionPreparationInput,
): Promise<RevisionPreparation> {
  const taskSessions = input.sessions.filter((session) => session.taskId === input.taskId);

  // The route contributes its live process map. The standalone CLI has no
  // monitor, so the shared persisted session ledger is its running-task guard.
  if (input.inMemoryRunning || taskSessions.some((session) => session.status === "active")) {
    throw new RevisionPreparationError(
      "already_running",
      `Task ${input.taskId} is already running`,
    );
  }
  if (taskSessions.length === 0) {
    throw new RevisionPreparationError("no_prior_runs", "Cannot revise: no prior runs");
  }

  const judgeFeedback = latestJudgeFeedback(taskSessions[0], input.getSessionEvents);
  let mergedFeedback = judgeFeedback
    ? `${judgeFeedback}\n\n---\n\n## Human Revision Feedback\n\n${input.humanFeedback}`
    : input.humanFeedback;
  const executionMode = input.resolvedTask.task?.executionMode ?? input.adapterExecutionMode;
  let resuming = false;

  if (executionMode === "loop") {
    const approval = await loadJudgeApproval(input.taskId, input.runtimeLogDir);
    const reviewFeedback = formatLoopReviewFeedback(approval?.review);
    if (reviewFeedback) {
      mergedFeedback = [mergedFeedback, reviewFeedback].filter(Boolean).join("\n\n---\n\n");
    }

    const checkpointManager = new CheckpointManager(input.runtimeLogDir);
    const rewound = await checkpointManager.rewindFrom(input.taskId, "agent");
    resuming = Boolean(rewound?.claudeSessionId && checkpointManager.isUsable(rewound));

    // A revision decides the old judge gate, regardless of whether that
    // record is pending, approved, rejected, auto-approved, or unreadable.
    await deleteJudgeApproval(input.taskId, input.runtimeLogDir);
  }

  return { executionMode, mergedFeedback, resuming };
}
