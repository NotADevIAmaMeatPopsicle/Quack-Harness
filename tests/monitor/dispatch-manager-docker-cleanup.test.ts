import { EventEmitter } from "node:events";

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
  execSync: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock("../../src/dispatcher/docker-cleanup", () => ({
  cleanupWorktreeContainers: jest.fn(),
}));

jest.mock("../../src/dispatcher/worktree-lifecycle", () => ({
  removeWorktree: jest.fn(),
}));

import { spawn } from "node:child_process";
import { cleanupWorktreeContainers } from "../../src/dispatcher/docker-cleanup";
import { removeWorktree as lifecycleRemoveWorktreeMock } from "../../src/dispatcher/worktree-lifecycle";
import { DispatchManager } from "../../src/monitor/dispatch-manager";

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockCleanupWorktreeContainers = cleanupWorktreeContainers as jest.MockedFunction<
  typeof cleanupWorktreeContainers
>;
const mockRemoveWorktree = lifecycleRemoveWorktreeMock as jest.MockedFunction<
  typeof lifecycleRemoveWorktreeMock
>;

describe("DispatchManager docker cleanup integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("removeWorktree calls docker cleanup by default", () => {
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", { method: "worktree" });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    removeWorktree.call(mgr, "/fake/project/.quack/worktrees/TASK-102");

    // Docker cleanup now routes through worktree-lifecycle's removeWorktree
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      "TASK-102",
      "/fake/project",
      true, // dockerCleanup=true by default
    );
    mgr.killAll();
  });

  test("removeWorktree skips docker cleanup when isolation.dockerCleanup is false", () => {
    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", {
      method: "worktree",
      dockerCleanup: false,
    });
    const removeWorktree = (mgr as unknown as Record<string, (path: string) => void>)
      .removeWorktree;
    removeWorktree.call(mgr, "/fake/project/.quack/worktrees/TASK-102");

    // Lifecycle removeWorktree called with dockerCleanup=false
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      "TASK-102",
      "/fake/project",
      false,
    );
    // The old cleanupWorktreeContainers should not be called directly
    expect(mockCleanupWorktreeContainers).not.toHaveBeenCalled();
    mgr.killAll();
  });

  test("failed dispatch path still runs docker cleanup when worktree is preserved", () => {
    const fakeChild = new FakeChild();
    mockSpawn.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    const mgr = new DispatchManager("/fake/project", "/fake/bin.js", { method: "worktree" });
    (mgr as unknown as { createWorktree: (taskId: string) => string }).createWorktree = () =>
      "/fake/project/.quack/worktrees/TASK-102";

    const startWorktree = (
      mgr as unknown as {
        startWorktree: (taskId: string) => unknown;
      }
    ).startWorktree;
    startWorktree.call(mgr, "TASK-102");

    fakeChild.emit("exit", 1);

    expect(mockCleanupWorktreeContainers).toHaveBeenCalledWith(
      "/fake/project/.quack/worktrees/TASK-102",
      expect.any(Object),
    );
    mgr.killAll();
  });
});
