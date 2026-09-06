// ─── Triage Routes ──────────────────────────────────────────────────
// Computed triage view with dynamic blocker resolution, verified.json
// cross-referencing, stale status detection, and parent task rollup.

import type { Express, Request, Response } from "express";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { parseTaskFile } from "../../core/task-parser.js";
import type { ParsedTask } from "../../core/types.js";
import type { RuntimeAuthorityDescriptor } from "../../core/worker-protocol.js";
import {
  inspectGeneratedProjectionHygiene,
  type ProjectionHygieneResult,
} from "../projection-hygiene.js";
import { isCompleteStatus } from "../../core/task-status.js";
import type { ResolvedTaskState, TaskStateAuthority } from "../../core/task-state.js";
import {
  loadTaskStateOverlay,
  resolveTaskStateWithOverlay,
  type TaskStateOverlaySource,
} from "../../core/task-state-overlay.js";

// ─── Types ───────────────────────────────────────────────────────────

interface TriageBlocker {
  taskId: string;
  status: string;
  complete: boolean;
}

interface TriageTask {
  id: string;
  title: string;
  priority: string;
  effort: string;
  /**
   * The RAW spec `Status:` line, kept so an operator can still see what
   * the markdown claims. TASK-1318 S2b: nothing in triage DECIDES from
   * this field any more. Every decision below reads `resolvedStatus` or
   * `effectiveStatus`.
   */
  status: string;
  /**
   * `resolveTaskStateWithOverlay` applied to this task: the DB
   * `task_status` row when one exists, then session evidence, then the
   * spec line. Byte-identical to whichever source won, never normalized.
   */
  resolvedStatus: string;
  /** Which source supplied `resolvedStatus`. "spec" here plus a
   *  `taskStateOverlay.degraded` response means the runtime store could
   *  not be read, not that it agreed with the spec. */
  statusAuthority: TaskStateAuthority;
  /** `resolvedStatus` plus the BACKLOG-to-READY presentation promotion.
   *  The value triage categorizes and counts from. */
  effectiveStatus: string;
  tags: string[];
  blockedBy: TriageBlocker[];
  allBlockersComplete: boolean;
  verified: boolean;
  verifiedEntry?: { date: string; method: string; verdict: string };
  stale: boolean;
  staleReason?: string;
  parentTaskId?: string;
  subtaskProgress?: { total: number; complete: number; allComplete: boolean };
}

interface TriageCategory {
  name: string;
  description: string;
  tasks: TriageTask[];
  count: number;
}

/**
 * Health of the runtime-authority read that backs every status in this
 * response.
 *
 * `degraded` is the field that matters: it means a `quack.db` EXISTS and
 * could not be read, so every task below silently fell back to spec
 * authority. That is not the same as the store having nothing to say
 * (`source: "absent"`, the normal case for a project that never
 * dispatched), and from the outside the two look identical unless the
 * difference is reported. An operator reading the triage view does not
 * see the monitor's log, so it is carried in the body.
 */
interface TriageStateOverlayStatus {
  source: TaskStateOverlaySource;
  degraded: boolean;
  error?: string;
}

interface TriageResponse {
  projectId: string;
  generatedAt: string;
  authority?: RuntimeAuthorityDescriptor;
  taskStateOverlay: TriageStateOverlayStatus;
  projectionHygiene: ProjectionHygieneResult;
  categories: TriageCategory[];
  summary: {
    total: number;
    verified: number;
    completeUnverified: number;
    inProgress: number;
    ready: number;
    blocked: number;
    manual: number;
    backlog: number;
    rejected: number;
  };
  parentTasks: Array<{
    id: string;
    title: string;
    subtasksComplete: number;
    subtasksTotal: number;
    allComplete: boolean;
  }>;
}

interface VerifiedEntry {
  verified: string;
  method: string;
  verdict: string;
}

