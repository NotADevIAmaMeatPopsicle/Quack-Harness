// ─── Runtime status overlay (TASK-1318, P2-4) ───────────────────────
// The shared way to feed `resolveTaskState` from a project root.
//
// TASK-1317 gave the repo one resolver but no way to SUPPLY it: any
// site that wanted the runtime answer had to open a database itself,
// and the sites that did not bother kept reading raw spec status.
// TASK-1318 round-2 F1 found five readers whose PREDICATE had been
// modernized (`=== "COMPLETE"` became `isCompleteStatus`) while their
// INPUT stayed spec-only. Changing the predicate without changing the
// input is a rename, not a retirement. This module is the missing
// input.
//
// Two properties matter more than the API surface.
//
// 1. ONE batch query per pass, never one per task. Callers load the
//    overlay once and reuse the returned Map for every task they judge.
//
// 2. A read path must perform NO MIGRATIONS, NO CHECKPOINTS AND NO
//    DURABLE LOGICAL WRITES against the database it reads. `QuackDB`'s
//    constructor sets `journal_mode = WAL` and runs `runMigrations`;
//    `QuackDB.close()` issues `wal_checkpoint(TRUNCATE)`. Opening it to
//    answer a read is a schema-changing, checkpoint-forcing write
//    against a file a live monitor may be holding. This module opens
//    better-sqlite3 directly with `{ readonly: true, fileMustExist:
//    true }`, matching the TASK-1202 pattern already proven in
//    `dispatcher/dependency-resolver.ts`. (`close()` on a read-only
//    handle is safe: the truncating checkpoint is an explicit pragma
//    QuackDB issues, not something close does on its own.)
//
//    Round-3 F5 corrected the earlier wording here, which said "never
//    mutates". That overstated read-only SQLite: a WAL reader
//    participates in the shared `-shm` wal-index, whose read marks and
//    hash tables change while a SELECT runs. No schema, no WAL frame
//    and no row is written, and the guarantee that matters is intact,
//    but the file the process touches is not literally untouched and
//    the comment should not have claimed it was.
//
// Deliberately NOT exported here: any "is this task done" predicate.
// TASK-1318 S2 maps the predicate PER SITE, because `isCompleteStatus`
// answers "does this satisfy a dependency" and `isTerminalTaskStatus`
// answers "is this finished", and a REJECTED task is the case where
// they must disagree. A convenience doneness helper on top of the
// overlay would quietly push every caller onto one of them, which is
// the mistake round-1 F7 exists to prevent. Callers resolve here and
// apply their own mapped predicate.

import * as fsSync from "node:fs";
import * as path from "node:path";

import {
  resolveTaskState,
  type ResolvedTaskState,
  type TaskStateSessionInput,
  type TaskVerificationEvidence,
} from "./task-state.js";

// ─── Types ──────────────────────────────────────────────────────────

/** task_id to the raw DB `task_status.status` value. Never normalized:
 *  the resolver preserves raw status byte-for-byte (TASK-1317 F2), so
 *  normalizing here would change what `ResolvedTaskState.status`
 *  reports. Use `typedStatus` when a canonical value is wanted. */
export type RuntimeStatusOverlay = ReadonlyMap<string, string>;

/**
 * Why the overlay looks the way it does.
 *
 * - `absent`: no database at the path. The NORMAL case for a project
 *   that never dispatched. An empty overlay is the correct and complete
 *   answer, and every caller falls back to spec authority exactly as
 *   the resolver's precedence already prescribes.
 * - `loaded`: the table was read. An empty overlay here means the table
 *   is genuinely empty, which is also a real answer.
 * - `unreadable`: a database EXISTS and could not be read. This is the
 *   dangerous one. Falling back to spec authority here is silent
 *   reversion to the behavior TASK-1318 removes, and from the outside
 *   it looks identical to the healthy case.
 */
export type TaskStateOverlaySource = "absent" | "loaded" | "unreadable";

