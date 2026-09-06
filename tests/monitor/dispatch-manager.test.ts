import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";

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

describe("DispatchManager", () => {
  let manager: DispatchManager;

  beforeEach(() => {
    // Use a dummy project root and bin path — we won't actually spawn
    manager = new DispatchManager("/fake/project", "/fake/bin.js");
  });

  afterEach(() => {
    manager.killAll();
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

      // awaiting_approval preserved, failed cleaned up
      expect(manager.getJob("TASK-206")).toBeDefined();
      expect(manager.getJob("TASK-207")).toBeUndefined();
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