export interface ProjectContext {
  projectRoot?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Load and parse adapter.json to get the task directory.
 * Falls back to "docs/tasks" if adapter.json is missing or has no taskDir.
 */
async function getTaskDir(projectRoot: string): Promise<string> {
  const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
  try {
    const raw = await fs.readFile(adapterPath, "utf-8");
    const config = JSON.parse(raw) as { project?: { taskDir?: string } };
    if (config.project?.taskDir) {
      return path.resolve(projectRoot, config.project.taskDir);
    }
  } catch {
    // adapter.json missing or invalid — use default
  }
  return path.resolve(projectRoot, "docs", "tasks");
}

/**
 * Load verified.json and return the tasks map.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
async function loadVerifiedJson(projectRoot: string): Promise<Record<string, VerifiedEntry>> {
  const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
  try {
    const raw = await fs.readFile(verifiedPath, "utf-8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, "")) as {
      tasks?: Record<string, VerifiedEntry>;
    };
    return parsed.tasks ?? {};
  } catch {
    return {};
  }
}

/**
 * Check git log for merge evidence of a task (commit messages mentioning [TASK-NNN]).
 * Returns whether merge evidence was found and the first matching commit.
 */
function detectMergeEvidence(
  taskId: string,
  projectRoot: string,
): { merged: boolean; mergeCommit?: string } {
  try {
    const result = execSync(`git log --oneline --all --grep="\\[${taskId}\\]" -- | head -1`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result) {
      return { merged: true, mergeCommit: result };
    }
    return { merged: false };
  } catch {
    // git failure — assume not stale
    return { merged: false };
  }
}

/**
 * Parse all TASK-*.md files from the task directory.
 * Skips files that fail to parse.
 */
async function parseAllTasks(taskDir: string): Promise<ParsedTask[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(taskDir);
  } catch {
    return [];
  }

  const taskFiles = entries.filter((e) => /^(?:TASK-\d+|SAURUS-REM-\d{3}).*\.md$/.test(e)).sort();

