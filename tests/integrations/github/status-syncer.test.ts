// ─── Status Syncer Tests ────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubConfig, SyncEvent } from "../../../src/integrations/github/github-types";
import { writeTestAdapter } from "../../helpers/divergent-task-fixture";

type RunBoundGitHubCommand =
  typeof import("../../../src/integrations/github/trusted-github").runBoundGitHubCommand;
const mockRunBoundGitHubCommand = jest.fn<
  ReturnType<RunBoundGitHubCommand>,
  Parameters<RunBoundGitHubCommand>
>();

jest.mock("../../../src/integrations/github/trusted-github", () => ({
  ...jest.requireActual<object>("../../../src/integrations/github/trusted-github"),
  runBoundGitHubCommand: (...args: Parameters<RunBoundGitHubCommand>) =>
    mockRunBoundGitHubCommand(...args),
}));

import { loadAdapter } from "../../../src/core/adapter-loader";
import {
  syncDispatchStarted,
  syncLifecycleEvent,
} from "../../../src/integrations/github/status-syncer";

const PROJECT_ROOT = "C:\\trusted\\project";
const REPOSITORY = { host: "github.com", owner: "myorg", repo: "myrepo" };
let issueEditArgs: string[][] = [];
let currentLabels = new Set<string>();
let comments: Array<{ url: string; body: string }> = [];

function installGitHubMock(): void {
  let nextCommentId = 100;
  mockRunBoundGitHubCommand.mockImplementation(
    (
      _root: string,
      _config: GitHubConfig,
      args: readonly string[],
      options?: { input?: string },
    ) => {
      if (args[0] === "issue" && args[1] === "edit") {
        issueEditArgs.push([...args]);
        for (const arg of args) {
          if (arg.startsWith("--add-label=")) currentLabels.add(arg.slice(12));
          if (arg.startsWith("--remove-label=")) currentLabels.delete(arg.slice(15));
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", repository: REPOSITORY });
      }
      if (args[0] === "issue" && args[1] === "comment") {
        const url = `https://github.com/myorg/myrepo/issues/42#issuecomment-${nextCommentId++}`;
        comments.push({ url, body: options?.input ?? "" });
        return Promise.resolve({
          exitCode: 0,
          stdout: `${url}\n`,
          stderr: "",
          repository: REPOSITORY,
        });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            number: 42,
            url: "https://github.com/myorg/myrepo/issues/42",
            labels: [...currentLabels].map((name) => ({ name })),
            comments,
          }),
          stderr: "",
          repository: REPOSITORY,
        });
      }
      return Promise.reject(new Error(`Unexpected GitHub args: ${args.join(" ")}`));
    },
  );
}

