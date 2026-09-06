// ─── TASK-1326 / QPI-042 ───────────────────────────────────────────
// A run paused at a human gate must survive a re-dispatch. These tests
// use a REAL git repo for the branch legs: the thing being protected is
// committed work, and a mocked git cannot demonstrate that `branch -D`
// no longer orphans it.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  archivePausedRunState,
  PausedRunArchiveError,
  PausedRunRefusalError,
  pausedRunRefusalMessage,
  resolvePausedRunState,
  resolveRunScopedPauseState,
} from "../../src/dispatcher/paused-run-state";
import { DispatchManager } from "../../src/monitor/dispatch-manager";

let projectRoot: string;
let logDir: string;
const managers: DispatchManager[] = [];

// Pend timestamps must be RECENT. `resolvePausedRunState` honours the 24h
// DEFAULT_APPROVAL_TIMEOUT_MS, so hardcoding absolute ones made this suite a
// TIME BOMB: it passed on the day it was written (2026-08-10) and five of its
// 27 tests went red 24 hours later, when the fixtures aged past the timeout and
// the resolver correctly returned null. Deterministic within a run, relative to
// it. FIRST is older than SECOND so the two-override ordering still holds.
const PEND_FIRST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const PEND_SECOND = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const PEND_JUDGE = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
/** Archive paths render the pend time with colons replaced. */
const PEND_FIRST_PATH = PEND_FIRST.replace(/:/g, "-");

function git(args: string[], cwd = projectRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function writeApproval(
  file: string,
  state: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): void {
  const dir = path.join(logDir, "approvals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({ taskId: "TASK-500", state, createdAt, ...extra }, null, 2),
    "utf-8",
  );
}

function writeCheckpoint(sessionId: string, branchName?: string): void {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "checkpoint-TASK-500.json"),
    JSON.stringify(
      {
        taskId: "TASK-500",
        sessionId,
        completedStages: ["gate", "blueprint", "approve", "branch", "context", "agent", "commit"],
        totalCostUsd: 4.2,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        ...(branchName ? { branchName } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-paused-run-"));
  logDir = path.join(projectRoot, ".quack", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "Quack Test"]);
  fs.writeFileSync(path.join(projectRoot, "seed.txt"), "seed\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "seed"]);
});

afterEach(() => {
  // The negative-control tests deliberately let start() through, which
  // spawns a child and creates a worktree; Windows holds those handles
  // briefly after kill, so cleanup is best-effort (the temp dir is
  // disposable either way).
  for (const m of managers) m.killAll();
  managers.length = 0;
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // EBUSY on Windows — leave it to the OS temp sweeper.
  }
});

describe("resolvePausedRunState", () => {
  it("returns null when nothing is pending", () => {
    expect(resolvePausedRunState(logDir, "TASK-500")).toBeNull();
    writeApproval("TASK-500.json", "approved", new Date().toISOString());
    expect(resolvePausedRunState(logDir, "TASK-500")).toBeNull();
  });

  it("sees a pending blueprint gate on disk with no in-memory state at all", () => {
    const createdAt = new Date().toISOString();
    writeApproval("TASK-500.json", "pending", createdAt);

    const paused = resolvePausedRunState(logDir, "TASK-500");
    expect(paused).not.toBeNull();
    expect(paused?.gate).toBe("blueprint");
    expect(paused?.createdAt).toBe(createdAt);
  });

  it("prefers the JUDGE gate when both are pending (it holds committed work)", () => {
    writeApproval("TASK-500.json", "pending", new Date().toISOString());
    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());

    expect(resolvePausedRunState(logDir, "TASK-500")?.gate).toBe("judge");
  });

  it("does not block on an EXPIRED pend (the dispatcher auto-rejects those)", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeApproval("TASK-500.json", "pending", old);

    expect(resolvePausedRunState(logDir, "TASK-500")).toBeNull();
    // ...but a longer configured timeout keeps it live.
    expect(resolvePausedRunState(logDir, "TASK-500", 72 * 60 * 60 * 1000)).not.toBeNull();
  });

  it("carries the paused run's session and branch from the checkpoint", () => {
    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());
    writeCheckpoint("quack-TASK-500-111", "quack/TASK-500");

    const paused = resolvePausedRunState(logDir, "TASK-500");
    expect(paused?.sessionId).toBe("quack-TASK-500-111");
    expect(paused?.branchName).toBe("quack/TASK-500");
  });

  it("names the gate and the way out in the refusal text", () => {
    writeApproval("TASK-500-judge.json", "pending", PEND_JUDGE);
    const paused = resolvePausedRunState(logDir, "TASK-500")!;
    const message = pausedRunRefusalMessage("TASK-500", paused);

    expect(message).toContain("judge review");
    expect(message).toContain(PEND_JUDGE);
    expect(message).toContain("committed work");
    expect(message).toMatch(/Approve or reject/);
  });
});