export interface TaskStateOverlayLoad {
  /** Always present, never null. Empty when `absent` or `unreadable`. */
  overlay: RuntimeStatusOverlay;
  /**
   * True only for `unreadable`. The one-line check a caller needs in
   * order to avoid treating "I could not read the store" as "the store
   * had nothing to say". Invariant, pinned by test:
   * `degraded === (source === "unreadable")`.
   */
  degraded: boolean;
  source: TaskStateOverlaySource;
  /** The path consulted, so a caller can report it without rebuilding it. */
  dbPath: string;
  /** The failure message. Present only when `source === "unreadable"`. */
  error?: string;
  /** The root as the caller supplied it (round-3 F1). */
  requestedRoot: string;
  /**
   * The root the consulted database belongs to. Differs from
   * `requestedRoot` when the caller passed a worktree path, which every
   * dispatched task does.
   */
  resolvedRoot: string;
  /** True when `resolvedRoot !== requestedRoot`. */
  viaWorktree: boolean;
}

/** The minimum surface this module uses. Narrow on purpose: a handle
 *  that cannot express `pragma` or `exec` cannot migrate or checkpoint
 *  by accident. */
export interface ReadonlySqliteStatement {
  all(): unknown[];
}

export interface ReadonlySqliteHandle {
  prepare(sql: string): ReadonlySqliteStatement;
  close(): void;
}

export interface ReadonlyOpenOptions {
  readonly: boolean;
  fileMustExist: boolean;
}

export type ReadonlySqliteOpener = (
  dbPath: string,
  options: ReadonlyOpenOptions,
) => ReadonlySqliteHandle;

export interface LoadTaskStateOverlayOptions {
  /** Override the default `<projectRoot>/.quack/quack.db`. */
  dbPath?: string;
  /** Where the degraded warning goes. Defaults to `console.warn`, so a
   *  failed read is never silent. Pass a no-op only when the caller
   *  surfaces `degraded` some other way. */
  warn?: (message: string) => void;
  /** Test seam. Production callers omit this and get better-sqlite3
   *  opened read-only. */
  openDatabase?: ReadonlySqliteOpener;
}

export interface ResolveTaskStateWithOverlayInput {
  taskId: string;
  /** The spec-parsed `Status:` value. Required, mirroring the
   *  resolver: the universe is spec-parsed tasks. */
  specStatus: string;
  /** Omit when no overlay was loaded; resolution then falls to spec. */
  overlay?: RuntimeStatusOverlay;
  session?: TaskStateSessionInput;
  verification?: TaskVerificationEvidence;
}

// ─── The read-only open ─────────────────────────────────────────────

/** The single batch read. Exported so a test can assert the shape
 *  rather than restate the string. */
export const TASK_STATUS_OVERLAY_QUERY = "SELECT task_id, status FROM task_status";

/** Canonical overlay database path for a project root. */
export function taskStateOverlayDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "quack.db");
}

// ─── Authoritative root resolution (round-3 F1) ─────────────────────
// A dispatched task does NOT run at the project root. `DispatchManager`
// creates `<root>/.quack/worktrees/<taskId>` and launches the child with
// `--project <worktree>` (dispatch-manager.ts), so `adapter.projectRoot`
// inside every dispatch IS the worktree. Worktree setup junctions only
// `.quack/logs` and `.quack/prep` into it — never `quack.db`, which is
// gitignored and deliberately single-instance.
//
// So `<worktree>/.quack/quack.db` cannot exist, `existsSync` returns
// false, the overlay loads as `absent` (not degraded, because absent is
// the normal rowless case), and every routed reader in the dispatch
// child silently falls back to spec authority. That made TASK-1318's
// lifecycle routing INERT in exactly the situation it was written for,
// and it looked healthy from the outside. Round-3 F1.
//
// The fix is structural, not per-caller: a worktree has no authority of
// its own and never will, so resolution belongs in the one place that
// turns a project root into a database path.

/**
 * Directory paths, relative to a project root, that hold WORKTREES
 * rather than projects. Outermost segment first.
 *
 * All three families are covered rather than only `.quack/worktrees`,
 * because the property is the same for each: a worktree is a checkout,
 * not a project, and the runtime store lives with the project. Covering
 * only the dispatch family would leave the identical bug open for the
 * other two.
 */
