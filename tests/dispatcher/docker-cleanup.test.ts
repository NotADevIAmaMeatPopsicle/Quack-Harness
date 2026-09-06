import { execSync } from "node:child_process";

import {
  cleanupWorktreeContainers,
  detectStaleContainers,
} from "../../src/dispatcher/docker-cleanup";

jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("docker-cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("cleanupWorktreeContainers runs docker compose down with project directory", () => {
    mockExecSync.mockReturnValue("" as unknown as ReturnType<typeof execSync>);
    const info = jest.fn();
    const ok = cleanupWorktreeContainers("/tmp/worktree/TASK-102", { info });

    expect(ok).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(
        'docker compose --project-directory "/tmp/worktree/TASK-102" down --volumes --remove-orphans',
      ),
      expect.any(Object),
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Stopped containers"));
  });

  test("cleanupWorktreeContainers swallows docker errors and returns false", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("compose file not found");
    });
    const warn = jest.fn();
    const ok = cleanupWorktreeContainers("/tmp/worktree/TASK-102", { warn });

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Non-fatal cleanup failure"));
  });

  test("detectStaleContainers returns only task postgres/redis container names", async () => {
    mockExecSync.mockReturnValue(
      ["task-691-postgres-1", "task-691-redis-1", "nginx-proxy-1", "task-700-other-1"].join(
        "\n",
      ) as unknown as ReturnType<typeof execSync>,
    );

    const warn = jest.fn();
    const stale = await detectStaleContainers({ warn });

    expect(stale).toEqual(["task-691-postgres-1", "task-691-redis-1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Detected 2 stale task containers"));
  });

  test("detectStaleContainers returns empty array when none match", async () => {
    mockExecSync.mockReturnValue(
      "project-web-1\nproject-worker-1" as unknown as ReturnType<typeof execSync>,
    );

    const stale = await detectStaleContainers();
    expect(stale).toEqual([]);
  });

  test("detectStaleContainers returns empty array on docker command failure", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("docker not found");
    });

    const warn = jest.fn();
    const stale = await detectStaleContainers({ warn });
    expect(stale).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unable to scan docker containers"));
  });
});
