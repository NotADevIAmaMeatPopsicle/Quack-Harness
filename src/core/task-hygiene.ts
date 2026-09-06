// ─── Backlog hygiene (TASK-856, restructured by TASK-1318 S2c) ──────
// Two kinds of hygiene live here, and the whole point of this file's
// shape is that they are no longer computed at the same moment.
//
// STRUCTURAL hygiene (duplicate task ids, supersession) is intrinsic to
// the spec files themselves. Nothing outside the parsed files can change
// the answer, so it is correct at parse time and stays there.
//
// STATUS hygiene (ON_HOLD, REJECTED) is not. It asks "what status is
// this task in", which is exactly the question the runtime store
// answers and the spec file only projects. Evaluating it at parse time
// meant a markdown edit could veto automation for a task whose DB row
// said otherwise: with a runtime row of BACKLOG and a spec line of
// REJECTED, the monitor's projection reported the task eligible while
// hygiene marked it dispatchBlocked. That is the spec-as-authority
// inversion TASK-1318 exists to remove, arriving through a back door.
//
// An earlier attempt added an optional `resolvedStatus` parameter to the
// combined evaluator and found that NOTHING could supply it, because
// hygiene was computed inside `parseAllTasks` before the runtime overlay
// was loaded. The parameter was removed rather than shipped dead. The
// fix is structural, not a parameter: status hygiene moved OUT of the
// parse-time pass and into the projection pass, where the resolved
// status already exists.
//
// So the pipeline is now two phases:
//
//   1. parse time  → `buildStructuralBacklogHygieneReport(sources)`
//   2. after state resolution → `applyResolvedStatusHygiene(structural,
//      [{ taskId, title, status: resolvedStatus, specStatus }])`
//
// A one-call `buildBacklogHygieneReport` shim used to compose those two
// phases with the SPEC status, so callers with no overlay in reach kept
// working unchanged. Round-3 F3 routed its last caller, the overnight
// runner, and the shim was deleted rather than left standing: see the
// note where it used to live, at the bottom of this file.

import type {
  BacklogHygieneIssue,
  BacklogHygieneReport,
  DuplicateTaskIdWarning,
  ExcludedTaskCandidate,
  ParsedTask,
  SupersededTaskWarning,
  TaskBacklogHygiene,
} from "./types.js";
import { groupTaskClaimantsByDeclaredId } from "./duplicate-claimants.js";
import { normalizeTaskStatus, type TaskStatus } from "./task-status.js";

export interface TaskBacklogHygieneSource {
  task: ParsedTask;
  file: string;
}

/**
 * The report plus its per-task view. Structural and combined
 * evaluations share this shape, which is what lets the projection path
 * take a structural evaluation in and hand a combined one back out.
 */
export interface BacklogHygieneEvaluationBase {
  report: BacklogHygieneReport;
  byTaskId: Map<string, TaskBacklogHygiene>;
}

export interface BacklogHygieneEvaluation extends BacklogHygieneEvaluationBase {
  duplicateFilesByTaskId: Map<string, string[]>;
}

/**
 * One task's resolved state, as phase 2 needs it.
 *
 * `status` is the RESOLVED status: the shared resolver's answer, with
 * runtime taking precedence over session taking precedence over spec.
 * Passing a raw spec `Status:` line here is legal (that is exactly what
 * the parse-time compatibility path does) but it is then a spec-only
 * answer, and the caller is the one saying so.
 */
export interface ResolvedTaskStatusHygieneInput {
  taskId: string;
  title: string;
  status: string;
  /**
   * The spec `Status:` value, used ONLY to keep the report's typed
   * `status` field populated when the resolved value has no canonical
   * form (a runtime row can hold any string).
   */
  specStatus: TaskStatus;
}

export function emptyBacklogHygieneReport(): BacklogHygieneReport {
  return {
    duplicateIds: [],
    supersededTasks: [],
    excludedCandidates: [],
  };
}

/**
 * Spec-intrinsic hygiene: duplicate ids and supersession.
 *
 * Correct at parse time and unaffected by any runtime store, so this is
 * the half that stays where it always was.
 */
export function evaluateStructuralTaskHygiene(
  task: Pick<ParsedTask, "id" | "supersededBy">,
  duplicateFiles: string[] = [],
): TaskBacklogHygiene {
  const reasons: BacklogHygieneIssue[] = [];

  if (duplicateFiles.length > 1) {
    reasons.push({
      code: "duplicate_id",
      message: `Duplicate task ID ${task.id} exists in ${duplicateFiles.length} files.`,
      relatedTaskIds: [task.id],
      relatedFiles: duplicateFiles,
    });
  }

  if (task.supersededBy.length > 0) {
    reasons.push({
      code: "superseded",
      message: `${task.id} is superseded by ${task.supersededBy.join(", ")}.`,
      relatedTaskIds: task.supersededBy,
    });
  }

  return { dispatchBlocked: reasons.length > 0, reasons };
}

