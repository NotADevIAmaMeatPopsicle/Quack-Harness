// ─── Task Service ──────────────────────────────────────────────────
// Reads and parses task files from the project's task directory.
// Used by the monitor server to provide task listing APIs.
// Supports overlaying session outcomes onto task status so the
// dashboard shows tasks as COMPLETE when the judge has approved them.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  applyResolvedStatusHygiene,
  buildStructuralBacklogHygieneReport,
  emptyBacklogHygieneReport,
} from "../core/task-hygiene.js";
import type { BacklogHygieneEvaluationBase } from "../core/task-hygiene.js";
import {
  resolveParsedTaskFile,
  resolveTaskFilePath,
  type ResolvedTaskFile,
} from "../core/task-file-resolver.js";
import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import type {
  BacklogHygieneReport,
  ParsedTask,
  TaskBacklogHygiene,
  VerifiedJsonEntry,
} from "../core/types.js";
import { freshReadAllTasks, startupValidation as runStartupValidation } from "./task-freshness.js";
import type { QuackDB, NoopDB } from "../db/index.js";
import type { TaskStatusRow, VerifiedRow } from "../db/types.js";
import {
  buildTaskProjection,
  getUnverifiedApprovedTaskIds as getUnverifiedApprovedTaskIdsFromProjection,
} from "./task-projection.js";
import type { TaskProjectionStatusSource, TaskSessionInfo } from "./task-projection.js";
import type { TaskStateAuthority, TaskVerificationEvidence } from "../core/task-state.js";
import type { TaskStatus } from "../core/task-status.js";

export type { TaskSessionInfo } from "./task-projection.js";

/**
 * NOTE (TASK-1317): this is a hand-maintained near-duplicate of
 * `TaskProjection` in task-projection.ts. Two structural types for
 * the same object, kept in sync by hand, is its own drift surface;
 * unifying them is out of this slice's scope and belongs with the
 * P2-4 reader consolidation.
 */
export interface TaskSummary {
  id: string;
  title: string;
  priority: string;
  effort: string;
  status: string;
  targetBranch?: string;
  branchGroup?: string;
  supersededBy: string[];
  supersedes: string[];
  relevanceReview: string;
  /** Effective status derived from session outcomes (overrides file status) */
  effectiveStatus: string;
  /**
   * @deprecated TASK-1317: use `authority`. The file/session/db
   * vocabulary cannot distinguish a human VERIFIED from a scanner
   * SOFT-VERIFIED. Removed in P2-4.
   */
  statusSource?: TaskProjectionStatusSource;
  /** TASK-1317: which source supplied `effectiveStatus`. */
  authority?: TaskStateAuthority;
  /** TASK-1317: the normalized view; null for non-canonical values. */
  typedStatus?: TaskStatus | null;
  /** TASK-1317: latest-verification evidence, carrying the verdict so
   * the two-tier done state is representable (P4-3). Evidence only: it
   * does not decide `effectiveStatus` until P2-4. */
  verification?: TaskVerificationEvidence;
  blockedBy: string[];
  blocks: string[];
  dependencyCount?: number;
  isTerminal?: boolean;
  tags: string[];
  successCriteriaCount: number;
  /** True when task has an approved session but no verified.json entry */
  needsVerification: boolean;
  /** Latest session outcome for this task (if any) */
  lastOutcome?: string;
  /** Latest session cost */
  lastCostUsd?: number;
  /** Non-fatal parsing advisories for this task file. */
  parseWarnings?: string[];
  /** Automatic queue/admin suppression reasons for stale or ambiguous specs. */
  backlogHygiene?: TaskBacklogHygiene;
}

/** A task file that failed to parse. */
export interface TaskParseErrorInfo {
  file: string;
  error: string;
}

/** A task file parsed successfully but emitted non-fatal warnings. */
export interface TaskParseWarningInfo {
  file: string;
  taskId: string;
  warnings: string[];
}

