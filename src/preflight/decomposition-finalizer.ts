import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  readTaskCreationClaimants,
  withTaskCreationReservation,
  type TaskCreationLockOptions,
} from "../core/task-creation-reservation.js";
import { resolveParsedTaskFile } from "../core/task-file-resolver.js";
import type { ParsedTask } from "../core/types.js";
import type { ChildDraft, CoverageReport, DecompositionTopology } from "./decompose-types.js";
import { buildDecompositionTrackerContent } from "./decomposition-tracker.js";
import { runChildQualityGate, validateChildDraftScope } from "./subtask-quality-gate.js";
import {
  assertTransactionPathsUnstaged,
  planSubtaskSpecWrites,
  SubtaskWriteError,
  TransactionPathStagedError,
  writeSubtaskSpecsWithinReservation,
} from "./subtask-writer.js";
import {
  assertDecompositionCommitBaseline,
  commitDecompositionTransaction,
  completeDecompositionTransactionJournal,
  createDecompositionTransactionJournal,
  recoverDecompositionJournalWithinReservation,
  recoverPendingTaskSpecMutationsWithinReservation,
  updateDecompositionTransactionJournal,
  DecompositionRecoveryError,
  type DecompositionCommitResult,
  type DecompositionCommitOptions,
  type DecompositionTransactionJournal,
} from "./decomposition-transaction-journal.js";
import {
  assertSafeDecompositionTaskDirectory,
  writeDecompositionFileAtomicReplace,
} from "./decomposition-file-io.js";
import {
  buildDecompositionCoverageReport,
  computeDecompositionParentHash,
  hasValidDecompositionTopologyIdentity,
} from "./decomposition-plan-integrity.js";
import {
  hasValidDecompositionChildCount,
  resolveEffectiveDecompositionMaxSubtasks,
} from "./decomposition-limits.js";

export type DecompositionFinalizeFailureKind =
  | "invalid_plan"
  | "coverage_gap"
  | "child_quality"
  | "parent_changed"
  | "index_dirty"
  | "write_locked"
  | "commit_indeterminate"
  | "write_failed";

export class DecompositionFinalizeError extends Error {
  constructor(
    public readonly kind: DecompositionFinalizeFailureKind,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly rollbackErrors: string[] = [],
  ) {
    super(message);
    this.name = "DecompositionFinalizeError";
  }
}

export interface FinalizeDecompositionTransactionInput {
  adapter: ProjectAdapter;
  parentTask: ParsedTask;
  parentFilePath: string;
  parentContent: string;
  topology: DecompositionTopology;
  drafts: ChildDraft[];
  /** Preserve trusted provider diagnostics. Submitted HTTP/CLI metadata is untrusted. */
  preserveDraftDiagnostics?: boolean;
  /** Narrow test hook for exercising real reservation contention without a 15s wait. */
  reservationOptions?: Partial<TaskCreationLockOptions>;
  /** Narrow test hook for exercising irreversible commit-boundary recovery. */
  commitOptions?: DecompositionCommitOptions;
}