/**
 * Status hygiene, evaluated against whatever status the caller has
 * decided is authoritative.
 *
 * Comparison is on the raw value, byte-for-byte as it always was, so a
 * runtime row holding a non-canonical string suppresses nothing rather
 * than being silently coerced into a canonical status it does not hold.
 */
export function evaluateStatusTaskHygiene(taskId: string, status: string): TaskBacklogHygiene {
  const reasons: BacklogHygieneIssue[] = [];

  if (status === "ON_HOLD") {
    reasons.push({
      code: "status_on_hold",
      message: `${taskId} is ON_HOLD and should not be selected by queue automation.`,
      relatedTaskIds: [taskId],
    });
  }

  if (status === "REJECTED") {
    reasons.push({
      code: "status_rejected",
      message: `${taskId} is REJECTED and should not be selected by queue automation.`,
      relatedTaskIds: [taskId],
    });
  }

  return { dispatchBlocked: reasons.length > 0, reasons };
}

/**
 * Combine hygiene parts, preserving reason order: structural reasons
 * first, then status reasons, which is the order the single combined
 * evaluator produced before the split.
 */
export function mergeTaskBacklogHygiene(
  ...parts: Array<TaskBacklogHygiene | undefined>
): TaskBacklogHygiene {
  const reasons: BacklogHygieneIssue[] = [];
  for (const part of parts) {
    if (part) reasons.push(...part.reasons);
  }
  return { dispatchBlocked: reasons.length > 0, reasons };
}

/**
 * Structural plus status hygiene with the SPEC status as the status
 * input.
 *
 * Retained for callers that parse task files without a runtime overlay
 * in reach. Byte-identical to this function's pre-split behavior; the
 * spec-only input is now explicit in the name of what it delegates to
 * rather than buried inside the rule.
 */
export function evaluateTaskBacklogHygiene(
  task: Pick<ParsedTask, "id" | "status" | "supersededBy">,
  duplicateFiles: string[] = [],
): TaskBacklogHygiene {
  return mergeTaskBacklogHygiene(
    evaluateStructuralTaskHygiene(task, duplicateFiles),
    evaluateStatusTaskHygiene(task.id, task.status),
  );
}

export function isTaskSuppressedFromAutomation(task: {
  status: string;
  backlogHygiene?: TaskBacklogHygiene;
}): boolean {
  if (task.backlogHygiene) {
    return task.backlogHygiene.dispatchBlocked;
  }
  // Last-resort fallback for callers with no hygiene evaluation at all.
  // It reads the spec status, so callers that CAN resolve state should
  // pass `backlogHygiene` from a projection rather than rely on this.
  return task.status === "ON_HOLD" || task.status === "REJECTED";
}

/**
 * Phase 1. Duplicate ids and supersession only.
 *
 * Every parsed source gets an entry in `byTaskId`, and every blocked
 * source contributes its own `excludedCandidates` row, including both
 * halves of a duplicated id, which is how the report has always shown
 * that a single id occupies two files.
 */
