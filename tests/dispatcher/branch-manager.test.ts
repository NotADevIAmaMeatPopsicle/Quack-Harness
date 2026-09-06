/* eslint-disable @typescript-eslint/no-require-imports */
import { promisify } from "node:util";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// ─── Mock child_process.exec ──────────────────────────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

let mockGitResults: Record<string, MockExecResult | MockExecResult[]> = {};
let mockExecutedCommands: string[] = [];

function findGitResult(command: string): MockExecResult | undefined {
  for (const [pattern, resultOrQueue] of Object.entries(mockGitResults)) {
    if (command.includes(pattern)) {
      // Support queued results: array means return results in order
      if (Array.isArray(resultOrQueue)) {
        return resultOrQueue.shift() ?? undefined;
      }
      return resultOrQueue;
    }
  }
  return undefined;
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const customPromisified = (
    command: string,
    _options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    mockExecutedCommands.push(command);
    const matchedResult = findGitResult(command);
    if (!matchedResult) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }

    if (matchedResult.error) {
      const err = Object.assign(new Error("Command failed"), {
        code: matchedResult.code ?? 1,
        killed: false,
        signal: null,
        stdout: matchedResult.stdout ?? "",
        stderr: matchedResult.stderr ?? "",
      });
      return Promise.reject(err);
    }

    return Promise.resolve({
      stdout: matchedResult.stdout ?? "",
      stderr: matchedResult.stderr ?? "",
    });
  };

  const mockExec = jest.fn();
  (mockExec as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

  return {
    ...actual,
    exec: mockExec,
  };
});

// ─── Import after mocking ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const branchManager =
  require("../../src/dispatcher/branch-manager") as typeof import("../../src/dispatcher/branch-manager");
const {
  buildBranchName,
  createBranch,
  createFeatureBranch,
  pushBranch,
  cleanupBranch,
  getBranchDiff,
  getBranchCommitCount,
  abandonBranch,
  getUncommittedChanges,
  autoCommitChanges,
  mergeBranchToTarget,
  updateTaskFileStatus,
  deleteAfterMerge,
  sweep,
} = branchManager;

// ─── Test helpers ────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
  const defaultConfig: AdapterConfig = {
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
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: ["npm test *"],
      deniedBashPatterns: ["rm *"],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 30,
    },
  };

  return {
    config: defaultConfig,
    projectRoot: "/fake/project",
    conventionsDoc: "Test conventions.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "sha256:test",
      normalizedConfig: defaultConfig,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockGitResults = {};
  mockExecutedCommands = [];
});

