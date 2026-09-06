import * as fs from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../../../src/core/adapter-loader";
import { formatDuplicateClaimantsMessage } from "../../../src/core/duplicate-claimants";
import { handleSync } from "../../../src/cli/sync";
import {
  syncAllTasks,
  syncDispatchComplete,
  syncDispatchStarted,
  syncPRCreated,
  syncTaskStatusToIssue,
} from "../../../src/integrations/github/status-syncer";
import { taskSpec, type FixtureCreationOrder } from "../../helpers/divergent-task-fixture";
import {
  createContestedTaskFixture,
  writeSyncMap,
  type ClaimantPopulation,
} from "../../helpers/task-1338e-fixture";

let capturedCommands: string[] = [];
let failingIssue: number | undefined;

jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn((args: string[]) => {
    const command = ["gh", ...args].join(" ");
    capturedCommands.push(command);
    if (failingIssue !== undefined && command.includes(`issue edit ${failingIssue} `)) {
      return Promise.reject(new Error("injected status gh failure"));
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }),
}));

const INITIAL_SYNC = "2026-08-18T00:00:00.000Z";

describe("TASK-1338-E: status sync duplicate outcomes", () => {
  beforeEach(() => {
    capturedCommands = [];
    failingIssue = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each<[ClaimantPopulation, FixtureCreationOrder]>([
    ["candidate", "child-first"],
    ["candidate", "parent-first"],
    ["cross-population", "child-first"],
    ["cross-population", "parent-first"],
  ])("refuses canonically resolvable %s claimants created %s", async (population, order) => {
    const fixture = createContestedTaskFixture(order, population, {
      withAdapter: true,
      reportBack: false,
      status: "COMPLETE",
    });
    const syncPath = writeSyncMap(fixture.root, [
      {
        taskId: fixture.taskId,
        issueNumber: 50,
        taskStatus: "READY",
      },
    ]);
    try {
      const adapter = await loadAdapter(fixture.root);
      const outcome = await syncAllTasks(adapter.config);
      expect(outcome).toEqual({
        outcomes: [
          {
            taskId: fixture.taskId,
            issueNumber: 50,
            outcome: "skipped",
            reason: "duplicate_claimants",
            claimants: fixture.claimants,
          },
        ],
      });
      const persisted = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskStatus: string; lastSyncedAt: string }>;
      };
      expect(persisted.entries[0]).toMatchObject({
        taskStatus: "READY",
        lastSyncedAt: INITIAL_SYNC,
      });
      expect(capturedCommands).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps a single claimant status syncable", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      withAdapter: true,
      reportBack: false,
      status: "COMPLETE",
    });
    fs.rmSync(fixture.claimantPaths[1]);
    const syncPath = writeSyncMap(fixture.root, [
      {
        taskId: fixture.taskId,
        issueNumber: 50,
        taskStatus: "READY",
      },
    ]);
    try {
      const adapter = await loadAdapter(fixture.root);
      await expect(syncAllTasks(adapter.config)).resolves.toEqual({
        outcomes: [
          {
            taskId: fixture.taskId,
            issueNumber: 50,
            outcome: "synced",
            taskStatus: "COMPLETE",
            statusChanged: true,
          },
        ],
      });
      const persisted = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskStatus: string; lastSyncedAt: string }>;
      };
      expect(persisted.entries[0]?.taskStatus).toBe("COMPLETE");
      expect(persisted.entries[0]?.lastSyncedAt).not.toBe(INITIAL_SYNC);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns the exhaustive three-arm skipped union without advancing timestamps", async () => {
    const fixture = createContestedTaskFixture("parent-first", "candidate", {
      withAdapter: true,
      reportBack: true,
      status: "COMPLETE",
    });
    const failureName = "TASK-502-status-failure.md";
    fs.writeFileSync(
      path.join(fixture.taskDir, failureName),
      taskSpec("TASK-502", { status: "COMPLETE" }),
      "utf-8",
    );
    const syncPath = writeSyncMap(fixture.root, [
      { taskId: fixture.taskId, issueNumber: 60, taskStatus: "READY" },
      { taskId: "TASK-501-legacy-stem", issueNumber: 61, taskStatus: "READY" },
      { taskId: "TASK-502", issueNumber: 62, taskStatus: "READY" },
    ]);
    failingIssue = 62;
    try {
      const adapter = await loadAdapter(fixture.root);
      const outcome = await syncAllTasks(adapter.config);
      expect(outcome).toEqual({
        outcomes: [
          {
            taskId: fixture.taskId,
            issueNumber: 60,
            outcome: "skipped",
            reason: "duplicate_claimants",
            claimants: fixture.claimants,
          },
          {
            taskId: "TASK-501-legacy-stem",
            issueNumber: 61,
            outcome: "skipped",
            reason: "task_file_unresolvable",
          },
          {
            taskId: "TASK-502",
            issueNumber: 62,
            outcome: "skipped",
            reason: "sync_failed",
            message: expect.stringContaining("injected status gh failure") as unknown as string,
          },
        ],
      });
      const persisted = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskStatus: string; lastSyncedAt: string }>;
      };
      expect(persisted.entries).toHaveLength(3);
      expect(
        persisted.entries.every(
          (entry) => entry.taskStatus === "READY" && entry.lastSyncedAt === INITIAL_SYNC,
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("prints the duplicate reason and claimants through the real sync CLI", async () => {
    const fixture = createContestedTaskFixture("child-first", "cross-population", {
      withAdapter: true,
      reportBack: false,
      status: "COMPLETE",
    });
    writeSyncMap(fixture.root, [
      {
        taskId: fixture.taskId,
        issueNumber: 70,
        taskStatus: "READY",
      },
    ]);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await handleSync({ github: true, project: fixture.root });
      const output = error.mock.calls.flat().join("\n");
      expect(output).toContain(fixture.taskId);
      expect(output).toContain("duplicate_claimants");
      for (const claimant of fixture.claimants) expect(output).toContain(claimant);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["dispatch_started", "dispatch_complete", "pr_created", "task_status"] as const)(
    "keeps the excluded %s mutator byte-identical between single and contested fixtures",
    async (mutator) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-08-18T14:00:00.000Z"));

      async function run(contested: boolean): Promise<{ commands: string[]; bytes: string }> {
        const fixture = createContestedTaskFixture("child-first", "candidate", {
          withAdapter: true,
          reportBack: true,
        });
        if (!contested) fs.rmSync(fixture.claimantPaths[1]);
        const syncPath = writeSyncMap(fixture.root, [
          {
            taskId: fixture.taskId,
            issueNumber: 80,
            taskStatus: "READY",
          },
        ]);
        const adapter = await loadAdapter(fixture.root);
        capturedCommands = [];
        try {
          if (mutator === "dispatch_started") {
            await syncDispatchStarted(fixture.taskId, "fixture-model", 2, adapter.config);
          } else if (mutator === "dispatch_complete") {
            await syncDispatchComplete(
              fixture.taskId,
              "approved",
              "fixture feedback",
              adapter.config,
            );
          } else if (mutator === "pr_created") {
            await syncPRCreated(
              fixture.taskId,
              "https://github.com/fixture/repo/pull/1",
              adapter.config,
            );
          } else {
            await syncTaskStatusToIssue(fixture.taskId, "COMPLETE", adapter.config);
          }
          return {
            commands: [...capturedCommands],
            bytes: fs.readFileSync(syncPath, "utf-8"),
          };
        } finally {
          fixture.cleanup();
        }
      }

      const single = await run(false);
      const contested = await run(true);
      expect(contested.commands).toEqual(single.commands);
      expect(contested.bytes).toBe(single.bytes);
    },
  );

  it("uses the shared duplicate message formatter without changing the status outcome shape", () => {
    const claimants = ["TASK-500-alpha.md", "TASK-500-zeta.md"];
    expect(formatDuplicateClaimantsMessage("TASK-500", claimants)).toContain(claimants.join(", "));
  });
});
