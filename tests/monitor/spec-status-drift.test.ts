// ─── Spec-status drift observation (TASK-1318, P2-4) ────────────────
// BEHAVIORAL pins for the two task-watcher `onTerminalStatus` callbacks
// wired inside `createMonitorServer` (src/monitor/server.ts): the
// project-scoped wiring used in multi-project mode, and the legacy
// single-project wiring.
//
// REACHABILITY, stated plainly because the alternative is a source-grep
// test that cannot fail. Both callbacks are inline closures inside
// `createMonitorServer`, so neither is importable. Both are still
// REACHABLE, and this suite reaches them the way production does:
//
//   * Project-scoped wiring: start a real monitor over a real temp
//     project, then drive the REAL `TaskWatcher` the server constructed
//     (`ProjectContext.taskWatcher`) through its public `processFile`,
//     which is precisely the method chokidar invokes. The only thing
//     skipped is the 2s debounce timer, so the callback, the DB it
//     consults and the SSE manager it broadcasts on are all the real
//     server-wired instances.
//   * Legacy wiring: its watcher handle is captured in a local
//     (`taskWatcherInstance`) and exposed nowhere, so that one runs fully
//     end to end. A real spec file is written into the watched directory
//     and chokidar drives everything.
//
// Every assertion below is made against real `task_status` rows and real
// SSE broadcasts, with conflicting spec and DB state. No test in this file
// reads source text.
//
// DISCRIMINATION, measured rather than asserted. Replayed against the
// pre-1318 callbacks (equal: return; absent or nonterminal:
// setStatus(..., "spec_sync") with no broadcast; terminal conflict:
// broadcast), 13 of these 17 fail. The four that pass either way are the
// branch this change deliberately did not touch, and each is marked
// UNCHANGED BRANCH below: an agreeing row and a conflicting TERMINAL row
// behave identically before and after. They are kept because they bound
// the WIDENING, which is this change's own failure mode: drift must not
// start firing on agreement, and must not stop firing on the conflict it
// already reported.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { QuackDB } from "../../src/db";
import type { NoopDB } from "../../src/db";
import type { QuackEvent } from "../../src/monitor/event-types";
import type { ProjectContext } from "../../src/monitor/project-registry";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// Keep tests off any real .quack/auth.json.
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// The legacy leg waits on chokidar (polling on Windows) plus the watcher's
// 2s debounce, so this suite needs more than the 15s default.
jest.setTimeout(120_000);

