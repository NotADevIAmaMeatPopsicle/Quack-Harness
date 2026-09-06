// ─── Status Syncer Tests ────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter } from "../../../src/core/adapter-loader";
import {
  syncDispatchStarted,
  syncLifecycleEvent,
} from "../../../src/integrations/github/status-syncer";
import type { GitHubConfig, SyncEvent } from "../../../src/integrations/github/github-types";
import { writeTestAdapter } from "../../helpers/divergent-task-fixture";

const mockExecCommands: string[] = [];

jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn((args: string[]) => {
    const command = [
      "gh",
      ...args.map((arg, index) =>
        ["--add-label", "--remove-label", "--title", "--label"].includes(args[index - 1])
          ? `"${arg}"`
          : arg,
      ),
    ].join(" ");
    mockExecCommands.push(command);
    return Promise.resolve({ stdout: "", stderr: "" });
  }),
}));

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
    mockExecCommands.length = 0;
  });

  it("syncs gate_passed to the configured ready label", async () => {
    const event: SyncEvent = {
      type: "gate_passed",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    await syncLifecycleEvent(42, event, baseConfig);

    const issueEditCommands = mockExecCommands.filter((command) =>
      command.startsWith("gh issue edit "),
    );
    expect(issueEditCommands).toHaveLength(1);
    expect(issueEditCommands).toEqual([
      'gh issue edit 42 --repo myorg/myrepo --add-label "task-1342-ready-sentinel"',
    ]);
  });

  it("syncs dispatch_started to configured in-progress and ready labels", async () => {
    const event: SyncEvent = {
      type: "dispatch_started",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    await syncLifecycleEvent(42, event, baseConfig);

    const issueEditCommands = mockExecCommands.filter((command) =>
      command.startsWith("gh issue edit "),
    );
    expect(issueEditCommands).toHaveLength(2);
    expect(issueEditCommands).toEqual([
      'gh issue edit 42 --repo myorg/myrepo --add-label "task-1342-in-progress-sentinel"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "task-1342-ready-sentinel"',
    ]);
  });

  it("syncs an approved dispatch_complete to configured labels", async () => {
    const event: SyncEvent = {
      type: "dispatch_complete",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
      data: { outcome: "approved" },
    };

    await syncLifecycleEvent(42, event, baseConfig);

    const issueEditCommands = mockExecCommands.filter((command) =>
      command.startsWith("gh issue edit "),
    );
    expect(issueEditCommands).toHaveLength(2);
    expect(issueEditCommands).toEqual([
      'gh issue edit 42 --repo myorg/myrepo --add-label "task-1342-approved-sentinel"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "task-1342-in-progress-sentinel"',
    ]);
  });

  it("syncs a rejected dispatch_complete to configured labels", async () => {
    const event: SyncEvent = {
      type: "dispatch_complete",
      taskId: "TASK-051",
      timestamp: "2026-08-17T12:00:00.000Z",
      data: { outcome: "rejected", feedback: "Missing tests" },
    };

    await syncLifecycleEvent(42, event, baseConfig);

    const issueEditCommands = mockExecCommands.filter((command) =>
      command.startsWith("gh issue edit "),
    );
    expect(issueEditCommands).toHaveLength(2);
    expect(issueEditCommands).toEqual([
      'gh issue edit 42 --repo myorg/myrepo --add-label "task-1342-rejected-sentinel"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "task-1342-in-progress-sentinel"',
    ]);
  });

  it("does not sync a mapped task when reportBack is false", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-status-syncer-report-back-"));

    try {
      writeTestAdapter(projectRoot, {
        reportBack: false,
        labels: {
          ready: "task-1342-disabled-ready-sentinel",
          inProgress: "task-1342-disabled-in-progress-sentinel",
          approved: "task-1342-disabled-approved-sentinel",
          rejected: "task-1342-disabled-rejected-sentinel",
          task: "task-1342-disabled-task-sentinel",
        },
      });
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

      await syncDispatchStarted("TASK-051", "task-1342-model-sentinel", 1, adapter.config);

      expect(mockExecCommands).toHaveLength(0);
      expect(mockExecCommands).toEqual([]);
      expect(fs.readFileSync(syncPath, "utf-8")).toBe(originalSyncMap);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses every default label through production when labels config is missing", async () => {
    const config: GitHubConfig = {
      owner: "myorg",
      repo: "myrepo",
    };
    const events: SyncEvent[] = [
      {
        type: "gate_passed",
        taskId: "TASK-051",
        timestamp: "2026-08-17T12:00:00.000Z",
      },
      {
        type: "dispatch_started",
        taskId: "TASK-051",
        timestamp: "2026-08-17T12:00:00.000Z",
      },
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

    for (const event of events) {
      await syncLifecycleEvent(42, event, config);
    }

    const issueEditCommands = mockExecCommands.filter((command) =>
      command.startsWith("gh issue edit "),
    );
    expect(issueEditCommands).toHaveLength(7);
    expect(issueEditCommands).toEqual([
      'gh issue edit 42 --repo myorg/myrepo --add-label "quack-ready"',
      'gh issue edit 42 --repo myorg/myrepo --add-label "quack-in-progress"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "quack-ready"',
      'gh issue edit 42 --repo myorg/myrepo --add-label "quack-approved"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "quack-in-progress"',
      'gh issue edit 42 --repo myorg/myrepo --add-label "quack-rejected"',
      'gh issue edit 42 --repo myorg/myrepo --remove-label "quack-in-progress"',
    ]);
  });
});
