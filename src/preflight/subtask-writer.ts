// ─── Subtask Spec Writer ────────────────────────────────────────────
// Serializes pre-materialized child draft specs to disk.
// The content has already been generated and quality-gated by
// subtask-materializer.ts — this module only handles final file I/O.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { ChildDraft } from "./decompose-types.js";
import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import {
  assertTaskCreationIdsAvailable,
  readTaskCreationClaimants,
  withTaskCreationReservation,
} from "../core/task-creation-reservation.js";
import {
  removeDecompositionFileIfExact,
  writeDecompositionFileAtomicExclusive,
} from "./decomposition-file-io.js";

const execFileAsync = promisify(execFile);

export interface PlannedSubtaskSpecWrite {
  draft: ChildDraft;
  declaredId: string;
  fileName: string;
  filePath: string;
}

export class SubtaskWriteError extends Error {
  constructor(
    message: string,
    public readonly writtenPaths: string[] = [],
    public readonly rollbackErrors: string[] = [],
  ) {
    super(message);
    this.name = "SubtaskWriteError";
  }
}

export class TransactionPathStagedError extends Error {
  constructor(public readonly stagedPaths: string[]) {
    super(
      `Decomposition transaction paths already have staged changes: ${stagedPaths.join(", ")}. Commit or unstage them before finalizing.`,
    );
    this.name = "TransactionPathStagedError";
  }
}

export function planSubtaskSpecWrites(
  drafts: ChildDraft[],
  adapter: ProjectAdapter,
): PlannedSubtaskSpecWrite[] {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  const planned = drafts.map((draft) => {
    let declaredId: string;
    try {
      declaredId = parseTaskFile(draft.markdown).id;
    } catch (err) {
      if (err instanceof TaskParseError) {
        throw new Error(`Draft ${draft.subtaskId} failed parse at write time: ${err.message}`);
      }
      throw err;
    }
    if (declaredId !== draft.subtaskId) {
      throw new Error(
        `Draft ${draft.subtaskId} declares ${declaredId}; refusing identity mismatch.`,
      );
    }

    const fileName = buildSubtaskSpecFileName(draft.subtaskId, draft.title);
    return { draft, declaredId, fileName, filePath: path.join(taskDir, fileName) };
  });

  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const item of planned) {
    if (seenIds.has(item.declaredId)) duplicateIds.add(item.declaredId);
    seenIds.add(item.declaredId);
  }
  if (duplicateIds.size > 0) {
    throw new Error(
      `Subtask batch declares duplicate ids: ${[...duplicateIds].sort().join(", ")}. No files were written.`,
    );
  }
  return planned;
}

