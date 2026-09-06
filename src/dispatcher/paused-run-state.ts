// ─── Paused-Run State (TASK-1326 / QPI-042) ────────────────────────
// A run paused at a human gate holds paid-for state: the stage
// checkpoint, the pending approval record carrying the brief and its
// cross-model review, and — at the judge gate — a task BRANCH with the
// worker's committed changes. Every one of those is destroyed by a
// plain re-dispatch today, and the operator is invited to do exactly
// that because federation labels the pause `failed` (QPI-041).
//
// This module answers two questions for the two seams that can destroy
// them (the monitor before it removes a worktree and force-deletes the
// branch, and the dispatcher before it re-bills gate + blueprint):
//   1. Is this task paused at a gate, decided from DISK?
//   2. If an operator explicitly overrides, what has to survive first?
//
// Deciding from disk is the whole point. An in-memory guard already
// exists in DispatchManager.start(), and it dies with the monitor
// restart that makes the queue look dead — the same restart that
// prompts the re-POST.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./blueprint-approval.js";

export type PausedGate = "blueprint" | "judge";

/** Round-2 R2-6: how far ahead of now a pend's `createdAt` may sit and still be
 *  attributable to a live run. Covers ordinary clock skew between the writer
 *  and the reader; anything beyond it is corruption, not a pause. */
const FUTURE_PEND_SKEW_MS = 5 * 60 * 1000;

export interface PausedRunState {
  gate: PausedGate;
  /** When the pend was opened (ISO), or `"unknown"` for a malformed record. */
  createdAt: string;
  /** Approval file basename inside `<logDir>/approvals`. */
  approvalFile: string;
  /** The paused run's Quack session id, when a checkpoint records one. */
  sessionId?: string;
  /** Branch the paused run was building on, when known. */
  branchName?: string;
  /**
   * Round-2 F2: the approval file EXISTS but could not be parsed, or is
   * missing the fields needed to evaluate it. Treated as paused —
   * anything else is a guard that fails OPEN on corruption, which in
   * this guard's case means silently destroying the run it exists to
   * protect. A caller that cannot read the state cannot claim there is
   * nothing to lose.
   */
  malformed?: boolean;
}

export interface PausedRunArchive {
  /** Full ref name of the archived branch tip, when a branch was archived. */
  branchRef?: string;
  /** Archived checkpoint path, when a checkpoint existed. */
  checkpointPath?: string;
  /** Archived approval-record path. */
  approvalPath?: string;
  /** Self-describing record of the archive, written to disk. */
  manifestPath?: string;
}

export class PausedRunArchiveError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PausedRunArchiveError";
  }
}

interface ApprovalRecordHead {
  state?: string;
  createdAt?: string;
}

const KNOWN_APPROVAL_STATES = new Set(["pending", "approved", "auto-approved", "rejected"]);

/**
 * Round-2b F1: `JSON.parse` succeeding is NOT the same as the record
 * being readable. `[]`, `"string"` and `{}` all parse, and the first
 * cut of this function handed them back as ordinary records — so a
 * `{}` at `approvals/<task>-judge.json` classified as "no pause" and the
 * confirmation round watched `branch -D` delete the branch. Anything
 * that is not an object carrying a RECOGNIZED state string is
 * unreadable, and unreadable is never absence in this module.
 */
function readApproval(file: string): ApprovalRecordHead | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as ApprovalRecordHead;
  if (typeof record.state !== "string" || !KNOWN_APPROVAL_STATES.has(record.state)) {
    return null;
  }
  return record;
}

function isExpired(createdAt: string, timeoutMs: number): boolean {
  const opened = new Date(createdAt).getTime();
  if (Number.isNaN(opened)) return false; // unparseable: treat as live (safe direction)
  return Date.now() - opened > timeoutMs;
}

/**
 * Is this task paused at a human gate, according to disk?
 *
 * The judge gate wins when both records are pending: it is the later
 * and far more expensive pause (it holds committed work).
 *
 * An EXPIRED pend does not block. The dispatcher auto-rejects expired
 * pends on its next pass, so refusing on one would strand the task —
 * this mirrors that behaviour rather than inventing a second policy.
 */