describe("archivePausedRunState", () => {
  it("preserves the branch tip so a later branch -D cannot orphan the work", () => {
    git(["checkout", "-b", "quack/TASK-500"]);
    fs.writeFileSync(path.join(projectRoot, "worker-output.txt"), "expensive\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "worker commit"]);
    const workSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "main"]);

    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());
    writeCheckpoint("quack-TASK-500-111", "quack/TASK-500");

    const paused = resolvePausedRunState(logDir, "TASK-500")!;
    const archive = archivePausedRunState(projectRoot, logDir, "TASK-500", paused);

    expect(archive.branchRef).toBe("refs/quack-archive/TASK-500/quack-TASK-500-111");
    expect(archive.checkpointPath).toBeDefined();
    expect(archive.approvalPath).toBeDefined();

    // The destructive step the monitor would take next.
    git(["branch", "-D", "quack/TASK-500"]);

    // The commit is still reachable, and its content is intact.
    expect(git(["rev-parse", archive.branchRef!])).toBe(workSha);
    expect(git(["show", `${workSha}:worker-output.txt`])).toBe("expensive");
  });

  it("keys archives by session, so a SECOND override cannot swallow the first", () => {
    writeApproval("TASK-500.json", "pending", PEND_FIRST);
    writeCheckpoint("quack-TASK-500-run1");
    const first = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );

    writeApproval("TASK-500.json", "pending", PEND_SECOND);
    writeCheckpoint("quack-TASK-500-run2");
    const second = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );

    expect(second.approvalPath).not.toBe(first.approvalPath);
    expect(fs.existsSync(first.approvalPath!)).toBe(true);
    expect(fs.existsSync(second.approvalPath!)).toBe(true);
    expect(
      (JSON.parse(fs.readFileSync(first.approvalPath!, "utf-8")) as { createdAt: string })
        .createdAt,
    ).toBe(PEND_FIRST);
  });

  it("writes a manifest to DISK, because the lifecycle event is SSE-only", () => {
    git(["checkout", "-b", "quack/TASK-500"]);
    fs.writeFileSync(path.join(projectRoot, "work.txt"), "x\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "worker commit"]);
    git(["checkout", "main"]);
    writeApproval("TASK-500-judge.json", "pending", PEND_FIRST);
    writeCheckpoint("quack-TASK-500-111", "quack/TASK-500");

    const archive = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );

    expect(archive.manifestPath).toBeDefined();
    const manifest = JSON.parse(fs.readFileSync(archive.manifestPath!, "utf-8")) as {
      gate: string;
      pendOpenedAt: string;
      branchRef: string;
      recovery: string;
    };
    expect(manifest.gate).toBe("judge");
    expect(manifest.pendOpenedAt).toBe(PEND_FIRST);
    expect(manifest.branchRef).toBe(archive.branchRef);
    // The recovery line has to actually work, not just look helpful.
    const recovered = manifest.recovery.replace("<name>", "recovered/TASK-500");
    execFileSync("git", recovered.split(" ").slice(1), { cwd: projectRoot });
    expect(git(["rev-parse", "recovered/TASK-500"])).toBe(git(["rev-parse", archive.branchRef!]));
  });

  it("2-F4: a stamp collision takes a free suffix instead of overwriting", () => {
    // Same session id twice — generateSessionId is only
    // second-granular, so this is reachable, and an overwrite would
    // cost the first run the archive that is the point of the feature.
    writeApproval("TASK-500.json", "pending", PEND_FIRST);
    writeCheckpoint("quack-TASK-500-20260810-100000");
    const first = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );

    writeApproval("TASK-500.json", "pending", PEND_SECOND);
    writeCheckpoint("quack-TASK-500-20260810-100000");
    const second = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );

    expect(second.manifestPath).not.toBe(first.manifestPath);
    expect(fs.existsSync(first.manifestPath!)).toBe(true);
    expect(
      (JSON.parse(fs.readFileSync(first.approvalPath!, "utf-8")) as { createdAt: string })
        .createdAt,
    ).toBe(PEND_FIRST);
    expect(
      (JSON.parse(fs.readFileSync(second.approvalPath!, "utf-8")) as { createdAt: string })
        .createdAt,
    ).toBe(PEND_SECOND);
  });

  it("falls back to the pend's open time when no checkpoint records a session", () => {
    writeApproval("TASK-500.json", "pending", PEND_FIRST);
    const archive = archivePausedRunState(
      projectRoot,
      logDir,
      "TASK-500",
      resolvePausedRunState(logDir, "TASK-500")!,
    );
    expect(archive.approvalPath).toContain(PEND_FIRST_PATH);
    expect(archive.checkpointPath).toBeUndefined();
  });

  it("THROWS rather than let an override proceed over unarchivable state", () => {
    writeApproval("TASK-500.json", "pending", new Date().toISOString());
    // Occupy the archive directory path with a FILE so mkdir must fail.
    fs.writeFileSync(path.join(logDir, "approvals", "archive"), "blocker", "utf-8");

    const paused = resolvePausedRunState(logDir, "TASK-500")!;
    expect(() => archivePausedRunState(projectRoot, logDir, "TASK-500", paused)).toThrow(
      PausedRunArchiveError,
    );
  });
});

