import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

import {
  loadTaskStateOverlay,
  resolveAuthoritativeProjectRoot,
  resolveTaskStateWithOverlay,
  taskStateOverlayDbPath,
  TASK_STATUS_OVERLAY_QUERY,
  WORKTREE_CONTAINER_PATHS,
  type ReadonlyOpenOptions,
  type ReadonlySqliteHandle,
  type ReadonlySqliteOpener,
  type RuntimeStatusOverlay,
} from "../../src/core/task-state-overlay";
import { resolveTaskState } from "../../src/core/task-state";
import { QuackDB } from "../../src/db/quack-db";

// ─── Harness ────────────────────────────────────────────────────────

const tempRoots: string[] = [];

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-overlay-mod-"));
  tempRoots.push(root);
  return root;
}

function makeQuackDir(root: string): string {
  const dir = path.join(root, ".quack");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps sqlite handles briefly after close; a leftover
      // temp dir must never fail the suite.
    }
  }
});

/** What the fake handle recorded, so batching and read-only opening are
 *  asserted against observed calls rather than against the source. */
interface OpenerCalls {
  openCount: number;
  openOptions: ReadonlyOpenOptions[];
  queries: string[];
  closes: number;
  /** Any mutating call the module might have made. Must stay empty. */
  mutations: string[];
}

interface FakeHandle extends ReadonlySqliteHandle {
  pragma(source: string): unknown;
  exec(sql: string): void;
}

function makeOpener(
  rows: unknown[],
  behavior: { failOpen?: Error; failQuery?: Error } = {},
): { opener: ReadonlySqliteOpener; calls: OpenerCalls } {
  const calls: OpenerCalls = {
    openCount: 0,
    openOptions: [],
    queries: [],
    closes: 0,
    mutations: [],
  };

  const opener: ReadonlySqliteOpener = (_dbPath, options) => {
    calls.openCount++;
    calls.openOptions.push(options);
    if (behavior.failOpen) throw behavior.failOpen;

    const handle: FakeHandle = {
      prepare(sql: string) {
        calls.queries.push(sql);
        return {
          all(): unknown[] {
            if (behavior.failQuery) throw behavior.failQuery;
            return rows;
          },
        };
      },
      close() {
        calls.closes++;
      },
      pragma(source: string): unknown {
        calls.mutations.push(`pragma:${source}`);
        return undefined;
      },
      exec(sql: string): void {
        calls.mutations.push(`exec:${sql}`);
      },
    };
    return handle;
  };

  return { opener, calls };
}

function statusRows(count: number): Array<{ task_id: string; status: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    task_id: `TASK-${String(1000 + index)}`,
    status: index % 2 === 0 ? "COMPLETE" : "IN_PROGRESS",
  }));
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows: unknown[] = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    return rows
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
  } finally {
    db.close();
  }
}

function journalMode(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const value: unknown = db.pragma("journal_mode", { simple: true });
    return typeof value === "string" ? value.toLowerCase() : "";
  } finally {
    db.close();
  }
}

// ─── One batch query, never one per task ────────────────────────────

describe("loadTaskStateOverlay batches", () => {
  test("issues exactly one query no matter how many rows come back", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const { opener, calls } = makeOpener(statusRows(250));

    const load = loadTaskStateOverlay(root, { openDatabase: opener });

    expect(load.overlay.size).toBe(250);
    expect(calls.openCount).toBe(1);
    expect(calls.queries).toEqual([TASK_STATUS_OVERLAY_QUERY]);
  });

  test("resolving many tasks after one load opens nothing further", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const rows = statusRows(100);
    const { opener, calls } = makeOpener(rows);

    const { overlay } = loadTaskStateOverlay(root, { openDatabase: opener });
    const resolved = rows.map((row) =>
      resolveTaskStateWithOverlay({
        taskId: row.task_id,
        specStatus: "BACKLOG",
        overlay,
      }),
    );

    expect(resolved).toHaveLength(100);
    expect(resolved.every((state) => state.authority === "runtime")).toBe(true);
    expect(calls.openCount).toBe(1);
    expect(calls.queries).toHaveLength(1);
  });

  test("rows whose id or status is not a string are dropped, not guessed at", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const { opener } = makeOpener([
      { task_id: "TASK-1", status: "COMPLETE" },
      { task_id: 2, status: "COMPLETE" },
      { task_id: "TASK-3", status: null },
      { nothing: true },
    ]);

    const { overlay, degraded } = loadTaskStateOverlay(root, { openDatabase: opener });

    expect([...overlay.keys()]).toEqual(["TASK-1"]);
    expect(degraded).toBe(false);
  });
});

