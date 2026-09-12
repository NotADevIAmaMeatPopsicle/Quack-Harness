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
let labelsByIssue = new Map<number, Set<string>>();
let commentsByIssue = new Map<number, Array<{ url: string; body: string }>>();
let nextCommentId = 1;
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

const INITIAL_SYNC = "2026-08-18T00:00:00.000Z";

describe("TASK-1338-E: status sync duplicate outcomes", () => {
  beforeEach(() => {
    capturedCommands = [];
    failingIssue = undefined;
    labelsByIssue = new Map();
    commentsByIssue = new Map();
    nextCommentId = 1;
    mockRunBoundGitHubCommand.mockReset();
    mockRunBoundGitHubCommand.mockImplementation(
      (
        _root: string,
        _config: { owner: string; repo: string },
        args: readonly string[],
        options?: { input?: string },
      ) => {
        const issueNumber = Number(args[2]);
        const repository = { host: "github.com", owner: "fixture", repo: "repo" };
        const labels = labelsByIssue.get(issueNumber) ?? new Set<string>();
        labelsByIssue.set(issueNumber, labels);
        const comments = commentsByIssue.get(issueNumber) ?? [];
        commentsByIssue.set(issueNumber, comments);
        if (args[0] === "issue" && args[1] === "edit") {
          capturedCommands.push(args.join(" "));
          if (failingIssue === issueNumber) {
            return Promise.reject(new Error("injected status gh failure"));
          }
          for (const arg of args) {
            if (arg.startsWith("--add-label=")) labels.add(arg.slice(12));
            if (arg.startsWith("--remove-label=")) labels.delete(arg.slice(15));
          }
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", repository });
        }
        if (args[0] === "issue" && args[1] === "comment") {
          capturedCommands.push(args.join(" "));
          const url = `https://github.com/fixture/repo/issues/${issueNumber}#issuecomment-${nextCommentId++}`;
          comments.push({ url, body: options?.input ?? "" });
          return Promise.resolve({ exitCode: 0, stdout: `${url}\n`, stderr: "", repository });
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            number: issueNumber,
            url: `https://github.com/fixture/repo/issues/${issueNumber}`,
            labels: [...labels].map((name) => ({ name })),
            comments,
          }),
          stderr: "",
          repository,
        });
      },
    );
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
      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
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
      await expect(syncAllTasks(adapter.config, adapter.projectRoot)).resolves.toEqual({
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
      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
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
            await syncDispatchStarted(
              fixture.taskId,
              "fixture-model",
              2,
              adapter.config,
              adapter.projectRoot,
            );
          } else if (mutator === "dispatch_complete") {
            await syncDispatchComplete(
              fixture.taskId,
              "approved",
              "fixture feedback",
              adapter.config,
              adapter.projectRoot,
            );
          } else if (mutator === "pr_created") {
            await syncPRCreated(
              fixture.taskId,
              "https://github.com/fixture/repo/pull/1",
              adapter.config,
              adapter.projectRoot,
            );
          } else {
            await syncTaskStatusToIssue(
              fixture.taskId,
              "COMPLETE",
              adapter.config,
              adapter.projectRoot,
            );
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