describe("Status Syncer", () => {
  const baseConfig: GitHubConfig = {
    owner: "myorg",
    repo: "myrepo",
    reportBack: true,
    closeOnMerge: true,
    labels: {
      ready: "task-1342-ready-sentinel",
      inProgress: "task-1342-in-progress-sentinel",
      approved: "task-1342-approved-sentinel",
      rejected: "task-1342-rejected-sentinel",
      task: "task-1342-task-sentinel",
    },
  };

  beforeEach(() => {
    issueEditArgs = [];
    currentLabels = new Set<string>();
    comments = [];
    mockRunBoundGitHubCommand.mockReset();
    installGitHubMock();
  });

  it("syncs gate_passed to the configured ready label and confirms readback", async () => {
    const event: SyncEvent = {
      type: "gate_passed",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    await syncLifecycleEvent(42, event, baseConfig, PROJECT_ROOT);

    expect(issueEditArgs).toEqual([
      ["issue", "edit", "42", "--add-label=task-1342-ready-sentinel"],
    ]);
    expect(comments).toHaveLength(1);
    expect(mockRunBoundGitHubCommand.mock.calls.every((call) => call[0] === PROJECT_ROOT)).toBe(
      true,
    );
  });

  it("syncs dispatch_started to configured in-progress and ready labels", async () => {
    currentLabels.add("task-1342-ready-sentinel");
    const event: SyncEvent = {
      type: "dispatch_started",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    await syncLifecycleEvent(42, event, baseConfig, PROJECT_ROOT);

    expect(issueEditArgs).toEqual([
      ["issue", "edit", "42", "--add-label=task-1342-in-progress-sentinel"],
      ["issue", "edit", "42", "--remove-label=task-1342-ready-sentinel"],
    ]);
  });

  it.each([
    ["approved", "task-1342-approved-sentinel"],
    ["rejected", "task-1342-rejected-sentinel"],
  ])("syncs a %s dispatch_complete to configured labels", async (outcome, outcomeLabel) => {
    currentLabels.add("task-1342-in-progress-sentinel");
    const event: SyncEvent = {
      type: "dispatch_complete",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
      data: { outcome, feedback: "Missing tests" },
    };

    await syncLifecycleEvent(42, event, baseConfig, PROJECT_ROOT);

    expect(issueEditArgs).toEqual([
      ["issue", "edit", "42", `--add-label=${outcomeLabel}`],
      ["issue", "edit", "42", "--remove-label=task-1342-in-progress-sentinel"],
    ]);
  });

  it("does not sync a mapped task when reportBack is false", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-status-syncer-report-back-"));

    try {
      writeTestAdapter(projectRoot, { reportBack: false });
      const syncPath = path.join(projectRoot, ".quack", "sync", "github-sync.json");
      const originalSyncMap = JSON.stringify(
        {
          entries: [
            {
              taskId: "TASK-051",
              issueNumber: 42,
              direction: "published",
              createdAt: "2026-08-17T00:00:00.000Z",
              lastSyncedAt: "2026-08-17T00:00:00.000Z",
              issueState: "open",
              taskStatus: "READY",
            },
          ],
        },
        null,
        2,
      );
      fs.mkdirSync(path.dirname(syncPath), { recursive: true });
      fs.writeFileSync(syncPath, originalSyncMap, "utf-8");
      const adapter = await loadAdapter(projectRoot);

      await syncDispatchStarted(
        "TASK-051",
        "task-1342-model-sentinel",
        1,
        adapter.config,
        adapter.projectRoot,
      );

      expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
      expect(fs.readFileSync(syncPath, "utf-8")).toBe(originalSyncMap);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses every default label when labels config is missing", async () => {
    const config: GitHubConfig = { owner: "myorg", repo: "myrepo" };
    const events: SyncEvent[] = [
      { type: "gate_passed", taskId: "TASK-051", timestamp: "2026-08-17T12:00:00.000Z" },
      { type: "dispatch_started", taskId: "TASK-051", timestamp: "2026-08-17T12:00:00.000Z" },
      {
        type: "dispatch_complete",
        taskId: "TASK-051",
        timestamp: "2026-08-17T12:00:00.000Z",
        data: { outcome: "approved" },
      },
      {
        type: "dispatch_complete",
        taskId: "TASK-051",
        timestamp: "2026-08-17T12:00:00.000Z",
        data: { outcome: "rejected" },
      },
    ];

    for (const event of events) await syncLifecycleEvent(42, event, config, PROJECT_ROOT);

    expect(issueEditArgs).toEqual([
      ["issue", "edit", "42", "--add-label=quack-ready"],
      ["issue", "edit", "42", "--add-label=quack-in-progress"],
      ["issue", "edit", "42", "--remove-label=quack-ready"],
      ["issue", "edit", "42", "--add-label=quack-approved"],
      ["issue", "edit", "42", "--remove-label=quack-in-progress"],
      ["issue", "edit", "42", "--add-label=quack-rejected"],
      ["issue", "edit", "42", "--remove-label=quack-in-progress"],
    ]);
  });

  it("fails closed when label readback does not confirm the mutation", async () => {
    mockRunBoundGitHubCommand
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", repository: REPOSITORY })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/myorg/myrepo/issues/42",
          labels: [],
        }),
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(
      syncLifecycleEvent(
        42,
        {
          type: "gate_passed",
          taskId: "TASK-051",
          timestamp: "2026-08-17T12:00:00.000Z",
        },
        baseConfig,
        PROJECT_ROOT,
      ),
    ).rejects.toThrow("did not confirm addition");
  });
});