describe("DispatchManager start guard (the seam ahead of the branch delete)", () => {
  function manager(): DispatchManager {
    // A FRESH manager: no in-memory job entry, which is exactly the
    // post-restart state the old guard could not see.
    const m = new DispatchManager(
      projectRoot,
      path.join(projectRoot, "fake-bin.js"),
      undefined,
      undefined,
      logDir,
    );
    managers.push(m);
    return m;
  }

  it("refuses a start for a task paused on disk, with no in-memory job", () => {
    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());
    const m = manager();

    expect(m.getActiveJob("TASK-500")).toBeUndefined();
    expect(() => m.start("TASK-500")).toThrow(PausedRunRefusalError);
  });

  it("refuses BEFORE anything destructive: the branch and worktree survive", () => {
    git(["branch", "quack/TASK-500"]);
    const worktreeDir = path.join(projectRoot, ".quack", "worktrees", "TASK-500");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "marker.txt"), "still here\n", "utf-8");
    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());

    expect(() => manager().start("TASK-500")).toThrow(PausedRunRefusalError);

    expect(git(["rev-parse", "--verify", "quack/TASK-500"])).toBeTruthy();
    expect(fs.existsSync(path.join(worktreeDir, "marker.txt"))).toBe(true);
  });

  // Round 2 F1 replaced the assertion that used to live here. It read
  // "does not refuse a resume", which encoded the bypass the round
  // refuted: a resume whose gate is STILL PENDING is the clobber path,
  // not the approve path. The real contract is the pair below — what
  // makes the approve flow safe is that it DECIDES the pend first, not
  // that it says `resume`.
  it("does not refuse a resume once the gate has been DECIDED (the approve path)", () => {
    writeApproval("TASK-500-judge.json", "approved", new Date().toISOString());
    let error: unknown;
    try {
      manager().start("TASK-500", { resume: true });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeInstanceOf(PausedRunRefusalError);
  });

  it("2-F1: DOES refuse a resume while the gate is still pending", () => {
    writeApproval("TASK-500-judge.json", "pending", new Date().toISOString());
    expect(() => manager().start("TASK-500", { resume: true })).toThrow(PausedRunRefusalError);
  });

  // Round-2b F1: the confirmation round EXECUTED this matrix and found
  // `[]`, `"string"` and `{}` falling through to `branch -D`. Each shape
  // is pinned individually so a future "simplification" of the parser
  // cannot quietly reopen one of them.
  it.each([
    ["a truncated file", "{ truncated"],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["a JSON string", '"string"'],
    ["an empty object", "{}"],
    ["an unknown state", '{"state":"weird","createdAt":"2026-08-10T10:00:00.000Z"}'],
    ["pending with no createdAt", '{"state":"pending"}'],
  ])("2b-F1: %s refuses instead of failing open into branch -D", (_label, body) => {
    const dir = path.join(logDir, "approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TASK-500-judge.json"), body, "utf-8");
    git(["branch", "quack/TASK-500"]);

    let thrown: unknown;
    try {
      manager().start("TASK-500");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PausedRunRefusalError);
    expect(git(["rev-parse", "--verify", "quack/TASK-500"])).toBeTruthy();
  });

  it("2b-F1: a DECIDED record with no createdAt is not a pause (it is not live)", () => {
    const dir = path.join(logDir, "approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TASK-500-judge.json"), '{"state":"approved"}', "utf-8");

    expect(resolvePausedRunState(logDir, "TASK-500")).toBeNull();
  });

  it("2-F2: an UNREADABLE approval record refuses rather than failing open", () => {
    const dir = path.join(logDir, "approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TASK-500-judge.json"), "{ truncated", "utf-8");
    git(["branch", "quack/TASK-500"]);

    let thrown: unknown;
    try {
      manager().start("TASK-500");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PausedRunRefusalError);
    expect((thrown as Error).message).toContain("UNREADABLE");
    // ...and it refused before the destructive step.
    expect(git(["rev-parse", "--verify", "quack/TASK-500"])).toBeTruthy();
  });

  // HAZARD PIN. This is the behaviour the guard exists to stand in
  // front of, asserted directly so nobody has to take QPI-042's word
  // for it: with no pend to refuse on, a plain start force-deletes the
  // task branch before the child dispatcher ever runs. Swap the pend
  // back in (the test above) and the branch survives. If this test ever
  // fails because the deletion moved or stopped, the guard's placement
  // must be re-derived rather than assumed.
  it("hazard: with nothing to refuse on, a fresh start DOES delete the task branch", () => {
    git(["branch", "quack/TASK-501"]);
    expect(git(["rev-parse", "--verify", "quack/TASK-501"])).toBeTruthy();

    try {
      manager().start("TASK-501");
    } catch {
      // The spawn itself may fail on the fake bin; the deletion happens
      // in createWorktree, ahead of it.
    }

    let branchStillThere = true;
    try {
      git(["rev-parse", "--verify", "quack/TASK-501"]);
    } catch {
      branchStillThere = false;
    }
    expect(branchStillThere).toBe(false);
  });

  it("does not refuse a task with no pend at all", () => {
    let error: unknown;
    try {
      manager().start("TASK-501");
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeInstanceOf(PausedRunRefusalError);
  });
});