/** Result of parsing all tasks, including any errors. */
export interface ParseAllTasksResult {
  tasks: ParsedTask[];
  parseErrors: TaskParseErrorInfo[];
  parseWarnings: TaskParseWarningInfo[];
  /**
   * STRUCTURAL hygiene only: duplicate ids and supersession (TASK-1318
   * S2c). Status hygiene cannot be answered here: parsing happens
   * before the runtime status overlay is loaded, so evaluating ON_HOLD
   * and REJECTED at this point would let a markdown edit veto
   * automation for a task the runtime store has already spoken for.
   * `projectTasks` folds status hygiene on after resolution.
   */
  structuralHygiene: BacklogHygieneEvaluationBase;
}

export interface TaskListResult {
  tasks: TaskSummary[];
  parseErrors: TaskParseErrorInfo[];
  parseWarnings: TaskParseWarningInfo[];
  hygiene?: BacklogHygieneReport;
}

/**
 * Derive effective task status by combining the file status with session outcomes.
 * File status is the source of truth — sessions only upgrade status, never downgrade.
 * - COMPLETE/VERIFIED in file → always terminal (human intent)
 * - READY in file → only upgrade to COMPLETE (approved) or IN_PROGRESS (active)
 * - BACKLOG in file → only upgrade to COMPLETE (approved) or IN_PROGRESS (active)
 * - Sessions with rejected/failed outcomes do NOT override file status,
 *   because the spec may have been manually updated after the rejection.
 */
// TODO(UI 2.0): remove after the remaining task projection helpers move out of this service.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function deriveEffectiveStatus(fileStatus: string, session?: TaskSessionInfo): string {
  if (!session) return fileStatus;

  // File status takes precedence for terminal states
  if (fileStatus === "COMPLETE" || fileStatus === "VERIFIED") return fileStatus;

  // Sessions can only upgrade status, never downgrade
  if (session.outcome === "approved") return "COMPLETE";
  if (session.status === "active") return "IN_PROGRESS";

  // For rejected/failed: only override if file status is still IN_PROGRESS
  // (meaning the task was dispatched and failed without human intervention).
  // If file says READY/BACKLOG, the human has reset it — respect that.
  if (
    (session.outcome === "rejected" || session.outcome === "agent_failed") &&
    fileStatus === "IN_PROGRESS"
  )
    return "REJECTED";

  return fileStatus;
}

/**
 * Returns the set of task IDs that have an approved session outcome
 * but no entry in verified.json. These need manual verification.
 */
export function getUnverifiedApprovedTaskIds(
  sessionsByTask: Map<string, TaskSessionInfo>,
  verifiedIndex?: Record<string, VerifiedJsonEntry>,
): Set<string> {
  return getUnverifiedApprovedTaskIdsFromProjection(sessionsByTask, verifiedIndex);
}

export class TaskService {
  constructor(
    private readonly projectRoot: string,
    private readonly taskDir: string,
  ) {}

  private get absoluteTaskDir(): string {
    return path.resolve(this.projectRoot, this.taskDir);
  }

  /** Absolute task directory used by admission gates and strict scans. */
  getTaskDirectory(): string {
    return this.absoluteTaskDir;
  }

  /**
   * List all tasks as summaries (cheap — parses metadata only).
   * If sessionsByTask is provided, overlays session outcomes onto task status.
   * Returns { tasks, parseErrors } so callers can surface failures.
   */
  /** Track last parsed count for freshness comparison */
  private lastParsedCount = 0;

  /** Get last parsed task count (used by freshness monitor) */
  getLastParsedCount(): number {
    return this.lastParsedCount;
  }

