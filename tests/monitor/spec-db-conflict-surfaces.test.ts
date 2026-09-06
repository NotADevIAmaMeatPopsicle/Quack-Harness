// ─── TASK-1318 S4: the spec/DB conflict surfaces ────────────────────
// Behavioral pins for the four eligibility surfaces TASK-1318 routes:
// triage, backlog hygiene, auto-prep scheduling and template
// eligibility.
//
// WHY THIS FILE EXISTS AT ALL. Round-2 F7 found the previous pins
// grepped the shipped source for predicate NAMES and counted string
// occurrences. Every one of them passed while the central defect (a
// modernized predicate fed a RAW SPEC input) was still present, which
// is the definition of a test that cannot fail. So every test here
// builds a real project on disk, writes a real `task_status` row that
// CONTRADICTS the markdown, calls the real entry point, and asserts on
// the decision that came out.
//
// Each test carries its own CONTROL: a task with the same spec line and
// NO runtime row. The control is what stops the conflicting assertion
// from being satisfied by a blunt fix (deciding nothing is done, or
// suppressing nothing at all), and it is also the availability pin the
// task's narrowed success criterion asks for. A task whose only
// completion signal is its spec file must keep behaving exactly as it
// did.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Triage shells out to git for merge evidence, and its projection
// hygiene check shells out for tracked-file state. Neither is under
// test, and a temp directory is not a repository, so both are stubbed
// to their "no repository" answers. `requireActual` is spread first so
// that nothing else in the import graph loses a function it needs.
const mockExecSync = jest.fn((): string => "");
const mockExecFileSync = jest.fn((): string => {
  throw Object.assign(new Error("not a git repository"), {
    status: 128,
    stderr: "fatal: not a git repository",
  });
});

jest.mock("node:child_process", () => ({
  ...jest.requireActual<Record<string, unknown>>("node:child_process"),
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

import { isTaskSuppressedFromAutomation } from "../../src/core/task-hygiene.js";
import {
  loadTaskStateOverlay,
  resolveTaskStateWithOverlay,
} from "../../src/core/task-state-overlay.js";
import { QuackDB } from "../../src/db/quack-db.js";
import { PrepScheduler } from "../../src/monitor/prep-scheduler.js";
import { computeTriage } from "../../src/monitor/routes/triage.js";
import { TaskService } from "../../src/monitor/task-service.js";
import type { TaskSummary } from "../../src/monitor/task-service.js";
import type { PrepCache } from "../../src/monitor/prep-cache.js";
import type { PrepJob, PrepWorker } from "../../src/monitor/prep-worker.js";
import type { AutoPrepConfig } from "../../src/core/types.js";
import {
  buildRegistry,
  loadRegistry,
  updateRegistry,
} from "../../src/templates/template-registry.js";

// ─── Fixtures ───────────────────────────────────────────────────────

let projectRoot: string;
let extraRoots: string[] = [];

/** A project directory with the standard layout and no runtime store. */
function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1318-conflict-"));
  fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
  return root;
}

/** A second project root for the same test, so one assertion can compare
 *  a project WITH runtime rows against one that has never dispatched. */
function makeBareProjectRoot(): string {
  const root = makeProjectRoot();
  extraRoots.push(root);
  return root;
}

beforeEach(() => {
  projectRoot = makeProjectRoot();
  extraRoots = [];
});

afterEach(() => {
  for (const root of [projectRoot, ...extraRoots]) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a sqlite handle briefly after close. A leftover
      // temp directory must never fail the suite.
    }
  }
});

interface SpecOptions {
  id: string;
  status: string;
  title?: string;
  tags?: string[];
  supersededBy?: string[];
  parentTask?: string;
}

/**
 * One spec shape that satisfies every parser in this file: triage's
 * directory scan, `TaskService.parseAllTasks` and the template
 * registry's per-file parse all call `parseTaskFile`.
 *
 * `Parent Task:` is written as a plain body line rather than a bolded
 * metadata bullet because `parseParentTaskId` matches
 * /Parent\s+Task:\s*(TASK-\d+)/ against the raw file, and the `**`
 * closing a bold metadata bullet sits between the colon and the id.
 */
