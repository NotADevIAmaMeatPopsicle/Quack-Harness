/* eslint-disable @typescript-eslint/no-require-imports */
import { promisify } from "node:util";

// ─── Mock child_process.exec ──────────────────────────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

let mockExecQueue: MockExecResult[] = [];

function pushMockResult(result: MockExecResult): void {
  mockExecQueue.push(result);
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const customPromisified = (
    _command: string,
    _options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    const result = mockExecQueue.shift();
    if (!result) {
      return Promise.resolve({ stdout: "", stderr: "" });
    }

    if (result.error) {
      const err = Object.assign(new Error("Command failed"), {
        code: result.code ?? 1,
        killed: false,
        signal: null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
      return Promise.reject(err);
    }

    return Promise.resolve({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
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
const worktreeCleanup =
  require("../../src/dispatcher/worktree-cleanup") as typeof import("../../src/dispatcher/worktree-cleanup");
const { safeUnsetCoreWorktree, cleanCoreWorktreeIfLeaked } = worktreeCleanup;

describe("worktree-cleanup", () => {
  beforeEach(() => {
    mockExecQueue = [];
  });

  // ─── safeUnsetCoreWorktree ────────────────────────────────────────

  describe("safeUnsetCoreWorktree", () => {
    test("removes core.worktree when it points inside .quack/worktrees/", async () => {
      const leakedValue = "/home/user/Quack/.quack/worktrees/TASK-893-A";
      // First call: git config --get returns the leaked path
      pushMockResult({ stdout: leakedValue + "\n" });
      // Second call: git config --unset succeeds
      pushMockResult({ stdout: "" });

      const mockEmit = jest.fn();
      const mockEvents = { emit: mockEmit } as unknown as Parameters<
        typeof safeUnsetCoreWorktree
      >[1];

      const result = await safeUnsetCoreWorktree("/repo", mockEvents);

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(result.leakedValue).toBe(leakedValue);
      expect(mockEmit).toHaveBeenCalledWith("core_worktree_cleaned", {
        repoPath: "/repo",
        leakedValue,
      });
    });

    test("removes core.worktree with Windows backslash path separator", async () => {
      const leakedValue = "C:\\Users\\user\\Quack\\.quack\\worktrees\\TASK-893-A";
      pushMockResult({ stdout: leakedValue + "\n" });
      pushMockResult({ stdout: "" });

      const result = await safeUnsetCoreWorktree("/repo");

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(result.leakedValue).toBe(leakedValue);
    });

    test("is a no-op when core.worktree is not set (git config exits non-zero)", async () => {
      // git config --get exits with code 1 when key is absent
      pushMockResult({ error: true, code: 1, stdout: "" });

      const mockEmit = jest.fn();
      const mockEvents = { emit: mockEmit } as unknown as Parameters<
        typeof safeUnsetCoreWorktree
      >[1];

      const result = await safeUnsetCoreWorktree("/repo", mockEvents);

      expect(result.leaked).toBe(false);
      expect(result.cleaned).toBe(false);
      expect(result.leakedValue).toBeUndefined();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    test("is a no-op when core.worktree is empty string", async () => {
      pushMockResult({ stdout: "\n" });

      const result = await safeUnsetCoreWorktree("/repo");

      expect(result.leaked).toBe(false);
      expect(result.cleaned).toBe(false);
    });

    test("does NOT remove core.worktree pointing outside .quack/worktrees/ (operator-set value)", async () => {
      const foreignValue = "/some/operator/custom/path";
      pushMockResult({ stdout: foreignValue + "\n" });

      const mockEmit = jest.fn();
      const mockEvents = { emit: mockEmit } as unknown as Parameters<
        typeof safeUnsetCoreWorktree
      >[1];

      const result = await safeUnsetCoreWorktree("/repo", mockEvents);

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(false);
      expect(result.leakedValue).toBe(foreignValue);
      // Event must NOT fire — we didn't clean it
      expect(mockEmit).not.toHaveBeenCalled();
    });

    test("does NOT remove core.worktree for unrelated paths", async () => {
      const unrelatedValue = "/home/user/my-other-project/worktrees/something";
      pushMockResult({ stdout: unrelatedValue + "\n" });

      const result = await safeUnsetCoreWorktree("/repo");

      // leaked = true (value exists) but cleaned = false (not a Quack path)
      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(false);
    });

    test("returns cleaned=false if unset command fails (non-fatal)", async () => {
      const leakedValue = "/home/user/Quack/.quack/worktrees/TASK-500";
      pushMockResult({ stdout: leakedValue + "\n" });
      // unset fails
      pushMockResult({ error: true, code: 5, stdout: "" });

      const result = await safeUnsetCoreWorktree("/repo");

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(false);
      expect(result.leakedValue).toBe(leakedValue);
    });

    test("works without events parameter (no-op when events undefined)", async () => {
      const leakedValue = "/home/user/Quack/.quack/worktrees/TASK-100";
      pushMockResult({ stdout: leakedValue + "\n" });
      pushMockResult({ stdout: "" });

      // Should not throw even without events
      const result = await safeUnsetCoreWorktree("/repo");
      expect(result.cleaned).toBe(true);
    });
  });

  // ─── cleanCoreWorktreeIfLeaked ────────────────────────────────────

  describe("cleanCoreWorktreeIfLeaked", () => {
    test("detects and cleans leaked value pointing inside .quack/worktrees/", async () => {
      const leakedValue = "/srv/Quack/.quack/worktrees/TASK-893-A";
      pushMockResult({ stdout: leakedValue + "\n" });
      pushMockResult({ stdout: "" });

      const result = await cleanCoreWorktreeIfLeaked("/repo");

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(result.leakedValue).toBe(leakedValue);
    });

    test("is a no-op when config is not set", async () => {
      pushMockResult({ error: true, code: 1 });

      const result = await cleanCoreWorktreeIfLeaked("/repo");

      expect(result.leaked).toBe(false);
      expect(result.cleaned).toBe(false);
    });

    test("does NOT remove value pointing outside .quack/worktrees/", async () => {
      pushMockResult({ stdout: "/some/foreign/path\n" });

      const result = await cleanCoreWorktreeIfLeaked("/repo");

      expect(result.leaked).toBe(true);
      expect(result.cleaned).toBe(false);
    });
  });
});