export function resolvePausedRunState(
  logDir: string,
  taskId: string,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
): PausedRunState | null {
  const approvalDir = path.join(logDir, "approvals");
  const candidates: Array<{ gate: PausedGate; file: string }> = [
    { gate: "judge", file: `${taskId}-judge.json` },
    { gate: "blueprint", file: `${taskId}.json` },
  ];

  for (const candidate of candidates) {
    const full = path.join(approvalDir, candidate.file);
    if (!fs.existsSync(full)) continue;
    const record = readApproval(full);
    const checkpoint = (): { sessionId?: string; branchName?: string } | null =>
      readCheckpoint(logDir, taskId);

    // Round-2 F2: present-but-unreadable is NOT absence.
    if (!record || (record.state === "pending" && !record.createdAt)) {
      const cp = checkpoint();
      return {
        gate: candidate.gate,
        createdAt: "unknown",
        approvalFile: candidate.file,
        malformed: true,
        ...(cp?.sessionId ? { sessionId: cp.sessionId } : {}),
        ...(cp?.branchName ? { branchName: cp.branchName } : {}),
      };
    }
    if (record.state !== "pending" || !record.createdAt) continue;
    if (isExpired(record.createdAt, timeoutMs)) continue;

    const cp = checkpoint();
    return {
      gate: candidate.gate,
      createdAt: record.createdAt,
      approvalFile: candidate.file,
      ...(cp?.sessionId ? { sessionId: cp.sessionId } : {}),
      ...(cp?.branchName ? { branchName: cp.branchName } : {}),
    };
  }
  return null;
}

/** TASK-1329: the ATTRIBUTION answer, deliberately not the same question as
 *  {@link resolvePausedRunState}. */
export interface RunScopedPauseState {
  gate: PausedGate;
  /** When the pend was opened (ISO). Never `"unknown"` here: see below. */
  createdAt: string;
  /** Approval file basename inside `<logDir>/approvals`. */
  approvalFile: string;
}

/**
 * Did THIS run pause at a human gate, or did it die?
 *
 * TASK-1329 / QPI-041. This exists because {@link resolvePausedRunState} is the
 * wrong tool for the question, in a way that is easy to miss and unsafe to get
 * wrong. That function guards DESTRUCTION, so it is deliberately fail-closed
 * toward "something is here, do not delete it": it reports a pause for any
 * non-expired pending record for the task, and reports one even when the record
 * is malformed. Both are correct there. A caller that cannot read the state
 * cannot claim there is nothing to lose.
 *
 * Reused unchanged for attribution, those same behaviours are fail-OPEN in the
 * opposite direction: an unrelated pend left by an EARLIER run, or a corrupt
 * record, would let a genuinely crashed dispatch be reported as "waiting on a
 * human". That is the original QPI-041 lie with the sign flipped, and it would
 * be worse, because a real failure would sit in the queue looking like it was
 * waiting for someone.
 *
 * So this answer is bound to one run and refuses on doubt:
 *   - the pend must be `pending` with a parseable `createdAt`
 *   - `createdAt` must be at or after `runStartedAt`, so a previous run's pend
 *     is never attributed to this one (same rule as
 *     `DispatchManager.isGateApprovalPending`)
 *   - a malformed or unreadable record is NOT a pause; it is left to the
 *     failure path
 *   - an expired pend is not a pause, matching the dispatcher's auto-reject
 *
 * The judge gate still wins when both are pending: it is later and holds
 * committed work.
 */