function writeSpec(options: SpecOptions, root = projectRoot): void {
  const title = options.title ?? `Conflict fixture ${options.id}`;
  const tags = options.tags ?? ["dashboard"];
  const superseded = options.supersededBy ?? [];
  const supersededLine =
    superseded.length > 0 ? `- **Superseded By:** [${superseded.join(", ")}]\n` : "";
  const parentLine = options.parentTask ? `Parent Task: ${options.parentTask}\n\n` : "";

  const content = `# ${options.id}: ${title}

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 4 hours
- **Status:** ${options.status}
- **Blocked By:** []
- **Blocks:** []
- **Tags:** [${tags.join(", ")}]
${supersededLine}
## Problem Statement
${parentLine}Fixture for the TASK-1318 spec/DB conflict pins.

## Current State
Fixture.

## Recommended Approach
Fixture.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/fixture.ts | Create | Fixture |

## Success Criteria
- [ ] Fixture criterion

## Testing Requirements
- [ ] Fixture requirement
`;

  fs.writeFileSync(path.join(root, "docs", "tasks", `${options.id}.md`), content, "utf-8");
}

/**
 * Write real `task_status` rows through the real QuackDB, then close so
 * the WAL is checkpointed and the read-only overlay open sees them.
 *
 * `updated_by` is "worker" throughout: TASK-1318 S1 retired the
 * `spec_sync` writer, so a row that exists is a row some runtime stage
 * wrote, and labelling these fixtures otherwise would describe a
 * provenance the code can no longer produce.
 */
function writeRuntimeStatuses(rows: Record<string, string>, root = projectRoot): void {
  const db = new QuackDB(path.join(root, ".quack", "quack.db"));
  try {
    for (const [taskId, status] of Object.entries(rows)) {
      db.setStatus(taskId, status, "worker");
    }
  } finally {
    db.close();
  }
}

function writeVerifiedJson(
  tasks: Record<string, { verified: string; method: string; verdict: string }>,
): void {
  fs.writeFileSync(
    path.join(projectRoot, ".quack", "verified.json"),
    JSON.stringify({ tasks }),
    "utf-8",
  );
}