// ─── Fixtures ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-spec-drift-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function setupProjectDirectory(projectRoot: string, projectName: string): void {
  fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
  fs.writeFileSync(
    path.join(projectRoot, ".quack", "adapter.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        project: {
          name: projectName,
          root: projectRoot,
          taskDir: "docs/tasks",
          conventionsDir: ".quack",
        },
        agent: {
          model: "claude-opus-4-20250514",
          judgeModel: "claude-sonnet-4-20250514",
          enrichModel: "claude-sonnet-4-20250514",
          maxTurns: 30,
          maxBudgetPerTask: 5.0,
          maxRetries: 1,
        },
        verification: { commands: [], conventionChecks: [] },
        sandbox: {
          writablePaths: [],
          deniedPaths: [],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        git: {
          branchPrefix: "quack",
          baseBranch: "main",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Automated-By: Quack",
          autoCreatePr: false,
          autoPush: false,
        },
        logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function makeAdapter(projectRoot: string): ProjectAdapter {
  const config = JSON.parse(
    fs.readFileSync(path.join(projectRoot, ".quack", "adapter.json"), "utf-8"),
  ) as AdapterConfig;
  return {
    projectRoot,
    config,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "spec-drift-fixture",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

/** A minimal spec that parses. The `Status:` line is the whole point. */
function specFor(taskId: string, status: string): string {
  return [
    `# ${taskId}: Drift fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1 hour",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "",
    "## Problem Statement",
    "A fixture whose only interesting property is its Status line.",
    "",
    "## Success Criteria",
    "- The watcher observes this file",
    "",
    "## Testing Requirements",
    "- Exercised by tests/monitor/spec-status-drift.test.ts",
  ].join("\n");
}

function writeSpec(taskDirAbs: string, taskId: string, status: string): string {
  const filePath = path.join(taskDirAbs, `${taskId}.md`);
  fs.writeFileSync(filePath, specFor(taskId, status), "utf-8");
  return filePath;
}

/**
 * `ProjectContext.taskWatcher` is declared as `{ close }` only, but the
 * value stored there is the real `TaskWatcher`. `processFile` is its
 * public entry point and the exact method chokidar calls.
 */
interface ProcessableWatcher {
  processFile(filePath: string): Promise<void>;
}

function watcherOf(context: ProjectContext): ProcessableWatcher {
  const watcher = context.taskWatcher;
  if (!watcher) {
    throw new Error(
      "the monitor did not attach a TaskWatcher to the project context; " +
        "the drift callback under test was never wired, so this suite would be vacuous",
    );
  }
  return watcher as unknown as ProcessableWatcher;
}

interface DriftPayload {
  taskId: string;
  specStatus: string;
  dbStatus: string;
}

function driftPayload(event: QuackEvent): DriftPayload {
  return event.payload as unknown as DriftPayload;
}

/**
 * Both watcher stages are broadcast with `as never` casts in server.ts
 * because `task_discovered` is not a member of `EventStage`, so the stage
 * is compared as a plain string rather than against the union.
 */
function stageOf(event: QuackEvent): string {
  return event.stage as string;
}

function driftEventsFor(events: readonly QuackEvent[], taskId: string): QuackEvent[] {
  return events.filter((e) => stageOf(e) === "task_status_drift" && e.taskId === taskId);
}

function discoveredFor(events: readonly QuackEvent[], taskId: string): QuackEvent[] {
  return events.filter((e) => stageOf(e) === "task_discovered" && e.taskId === taskId);
}

/** Records every broadcast while still running the real SSE broadcast. */
function recordBroadcasts(sse: { broadcast(event: QuackEvent): void }): QuackEvent[] {
  const seen: QuackEvent[] = [];
  const original = sse.broadcast.bind(sse);
  jest.spyOn(sse, "broadcast").mockImplementation((event: QuackEvent) => {
    seen.push(event);
    original(event);
  });
  return seen;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

interface SeedRow {
  status: string;
  updatedBy: string;
}

interface DriftCase {
  name: string;
  taskId: string;
  specStatus: "COMPLETE" | "VERIFIED" | "REJECTED";
  /** The runtime row to plant before the spec is observed. */
  seed: SeedRow | null;
  expectDrift: boolean;
}

// The full matrix: three terminal spec claims against every shape of
// runtime row. `absent` and every `nonterminal` row are the cases the
// pre-TASK-1318 code answered by WRITING task_status with updated_by
// "spec_sync"; the terminal-conflict rows are the one case it already
// reported and must keep reporting.
//
// The four cases marked UNCHANGED BRANCH pass against the pre-1318 code
// too, because that branch is deliberately identical. They are here to
// bound the widening: drift must not start firing on agreement, and must
// not stop firing on the conflict it already reported.
const DRIFT_CASES: DriftCase[] = [
  {
    name: "rowless spec COMPLETE is not drift and creates no runtime row (pre-1318 wrote one)",
    taskId: "TASK-4101",
    specStatus: "COMPLETE",
    seed: null,
    expectDrift: false,
  },
  {
    name: "rowless spec VERIFIED is not drift and creates no runtime row (pre-1318 wrote one)",
    taskId: "TASK-4102",
    specStatus: "VERIFIED",
    seed: null,
    expectDrift: false,
  },
  {
    name: "rowless spec REJECTED is not drift and creates no runtime row (pre-1318 wrote one)",
    taskId: "TASK-4103",
    specStatus: "REJECTED",
    seed: null,
    expectDrift: false,
  },
  {
    name: "UNCHANGED BRANCH: an agreeing COMPLETE row is not drift and is left untouched",
    taskId: "TASK-4104",
    specStatus: "COMPLETE",
    seed: { status: "COMPLETE", updatedBy: "dispatch" },
    expectDrift: false,
  },
  {
    name: "UNCHANGED BRANCH: an agreeing REJECTED row is not drift and is left untouched",
    taskId: "TASK-4105",
    specStatus: "REJECTED",
    seed: { status: "REJECTED", updatedBy: "session_rejected" },
    expectDrift: false,
  },
  {
    name: "UNCHANGED BRANCH: a conflicting terminal row (REJECTED vs spec COMPLETE) still broadcasts drift",
    taskId: "TASK-4106",
    specStatus: "COMPLETE",
    seed: { status: "REJECTED", updatedBy: "session_rejected" },
    expectDrift: true,
  },
  {
    name: "UNCHANGED BRANCH: a conflicting terminal row (COMPLETE vs spec VERIFIED) still broadcasts drift",
    taskId: "TASK-4107",
    specStatus: "VERIFIED",
    seed: { status: "COMPLETE", updatedBy: "reconcile" },
    expectDrift: true,
  },
  {
    name: "a NONTERMINAL IN_PROGRESS row broadcasts drift and survives the terminal spec (pre-1318 overwrote it silently)",
    taskId: "TASK-4108",
    specStatus: "COMPLETE",
    seed: { status: "IN_PROGRESS", updatedBy: "dispatch" },
    expectDrift: true,
  },
  {
    name: "a NONTERMINAL READY row broadcasts drift and survives the terminal spec (pre-1318 overwrote it silently)",
    taskId: "TASK-4109",
    specStatus: "VERIFIED",
    seed: { status: "READY", updatedBy: "dispatch_stopped" },
    expectDrift: true,
  },
  {
    name: "a NONTERMINAL BACKLOG row broadcasts drift and survives the terminal spec (pre-1318 overwrote it silently)",
    taskId: "TASK-4110",
    specStatus: "REJECTED",
    seed: { status: "BACKLOG", updatedBy: "dashboard" },
    expectDrift: true,
  },
  {
    name: "a NONTERMINAL BLOCKED row broadcasts drift and survives the terminal spec (pre-1318 overwrote it silently)",
    taskId: "TASK-4111",
    specStatus: "COMPLETE",
    seed: { status: "BLOCKED", updatedBy: "lifecycle" },
    expectDrift: true,
  },
];

// ─── Project-scoped wiring (src/monitor/server.ts, multi-project) ──

describe("TASK-1318 project-scoped watcher: the spec is observed, never propagated", () => {
  let projectRoot = "";
  let taskDirAbs = "";
  let stopServer: (() => Promise<void>) | null = null;
  let db: QuackDB | NoopDB;
  let watcher: ProcessableWatcher;
  let broadcasts: QuackEvent[] = [];

  beforeAll(async () => {
    projectRoot = makeTempDir();
    setupProjectDirectory(projectRoot, "Spec Drift Fixture");
    taskDirAbs = path.join(projectRoot, "docs", "tasks");

    const server = createMonitorServer({ port: 0, projectAdapters: [makeAdapter(projectRoot)] });
    broadcasts = recordBroadcasts(server.sse);
    const started = await server.start();
    stopServer = started.stop;

    const context = server.registry?.getProject("spec-drift-fixture");
    if (!context) throw new Error("project context was not registered");
    // Guard against a vacuous suite: a NoopDB answers `undefined` to every
    // read, which would make the rowless assertions pass for the wrong
    // reason.
    expect(context.dbState?.mode).toBe("sqlite");
    db = context.db;
    watcher = watcherOf(context);
  });

  afterAll(async () => {
    if (stopServer) await stopServer();
    stopServer = null;
    jest.restoreAllMocks();
    if (projectRoot) removeTempDir(projectRoot);
  });

  it.each(DRIFT_CASES.map((c): [string, DriftCase] => [c.name, c]))(
    "%s",
    async (_name, testCase) => {
      if (testCase.seed) {
        db.setStatus(testCase.taskId, testCase.seed.status, testCase.seed.updatedBy);
      }
      const before = db.getStatus(testCase.taskId);
      expect(before?.status).toBe(testCase.seed?.status);
      expect(before?.updated_by).toBe(testCase.seed?.updatedBy);

      const filePath = writeSpec(taskDirAbs, testCase.taskId, testCase.specStatus);
      await watcher.processFile(filePath);

      // 1. The OBSERVATION. Drift fires whenever the terminal spec claim
      //    differs from an existing row, including the nonterminal
      //    disagreements the pre-1318 callback answered with a silent write.
      const drift = driftEventsFor(broadcasts, testCase.taskId);
      if (testCase.expectDrift) {
        expect(drift.length).toBeGreaterThanOrEqual(1);
        expect(driftPayload(drift[0])).toEqual({
          taskId: testCase.taskId,
          specStatus: testCase.specStatus,
          dbStatus: testCase.seed?.status,
        });
      } else {
        expect(drift).toEqual([]);
      }

      // 2. The RETIREMENT. Whatever the spec claims, the runtime row is
      //    exactly what it was: unchanged when it existed, still absent
      //    when it did not.
      const after = db.getStatus(testCase.taskId);
      if (testCase.seed === null) {
        expect(after).toBeUndefined();
      } else {
        expect(after?.status).toBe(testCase.seed.status);
        expect(after?.updated_by).toBe(testCase.seed.updatedBy);
      }
    },
  );

  it("no runtime row anywhere carries spec_sync provenance after the whole matrix", async () => {
    // The retirement stated as provenance rather than as a source grep:
    // drive one more of each shape, then look at what actually landed in
    // task_status. Pre-1318 this table held `spec_sync` rows for the
    // rowless and nonterminal cases.
    db.setStatus("TASK-4131", "IN_PROGRESS", "dispatch");
    await watcher.processFile(writeSpec(taskDirAbs, "TASK-4131", "COMPLETE"));
    await watcher.processFile(writeSpec(taskDirAbs, "TASK-4132", "VERIFIED"));

    const rows = db.getAllStatuses();
    expect(rows.filter((r) => r.updated_by === "spec_sync")).toEqual([]);
    // And the spec-only task never entered the store at all.
    expect(rows.map((r) => r.task_id)).not.toContain("TASK-4132");
  });

  it("a nonterminal row keeps its provenance and previous_status through repeated spec observations", async () => {
    // Idempotence of the retirement. Pre-1318 the first observation wrote
    // the row (previous_status IN_PROGRESS, updated_by spec_sync) and the
    // second returned early as "idempotent", so the row drifted once and
    // then looked settled. Now nothing moves, and every observation is
    // still reported.
    db.setStatus("TASK-4141", "IN_PROGRESS", "dispatch");
    const seeded = db.getStatus("TASK-4141");
    const filePath = writeSpec(taskDirAbs, "TASK-4141", "COMPLETE");

    await watcher.processFile(filePath);
    await watcher.processFile(filePath);

    expect(driftEventsFor(broadcasts, "TASK-4141").length).toBeGreaterThanOrEqual(2);
    const after = db.getStatus("TASK-4141");
    expect(after?.status).toBe("IN_PROGRESS");
    expect(after?.updated_by).toBe("dispatch");
    expect(after?.updated_at).toBe(seeded?.updated_at);
    expect(after?.previous_status).toBe(seeded?.previous_status);
  });

  it("a NONTERMINAL row wins over a later terminal spec edit, which is the accepted semantics", async () => {
    // TASK-1318's narrowed availability criterion, from the DB's side: a
    // live dispatch outranks a markdown claim. Pinned as intended rather
    // than discovered later as a surprise.
    db.setStatus("TASK-4151", "IN_PROGRESS", "dispatch");
    await watcher.processFile(writeSpec(taskDirAbs, "TASK-4151", "COMPLETE"));
    expect(db.getStatus("TASK-4151")?.status).toBe("IN_PROGRESS");

    // And the other half of that criterion: a task whose ONLY completion
    // signal is its spec file leaves the store silent, so every DB-first
    // reader still reaches its spec fallback and the task still unblocks
    // its dependents.
    await watcher.processFile(writeSpec(taskDirAbs, "TASK-4152", "COMPLETE"));
    expect(db.getStatus("TASK-4152")).toBeUndefined();
  });
});

// ─── Legacy single-project wiring (src/monitor/server.ts) ──────────

describe("TASK-1318 legacy watcher: the same contract, end to end through chokidar", () => {
  // The legacy watcher handle is not exposed on the MonitorServer object,
  // so this leg drives the real file watcher instead of calling
  // processFile: write a spec into the watched directory and wait.
  let projectRoot = "";
  let stopServer: (() => Promise<void>) | null = null;
  let broadcasts: QuackEvent[] = [];
  /** Reopened after the monitor stops, so the assertions read what it left. */
  let finalDb: QuackDB | null = null;

  beforeAll(async () => {
    projectRoot = makeTempDir();
    setupProjectDirectory(projectRoot, "Legacy Drift Fixture");

    // Seed before the monitor opens the DB so there is exactly one writer
    // at a time; the assertions read the file back after the server stops.
    const seed = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    seed.setStatus("TASK-4201", "IN_PROGRESS", "dispatch");
    seed.close();

    const server = createMonitorServer({
      port: 0,
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
    });
    broadcasts = recordBroadcasts(server.sse);
    const started = await server.start();
    stopServer = started.stop;

    // ignoreInitial is on, so both files must be created after start().
    const taskDirAbs = path.join(projectRoot, "docs", "tasks");
    writeSpec(taskDirAbs, "TASK-4201", "COMPLETE"); // conflicts with the seeded row
    writeSpec(taskDirAbs, "TASK-4202", "COMPLETE"); // no row at all

    await waitFor(
      () =>
        discoveredFor(broadcasts, "TASK-4201").length > 0 &&
        discoveredFor(broadcasts, "TASK-4202").length > 0,
      60_000,
      "the legacy task watcher to process both fixture specs",
    );
    // onTerminalStatus runs synchronously right after onNewTask, so the
    // decision is already made; this is belt and braces.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Stop here so the assertions can reopen the DB file without racing
    // the monitor's own handle, and so no test depends on another's order.
    await started.stop();
    stopServer = null;
    finalDb = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
  });

  afterAll(async () => {
    if (finalDb) finalDb.close();
    finalDb = null;
    if (stopServer) await stopServer();
    stopServer = null;
    jest.restoreAllMocks();
    if (projectRoot) removeTempDir(projectRoot);
  });

  it("reports the nonterminal disagreement and leaves the row alone", () => {
    const drift = driftEventsFor(broadcasts, "TASK-4201");
    expect(drift.length).toBeGreaterThanOrEqual(1);
    expect(driftPayload(drift[0])).toEqual({
      taskId: "TASK-4201",
      specStatus: "COMPLETE",
      dbStatus: "IN_PROGRESS",
    });
    const row = finalDb?.getStatus("TASK-4201");
    expect(row?.status).toBe("IN_PROGRESS");
    expect(row?.updated_by).toBe("dispatch");
  });

  it("treats the rowless spec as the ordinary fallback state: no drift, and no row invented", () => {
    expect(driftEventsFor(broadcasts, "TASK-4202")).toEqual([]);
    expect(finalDb?.getStatus("TASK-4202")).toBeUndefined();
  });

  it("wrote nothing with spec_sync provenance", () => {
    expect(finalDb?.getAllStatuses().filter((r) => r.updated_by === "spec_sync")).toEqual([]);
  });
});
