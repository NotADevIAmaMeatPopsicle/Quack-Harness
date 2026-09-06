import type { ParsedTask, TaskBacklogHygiene, VerifiedJsonEntry } from "../core/types.js";
import type { TaskStatusRow } from "../db/types.js";
import {
  deriveSessionStatus,
  resolveTaskState,
  type TaskStateAuthority,
  type TaskVerificationEvidence,
} from "../core/task-state.js";
import type { TaskStatus } from "../core/task-status.js";

export interface TaskSessionInfo {
  outcome: string;
  costUsd: number;
  status: string;
}

export type TaskProjectionStatusSource = "file" | "session" | "db";

export interface TaskProjection {
  id: string;
  title: string;
  priority: string;
  effort: string;
  status: string;
  targetBranch?: string;
  supersededBy: string[];
  supersedes: string[];
  relevanceReview: string;
  effectiveStatus: string;
  /**
   * @deprecated TASK-1317: kept so no consumer breaks. Its
   * file/session/db vocabulary cannot express the question that
   * matters; use `authority` and `verification` instead. Removed in
   * P2-4.
   */
  statusSource: TaskProjectionStatusSource;
  /** TASK-1317: which source supplied `effectiveStatus`. */
  authority: TaskStateAuthority;
  /** TASK-1317: the normalized view; null for non-canonical values. */
  typedStatus: TaskStatus | null;
  /** TASK-1317: latest-verification evidence, when the register has a
   * row. Carries the verdict, so the two-tier done state is finally
   * representable downstream (P4-3). */
  verification?: TaskVerificationEvidence;
  blockedBy: string[];
  blocks: string[];
  dependencyCount: number;
  isTerminal: boolean;
  tags: string[];
  successCriteriaCount: number;
  needsVerification: boolean;
  lastOutcome?: string;
  lastCostUsd?: number;
  parseWarnings?: string[];
  backlogHygiene?: TaskBacklogHygiene;
}

/**
 * TASK-1317: the derivation moved verbatim to `core/task-state.ts` so
 * the resolver and this projection cannot drift. Kept as a re-export
 * wrapper because existing callers and tests import it from here.
 */
export function deriveEffectiveTaskStatus(fileStatus: string, session?: TaskSessionInfo): string {
  return deriveSessionStatus(fileStatus, session);
}

export function getUnverifiedApprovedTaskIds(
  sessionsByTask: Map<string, TaskSessionInfo>,
  verifiedIndex?: Record<string, VerifiedJsonEntry>,
): Set<string> {
  const ids = new Set<string>();
  for (const [taskId, session] of sessionsByTask) {
    if (session.outcome === "approved" && (!verifiedIndex || !verifiedIndex[taskId])) {
      ids.add(taskId);
    }
  }
  return ids;
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "COMPLETE" || status === "VERIFIED" || status === "REJECTED";
}

export function buildTaskProjection(
  task: ParsedTask,
  options: {
    session?: TaskSessionInfo;
    dbStatus?: TaskStatusRow;
    verifiedIndex?: Record<string, VerifiedJsonEntry>;
    backlogHygiene?: TaskBacklogHygiene;
    /** TASK-1317: batch-read from the DB register by the caller, NEVER
     * per task (round-1 F7: that would be ~268 queries per request). */
    verification?: TaskVerificationEvidence;
  } = {},
): TaskProjection {
  // TASK-1317 S6: resolution moved to the shared resolver. This is now
  // a thin adapter that maps the typed result onto the field names
  // consumers already use. `effectiveStatus` stays byte-identical.
  const resolved = resolveTaskState({
    spec: task.status,
    ...(options.dbStatus ? { runtime: options.dbStatus.status } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
  });
  const effectiveStatus = resolved.status;
  // Preserved exactly, including its quirk that a session whose
  // derivation happens to equal the spec status still reports "file".
  const sessionEffectiveStatus = deriveEffectiveTaskStatus(task.status, options.session);
  const statusSource: TaskProjectionStatusSource = options.dbStatus
    ? "db"
    : sessionEffectiveStatus !== task.status
      ? "session"
      : "file";

  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    effort: task.effort,
    status: task.status,
    targetBranch: task.targetBranch,
    supersededBy: task.supersededBy,
    supersedes: task.supersedes,
    relevanceReview: task.relevanceReview,
    effectiveStatus,
    statusSource,
    authority: resolved.authority,
    typedStatus: resolved.typedStatus,
    ...(resolved.verification ? { verification: resolved.verification } : {}),
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    dependencyCount: task.blockedBy.length + task.blocks.length,
    isTerminal: isTerminalTaskStatus(effectiveStatus),
    tags: task.tags,
    successCriteriaCount: task.successCriteria.length,
    needsVerification:
      options.session?.outcome === "approved" &&
      (!options.verifiedIndex || !options.verifiedIndex[task.id]),
    lastOutcome: options.session?.outcome,
    lastCostUsd: options.session?.costUsd,
    parseWarnings: task.parseWarnings,
    backlogHygiene: options.backlogHygiene,
  };
}