function writeSessionHistory(entries: Array<{ taskId: string; outcome: string }>): void {
  const logsDir = path.join(projectRoot, ".quack", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const lines = entries.map((entry) =>
    JSON.stringify({
      taskId: entry.taskId,
      sessionId: `session-${entry.taskId}`,
      outcome: entry.outcome,
      costUsd: 4,
      turnsUsed: 9,
      retriesUsed: 0,
      taskTags: ["dashboard"],
      targetFiles: ["src/fixture.ts"],
      criteriaResults: [],
      feedbackThemes: [],
      gateScore: 4.8,
      complexity: { filesToModify: 1, successCriteria: 1 },
    }),
  );
  fs.writeFileSync(path.join(logsDir, "sessions.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

type TriageResult = Awaited<ReturnType<typeof computeTriage>>;

function categoryIds(result: TriageResult, name: string): string[] {
  const category = result.categories.find((entry) => entry.name === name);
  if (!category) throw new Error(`triage produced no ${name} category`);
  return category.tasks.map((task) => task.id);
}

function triageTask(
  result: TriageResult,
  id: string,
): TriageResult["categories"][number]["tasks"][number] {
  for (const category of result.categories) {
    const found = category.tasks.find((task) => task.id === id);
    if (found) return found;
  }
  throw new Error(`triage produced no task ${id}`);
}

function summaryOf(
  result: TriageResult,
  id: string,
): { id: string; complete: number; total: number; allComplete: boolean } {
  const parent = result.parentTasks.find((entry) => entry.id === id);
  if (!parent) throw new Error(`triage produced no parent rollup for ${id}`);
  return {
    id: parent.id,
    complete: parent.subtasksComplete,
    total: parent.subtasksTotal,
    allComplete: parent.allComplete,
  };
}

// ─── Triage ─────────────────────────────────────────────────────────

describe("triage classifies from the runtime store, not the markdown", () => {
  test("a spec READY line with a runtime COMPLETE row is not offered as READY work", async () => {
    writeSpec({ id: "TASK-1401", status: "READY" });
    writeSpec({ id: "TASK-1402", status: "READY" });
    // Only 1401 conflicts. 1402 is the control: spec-only READY, which
    // must keep being offered exactly as it always was.
    writeRuntimeStatuses({ "TASK-1401": "COMPLETE" });

    const result = await computeTriage(projectRoot);

    expect(categoryIds(result, "READY")).toEqual(["TASK-1402"]);
    expect(categoryIds(result, "COMPLETE_UNVERIFIED")).toEqual(["TASK-1401"]);
    expect(result.summary.ready).toBe(1);
    expect(result.summary.completeUnverified).toBe(1);

    // The raw markdown line is still reported, so an operator can see
    // what the file claims. It just no longer decides anything.
    expect(triageTask(result, "TASK-1401").status).toBe("READY");
    expect(triageTask(result, "TASK-1401").resolvedStatus).toBe("COMPLETE");
    expect(triageTask(result, "TASK-1401").statusAuthority).toBe("runtime");
    expect(triageTask(result, "TASK-1402").statusAuthority).toBe("spec");
    expect(result.taskStateOverlay.degraded).toBe(false);
    expect(result.taskStateOverlay.source).toBe("loaded");
  });

  test("a spec COMPLETE line with a runtime IN_PROGRESS row is not reported complete, even with a verified.json entry", async () => {
    writeSpec({ id: "TASK-1403", status: "COMPLETE" });
    writeSpec({ id: "TASK-1404", status: "COMPLETE" });
    writeRuntimeStatuses({ "TASK-1403": "IN_PROGRESS" });
    // Both carry a VERIFIED cross-reference. The verified register is
    // evidence, not authority, so it must not rescue 1403 into the
    // VERIFIED bucket while the store says the work is still running.
    writeVerifiedJson({
      "TASK-1403": { verified: "2026-08-07", method: "admin-9-phase", verdict: "VERIFIED" },
      "TASK-1404": { verified: "2026-08-07", method: "admin-9-phase", verdict: "VERIFIED" },
    });

    const result = await computeTriage(projectRoot);

    expect(categoryIds(result, "IN_PROGRESS")).toEqual(["TASK-1403"]);
    expect(categoryIds(result, "VERIFIED")).toEqual(["TASK-1404"]);
    expect(categoryIds(result, "COMPLETE_UNVERIFIED")).toEqual([]);
    expect(result.summary.inProgress).toBe(1);
    expect(result.summary.verified).toBe(1);
    expect(result.summary.completeUnverified).toBe(0);
  });

  test("parent rollups count subtasks from the store, in both directions", async () => {
    writeSpec({ id: "TASK-1410", status: "IN_PROGRESS", title: "Parent one" });
    writeSpec({ id: "TASK-1411", status: "COMPLETE", parentTask: "TASK-1410" });
    writeSpec({ id: "TASK-1412", status: "COMPLETE", parentTask: "TASK-1410" });

    writeSpec({ id: "TASK-1415", status: "IN_PROGRESS", title: "Parent two" });
    writeSpec({ id: "TASK-1416", status: "READY", parentTask: "TASK-1415" });

    // Parent one: 1411's markdown claims COMPLETE while the store still
    // has it running, so the parent is 1 of 2 rather than 2 of 2.
    // Parent two: 1416's markdown says READY while the store holds
    // VERIFIED, so the parent is 1 of 1 rather than 0 of 1.
    writeRuntimeStatuses({ "TASK-1411": "IN_PROGRESS", "TASK-1416": "VERIFIED" });

    const result = await computeTriage(projectRoot);

    expect(summaryOf(result, "TASK-1410")).toEqual({
      id: "TASK-1410",
      complete: 1,
      total: 2,
      allComplete: false,
    });
    expect(summaryOf(result, "TASK-1415")).toEqual({
      id: "TASK-1415",
      complete: 1,
      total: 1,
      allComplete: true,
    });

    // The same rule, read off the parent's own triage row.
    expect(triageTask(result, "TASK-1410").subtaskProgress).toEqual({
      total: 2,
      complete: 1,
      allComplete: false,
    });
    expect(triageTask(result, "TASK-1415").subtaskProgress).toEqual({
      total: 1,
      complete: 1,
      allComplete: true,
    });
  });
});

// ─── Backlog hygiene ────────────────────────────────────────────────

function taskById(tasks: TaskSummary[], id: string): TaskSummary {
  const found = tasks.find((task) => task.id === id);
  if (!found) throw new Error(`listTasks produced no task ${id}`);
  return found;
}

describe("status hygiene evaluates the resolved status, closing the suppression back door", () => {
  test("a spec REJECTED or ON_HOLD line cannot suppress a task the store says is live", async () => {
    writeSpec({ id: "TASK-1420", status: "REJECTED" });
    writeSpec({ id: "TASK-1421", status: "ON_HOLD" });
    writeSpec({ id: "TASK-1422", status: "REJECTED" });
    writeSpec({ id: "TASK-1423", status: "BACKLOG", supersededBy: ["TASK-1499"] });
    // 1420 and 1421 conflict. 1422 is the suppression control (spec-only
    // REJECTED must stay suppressed). 1423 has a live BACKLOG row and is
    // the STRUCTURAL control: supersession is intrinsic to the spec file,
    // so no runtime row may rescue it.
    writeRuntimeStatuses({
      "TASK-1420": "BACKLOG",
      "TASK-1421": "READY",
      "TASK-1423": "BACKLOG",
    });

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    let tasks: TaskSummary[];
    let excluded: string[];
    try {
      const service = new TaskService(projectRoot, "docs/tasks");
      const result = await service.listTasks(undefined, undefined, db);
      tasks = result.tasks;
      excluded = (result.hygiene?.excludedCandidates ?? []).map((row) => row.taskId);
    } finally {
      db.close();
    }

    // The back door: markdown said REJECTED, the store said BACKLOG.
    expect(taskById(tasks, "TASK-1420").backlogHygiene?.dispatchBlocked).toBe(false);
    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1420"))).toBe(false);
    expect(taskById(tasks, "TASK-1421").backlogHygiene?.dispatchBlocked).toBe(false);
    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1421"))).toBe(false);

    // Controls: spec-only REJECTED still suppressed, supersession still
    // suppressed and still for the structural reason.
    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1422"))).toBe(true);
    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1423"))).toBe(true);
    expect(
      taskById(tasks, "TASK-1423").backlogHygiene?.reasons.map((reason) => reason.code),
    ).toEqual(["superseded"]);

    expect(excluded).toEqual(["TASK-1422", "TASK-1423"]);
  });

  test("a runtime REJECTED row suppresses a task whose markdown still reads BACKLOG, and the report names the status that caused it", async () => {
    writeSpec({ id: "TASK-1430", status: "BACKLOG" });
    writeSpec({ id: "TASK-1431", status: "BACKLOG" });
    writeRuntimeStatuses({ "TASK-1430": "REJECTED" });

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    let tasks: TaskSummary[];
    let excluded: Array<{ taskId: string; status: string; codes: string[] }>;
    try {
      const service = new TaskService(projectRoot, "docs/tasks");
      const result = await service.listTasks(undefined, undefined, db);
      tasks = result.tasks;
      excluded = (result.hygiene?.excludedCandidates ?? []).map((row) => ({
        taskId: row.taskId,
        status: row.status,
        codes: row.reasons.map((reason) => reason.code),
      }));
    } finally {
      db.close();
    }

    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1430"))).toBe(true);
    // Control: identical markdown, no runtime row, still eligible.
    expect(isTaskSuppressedFromAutomation(taskById(tasks, "TASK-1431"))).toBe(false);

    // The exclusion row must explain itself with the value the decision
    // was made on. Reporting BACKLOG here would describe the row with a
    // status that did not cause it.
    expect(excluded).toEqual([
      { taskId: "TASK-1430", status: "REJECTED", codes: ["status_rejected"] },
    ]);

    // Hygiene and the projection answer from the same resolved value, so
    // they cannot contradict each other for one task.
    expect(taskById(tasks, "TASK-1430").effectiveStatus).toBe("REJECTED");
    expect(taskById(tasks, "TASK-1430").status).toBe("BACKLOG");
  });
});

// ─── Auto-prep scheduling ───────────────────────────────────────────

// ROUND-3 F2 REWRITE. The previous harness stubbed `listTasks` to
// return hand-built summaries whose `backlogHygiene` was hardcoded
// `{ dispatchBlocked: false }`, and let the scheduler open its own
// overlay from a `projectRoot`. Both halves of that are what hid the
// defect:
//
//   - Hardcoding hygiene to never block deleted the failing case. In
//     production `listTasks()` was called with NO database, so hygiene
//     came back SPEC-derived, and a task whose runtime row said BACKLOG
//     under a REJECTED markdown line passed the routed predicate and was
//     then suppressed by hygiene anyway. The spec still decided.
//   - Two independent resolutions of one question, the scheduler's
//     overlay and the projection's, could disagree; the harness only
//     ever exercised one of them.
//
// So the harness now uses the REAL `TaskService` over the REAL spec
// files with the REAL store handed in, which is the production wiring.
// Nothing about eligibility is supplied by the test except the files and
// the rows.

interface PrepHarness {
  scheduler: PrepScheduler;
  queue(): string[];
}

function makePrepHarness(
  root: string,
  db: QuackDB | undefined,
  config?: Partial<AutoPrepConfig>,
): PrepHarness {
  const runningElsewhere: PrepJob = {
    taskId: "TASK-OTHER",
    pid: 4242,
    startedAt: new Date().toISOString(),
    status: "running",
  };

  const worker = {
    start: jest.fn(),
    getActiveJob: jest.fn(() => undefined),
    // One job already running against a maxConcurrent of 1 parks the
    // scheduler at its concurrency limit before it dequeues anything, so
    // the queue it built is observable in full.
    getActiveJobs: jest.fn(() => [runningElsewhere]),
    getJob: jest.fn(() => undefined),
    killAll: jest.fn(),
  };
  const cache = {
    exists: jest.fn(() => false),
    read: jest.fn(() => Promise.resolve(null)),
    invalidate: jest.fn(() => Promise.resolve(false)),
  };
  const scheduler = new PrepScheduler(
    worker as unknown as PrepWorker,
    cache as unknown as PrepCache,
    new TaskService(root, "docs/tasks"),
    {
      enabled: true,
      maxConcurrent: 1,
      cooldownSeconds: 30,
      maxPerHour: 100,
      maxBudgetPerHour: 10,
      priorityOrder: "priority_then_id",
      skipPrepped: false,
      ...config,
    },
    undefined,
    { db },
  );

  return { scheduler, queue: () => scheduler.getQueue() };
}

/**
 * Each test below asks the SAME question twice: once against a store
 * holding the conflicting rows, and once against a store that has
 * nothing to say about those tasks.
 *
 * The second pass is the availability pin the task's narrowed success
 * criterion asks for (a silent store must change nothing), and it is
 * what makes the pair impossible to satisfy by failing closed: any fix
 * that decides from something other than the rows themselves moves one
 * of the two answers.
 */
describe("auto-prep decides eligibility from the runtime store", () => {
  const harnesses: PrepHarness[] = [];
  const openDbs: QuackDB[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.scheduler.stop();
    for (const db of openDbs.splice(0)) {
      try {
        db.close();
      } catch {
        // Already closed. A teardown failure must never fail the suite.
      }
    }
    jest.useRealTimers();
  });

  /** The live handle the production wiring hands the scheduler. */
  function openStore(root: string): QuackDB {
    const db = new QuackDB(path.join(root, ".quack", "quack.db"));
    openDbs.push(db);
    return db;
  }

  async function queueFor(root: string, db: QuackDB | undefined): Promise<string[]> {
    const harness = makePrepHarness(root, db);
    harnesses.push(harness);
    await harness.scheduler.start();
    return harness.queue();
  }

  test("finished work is skipped even when the markdown still says READY", async () => {
    for (const id of ["TASK-1440", "TASK-1441", "TASK-1442"]) {
      writeSpec({ id, status: "READY" });
    }
    writeRuntimeStatuses({ "TASK-1440": "COMPLETE", "TASK-1441": "REJECTED" });

    // 1440 is finished. 1441 is REJECTED, which IS finished for this
    // question, and its spec line of READY means backlog hygiene cannot
    // catch it: only the routed predicate can. 1442 has no row.
    expect(await queueFor(projectRoot, openStore(projectRoot))).toEqual(["TASK-1442"]);

    // Same three READY spec lines against a store that has never
    // recorded them: all three are prepped. The exclusions above came
    // from the rows and from nothing else.
    const bare = makeBareProjectRoot();
    for (const id of ["TASK-1440", "TASK-1441", "TASK-1442"]) {
      writeSpec({ id, status: "READY" }, bare);
    }
    expect(await queueFor(bare, openStore(bare))).toEqual(["TASK-1440", "TASK-1441", "TASK-1442"]);
  });

  test("a task the store re-opened is prepped again despite a COMPLETE markdown line", async () => {
    writeSpec({ id: "TASK-1443", status: "COMPLETE" });
    writeSpec({ id: "TASK-1444", status: "COMPLETE" });
    writeRuntimeStatuses({ "TASK-1443": "READY" });

    // The store, not the markdown, decides in BOTH directions.
    expect(await queueFor(projectRoot, openStore(projectRoot))).toEqual(["TASK-1443"]);

    // With a silent store, the COMPLETE spec lines are the whole answer
    // again and neither task is prepped.
    const bare = makeBareProjectRoot();
    writeSpec({ id: "TASK-1443", status: "COMPLETE" }, bare);
    writeSpec({ id: "TASK-1444", status: "COMPLETE" }, bare);
    expect(await queueFor(bare, openStore(bare))).toEqual([]);
  });

  // ─── The round-3 F2 case ──────────────────────────────────────────
  test("a REJECTED markdown line cannot suppress a task the store re-opened", async () => {
    writeSpec({ id: "TASK-1445", status: "REJECTED" });
    writeSpec({ id: "TASK-1446", status: "REJECTED" });
    writeRuntimeStatuses({ "TASK-1445": "BACKLOG" });

    // THE defect round-3 F2 names. Before the fix the routed predicate
    // correctly saw BACKLOG and let 1445 through, and then
    // `backlogHygiene` (computed by a `listTasks()` call made with no
    // store, so still SPEC-derived) reported `status_rejected` and
    // suppressed it anyway. The markdown decided through a second door
    // after the front one had been closed.
    //
    // 1446 is the control: identical REJECTED markdown, no row, still
    // suppressed. That is what stops this from being satisfied by simply
    // dropping the hygiene check.
    expect(await queueFor(projectRoot, openStore(projectRoot))).toEqual(["TASK-1445"]);
  });

  test("an ON_HOLD row suppresses a task whose markdown says READY", async () => {
    writeSpec({ id: "TASK-1447", status: "READY" });
    writeSpec({ id: "TASK-1448", status: "READY" });
    writeRuntimeStatuses({ "TASK-1447": "ON_HOLD" });

    // The mirror direction, and the one the pre-round-3 code could not
    // reach at all: ON_HOLD is not terminal, so the routed predicate
    // does not exclude it and only hygiene can. With hygiene evaluated
    // from the spec line, a runtime hold was invisible to auto-prep.
    expect(await queueFor(projectRoot, openStore(projectRoot))).toEqual(["TASK-1448"]);
  });

  // ─── The two invariants the scheduler's comments assert ───────────
  // Cross-model round 4b would not confirm either from the scheduler
  // alone, correctly: both are claims ABOUT `listTasks`, and an
  // assertion in a comment is not evidence. Pinned here instead.

  test("effectiveStatus from a db-backed listTasks IS the overlay answer", async () => {
    // The scheduler dropped its own overlay read and now uses
    // `task.effectiveStatus`. That is only sound if the projection's
    // answer equals what the overlay would have given. It does, and the
    // reason is narrow enough to be worth pinning rather than trusting:
    // the scheduler passes NO sessions, so the session precedence entry
    // can never supply; and verification evidence rides along in the
    // result without supplying a status, because `TASK_STATE_AUTHORITIES`
    // deliberately has no "ledger" member. Add either and this fails.
    writeSpec({ id: "TASK-1460", status: "READY" });
    writeSpec({ id: "TASK-1461", status: "COMPLETE" });
    writeSpec({ id: "TASK-1462", status: "BACKLOG" });
    writeRuntimeStatuses({ "TASK-1460": "REJECTED", "TASK-1461": "READY" });

    const db = openStore(projectRoot);
    const { tasks } = await new TaskService(projectRoot, "docs/tasks").listTasks(
      undefined,
      undefined,
      db,
    );
    const { overlay } = loadTaskStateOverlay(projectRoot);

    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.effectiveStatus).toBe(
        resolveTaskStateWithOverlay({
          taskId: task.id,
          specStatus: task.status,
          overlay,
        }).status,
      );
    }
    // And the two really did move, so this is not vacuously true over
    // three tasks the store never touched.
    expect(taskById(tasks, "TASK-1460").effectiveStatus).toBe("REJECTED");
    expect(taskById(tasks, "TASK-1461").effectiveStatus).toBe("READY");
    expect(taskById(tasks, "TASK-1462").effectiveStatus).toBe("BACKLOG");
  });

  test("every summary from listTasks carries backlogHygiene", async () => {
    // `isTaskSuppressedFromAutomation` falls back to RAW spec status
    // when `backlogHygiene` is absent, which would reintroduce spec
    // authority through the back door round-3 F2 just closed. The
    // scheduler's comment claims that branch is unreachable for
    // `listTasks` output. It is: `parseAllTasks` pushes to `tasks` and
    // `taskSources` in the same block, so every parsed task has a
    // structural entry, and `applyResolvedStatusHygiene` copies that map
    // before folding. Claimed is not pinned, so here it is pinned.
    writeSpec({ id: "TASK-1465", status: "READY" });
    writeSpec({ id: "TASK-1466", status: "ON_HOLD" });
    writeSpec({ id: "TASK-1467", status: "REJECTED", supersededBy: ["TASK-1465"] });
    writeRuntimeStatuses({ "TASK-1466": "READY" });

    for (const db of [openStore(projectRoot), undefined]) {
      const { tasks } = await new TaskService(projectRoot, "docs/tasks").listTasks(
        undefined,
        undefined,
        db,
      );
      expect(tasks).toHaveLength(3);
      for (const task of tasks) {
        expect(task.backlogHygiene).toBeDefined();
      }
    }
  });

  test("no store at all is a wiring defect, and it says so out loud", async () => {
    writeSpec({ id: "TASK-1449", status: "READY" });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Spec-only, exactly as before: the task is still prepped. What
      // must not happen is silence, because from the outside a
      // spec-only pass is indistinguishable from a routed one.
      expect(await queueFor(projectRoot, undefined)).toEqual(["TASK-1449"]);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
        /prep-scheduler.*no runtime store/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Template eligibility ───────────────────────────────────────────

describe("template eligibility is decided by the runtime store", () => {
  test("a run the store rejected is never mined as a template, whatever its markdown says", async () => {
    writeSpec({ id: "TASK-1450", status: "COMPLETE" });
    writeSpec({ id: "TASK-1451", status: "COMPLETE" });
    writeRuntimeStatuses({ "TASK-1450": "REJECTED" });
    writeSessionHistory([
      { taskId: "TASK-1450", outcome: "approved" },
      { taskId: "TASK-1451", outcome: "approved" },
    ]);

    const registry = await buildRegistry(projectRoot);

    // 1451 is the control: identical markdown and identical history, no
    // runtime row, still a template.
    expect(registry.templates.map((template) => template.sourceTaskId)).toEqual(["TASK-1451"]);
  });

  test("updateRegistry refuses a rejected run, names the authority, and writes nothing", async () => {
    writeSpec({ id: "TASK-1450", status: "COMPLETE" });
    writeRuntimeStatuses({ "TASK-1450": "REJECTED" });
    writeSessionHistory([{ taskId: "TASK-1450", outcome: "approved" }]);

    await expect(updateRegistry(projectRoot, "TASK-1450")).rejects.toThrow(
      /TASK-1450 is not COMPLETE/,
    );
    // The operator reads COMPLETE in the markdown, so the refusal has to
    // say where the contradicting answer came from or it looks like the
    // spec file was misread.
    await expect(updateRegistry(projectRoot, "TASK-1450")).rejects.toThrow(/REJECTED/);
    await expect(updateRegistry(projectRoot, "TASK-1450")).rejects.toThrow(/runtime/);

    const onDisk = await loadRegistry(projectRoot);
    expect(onDisk.templates).toEqual([]);
  });

  test("a run the store completed is admitted even after the markdown was edited to REJECTED", async () => {
    writeSpec({ id: "TASK-1452", status: "REJECTED" });
    writeSpec({ id: "TASK-1453", status: "REJECTED" });
    writeRuntimeStatuses({ "TASK-1452": "COMPLETE" });
    writeSessionHistory([
      { taskId: "TASK-1452", outcome: "approved" },
      { taskId: "TASK-1453", outcome: "approved" },
    ]);

    const registry = await buildRegistry(projectRoot);

    // This is the anti-gaming half of the pair above. Hardcoding a
    // spec-side REJECTED veto would satisfy the previous test and fail
    // this one: routing means the store answers, not that one more
    // markdown value gets special treatment. 1453 is the control and
    // stays out on its spec line alone.
    expect(registry.templates.map((template) => template.sourceTaskId)).toEqual(["TASK-1452"]);
  });
});