export interface FinalizeDecompositionTransactionResult {
  topology: DecompositionTopology;
  coverageReport: CoverageReport;
  drafts: ChildDraft[];
  writtenPaths: string[];
  parentStatusUpdated: boolean;
  /** Exact committed tracker bytes, used for post-commit readiness projection. */
  parentContent: string;
  commit: DecompositionCommitResult;
  /** Non-fatal reservation/journal cleanup diagnostics after a real commit. */
  warnings?: string[];
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertSafeTaskDirectory(projectRoot: string, taskDir: string): Promise<void> {
  try {
    await assertSafeDecompositionTaskDirectory(projectRoot, taskDir);
  } catch (error) {
    if (error instanceof DecompositionFinalizeError) throw error;
    throw new DecompositionFinalizeError(
      "write_failed",
      `Unsafe decomposition task directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function assertSafeParentPath(
  projectRoot: string,
  taskDir: string,
  parentFilePath: string,
): Promise<void> {
  try {
    if (!isPathContainedBy(taskDir, parentFilePath)) {
      throw new Error("the parent path is outside the configured task directory");
    }
    const [realProjectRoot, realTaskDir, realParent, parentStat] = await Promise.all([
      fs.realpath(projectRoot),
      fs.realpath(taskDir),
      fs.realpath(parentFilePath),
      fs.lstat(parentFilePath),
    ]);
    if (
      !parentStat.isFile() ||
      parentStat.isSymbolicLink() ||
      parentStat.nlink !== 1 ||
      !isPathContainedBy(realProjectRoot, realTaskDir) ||
      !isPathContainedBy(realProjectRoot, realParent) ||
      !isPathContainedBy(realTaskDir, realParent)
    ) {
      throw new Error(
        "the parent must be a single-link regular file contained by the real task directory and project root",
      );
    }
  } catch (error) {
    if (error instanceof DecompositionFinalizeError) throw error;
    throw new DecompositionFinalizeError(
      "write_failed",
      `Unsafe decomposition parent path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function topologyChildDiagnostics(topology: unknown): {
  childIds: Array<string | null>;
  finalChildIds: string[];
} {
  if (!isUnknownRecord(topology) || !Array.isArray(topology.subtasks)) {
    return { childIds: [], finalChildIds: [] };
  }
  const childIds = topology.subtasks.map((subtask: unknown) => {
    if (!isUnknownRecord(subtask) || typeof subtask.id !== "string") return null;
    return subtask.id;
  });
  const finalChildIds = topology.subtasks.flatMap((subtask: unknown) => {
    if (!isUnknownRecord(subtask) || typeof subtask.id !== "string") return [];
    return subtask.isFinal === true ? [subtask.id] : [];
  });
  return { childIds, finalChildIds };
}

function assertValidTopologyIdentity(
  adapter: ProjectAdapter,
  parentTaskId: string,
  topology: unknown,
): asserts topology is DecompositionTopology {
  const rawSubtasks = isUnknownRecord(topology) ? topology.subtasks : undefined;
  const configuredMax = adapter.config.preflight?.autoDecompose?.maxSubtasks;
  let maxSubtasks: number;
  try {
    const carriedMax = isUnknownRecord(topology) ? topology.maxSubtasks : undefined;
    if (carriedMax !== undefined && typeof carriedMax !== "number") {
      throw new RangeError("Topology maxSubtasks must be a number when provided.");
    }
    maxSubtasks = resolveEffectiveDecompositionMaxSubtasks(
      carriedMax ?? configuredMax,
      configuredMax,
    );
  } catch (error) {
    throw new DecompositionFinalizeError(
      "invalid_plan",
      error instanceof Error ? error.message : String(error),
      topologyChildDiagnostics(topology),
    );
  }
  if (
    !Array.isArray(rawSubtasks) ||
    !hasValidDecompositionChildCount(rawSubtasks.length, maxSubtasks)
  ) {
    throw new DecompositionFinalizeError(
      "invalid_plan",
      `Topology child-count limit requires at least two children and at most ${maxSubtasks}; received ${Array.isArray(rawSubtasks) ? rawSubtasks.length : "a non-array value"}.`,
      topologyChildDiagnostics(topology),
    );
  }
  if (!hasValidDecompositionTopologyIdentity(parentTaskId, rawSubtasks, maxSubtasks)) {
    throw new DecompositionFinalizeError(
      "invalid_plan",
      "Topology must contain at least two exact child rows within the configured maximum, sequential identities, unique backward-only dependencies, and exactly one trailing final child.",
      topologyChildDiagnostics(topology),
    );
  }
}

function validatePlan(
  adapter: ProjectAdapter,
  parentTask: ParsedTask,
  parentContent: string,
  topology: DecompositionTopology,
): CoverageReport {
  if (parentTask.rawContent !== parentContent) {
    throw new DecompositionFinalizeError(
      "parent_changed",
      "The parsed parent bytes do not match the parent content selected for finalization.",
    );
  }
  if (topology.parentTaskId !== parentTask.id) {
    throw new DecompositionFinalizeError(
      "invalid_plan",
      `Topology belongs to ${topology.parentTaskId}; expected ${parentTask.id}.`,
    );
  }
  const expectedHash = computeDecompositionParentHash(parentContent);
  if (!topology.parentContentHash || topology.parentContentHash !== expectedHash) {
    throw new DecompositionFinalizeError(
      "invalid_plan",
      "Topology is missing a matching parent-content hash. Re-run decomposition plan/materialize for the current parent.",
      { expectedParentContentHash: expectedHash },
    );
  }

  assertValidTopologyIdentity(adapter, parentTask.id, topology);

  const coverageReport = buildDecompositionCoverageReport(parentTask, topology.subtasks);
  if (coverageReport.hasCoverageGap) {
    throw new DecompositionFinalizeError(
      "coverage_gap",
      "Recomputed topology coverage is incomplete, duplicated, widened, or action-mismatched.",
      { coverageReport },
    );
  }
  return coverageReport;
}

function validateDrafts(
  topology: DecompositionTopology,
  drafts: ChildDraft[],
  preserveDraftDiagnostics: boolean,
): ChildDraft[] {
  const expectedIds = topology.subtasks.map((subtask) => subtask.id);
  const submittedIds = drafts.map((draft) => draft.subtaskId);
  if (
    drafts.length !== expectedIds.length ||
    new Set(submittedIds).size !== expectedIds.length ||
    submittedIds.some((id) => !expectedIds.includes(id))
  ) {
    throw new DecompositionFinalizeError(
      "child_quality",
      "Submitted child identities do not exactly match the topology.",
      { expectedIds, submittedIds, rejectedDrafts: [] },
    );
  }

  const validated = topology.subtasks.map((subtask) => {
    const submitted = drafts.find((draft) => draft.subtaskId === subtask.id);
    if (!submitted) {
      throw new DecompositionFinalizeError("child_quality", `Missing child draft ${subtask.id}.`, {
        expectedIds,
        submittedIds,
        rejectedDrafts: [],
      });
    }
    const gate = runChildQualityGate(subtask.id, submitted.markdown);
    const scopeDeficiencies = validateChildDraftScope(subtask, submitted.markdown);
    const trustedDeficiencies = preserveDraftDiagnostics ? submitted.deficiencies : [];
    const trustedParseError = preserveDraftDiagnostics ? submitted.parseError : undefined;
    const deficiencies = [
      ...new Set([...trustedDeficiencies, ...gate.deficiencies, ...scopeDeficiencies]),
    ];
    return {
      ...submitted,
      title: subtask.title,
      sectionsPresent: gate.sectionsPresent,
      prepScore: gate.prepScore,
      prepReady: gate.prepReady && !trustedParseError && scopeDeficiencies.length === 0,
      deficiencies,
      parseError: trustedParseError ?? gate.parseError,
    };
  });

  const rejectedDrafts = validated
    .filter((draft) => !draft.prepReady || Boolean(draft.parseError))
    .map((draft) => ({
      subtaskId: draft.subtaskId,
      prepScore: draft.prepScore,
      deficiencies: draft.deficiencies,
      ...(draft.parseError ? { parseError: draft.parseError } : {}),
    }));
  if (rejectedDrafts.length > 0) {
    throw new DecompositionFinalizeError(
      "child_quality",
      `${rejectedDrafts.length} child draft(s) failed deterministic quality or topology checks.`,
      { rejectedDrafts },
    );
  }
  return validated;
}

function assertValidDraftSubmissionShape(drafts: unknown): asserts drafts is ChildDraft[] {
  if (!Array.isArray(drafts)) {
    throw new DecompositionFinalizeError(
      "child_quality",
      "Finalize requires an array of child drafts.",
      { rejectedDrafts: [] },
    );
  }
  const invalidDraftIndexes = drafts.flatMap((draft: unknown, index) => {
    if (!isUnknownRecord(draft)) return [index];
    return typeof draft.subtaskId !== "string" ||
      draft.subtaskId.trim().length === 0 ||
      typeof draft.markdown !== "string"
      ? [index]
      : [];
  });
  if (invalidDraftIndexes.length > 0) {
    throw new DecompositionFinalizeError(
      "child_quality",
      "Each child draft must contain a non-empty subtaskId and Markdown string.",
      { invalidDraftIndexes, rejectedDrafts: [] },
    );
  }
}

async function validateCurrentParent(
  taskDir: string,
  parentTask: ParsedTask,
  parentFilePath: string,
  parentContent: string,
): Promise<void> {
  const claimants = await readTaskCreationClaimants(taskDir);
  const owners = claimants.get(parentTask.id.trim().toUpperCase()) ?? [];
  const expectedName = path.basename(parentFilePath);
  if (owners.length !== 1 || owners[0] !== expectedName) {
    throw new DecompositionFinalizeError(
      "parent_changed",
      `Parent ${parentTask.id} no longer has exactly one claimant at ${expectedName}.`,
      { claimants: owners },
    );
  }

  const current = await resolveParsedTaskFile(taskDir, parentTask.id);
  if (
    !current ||
    !samePath(current.filePath, parentFilePath) ||
    current.content !== parentContent ||
    current.task?.id !== parentTask.id
  ) {
    throw new DecompositionFinalizeError(
      "parent_changed",
      `Parent ${parentTask.id} changed after planning; no decomposition files were written.`,
    );
  }
}

function asFinalizeError(error: unknown): DecompositionFinalizeError {
  if (error instanceof DecompositionFinalizeError) return error;
  if (
    error instanceof DecompositionRecoveryError &&
    error.details.commitState === "unknown" &&
    error.details.retryable === false
  ) {
    return new DecompositionFinalizeError("commit_indeterminate", error.message, error.details);
  }
  if (error instanceof SubtaskWriteError) {
    return new DecompositionFinalizeError("write_failed", error.message, {}, error.rollbackErrors);
  }
  if (error instanceof TransactionPathStagedError) {
    return new DecompositionFinalizeError("index_dirty", error.message, {
      stagedPaths: error.stagedPaths,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DecompositionFinalizeError(
    message.includes("in progress") ||
      message.includes("task-creation reservation") ||
      message.includes(".task-creation.lock")
      ? "write_locked"
      : "write_failed",
    message,
  );
}

/**
 * Finalize one decomposition under the task-creation reservation. Every
 * caller uses this path so plan/draft trust checks and rollback cannot drift.
 */
export async function finalizeDecompositionTransaction(
  input: FinalizeDecompositionTransactionInput,
): Promise<FinalizeDecompositionTransactionResult> {
  const { adapter, parentTask, parentFilePath, parentContent, topology, drafts } = input;
  // Runtime callers deserialize untrusted JSON. Validate enough structure
  // before deriving reservation IDs, then repeat the full check while the
  // reservation is held before any write.
  assertValidTopologyIdentity(adapter, parentTask.id, topology);
  assertValidDraftSubmissionShape(drafts);
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  // Check before lock acquisition so an escaping task-directory junction
  // cannot even receive Quack's temporary reservation file.
  await assertSafeTaskDirectory(adapter.projectRoot, taskDir);
  let completedResult: FinalizeDecompositionTransactionResult | undefined;
  const reservationReleaseErrors: string[] = [];
  try {
    return await withTaskCreationReservation(
      taskDir,
      {
        creator: "decompose",
        requestedIds: [parentTask.id, ...topology.subtasks.map((subtask) => subtask.id)],
      },
      async () => {
        let commitCreated = false;
        let writtenPaths: string[] = [];
        let journal: { journal: DecompositionTransactionJournal; journalPath: string } | undefined;
        try {
          // Recovery and the new transaction share one reservation. A second
          // finalizer cannot create a journal in the scan/acquire gap.
          await recoverPendingTaskSpecMutationsWithinReservation(adapter);
          await assertSafeTaskDirectory(adapter.projectRoot, taskDir);
          await assertSafeParentPath(adapter.projectRoot, taskDir, parentFilePath);
          const coverageReport = validatePlan(adapter, parentTask, parentContent, topology);
          const validatedDrafts = validateDrafts(
            topology,
            drafts,
            input.preserveDraftDiagnostics === true,
          );
          await validateCurrentParent(taskDir, parentTask, parentFilePath, parentContent);

          const plannedWrites = planSubtaskSpecWrites(validatedDrafts, adapter);
          const transactionPaths = [parentFilePath, ...plannedWrites.map((item) => item.filePath)];
          await assertTransactionPathsUnstaged(adapter, transactionPaths);
          const updatedParent = buildDecompositionTrackerContent(
            parentContent,
            { ...topology, coverageReport },
            validatedDrafts,
          );
          journal = await createDecompositionTransactionJournal({
            adapter,
            parentTaskId: parentTask.id,
            parentFilePath,
            parentOriginalContent: parentContent,
            parentTargetContent: updatedParent,
            plannedWrites,
          });

          // Parent first: a watcher may briefly see DECOMPOSED without children,
          // but can never dispatch freshly created children beside a READY parent.
          await assertSafeTaskDirectory(adapter.projectRoot, taskDir);
          await assertSafeParentPath(adapter.projectRoot, taskDir, parentFilePath);
          await writeDecompositionFileAtomicReplace(parentFilePath, updatedParent, parentContent);
          await updateDecompositionTransactionJournal(
            journal.journalPath,
            journal.journal,
            "parent_written",
          );
          writtenPaths = await writeSubtaskSpecsWithinReservation(validatedDrafts, adapter, false);
          await updateDecompositionTransactionJournal(
            journal.journalPath,
            journal.journal,
            "children_written",
          );

          await assertDecompositionCommitBaseline(adapter, journal.journal);
          await updateDecompositionTransactionJournal(
            journal.journalPath,
            journal.journal,
            "committing",
          );
          const commit = await commitDecompositionTransaction(
            adapter,
            journal.journal,
            input.commitOptions,
          );
          if (!commit.committed) {
            throw new Error("Git did not create the decomposition commit.");
          }
          commitCreated = true;
          if (commit.warnings) reservationReleaseErrors.push(...commit.warnings);
          if (!commit.journalReconciled && !commit.recoveryPending) {
            try {
              const projection = await completeDecompositionTransactionJournal(
                adapter,
                journal.journalPath,
                journal.journal,
              );
              commit.recoveryPending = true;
              commit.statusProjectionId = projection.projectionId;
            } catch (journalError) {
              commit.recoveryPending = true;
              reservationReleaseErrors.push(
                `journal recovery/status projection pending: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
              );
            }
          }
          completedResult = {
            topology: { ...topology, coverageReport },
            coverageReport,
            drafts: validatedDrafts,
            writtenPaths,
            parentStatusUpdated: updatedParent !== parentContent,
            parentContent: updatedParent,
            commit,
            warnings: reservationReleaseErrors,
          };
          return completedResult;
        } catch (error) {
          // Once Git created a commit, never roll the worktree back across the
          // new HEAD. A verification mismatch retains the journal for explicit
          // recovery and reports a committed-but-unverified failure.
          const commitReportedByError =
            typeof error === "object" &&
            error !== null &&
            ((error as { decompositionCommitCreated?: unknown }).decompositionCommitCreated ===
              true ||
              (error instanceof DecompositionRecoveryError && error.details.committed === true));
          const commitIndeterminate =
            error instanceof DecompositionRecoveryError &&
            error.details.commitState === "unknown" &&
            error.details.retryable === false;
          if (commitIndeterminate) {
            throw asFinalizeError(error);
          }
          if (commitCreated || commitReportedByError) {
            const failure = asFinalizeError(error);
            throw new DecompositionFinalizeError(
              failure.kind,
              failure.message,
              { ...failure.details, committed: true },
              failure.rollbackErrors,
            );
          }
          const failure = asFinalizeError(error);
          const rollbackErrors = [...failure.rollbackErrors];
          const rollbackAlreadyReconciled =
            error instanceof DecompositionRecoveryError &&
            error.details.rollbackReconciled === true;
          if (journal && !rollbackAlreadyReconciled) {
            try {
              await recoverDecompositionJournalWithinReservation(adapter, journal.journalPath);
            } catch (rollbackError) {
              rollbackErrors.push(
                `journal recovery: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            }
          }
          throw new DecompositionFinalizeError(
            failure.kind,
            failure.message,
            failure.details,
            rollbackErrors,
          );
        }
      },
      {
        ...input.reservationOptions,
        onReleaseError: (releaseError) => {
          reservationReleaseErrors.push(
            `reservation release: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        },
      },
    );
  } catch (error) {
    // A reservation-release failure cannot undo a commit that already
    // succeeded, so never report the finalized transaction as failed.
    if (completedResult) return completedResult;
    const failure = asFinalizeError(error);
    if (reservationReleaseErrors.length === 0) throw failure;
    throw new DecompositionFinalizeError(failure.kind, failure.message, failure.details, [
      ...failure.rollbackErrors,
      ...reservationReleaseErrors,
    ]);
  }
}