// ─── Read-only safety: never migrate, never checkpoint ──────────────

describe("loadTaskStateOverlay never mutates the database", () => {
  test("opens read-only with fileMustExist and closes the handle", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const { opener, calls } = makeOpener(statusRows(3));

    loadTaskStateOverlay(root, { openDatabase: opener });

    expect(calls.openOptions).toEqual([{ readonly: true, fileMustExist: true }]);
    expect(calls.closes).toBe(1);
    expect(calls.mutations).toEqual([]);
  });

  test("closes the handle even when the query throws", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const { opener, calls } = makeOpener([], { failQuery: new Error("no such table") });

    const load = loadTaskStateOverlay(root, { openDatabase: opener, warn: () => undefined });

    expect(load.degraded).toBe(true);
    expect(calls.closes).toBe(1);
  });

  test("a real database gains no tables and keeps its journal mode", () => {
    // A bare database holding only task_status. Running QuackDB's
    // migrations against it would add sessions, dispatch_jobs, verified
    // and the rest, and QuackDB's constructor would switch it to WAL.
    // Both are observable in the file afterwards.
    const root = makeProjectRoot();
    makeQuackDir(root);
    const dbPath = taskStateOverlayDbPath(root);
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE task_status (task_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    seed.prepare("INSERT INTO task_status VALUES (?, ?)").run("TASK-1318", "IN_PROGRESS");
    seed.close();

    const tablesBefore = tableNames(dbPath);
    const modeBefore = journalMode(dbPath);

    const load = loadTaskStateOverlay(root);

    expect(load.source).toBe("loaded");
    expect(load.overlay.get("TASK-1318")).toBe("IN_PROGRESS");
    expect(tablesBefore).toEqual(["task_status"]);
    expect(tableNames(dbPath)).toEqual(tablesBefore);
    expect(journalMode(dbPath)).toBe(modeBefore);
  });

  test("reads a live QuackDB without altering its schema", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    const dbPath = taskStateOverlayDbPath(root);
    const db = new QuackDB(dbPath);
    db.setStatus("TASK-1317", "COMPLETE", "test");
    db.setStatus("TASK-1318", "IN_PROGRESS", "test");
    db.close();
    const tablesBefore = tableNames(dbPath);

    const load = loadTaskStateOverlay(root);

    expect(load.source).toBe("loaded");
    expect(load.degraded).toBe(false);
    expect(load.overlay.get("TASK-1317")).toBe("COMPLETE");
    expect(load.overlay.get("TASK-1318")).toBe("IN_PROGRESS");
    expect(tableNames(dbPath)).toEqual(tablesBefore);
  });
});

// ─── Missing is not the same as unreadable ──────────────────────────

