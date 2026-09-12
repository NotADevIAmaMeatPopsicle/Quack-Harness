import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  formatDuplicateClaimantsMessage,
  normalizeClaimantTaskId,
} from "../core/duplicate-claimants.js";
import { parseTaskFile } from "../core/task-parser.js";
import {
  readTaskCreationClaimants,
  withTaskCreationReservation,
} from "../core/task-creation-reservation.js";
import {
  assertSafeDecompositionTaskDirectory,
  writeDecompositionFileAtomicReplace,
} from "./decomposition-file-io.js";
import {
  completeCanonicalTaskMutationJournal,
  createCanonicalTaskMutationJournal,
} from "./canonical-task-mutation-journal.js";

export type CanonicalTaskSpecMutationErrorCode =
  | "task_changed"
  | "task_decomposed"
  | "task_identity_conflict"
  | "task_invalid"
  | "unsafe_task_path";

export class CanonicalTaskSpecMutationError extends Error {
  constructor(
    public readonly code: CanonicalTaskSpecMutationErrorCode,
    message: string,
    public readonly taskId?: string,
    public readonly claimants: readonly string[] = [],
  ) {
    super(message);
    this.name = "CanonicalTaskSpecMutationError";
  }
}

export interface CanonicalTaskSpecMutationInput<T> {
  adapter: ProjectAdapter;
  taskId: string;
  taskFilePath: string;
  /** Exact bytes observed before any long-running preparation or review. */
  expectedContent: string;
  replacementContent: string;
  /** Reserved only for the explicit repair route. */
  allowUnparseableCurrent?: boolean;
  /** Reserved for lifecycle roll-up of a completed decomposition parent. */
  allowDecomposedCurrent?: boolean;
  /** Optional policy check that must still pass inside the reservation. */
  authorize?: () => boolean | Promise<boolean>;
  /** Runs after the durable replacement while the reservation is still held. */
  afterWrite?: () => T | Promise<T>;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function assertSafeTaskFile(
  adapter: ProjectAdapter,
  taskDir: string,
  taskFilePath: string,
): Promise<void> {
  const resolvedFile = path.resolve(taskFilePath);
  if (!isContained(taskDir, resolvedFile) || !samePath(path.dirname(resolvedFile), taskDir)) {
    throw new CanonicalTaskSpecMutationError(
      "unsafe_task_path",
      "Canonical task mutation target is outside the configured task directory.",
    );
  }
  try {
    const [realRoot, realTaskDir, realFile, stat] = await Promise.all([
      fs.realpath(adapter.projectRoot),
      fs.realpath(taskDir),
      fs.realpath(resolvedFile),
      fs.lstat(resolvedFile),
    ]);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !isContained(realRoot, realTaskDir) ||
      !isContained(realRoot, realFile) ||
      !isContained(realTaskDir, realFile)
    ) {
      throw new Error("target is not a single-link regular file in the real task directory");
    }
  } catch (error) {
    if (error instanceof CanonicalTaskSpecMutationError) throw error;
    throw new CanonicalTaskSpecMutationError(
      "unsafe_task_path",
      `Canonical task mutation target is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Serialize an existing canonical task-spec mutation with decomposition.
 * Recovery, exact claimant/content validation, and the caller's write/commit
 * all occur under one reservation, so no READY parent can be overwritten by
 * a stale route result after its decomposition has committed.
 */
export async function withCanonicalTaskSpecMutationFence<T>(
  input: CanonicalTaskSpecMutationInput<T>,
): Promise<T | undefined> {
  const {
    adapter,
    taskId,
    taskFilePath,
    expectedContent,
    replacementContent,
    allowUnparseableCurrent,
    allowDecomposedCurrent,
    authorize,
    afterWrite,
  } = input;
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await assertSafeDecompositionTaskDirectory(adapter.projectRoot, taskDir);
  let replacement;
  try {
    replacement = parseTaskFile(replacementContent, taskFilePath);
  } catch (error) {
    throw new CanonicalTaskSpecMutationError(
      "task_invalid",
      `Replacement for ${taskId} is not a valid canonical spec: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (normalizeClaimantTaskId(replacement.id) !== normalizeClaimantTaskId(taskId)) {
    throw new CanonicalTaskSpecMutationError(
      "task_identity_conflict",
      `Replacement declares ${replacement.id}, not ${taskId}.`,
    );
  }
  if (replacement.status === "DECOMPOSED") {
    throw new CanonicalTaskSpecMutationError(
      "task_invalid",
      "Only decomposition finalization may publish a DECOMPOSED task spec.",
    );
  }

  return withTaskCreationReservation(
    taskDir,
    { creator: "task-mutation", requestedIds: [taskId] },
    async () => {
      // Keep journal recovery lazy at this boundary. Besides avoiding the
      // journal/subtask-writer import cycle, canonical status mutations must
      // not eagerly initialize the journal's git process adapter merely by
      // importing lifecycle code.
      const { recoverPendingTaskSpecMutationsWithinReservation } =
        await import("./decomposition-transaction-journal.js");
      await recoverPendingTaskSpecMutationsWithinReservation(adapter);
      await assertSafeDecompositionTaskDirectory(adapter.projectRoot, taskDir);
      await assertSafeTaskFile(adapter, taskDir, taskFilePath);

      const currentContent = await fs.readFile(taskFilePath, "utf-8");
      if (currentContent !== expectedContent) {
        throw new CanonicalTaskSpecMutationError(
          "task_changed",
          `Task ${taskId} changed before its canonical mutation could be published.`,
        );
      }

      let parsed = null;
      try {
        parsed = parseTaskFile(currentContent, taskFilePath);
      } catch (error) {
        if (!allowUnparseableCurrent) {
          throw new CanonicalTaskSpecMutationError(
            "task_invalid",
            `Task ${taskId} is no longer a valid canonical spec: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (parsed && normalizeClaimantTaskId(parsed.id) !== normalizeClaimantTaskId(taskId)) {
        throw new CanonicalTaskSpecMutationError(
          "task_identity_conflict",
          `Canonical mutation target declares ${parsed.id}, not ${taskId}.`,
        );
      }
      if (parsed?.status === "DECOMPOSED" && !allowDecomposedCurrent) {
        throw new CanonicalTaskSpecMutationError(
          "task_decomposed",
          `Task ${taskId} is DECOMPOSED and cannot be rewritten by this route.`,
        );
      }

      const owners =
        (await readTaskCreationClaimants(taskDir)).get(normalizeClaimantTaskId(taskId)) ?? [];
      const expectedName = path.basename(taskFilePath);
      const validOwners = parsed
        ? owners.length === 1 && owners[0] === expectedName
        : owners.length === 0;
      if (!validOwners) {
        const ownerEvidence = owners.length > 0 ? owners.join(", ") : "none";
        const duplicateMessage =
          owners.length > 1 ? formatDuplicateClaimantsMessage(taskId, owners) : undefined;
        throw new CanonicalTaskSpecMutationError(
          "task_identity_conflict",
          duplicateMessage ??
            `Task ${taskId} no longer has one uncontested canonical claimant at ${expectedName}; current claimants: ${ownerEvidence}.`,
          taskId,
          owners,
        );
      }

      if (authorize && !(await authorize())) return undefined;

      const journalPath = await createCanonicalTaskMutationJournal({
        adapter,
        taskId,
        taskFilePath,
        originalContent: expectedContent,
        targetContent: replacementContent,
      });
      try {
        await writeDecompositionFileAtomicReplace(
          taskFilePath,
          replacementContent,
          expectedContent,
        );
        await completeCanonicalTaskMutationJournal(journalPath);
      } catch (error) {
        try {
          const { recoverPendingCanonicalTaskMutationsWithinReservation } =
            await import("./canonical-task-mutation-journal.js");
          await recoverPendingCanonicalTaskMutationsWithinReservation(adapter);
        } catch (recoveryError) {
          if (typeof error === "object" && error !== null) {
            Object.defineProperty(error, "canonicalMutationRecoveryError", {
              value: recoveryError,
              configurable: true,
              enumerable: true,
            });
          }
        }
        throw error;
      }
      return afterWrite?.();
    },
  );
}