// ─── TASK-1329 / QPI-041 ────────────────────────────────────────────
// The ATTRIBUTION question, which is not the same as the clobber-protection
// question. resolvePausedRunState is deliberately fail-CLOSED toward "do not
// delete this"; reused for attribution those same behaviours are fail-OPEN and
// would let a crashed run be reported as waiting on a human.
describe("resolveRunScopedPauseState", () => {
  const runStart = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it("reports a pause opened during THIS run", () => {
    const start = runStart();
    writeApproval("TASK-500.json", "pending", new Date(Date.parse(start) + 1000).toISOString());
    const paused = resolveRunScopedPauseState(logDir, "TASK-500", start);
    expect(paused?.gate).toBe("blueprint");
  });

  it("does NOT attribute a pend opened before this run started", () => {
    const start = runStart();
    writeApproval("TASK-500.json", "pending", new Date(Date.parse(start) - 1000).toISOString());
    expect(resolveRunScopedPauseState(logDir, "TASK-500", start)).toBeNull();
  });

  it("does NOT treat a malformed record as a pause (resolvePausedRunState does)", () => {
    const dir = path.join(logDir, "approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TASK-500.json"), "{ not json", "utf-8");
    // The guard spares it (fail-closed toward preserving)...
    expect(resolvePausedRunState(logDir, "TASK-500")?.malformed).toBe(true);
    // ...but attribution refuses it, so a real crash is not laundered into a pause.
    expect(resolveRunScopedPauseState(logDir, "TASK-500", runStart())).toBeNull();
  });

  it("does NOT attribute an expired pend", () => {
    const start = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeApproval("TASK-500.json", "pending", new Date(Date.parse(start) + 1000).toISOString());
    expect(resolveRunScopedPauseState(logDir, "TASK-500", start)).toBeNull();
  });

  it("refuses to attribute at all when the run boundary is unparseable", () => {
    writeApproval("TASK-500.json", "pending", new Date().toISOString());
    expect(resolveRunScopedPauseState(logDir, "TASK-500", "not-a-date")).toBeNull();
  });

  it("does NOT attribute a pend dated absurdly in the future (round-2 R2-6)", () => {
    // isExpired treats a future timestamp as un-expired, which is right for the
    // clobber guard and fail-OPEN for attribution: a corrupt year-9999 record is
    // "after the run start" of every run that will ever exist, so without a
    // forward bound it would mask any crash as a pause.
    writeApproval("TASK-500.json", "pending", "9999-01-01T00:00:00.000Z");
    expect(resolveRunScopedPauseState(logDir, "TASK-500", runStart())).toBeNull();
    // ...while the guard still refuses to destroy it.
    expect(resolvePausedRunState(logDir, "TASK-500")).not.toBeNull();
  });

  it("still attributes a pend a little ahead of now (ordinary clock skew)", () => {
    const start = runStart();
    writeApproval("TASK-500.json", "pending", new Date(Date.now() + 60 * 1000).toISOString());
    expect(resolveRunScopedPauseState(logDir, "TASK-500", start)?.gate).toBe("blueprint");
  });

  it("prefers the judge gate when both are pending in this run", () => {
    const start = runStart();
    const opened = new Date(Date.parse(start) + 1000).toISOString();
    writeApproval("TASK-500.json", "pending", opened);
    writeApproval("TASK-500-judge.json", "pending", opened);
    expect(resolveRunScopedPauseState(logDir, "TASK-500", start)?.gate).toBe("judge");
  });
});