describe("loadTaskStateOverlay distinguishes missing from unreadable", () => {
  test("a project that never dispatched degrades silently and creates nothing", () => {
    const root = makeProjectRoot();
    const warn = jest.fn();

    const load = loadTaskStateOverlay(root, { warn });

    expect(load.source).toBe("absent");
    expect(load.degraded).toBe(false);
    expect(load.error).toBeUndefined();
    expect(load.overlay.size).toBe(0);
    expect(load.dbPath).toBe(taskStateOverlayDbPath(root));
    expect(fs.existsSync(load.dbPath)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a database that exists but cannot be read reports degraded with the reason", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "this is not a sqlite database");
    const warn = jest.fn();

    const load = loadTaskStateOverlay(root, { warn });

    expect(load.source).toBe("unreadable");
    expect(load.degraded).toBe(true);
    expect(load.overlay.size).toBe(0);
    expect(typeof load.error).toBe("string");
    expect(load.error).not.toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNREADABLE"));
  });

  test("an open failure is degraded, not an empty overlay pretending to be fine", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "");
    const { opener } = makeOpener([], { failOpen: new Error("better-sqlite3 unavailable") });
    const warn = jest.fn();

    const load = loadTaskStateOverlay(root, { openDatabase: opener, warn });

    expect(load.degraded).toBe(true);
    expect(load.source).toBe("unreadable");
    expect(load.error).toContain("better-sqlite3 unavailable");
  });

  test("a degraded read is never silent by default", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    fs.writeFileSync(taskStateOverlayDbPath(root), "not a database either");
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const load = loadTaskStateOverlay(root);

      expect(load.degraded).toBe(true);
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("task-state-overlay"));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  test("an empty table is loaded, not degraded", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    const db = new QuackDB(taskStateOverlayDbPath(root));
    db.close();

    const load = loadTaskStateOverlay(root);

    expect(load.source).toBe("loaded");
    expect(load.degraded).toBe(false);
    expect(load.overlay.size).toBe(0);
  });

  test("degraded is true for exactly the unreadable source", () => {
    const absentRoot = makeProjectRoot();
    const loadedRoot = makeProjectRoot();
    makeQuackDir(loadedRoot);
    new QuackDB(taskStateOverlayDbPath(loadedRoot)).close();
    const brokenRoot = makeProjectRoot();
    makeQuackDir(brokenRoot);
    fs.writeFileSync(taskStateOverlayDbPath(brokenRoot), "junk");

    const loads = [
      loadTaskStateOverlay(absentRoot),
      loadTaskStateOverlay(loadedRoot),
      loadTaskStateOverlay(brokenRoot, { warn: () => undefined }),
    ];

    expect(loads.map((load) => load.source)).toEqual(["absent", "loaded", "unreadable"]);
    for (const load of loads) {
      expect(load.degraded).toBe(load.source === "unreadable");
    }
  });

  test("an explicit dbPath overrides the project-root default", () => {
    const root = makeProjectRoot();
    const elsewhere = path.join(makeProjectRoot(), "custom.db");
    const db = new QuackDB(elsewhere);
    db.setStatus("TASK-1", "VERIFIED", "test");
    db.close();

    const load = loadTaskStateOverlay(root, { dbPath: elsewhere });

    expect(load.dbPath).toBe(elsewhere);
    expect(load.overlay.get("TASK-1")).toBe("VERIFIED");
  });
});

// ─── Resolution agrees with resolveTaskState ────────────────────────

describe("resolveTaskStateWithOverlay", () => {
  const specStatuses = [
    "BACKLOG",
    "READY",
    "IN_PROGRESS",
    "BLOCKED",
    "ON_HOLD",
    "DECOMPOSED",
    "VERIFYING",
    "COMPLETE",
    "VERIFIED",
    "REJECTED",
    "in progress",
    "",
    "NOT_A_STATUS",
  ];
  const runtimeValues = [undefined, "COMPLETE", "REJECTED", "IN_PROGRESS", "", "weird"];

  test("matches resolveTaskState for every spec and runtime combination", () => {
    for (const specStatus of specStatuses) {
      for (const runtime of runtimeValues) {
        const overlay: RuntimeStatusOverlay =
          runtime === undefined ? new Map() : new Map([["TASK-1", runtime]]);

        const viaOverlay = resolveTaskStateWithOverlay({
          taskId: "TASK-1",
          specStatus,
          overlay,
        });
        const direct = resolveTaskState(
          runtime === undefined ? { spec: specStatus } : { spec: specStatus, runtime },
        );

        expect(viaOverlay).toEqual(direct);
      }
    }
  });

  test("a runtime row wins over the spec and says so", () => {
    const overlay = new Map([["TASK-1318", "IN_PROGRESS"]]);

    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "COMPLETE",
      overlay,
    });

    expect(state.status).toBe("IN_PROGRESS");
    expect(state.typedStatus).toBe("IN_PROGRESS");
    expect(state.authority).toBe("runtime");
  });

  test("a task with no row keeps spec authority, which is how spec-only completions still unblock", () => {
    const overlay = new Map([["TASK-OTHER", "IN_PROGRESS"]]);

    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "COMPLETE",
      overlay,
    });

    expect(state.status).toBe("COMPLETE");
    expect(state.authority).toBe("spec");
  });

  test("an omitted overlay resolves from the spec", () => {
    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "READY",
    });

    expect(state.status).toBe("READY");
    expect(state.authority).toBe("spec");
  });

  test("an empty-string row still wins, matching the resolver's inherited semantics", () => {
    const overlay = new Map([["TASK-1318", ""]]);

    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "COMPLETE",
      overlay,
    });

    expect(state.status).toBe("");
    expect(state.typedStatus).toBeNull();
    expect(state.authority).toBe("runtime");
  });

  test("session evidence still applies when no row exists", () => {
    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "IN_PROGRESS",
      overlay: new Map(),
      session: { outcome: "approved", status: "completed" },
    });

    expect(state.status).toBe("COMPLETE");
    expect(state.authority).toBe("session");
  });

  test("a runtime row outranks session evidence", () => {
    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "IN_PROGRESS",
      overlay: new Map([["TASK-1318", "REJECTED"]]),
      session: { outcome: "approved", status: "completed" },
    });

    expect(state.status).toBe("REJECTED");
    expect(state.authority).toBe("runtime");
  });

  test("verification evidence is carried through untouched", () => {
    const verification = {
      verdict: "VERIFIED",
      method: "admin-9-phase",
      commitSha: "abc1234",
      verifiedAt: "2026-08-07T00:00:00.000Z",
    };

    const state = resolveTaskStateWithOverlay({
      taskId: "TASK-1318",
      specStatus: "COMPLETE",
      overlay: new Map(),
      verification,
    });

    expect(state.verification).toEqual(verification);
  });

  test("resolution reads only the requested id", () => {
    const overlay = new Map([
      ["TASK-1", "COMPLETE"],
      ["TASK-11", "REJECTED"],
    ]);

    expect(
      resolveTaskStateWithOverlay({ taskId: "TASK-1", specStatus: "BACKLOG", overlay }).status,
    ).toBe("COMPLETE");
    expect(
      resolveTaskStateWithOverlay({ taskId: "TASK-11", specStatus: "BACKLOG", overlay }).status,
    ).toBe("REJECTED");
    expect(
      resolveTaskStateWithOverlay({ taskId: "TASK-111", specStatus: "BACKLOG", overlay }).status,
    ).toBe("BACKLOG");
  });
});