  /**
   * The single projection mapping used by BOTH listTasks and
   * refreshTasks (TASK-1317 round-2 F1). Keeping it in one place is
   * what makes "one batch read per operation, and the same evidence on
   * every path" checkable rather than aspirational.
   *
   * TASK-1318 S2c: it is also where STATUS hygiene is evaluated. The
   * resolved status only exists here. `buildTaskProjection` runs the
   * shared resolver over the runtime row, the session and the spec, and
   * `effectiveStatus` is its answer, so this is the earliest honest
   * moment to ask whether a task is ON_HOLD or REJECTED. Asking at parse
   * time meant a spec line vetoed automation for tasks the runtime store
   * disagreed with, which is the inversion TASK-1318 removes.
   *
   * Hygiene is folded from the SAME resolved value the projection
   * reports, so `backlogHygiene` and `effectiveStatus` cannot contradict
   * each other for the same task.
   */
  private projectTasks(
    parsedTasks: ParsedTask[],
    inputs: {
      sessionsByTask?: Map<string, TaskSessionInfo>;
      verifiedIndex?: Record<string, VerifiedJsonEntry>;
      dbStatuses?: Map<string, TaskStatusRow>;
      verifiedRows?: Map<string, VerifiedRow>;
      structuralHygiene: BacklogHygieneEvaluationBase;
    },
  ): { tasks: TaskSummary[]; hygiene: BacklogHygieneReport } {
    const projected = parsedTasks.map((task) => {
      const verified = inputs.verifiedRows?.get(task.id);
      return {
        task,
        projection: buildTaskProjection(task, {
          session: inputs.sessionsByTask?.get(task.id),
          dbStatus: inputs.dbStatuses?.get(task.id),
          verifiedIndex: inputs.verifiedIndex,
          backlogHygiene: inputs.structuralHygiene.byTaskId.get(task.id),
          ...(verified
            ? {
                verification: {
                  verdict: verified.verdict,
                  method: verified.method,
                  commitSha: verified.commit_sha,
                  verifiedAt: verified.verified_at,
                },
              }
            : {}),
        }),
      };
    });

    const resolvedHygiene = applyResolvedStatusHygiene(
      inputs.structuralHygiene,
      projected.map(({ task, projection }) => ({
        taskId: task.id,
        title: task.title,
        status: projection.effectiveStatus,
        specStatus: task.status,
      })),
    );

    const tasks = projected.map(({ task, projection }) => ({
      ...projection,
      backlogHygiene: resolvedHygiene.byTaskId.get(task.id) ?? projection.backlogHygiene,
    }));

    return { tasks, hygiene: resolvedHygiene.report };
  }

  async listTasks(
    sessionsByTask?: Map<string, TaskSessionInfo>,
    verifiedIndex?: Record<string, VerifiedJsonEntry>,
    db?: QuackDB | NoopDB,
  ): Promise<TaskListResult> {
    const {
      tasks: parsedTasks,
      parseErrors,
      parseWarnings,
      structuralHygiene,
    } = await this.parseAllTasks();
    this.lastParsedCount = parsedTasks.length;
    // Build DB status lookup if available — DB status takes precedence
    let dbStatuses: Map<string, TaskStatusRow> | undefined;
    if (db) {
      dbStatuses = new Map<string, TaskStatusRow>();
      for (const row of db.getAllStatuses()) {
        dbStatuses.set(row.task_id, row);
      }
    }

    const { tasks, hygiene } = this.projectTasks(parsedTasks, {
      sessionsByTask,
      verifiedIndex,
      dbStatuses,
      // TASK-1317 S3: ONE batch read per operation, never per task.
      verifiedRows: db?.getAllVerified(),
      structuralHygiene,
    });
    return { tasks, parseErrors, parseWarnings, hygiene };
  }

  /**
   * Force a fresh re-read of all tasks using fs.opendir() to bypass
   * OS-level directory caching (NTFS stale read issue on Windows).
   */
  async refreshTasks(
    sessionsByTask?: Map<string, TaskSessionInfo>,
    verifiedIndex?: Record<string, VerifiedJsonEntry>,
    db?: QuackDB | NoopDB,
  ): Promise<TaskListResult> {
    const dir = this.absoluteTaskDir;
    const { tasks: parsedTasks, parseErrors, taskSources = [] } = await freshReadAllTasks(dir);
    const taskFilesById = new Map(taskSources.map((source) => [source.task.id, source.file]));
    const parseWarnings: TaskParseWarningInfo[] = parsedTasks
      .filter((task) => Array.isArray(task.parseWarnings) && task.parseWarnings.length > 0)
      .map((task) => ({
        file: taskFilesById.get(task.id) ?? `${task.id}.md`,
        taskId: task.id,
        warnings: task.parseWarnings ?? [],
      }));
    const structuralHygiene = buildStructuralBacklogHygieneReport(taskSources);
    this.lastParsedCount = parsedTasks.length;
    // Build DB status lookup if available — DB status takes precedence
    let dbStatuses: Map<string, TaskStatusRow> | undefined;
    if (db) {
      dbStatuses = new Map<string, TaskStatusRow>();
      for (const row of db.getAllStatuses()) {
        dbStatuses.set(row.task_id, row);
      }
    }

    // TASK-1317 round-2 F1: refresh MUST batch and carry evidence
    // exactly like list, or task state would depend on which API
    // operation produced the projection. Shared mapping, one batch read.
    // TASK-1318 S2c: the same shared mapping also folds status hygiene
    // on, so refresh and list cannot disagree about suppression either.
    const { tasks, hygiene } = this.projectTasks(parsedTasks, {
      sessionsByTask,
      verifiedIndex,
      dbStatuses,
      verifiedRows: db?.getAllVerified(),
      structuralHygiene,
    });
    return { tasks, parseErrors, parseWarnings, hygiene };
  }