  const tasks: ParsedTask[] = [];
  for (const file of taskFiles) {
    try {
      const filePath = path.join(taskDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      tasks.push(parseTaskFile(content, filePath));
    } catch (err) {
      // Skip unparseable task files
      console.warn(
        `[triage] Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return tasks;
}

/**
 * Parse parent task reference from raw task content.
 * Looks for a line like "Parent Task: TASK-NNN" in the metadata or body.
 */
function parseParentTaskId(rawContent: string): string | undefined {
  const match = rawContent.match(/Parent\s+Task:\s*(TASK-\d+)/i);
  return match ? match[1] : undefined;
}

const MANUAL_TAGS = new Set(["manual", "infrastructure", "interactive"]);

/**
 * Categorize triage tasks into ordered groups.
 *
 * TASK-1318 S2b (round-2 F3): every arm reads `effectiveStatus`, never
 * the raw spec `status`. Classifying from the spec line while
 * `effectiveStatus` resolved DB-over-spec let the two contradict each
 * other in the same payload: a spec `READY` with a DB `COMPLETE` row
 * landed in READY, and a spec `COMPLETE` with a DB `IN_PROGRESS` row was
 * reported COMPLETE_UNVERIFIED. Reading the one resolved value makes
 * that contradiction unrepresentable rather than merely corrected, and
 * the summary counts, which are derived from these categories, are
 * fixed by the same change.
 *
 * The BACKLOG-to-READY promotion is PRESERVED, and is now stated once
 * rather than twice. It used to appear both here (as the second arm of
 * the READY branch) and in `effectiveStatus`, as two copies of one rule
 * that could drift apart. `effectiveStatus` already carries it, so the
 * arm here is redundant with it, not deleted. It remains a deliberate
 * presentation rule: it tells an operator a task is dispatchable now,
 * and claims nothing about stored state.
 */
function categorize(tasks: TriageTask[]): TriageCategory[] {
  const verified: TriageTask[] = [];
  const completeUnverified: TriageTask[] = [];
  const inProgress: TriageTask[] = [];
  const ready: TriageTask[] = [];
  const blocked: TriageTask[] = [];
  const manual: TriageTask[] = [];
  const backlog: TriageTask[] = [];
  const rejected: TriageTask[] = [];

  for (const task of tasks) {
    // MANUAL check comes first — a BACKLOG task with manual tag goes to MANUAL
    if (task.tags.some((t) => MANUAL_TAGS.has(t.toLowerCase()))) {
      manual.push(task);
      continue;
    }

    const status = task.effectiveStatus;

    // `isCompleteStatus` is exactly the COMPLETE-or-VERIFIED pair these
    // two arms already tested for, so this is the same set from the one
    // shared predicate rather than a widening.
    if (isCompleteStatus(status) && task.verified) {
      verified.push(task);
    } else if (isCompleteStatus(status)) {
      completeUnverified.push(task);
    } else if (status === "IN_PROGRESS" || status === "VERIFYING") {
      inProgress.push(task);
    } else if (status === "REJECTED") {
      rejected.push(task);
    } else if (status === "BLOCKED" || status === "ON_HOLD") {
      blocked.push(task);
    } else if (status === "READY") {
      // Covers both a resolved READY and a BACKLOG promoted by
      // `effectiveStatus`; see this function's note on the promotion.
      ready.push(task);
    } else if (status === "BACKLOG" && task.blockedBy.length > 0 && !task.allBlockersComplete) {
      blocked.push(task);
    } else {
      // Remaining BACKLOG (no blockers listed, or other edge cases)
      backlog.push(task);
    }
  }

  return [
    {
      name: "VERIFIED",
      description: "Complete and independently verified",
      tasks: verified,
      count: verified.length,
    },
    {
      name: "COMPLETE_UNVERIFIED",
      description: "Complete but awaiting verification",
      tasks: completeUnverified,
      count: completeUnverified.length,
    },
    {
      name: "IN_PROGRESS",
      description: "Currently being worked on or under verification",
      tasks: inProgress,
      count: inProgress.length,
    },
    {
      name: "READY",
      description: "Ready to dispatch — all blockers resolved",
      tasks: ready,
      count: ready.length,
    },
    {
      name: "BLOCKED",
      description: "Waiting on unresolved dependencies",
      tasks: blocked,
      count: blocked.length,
    },
    {
      name: "MANUAL",
      description: "Requires manual, infrastructure, or interactive work",
      tasks: manual,
      count: manual.length,
    },
    {
      name: "BACKLOG",
      description: "Backlog tasks with no blockers listed",
      tasks: backlog,
      count: backlog.length,
    },
    {
      name: "REJECTED",
      description: "Previously rejected by judge or human review",
      tasks: rejected,
      count: rejected.length,
    },
  ];
}

// ─── Core Computation ────────────────────────────────────────────────

/**
 * Compute the full triage view for a project.
 * Exported separately from the route handler for testability.
 */
export async function computeTriage(projectRoot: string): Promise<TriageResponse> {
  const taskDir = await getTaskDir(projectRoot);
  const allParsed = await parseAllTasks(taskDir);
  const verifiedMap = await loadVerifiedJson(projectRoot);

  // TASK-1318 S2b: triage is the canonical action queue, so it must not
  // classify from raw spec status while every other reader resolves
  // DB-over-spec (round-1 F3).
  //
  // ONE batch read of the runtime authority per request, deliberately
  // outside every loop below. Round-2 F4 replaced a per-request
  // `new QuackDB(...)` here: that constructor sets `journal_mode = WAL`
  // and runs migrations, and its `close()` issues a truncating WAL
  // checkpoint, so rendering a READ-ONLY view mutated the live store a
  // running monitor holds open. Worse, its `catch {}` collapsed any read
  // failure into an empty overlay, which is indistinguishable from "the
  // store had nothing to say" and silently reverted the whole view to
  // spec authority. The shared loader opens better-sqlite3 read-only and
  // reports a failed read as `degraded`.
  const overlayLoad = loadTaskStateOverlay(projectRoot, {
    // The loader's own message already names the path, the failure and
    // the consequence, so it is prefixed here rather than duplicated by
    // a second warn. `degraded` also travels in the response body: an
    // operator reading the triage view never sees this log.
    warn: (message) => console.warn(`[triage] ${message}`),
  });

  // A missing database (`source: "absent"`) needs no handling. It is the
  // normal case for a project that has never dispatched, and an empty
  // overlay is then the complete and correct answer: every task falls to
  // spec authority exactly as the resolver's precedence prescribes.
  const resolvedByTask = new Map<string, ResolvedTaskState>();
  const titleByTask = new Map<string, string>();
  for (const t of allParsed) {
    // No I/O in this loop: resolution reads the already-loaded Map.
    resolvedByTask.set(
      t.id,
      resolveTaskStateWithOverlay({
        taskId: t.id,
        specStatus: t.status,
        overlay: overlayLoad.overlay,
      }),
    );
    titleByTask.set(t.id, t.title);
  }

  // Build triage tasks with blocker resolution, verified cross-ref, stale detection
  const triageTasks: TriageTask[] = [];

  for (const parsed of allParsed) {
    // Dynamic blocker resolution
    const blockers: TriageBlocker[] = parsed.blockedBy.map((blockerId) => {
      // A blocker with no spec file stays UNKNOWN even when the overlay
      // holds a row for it. TASK_STATE_UNIVERSE scopes the resolver to
      // spec-parsed tasks, so admitting runtime-only ids here would
      // unblock a dependent on the strength of an id triage cannot even
      // display. Unchanged by this cutover, and called out because it is
      // the one place the overlay is deliberately not consulted.
      const blockerStatus = resolvedByTask.get(blockerId)?.status ?? "UNKNOWN";
      return {
        taskId: blockerId,
        status: blockerStatus,
        // TASK-1318 S2b: was `=== "COMPLETE"`, so a VERIFIED blocker
        // counted as INCOMPLETE (round-1 F3). The shared predicate
        // covers COMPLETE and VERIFIED and still excludes REJECTED.
        complete: isCompleteStatus(blockerStatus),
      };
    });
    const allBlockersComplete = blockers.length === 0 || blockers.every((b) => b.complete);

    // Verified cross-reference
    const vEntry = verifiedMap[parsed.id];
    const isVerified =
      !!vEntry && (vEntry.verdict === "VERIFIED" || vEntry.verdict === "SOFT-VERIFIED");

    // Every task in `allParsed` was resolved above, so the fallback here
    // is unreachable in practice. It is a `??` rather than a `!` so that
    // a future caller passing an id outside the resolved set degrades to
    // the spec line instead of throwing on the operator's action queue.
    const ownState = resolvedByTask.get(parsed.id);
    const resolvedOwn = ownState?.status ?? parsed.status;
    const statusAuthority: TaskStateAuthority = ownState?.authority ?? "spec";

    // Stale status detection (only for READY/BACKLOG tasks)
    let stale = false;
    let staleReason: string | undefined;
    if (resolvedOwn === "READY" || resolvedOwn === "BACKLOG") {
      const evidence = detectMergeEvidence(parsed.id, projectRoot);
      if (evidence.merged) {
        stale = true;
        staleReason = `Merge evidence found: ${evidence.mergeCommit}`;
      }
    }

    // TASK-1318 S2b: starts from the RESOLVED status, not the raw spec
    // line. The BACKLOG-to-READY promotion is PRESERVED deliberately: it
    // is a presentation rule telling an operator "this is dispatchable
    // now", not a claim about stored state, and dropping it silently
    // while routing the reader would have been a scope grab. This is now
    // the ONLY statement of that rule; `categorize` reads the result
    // instead of restating the condition.
    let effectiveStatus = resolvedOwn;
    if (resolvedOwn === "BACKLOG" && allBlockersComplete && blockers.length > 0) {
      effectiveStatus = "READY";
    }

    // Parent task reference
    const parentTaskId = parseParentTaskId(parsed.rawContent);

    triageTasks.push({
      id: parsed.id,
      title: parsed.title,
      priority: parsed.priority,
      effort: parsed.effort,
      status: parsed.status,
      resolvedStatus: resolvedOwn,
      statusAuthority,
      effectiveStatus,
      tags: parsed.tags,
      blockedBy: blockers,
      allBlockersComplete,
      verified: isVerified,
      verifiedEntry: vEntry
        ? { date: vEntry.verified, method: vEntry.method, verdict: vEntry.verdict }
        : undefined,
      stale,
      staleReason,
      parentTaskId,
    });
  }

  // Resolve parent relationships and subtask progress
  const subtasksByParent = new Map<string, TriageTask[]>();
  for (const t of triageTasks) {
    if (t.parentTaskId) {
      const group = subtasksByParent.get(t.parentTaskId) ?? [];
      group.push(t);
      subtasksByParent.set(t.parentTaskId, group);
    }
  }

  // Attach subtask progress to parent tasks
  for (const t of triageTasks) {
    const subtasks = subtasksByParent.get(t.id);
    if (subtasks) {
      // TASK-1318 S2b (round-2 F3): was `s.status === "COMPLETE"` over the
      // RAW spec line, which both ignored a DB row and counted a VERIFIED
      // subtask as incomplete. `isCompleteStatus` over the resolved status
      // is the same dependency-satisfied rule the blockers use, and it
      // still excludes REJECTED: a rejected subtask is finished but has
      // not delivered its parent's work.
      //
      // Resolved rather than effective status on purpose. The
      // BACKLOG-to-READY promotion is a dispatchability hint and has no
      // bearing on doneness; both values give the same answer here, and
      // reading the unpromoted one keeps that independence explicit.
      const complete = subtasks.filter((s) => isCompleteStatus(s.resolvedStatus)).length;
      t.subtaskProgress = {
        total: subtasks.length,
        complete,
        allComplete: complete === subtasks.length,
      };
    }
  }

  // Categorize
  const categories = categorize(triageTasks);

  // Build summary. Every count is read off the categories above, so the
  // summary resolves DB-over-spec because `categorize` does. It cannot
  // drift from the categories it counts, which is why round-2 F3's third
  // site needs no separate fix.
  const summary = {
    total: triageTasks.length,
    verified: 0,
    completeUnverified: 0,
    inProgress: 0,
    ready: 0,
    blocked: 0,
    manual: 0,
    backlog: 0,
    rejected: 0,
  };
  for (const cat of categories) {
    switch (cat.name) {
      case "VERIFIED":
        summary.verified = cat.count;
        break;
      case "COMPLETE_UNVERIFIED":
        summary.completeUnverified = cat.count;
        break;
      case "IN_PROGRESS":
        summary.inProgress = cat.count;
        break;
      case "READY":
        summary.ready = cat.count;
        break;
      case "BLOCKED":
        summary.blocked = cat.count;
        break;
      case "MANUAL":
        summary.manual = cat.count;
        break;
      case "BACKLOG":
        summary.backlog = cat.count;
        break;
      case "REJECTED":
        summary.rejected = cat.count;
        break;
    }
  }

  // Build parent task rollups
  const parentTasks: TriageResponse["parentTasks"] = [];
  for (const [parentId, subtasks] of subtasksByParent) {
    // Same rule as `subtaskProgress` above, and it must stay the same:
    // these two counts describe one relationship and are rendered side by
    // side, so any divergence reads as a bug in the data.
    const complete = subtasks.filter((s) => isCompleteStatus(s.resolvedStatus)).length;
    parentTasks.push({
      id: parentId,
      title: titleByTask.get(parentId) ?? "",
      subtasksComplete: complete,
      subtasksTotal: subtasks.length,
      allComplete: complete === subtasks.length,
    });
  }

  // Derive a project ID from the directory name
  const projectId = path.basename(projectRoot);

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    taskStateOverlay: {
      source: overlayLoad.source,
      degraded: overlayLoad.degraded,
      error: overlayLoad.error,
    },
    projectionHygiene: inspectGeneratedProjectionHygiene(projectRoot),
    categories,
    summary,
    parentTasks,
  };
}

// ─── Route Registration ──────────────────────────────────────────────

export function registerTriageRoutes(
  app: Express,
  resolveProject: (req: Request) => ProjectContext,
  authority?: RuntimeAuthorityDescriptor,
): void {
  app.get("/api/triage", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const result = await computeTriage(p.projectRoot);
      res.json(authority ? { ...result, authority } : result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Triage computation failed: ${msg}` });
    }
  });
}