export function resolveRunScopedPauseState(
  logDir: string,
  taskId: string,
  runStartedAt: string,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
): RunScopedPauseState | null {
  const startedMs = new Date(runStartedAt).getTime();
  if (Number.isNaN(startedMs)) return null; // no usable run boundary: refuse to attribute

  const approvalDir = path.join(logDir, "approvals");
  const candidates: Array<{ gate: PausedGate; file: string }> = [
    { gate: "judge", file: `${taskId}-judge.json` },
    { gate: "blueprint", file: `${taskId}.json` },
  ];

  for (const candidate of candidates) {
    const full = path.join(approvalDir, candidate.file);
    if (!fs.existsSync(full)) continue;
    const record = readApproval(full);
    // Unlike resolvePausedRunState, malformed is NOT a pause here.
    if (!record || record.state !== "pending" || !record.createdAt) continue;
    const openedMs = new Date(record.createdAt).getTime();
    if (Number.isNaN(openedMs)) continue;
    if (openedMs < startedMs) continue; // a previous run's pend
    // Round-2 R2-6: bound the OTHER end too. `isExpired` treats a future
    // timestamp as un-expired, which is right for the clobber guard (fail
    // closed toward preserving) and fail-OPEN here: a corrupt record dated
    // year 9999 is "after the run start" of every run that will ever exist,
    // so it would mask any crash as a pause. Only the attribution path is
    // clamped; `isExpired` and the guard keep their semantics.
    if (openedMs > Date.now() + FUTURE_PEND_SKEW_MS) continue;
    if (isExpired(record.createdAt, timeoutMs)) continue;
    return {
      gate: candidate.gate,
      createdAt: record.createdAt,
      approvalFile: candidate.file,
    };
  }
  return null;
}

function readCheckpoint(
  logDir: string,
  taskId: string,
): { sessionId?: string; branchName?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(logDir, `checkpoint-${taskId}.json`), "utf-8");
    return JSON.parse(raw) as { sessionId?: string; branchName?: string };
  } catch {
    return null;
  }
}

/** Operator-facing refusal text. Names the gate, when it opened, and the way out. */
export function pausedRunRefusalMessage(taskId: string, paused: PausedRunState): string {
  const gateLabel = paused.gate === "judge" ? "judge review" : "blueprint";
  if (paused.malformed) {
    return (
      `Task ${taskId} has an UNREADABLE ${gateLabel}-gate approval record ` +
      `(approvals/${paused.approvalFile}). Refusing to start rather than assume there is ` +
      `nothing to lose: inspect or remove the record, or re-send with an explicit override.`
    );
  }
  return (
    `Task ${taskId} is paused at the ${gateLabel} gate (opened ${paused.createdAt}). ` +
    `Starting it fresh would discard that run's state` +
    (paused.gate === "judge" ? ", including its committed work" : "") +
    `. Approve or reject the gate, stop the task, or re-send with an explicit override.`
  );
}

/**
 * Typed so a caller can answer with a structured refusal instead of
 * re-deriving the condition. One source of truth for "this start would
 * clobber a pause": the guard that knows, not a second copy in a route.
 */
export class PausedRunRefusalError extends Error {
  constructor(
    readonly taskId: string,
    readonly paused: PausedRunState,
  ) {
    super(pausedRunRefusalMessage(taskId, paused));
    this.name = "PausedRunRefusalError";
  }
}

/**
 * Round-2 F4: `generateSessionId` is second-granularity
 * (`quack-<taskId>-YYYYMMDD-HHMMSS`), and a malformed record has no
 * createdAt at all, so the base key is NOT unique by construction. The
 * stamp therefore takes a free suffix, and every write below refuses to
 * clobber rather than trusting the key — a second override must never
 * cost the first run its archive, which is the whole reason these are
 * session-keyed instead of a single `.prev` slot.
 */
function stampFor(paused: PausedRunState, logDir: string, taskId: string): string {
  const raw = paused.sessionId ?? paused.createdAt;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  const base = safe.length > 0 ? safe : "unknown";
  const taken = (stamp: string): boolean =>
    fs.existsSync(path.join(logDir, "checkpoints-archive", `${taskId}-${stamp}.manifest.json`));
  if (!taken(base)) return base;
  for (let n = 2; n <= 50; n += 1) {
    if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new PausedRunArchiveError(
    `Refusing to overwrite a paused run: 50 archives already exist for ${taskId} at stamp ${base}`,
  );
}

function copyOrThrow(from: string, to: string, what: string): void {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // COPYFILE_EXCL: an existing archive is never silently replaced.
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    throw new PausedRunArchiveError(
      `Refusing to overwrite a paused run: its ${what} could not be archived to ${to}`,
      error,
    );
  }
}

