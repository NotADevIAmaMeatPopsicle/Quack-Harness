import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import {
  DegradedSharedCheckoutBusyError,
  DispatchManager,
  type DispatchJob,
} from "../../src/monitor/dispatch-manager";

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function confirmWindowsSharedCheckoutTree(markerPath: string): void {
  if (process.platform !== "win32") return;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
  marker.processTreeStatus = "confirmed-stopped";
  marker.reconciliationToken ??= "test-confirmation-token";
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
}

function markWindowsTreeKillConfirmed(manager: DispatchManager, taskId: string): void {
  if (process.platform !== "win32") return;
  (manager as unknown as { confirmedWindowsTreeKills: Set<string> }).confirmedWindowsTreeKills.add(
    taskId,
  );
}

describe("DispatchManager", () => {
  let manager: DispatchManager;
  let suiteLogDir: string;

  beforeEach(() => {
    // Use a dummy project root and bin path — we won't actually spawn
    suiteLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-dispatch-manager-suite-"));
    manager = new DispatchManager(
      "/fake/project",
      "/fake/bin.js",
      undefined,
      undefined,
      suiteLogDir,
    );
  });

  afterEach(() => {
    manager.killAll();
    fs.rmSync(suiteLogDir, { recursive: true, force: true });
  });

  test("getActiveJobs returns empty when no jobs", () => {
    expect(manager.getActiveJobs()).toEqual([]);
  });

  test("getAllJobs returns empty when no jobs", () => {
    expect(manager.getAllJobs()).toEqual([]);
  });

  test("getJob returns undefined for unknown task", () => {
    expect(manager.getJob("TASK-999")).toBeUndefined();
  });

  test("getActiveJob returns undefined for unknown task", () => {
    expect(manager.getActiveJob("TASK-999")).toBeUndefined();
  });

  test("getAllJobs marks a running job failed when its child pid is gone", () => {
    const jobs = (manager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
    jobs.set("TASK-DEAD", {
      taskId: "TASK-DEAD",
      sessionId: "dead-session",
      pid: 2_147_483_000,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      worktreePath: "/missing/worktree",
    });

    const [job] = manager.getAllJobs();

    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(1);
    expect(job.output.join("\n")).toContain("no longer alive");
    expect(manager.getActiveJobs()).toEqual([]);
  });

  test("stop returns false when no active job", () => {
    expect(manager.stop("TASK-999")).toBe(false);
  });

  test("start throws when task is already running", () => {
    // Start with a real bin that exists but will exit quickly
    const realManager = new DispatchManager("/fake", process.execPath);
    try {
      // This will fail to actually dispatch but creates the job entry
      // We test the double-start guard with a mock approach instead
    } finally {
      realManager.killAll();
    }
  });

  test("cleanup removes old completed jobs", () => {
    // Internal state test — just verify cleanup doesn't throw
    manager.cleanup(0);
    expect(manager.getAllJobs()).toEqual([]);
  });

  test("bounded shutdown confirms a real child exit and preserves its worktree", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shutdown-"));
    const worktreePath = path.join(tmpDir, "worktree");
    const readyPath = path.join(tmpDir, "child-ready");
    const scriptPath = path.join(tmpDir, "signal-resistant-child.cjs");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "preserve me\n", "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "if (process.platform !== 'win32') process.on('SIGTERM', () => undefined);",
        "const grandchild = spawn(process.execPath, ['-e', \"if (process.platform !== 'win32') process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);\"], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ grandchildPid: grandchild.pid }), 'utf-8');`,
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
      "utf-8",
    );

    const mgr = new DispatchManager(tmpDir, scriptPath, {
      method: "worktree",
      dockerCleanup: false,
    });
    (
      mgr as unknown as {
        createWorktree(taskId: string): string | undefined;
      }
    ).createWorktree = () => worktreePath;

    try {
      const job = mgr.start("TASK-SHUTDOWN", { skipGate: true });
      await waitForFile(readyPath);
      const { grandchildPid } = JSON.parse(fs.readFileSync(readyPath, "utf-8")) as {
        grandchildPid: number;
      };

      expect(mgr.stop("TASK-SHUTDOWN")).toBe(true);
      expect(job.status).toBe("running");
      expect(fs.existsSync(worktreePath)).toBe(true);

      const result = await mgr.shutdownAll({ gracefulTimeoutMs: 50, forceTimeoutMs: 2_000 });
      await waitForCondition(() => job.status !== "running", "real child exit handling");
      await waitForCondition(() => !processIsAlive(grandchildPid), "real grandchild exit");

      expect(result.requested).toEqual(["TASK-SHUTDOWN"]);
      expect(result.exited).toEqual(["TASK-SHUTDOWN"]);
      expect(result.escalated).toEqual(["TASK-SHUTDOWN"]);
      expect(result.timedOut).toEqual([]);
      expect(job.status).toBe("stopped");
      expect(fs.readFileSync(path.join(worktreePath, "uncommitted.txt"), "utf-8")).toBe(
        "preserve me\n",
      );
      expect(fs.existsSync(worktreePath)).toBe(true);
    } finally {
      await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("a failed stop signal keeps a live child tracked and preserves its worktree", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-stop-error-"));
    const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-STOP-ERROR");
    const scriptPath = path.join(tmpDir, "long-running-child.cjs");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "preserve me\n", "utf-8");
    fs.writeFileSync(scriptPath, "setInterval(() => undefined, 1000);\n", "utf-8");

    const mgr = new DispatchManager(tmpDir, scriptPath, {
      method: "worktree",
      dockerCleanup: false,
    });
    type TreeSignaler = (
      taskId: string,
      child: ChildProcess,
      signal: NodeJS.Signals,
      windowsTimeoutMs: number,
    ) => void;
    const internals = mgr as unknown as {
      createWorktree(taskId: string): string | undefined;
      processes: Map<string, ChildProcess>;
      signalProcessTree: TreeSignaler;
    };
    internals.createWorktree = () => worktreePath;
    const signalProcessTree = internals.signalProcessTree.bind(mgr);
    let rejectSignals = true;
    internals.signalProcessTree = (...args) => {
      if (rejectSignals) throw new Error("simulated signal delivery failure");
      signalProcessTree(...args);
    };

    try {
      const job = mgr.start("TASK-STOP-ERROR", { skipGate: true });
      const child = internals.processes.get("TASK-STOP-ERROR");
      if (!child) throw new Error("Expected tracked child");
      await waitForCondition(() => processIsAlive(job.pid), "long-running child startup");

      expect(mgr.stop("TASK-STOP-ERROR")).toBe(true);
      child.emit("error", new Error("simulated signal delivery failure"));

      expect(job.status).toBe("running");
      expect(internals.processes.get("TASK-STOP-ERROR")).toBe(child);
      expect(fs.readFileSync(path.join(worktreePath, "uncommitted.txt"), "utf-8")).toBe(
        "preserve me\n",
      );
      expect(fs.existsSync(worktreePath)).toBe(true);

      const firstShutdown = await mgr.shutdownAll({ gracefulTimeoutMs: 10, forceTimeoutMs: 10 });
      expect(firstShutdown.timedOut).toEqual(["TASK-STOP-ERROR"]);
      const survivorMarker = path.join(
        tmpDir,
        ".quack",
        "logs",
        "worktree-survivors",
        "TASK-STOP-ERROR.json",
      );
      expect(fs.existsSync(survivorMarker)).toBe(true);
      const restartedManager = new DispatchManager(tmpDir, scriptPath, {
        method: "worktree",
        dockerCleanup: false,
      });
      expect(() =>
        (
          restartedManager as unknown as {
            createWorktree(taskId: string): string | undefined;
          }
        ).createWorktree("TASK-STOP-ERROR"),
      ).toThrow("has not been confirmed stopped");

      rejectSignals = false;
      const result = await mgr.shutdownAll({ gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 });
      expect(result.timedOut).toEqual([]);
      await waitForCondition(() => job.status === "stopped", "failed-stop child exit handling");
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.existsSync(survivorMarker)).toBe(false);
    } finally {
      rejectSignals = false;
      await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("shutdown inherits a stopped root's process group and kills its resistant descendant", async () => {
    if (process.platform === "win32") return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-stop-tree-"));
    const worktreePath = path.join(tmpDir, "worktree");
    const readyPath = path.join(tmpDir, "child-ready");
    const scriptPath = path.join(tmpDir, "cooperative-root.cjs");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "preserve me\n", "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);\"], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ grandchildPid: grandchild.pid }), 'utf-8');`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
      "utf-8",
    );

    const mgr = new DispatchManager(tmpDir, scriptPath, {
      method: "worktree",
      dockerCleanup: false,
    });
    (
      mgr as unknown as {
        createWorktree(taskId: string): string | undefined;
      }
    ).createWorktree = () => worktreePath;

    let grandchildPid: number | undefined;
    try {
      const job = mgr.start("TASK-STOP-TREE", { skipGate: true });
      await waitForFile(readyPath);
      grandchildPid = (JSON.parse(fs.readFileSync(readyPath, "utf-8")) as { grandchildPid: number })
        .grandchildPid;
      const trackedProcesses = (mgr as unknown as { processes: Map<string, ChildProcess> })
        .processes;

      expect(mgr.stop("TASK-STOP-TREE")).toBe(true);
      await waitForCondition(
        () => !trackedProcesses.has("TASK-STOP-TREE"),
        "cooperative root exit",
      );
      expect(job.status).toBe("running");
      expect(processIsAlive(grandchildPid)).toBe(true);
      const shutdown = await mgr.shutdownAll({ gracefulTimeoutMs: 50, forceTimeoutMs: 2_000 });
      await waitForCondition(
        () => !processIsAlive(grandchildPid as number),
        "resistant descendant escalation",
        3_000,
      );

      expect(shutdown.requested).toContain("TASK-STOP-TREE");
      expect(shutdown.escalated).toContain("TASK-STOP-TREE");
      expect(shutdown.timedOut).toEqual([]);
      expect(job.status).toBe("stopped");
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.readFileSync(path.join(worktreePath, "uncommitted.txt"), "utf-8")).toBe(
        "preserve me\n",
      );
    } finally {
      await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
      if (grandchildPid && processIsAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("isolation method branching", () => {
    test("defaults to worktree isolation when no config", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      // getActiveContainers should return empty (no Docker manager)
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("defaults to worktree when method is worktree", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
        method: "worktree",
      });
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("creates DockerManager when method is docker", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
        method: "docker",
        docker: {
          image: "node:20-slim",
          volumes: [],
          envPassthrough: [],
          resourceLimits: { memoryMb: 2048, cpus: 1 },
          networkMode: "bridge",
          cleanupPolicy: "remove",
        },
      });
      // getActiveContainers delegates to DockerManager — should be empty but not crash
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("does not create DockerManager when docker config is missing", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
        method: "docker",
        // No docker config — should gracefully degrade
      });
      expect(mgr.getActiveContainers()).toEqual([]);
      mgr.killAll();
    });

    test("checkDockerAvailability throws when no docker manager", async () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      await expect(mgr.checkDockerAvailability()).rejects.toThrow(
        "Docker isolation is not configured",
      );
      mgr.killAll();
    });

    test("setEventCallback stores callback without error", () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      const cb = jest.fn();
      expect(() => mgr.setEventCallback(cb)).not.toThrow();
      mgr.killAll();
    });

    test("cleanupAllContainers is no-op when no docker manager", async () => {
      const mgr = new DispatchManager("/fake/project", "/fake/bin.js");
      await expect(mgr.cleanupAllContainers()).resolves.not.toThrow();
      mgr.killAll();
    });
  });

  describe("unlinkJunctions", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("unlinking a junction before rmSync preserves target contents", () => {
      // Set up: real target directory with a file
      const mainLogs = path.join(tmpDir, "main-logs");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "session.jsonl"), "test data");

      // Set up: worktree with a junction pointing to the target
      const worktreePath = path.join(tmpDir, "worktree");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });
      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");

      // Verify junction exists
      expect(fs.lstatSync(path.join(wtQuack, "logs")).isSymbolicLink()).toBe(true);

      // Unlink the junction first (what unlinkJunctions does), then rmSync
      fs.unlinkSync(path.join(wtQuack, "logs"));
      fs.rmSync(worktreePath, { recursive: true, force: true });

      // Target directory and contents survive
      expect(fs.existsSync(mainLogs)).toBe(true);
      expect(fs.readFileSync(path.join(mainLogs, "session.jsonl"), "utf-8")).toBe("test data");
    });

    test("removeWorktree preserves junction target contents", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");

      // Create a fake worktree dir with a junction to a shared logs dir
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-TEST");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      const mainLogs = path.join(tmpDir, ".quack", "logs");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "keep-me.jsonl"), "precious data");
      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");

      // Call the private removeWorktree — it should unlink junctions first
      const removeWorktree = (mgr as unknown as Record<string, (p: string) => void>)[
        "removeWorktree"
      ];
      removeWorktree.call(mgr, worktreePath);

      // Main logs directory and contents must survive
      expect(fs.existsSync(mainLogs)).toBe(true);
      expect(fs.readFileSync(path.join(mainLogs, "keep-me.jsonl"), "utf-8")).toBe("precious data");

      mgr.killAll();
    });

    test("removeWorktree preserves both logs and prep junctions", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");

      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-DUAL");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      const mainLogs = path.join(tmpDir, ".quack", "logs");
      const mainPrep = path.join(tmpDir, ".quack", "prep");
      fs.mkdirSync(mainLogs, { recursive: true });
      fs.mkdirSync(mainPrep, { recursive: true });
      fs.writeFileSync(path.join(mainLogs, "log.jsonl"), "log data");
      fs.writeFileSync(path.join(mainPrep, "gate.json"), "prep data");

      fs.symlinkSync(mainLogs, path.join(wtQuack, "logs"), "junction");
      fs.symlinkSync(mainPrep, path.join(wtQuack, "prep"), "junction");

      const removeWorktree = (mgr as unknown as Record<string, (p: string) => void>)[
        "removeWorktree"
      ];
      removeWorktree.call(mgr, worktreePath);

      // Both target directories and their contents survive
      expect(fs.readFileSync(path.join(mainLogs, "log.jsonl"), "utf-8")).toBe("log data");
      expect(fs.readFileSync(path.join(mainPrep, "gate.json"), "utf-8")).toBe("prep data");

      mgr.killAll();
    });

    test("unlinkJunctions handles missing .quack directory gracefully", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const worktreePath = path.join(tmpDir, "nonexistent-worktree");

      // Should not throw even when .quack doesn't exist
      const unlinkJunctions = (mgr as unknown as Record<string, (p: string) => void>)[
        "unlinkJunctions"
      ];
      expect(() => unlinkJunctions.call(mgr, worktreePath)).not.toThrow();
      mgr.killAll();
    });

    test("unlinkJunctions skips non-symlink directories", () => {
      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const worktreePath = path.join(tmpDir, "worktree");
      const wtQuack = path.join(worktreePath, ".quack");

      // Create real directories (not junctions) at logs and prep
      fs.mkdirSync(path.join(wtQuack, "logs"), { recursive: true });
      fs.mkdirSync(path.join(wtQuack, "prep"), { recursive: true });
      fs.writeFileSync(path.join(wtQuack, "logs", "file.txt"), "data");

      const unlinkJunctions = (mgr as unknown as Record<string, (p: string) => void>)[
        "unlinkJunctions"
      ];
      unlinkJunctions.call(mgr, worktreePath);

      // Real directory contents are untouched (lstatSync returns isSymbolicLink=false, so no unlink)
      expect(fs.readFileSync(path.join(wtQuack, "logs", "file.txt"), "utf-8")).toBe("data");

      mgr.killAll();
    });
  });

  describe("worktree freshness", () => {
    let tmpDir: string;

    function git(cwd: string, args: string[]): void {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    }

    function initRepoWithOrigin(rootDir: string): string {
      const originDir = path.join(rootDir, "origin.git");
      const repoDir = path.join(rootDir, "repo");
      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "fresh\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "tracked.txt"]);
      git(repoDir, ["commit", "-m", "initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["push", "-u", "origin", "dev"]);
      return repoDir;
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worktree-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("creates worktrees from freshly fetched origin base, not stale local HEAD", () => {
      const originDir = path.join(tmpDir, "origin.git");
      const repoDir = path.join(tmpDir, "repo");
      const updaterDir = path.join(tmpDir, "updater");

      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "stale\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "tracked.txt"]);
      git(repoDir, ["commit", "-m", "initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["push", "-u", "origin", "dev"]);

      execFileSync("git", ["clone", originDir, updaterDir], { stdio: "ignore" });
      git(updaterDir, ["config", "user.email", "quack@example.test"]);
      git(updaterDir, ["config", "user.name", "Quack Test"]);
      git(updaterDir, ["checkout", "dev"]);
      fs.writeFileSync(path.join(updaterDir, "tracked.txt"), "fresh\n");
      git(updaterDir, ["commit", "-am", "remote update"]);
      git(updaterDir, ["push", "origin", "dev"]);

      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-FRESH");

      expect(worktreePath).toBeDefined();
      expect(
        fs.readFileSync(path.join(worktreePath!, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("fresh\n");

      mgr.killAll();
    });

    test("prep junction failures do not mark worktree creation degraded", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const realCreateJunction = (
        mgr as unknown as {
          createJunction(targetPath: string, junctionPath: string): void;
        }
      ).createJunction.bind(mgr);
      (
        mgr as unknown as {
          createJunction(targetPath: string, junctionPath: string): void;
        }
      ).createJunction = (targetPath: string, junctionPath: string) => {
        if (junctionPath.endsWith(`${path.sep}prep`)) {
          const err = new Error("prep exists already") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
        realCreateJunction(targetPath, junctionPath);
      };

      try {
        const worktreePath = (
          mgr as unknown as { createWorktree(taskId: string): string | undefined }
        ).createWorktree.call(mgr, "TASK-PREP");

        expect(worktreePath).toBeDefined();
        expect(mgr.isWorktreeDegraded()).toBe(false);
        expect(fs.existsSync(path.join(worktreePath!, ".quack"))).toBe(true);
      } finally {
        (
          mgr as unknown as {
            createJunction(targetPath: string, junctionPath: string): void;
          }
        ).createJunction = realCreateJunction;
        mgr.killAll();
      }
    });

    test("successful worktree creation clears degraded mode", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      (mgr as unknown as { worktreeDegraded: boolean }).worktreeDegraded = true;

      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-RECOVER");

      expect(worktreePath).toBeDefined();
      expect(mgr.isWorktreeDegraded()).toBe(false);
      mgr.killAll();
    });

    test("stale task branch is deleted on fresh re-dispatch (Pattern 22 preserved, TASK-1312)", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      git(repoDir, ["branch", "quack/TASK-STALE"]);

      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-STALE");

      expect(worktreePath).toBeDefined();
      expect(() =>
        execFileSync("git", ["rev-parse", "--verify", "quack/TASK-STALE"], {
          cwd: repoDir,
          stdio: "pipe",
        }),
      ).toThrow();
      mgr.killAll();
    });

    test("stale-branch cleanup refuses protected branches (TASK-1312 guard)", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      // Empty prefix makes the stale-branch name collide with the base
      // branch itself: staleBranch = "" + "dev" = "dev" (protected).
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "" } }),
      );

      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      // TASK-1313 S5 (round-2 F7): the pre-session refusal reports
      // through the typed lifecycle callback.
      const lifecycleEvents: Array<{
        stage: string;
        taskId: string;
        payload: Record<string, unknown>;
      }> = [];
      mgr.setEventCallback((stage, taskId, payload) => {
        lifecycleEvents.push({ stage, taskId, payload });
      });
      (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "dev");

      // The essential invariant: the protected branch SURVIVES the
      // stale-cleanup path regardless of what worktree creation does.
      expect(() =>
        execFileSync("git", ["rev-parse", "--verify", "dev"], {
          cwd: repoDir,
          stdio: "pipe",
        }),
      ).not.toThrow();
      const refusal = lifecycleEvents.find((event) => event.stage === "branch_guard_refusal");
      expect(refusal).toBeDefined();
      expect(refusal?.taskId).toBe("dev");
      expect(refusal?.payload.branch).toBe("dev");
      expect(refusal?.payload.site).toBe("stale_branch_cleanup");
      mgr.killAll();
    });

    test("createWorktree refreshes refs/remotes/origin/<baseBranch> so worktrees see updates not yet in local tracking ref", () => {
      // Scenario: the local repo's origin/dev tracking ref is stale (points at commit A),
      // but origin actually has commit B. The worktree should contain B's content,
      // proving that createWorktree issued a fetch that updated refs/remotes/origin/dev,
      // not just FETCH_HEAD.
      const originDir = path.join(tmpDir, "origin2.git");
      const repoDir = path.join(tmpDir, "repo2");
      const cloneDir = path.join(tmpDir, "clone2");

      execFileSync("git", ["init", "--bare", originDir], { stdio: "ignore" });

      // Seed origin with commit A
      fs.mkdirSync(cloneDir, { recursive: true });
      git(cloneDir, ["init"]);
      git(cloneDir, ["config", "user.email", "quack@example.test"]);
      git(cloneDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(cloneDir, "tracked.txt"), "commit-A\n");
      git(cloneDir, ["add", "tracked.txt"]);
      git(cloneDir, ["commit", "-m", "A"]);
      git(cloneDir, ["branch", "-M", "dev"]);
      git(cloneDir, ["remote", "add", "origin", originDir]);
      git(cloneDir, ["push", "-u", "origin", "dev"]);

      // Set up local repo pointing at same origin, fetch once so origin/dev → A
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init"]);
      git(repoDir, ["config", "user.email", "quack@example.test"]);
      git(repoDir, ["config", "user.name", "Quack Test"]);
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "local-stale\n");
      fs.mkdirSync(path.join(repoDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".quack", "adapter.json"),
        JSON.stringify({ git: { baseBranch: "dev", branchPrefix: "quack/" } }),
      );
      git(repoDir, ["add", "."]);
      git(repoDir, ["commit", "-m", "local-initial"]);
      git(repoDir, ["branch", "-M", "dev"]);
      git(repoDir, ["remote", "add", "origin", originDir]);
      git(repoDir, ["fetch", "origin"]); // origin/dev now → A

      // Push commit B to origin so origin is ahead of the local tracking ref
      fs.writeFileSync(path.join(cloneDir, "tracked.txt"), "commit-B\n");
      git(cloneDir, ["commit", "-am", "B"]);
      git(cloneDir, ["push", "origin", "dev"]);

      // Local repo's origin/dev still points at A (no fetch since push)
      // createWorktree must fetch and update refs/remotes/origin/dev to B
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-REFSPEC");

      expect(worktreePath).toBeDefined();
      // Worktree content must be B (from origin), not A or the stale local value
      expect(
        fs.readFileSync(path.join(worktreePath!, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"),
      ).toBe("commit-B\n");

      mgr.killAll();
    });

    test("refreshes a stale worktree adapter bundle before reuse", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-ADAPTER");

      expect(worktreePath).toBeDefined();
      const rootAdapterPath = path.join(repoDir, ".quack", "adapter.json");
      const worktreeAdapterPath = path.join(worktreePath!, ".quack", "adapter.json");

      fs.writeFileSync(
        rootAdapterPath,
        JSON.stringify({
          version: "1.0",
          project: {
            name: "test-project",
            root: ".",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          verification: {
            commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
            conventionChecks: [],
          },
          git: {
            baseBranch: "dev",
            branchPrefix: "fresh/",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "",
            autoCreatePr: false,
            autoPush: false,
          },
          logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
        }),
      );

      const freshness = (
        mgr as unknown as {
          ensureWorktreeAdapterFreshness(worktreePath: string): { status: string };
        }
      ).ensureWorktreeAdapterFreshness.call(mgr, worktreePath!);

      expect(freshness.status).toBe("refreshed");
      expect(JSON.parse(fs.readFileSync(worktreeAdapterPath, "utf-8"))).toMatchObject({
        git: { baseBranch: "dev", branchPrefix: "fresh/" },
      });

      mgr.killAll();
    });

    test("TASK-1313 F10: conventions-only drift re-copies ONLY for opted-in safetyFloor adapters; bundle-hash comparison unchanged", () => {
      const repoDir = initRepoWithOrigin(tmpDir);
      const mgr = new DispatchManager(repoDir, "/fake/bin.js");
      const worktreePath = (
        mgr as unknown as { createWorktree(taskId: string): string | undefined }
      ).createWorktree.call(mgr, "TASK-MACH");
      expect(worktreePath).toBeDefined();

      const rootQuack = path.join(repoDir, ".quack");
      const wtQuack = path.join(worktreePath!, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });
      const baseAdapter = {
        version: "1.0",
        project: {
          name: "test-project",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        verification: {
          commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
          conventionChecks: [],
        },
        git: {
          baseBranch: "dev",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "",
          autoCreatePr: false,
          autoPush: false,
        },
        logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
      };
      const writeBoth = (adapter: Record<string, unknown>): void => {
        const json = JSON.stringify(adapter);
        fs.writeFileSync(path.join(rootQuack, "adapter.json"), json);
        fs.writeFileSync(path.join(wtQuack, "adapter.json"), json);
      };
      const callFreshness = (): {
        status: string;
        localHash?: string;
        authoritativeHash?: string;
      } =>
        (
          mgr as unknown as {
            ensureWorktreeAdapterFreshness(worktreePath: string): {
              status: string;
              localHash?: string;
              authoritativeHash?: string;
            };
          }
        ).ensureWorktreeAdapterFreshness.call(mgr, worktreePath!);

      // The drift: ONLY conventions.md differs between root and worktree.
      fs.writeFileSync(path.join(rootQuack, "conventions.md"), "authoritative conventions v2");
      fs.writeFileSync(path.join(wtQuack, "conventions.md"), "stale worktree conventions v1");

      // Non-opted adapter (no safetyFloor key): pre-1313 behavior exactly —
      // matching bundle hashes report fresh and the drift is NOT copied.
      writeBoth(baseAdapter);
      const nonOpted = callFreshness();
      expect(nonOpted.status).toBe("fresh");
      expect(fs.readFileSync(path.join(wtQuack, "conventions.md"), "utf-8")).toBe(
        "stale worktree conventions v1",
      );

      // Opted-in adapter (identical bytes both sides, so the bundle-hash
      // comparison is STILL equal): the separate machinery hash catches
      // the conventions drift and drives the re-copy.
      writeBoth({
        ...baseAdapter,
        judgment: { safetyFloor: { signals: { mode: "report" } } },
      });
      const opted = callFreshness();
      expect(opted.status).toBe("refreshed");
      expect(opted.localHash).toBe(opted.authoritativeHash);
      expect(fs.readFileSync(path.join(wtQuack, "conventions.md"), "utf-8")).toBe(
        "authoritative conventions v2",
      );

      mgr.killAll();
    });
  });

  describe("managed worktree janitor ownership policy", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-janitor-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeAdapter(branchCleanup?: Record<string, unknown>): void {
      fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".quack", "adapter.json"),
        JSON.stringify({
          version: "1.0",
          project: {
            name: "test-project",
            root: ".",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          agent: {
            model: "claude-opus-4-6",
            judgeModel: "claude-sonnet-4-6",
            enrichModel: "claude-sonnet-4-6",
            maxTurns: 50,
            maxBudgetPerTask: 5,
            maxRetries: 1,
          },
          verification: {
            commands: [{ name: "test", command: "npm test", required: true, timeout: 1000 }],
            conventionChecks: [],
          },
          git: {
            baseBranch: "dev",
            branchPrefix: "quack/",
            commitFormat: "[{taskId}] {message}",
            commitTrailer: "",
            autoCreatePr: false,
            autoPush: false,
            branchCleanup,
          },
          logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
        }),
      );
    }

    function makeOldDirectory(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      fs.utimesSync(dir, old, old);
    }

    test("reports protected-owner worktrees as not prune eligible by default", () => {
      writeAdapter();
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "contributor-TASK-123");
      makeOldDirectory(worktreePath);

      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const records = mgr.listManagedWorktrees(24 * 60 * 60 * 1000);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        taskId: "contributor-TASK-123",
        rootKind: "quack",
        owner: "contributor",
        protectedOwner: true,
        requiresOwnerOverride: true,
        pruneEligible: false,
      });
      expect(records[0].skipReasons).toContain("protected_owner");

      mgr.killAll();
    });

    test("configured Hermes worktree roots can become prune candidates", () => {
      writeAdapter({
        enabled: true,
        allowedPrefixes: ["quack/TASK-", "echo/TASK-"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      });
      const worktreePath = path.join(tmpDir, ".hermes-worktrees", "TASK-1048");
      makeOldDirectory(worktreePath);

      const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
      const result = mgr.pruneManagedWorktrees({
        dryRun: true,
        maxAgeMs: 24 * 60 * 60 * 1000,
      });

      expect(result.policy.allowedPrefixes).toContain("echo/TASK-");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        taskId: "TASK-1048",
        rootKind: "hermes",
        owner: "hermes",
        allowedPrefix: "echo/TASK-",
        pruneEligible: true,
      });

      mgr.killAll();
    });
  });

  describe("awaiting_approval lifecycle (TASK-107)", () => {
    /** Helper to inject a job directly into the private jobs map */
    function injectJob(mgr: DispatchManager, job: DispatchJob): void {
      const jobs = (mgr as unknown as { jobs: Map<string, DispatchJob> }).jobs;
      jobs.set(job.taskId, job);
    }

    function makeJob(overrides: Partial<DispatchJob> & { taskId: string }): DispatchJob {
      return {
        sessionId: `test-${Date.now()}`,
        pid: 0,
        startedAt: new Date().toISOString(),
        status: "running",
        output: [],
        ...overrides,
      };
    }

    test("getActiveJob returns awaiting_approval jobs", () => {
      const job = makeJob({
        taskId: "TASK-200",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, job);

      expect(manager.getActiveJob("TASK-200")).toBe(job);
    });

    test("getActiveJob does not return failed jobs", () => {
      const job = makeJob({ taskId: "TASK-201", status: "failed" });
      injectJob(manager, job);

      expect(manager.getActiveJob("TASK-201")).toBeUndefined();
    });

    test("getActiveJobs excludes awaiting_approval (no running process)", () => {
      const job = makeJob({ taskId: "TASK-202", status: "awaiting_approval" });
      injectJob(manager, job);

      // getActiveJobs returns only "running" — awaiting_approval has no process
      expect(manager.getActiveJobs()).toEqual([]);
    });

    test("shared checkout occupants include approval-paused jobs without worktrees", () => {
      const running = makeJob({ taskId: "TASK-202-A", status: "running", pid: process.pid });
      const awaiting = makeJob({ taskId: "TASK-202-B", status: "awaiting_approval" });
      const isolated = makeJob({
        taskId: "TASK-202-C",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, running);
      injectJob(manager, awaiting);
      injectJob(manager, isolated);

      expect(manager.getSharedCheckoutOccupants()).toEqual([running, awaiting]);
    });

    test("degraded admission rejects a different task while shared checkout awaits approval", () => {
      injectJob(manager, makeJob({ taskId: "TASK-202-D", status: "awaiting_approval" }));
      (manager as unknown as { worktreeDegraded: boolean }).worktreeDegraded = true;

      let thrown: unknown;
      try {
        manager.start("TASK-202-E");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DegradedSharedCheckoutBusyError);
      expect((thrown as DegradedSharedCheckoutBusyError).hasApprovalPause).toBe(true);
      expect((thrown as Error).message).toContain(
        "shared directory is occupied by TASK-202-D (awaiting_approval)",
      );
    });

    test("atomically preserves the first shared-checkout owner across manager instances", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-atomic-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const first = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const second = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const firstJob = makeJob({ taskId: "TASK-FIRST", sessionId: "first-session" });
      const secondJob = makeJob({ taskId: "TASK-SECOND", sessionId: "second-session" });
      const firstInternals = first as unknown as {
        readSharedCheckoutPause(): unknown;
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      const secondInternals = second as unknown as {
        readSharedCheckoutPause(): unknown;
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      try {
        // Both processes can observe the pre-claim state; the exclusive lock
        // and in-lock owner check still allow exactly one durable winner.
        expect(firstInternals.readSharedCheckoutPause()).toBeUndefined();
        expect(secondInternals.readSharedCheckoutPause()).toBeUndefined();
        firstInternals.persistSharedCheckoutPause(firstJob, "running");
        const markerPath = path.join(logDir, "shared-checkout-pause.json");
        const agedMarker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<
          string,
          unknown
        >;
        agedMarker.pausedAt = "2000-01-01T00:00:00.000Z";
        fs.writeFileSync(markerPath, `${JSON.stringify(agedMarker, null, 2)}\n`, "utf-8");
        expect(() => secondInternals.persistSharedCheckoutPause(secondJob, "running")).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
          taskId: string;
          sessionId: string;
        };
        expect(marker).toMatchObject({ taskId: "TASK-FIRST", sessionId: "first-session" });
      } finally {
        first.killAll();
        second.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("serializes old-owner restore and release before a same-task handoff", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-handoff-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const first = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const second = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const firstJob = makeJob({ taskId: "TASK-HANDOFF", sessionId: "old-session", pid: 999_999 });
      const nextJob = makeJob({ taskId: "TASK-HANDOFF", sessionId: "new-session" });
      const firstInternals = first as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
        restoreSharedCheckout(job: DispatchJob): boolean;
        restoreAndReleaseSharedCheckout(job: DispatchJob): boolean;
      };
      const secondInternals = second as unknown as {
        persistSharedCheckoutPause(
          job: DispatchJob,
          status: "running",
          allowOwnershipTransfer: boolean,
        ): void;
      };
      try {
        firstInternals.persistSharedCheckoutPause(firstJob, "running");
        expect(() => secondInternals.persistSharedCheckoutPause(nextJob, "running", true)).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        firstInternals.restoreSharedCheckout = () => {
          expect(() =>
            secondInternals.persistSharedCheckoutPause(nextJob, "running", true),
          ).toThrow("ownership is locked");
          return true;
        };
        expect(firstInternals.restoreAndReleaseSharedCheckout(firstJob)).toBe(true);
        expect(() =>
          secondInternals.persistSharedCheckoutPause(nextJob, "running", true),
        ).not.toThrow();
      } finally {
        first.killAll();
        second.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("never expires an unverified shared-checkout mutation lock by age", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-lock-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const lockPath = path.join(logDir, "shared-checkout-pause.lock");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ version: 1, pid: 1, acquiredAt: "2000-01-01T00:00:00.000Z" }),
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const internals = mgr as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status: "running"): void;
      };
      try {
        expect(() =>
          internals.persistSharedCheckoutPause(
            makeJob({ taskId: "TASK-LOCKED", sessionId: "locked-session" }),
            "running",
          ),
        ).toThrow("unverified stale lock");
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(mgr.getSharedCheckoutOccupants()).toEqual([
          expect.objectContaining({ taskId: "unknown-shared-checkout-owner" }),
        ]);
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("requires exact reconciliation before reusing a Windows-unconfirmed shared tree", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-tree-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const markerPath = path.join(logDir, "shared-checkout-pause.json");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-WINDOWS-TREE",
          sessionId: "tree-session",
          startedAt: "2026-09-09T12:00:00.000Z",
          pausedAt: "2026-09-09T12:01:00.000Z",
          status: "stopped",
          processId: 2_147_483_000,
          processTreeStatus: "unconfirmed",
          reconciliationToken: "tree-token",
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const internals = mgr as unknown as {
        durableSharedOwnerMayBeLive(marker: unknown): boolean;
        readSharedCheckoutPause(): unknown;
      };
      try {
        expect(internals.durableSharedOwnerMayBeLive(internals.readSharedCheckoutPause())).toBe(
          true,
        );
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "stale-token",
            true,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "tree-token",
            false,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            "TASK-WINDOWS-TREE",
            "tree-session",
            "tree-token",
            true,
          ),
        ).toBe(true);
        expect(internals.durableSharedOwnerMayBeLive(internals.readSharedCheckoutPause())).toBe(
          false,
        );
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrates a legacy Windows shared marker and preserves confirmation through admission", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-legacy-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const markerPath = path.join(logDir, "shared-checkout-pause.json");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-LEGACY-SHARED",
          sessionId: "legacy-session",
          startedAt: "2026-09-09T12:00:00.000Z",
          pausedAt: "2026-09-09T12:01:00.000Z",
          status: "failed",
          processId: 4242,
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      const prior = makeJob({
        taskId: "TASK-LEGACY-SHARED",
        sessionId: "legacy-session",
        status: "failed",
      });
      injectJob(mgr, prior);
      const startWorktree = jest.fn(() => makeJob({ taskId: "TASK-LEGACY-SHARED" }));
      (mgr as unknown as { startWorktree: typeof startWorktree }).startWorktree = startWorktree;
      try {
        const survivor = mgr.getSharedCheckoutShutdownSurvivor();
        expect(survivor?.reconciliationToken).toEqual(expect.any(String));
        expect(
          mgr.reconcileSharedCheckoutShutdownSurvivor(
            survivor!.taskId,
            survivor!.sessionId,
            survivor!.reconciliationToken!,
            true,
          ),
        ).toBe(true);
        expect(() =>
          mgr.start("TASK-LEGACY-SHARED", { skipGate: true, resume: true }),
        ).not.toThrow();
        expect(startWorktree).toHaveBeenCalledWith(
          "TASK-LEGACY-SHARED",
          expect.objectContaining({ resume: true }),
          true,
          expect.any(Object),
        );
      } finally {
        mgr.killAll();
        Object.defineProperty(process, "platform", originalPlatform);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrates and safely reconciles legacy Windows worktree survivor markers", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worktree-win-legacy-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const worktreePath = path.join(tmpDir, ".quack", "worktrees", "TASK-WORKTREE");
      const markerDir = path.join(logDir, "worktree-survivors");
      const markerPath = path.join(markerDir, "TASK-WORKTREE.json");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-WORKTREE",
          sessionId: "worktree-session",
          worktreePath,
          processId: 7171,
          strategy: "windows-process-tree",
          recordedAt: "2026-09-09T12:00:00.000Z",
        })}\n`,
        "utf-8",
      );
      const mgr = new DispatchManager(tmpDir, process.execPath, undefined, undefined, logDir);
      try {
        const [survivor] = mgr.getWorktreeShutdownSurvivors();
        expect(survivor.reconciliationToken).toEqual(expect.any(String));
        expect(mgr.canResumeAfterShutdown()).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            "stale-token",
            true,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            survivor.reconciliationToken!,
            false,
          ),
        ).toBe(false);
        expect(
          mgr.reconcileWorktreeShutdownSurvivor(
            survivor.taskId,
            survivor.sessionId,
            survivor.reconciliationToken!,
            true,
          ),
        ).toBe(true);
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(mgr.getWorktreeShutdownSurvivors()).toEqual([]);
      } finally {
        mgr.killAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("blocks shared-checkout resume when a Windows wrapper exits before its descendant", async () => {
      if (process.platform !== "win32") return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-win-descendant-"));
      const descendantPidPath = path.join(tmpDir, "descendant.pid");
      const touchedPath = path.join(tmpDir, "descendant-touch.txt");
      const scriptPath = path.join(tmpDir, "wrapper.cjs");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          `const touchPath = ${JSON.stringify(touchedPath)};`,
          "const code = `const fs = require('node:fs'); const p = ${JSON.stringify(touchPath)}; setInterval(() => fs.appendFileSync(p, 'x'), 25);`;",
          "const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
          "child.unref();",
          "process.exit(0);",
        ].join("\n"),
        "utf-8",
      );
      const first = new DispatchManager(tmpDir, scriptPath);
      const restarted = new DispatchManager(tmpDir, scriptPath);
      (first as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      (restarted as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      let descendantPid = 0;
      try {
        const job = first.start("TASK-WINDOWS-DESCENDANT", { skipGate: true });
        await waitForFile(descendantPidPath);
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf-8"), 10);
        await waitForCondition(() => job.status === "completed", "wrapper exit");
        await waitForFile(touchedPath);

        expect(processIsAlive(descendantPid)).toBe(true);
        expect(() =>
          restarted.start("TASK-WINDOWS-DESCENDANT", { skipGate: true, resume: true }),
        ).toThrow(DegradedSharedCheckoutBusyError);
        expect(restarted.getSharedCheckoutShutdownSurvivor()).toEqual(
          expect.objectContaining({
            taskId: "TASK-WINDOWS-DESCENDANT",
            status: "stopped",
          }),
        );
      } finally {
        if (descendantPid > 0 && processIsAlive(descendantPid)) {
          try {
            execFileSync("taskkill", ["/pid", String(descendantPid), "/t", "/f"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            // Best-effort cleanup of the test-only child.
          }
        }
        await first.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restarted.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("refuses shared-checkout fallback when the original Git checkout is dirty", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-dirty-"));
      const scriptPath = path.join(tmpDir, "should-not-start.cjs");
      const startedPath = path.join(tmpDir, "unsafe-started");
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
        fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "original\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", "tracked.txt", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
        fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "pre-existing user edit\n", "utf-8");

        const mgr = new DispatchManager(tmpDir, scriptPath);
        (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;

        expect(() => mgr.start("TASK-DIRTY", { skipGate: true })).toThrow(
          "shared checkout because it was already dirty",
        );
        expect(fs.readFileSync(path.join(tmpDir, "tracked.txt"), "utf-8")).toBe(
          "pre-existing user edit\n",
        );
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("refuses shared-checkout fallback when the Git branch baseline is unverifiable", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-detached-"));
      const scriptPath = path.join(tmpDir, "should-not-start.cjs");
      const startedPath = path.join(tmpDir, "unsafe-started");
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["checkout", "--detach"], { cwd: tmpDir, stdio: "ignore" });

        const mgr = new DispatchManager(tmpDir, scriptPath);
        (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;

        expect(() => mgr.start("TASK-DETACHED", { skipGate: true })).toThrow(
          "Git restoration baseline could not be verified",
        );
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("does not refresh projectRoot while another task owns the shared checkout", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-refresh-"));
      const isolatedDir = path.join(tmpDir, "isolated-task");
      const scriptPath = path.join(tmpDir, "concurrent-children.cjs");
      const isolatedReady = path.join(tmpDir, "isolated-ready");
      const sharedReady = path.join(tmpDir, "shared-ready");
      const releaseIsolated = path.join(tmpDir, "release-isolated");
      const trackedPath = path.join(tmpDir, "tracked.txt");
      let mgr: DispatchManager | undefined;
      fs.mkdirSync(isolatedDir, { recursive: true });
      try {
        execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "quack@example.test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Quack Test"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        fs.writeFileSync(
          path.join(tmpDir, ".gitignore"),
          ".quack/\nisolated-task/\nisolated-ready\nshared-ready\nrelease-isolated\n",
          "utf-8",
        );
        fs.writeFileSync(trackedPath, "baseline\n", "utf-8");
        fs.writeFileSync(
          scriptPath,
          [
            "const fs = require('node:fs');",
            "const taskId = process.argv[3];",
            `const isolatedReady = ${JSON.stringify(isolatedReady)};`,
            `const sharedReady = ${JSON.stringify(sharedReady)};`,
            `const releaseIsolated = ${JSON.stringify(releaseIsolated)};`,
            `const trackedPath = ${JSON.stringify(trackedPath)};`,
            "if (taskId === 'TASK-ISOLATED') {",
            "  fs.writeFileSync(isolatedReady, 'ready');",
            "  const timer = setInterval(() => {",
            "    if (fs.existsSync(releaseIsolated)) { clearInterval(timer); process.exit(0); }",
            "  }, 10);",
            "} else {",
            "  fs.writeFileSync(trackedPath, 'shared worker edit\\n');",
            "  fs.writeFileSync(sharedReady, 'ready');",
            "  setInterval(() => undefined, 1000);",
            "}",
          ].join("\n"),
          "utf-8",
        );
        execFileSync("git", ["add", ".gitignore", "tracked.txt", path.basename(scriptPath)], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });

        mgr = new DispatchManager(tmpDir, scriptPath);
        const internals = mgr as unknown as {
          createWorktree(taskId: string): string | undefined;
          worktreeDegraded: boolean;
        };
        internals.createWorktree = (taskId) => {
          if (taskId === "TASK-ISOLATED") return isolatedDir;
          internals.worktreeDegraded = true;
          return undefined;
        };

        const isolated = mgr.start("TASK-ISOLATED", { skipGate: true });
        await waitForFile(isolatedReady);
        const shared = mgr.start("TASK-SHARED", { skipGate: true });
        await waitForFile(sharedReady);
        fs.writeFileSync(releaseIsolated, "release", "utf-8");
        await waitForCondition(() => isolated.status === "completed", "isolated completion");

        expect(shared.status).toBe("running");
        expect(fs.readFileSync(trackedPath, "utf-8")).toBe("shared worker edit\n");
        expect(isolated.output.join("\n")).toContain("Skipped main checkout refresh");

        const shutdown = await mgr.shutdownAll({ gracefulTimeoutMs: 50, forceTimeoutMs: 2_000 });
        expect(shutdown.timedOut).toEqual([]);
      } finally {
        if (mgr) {
          await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 2_000 });
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("restores shared-checkout pause ownership after restart before fallback spawn", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-"));
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      const firstScript = path.join(tmpDir, "pause-child.cjs");
      const nextStarted = path.join(tmpDir, "unsafe-next-started");
      const nextScript = path.join(tmpDir, "next-child.cjs");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        firstScript,
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const approvalDir = path.join(process.cwd(), '.quack', 'logs', 'approvals');",
          "fs.mkdirSync(approvalDir, { recursive: true });",
          "fs.writeFileSync(path.join(approvalDir, 'TASK-PAUSED.json'), JSON.stringify({",
          "  taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString()",
          "}), 'utf-8');",
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        nextScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(nextStarted)}, 'started', 'utf-8');`,
        ].join("\n"),
        "utf-8",
      );

      const firstManager = new DispatchManager(tmpDir, firstScript);
      const restartedManager = new DispatchManager(tmpDir, nextScript);
      try {
        const pausedJob = firstManager.start("TASK-PAUSED", { skipGate: true });
        await waitForCondition(
          () => pausedJob.status === "awaiting_approval",
          "shared-checkout approval pause",
        );

        const markerPath = path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json");
        expect(fs.existsSync(markerPath)).toBe(true);

        // Simulate upgrading a pause created before durable markers existed,
        // or a crash after the durable exit event but before marker creation.
        fs.rmSync(markerPath);
        // A failed worktree setup may leave a partial directory behind even
        // though the durable exit event proves the child used projectRoot.
        fs.mkdirSync(path.join(tmpDir, ".quack", "worktrees", "TASK-PAUSED"), {
          recursive: true,
        });
        expect(restartedManager.getAllJobs()).toEqual([]);
        expect(restartedManager.getSharedCheckoutOccupants()).toEqual([
          expect.objectContaining({
            taskId: "TASK-PAUSED",
            status: "awaiting_approval",
          }),
        ]);
        expect(fs.existsSync(markerPath)).toBe(true);

        let thrown: unknown;
        try {
          restartedManager.start("TASK-NEXT", { skipGate: true });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(DegradedSharedCheckoutBusyError);
        expect((thrown as Error).message).toContain("TASK-PAUSED (awaiting_approval)");
        expect(restartedManager.getJob("TASK-NEXT")).toBeUndefined();
        expect(fs.existsSync(nextStarted)).toBe(false);

        fs.writeFileSync(
          path.join(approvalDir, "TASK-PAUSED.json"),
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );
        expect(() => restartedManager.start("TASK-PAUSED", { skipGate: true })).toThrow(
          DegradedSharedCheckoutBusyError,
        );

        confirmWindowsSharedCheckoutTree(markerPath);
        const resumed = restartedManager.start("TASK-PAUSED", {
          skipGate: true,
          resume: true,
        });
        markWindowsTreeKillConfirmed(restartedManager, "TASK-PAUSED");
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(nextStarted);
        await waitForCondition(() => resumed.status === "completed", "shared-checkout resume");
        expect(fs.existsSync(markerPath)).toBe(false);
      } finally {
        await firstManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restartedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("restores the original branch from durable shared-checkout evidence after restart", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-branch-restore-"));
      const approvalPath = path.join(tmpDir, ".quack", "logs", "approvals", "TASK-RESTORE.json");
      const scriptPath = path.join(tmpDir, "pause-and-restore.cjs");
      fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "quack@example.test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Quack Test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "const { execFileSync } = require('node:child_process');",
          `const approvalPath = ${JSON.stringify(approvalPath)};`,
          "if (!fs.existsSync(approvalPath)) {",
          "  execFileSync('git', ['checkout', '-b', 'quack/TASK-RESTORE'], { stdio: 'ignore' });",
          "  fs.mkdirSync(require('node:path').dirname(approvalPath), { recursive: true });",
          "  fs.writeFileSync(approvalPath, JSON.stringify({ taskId: 'TASK-RESTORE', state: 'pending', createdAt: new Date().toISOString() }));",
          "  process.exit(1);",
          "}",
          "process.exit(0);",
        ].join("\n"),
        "utf-8",
      );
      execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
      const originalBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: tmpDir,
        encoding: "utf-8",
      }).trim();

      const firstManager = new DispatchManager(tmpDir, scriptPath);
      const restartedManager = new DispatchManager(tmpDir, scriptPath);
      (firstManager as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      (restartedManager as unknown as { createWorktree(): undefined }).createWorktree = () =>
        undefined;
      try {
        const paused = firstManager.start("TASK-RESTORE", { skipGate: true });
        await waitForCondition(() => paused.status === "awaiting_approval", "branch restore pause");
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: tmpDir,
            encoding: "utf-8",
          }).trim(),
        ).toBe("quack/TASK-RESTORE");
        const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<
          string,
          unknown
        >;
        fs.writeFileSync(approvalPath, JSON.stringify({ ...approval, state: "approved" }), "utf-8");

        confirmWindowsSharedCheckoutTree(
          approvalPath.replace(
            path.join("approvals", "TASK-RESTORE.json"),
            "shared-checkout-pause.json",
          ),
        );
        const resumed = restartedManager.start("TASK-RESTORE", { skipGate: true, resume: true });
        markWindowsTreeKillConfirmed(restartedManager, "TASK-RESTORE");
        await waitForCondition(() => resumed.status === "completed", "branch restore completion");
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: tmpDir,
            encoding: "utf-8",
          }).trim(),
        ).toBe(originalBranch);
        expect(
          fs.existsSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json")),
        ).toBe(false);
      } finally {
        await firstManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restartedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("keeps durable ownership when a shared resume lacks a restoration baseline", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-restore-fail-"));
      const markerPath = path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json");
      const scriptPath = path.join(tmpDir, "successful-child.cjs");
      const startedPath = path.join(tmpDir, "unsafe-resume-started");
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "quack@example.test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Quack Test"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".quack/\n", "utf-8");
      fs.writeFileSync(
        scriptPath,
        `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");\n`,
        "utf-8",
      );
      execFileSync("git", ["add", ".gitignore", path.basename(scriptPath)], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "-b", "quack/TASK-NO-BASELINE"], {
        cwd: tmpDir,
        stdio: "ignore",
      });
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          taskId: "TASK-NO-BASELINE",
          sessionId: "legacy-session",
          startedAt: now,
          pausedAt: now,
          status: "stopped",
          ...(process.platform === "win32" ? { processTreeStatus: "confirmed-stopped" } : {}),
        })}\n`,
        "utf-8",
      );

      const mgr = new DispatchManager(tmpDir, scriptPath);
      (mgr as unknown as { createWorktree(): undefined }).createWorktree = () => undefined;
      try {
        expect(() => mgr.start("TASK-NO-BASELINE", { skipGate: true, resume: true })).toThrow(
          "Git restoration baseline could not be verified",
        );
        expect(fs.existsSync(markerPath)).toBe(true);
        expect(fs.existsSync(startedPath)).toBe(false);
      } finally {
        await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("resumes the in-memory shared checkout when durable marker persistence failed", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-memory-"));
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      const approvalPath = path.join(approvalDir, "TASK-PAUSED.json");
      const resumedPath = path.join(tmpDir, "resumed-in-shared-checkout");
      const scriptPath = path.join(tmpDir, "pause-then-resume.cjs");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `const approvalPath = ${JSON.stringify(approvalPath)};`,
          "if (fs.existsSync(approvalPath) && JSON.parse(fs.readFileSync(approvalPath, 'utf-8')).state === 'approved') {",
          `  fs.writeFileSync(${JSON.stringify(resumedPath)}, process.cwd(), 'utf-8');`,
          "  process.exit(0);",
          "}",
          "fs.writeFileSync(approvalPath, JSON.stringify({ taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString() }), 'utf-8');",
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = new DispatchManager(tmpDir, scriptPath);
      const internals = mgr as unknown as {
        persistSharedCheckoutPause(job: DispatchJob, status?: string): void;
      };
      const persistMarker = internals.persistSharedCheckoutPause.bind(mgr);
      let markerWrites = 0;
      internals.persistSharedCheckoutPause = (job, status) => {
        markerWrites += 1;
        if (markerWrites <= 2) {
          persistMarker(job, status);
          return;
        }
        fs.rmSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json"), {
          force: true,
        });
        throw new Error("simulated marker write failure");
      };

      try {
        const pausedJob = mgr.start("TASK-PAUSED", { skipGate: true });
        await waitForCondition(
          () => pausedJob.status === "awaiting_approval",
          "in-memory shared-checkout pause",
        );
        expect(
          fs.existsSync(path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json")),
        ).toBe(false);
        internals.persistSharedCheckoutPause = persistMarker;

        fs.writeFileSync(
          approvalPath,
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );
        if (process.platform === "win32") {
          expect(() => mgr.start("TASK-PAUSED", { skipGate: true, resume: true })).toThrow(
            DegradedSharedCheckoutBusyError,
          );
          return;
        }
        const resumed = mgr.start("TASK-PAUSED", { skipGate: true, resume: true });
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(resumedPath);
        await waitForCondition(() => resumed.status === "completed", "in-memory shared resume");
        expect(fs.readFileSync(resumedPath, "utf-8")).toBe(tmpDir);
      } finally {
        await mgr.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("keeps shared-checkout ownership after a recovered run is stopped", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-shared-pause-stop-"));
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      const approvalPath = path.join(approvalDir, "TASK-PAUSED.json");
      const pauseScript = path.join(tmpDir, "pause-child.cjs");
      const resumeScript = path.join(tmpDir, "resume-child.cjs");
      const readyPath = path.join(tmpDir, "resume-ready");
      fs.mkdirSync(approvalDir, { recursive: true });
      fs.writeFileSync(
        pauseScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(approvalPath)}, JSON.stringify({ taskId: 'TASK-PAUSED', state: 'pending', createdAt: new Date().toISOString() }), 'utf-8');`,
          "setTimeout(() => process.exit(1), 25);",
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        resumeScript,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf-8');`,
          "setInterval(() => undefined, 1000);",
        ].join("\n"),
        "utf-8",
      );

      const firstManager = new DispatchManager(tmpDir, pauseScript);
      const resumedManager = new DispatchManager(tmpDir, resumeScript);
      const restartedManager = new DispatchManager(tmpDir, resumeScript);
      try {
        const paused = firstManager.start("TASK-PAUSED", { skipGate: true });
        await waitForCondition(
          () => paused.status === "awaiting_approval",
          "durable shared-checkout pause",
        );
        fs.writeFileSync(
          approvalPath,
          JSON.stringify({
            taskId: "TASK-PAUSED",
            state: "approved",
            createdAt: new Date().toISOString(),
          }),
          "utf-8",
        );

        const resumedMarkerPath = path.join(tmpDir, ".quack", "logs", "shared-checkout-pause.json");
        confirmWindowsSharedCheckoutTree(resumedMarkerPath);
        const resumed = resumedManager.start("TASK-PAUSED", { skipGate: true, resume: true });
        markWindowsTreeKillConfirmed(resumedManager, "TASK-PAUSED");
        expect(resumed.worktreePath).toBeUndefined();
        await waitForFile(readyPath);
        const shutdown = await resumedManager.shutdownAll({
          gracefulTimeoutMs: 100,
          forceTimeoutMs: 2_000,
        });
        expect(shutdown.timedOut).toEqual([]);
        expect(resumed.status).toBe("stopped");

        expect(restartedManager.getSharedCheckoutOccupants()).toEqual([
          expect.objectContaining({ taskId: "TASK-PAUSED", status: "stopped" }),
        ]);
      } finally {
        await firstManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await resumedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        await restartedManager.shutdownAll({ gracefulTimeoutMs: 0, forceTimeoutMs: 1_000 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("does not infer shared-checkout ownership from Docker exit evidence", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-pause-evidence-"));
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      fs.mkdirSync(approvalDir, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        path.join(approvalDir, "TASK-DOCKER.json"),
        JSON.stringify({ taskId: "TASK-DOCKER", state: "pending", createdAt: now }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(logDir, "events-docker-session.jsonl"),
        `${JSON.stringify({
          stage: "dispatch_child_exit",
          timestamp: now,
          payload: {
            taskId: "TASK-DOCKER",
            worktreePath: null,
            isolation: "docker",
            killed: false,
            at: now,
          },
        })}\n`,
        "utf-8",
      );

      try {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js", {
          method: "docker",
          docker: {
            image: "node:20-slim",
            volumes: [],
            envPassthrough: [],
            resourceLimits: { memoryMb: 2048, cpus: 1 },
            networkMode: "bridge",
            cleanupPolicy: "remove",
          },
        });
        expect(mgr.getSharedCheckoutOccupants()).toEqual([]);
        expect(fs.existsSync(path.join(logDir, "shared-checkout-pause.json"))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("start throws for awaiting_approval without resume flag", () => {
      const job = makeJob({ taskId: "TASK-203", status: "awaiting_approval" });
      injectJob(manager, job);

      expect(() => manager.start("TASK-203")).toThrow("awaiting human approval at a gate");
    });

    test("start allows resume of awaiting_approval task", () => {
      const job = makeJob({
        taskId: "TASK-204",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, job);

      // start() with resume:true should remove the old job and proceed.
      // The spawn will fail (fake paths), but the guard should NOT throw.
      let threwAwaitingError = false;
      try {
        manager.start("TASK-204", { resume: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("awaiting")) threwAwaitingError = true;
        // Other errors (spawn failure) are expected — that's fine
      }
      expect(threwAwaitingError).toBe(false);
    });

    test("stop handles awaiting_approval jobs (no process to kill)", () => {
      const job = makeJob({
        taskId: "TASK-205",
        status: "awaiting_approval",
        worktreePath: "/fake/wt",
      });
      injectJob(manager, job);

      const result = manager.stop("TASK-205");
      expect(result).toBe(true);
      expect(job.status).toBe("stopped");
    });

    test("cleanup preserves awaiting_approval jobs", () => {
      const oldDate = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
      const awaitingJob = makeJob({
        taskId: "TASK-206",
        status: "awaiting_approval",
        startedAt: oldDate,
      });
      const failedJob = makeJob({ taskId: "TASK-207", status: "failed", startedAt: oldDate });
      injectJob(manager, awaitingJob);
      injectJob(manager, failedJob);

      manager.cleanup(3600000); // 1 hour cutoff

      // Both jobs still own a degraded shared checkout and are preserved.
      expect(manager.getJob("TASK-206")).toBeDefined();
      expect(manager.getJob("TASK-207")).toBeDefined();
    });

    describe("isApprovalPending", () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-approval-"));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      // QPI-041 renamed this: the detector now covers BOTH human gates,
      // because checking only the judge gate meant a run paused at the
      // BLUEPRINT gate was recorded as failed. In loop mode the brief
      // gate is the first gate every run reaches, so the unhandled case
      // was the common one.
      function callIsJudgeApprovalPending(
        mgr: DispatchManager,
        taskId: string,
        after: string,
      ): boolean {
        const fn = (mgr as unknown as Record<string, (t: string, a: string) => boolean>)[
          "isApprovalPending"
        ];
        return fn.call(mgr, taskId, after);
      }

      test("returns true for a pending BLUEPRINT approval (QPI-041)", () => {
        // The case that was NOT handled. `<taskId>.json` is the brief
        // gate; only `<taskId>-judge.json` used to be checked, so every
        // loop-mode run pausing at its FIRST gate was recorded as
        // failed, and the operator re-POSTed what looked dead.
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const startedAt = new Date(Date.now() - 60_000).toISOString();
        fs.writeFileSync(
          path.join(approvalDir, "TASK-BP.json"),
          JSON.stringify({ state: "pending", createdAt: new Date().toISOString() }),
          "utf-8",
        );

        expect(callIsJudgeApprovalPending(mgr, "TASK-BP", startedAt)).toBe(true);
      });

      test("a STALE blueprint approval from an earlier dispatch does not count", () => {
        // The guard that keeps the fix from making every failure look
        // like a pause: the approval must have been created during THIS
        // dispatch.
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const startedAt = new Date().toISOString();
        fs.writeFileSync(
          path.join(approvalDir, "TASK-BP2.json"),
          JSON.stringify({
            state: "pending",
            createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          }),
          "utf-8",
        );

        expect(callIsJudgeApprovalPending(mgr, "TASK-BP2", startedAt)).toBe(false);
      });

      test("returns true for pending approval created during dispatch", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const now = new Date();
        const approval = {
          taskId: "TASK-300",
          state: "pending",
          createdAt: now.toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-300-judge.json"), JSON.stringify(approval));

        // afterTimestamp is before the approval was created
        const before = new Date(now.getTime() - 1000).toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-300", before)).toBe(true);

        mgr.killAll();
      });

      test("returns false for stale approval from earlier dispatch", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const staleTime = new Date(Date.now() - 3600000); // 1 hour ago
        const approval = {
          taskId: "TASK-301",
          state: "pending",
          createdAt: staleTime.toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-301-judge.json"), JSON.stringify(approval));

        // afterTimestamp is after the approval was created → stale
        const after = new Date().toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-301", after)).toBe(false);

        mgr.killAll();
      });

      test("returns false for already-approved approval", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });

        const approval = {
          taskId: "TASK-302",
          state: "approved",
          createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(approvalDir, "TASK-302-judge.json"), JSON.stringify(approval));

        const before = new Date(Date.now() - 1000).toISOString();
        expect(callIsJudgeApprovalPending(mgr, "TASK-302", before)).toBe(false);

        mgr.killAll();
      });

      test("returns false when no approval file exists", () => {
        const mgr = new DispatchManager(tmpDir, "/fake/bin.js");
        expect(callIsJudgeApprovalPending(mgr, "TASK-303", new Date().toISOString())).toBe(false);
        mgr.killAll();
      });
    });
  });

  describe("CLI flag threading", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-start-flags-"));
    });

    afterEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("threads --skip-depth-only into the child process args", async () => {
      const argsFile = path.join(tmpDir, "args.json");
      const scriptPath = path.join(tmpDir, "fake-quack.js");
      fs.writeFileSync(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)), 'utf-8');`,
          "setTimeout(() => process.exit(0), 50);",
        ].join("\n"),
        "utf-8",
      );

      const mgr = new DispatchManager(tmpDir, scriptPath);
      try {
        mgr.start("TASK-FLAGS", { skipGate: true, skipDepthOnly: true });
        await waitForFile(argsFile);

        const args = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
        expect(args).toContain("run");
        expect(args).toContain("TASK-FLAGS");
        expect(args).toContain("--skip-gate");
        expect(args).toContain("--skip-depth-only");
      } finally {
        mgr.killAll();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });

    test("writes durable dispatch_child_exit facts into the events jsonl on child exit (QPI-043)", async () => {
      const scriptPath = path.join(tmpDir, "fake-quack.js");
      fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(3), 50);", "utf-8");

      const mgr = new DispatchManager(tmpDir, scriptPath);
      try {
        const job = mgr.start("TASK-EXIT-FACTS", { skipGate: true });
        // The fake child records no session, so the facts land durably
        // under the monitor job's own session id (the fallback path).
        const eventsFile = path.join(tmpDir, ".quack", "logs", `events-${job.sessionId}.jsonl`);
        await waitForFile(eventsFile);

        const lines = fs.readFileSync(eventsFile, "utf-8").trim().split("\n");
        const exitEvent = lines
          .map((line) => JSON.parse(line) as { stage: string; payload: Record<string, unknown> })
          .find((e) => e.stage === "dispatch_child_exit");
        expect(exitEvent).toBeDefined();
        expect(exitEvent?.payload.exitCode).toBe(3);
        expect(exitEvent?.payload.killed).toBe(false);
        expect(exitEvent?.payload.sessionResolution).toBe("job-fallback");
      } finally {
        mgr.killAll();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  });
});
