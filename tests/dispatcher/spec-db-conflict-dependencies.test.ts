// ─── TASK-1318 S2: the dependency-deciding paths, under spec/DB conflict ──
//
// The defect this suite exists to catch is narrow and specific. TASK-1318
// round 2 found five readers whose PREDICATE had been modernized
// (`=== "COMPLETE"` became `isCompleteStatus`) while their INPUT stayed
// the raw spec `Status:` line. A conflicting `task_status` row was still
// ignored, so nothing about authority had actually moved. Round-2 F7 then
// found that the tests written to pin that work greped source files for
// predicate names and counted string occurrences, so every one of them
// passed while the defect was fully present.
//
// This suite therefore does the opposite. Every test builds a REAL project
// on disk (spec markdown plus a real `.quack/quack.db` holding real
// `task_status` rows), drives a REAL exported entry point, and asserts on
// the decision that entry point returns. Nothing here reads source text.
//
// Two entry points cover the three assigned sites:
//
//   - `runPostApprovalLifecycle` reaches the blocker pass (step 4) and the
//     parent-rollup subtask pass (step 5). Both are dependency questions,
//     so both must use `isCompleteStatus` over the RESOLVED status.
//   - `runOvernightRunner` with `maxCycles: 0` runs the inventory pass and
//     stops before the dispatch loop. That pass is exactly the code under
//     test: `areParsedDependenciesSatisfied` (dependency eligibility) and
//     `initialStatusForInventory` (own-task skip). No monitor, no network,
//     no git.
//
// The distinction that must never erode: a REJECTED task IS finished as
// work, so the own-task skip counts it, and a REJECTED DEPENDENCY must
// NEVER satisfy its dependent, so the dependency sites do not.

import { describe, test, expect, afterAll, jest } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The lifecycle's step 6 shells out to git. Nothing in this suite is about
// committing, and a real `git add` against a temp directory is both slow
// and environment-dependent, so `execSync` returns empty and the commit
// step decides there is nothing staged. Everything else in child_process
// stays real, because the overnight runner promisifies `execFile` at
// module load.
jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>("node:child_process"),
  execSync: jest.fn(() => ""),
}));

// HOW THIS SUITE WAS PROVEN ABLE TO FAIL (round-2 F7 is the reason it
// needed proving). Every test below was re-run against a simulation of
// the exact pre-fix defect: `src/core/task-state-overlay.js` mocked so
// `loadTaskStateOverlay` returns an empty overlay and
// `resolveTaskStateWithOverlay` returns `resolveTaskState({ spec })`,
// which is precisely "predicate modernized, INPUT still raw spec".
// All 14 failed, each on the assertion that encodes the defect. To
// reproduce, paste this factory back in, run, and delete it again:
//
//   jest.mock("../../src/core/task-state-overlay.js", () => {
//     const state = jest.requireActual<
//       typeof import("../../src/core/task-state.js")
//     >("../../src/core/task-state.js");
//     const actual = jest.requireActual<
//       typeof import("../../src/core/task-state-overlay.js")
//     >("../../src/core/task-state-overlay.js");
//     return {
//       ...actual,
//       loadTaskStateOverlay: () => ({
//         overlay: new Map<string, string>(),
//         degraded: false,
//         source: "absent" as const,
//         dbPath: "",
//       }),
//       resolveTaskStateWithOverlay: (input: { specStatus: string }) =>
//         state.resolveTaskState({ spec: input.specStatus }),
//     };
//   });

import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import { parseTaskFile } from "../../src/core/task-parser.js";
import type { LifecycleResult, ParsedTask } from "../../src/core/types.js";
import { QuackDB } from "../../src/db/quack-db.js";
import { runPostApprovalLifecycle, _setQueryFn } from "../../src/dispatcher/lifecycle-manager.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";
import { runOvernightRunner } from "../../src/overnight/runner.js";
import type { OvernightRunCheckpoint, OvernightTaskRecord } from "../../src/overnight/types.js";

// ─── Project harness ────────────────────────────────────────────────

const TASK_DIR = "docs/tasks";
const tempRoots: string[] = [];