export const WORKTREE_CONTAINER_PATHS: readonly (readonly string[])[] = [
  [".quack", "worktrees"], // Quack dispatch worktrees
  [".claude", "worktrees"], // Claude Code worktrees
  [".hermes-worktrees"], // Hermes worktrees
];

export interface AuthoritativeProjectRootResolution {
  /** The root as the caller supplied it, absolute. */
  requestedRoot: string;
  /** The root whose `.quack/quack.db` is authoritative. */
  root: string;
  /** True when `root` differs from `requestedRoot`. */
  viaWorktree: boolean;
  /**
   * Every root considered, innermost (the request) to outermost. Kept
   * so a caller can report what was searched instead of restating the
   * unwrapping rule in a log line.
   */
  candidates: readonly string[];
}

/**
 * If `root` is `<parent>/<container>/<name>` for a known worktree
 * container, return `<parent>`. Otherwise null.
 *
 * Compared case-insensitively: on Windows `.Quack\Worktrees\X` and
 * `.quack\worktrees\X` are the same directory, and failing to unwrap
 * there reintroduces the whole bug. On a case-sensitive filesystem this
 * is marginally more eager than strictly necessary, which is the safe
 * direction: the candidate still has to hold an actual database before
 * it is chosen.
 */
function unwrapWorktreeRoot(root: string): string | null {
  for (const container of WORKTREE_CONTAINER_PATHS) {
    // `root`'s basename is the worktree NAME; the container sits above
    // it, so walk up from the worktree's parent, outermost segment last.
    let cursor = path.dirname(root);
    let matched = true;
    for (let i = container.length - 1; i >= 0; i--) {
      if (path.basename(cursor).toLowerCase() !== container[i]) {
        matched = false;
        break;
      }
      cursor = path.dirname(cursor);
    }
    if (matched) return cursor;
  }
  return null;
}

/**
 * Resolve the project root whose runtime store answers for a given
 * root, unwrapping worktree topologies.
 *
 * The request itself is always the FIRST candidate, so a root that does
 * hold a database keeps it and nothing about the non-worktree case
 * changes. Unwrapping repeats because the layers genuinely nest: a
 * dispatch worktree created from inside a Claude Code worktree is
 * `<repo>/.claude/worktrees/<name>/.quack/worktrees/<taskId>`, and one
 * step out lands on a checkout with no database either.
 *
 * The first candidate that actually HOLDS a database wins, so the
 * nearest real store is preferred over a more distant one. When no
 * candidate holds one the outermost is returned: the answer is `absent`
 * whichever is reported, and naming the real project root makes the
 * diagnostic useful instead of pointing at a worktree that could never
 * have had it.
 */
export function resolveAuthoritativeProjectRoot(
  projectRoot: string,
): AuthoritativeProjectRootResolution {
  const requestedRoot = path.resolve(projectRoot);

  const candidates: string[] = [requestedRoot];
  for (;;) {
    const next = unwrapWorktreeRoot(candidates[candidates.length - 1]);
    // The `includes` guard is belt-and-braces: `unwrapWorktreeRoot`
    // always moves strictly upward, so a cycle is impossible, but an
    // unbounded `for(;;)` over path math should not depend on that.
    if (!next || candidates.includes(next)) break;
    candidates.push(next);
  }

  for (const candidate of candidates) {
    if (fsSync.existsSync(taskStateOverlayDbPath(candidate))) {
      return {
        requestedRoot,
        root: candidate,
        viaWorktree: candidate !== requestedRoot,
        candidates,
      };
    }
  }

  const root = candidates[candidates.length - 1];
  return {
    requestedRoot,
    root,
    viaWorktree: root !== requestedRoot,
    candidates,
  };
}

// Lazy-require better-sqlite3 the way quack-db.ts does, so the native
// addon is only loaded when a read actually happens and a machine with
// a version-skewed build fails at the read rather than at import.
let _ReadonlyDatabase: ReadonlySqliteOpener | undefined;

