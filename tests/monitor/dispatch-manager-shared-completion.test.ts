import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";

interface Internals {
  jobs: Map<string, DispatchJob>;
  observationExitHandlers: Map<DispatchJob, number>;
  persistSharedCheckoutPause(
    job: DispatchJob,
    status: string,
    transfer?: boolean,
    successful?: boolean,
  ): void;
  restoreSharedCheckout(job: DispatchJob): boolean;
}

describe("completed shared-checkout reconciliation", () => {
  let root: string;
  let manager: DispatchManager;
  let markerPath: string;
  let eventPath: string;
  let marker: Record<string, unknown>;
  let event: { stage: string; taskId: string; sessionId: string; payload: Record<string, unknown> };
  const startedAt = "2026-09-12T19:00:00.000Z";
  const completedAt = "2026-09-12T19:00:02.000Z";

  function writeMarker() {
    fs.writeFileSync(markerPath, JSON.stringify(marker));
  }
  function writeEvent() {
    fs.writeFileSync(eventPath, JSON.stringify(event) + "\n");
  }
  function reconcile(token = "reconcile-token") {
    return manager.reconcileSharedCheckoutShutdownSurvivor(
      "TASK-A",
      "session-a",
      "owner-a",
      token,
      true,
    );
  }
  function currentJob(): DispatchJob {
    const job: DispatchJob = {
      taskId: "TASK-A",
      sessionId: "session-a",
      sharedCheckoutOwnershipId: "owner-a",
      pid: 0,
      startedAt,
      completedAt,
      status: "completed",
      exitCode: 0,
      output: [],
    };
    (manager as unknown as Internals).jobs.set(job.taskId, job);
    return job;
  }
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  }
  function gitBaseline() {
    git("init", "-b", "main");
    git("config", "user.name", "Quack test");
    git("config", "user.email", "quack-test@example.invalid");
    fs.writeFileSync(path.join(root, ".gitignore"), ".quack/\n");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    git("add", ".gitignore", "tracked.txt");
    git("commit", "-m", "baseline");
    git("checkout", "-b", "task-branch");
    marker.originalBranch = "main";
    marker.originalStatus = "";
    writeMarker();
    manager = new DispatchManager(root, path.join(root, "fixture.cjs"));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-completion-"));
    const logs = path.join(root, ".quack", "logs");
    fs.mkdirSync(logs, { recursive: true });
    markerPath = path.join(logs, "shared-checkout-pause.json");
    eventPath = path.join(logs, "events-session-a.jsonl");
    marker = {
      version: 1,
      taskId: "TASK-A",
      sessionId: "session-a",
      ownershipId: "owner-a",
      startedAt,
      pausedAt: completedAt,
      successfulExitAt: completedAt,
      status: "stopped",
      processTreeStatus: "unconfirmed",
      reconciliationToken: "reconcile-token",
    };
    event = {
      stage: "dispatch_child_exit",
      taskId: "TASK-A",
      sessionId: "session-a",
      payload: {
        taskId: "TASK-A",
        exitCode: 0,
        signal: null,
        killed: false,
        operatorRequested: false,
        worktreePath: null,
        at: "2026-09-12T19:00:01.000Z",
      },
    };
    writeMarker();
    writeEvent();
    manager = new DispatchManager(root, path.join(root, "fixture.cjs"));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    const resolved = fs.realpathSync.native(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync.native(os.tmpdir()));
    expect(path.basename(resolved).startsWith("quack-shared-completion-")).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it.each([false, true])(
    "releases the exact successful owner, in-memory job present: %s",
    (present) => {
      if (present) currentJob();
      expect(reconcile()).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(manager.getSharedCheckoutOccupants()).toEqual([]);
      expect(manager.getSharedCheckoutShutdownSurvivor()).toBeUndefined();
    },
  );

  it("holds the mutation lock through branch restoration and release", () => {
    gitBaseline();
    const internals = manager as unknown as Internals;
    const restore = internals.restoreSharedCheckout.bind(manager);
    jest.spyOn(internals, "restoreSharedCheckout").mockImplementation((job) => {
      const competing = new DispatchManager(root, path.join(root, "fixture.cjs"));
      expect(
        competing.reconcileSharedCheckoutShutdownSurvivor(
          "TASK-A",
          "session-a",
          "owner-a",
          "reconcile-token",
          true,
        ),
      ).toBe(false);
      return restore(job);
    });
    expect(reconcile()).toBe(true);
    expect(git("branch", "--show-current")).toBe("main");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each(["baseline missing", "dirty baseline changed"])("retains ownership when %s", (reason) => {
    gitBaseline();
    if (reason === "baseline missing") {
      delete marker.originalBranch;
      writeMarker();
    } else fs.writeFileSync(path.join(root, "tracked.txt"), "preserve this edit\n");
    expect(reconcile()).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    if (reason !== "baseline missing")
      expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("preserve this edit\n");
  });

  it("permits retry after the operator restores the exact baseline", () => {
    gitBaseline();
    fs.writeFileSync(path.join(root, "tracked.txt"), "temporary edit\n");
    expect(reconcile()).toBe(false);
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    expect(reconcile()).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each([
    "nonzero",
    "signal",
    "operator stop",
    "wrong task",
    "wrong session",
    "worktree",
    "old exit",
    "late exit",
    "missing",
    "malformed",
    "duplicate",
    "legacy",
    "paused",
    "failed",
    "replacement",
  ])("preserves ambiguous or unfinished ownership: %s", (reason) => {
    if (reason === "nonzero") event.payload.exitCode = 1;
    if (reason === "signal") event.payload.signal = "SIGTERM";
    if (reason === "operator stop") event.payload.operatorRequested = true;
    if (reason === "wrong task") event.taskId = "TASK-OTHER";
    if (reason === "wrong session") event.sessionId = "session-other";
    if (reason === "worktree") event.payload.worktreePath = "/worktree";
    if (reason === "old exit") event.payload.at = "2026-09-12T18:59:59.000Z";
    if (reason === "late exit") event.payload.at = "2026-09-12T19:00:03.000Z";
    writeEvent();
    if (reason === "missing") fs.unlinkSync(eventPath);
    if (reason === "malformed") fs.appendFileSync(eventPath, "{broken\n");
    if (reason === "duplicate") fs.appendFileSync(eventPath, JSON.stringify(event) + "\n");
    if (reason === "legacy") {
      delete marker.successfulExitAt;
      writeMarker();
    }
    if (reason === "failed") {
      marker.status = "failed";
      writeMarker();
    }
    if (reason === "paused") {
      const approvals = path.join(root, ".quack/logs/approvals");
      fs.mkdirSync(approvals);
      fs.writeFileSync(
        path.join(approvals, "TASK-A.json"),
        JSON.stringify({ taskId: "TASK-A", state: "pending", createdAt: completedAt }),
      );
    }
    if (reason === "replacement") currentJob().sharedCheckoutOwnershipId = "new-owner";
    expect(reconcile()).toBe(true); // Tree confirmation alone must not release work.
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(manager.getSharedCheckoutOccupants()).toHaveLength(1);
  });

  it("rejects stale operator tokens without altering ownership", () => {
    const before = fs.readFileSync(markerPath, "utf8");
    expect(reconcile("old-token")).toBe(false);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(before);
  });

  it("waits for the original exit handler to finish before reconciliation", () => {
    const job = currentJob();
    (manager as unknown as Internals).observationExitHandlers.set(job, 1);
    const before = fs.readFileSync(markerPath, "utf8");
    expect(reconcile()).toBe(false);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(before);
  });

  it("records successful exit only for the same owner and never carries it into a new run", () => {
    const internals = manager as unknown as Internals;
    const job = currentJob();
    internals.persistSharedCheckoutPause(job, "stopped", false, true);
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(marker.successfulExitAt).toBe(completedAt);
    marker.processTreeStatus = "confirmed-stopped";
    writeMarker();
    job.sessionId = "next-session";
    job.status = "running";
    job.exitCode = undefined;
    internals.persistSharedCheckoutPause(job, "running", true);
    const next = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(next.successfulExitAt).toBeUndefined();
  });
});