// ─── End to end against a seeded database ───────────────────────────

describe("load then resolve", () => {
  test("a DB row overrides a conflicting spec line through the real path", () => {
    const root = makeProjectRoot();
    makeQuackDir(root);
    const db = new QuackDB(taskStateOverlayDbPath(root));
    db.setStatus("TASK-A", "IN_PROGRESS", "worker");
    db.setStatus("TASK-B", "REJECTED", "judge");
    db.close();

    const { overlay, degraded } = loadTaskStateOverlay(root);
    const a = resolveTaskStateWithOverlay({
      taskId: "TASK-A",
      specStatus: "COMPLETE",
      overlay,
    });
    const b = resolveTaskStateWithOverlay({
      taskId: "TASK-B",
      specStatus: "COMPLETE",
      overlay,
    });
    const c = resolveTaskStateWithOverlay({
      taskId: "TASK-C",
      specStatus: "COMPLETE",
      overlay,
    });

    expect(degraded).toBe(false);
    expect(a.status).toBe("IN_PROGRESS");
    expect(a.authority).toBe("runtime");
    expect(b.status).toBe("REJECTED");
    expect(c.status).toBe("COMPLETE");
    expect(c.authority).toBe("spec");
  });
});

// ─── Authoritative root resolution (round-3 F1) ─────────────────────
// A dispatched task runs with `--project <root>/.quack/worktrees/<id>`,
// and worktree setup junctions only `.quack/logs` and `.quack/prep`, so
// `<worktree>/.quack/quack.db` structurally cannot exist. Reading the
// store from the requested root therefore returned an empty overlay on
// EVERY real dispatch, and `absent` is not `degraded`, so it looked
// healthy. These pin the resolution that fixes it.