function defaultOpenDatabase(dbPath: string, options: ReadonlyOpenOptions): ReadonlySqliteHandle {
  if (!_ReadonlyDatabase) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as new (
      file: string,
      opts: ReadonlyOpenOptions,
    ) => ReadonlySqliteHandle;
    _ReadonlyDatabase = (file, opts) => new Database(file, opts);
  }
  return _ReadonlyDatabase(dbPath, options);
}

/**
 * Load the whole `task_status` table for a project in ONE query.
 *
 * Never creates, migrates or checkpoints the database. Never throws:
 * an unreadable database is reported through `degraded` rather than by
 * breaking whatever view or scheduler asked for it.
 *
 * Load once per pass and reuse the Map. There is deliberately no cache
 * inside this module: a cached overlay would answer with a status the
 * store no longer holds, and staleness in the authority store is the
 * class of bug this whole task exists to remove.
 */
export function loadTaskStateOverlay(
  projectRoot: string,
  options: LoadTaskStateOverlayOptions = {},
): TaskStateOverlayLoad {
  // Round-3 F1: resolve worktree roots to the project that owns the
  // store. An explicit `dbPath` skips resolution entirely, because a
  // caller naming the file has already decided; `resolvedRoot` then
  // reports the request unchanged rather than implying a walk happened.
  const resolution = options.dbPath
    ? {
        requestedRoot: path.resolve(projectRoot),
        root: path.resolve(projectRoot),
        viaWorktree: false,
      }
    : resolveAuthoritativeProjectRoot(projectRoot);
  const roots = {
    requestedRoot: resolution.requestedRoot,
    resolvedRoot: resolution.root,
    viaWorktree: resolution.viaWorktree,
  };
  const dbPath = options.dbPath ?? taskStateOverlayDbPath(resolution.root);

  if (!fsSync.existsSync(dbPath)) {
    return { overlay: new Map(), degraded: false, source: "absent", dbPath, ...roots };
  }

  const open = options.openDatabase ?? defaultOpenDatabase;
  let handle: ReadonlySqliteHandle | undefined;
  try {
    handle = open(dbPath, { readonly: true, fileMustExist: true });
    const rows = handle.prepare(TASK_STATUS_OVERLAY_QUERY).all() as Array<{
      task_id?: unknown;
      status?: unknown;
    }>;
    const overlay = new Map<string, string>();
    for (const row of rows) {
      // A row whose id or status is not a string cannot answer for a
      // task; skipping it leaves that task on spec authority, which is
      // the same outcome as having no row at all.
      if (typeof row.task_id === "string" && typeof row.status === "string") {
        overlay.set(row.task_id, row.status);
      }
    }
    return { overlay, degraded: false, source: "loaded", dbPath, ...roots };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const warn = options.warn ?? ((text: string) => console.warn(text));
    warn(
      `[task-state-overlay] runtime overlay UNREADABLE at ${dbPath} (${message}); ` +
        "callers are falling back to spec status, which is not authoritative",
    );
    return {
      overlay: new Map(),
      degraded: true,
      source: "unreadable",
      dbPath,
      error: message,
      ...roots,
    };
  } finally {
    try {
      handle?.close();
    } catch {
      // Already closed, or never opened. A read path has nothing to
      // flush, so a failed close changes no state.
    }
  }
}

// ─── Single-task resolution ─────────────────────────────────────────

/**
 * Resolve one task through the shared resolver with the runtime
 * overlay applied.
 *
 * The object argument is deliberate: `taskId` and `specStatus` are both
 * strings, so a positional signature would let a swapped call compile
 * silently, and this helper is copied across many call sites.
 *
 * A missing overlay entry supplies nothing, so precedence falls through
 * to session and then spec exactly as `resolveTaskState` defines. An
 * entry holding the empty string DOES win, because the resolver
 * preserves the pre-1317 `??` semantics byte-for-byte; that is inherited
 * behavior, pinned by test rather than assumed.
 */
export function resolveTaskStateWithOverlay(
  input: ResolveTaskStateWithOverlayInput,
): ResolvedTaskState {
  const runtime = input.overlay?.get(input.taskId);
  return resolveTaskState({
    spec: input.specStatus,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(input.session ? { session: input.session } : {}),
    ...(input.verification ? { verification: input.verification } : {}),
  });
}