  /**
   * Run startup validation — logs diagnostic counts for the task directory.
   */
  async startupValidation(): Promise<void> {
    await runStartupValidation(this.absoluteTaskDir);
  }

  /**
   * Get full parsed task by ID.
   */
  async getTask(taskId: string): Promise<ParsedTask | null> {
    return (await resolveParsedTaskFile(this.absoluteTaskDir, taskId))?.task ?? null;
  }

  /**
   * Get the absolute path to a task file by ID, or null if not found.
   */
  async getTaskFilePath(taskId: string): Promise<string | null> {
    return (await resolveParsedTaskFile(this.absoluteTaskDir, taskId))?.filePath ?? null;
  }

  /**
   * TASK-1334: the parsed task AND the file it came from, in ONE resolution.
   *
   * `getTask` and `getTaskFilePath` each resolve independently, so an
   * operation that reads through one and writes through the other performs
   * TWO resolutions and can act on two different files. That is not
   * hypothetical: `POST /api/tasks/:id/enrich` resolved the parent
   * correctly, enriched it, and then re-selected by filename prefix and
   * atomically overwrote a SUBTASK with the parent's content, leaving the
   * parent untouched while reporting success.
   *
   * **Any operation that reads a spec and then writes it must take this
   * bundle and carry it through.** Resolving correctly twice is still
   * resolving twice; the guarantee comes from resolving ONCE.
   */
  async getTaskBundle(taskId: string): Promise<ResolvedTaskFile | null> {
    return resolveParsedTaskFile(this.absoluteTaskDir, taskId);
  }

  /**
   * Get the absolute path to a task file by ID without requiring it to parse.
   * Used by routes that need raw spec content for validation against parse-error tasks.
   */
  async getRawTaskFilePath(taskId: string): Promise<string | null> {
    return resolveTaskFilePath(this.absoluteTaskDir, taskId);
  }

  /**
   * Parse all task files in the directory.
   * Collects parse errors instead of silently swallowing them.
   */
  private async parseAllTasks(): Promise<ParseAllTasksResult> {
    const dir = this.absoluteTaskDir;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return {
        tasks: [],
        parseErrors: [],
        parseWarnings: [],
        structuralHygiene: {
          report: emptyBacklogHygieneReport(),
          byTaskId: new Map<string, TaskBacklogHygiene>(),
        },
      };
    }

    const taskFiles = entries.filter((e) => /^(?:TASK-\d+|SAURUS-REM-\d{3}).*\.md$/.test(e)).sort();

    const tasks: ParsedTask[] = [];
    const parseErrors: TaskParseErrorInfo[] = [];
    const parseWarnings: TaskParseWarningInfo[] = [];
    const taskSources: Array<{ file: string; task: ParsedTask }> = [];
    for (const file of taskFiles) {
      try {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = parseTaskFile(content, filePath);
        tasks.push(parsed);
        taskSources.push({ file, task: parsed });
        if (parsed.parseWarnings && parsed.parseWarnings.length > 0) {
          parseWarnings.push({
            file,
            taskId: parsed.id,
            warnings: parsed.parseWarnings,
          });
        }
      } catch (err) {
        parseErrors.push({
          file,
          error: err instanceof TaskParseError ? err.message : String(err),
        });
      }
    }
    const structuralHygiene = buildStructuralBacklogHygieneReport(taskSources);
    return { tasks, parseErrors, parseWarnings, structuralHygiene };
  }
}
