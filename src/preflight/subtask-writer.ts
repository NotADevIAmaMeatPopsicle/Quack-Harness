// ─── Subtask Spec Writer ────────────────────────────────────────────
// Serializes pre-materialized child draft specs to disk.
// The content has already been generated and quality-gated by
// subtask-materializer.ts — this module only handles final file I/O.

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { ChildDraft } from "./decompose-types.js";
import { parseTaskFile, TaskParseError } from "../core/task-parser.js";

const execAsync = promisify(exec);

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

  // Use lock file to prevent concurrent writes
  const lockPath = path.join(taskDir, ".decompose.lock");
  try {
    await fs.writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
  } catch {
    throw new Error(`Another decompose operation is in progress. If stale, delete ${lockPath}`);
  }

  try {
    const writtenPaths: string[] = [];

    for (const draft of drafts) {
      // Re-validate at write time (content was quality-gated, but confirm parse)
      try {
        parseTaskFile(draft.markdown);
      } catch (err) {
        if (err instanceof TaskParseError) {
          throw new Error(`Draft ${draft.subtaskId} failed parse at write time: ${err.message}`);
        }
        throw err;
      }

      const fileName = `${draft.subtaskId}-${slugify(draft.title)}.md`;
      const filePath = path.join(taskDir, fileName);

      // Refuse to overwrite an existing child spec — use { flag: "wx" } so that
      // the write fails atomically if the file already exists.  This prevents
      // silent data loss when decomposeRecommendedTask is called on a task that
      // was already (partially) decomposed.
      try {
        await fs.writeFile(filePath, draft.markdown, { encoding: "utf-8", flag: "wx" });
      } catch (writeErr: unknown) {
        const nodeErr = writeErr as NodeJS.ErrnoException;
        if (nodeErr.code === "EEXIST") {
          throw new Error(
            `Child spec ${fileName} already exists. Delete or rename it before re-running decomposition.`,
          );
        }
        throw writeErr;
      }
      writtenPaths.push(filePath);
    }

    return writtenPaths;
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
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
 * Commit the freshly-written subtask spec files to the parent project's main
 * branch. This is the fix for TASK-900: without it, dispatcher worktrees
 * created via `git worktree add` materialize from the object database and
 * cannot see uncommitted spec files, so subtask dispatches fail at
 * session_start with "task not found".
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
 * @param subtaskPaths - Absolute paths to spec files just written
 * @param parentTaskId - Parent task ID (for commit message)
 */
export async function commitSubtaskSpecs(
  adapter: ProjectAdapter,
  subtaskPaths: string[],
  parentTaskId: string,
): Promise<CommitSubtaskSpecsResult> {
  if (subtaskPaths.length === 0) {
    return { committed: false, staged: [] };
  }

  const projectRoot = adapter.projectRoot;
  const relPaths = subtaskPaths.map((p) => path.relative(projectRoot, p).replace(/\\/g, "/"));

  // Stage only the specific paths.
  await execAsync(`git add -- ${relPaths.map((p) => `"${p}"`).join(" ")}`, { cwd: projectRoot });

  // Check if there are staged changes — `git diff --cached --quiet` exits 1
  // when there are staged changes, 0 when clean.
  let hasStagedChanges = false;
  try {
    await execAsync("git diff --cached --quiet -- " + relPaths.map((p) => `"${p}"`).join(" "), {
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
  await execAsync(`git commit -m "${msg}"`, { cwd: projectRoot });

  let sha: string | undefined;
  try {
    const { stdout } = await execAsync("git rev-parse --short HEAD", {
      cwd: projectRoot,
    });
    sha = stdout.trim();
  } catch {
    // best-effort
  }

  return { committed: true, sha, staged: relPaths };
}

/**
 * Convert a title to a URL-safe slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