async function assertLegacyDecomposeLockAbsent(taskDir: string): Promise<void> {
  const legacyLockPath = path.join(taskDir, ".decompose.lock");
  try {
    await fs.stat(legacyLockPath);
    throw new Error(
      `Another decompose operation is in progress. If stale, delete ${legacyLockPath}`,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Caller must already hold the task-creation reservation. */
export async function writeSubtaskSpecsWithinReservation(
  drafts: ChildDraft[],
  adapter: ProjectAdapter,
  rollbackOnFailure = true,
): Promise<string[]> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);
  await assertLegacyDecomposeLockAbsent(taskDir);
  const planned = planSubtaskSpecWrites(drafts, adapter);

  for (const item of planned) {
    try {
      await fs.stat(item.filePath);
      throw new Error(
        `Child spec ${item.fileName} already exists. Delete or rename it before re-running decomposition.`,
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const claimants = await readTaskCreationClaimants(taskDir);
  assertTaskCreationIdsAvailable(
    claimants,
    planned.map(({ declaredId, fileName }) => ({ taskId: declaredId, fileName })),
  );

  const writtenPaths: string[] = [];
  try {
    for (const item of planned) {
      await writeDecompositionFileAtomicExclusive(item.filePath, item.draft.markdown);
      writtenPaths.push(item.filePath);
    }
    return writtenPaths;
  } catch (writeErr: unknown) {
    const rollbackErrors: string[] = [];
    if (rollbackOnFailure) {
      for (const writtenPath of writtenPaths) {
        try {
          const plannedWrite = planned.find((item) => item.filePath === writtenPath);
          if (!plannedWrite) throw new Error("Missing planned draft for written child path.");
          await removeDecompositionFileIfExact(writtenPath, plannedWrite.draft.markdown);
        } catch (rollbackErr) {
          rollbackErrors.push(
            `child cleanup ${writtenPath}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        }
      }
    }
    const message =
      (writeErr as NodeJS.ErrnoException).code === "EEXIST"
        ? "A child destination appeared during decomposition. The whole batch was rolled back."
        : writeErr instanceof Error
          ? writeErr.message
          : String(writeErr);
    throw new SubtaskWriteError(message, writtenPaths, rollbackErrors);
  }
}

/**
 * Write pre-materialized child draft specs to disk.
 * Lock → validate → write → unlock. No content generation happens here.
 *
 * @param drafts - Pre-built child drafts from subtask-materializer
 * @param adapter - Project adapter with config
 * @returns Array of file paths created
 */
export async function writeSubtaskSpecs(
  drafts: ChildDraft[],
  adapter: ProjectAdapter,
): Promise<string[]> {
  const taskDir = path.resolve(adapter.projectRoot, adapter.config.project.taskDir);

  // Ensure task directory exists
  await fs.mkdir(taskDir, { recursive: true });

  return withTaskCreationReservation(
    taskDir,
    {
      creator: "decompose",
      requestedIds: drafts.map((draft) => draft.subtaskId),
    },
    async () => {
      // This legacy public writer shares the same reservation as the durable
      // finalizer. Load the journal module lazily to avoid a module-init cycle:
      // transaction recovery imports the write-planning helpers above.
      const { recoverPendingTaskSpecMutationsWithinReservation } =
        await import("./decomposition-transaction-journal.js");
      await recoverPendingTaskSpecMutationsWithinReservation(adapter);
      return writeSubtaskSpecsWithinReservation(drafts, adapter);
    },
  );
}

function transactionRelativePaths(adapter: ProjectAdapter, pathsToCheck: string[]): string[] {
  return pathsToCheck.map((filePath) =>
    path.relative(adapter.projectRoot, filePath).replace(/\\/g, "/"),
  );
}

/** Refuse before any write when a transaction path already has index state. */
export async function assertTransactionPathsUnstaged(
  adapter: ProjectAdapter,
  pathsToCheck: string[],
): Promise<void> {
  if (pathsToCheck.length === 0) return;
  const relPaths = transactionRelativePaths(adapter, pathsToCheck);
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...relPaths],
    { cwd: adapter.projectRoot, encoding: "utf-8" },
  );
  const stagedPaths = stdout
    .split("\0")
    .filter(Boolean)
    .filter((entry) => entry.slice(0, 2) !== "??" && entry[0] !== " ")
    .map((entry) => entry.slice(3));
  if (stagedPaths.length > 0) throw new TransactionPathStagedError(stagedPaths);
}

export interface CommitSubtaskSpecsResult {
  /** True if a commit was created. False if there were no staged changes (e.g., specs already committed). */
  committed: boolean;
  /** Short SHA of the resulting commit (when committed=true). */
  sha?: string;
  /** Specific paths that were staged (relative to projectRoot). */
  staged: string[];
}

/**
 * Commit the freshly-written subtask specs and any explicitly supplied parent
 * tracker path. Without this, dispatcher worktrees created via `git worktree
 * add` materialize from the object database and cannot see the finalized
 * decomposition at session_start.
 *
 * Behavior:
 *   - Stages ONLY the specific paths passed in (never `git add .` or `-A`).
 *   - Commits with a greppable message: `docs(tasks): auto-commit subtasks for <parentId>`.
 *   - If the working tree has nothing to commit (e.g., the files were already
 *     tracked + identical), returns committed=false.
 *   - Push behavior is the caller's responsibility (mirror existing dispatch
 *     auto-push semantics).
 *
 * @param adapter - Project adapter (used for projectRoot)
 * @param pathsToCommit - Absolute paths in the decomposition transaction
 * @param parentTaskId - Parent task ID (for commit message)
 */
async function commitSubtaskSpecsInternal(
  adapter: ProjectAdapter,
  pathsToCommit: string[],
  parentTaskId: string,
  checkIndexBeforeStage: boolean,
): Promise<CommitSubtaskSpecsResult> {
  if (pathsToCommit.length === 0) {
    return { committed: false, staged: [] };
  }

  const projectRoot = adapter.projectRoot;
  const relPaths = transactionRelativePaths(adapter, pathsToCommit);

  if (checkIndexBeforeStage) {
    await assertTransactionPathsUnstaged(adapter, pathsToCommit);
  }

  // Stage only the specific paths.
  await execFileAsync("git", ["add", "--", ...relPaths], { cwd: projectRoot });

  // Check if there are staged changes — `git diff --cached --quiet` exits 1
  // when there are staged changes, 0 when clean.
  let hasStagedChanges = false;
  try {
    await execFileAsync("git", ["diff", "--cached", "--quiet", "--", ...relPaths], {
      cwd: projectRoot,
    });
    hasStagedChanges = false;
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    return { committed: false, staged: relPaths };
  }

  const msg = `docs(tasks): auto-commit subtasks for ${parentTaskId}`;
  // `--only` is essential here: a plain `git commit` would absorb unrelated
  // changes the user had already staged before auto-decomposition began.
  await execFileAsync("git", ["commit", "--only", "-m", msg, "--", ...relPaths], {
    cwd: projectRoot,
  });

  let sha: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
    });
    sha = stdout.trim();
  } catch {
    // best-effort
  }

  return { committed: true, sha, staged: relPaths };
}

export async function commitSubtaskSpecs(
  adapter: ProjectAdapter,
  pathsToCommit: string[],
  parentTaskId: string,
): Promise<CommitSubtaskSpecsResult> {
  return commitSubtaskSpecsInternal(adapter, pathsToCommit, parentTaskId, true);
}

/**
 * Commit after a caller has already checked the complete transaction path set
 * before performing any writes. Rechecking after writes would create a race:
 * an external stage appearing in between could be mistaken for transaction
 * state and then removed by rollback. The decomposition finalizer is the only
 * intended caller and holds the task-creation reservation for the whole span.
 */
export async function commitSubtaskSpecsWithinReservation(
  adapter: ProjectAdapter,
  pathsToCommit: string[],
  parentTaskId: string,
): Promise<CommitSubtaskSpecsResult> {
  return commitSubtaskSpecsInternal(adapter, pathsToCommit, parentTaskId, false);
}

/**
 * Remove only the decomposition transaction's paths from the index after a
 * failed commit. Unrelated staged user work remains untouched.
 */
export async function unstageSubtaskSpecs(
  adapter: ProjectAdapter,
  pathsToUnstage: string[],
): Promise<void> {
  if (pathsToUnstage.length === 0) return;
  const relPaths = pathsToUnstage.map((filePath) =>
    path.relative(adapter.projectRoot, filePath).replace(/\\/g, "/"),
  );
  await execFileAsync("git", ["reset", "--quiet", "HEAD", "--", ...relPaths], {
    cwd: adapter.projectRoot,
  });
}

/**
 * Convert a title to a URL-safe slug.
 */
export function buildSubtaskSpecFileName(subtaskId: string, title: string): string {
  return `${subtaskId}-${slugify(title)}.md`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