/**
 * Preserve everything an override is about to destroy. THROWS on
 * failure — the entire point is that losing a run someone paid for is
 * not an acceptable outcome of a failed cleanup. Scoped by
 * construction: callers only reach here when a paused run exists, so an
 * unwritable archive path cannot deny dispatch for tasks with nothing
 * to protect.
 *
 * Archive names are keyed by the paused run's session (falling back to
 * the pend's open time), never a single fixed slot — two successive
 * overrides must not leave the first run unrecoverable.
 *
 * The branch is archived as a REF rather than renamed or moved: the
 * commits stay reachable when the caller's `git branch -D` runs, the
 * live branch name keeps working for anything mid-flight, and nothing
 * about the normal path changes.
 */
export function archivePausedRunState(
  projectRoot: string,
  logDir: string,
  taskId: string,
  paused: PausedRunState,
): PausedRunArchive {
  const stamp = stampFor(paused, logDir, taskId);
  const archive: PausedRunArchive = {};

  const approvalSource = path.join(logDir, "approvals", paused.approvalFile);
  if (fs.existsSync(approvalSource)) {
    const target = path.join(
      logDir,
      "approvals",
      "archive",
      `${path.basename(paused.approvalFile, ".json")}-${stamp}.json`,
    );
    copyOrThrow(approvalSource, target, "pending approval record");
    archive.approvalPath = target;
  }

  const checkpointSource = path.join(logDir, `checkpoint-${taskId}.json`);
  if (fs.existsSync(checkpointSource)) {
    const target = path.join(logDir, "checkpoints-archive", `checkpoint-${taskId}-${stamp}.json`);
    copyOrThrow(checkpointSource, target, "checkpoint");
    archive.checkpointPath = target;
  }

  const branchRef = archiveBranchTip(projectRoot, taskId, paused, stamp);
  if (branchRef) archive.branchRef = branchRef;

  // A MANIFEST on disk, not just an event. The monitor's dispatch
  // lifecycle callback is SSE-only (server.ts wires it straight to
  // sse.broadcast), which is precisely how QPI-043's first attempt at
  // "durable" instrumentation was lost — and an archive nobody can find
  // is a deletion with extra steps.
  const manifestPath = path.join(logDir, "checkpoints-archive", `${taskId}-${stamp}.manifest.json`);
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    if (fs.existsSync(manifestPath)) {
      throw new Error(`archive manifest already exists at ${manifestPath}`);
    }
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          taskId,
          gate: paused.gate,
          pendOpenedAt: paused.createdAt,
          sessionId: paused.sessionId ?? null,
          archivedAt: new Date().toISOString(),
          ...archive,
          recovery: archive.branchRef
            ? `git branch <name> ${archive.branchRef}`
            : "no branch existed for this paused run",
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (error) {
    throw new PausedRunArchiveError(
      `Refusing to overwrite a paused run: its archive manifest could not be written to ${manifestPath}`,
      error,
    );
  }
  archive.manifestPath = manifestPath;

  return archive;
}

/**
 * Point an archive ref at the task branch's tip so a later `branch -D`
 * cannot orphan the commits. Returns the ref name, or undefined when
 * there is no such branch (nothing to protect).
 */
function archiveBranchTip(
  projectRoot: string,
  taskId: string,
  paused: PausedRunState,
  stamp: string,
): string | undefined {
  const branch = paused.branchName ?? defaultBranchName(projectRoot, taskId);
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", `${branch}^{commit}`], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined; // no branch (blueprint-gate pauses usually have none)
  }
  const ref = `refs/quack-archive/${taskId}/${stamp}`;
  try {
    // Round-2 F4: create-only. `update-ref <ref> <new>` with an empty
    // <oldvalue> fails if the ref already exists, so a stamp collision
    // cannot silently move an earlier run's archive onto this one.
    execFileSync("git", ["update-ref", ref, sha, ""], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new PausedRunArchiveError(
      `Refusing to overwrite a paused run: its branch ${branch} (${sha}) could not be archived as ${ref}`,
      error,
    );
  }
  return ref;
}

function defaultBranchName(projectRoot: string, taskId: string): string {
  let prefix = "quack/";
  try {
    const adapter = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "adapter.json"), "utf-8"),
    ) as { git?: { branchPrefix?: string } };
    prefix = adapter?.git?.branchPrefix ?? prefix;
  } catch {
    // defaults
  }
  return `${prefix}${taskId}`;
}