/** A real project root: adapter, task directory, nothing else. */
function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1318-conflict-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
  fs.mkdirSync(path.join(root, TASK_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".quack", "adapter.json"),
    JSON.stringify(
      {
        version: "1.0",
        project: {
          name: "spec-db-conflict",
          root: ".",
          taskDir: TASK_DIR,
          conventionsDir: ".quack",
        },
        verification: {
          commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
        },
        git: { commitFormat: "[{taskId}] {message}", commitTrailer: "" },
        logging: { dir: ".quack/logs" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return root;
}

interface TaskSpec {
  id: string;
  status: string;
  blockedBy?: string[];
  blocks?: string[];
  /** Written as a plain bullet: the lifecycle's parent regex is
   *  `Parent Task:\s*(TASK-\d+)`, which a bold `**` suffix would break. */
  parent?: string;
}

function writeTask(root: string, spec: TaskSpec): void {
  const parentLine = spec.parent ? `- Parent Task: ${spec.parent}\n` : "";
  const content = `# ${spec.id}: Conflict fixture

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 1-2 hours
- **Status:** ${spec.status}
- **Blocked By:** [${(spec.blockedBy ?? []).join(", ")}]
- **Blocks:** [${(spec.blocks ?? []).join(", ")}]
${parentLine}
## Problem Statement
Fixture for TASK-1318 spec/DB conflict coverage.

## Success Criteria
- [ ] Criterion one

## Testing Requirements
- [ ] Requirement one
`;
  fs.writeFileSync(path.join(root, TASK_DIR, `${spec.id}.md`), content, "utf-8");
}

/**
 * Write real `task_status` rows through the real QuackDB, so the overlay
 * reads a genuine store rather than a hand-built Map. `updatedBy` is
 * deliberately never "spec_sync": TASK-1318 retired that writer, and a
 * fixture that resurrected it would be testing the wrong world.
 */
function seedRuntimeStatus(root: string, rows: Record<string, string>): void {
  const db = new QuackDB(path.join(root, ".quack", "quack.db"));
  try {
    for (const [taskId, status] of Object.entries(rows)) {
      db.setStatus(taskId, status, "worker");
    }
  } finally {
    db.close();
  }
}

function parseTask(root: string, taskId: string): ParsedTask {
  const filePath = path.join(root, TASK_DIR, `${taskId}.md`);
  return parseTaskFile(fs.readFileSync(filePath, "utf-8"), filePath);
}

/** The spec `Status:` value as it stands on disk right now. */
function specStatusOnDisk(root: string, taskId: string): string {
  const content = fs.readFileSync(path.join(root, TASK_DIR, `${taskId}.md`), "utf-8");
  return content.match(/\*\*Status:\*\*\s*(\S+)/)?.[1] ?? "(none)";
}

// ─── Lifecycle harness ──────────────────────────────────────────────

interface RecordedEvent {
  stage: string;
  payload: unknown;
}

function makeEvents(taskId: string): {
  events: IEventWriter;
  recorded: RecordedEvent[];
} {
  const recorded: RecordedEvent[] = [];
  const events: IEventWriter = {
    sessionId: "spec-db-conflict",
    taskId,
    project: "spec-db-conflict",
    emit(stage, payload) {
      recorded.push({ stage, payload });
    },
    recordSession() {
      // No session ledger in this harness.
    },
  };
  return { events, recorded };
}

/**
 * Make the lifecycle's adversarial verification pass without an LLM, so
 * the run reaches step 3 (write COMPLETE to the spec) and then steps 4
 * and 5, which are the passes under test.
 */
function stubAdversarialPass(criteria: string[]): void {
  const text = [
    ...criteria.flatMap((criterion) => [
      `CRITERION: ${criterion}`,
      "STATUS: PASS",
      "EVIDENCE: seeded by the conflict harness",
      "",
    ]),
    "OVERALL: PASS",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async function* (): AsyncGenerator<
    { type: string; subtype?: string; result?: string },
    void
  > {
    yield { type: "result", subtype: "success", result: text };
  };
  _setQueryFn(query as unknown as Parameters<typeof _setQueryFn>[0]);
}

function makeAdapter(root: string): ProjectAdapter {
  return {
    projectRoot: root,
    config: {
      project: {
        name: "spec-db-conflict",
        root: ".",
        taskDir: TASK_DIR,
        conventionsDir: ".quack",
      },
      agent: {
        model: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 15,
        maxBudgetPerTask: 1,
        maxRetries: 0,
      },
      verification: { commands: [], conventionChecks: [] },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
      },
      logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
      sandbox: {
        writablePaths: [],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      revision: { maxBudget: 1, maxTurns: 5 },
    },
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
  } as unknown as ProjectAdapter;
}

/** Run the real post-approval lifecycle for one task in one project. */
async function runLifecycle(
  root: string,
  taskId: string,
): Promise<{ result: LifecycleResult; recorded: RecordedEvent[] }> {
  const task = parseTask(root, taskId);
  stubAdversarialPass(task.successCriteria);
  const { events, recorded } = makeEvents(taskId);
  const result = await runPostApprovalLifecycle(taskId, task, makeAdapter(root), root, events);
  return { result, recorded };
}

// ─── Overnight harness ──────────────────────────────────────────────

/**
 * Run the real overnight runner up to and including the inventory pass.
 *
 * `maxCycles: 0` skips the dispatch loop entirely (`while (cycles < 0…)`
 * never enters), so the run does the adapter load, the single batched
 * overlay read, `areParsedDependenciesSatisfied`, `mergeInventory` and
 * `initialStatusForInventory`, then halts. Those are exactly the two
 * decisions this suite is about, and nothing else runs: no monitor health
 * call, no dispatch, no HTTP. `dryRun` keeps the checkpoint out of the
 * project directory.
 */
async function runInventory(root: string, taskIds: string[]): Promise<OvernightRunCheckpoint> {
  return runOvernightRunner({
    projectRoot: root,
    taskIds,
    checkpointPath: path.join(root, ".quack", "overnight-checkpoint.json"),
    dryRun: true,
    maxCycles: 0,
    monitorUrl: "http://127.0.0.1:1",
    logger: () => undefined,
  });
}

function recordFor(checkpoint: OvernightRunCheckpoint, taskId: string): OvernightTaskRecord {
  const record = checkpoint.tasks.find((entry) => entry.taskId === taskId);
  if (!record) {
    throw new Error(
      `${taskId} is absent from the overnight inventory; the fixture is wrong, not the code`,
    );
  }
  return record;
}

// ─── Cleanup ────────────────────────────────────────────────────────

afterAll(() => {
  _setQueryFn(undefined as unknown as Parameters<typeof _setQueryFn>[0]);
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds sqlite handles briefly after close. A leftover temp
      // directory must never fail the suite.
    }
  }
});

// ─── Overnight runner: dependency eligibility ───────────────────────

describe("overnight dependency eligibility resolves the runtime row over the spec", () => {
  test("a dependency the store still has IN_PROGRESS does not unblock its dependent, whatever its spec says", async () => {
    // PRE-FIX: `areParsedDependenciesSatisfied` read `dep.status`, the raw
    // spec value, which is COMPLETE here, so the dependent came back
    // "pending_prep" and would have been queued for dispatch.
    const root = makeProject();
    writeTask(root, { id: "TASK-4000", status: "COMPLETE", blocks: ["TASK-4001"] });
    writeTask(root, { id: "TASK-4001", status: "READY", blockedBy: ["TASK-4000"] });
    seedRuntimeStatus(root, { "TASK-4000": "IN_PROGRESS" });

    const checkpoint = await runInventory(root, ["TASK-4001"]);

    expect(recordFor(checkpoint, "TASK-4001").status).toBe("blocked");
  });

  test("a dependency the store has marked COMPLETE unblocks its dependent even while the spec still says IN_PROGRESS", async () => {
    // PRE-FIX: the raw spec IN_PROGRESS failed the predicate and the
    // dependent came back "blocked", so a genuinely finished dependency
    // could not release its dependents until someone edited markdown.
    const root = makeProject();
    writeTask(root, { id: "TASK-4010", status: "IN_PROGRESS", blocks: ["TASK-4011"] });
    writeTask(root, { id: "TASK-4011", status: "READY", blockedBy: ["TASK-4010"] });
    seedRuntimeStatus(root, { "TASK-4010": "COMPLETE" });

    const checkpoint = await runInventory(root, ["TASK-4011"]);

    expect(recordFor(checkpoint, "TASK-4011").status).toBe("pending_prep");
  });

  test("REJECTED never satisfies a dependent when it is the resolved answer, and a COMPLETE row over a REJECTED spec does satisfy", async () => {
    // Three combinations, because the slogan "REJECTED never satisfies"
    // is only true of the RESOLVED status. A COMPLETE row over a REJECTED
    // spec line resolves to COMPLETE and satisfies, which is "DB is truth"
    // working, not a hole.
    //
    // PRE-FIX: 4021 was "pending_prep" (raw spec COMPLETE satisfied it,
    // the REJECTED row unseen) and 4025 was "blocked" (raw spec REJECTED).
    // Only the middle pair agreed with the fixed behavior.
    const root = makeProject();
    writeTask(root, { id: "TASK-4020", status: "COMPLETE", blocks: ["TASK-4021"] });
    writeTask(root, { id: "TASK-4021", status: "READY", blockedBy: ["TASK-4020"] });
    writeTask(root, { id: "TASK-4022", status: "REJECTED", blocks: ["TASK-4023"] });
    writeTask(root, { id: "TASK-4023", status: "READY", blockedBy: ["TASK-4022"] });
    writeTask(root, { id: "TASK-4024", status: "REJECTED", blocks: ["TASK-4025"] });
    writeTask(root, { id: "TASK-4025", status: "READY", blockedBy: ["TASK-4024"] });
    seedRuntimeStatus(root, {
      "TASK-4020": "REJECTED",
      "TASK-4024": "COMPLETE",
    });

    const checkpoint = await runInventory(root, ["TASK-4021", "TASK-4023", "TASK-4025"]);

    // Rejected by the store, over a spec that claims COMPLETE.
    expect(recordFor(checkpoint, "TASK-4021").status).toBe("blocked");
    // Rejected by the spec with no row to say otherwise.
    expect(recordFor(checkpoint, "TASK-4023").status).toBe("blocked");
    // Completed by the store, over a stale REJECTED spec line.
    expect(recordFor(checkpoint, "TASK-4025").status).toBe("pending_prep");
  });

  test("a spec-only completion still unblocks in the same pass where a conflicting row does not", async () => {
    // The narrowed availability criterion and the retirement, together, in
    // one inventory: a task whose ONLY completion signal is its spec file
    // must keep unblocking dependents (4030), while a task the store
    // disagrees about must not (4032).
    //
    // PRE-FIX: 4031 was "pending_prep" too, so that half is a guard rather
    // than a defect pin; 4033 was "pending_prep" as well, which is the
    // failure. The pair is asserted together on purpose, because a "fix"
    // that made a runtime row mandatory would pass the second and break
    // the first.
    const root = makeProject();
    writeTask(root, { id: "TASK-4030", status: "COMPLETE", blocks: ["TASK-4031"] });
    writeTask(root, { id: "TASK-4031", status: "READY", blockedBy: ["TASK-4030"] });
    writeTask(root, { id: "TASK-4032", status: "COMPLETE", blocks: ["TASK-4033"] });
    writeTask(root, { id: "TASK-4033", status: "READY", blockedBy: ["TASK-4032"] });
    // A real store that simply has no row for 4030.
    seedRuntimeStatus(root, { "TASK-4032": "READY" });

    const checkpoint = await runInventory(root, ["TASK-4031", "TASK-4033"]);

    expect(recordFor(checkpoint, "TASK-4031").status).toBe("pending_prep");
    expect(recordFor(checkpoint, "TASK-4033").status).toBe("blocked");
  });

  test("a runtime store that exists but cannot be read is reported, not silently answered from the spec", async () => {
    // "I could not read the store" must never look like "the store had
    // nothing to say". The answers below fall back to spec authority,
    // which is correct as a fallback and dangerous as a silent one.
    //
    // PRE-FIX: the pass never opened a store at all, so no degradation
    // event of any kind existed to record.
    const root = makeProject();
    writeTask(root, { id: "TASK-4040", status: "COMPLETE", blocks: ["TASK-4041"] });
    writeTask(root, { id: "TASK-4041", status: "READY", blockedBy: ["TASK-4040"] });
    fs.writeFileSync(
      path.join(root, ".quack", "quack.db"),
      "this is not a sqlite database",
      "utf-8",
    );

    const checkpoint = await runInventory(root, ["TASK-4041"]);

    const degraded = checkpoint.events.filter(
      (event) => event.type === "task_state_overlay_degraded",
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0].details?.overlaySource).toBe("unreadable");
    // The fallback itself still answers, so availability is preserved.
    expect(recordFor(checkpoint, "TASK-4041").status).toBe("pending_prep");
  });
});

// ─── Overnight runner: own-task skip ────────────────────────────────

// ─── The round-3 F3 path ────────────────────────────────────────────
describe("overnight AUTOMATIC discovery resolves the runtime row over the spec", () => {
  test("with no task ids named, the store decides which tasks enter the inventory at all", async () => {
    // PRE-FIX: discovery gated on `task.status === "READY"` (the raw
    // spec line) and on spec-only hygiene, BEFORE anything routed ran.
    // A conflicting task never entered the inventory, so it never
    // reached the resolved predicates downstream and no amount of
    // routing further along could reach it. Every existing overnight
    // test passes explicit ids and so never crosses this branch.
    const root = makeProject();
    writeTask(root, { id: "TASK-4500", status: "READY" });
    writeTask(root, { id: "TASK-4501", status: "REJECTED" });
    writeTask(root, { id: "TASK-4502", status: "READY" });
    seedRuntimeStatus(root, {
      "TASK-4500": "REJECTED", // the store refused it; the markdown is stale
      "TASK-4501": "READY", // the store re-opened it; the markdown is stale
    });

    const checkpoint = await runInventory(root, []);
    const discovered = checkpoint.tasks.map((entry) => entry.taskId).sort();

    // 4500 out on its row despite a READY line. 4501 IN on its row
    // despite a REJECTED line, which is the half a spec-side veto could
    // never produce. 4502 is the control: no row, spec READY, in.
    expect(discovered).toEqual(["TASK-4501", "TASK-4502"]);
  });

  test("with no store, automatic discovery is exactly what it always was", async () => {
    // The availability control. Same three specs, no runtime rows: the
    // spec lines are the whole answer, so the two READY tasks are
    // discovered and the REJECTED one is suppressed by hygiene.
    const root = makeProject();
    writeTask(root, { id: "TASK-4510", status: "READY" });
    writeTask(root, { id: "TASK-4511", status: "REJECTED" });
    writeTask(root, { id: "TASK-4512", status: "READY" });

    const checkpoint = await runInventory(root, []);

    expect(checkpoint.tasks.map((entry) => entry.taskId).sort()).toEqual([
      "TASK-4510",
      "TASK-4512",
    ]);
  });
});

describe("overnight own-task skip resolves the runtime row over the spec", () => {
  test("a task the store has rejected is skipped as work even though its spec still says READY", async () => {
    // Two changes at once, which is the point: REJECTED counts as finished
    // for the "is this task work I should do" question, and the answer is
    // read from the store rather than the markdown.
    //
    // PRE-FIX: raw spec READY, predicate `isCompleteStatus`, so the record
    // came back "pending_prep" and an explicitly named REJECTED task went
    // straight back into prep and redispatch.
    const root = makeProject();
    writeTask(root, { id: "TASK-4100", status: "READY" });
    seedRuntimeStatus(root, { "TASK-4100": "REJECTED" });

    const checkpoint = await runInventory(root, ["TASK-4100"]);

    const record = recordFor(checkpoint, "TASK-4100");
    expect(record.status).toBe("skipped");
    // The skip reason matters: `refreshBlockedTasks` treats `skipped` as
    // satisfying a dependent, so a REJECTED skip has to be distinguishable
    // from a COMPLETE one.
    expect(record.lastError).toContain("REJECTED");
  });

  test("a task the store has not finished is queued even though its spec says COMPLETE, and one the store finished is skipped without a rejection marker", async () => {
    // PRE-FIX: 4110 read raw spec COMPLETE and was skipped, so a task the
    // store still had in flight was dropped from the queue on the strength
    // of a markdown line; 4111 read raw spec READY and was queued even
    // though the store had already closed it.
    const root = makeProject();
    writeTask(root, { id: "TASK-4110", status: "COMPLETE" });
    writeTask(root, { id: "TASK-4111", status: "READY" });
    seedRuntimeStatus(root, {
      "TASK-4110": "IN_PROGRESS",
      "TASK-4111": "COMPLETE",
    });

    const checkpoint = await runInventory(root, ["TASK-4110", "TASK-4111"]);

    expect(recordFor(checkpoint, "TASK-4110").status).toBe("pending_prep");
    const finished = recordFor(checkpoint, "TASK-4111");
    expect(finished.status).toBe("skipped");
    expect(finished.lastError).toBeUndefined();
  });
});

// ─── Lifecycle: blocker promotion ───────────────────────────────────

// ─── The round-3 F1 topology ────────────────────────────────────────
// Every lifecycle test above runs with `adapter.projectRoot` set to the
// project root, and that is NOT what a dispatch does.
//
// `DispatchManager.startWorktree` creates `<root>/.quack/worktrees/
// <taskId>` and spawns the child with `--project <worktree>`, so
// `adapter.projectRoot` inside a real run IS the worktree. Worktree
// setup junctions `.quack/logs` and `.quack/prep` into it and NOTHING
// else, so `<worktree>/.quack/quack.db` cannot exist.
//
// The result was that the overlay loaded `absent` on every real
// dispatch, the lifecycle fell back to raw spec status, and all the
// coverage above passed while the routing did nothing in production.
// A test whose store sits at the project root cannot see that. These
// put the store ONLY at the parent, which is where it actually lives.

/**
 * A dispatch worktree under `root`, with its own task directory and
 * adapter, and deliberately NO database of its own.
 */
function makeDispatchWorktree(root: string, taskId: string): string {
  const worktree = path.join(root, ".quack", "worktrees", taskId);
  fs.mkdirSync(path.join(worktree, TASK_DIR), { recursive: true });
  fs.mkdirSync(path.join(worktree, ".quack", "logs"), { recursive: true });
  fs.copyFileSync(
    path.join(root, ".quack", "adapter.json"),
    path.join(worktree, ".quack", "adapter.json"),
  );
  return worktree;
}

describe("lifecycle routing survives the real dispatch worktree topology", () => {
  test("the store at the project root decides, even though the run is rooted in a worktree with no store", async () => {
    // PRE-FIX: `loadTaskStateOverlay(adapter.projectRoot)` looked for
    // `<worktree>/.quack/quack.db`, found nothing, reported `absent`
    // (not degraded, because absent is the ordinary rowless case) and
    // silently returned an empty overlay. Raw spec COMPLETE for 4402
    // then satisfied the blocker loop and TASK-4401 was promoted.
    const root = makeProject();
    const worktree = makeDispatchWorktree(root, "TASK-4400");

    // The specs live in the WORKTREE, exactly as a git worktree gives
    // them to the dispatched agent.
    writeTask(worktree, { id: "TASK-4400", status: "READY", blocks: ["TASK-4401"] });
    writeTask(worktree, {
      id: "TASK-4401",
      status: "BACKLOG",
      blockedBy: ["TASK-4400", "TASK-4402"],
    });
    writeTask(worktree, { id: "TASK-4402", status: "COMPLETE", blocks: ["TASK-4401"] });

    // The store lives at the PROJECT ROOT, and only there.
    seedRuntimeStatus(root, { "TASK-4402": "IN_PROGRESS" });
    expect(fs.existsSync(path.join(root, ".quack", "quack.db"))).toBe(true);
    expect(fs.existsSync(path.join(worktree, ".quack", "quack.db"))).toBe(false);

    const { result } = await runLifecycle(worktree, "TASK-4400");

    expect(result.statusUpdated).toBe(true);
    expect(result.blockersResolved).toEqual([]);
    expect(specStatusOnDisk(worktree, "TASK-4401")).toBe("BACKLOG");
  });

  test("the availability property survives the same topology: no store anywhere still promotes", async () => {
    // The control, and the reason this cannot be satisfied by failing
    // closed. Identical spec files, identical worktree layout, and no
    // database at the parent either. A task whose only completion
    // signal is its spec file must still unblock its dependents.
    const root = makeProject();
    const worktree = makeDispatchWorktree(root, "TASK-4410");
    writeTask(worktree, { id: "TASK-4410", status: "READY", blocks: ["TASK-4411"] });
    writeTask(worktree, {
      id: "TASK-4411",
      status: "BACKLOG",
      blockedBy: ["TASK-4410", "TASK-4412"],
    });
    writeTask(worktree, { id: "TASK-4412", status: "COMPLETE", blocks: ["TASK-4411"] });

    expect(fs.existsSync(path.join(root, ".quack", "quack.db"))).toBe(false);

    const { result } = await runLifecycle(worktree, "TASK-4410");

    expect(result.blockersResolved).toEqual(["TASK-4411"]);
    expect(specStatusOnDisk(worktree, "TASK-4411")).toBe("READY");
  });

  test("a store in the worktree still wins over the parent's, so nothing is hijacked upward", async () => {
    // Resolution prefers the NEAREST store rather than always climbing.
    // Without this, an isolated checkout that genuinely has its own
    // database would silently start answering from its parent, which is
    // a different bug in the opposite direction.
    const root = makeProject();
    const worktree = makeDispatchWorktree(root, "TASK-4420");
    writeTask(worktree, { id: "TASK-4420", status: "READY", blocks: ["TASK-4421"] });
    writeTask(worktree, {
      id: "TASK-4421",
      status: "BACKLOG",
      blockedBy: ["TASK-4420", "TASK-4422"],
    });
    writeTask(worktree, { id: "TASK-4422", status: "IN_PROGRESS", blocks: ["TASK-4421"] });

    // The parent says the blocker is unfinished; the worktree's own
    // store says it is done. The nearer store is the answer.
    seedRuntimeStatus(root, { "TASK-4422": "IN_PROGRESS" });
    seedRuntimeStatus(worktree, { "TASK-4422": "COMPLETE" });

    const { result } = await runLifecycle(worktree, "TASK-4420");

    expect(result.blockersResolved).toEqual(["TASK-4421"]);
  });
});

describe("lifecycle blocker promotion resolves the runtime row over the spec", () => {
  test("a blocker the store still has IN_PROGRESS holds the promotion back even though its spec says COMPLETE", async () => {
    // Promotion is not cosmetic: the monitor turns
    // `lifecycle_blocker_resolved` into setStatus(id, "READY"), so an
    // unresolved read here lets a markdown line write runtime authority.
    //
    // PRE-FIX: raw spec COMPLETE for 4202 satisfied the loop and TASK-4201
    // was promoted.
    const root = makeProject();
    writeTask(root, { id: "TASK-4200", status: "READY", blocks: ["TASK-4201"] });
    writeTask(root, {
      id: "TASK-4201",
      status: "BACKLOG",
      blockedBy: ["TASK-4200", "TASK-4202"],
    });
    writeTask(root, { id: "TASK-4202", status: "COMPLETE", blocks: ["TASK-4201"] });
    seedRuntimeStatus(root, { "TASK-4202": "IN_PROGRESS" });

    const { result } = await runLifecycle(root, "TASK-4200");

    expect(result.statusUpdated).toBe(true);
    expect(result.blockersResolved).toEqual([]);
    expect(specStatusOnDisk(root, "TASK-4201")).toBe("BACKLOG");
  });

  test("a blocker the store has marked COMPLETE releases the dependent even though its spec says IN_PROGRESS", async () => {
    // PRE-FIX: raw spec IN_PROGRESS failed the predicate, so a dependency
    // the store had genuinely finished could not release its dependent.
    const root = makeProject();
    writeTask(root, { id: "TASK-4210", status: "READY", blocks: ["TASK-4211"] });
    writeTask(root, {
      id: "TASK-4211",
      status: "BACKLOG",
      blockedBy: ["TASK-4210", "TASK-4212"],
    });
    writeTask(root, { id: "TASK-4212", status: "IN_PROGRESS", blocks: ["TASK-4211"] });
    seedRuntimeStatus(root, { "TASK-4212": "COMPLETE" });

    const { result, recorded } = await runLifecycle(root, "TASK-4210");

    expect(result.blockersResolved).toEqual(["TASK-4211"]);
    expect(specStatusOnDisk(root, "TASK-4211")).toBe("READY");
    expect(recorded.filter((event) => event.stage === "lifecycle_blocker_resolved")).toHaveLength(
      1,
    );
  });

  test("a REJECTED blocker never promotes when it is the resolved answer, whichever layer holds it", async () => {
    // PRE-FIX: 4221 was promoted, because the raw spec said COMPLETE and
    // the REJECTED row was invisible. 4223 was correct pre-fix too, and is
    // asserted alongside so the pair states the whole rule.
    const root = makeProject();
    writeTask(root, {
      id: "TASK-4220",
      status: "READY",
      blocks: ["TASK-4221", "TASK-4223"],
    });
    writeTask(root, {
      id: "TASK-4221",
      status: "BACKLOG",
      blockedBy: ["TASK-4220", "TASK-4222"],
    });
    writeTask(root, { id: "TASK-4222", status: "COMPLETE", blocks: ["TASK-4221"] });
    writeTask(root, {
      id: "TASK-4223",
      status: "BACKLOG",
      blockedBy: ["TASK-4220", "TASK-4224"],
    });
    writeTask(root, { id: "TASK-4224", status: "REJECTED", blocks: ["TASK-4223"] });
    seedRuntimeStatus(root, { "TASK-4222": "REJECTED" });

    const { result } = await runLifecycle(root, "TASK-4220");

    expect(result.blockersResolved).toEqual([]);
    expect(specStatusOnDisk(root, "TASK-4221")).toBe("BACKLOG");
    expect(specStatusOnDisk(root, "TASK-4223")).toBe("BACKLOG");
  });

  test("this run's own completion counts over its stale IN_PROGRESS row, but a REJECTED row for it is not overwritten", async () => {
    // The lifecycle writes COMPLETE to the spec here and the monitor
    // writes the matching row later, in another process. Resolving
    // DB-over-spec without layering in the decision this run just made
    // would stop every real dispatch from promoting its dependents.
    //
    // PRE-FIX: the first half passed (raw spec COMPLETE, freshly written)
    // and the second half FAILED: 4311 was promoted even though the store
    // had recorded the work as refused.
    const layered = makeProject();
    writeTask(layered, { id: "TASK-4300", status: "READY", blocks: ["TASK-4301"] });
    writeTask(layered, {
      id: "TASK-4301",
      status: "BACKLOG",
      blockedBy: ["TASK-4300"],
    });
    seedRuntimeStatus(layered, { "TASK-4300": "IN_PROGRESS" });

    const layeredRun = await runLifecycle(layered, "TASK-4300");
    expect(layeredRun.result.blockersResolved).toEqual(["TASK-4301"]);

    const refused = makeProject();
    writeTask(refused, { id: "TASK-4310", status: "READY", blocks: ["TASK-4311"] });
    writeTask(refused, {
      id: "TASK-4311",
      status: "BACKLOG",
      blockedBy: ["TASK-4310"],
    });
    seedRuntimeStatus(refused, { "TASK-4310": "REJECTED" });

    const refusedRun = await runLifecycle(refused, "TASK-4310");
    expect(refusedRun.result.statusUpdated).toBe(true);
    expect(refusedRun.result.blockersResolved).toEqual([]);
    expect(specStatusOnDisk(refused, "TASK-4311")).toBe("BACKLOG");
  });

  test("a dependent the store has already advanced past BACKLOG is not walked backwards", async () => {
    // The promotion candidate's OWN status is an input too. Promoting
    // writes READY into the store, so a stale BACKLOG line must not be
    // able to re-promote a task the store already moved on.
    //
    // PRE-FIX: the raw spec said BACKLOG, so the task was promoted a
    // second time, its spec rewritten and a duplicate
    // `lifecycle_blocker_resolved` emitted.
    const root = makeProject();
    writeTask(root, { id: "TASK-4400", status: "READY", blocks: ["TASK-4401"] });
    writeTask(root, {
      id: "TASK-4401",
      status: "BACKLOG",
      blockedBy: ["TASK-4400"],
    });
    seedRuntimeStatus(root, { "TASK-4401": "READY" });

    const { result, recorded } = await runLifecycle(root, "TASK-4400");

    expect(result.blockersResolved).toEqual([]);
    expect(specStatusOnDisk(root, "TASK-4401")).toBe("BACKLOG");
    expect(recorded.filter((event) => event.stage === "lifecycle_blocker_resolved")).toHaveLength(
      0,
    );
  });
});

// ─── Lifecycle: parent rollup over subtasks ─────────────────────────

describe("lifecycle parent rollup resolves the runtime row over the spec", () => {
  test("a sibling the store still has IN_PROGRESS holds the parent back even though its spec says COMPLETE", async () => {
    // Rolling the parent up writes COMPLETE for the parent, so an
    // unresolved subtask read lets a markdown line close a parent task.
    //
    // PRE-FIX: raw spec COMPLETE for 4502 satisfied the loop and the
    // parent was marked complete.
    const root = makeProject();
    writeTask(root, { id: "TASK-4500", status: "IN_PROGRESS" });
    writeTask(root, { id: "TASK-4501", status: "READY", parent: "TASK-4500" });
    writeTask(root, { id: "TASK-4502", status: "COMPLETE", parent: "TASK-4500" });
    seedRuntimeStatus(root, {
      "TASK-4501": "IN_PROGRESS",
      "TASK-4502": "IN_PROGRESS",
    });

    const { result } = await runLifecycle(root, "TASK-4501");

    expect(result.statusUpdated).toBe(true);
    expect(result.parentCompleted).toBeNull();
    expect(specStatusOnDisk(root, "TASK-4500")).toBe("IN_PROGRESS");
  });

  test("a sibling the store has marked COMPLETE rolls the parent up, and a REJECTED row blocks it", async () => {
    // PRE-FIX: the first half FAILED, because the raw spec said
    // IN_PROGRESS and the parent was left open even though the store had
    // finished the sibling. The second half FAILED the other way, rolling
    // the parent up over a sibling the store had refused.
    const rollup = makeProject();
    writeTask(rollup, { id: "TASK-4510", status: "IN_PROGRESS" });
    writeTask(rollup, { id: "TASK-4511", status: "READY", parent: "TASK-4510" });
    writeTask(rollup, { id: "TASK-4512", status: "IN_PROGRESS", parent: "TASK-4510" });
    seedRuntimeStatus(rollup, {
      "TASK-4511": "IN_PROGRESS",
      "TASK-4512": "COMPLETE",
    });

    const rollupRun = await runLifecycle(rollup, "TASK-4511");
    expect(rollupRun.result.parentCompleted).toBe("TASK-4510");
    expect(specStatusOnDisk(rollup, "TASK-4510")).toBe("COMPLETE");

    const refused = makeProject();
    writeTask(refused, { id: "TASK-4520", status: "IN_PROGRESS" });
    writeTask(refused, { id: "TASK-4521", status: "READY", parent: "TASK-4520" });
    writeTask(refused, { id: "TASK-4522", status: "COMPLETE", parent: "TASK-4520" });
    seedRuntimeStatus(refused, {
      "TASK-4521": "IN_PROGRESS",
      "TASK-4522": "REJECTED",
    });

    const refusedRun = await runLifecycle(refused, "TASK-4521");
    expect(refusedRun.result.parentCompleted).toBeNull();
    expect(specStatusOnDisk(refused, "TASK-4520")).toBe("IN_PROGRESS");
  });
});