export function buildStructuralBacklogHygieneReport(
  sources: TaskBacklogHygieneSource[],
): BacklogHygieneEvaluation {
  const duplicateFilesByTaskId = groupTaskClaimantsByDeclaredId(
    sources.map((source) => ({
      fileName: source.file,
      declaredId: source.task.id,
    })),
  );

  const duplicateIds: DuplicateTaskIdWarning[] = [...duplicateFilesByTaskId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([taskId, files]) => ({
      taskId,
      files: [...files].sort(),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const byTaskId = new Map<string, TaskBacklogHygiene>();
  const supersededTasks: SupersededTaskWarning[] = [];
  const excludedCandidates: ExcludedTaskCandidate[] = [];

  for (const source of sources) {
    const duplicateFiles = duplicateFilesByTaskId.get(source.task.id) ?? [];
    const hygiene = evaluateStructuralTaskHygiene(source.task, duplicateFiles);
    byTaskId.set(source.task.id, hygiene);

    if (source.task.supersededBy.length > 0) {
      supersededTasks.push({
        taskId: source.task.id,
        supersededBy: [...source.task.supersededBy],
      });
    }

    if (hygiene.dispatchBlocked) {
      excludedCandidates.push({
        taskId: source.task.id,
        title: source.task.title,
        status: source.task.status,
        reasons: hygiene.reasons,
      });
    }
  }

  supersededTasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
  excludedCandidates.sort((a, b) => a.taskId.localeCompare(b.taskId));

  return {
    report: {
      duplicateIds,
      supersededTasks,
      excludedCandidates,
    },
    byTaskId,
    duplicateFilesByTaskId,
  };
}

/**
 * The status an excluded-candidate row reports.
 *
 * `ExcludedTaskCandidate.status` is typed `TaskStatus` while a resolved
 * status is a raw string a runtime row can hold in any shape, so the
 * resolved value is normalized before it can be reported. When
 * resolution changed nothing, the spec value is passed through
 * untouched: normalizing there would rewrite rows this function is not
 * supposed to be deciding anything about.
 */
function reportedStatus(input: ResolvedTaskStatusHygieneInput): TaskStatus {
  if (input.status === input.specStatus) return input.specStatus;
  return normalizeTaskStatus(input.status) ?? input.specStatus;
}

/**
 * Phase 2. Fold status hygiene onto a structural evaluation, using the
 * resolved status of each task.
 *
 * Run this where the runtime overlay is already loaded. It performs no
 * I/O and no resolution of its own: the caller resolves once, for its
 * own projection, and passes the answer here so hygiene and the
 * projection cannot disagree about the same task.
 *
 * The returned `excludedCandidates` rows report the RESOLVED status,
 * because that is the value the exclusion decision was made on;
 * reporting the spec line would explain the row with a value that did
 * not cause it. A row whose resolution changed nothing keeps its spec
 * value byte-for-byte, so this can never rewrite a status that
 * resolution did not touch.
 *
 * Duplicate-id note: when two files declare the same id, each structural
 * row is paired with its OWN resolved input, in file order. That matters
 * exactly when the runtime store is silent and the two files disagree
 * about status, which is the case the duplicate report exists to expose.
 * `byTaskId` still collapses to one entry per id (last input wins), as
 * it always has, because its key admits only one.
 */
export function applyResolvedStatusHygiene(
  structural: BacklogHygieneEvaluationBase,
  resolved: readonly ResolvedTaskStatusHygieneInput[],
): BacklogHygieneEvaluationBase {
  const byTaskId = new Map<string, TaskBacklogHygiene>(structural.byTaskId);
  const statusByTaskId = new Map<
    string,
    Array<{ input: ResolvedTaskStatusHygieneInput; hygiene: TaskBacklogHygiene }>
  >();

  for (const input of resolved) {
    const hygiene = evaluateStatusTaskHygiene(input.taskId, input.status);
    const forTask = statusByTaskId.get(input.taskId) ?? [];
    forTask.push({ input, hygiene });
    statusByTaskId.set(input.taskId, forTask);
    byTaskId.set(
      input.taskId,
      mergeTaskBacklogHygiene(structural.byTaskId.get(input.taskId), hygiene),
    );
  }

  const structurallyExcluded = new Set(
    structural.report.excludedCandidates.map((candidate) => candidate.taskId),
  );

  // Structural rows for one id are already in file order, and so are the
  // resolved inputs for that id, so walking a cursor per id pairs them.
  const cursors = new Map<string, number>();
  const excludedCandidates: ExcludedTaskCandidate[] = structural.report.excludedCandidates.map(
    (candidate) => {
      const forTask = statusByTaskId.get(candidate.taskId);
      // No resolved input for this id means the caller did not project
      // it; leaving the structural row exactly as parsed is the honest
      // answer rather than inventing a status for it.
      if (!forTask || forTask.length === 0) return candidate;
      const cursor = cursors.get(candidate.taskId) ?? 0;
      cursors.set(candidate.taskId, cursor + 1);
      const status = forTask[Math.min(cursor, forTask.length - 1)];
      return {
        ...candidate,
        status: reportedStatus(status.input),
        reasons: [...candidate.reasons, ...status.hygiene.reasons],
      };
    },
  );

  for (const entries of statusByTaskId.values()) {
    for (const { input, hygiene } of entries) {
      if (structurallyExcluded.has(input.taskId)) continue;
      if (!hygiene.dispatchBlocked) continue;
      excludedCandidates.push({
        taskId: input.taskId,
        title: input.title,
        status: reportedStatus(input),
        reasons: hygiene.reasons,
      });
    }
  }

  excludedCandidates.sort((a, b) => a.taskId.localeCompare(b.taskId));

  return {
    report: { ...structural.report, excludedCandidates },
    byTaskId,
  };
}

// ─── REMOVED: buildBacklogHygieneReport (round-3 F3) ────────────────
// The pre-split entry point, structural plus SPEC-status hygiene in one
// pass. It was retained through S2c "for callers that parse task files
// with no runtime overlay available", and the overnight runner was the
// last of them. Round-3 F3 routed that caller, which left an exported
// function with zero production callers whose entire behavior is to
// answer a runtime question from the markdown.
//
// Keeping it would have been a trap rather than a convenience: it is
// exactly the back door this task exists to close, sitting in the shared
// module with a neutral name, ready for the next caller to pick up and
// silently get spec-only suppression. Callers compose the two phases
// explicitly instead, which puts the spec-only choice in the call site
// where a reviewer can see it.