describe("resolveAuthoritativeProjectRoot", () => {
  function seedStore(root: string, rows: Record<string, string>): void {
    makeQuackDir(root);
    const db = new QuackDB(taskStateOverlayDbPath(root));
    for (const [taskId, status] of Object.entries(rows)) {
      db.setStatus(taskId, status, "worker");
    }
    db.close();
  }

  test("an ordinary project root resolves to itself and reports no worktree", () => {
    const root = makeProjectRoot();
    seedStore(root, { "TASK-1": "IN_PROGRESS" });

    const resolution = resolveAuthoritativeProjectRoot(root);

    expect(resolution.root).toBe(path.resolve(root));
    expect(resolution.viaWorktree).toBe(false);
    expect(resolution.candidates).toEqual([path.resolve(root)]);
  });

  test.each(WORKTREE_CONTAINER_PATHS.map((segments) => [segments.join("/"), segments]))(
    "a worktree under %s resolves out to the project that owns the store",
    (_label, segments) => {
      const root = makeProjectRoot();
      seedStore(root, { "TASK-2": "REJECTED" });
      const worktree = path.join(root, ...(segments as string[]), "TASK-2");
      fs.mkdirSync(worktree, { recursive: true });

      const resolution = resolveAuthoritativeProjectRoot(worktree);

      expect(resolution.root).toBe(path.resolve(root));
      expect(resolution.viaWorktree).toBe(true);
      expect(resolution.requestedRoot).toBe(path.resolve(worktree));
    },
  );

  test("the NEAREST store wins, so a worktree with its own database keeps it", () => {
    // The opposite failure mode. Always climbing would make an isolated
    // checkout that genuinely has a store start answering from its
    // parent, which is a different bug in the other direction.
    const root = makeProjectRoot();
    seedStore(root, { "TASK-3": "IN_PROGRESS" });
    const worktree = path.join(root, ".quack", "worktrees", "TASK-3");
    fs.mkdirSync(worktree, { recursive: true });
    seedStore(worktree, { "TASK-3": "COMPLETE" });

    const resolution = resolveAuthoritativeProjectRoot(worktree);

    expect(resolution.root).toBe(path.resolve(worktree));
    expect(resolution.viaWorktree).toBe(false);
  });

  test("nested worktrees unwrap all the way to the store", () => {
    // A dispatch worktree created from inside a Claude Code worktree is
    // `<repo>/.claude/worktrees/<name>/.quack/worktrees/<taskId>`, and
    // one step out lands on a checkout with no store either.
    const root = makeProjectRoot();
    seedStore(root, { "TASK-4": "REJECTED" });
    const nested = path.join(
      root,
      ".claude",
      "worktrees",
      "some-session",
      ".quack",
      "worktrees",
      "TASK-4",
    );
    fs.mkdirSync(nested, { recursive: true });

    const resolution = resolveAuthoritativeProjectRoot(nested);

    expect(resolution.root).toBe(path.resolve(root));
    expect(resolution.candidates).toHaveLength(3);
  });

  test("with no store anywhere, the outermost project root is reported", () => {
    // The answer is `absent` whichever root is named, so naming the real
    // project makes the diagnostic useful instead of pointing at a
    // worktree that could never have held a database.
    const root = makeProjectRoot();
    const worktree = path.join(root, ".quack", "worktrees", "TASK-5");
    fs.mkdirSync(worktree, { recursive: true });

    const resolution = resolveAuthoritativeProjectRoot(worktree);

    expect(resolution.root).toBe(path.resolve(root));
    expect(resolution.viaWorktree).toBe(true);
  });

  test("loadTaskStateOverlay reads the parent's rows from inside a worktree", () => {
    // The end-to-end shape of round-3 F1: the rows a dispatch must obey
    // live at the project root, and the dispatch is rooted in a worktree
    // that has no store and never will.
    const root = makeProjectRoot();
    seedStore(root, { "TASK-6": "IN_PROGRESS" });
    const worktree = path.join(root, ".quack", "worktrees", "TASK-6");
    fs.mkdirSync(path.join(worktree, ".quack", "logs"), { recursive: true });

    const load = loadTaskStateOverlay(worktree);

    expect(load.source).toBe("loaded");
    expect(load.degraded).toBe(false);
    expect(load.viaWorktree).toBe(true);
    expect(load.requestedRoot).toBe(path.resolve(worktree));
    expect(load.resolvedRoot).toBe(path.resolve(root));
    expect(load.dbPath).toBe(taskStateOverlayDbPath(path.resolve(root)));
    expect(
      resolveTaskStateWithOverlay({
        taskId: "TASK-6",
        specStatus: "COMPLETE",
        overlay: load.overlay,
      }).status,
    ).toBe("IN_PROGRESS");
  });

  test("an explicit dbPath is obeyed verbatim and skips resolution entirely", () => {
    // A caller naming the file has already decided. `resolvedRoot` must
    // then report the request unchanged rather than implying a walk that
    // did not happen.
    const root = makeProjectRoot();
    seedStore(root, { "TASK-7": "REJECTED" });
    const worktree = path.join(root, ".quack", "worktrees", "TASK-7");
    fs.mkdirSync(worktree, { recursive: true });

    const load = loadTaskStateOverlay(worktree, {
      dbPath: taskStateOverlayDbPath(root),
    });

    expect(load.source).toBe("loaded");
    expect(load.viaWorktree).toBe(false);
    expect(load.resolvedRoot).toBe(path.resolve(worktree));
    expect(load.overlay.get("TASK-7")).toBe("REJECTED");
  });
});