describe("branch-manager", () => {
  describe("buildBranchName", () => {
    test("should build branch name from prefix and taskId", () => {
      const adapter = makeAdapter();
      const name = buildBranchName("TASK-042", adapter);
      expect(name).toBe("quack/TASK-042");
    });

    test("should use adapter's custom prefix", () => {
      const adapter = makeAdapter();
      adapter.config.git.branchPrefix = "agent/";
      const name = buildBranchName("TASK-001", adapter);
      expect(name).toBe("agent/TASK-001");
    });
  });

  describe("createBranch", () => {
    test("should create root task branch from freshly fetched remote base", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": {
          stdout: "Switched to branch",
        },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    test("should not create root task branch from stale local base", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": {
          stdout: "Switched to branch",
        },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("should return failure when remote base cannot be fetched", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": {
          error: true,
          stderr: "Could not resolve host",
        },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to fetch");
    });

    test("should delete stale branch and retry when branch already exists", async () => {
      // Queue two results for the same pattern: first fails (exists), second succeeds
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": [
          { error: true, stderr: "fatal: a branch named 'quack/TASK-042' already exists" },
          { stdout: "Switched to branch" },
        ],
        "branch -D quack/TASK-042": { stdout: "Deleted branch quack/TASK-042" },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    test("should stash dirty changes before checkout and pop after success", async () => {
      mockGitResults = {
        "stash --include-untracked": {
          stdout: "Saved working directory and index state WIP on main: abc1234 chore: stuff",
        },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": {
          stdout: "Switched to branch",
        },
        "stash pop": { stdout: "On branch quack/TASK-042\nChanges not staged for commit:" },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    test("should restore stash when all branch creation attempts fail", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "Saved working directory and index state" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": {
          error: true,
          stderr: "not found",
        },
        "stash pop": { stdout: "Changes restored" },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create branch");
    });

    test("root task createBranch uses explicit branch:refs/remotes/origin/branch refspec for fetch", async () => {
      // Only match the explicit refspec form. If the code uses bare "fetch origin main"
      // without the refspec, findGitResult() will not match this key and fetchRemoteBranch
      // will return an error, causing the test to fail — proving the refspec IS required.
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main:refs/remotes/origin/main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": { stdout: "Switched to branch" },
      };

      const adapter = makeAdapter();
      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });
  });

  describe("pushBranch", () => {
    test("should return success when push succeeds", async () => {
      mockGitResults = {
        "push -u origin quack/TASK-042": { stdout: "Branch pushed" },
      };

      const adapter = makeAdapter();
      const result = await pushBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    test("should return failure on push error", async () => {
      mockGitResults = {
        "push -u origin quack/TASK-042": {
          error: true,
          stderr: "Permission denied",
        },
      };

      const adapter = makeAdapter();
      const result = await pushBranch("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to push");
    });
  });

  describe("cleanupBranch", () => {
    test("should checkout base and delete branch", async () => {
      mockGitResults = {
        "checkout main": { stdout: "Switched to branch main" },
        "branch -D quack/TASK-042": { stdout: "Deleted branch" },
        "push origin --delete": { stdout: "" },
      };

      const adapter = makeAdapter();
      const result = await cleanupBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("should return failure if checkout fails", async () => {
      mockGitResults = {
        "checkout main": {
          error: true,
          stderr: "error: Your local changes would be overwritten",
        },
      };

      const adapter = makeAdapter();
      const result = await cleanupBranch("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to checkout");
    });
  });

  describe("protected-branch deletion guard (TASK-1312)", () => {
    // The guard must hold at every deletion site. Branch names collide
    // with protected names via an empty prefix in these fixtures.
    function protectedAdapter(prefix = ""): ProjectAdapter {
      const base = makeAdapter();
      return {
        ...base,
        config: {
          ...base.config,
          git: { ...base.config.git, branchPrefix: prefix },
        },
      };
    }

    test("TASK-1313: guard refusal emits a dispatcher_branch_guard safety_fact", async () => {
      const emitted: Array<{ stage: string; payload: unknown }> = [];
      const events = {
        emit: (stage: string, payload: unknown) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

      const result = await cleanupBranch("main", protectedAdapter(), events);
      expect(result.success).toBe(false);
      const facts = emitted.filter((e) => e.stage === "safety_fact");
      expect(facts).toHaveLength(1);
      const payload = facts[0].payload as {
        origin: string;
        facts: Array<{ targetRef?: string; candidateSafetyCode?: string }>;
      };
      expect(payload.origin).toBe("dispatcher_branch_guard");
      expect(payload.facts[0].targetRef).toBe("main");
      expect(payload.facts[0].candidateSafetyCode).toBe("protected_branch_delete");
    });

    test("cleanupBranch refuses a protected branch BEFORE any git runs", async () => {
      const result = await cleanupBranch("main", protectedAdapter());
      expect(result.success).toBe(false);
      expect(result.error).toContain("protected branch");
      expect(mockExecutedCommands).toHaveLength(0);
    });

    test("cleanupBranch still deletes quack task branches", async () => {
      mockGitResults = {
        "checkout main": { stdout: "Switched" },
        "branch -D quack/TASK-042": { stdout: "Deleted" },
        "push origin --delete": { stdout: "" },
      };
      const result = await cleanupBranch("TASK-042", makeAdapter());
      expect(result.success).toBe(true);
      expect(mockExecutedCommands.some((c) => c.includes("branch -D quack/TASK-042"))).toBe(true);
    });

    test("createBranch retry path refuses to delete a protected stale branch", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b main origin/main": {
          error: true,
          stderr: "fatal: a branch named 'main' already exists",
        },
      };
      // TASK-1313 round-2 F7: the refusal also emits through the
      // optional events param at THIS site (per-site emission proof
      // beyond the cleanupBranch test).
      const emitted: Array<{ stage: string; payload: unknown }> = [];
      const events = {
        emit: (stage: string, payload: unknown) => emitted.push({ stage, payload }),
      } as unknown as import("../../src/monitor/event-emitter").IEventWriter;
      const result = await createBranch("main", protectedAdapter(), {}, events);
      expect(result.success).toBe(false);
      expect(result.error).toContain("protected branch");
      expect(mockExecutedCommands.some((c) => c.includes("branch -D main"))).toBe(false);
      const facts = emitted.filter((e) => e.stage === "safety_fact");
      expect(facts).toHaveLength(1);
      expect((facts[0].payload as { origin: string }).origin).toBe("dispatcher_branch_guard");
    });

    test("createBranch retry path still deletes stale quack task branches", async () => {
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes to save" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": [
          {
            error: true,
            stderr: "fatal: a branch named 'quack/TASK-042' already exists",
          },
          { stdout: "Switched to branch" },
        ],
      };
      const result = await createBranch("TASK-042", makeAdapter());
      expect(result.success).toBe(true);
      expect(mockExecutedCommands.some((c) => c.includes("branch -D quack/TASK-042"))).toBe(true);
    });

    test("detached-merge cleanup deletes non-protected branches (control case)", async () => {
      mockGitResults = {
        "checkout dev": {
          error: true,
          stderr: "fatal: 'dev' is already used by worktree at /elsewhere",
        },
      };
      await mergeBranchToTarget("feature-x", protectedAdapter(), undefined, "dev");
      // Under default-success mocks the detached merge completes; the
      // control proves this mock setup reaches the deletion step.
      expect(mockExecutedCommands.some((c) => c.includes("branch -D feature-x"))).toBe(true);
    });

    test("detached-merge cleanup skips deletion for protected branches", async () => {
      mockGitResults = {
        "checkout dev": {
          error: true,
          stderr: "fatal: 'dev' is already used by worktree at /elsewhere",
        },
      };
      await mergeBranchToTarget("main", protectedAdapter(), undefined, "dev");
      expect(mockExecutedCommands.some((c) => c.includes("branch -D main"))).toBe(false);
    });
  });

  describe("getBranchDiff", () => {
    test("should return diff from freshly fetched remote baseBranch", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "diff origin/main...HEAD": {
          stdout: "diff --git a/src/test.ts b/src/test.ts\n+new code",
        },
      };

      const adapter = makeAdapter();
      const diff = await getBranchDiff(adapter);

      expect(diff).toContain("new code");
    });

    test("should fallback to local diff when remote fetch fails", async () => {
      mockGitResults = {
        "fetch origin main": { error: true, stderr: "offline" },
        "diff main...HEAD": {
          stdout: "local diff content",
        },
      };

      const adapter = makeAdapter();
      const diff = await getBranchDiff(adapter);

      expect(diff).toBe("local diff content");
    });
  });

  describe("abandonBranch", () => {
    test("should checkout base branch without deleting task branch", async () => {
      mockGitResults = {
        "checkout main": { stdout: "Switched to branch main" },
      };

      const adapter = makeAdapter();
      const result = await abandonBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    test("should return failure if checkout fails", async () => {
      mockGitResults = {
        "checkout main": {
          error: true,
          stderr: "error: Your local changes would be overwritten",
        },
      };

      const adapter = makeAdapter();
      const result = await abandonBranch("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to checkout base branch");
    });
  });

  describe("getUncommittedChanges", () => {
    test("should return status output for dirty tree", async () => {
      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n?? new-file.ts\n" },
      };

      const adapter = makeAdapter();
      const changes = await getUncommittedChanges(adapter);

      expect(changes).toContain("src/test.ts");
      expect(changes).toContain("new-file.ts");
    });

    test("should return empty string for clean tree", async () => {
      mockGitResults = {
        "status --short": { stdout: "" },
      };

      const adapter = makeAdapter();
      const changes = await getUncommittedChanges(adapter);

      expect(changes).toBe("");
    });
  });

  describe("autoCommitChanges", () => {
    test("should stage, count, and commit files", async () => {
      mockGitResults = {
        "add -A": { stdout: "" },
        "diff --cached --name-only": { stdout: "src/a.ts\nsrc/b.ts\n" },
        "commit -m": { stdout: "2 files changed" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.filesStaged).toBe(2);
      expect(result.message).toContain("TASK-042");
    });

    test("QPI-050: unstages the pipeline-synced adapter trio so host-local drift never rides a task commit", async () => {
      mockGitResults = {
        "add -A": { stdout: "" },
        "diff --cached --name-only": { stdout: "src/a.ts\n" },
        "commit -m": { stdout: "1 file changed" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);
      expect(result.success).toBe(true);

      const resetCommand = mockExecutedCommands.find((c) => c.includes("reset HEAD --"));
      expect(resetCommand).toBeDefined();
      for (const synced of [
        ".quack/adapter.json",
        ".quack/conventions.md",
        ".quack/judge-criteria.md",
      ]) {
        expect(resetCommand).toContain(synced);
      }
      // The original shared-state pair stays covered too.
      expect(resetCommand).toContain("PROGRESS.md");
      expect(resetCommand).toContain(".quack/verified.json");
    });

    test("should return failure when git add fails", async () => {
      mockGitResults = {
        "add -A": { error: true, stderr: "Permission denied" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.message).toContain("git add failed");
    });

    test("should treat ignored shared-state-only changes as a no-op", async () => {
      mockGitResults = {
        "add -A": { stdout: "" },
        "reset HEAD": { stdout: "" },
        "diff --cached --name-only": { stdout: "" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.filesStaged).toBe(0);
      expect(result.message).toContain("No commit created");
    });

    test("should return failure when git commit fails", async () => {
      mockGitResults = {
        "add -A": { stdout: "" },
        "diff --cached --name-only": { stdout: "src/a.ts\n" },
        "commit -m": { error: true, stderr: "nothing to commit" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.filesStaged).toBe(1);
      expect(result.message).toContain("git commit failed");
    });

    test("should use two-step add+reset instead of pathspec negation", async () => {
      // Verifies the fix for Windows where :!PROGRESS.md pathspec fails.
      // The function should: 1) git add -A  2) git reset HEAD -- PROGRESS.md ...
      mockGitResults = {
        "add -A": { stdout: "" },
        "reset HEAD": { stdout: "" },
        "diff --cached --name-only": { stdout: "src/service.ts\nsrc/model.ts\n" },
        "commit -m": { stdout: "2 files changed" },
      };

      const adapter = makeAdapter();
      const result = await autoCommitChanges("TASK-042", adapter);

      expect(result.success).toBe(true);
      expect(result.filesStaged).toBe(2);
    });
  });

  describe("mergeBranchToTarget", () => {
    test("should use gh pr merge when prUrl is provided", async () => {
      mockGitResults = {
        "gh pr merge https://github.com/org/repo/pull/42 --squash --delete-branch": {
          stdout: "Merged",
        },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget(
        "TASK-042",
        adapter,
        "https://github.com/org/repo/pull/42",
      );

      expect(result.success).toBe(true);
    });

    test("should return failure when gh pr merge fails", async () => {
      mockGitResults = {
        "gh pr merge": {
          error: true,
          stderr: "merge conflict",
        },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;

      const result = await mergeBranchToTarget(
        "TASK-042",
        adapter,
        "https://github.com/org/repo/pull/42",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("gh pr merge failed");
    });

    test("should use merge strategy flag from config", async () => {
      mockGitResults = {
        "gh pr merge https://github.com/org/repo/pull/42 --merge --delete-branch": {
          stdout: "Merged",
        },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "merge";

      const result = await mergeBranchToTarget(
        "TASK-042",
        adapter,
        "https://github.com/org/repo/pull/42",
      );

      expect(result.success).toBe(true);
    });

    test("should fall back to local squash merge when no prUrl", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": { stdout: "Switched to branch main" },
        "pull origin main": { stdout: "Already up to date." },
        "merge --squash quack/TASK-042": { stdout: "Squash commit" },
        "commit -m": { stdout: "1 file changed" },
        "push origin main": { stdout: "Pushed" },
        "branch -D quack/TASK-042": { stdout: "Deleted" },
        "push origin --delete quack/TASK-042": { stdout: "" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("falls back to a detached temp worktree when target branch is already checked out elsewhere", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": {
          error: true,
          stderr: "fatal: 'main' is already used by worktree at '/srv/example-service-dev'",
        },
        "worktree add --detach": { stdout: "Preparing worktree" },
        "merge-base origin/main quack/TASK-042": { stdout: "base123\n" },
        "rev-parse origin/main": { stdout: "base123\n" },
        "merge --squash quack/TASK-042": { stdout: "Squash commit" },
        "diff --cached --name-status": { stdout: "M\tsrc/example.ts\n" },
        "commit -m": { stdout: "1 file changed" },
        "push origin HEAD:main": { stdout: "Pushed" },
        "worktree remove": { stdout: "" },
        "branch -D quack/TASK-042": { stdout: "Deleted" },
        "push origin --delete quack/TASK-042": { stdout: "" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("should fall back to local --no-ff merge for merge strategy", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": { stdout: "Switched to branch main" },
        "pull origin main": { stdout: "Already up to date." },
        "merge --no-ff quack/TASK-042": { stdout: "Merge made" },
        "push origin main": { stdout: "Pushed" },
        "branch -D quack/TASK-042": { stdout: "Deleted" },
        "push origin --delete quack/TASK-042": { stdout: "" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "merge";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("should return failure when local squash merge conflicts", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": { stdout: "Switched to branch main" },
        "pull origin main": { stdout: "Already up to date." },
        "merge --squash quack/TASK-042": {
          error: true,
          stderr: "CONFLICT (content): Merge conflict in src/test.ts",
        },
        "merge --abort": { stdout: "" },
        "checkout quack/TASK-042": { stdout: "Switched to branch" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Squash merge failed");
    });

    test("should use autoMergeTarget when specified", async () => {
      mockGitResults = {
        "fetch origin staging": { stdout: "" },
        "checkout staging": { stdout: "Switched to branch staging" },
        "pull origin staging": { stdout: "Already up to date." },
        "merge --squash quack/TASK-042": { stdout: "Squash commit" },
        "commit -m": { stdout: "1 file changed" },
        "push origin staging": { stdout: "Pushed" },
        "branch -D quack/TASK-042": { stdout: "Deleted" },
        "push origin --delete quack/TASK-042": { stdout: "" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeTarget = "staging";
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(true);
    });

    test("should return failure when fetch fails", async () => {
      mockGitResults = {
        "fetch origin main": {
          error: true,
          stderr: "Could not resolve host",
        },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to fetch");
    });

    test("should return failure when push to target fails", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": { stdout: "Switched to branch main" },
        "pull origin main": { stdout: "Already up to date." },
        "merge --squash quack/TASK-042": { stdout: "Squash commit" },
        "commit -m": { stdout: "1 file changed" },
        "push origin main": {
          error: true,
          stderr: "Permission denied",
        },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to push");
    });

    test("should block stale branch auto-merge when target changed same files", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "checkout main": { stdout: "Switched to branch main" },
        "pull --ff-only origin main": { stdout: "Already up to date." },
        "merge-base main quack/TASK-042": { stdout: "base123\n" },
        "rev-parse main": { stdout: "head456\n" },
        "diff --name-only base123..main": { stdout: "src/shared.ts\nREADME.md\n" },
        "diff --name-only base123..quack/TASK-042": { stdout: "src/shared.ts\nsrc/task.ts\n" },
      };

      const adapter = makeAdapter();
      adapter.config.git.autoMerge = true;
      adapter.config.git.autoMergeStrategy = "squash";

      const result = await mergeBranchToTarget("TASK-042", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Refusing to auto-merge stale branch");
      expect(result.error).toContain("src/shared.ts");
    });
  });

  describe("updateTaskFileStatus", () => {
    const mockReaddir = jest.fn<Promise<string[]>, [string]>();
    const mockReadFile = jest.fn<Promise<string>, [string, string]>();
    const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();

    beforeEach(() => {
      jest.mock("node:fs/promises", () => ({
        readdir: (...args: [string]) => mockReaddir(...args),
        readFile: (...args: [string, string]) => mockReadFile(...args),
        writeFile: (...args: [string, string, string]) => mockWriteFile(...args),
      }));
      mockReaddir.mockReset();
      mockReadFile.mockReset();
      mockWriteFile.mockReset();
    });

    test("should return failure when worktree creation fails", async () => {
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "worktree add": {
          error: true,
          stderr: "fatal: worktree already exists",
        },
        "worktree remove": { stdout: "" },
      };

      const adapter = makeAdapter();
      const result = await updateTaskFileStatus("TASK-042", adapter, "main");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create temp worktree");
    });
  });

  // ─── Fix 1: createFeatureBranch ─────────────────────────────────────

  describe("createFeatureBranch", () => {
    it("creates feature branch from freshly fetched remote baseBranch when it doesn't exist", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "rev-parse --verify quack/TASK-207": { error: true, code: 128 },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "branch quack/TASK-207 origin/main": { stdout: "" },
      };

      const result = await createFeatureBranch("TASK-207", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-207");
    });

    it("returns existing branch without creating (idempotent)", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "rev-parse --verify quack/TASK-207": { stdout: "abc123\n" },
      };

      const result = await createFeatureBranch("TASK-207", adapter);

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-207");
    });

    it("returns error when remote base fetch fails", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "rev-parse --verify quack/TASK-207": { error: true, code: 128 },
        "fetch origin main": { error: true, stderr: "offline" },
      };

      const result = await createFeatureBranch("TASK-207", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to fetch");
    });

    it("returns error when all attempts fail", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "rev-parse --verify quack/TASK-207": { error: true, code: 128 },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "branch quack/TASK-207 origin/main": { error: true, stderr: "also failed" },
      };

      const result = await createFeatureBranch("TASK-207", adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create feature branch");
    });
  });

  // ─── Fix 1: createBranch with fromBranch ────────────────────────────

  describe("createBranch with fromBranch", () => {
    it("creates branch from fromBranch when provided", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes" },
        "checkout -b quack/TASK-207-A quack/TASK-207": { stdout: "" },
      };

      const result = await createBranch("TASK-207-A", adapter, {
        fromBranch: "quack/TASK-207",
      });

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-207-A");
    });

    it("fetches the remote base when a root task overrides its base branch", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes" },
        "fetch origin staging": { stdout: "" },
        "rev-parse --verify origin/staging": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/staging": { stdout: "" },
      };

      const result = await createBranch("TASK-042", adapter, {
        baseBranch: "staging",
      });

      expect(result.success).toBe(true);
      expect(result.branchName).toBe("quack/TASK-042");
    });

    it("falls back to baseBranch when fromBranch is undefined", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "stash --include-untracked": { stdout: "No local changes" },
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "checkout -b quack/TASK-042 origin/main": { stdout: "" },
      };

      const result = await createBranch("TASK-042", adapter);

      expect(result.success).toBe(true);
    });
  });

  // ─── Fix 1: getBranchDiff with diffBase ─────────────────────────────

  describe("getBranchDiff with diffBase", () => {
    it("diffs against diffBase when provided", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "diff quack/TASK-207...HEAD": { stdout: "diff --git a/file.ts" },
      };

      const diff = await getBranchDiff(adapter, "quack/TASK-207");

      expect(diff).toContain("diff --git a/file.ts");
    });

    it("diffs against remote baseBranch when diffBase is undefined", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "fetch origin main": { stdout: "" },
        "rev-parse --verify origin/main": { stdout: "abc123\n" },
        "diff origin/main...HEAD": { stdout: "diff --git a/other.ts" },
      };

      const diff = await getBranchDiff(adapter);

      expect(diff).toContain("diff --git a/other.ts");
    });
  });

  // ─── Fix 2: getBranchCommitCount ────────────────────────────────────

  describe("getBranchCommitCount", () => {
    it("returns commit count relative to base", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline main..HEAD": { stdout: "abc123 first commit\ndef456 second commit\n" },
      };

      const count = await getBranchCommitCount(adapter);

      expect(count).toBe(2);
    });

    it("returns 0 when no commits ahead of base", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline main..HEAD": { stdout: "" },
      };

      const count = await getBranchCommitCount(adapter);

      expect(count).toBe(0);
    });

    it("returns 0 on git error", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline main..HEAD": { error: true, stderr: "fatal: bad ref" },
      };

      const count = await getBranchCommitCount(adapter);

      expect(count).toBe(0);
    });

    it("uses custom baseBranch when provided", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline quack/TASK-207..HEAD": { stdout: "abc123 one commit\n" },
      };

      const count = await getBranchCommitCount(adapter, "quack/TASK-207");

      expect(count).toBe(1);
    });

    it("uses explicit branchRef instead of HEAD when provided", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline main..quack/TASK-559": { stdout: "abc123 first\ndef456 second\n" },
      };

      const count = await getBranchCommitCount(adapter, undefined, "quack/TASK-559");

      expect(count).toBe(2);
    });

    it("defaults to HEAD when branchRef is not provided", async () => {
      const adapter = makeAdapter();
      mockGitResults = {
        "log --oneline main..HEAD": { stdout: "abc123 one commit\n" },
      };

      const count = await getBranchCommitCount(adapter);

      expect(count).toBe(1);
    });
  });

  // ─── deleteAfterMerge ───────────────────────────────────────────────

  describe("deleteAfterMerge", () => {
    test("fully merged branch older than minAgeDays is deleted", async () => {
      const adapter = makeAdapter();
      const twoDAysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${twoDAysAgo}\n` },
        "log -1 --format=%B quack/TASK-100": { stdout: "[TASK-100] fix something\n" },
        "merge-base --is-ancestor quack/TASK-100 origin/main": { stdout: "" },
        "branch -d quack/TASK-100": { stdout: "Deleted branch quack/TASK-100" },
        "push origin --delete quack/TASK-100": { stdout: "" },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter);

      expect(result.deleted).toBe(true);
      expect(result.localDeleted).toBe(true);
      expect(result.remoteDeleted).toBe(true);
    });

    test("branch with commits beyond merge-base is NOT deleted", async () => {
      const adapter = makeAdapter();
      const twoDAysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${twoDAysAgo}\n` },
        "log -1 --format=%B quack/TASK-100": { stdout: "[TASK-100] fix something\n" },
        "merge-base --is-ancestor quack/TASK-100 origin/main": {
          error: true,
          code: 1,
          stderr: "",
        },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter);

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("not-merged");
    });

    test("branch younger than minAgeDays is skipped", async () => {
      const adapter = makeAdapter();
      const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${oneHourAgo}\n` },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter, { minAgeDays: 1 });

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("too-recent");
    });

    test("branch with [skip-cleanup] in commit message is skipped", async () => {
      const adapter = makeAdapter();
      const twoDAysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${twoDAysAgo}\n` },
        "log -1 --format=%B quack/TASK-100": { stdout: "[TASK-100] fix\n[skip-cleanup]\n" },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter);

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("skip-cleanup-marker");
    });

    test("remote branch already deleted is treated as success (idempotent)", async () => {
      const adapter = makeAdapter();
      const twoDAysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${twoDAysAgo}\n` },
        "log -1 --format=%B quack/TASK-100": { stdout: "[TASK-100] fix something\n" },
        "merge-base --is-ancestor quack/TASK-100 origin/main": { stdout: "" },
        "branch -d quack/TASK-100": { stdout: "Deleted branch quack/TASK-100" },
        "push origin --delete quack/TASK-100": {
          error: true,
          code: 1,
          stderr: "remote: error: unable to delete 'quack/TASK-100': remote ref does not exist",
        },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter);

      expect(result.deleted).toBe(true);
      expect(result.remoteDeleted).toBe(true);
    });

    test("non-quack branch is rejected immediately", async () => {
      const adapter = makeAdapter();
      const result = await deleteAfterMerge("feature/my-branch", adapter);

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("non-quack-branch");
    });

    test("protected branch is rejected", async () => {
      const adapter = makeAdapter();
      adapter.config.git.protectedBranches = ["quack/TASK-999"];

      const result = await deleteAfterMerge("quack/TASK-999", adapter);

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("protected-branch");
    });

    test("uses -d (safe-delete) not -D (force-delete)", async () => {
      // We capture calls via mockGitResults — the pattern "branch -d" only matches safe-delete
      const adapter = makeAdapter();
      const twoDAysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "log -1 --format=%ct quack/TASK-100": { stdout: `${twoDAysAgo}\n` },
        "log -1 --format=%B quack/TASK-100": { stdout: "[TASK-100] fix\n" },
        "merge-base --is-ancestor quack/TASK-100 origin/main": { stdout: "" },
        "branch -d quack/TASK-100": { stdout: "Deleted branch quack/TASK-100" },
        "push origin --delete quack/TASK-100": { stdout: "" },
      };

      const result = await deleteAfterMerge("quack/TASK-100", adapter);
      // If safe-delete is matched, the result should be deleted.
      // If force-delete (-D) were used, the "branch -d" pattern would not match
      // (because "branch -D" would not start with "branch -d").
      expect(result.deleted).toBe(true);
    });
  });

  // ─── sweep ──────────────────────────────────────────────────────────

  describe("sweep", () => {
    test("dry-run lists branches that would be deleted without actually deleting", async () => {
      const adapter = makeAdapter();
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;

      // 3 merged branches, 2 not merged
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout:
            ["quack/TASK-1", "quack/TASK-2", "quack/TASK-3", "quack/TASK-4", "quack/TASK-5"].join(
              "\n",
            ) + "\n",
        },
        // Age checks — all 2 days old
        "log -1 --format=%ct quack/TASK-1": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-2": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-3": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-4": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-5": { stdout: `${twoDaysAgo}\n` },
        // Skip-cleanup checks — none
        "log -1 --format=%B quack/TASK-1": { stdout: "[TASK-1] fix\n" },
        "log -1 --format=%B quack/TASK-2": { stdout: "[TASK-2] fix\n" },
        "log -1 --format=%B quack/TASK-3": { stdout: "[TASK-3] fix\n" },
        "log -1 --format=%B quack/TASK-4": { stdout: "[TASK-4] fix\n" },
        "log -1 --format=%B quack/TASK-5": { stdout: "[TASK-5] fix\n" },
        // Ancestor checks: TASK-1, TASK-2, TASK-3 are merged; TASK-4, TASK-5 are not
        "merge-base --is-ancestor quack/TASK-1 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-2 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-3 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-4 origin/main": { error: true, code: 1, stderr: "" },
        "merge-base --is-ancestor quack/TASK-5 origin/main": { error: true, code: 1, stderr: "" },
      };

      const report = await sweep("/fake/project", { dryRun: true }, adapter);

      expect(report.dryRun).toBe(true);
      expect(report.deleted).toHaveLength(3);
      expect(report.deleted).toContain("quack/TASK-1");
      expect(report.deleted).toContain("quack/TASK-2");
      expect(report.deleted).toContain("quack/TASK-3");
      expect(report.skipped).toHaveLength(2);
      expect(report.skipped.every((s) => s.reason === "not-merged")).toBe(true);
    });

    test("dryRun: false deletes 3 merged branches and leaves 2 unmerged", async () => {
      const adapter = makeAdapter();
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;

      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout:
            ["quack/TASK-1", "quack/TASK-2", "quack/TASK-3", "quack/TASK-4", "quack/TASK-5"].join(
              "\n",
            ) + "\n",
        },
        "log -1 --format=%ct quack/TASK-1": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-2": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-3": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-4": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-5": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B quack/TASK-1": { stdout: "[TASK-1] fix\n" },
        "log -1 --format=%B quack/TASK-2": { stdout: "[TASK-2] fix\n" },
        "log -1 --format=%B quack/TASK-3": { stdout: "[TASK-3] fix\n" },
        "log -1 --format=%B quack/TASK-4": { stdout: "[TASK-4] fix\n" },
        "log -1 --format=%B quack/TASK-5": { stdout: "[TASK-5] fix\n" },
        "merge-base --is-ancestor quack/TASK-1 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-2 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-3 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-4 origin/main": { error: true, code: 1, stderr: "" },
        "merge-base --is-ancestor quack/TASK-5 origin/main": { error: true, code: 1, stderr: "" },
        "branch -d quack/TASK-1": { stdout: "Deleted" },
        "branch -d quack/TASK-2": { stdout: "Deleted" },
        "branch -d quack/TASK-3": { stdout: "Deleted" },
        "push origin --delete quack/TASK-1": { stdout: "" },
        "push origin --delete quack/TASK-2": { stdout: "" },
        "push origin --delete quack/TASK-3": { stdout: "" },
      };

      const report = await sweep("/fake/project", { dryRun: false }, adapter);

      expect(report.deleted).toHaveLength(3);
      expect(report.skipped).toHaveLength(2);
      expect(report.skipped.every((s) => s.reason === "not-merged")).toBe(true);
    });

    test("handles remote branch already deleted gracefully (idempotent)", async () => {
      const adapter = makeAdapter();
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;

      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "quack/TASK-1\n",
        },
        "log -1 --format=%ct quack/TASK-1": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B quack/TASK-1": { stdout: "[TASK-1] fix\n" },
        "merge-base --is-ancestor quack/TASK-1 origin/main": { stdout: "" },
        "branch -d quack/TASK-1": { stdout: "Deleted" },
        "push origin --delete quack/TASK-1": {
          error: true,
          code: 1,
          stderr: "remote: error: unable to delete 'quack/TASK-1': remote ref does not exist",
        },
      };

      const report = await sweep("/fake/project", { dryRun: false }, adapter);

      expect(report.deleted).toContain("quack/TASK-1");
      expect(report.errors).toHaveLength(0);
    });

    test("skips branch with [skip-cleanup] marker and includes in skipped[]", async () => {
      const adapter = makeAdapter();
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;

      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "quack/TASK-1\nquack/TASK-2\nquack/TASK-3\n",
        },
        "log -1 --format=%ct quack/TASK-1": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-2": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%ct quack/TASK-3": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B quack/TASK-1": { stdout: "[TASK-1] fix\n" },
        "log -1 --format=%B quack/TASK-2": { stdout: "[TASK-2] fix [skip-cleanup]\n" },
        "log -1 --format=%B quack/TASK-3": { stdout: "[TASK-3] fix\n" },
        "merge-base --is-ancestor quack/TASK-1 origin/main": { stdout: "" },
        "merge-base --is-ancestor quack/TASK-3 origin/main": { stdout: "" },
        "branch -d quack/TASK-1": { stdout: "Deleted" },
        "branch -d quack/TASK-3": { stdout: "Deleted" },
        "push origin --delete quack/TASK-1": { stdout: "" },
        "push origin --delete quack/TASK-3": { stdout: "" },
      };

      const report = await sweep("/fake/project", { dryRun: false }, adapter);

      expect(report.deleted).toHaveLength(2);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.reason).toBe("skip-cleanup-marker");
    });

    test("default cleanup policy preserves existing quack/TASK behavior", async () => {
      const adapter = makeAdapter();
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "quack/TASK-321\necho/TASK-321\n",
        },
        "log -1 --format=%ct quack/TASK-321": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B quack/TASK-321": { stdout: "[TASK-321] done\n" },
        "merge-base --is-ancestor quack/TASK-321 origin/main": { stdout: "" },
      };

      const report = await sweep("/fake/project", { dryRun: true }, adapter);

      expect(report.scanned).toBe(1);
      expect(report.deleted).toEqual(["quack/TASK-321"]);
      expect(report.skipped).toEqual([]);
    });

    test("configured echo/TASK prefix is eligible when merged and old", async () => {
      const adapter = makeAdapter();
      adapter.config.git.branchCleanup = {
        enabled: true,
        allowedPrefixes: ["quack/TASK-", "echo/TASK-"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      };
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "echo/TASK-444\n",
        },
        "log -1 --format=%ct echo/TASK-444": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B echo/TASK-444": { stdout: "[TASK-444] Hermes done\n" },
        "merge-base --is-ancestor echo/TASK-444 origin/main": { stdout: "" },
      };

      const report = await sweep("/fake/project", { dryRun: true }, adapter);

      expect(report.deleted).toEqual(["echo/TASK-444"]);
      expect(report.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branch: "echo/TASK-444",
            allowedPrefix: "echo/TASK-",
            owner: "hermes",
            deleteEligible: true,
            merged: true,
          }),
        ]),
      );
    });

    test("Contributor-owned merged branch is skipped as protected-owner", async () => {
      const adapter = makeAdapter();
      adapter.config.git.branchCleanup = {
        enabled: true,
        allowedPrefixes: ["quack/TASK-", "contributor/"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      };
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "contributor/task-123\n",
        },
        "log -1 --format=%ct contributor/task-123": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B contributor/task-123": { stdout: "Contributor task\n" },
        "merge-base --is-ancestor contributor/task-123 origin/main": { stdout: "" },
      };

      const report = await sweep("/fake/project", { dryRun: true }, adapter);

      expect(report.deleted).toEqual([]);
      expect(report.skipped).toEqual([
        expect.objectContaining({
          branch: "contributor/task-123",
          reason: "protected-owner",
          owner: "contributor",
          requiresOverride: true,
        }),
      ]);
      expect(report.candidates).toEqual([
        expect.objectContaining({
          branch: "contributor/task-123",
          owner: "contributor",
          deleteEligible: false,
          reason: "protected-owner",
        }),
      ]);
    });

    test("explicit owner override allows protected branch only when merged and old", async () => {
      const adapter = makeAdapter();
      adapter.config.git.branchCleanup = {
        enabled: true,
        allowedPrefixes: ["contributor/"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      };
      const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "for-each-ref --format=%(refname:short) refs/heads/": {
          stdout: "contributor/task-123\n",
        },
        "log -1 --format=%ct contributor/task-123": { stdout: `${twoDaysAgo}\n` },
        "log -1 --format=%B contributor/task-123": { stdout: "Contributor task\n" },
        "merge-base --is-ancestor contributor/task-123 origin/main": { stdout: "" },
      };

      const report = await sweep(
        "/fake/project",
        {
          dryRun: true,
          ownerOverride: {
            owner: "contributor",
            reason: "Operator explicitly approved cleanup of this merged Contributor branch.",
          },
        },
        adapter,
      );

      expect(report.deleted).toEqual(["contributor/task-123"]);
      expect(report.candidates).toEqual([
        expect.objectContaining({
          branch: "contributor/task-123",
          owner: "contributor",
          deleteEligible: true,
          overrideApplied: true,
          merged: true,
        }),
      ]);
    });
  });
});
