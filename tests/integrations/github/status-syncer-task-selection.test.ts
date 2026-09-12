// TASK-1339-A R6: status sync resolves parent files canonically and every
// row lands as a typed synced or skipped outcome.
//
// The naive-control tests are MATCHER-ONLY CONTROLS. GitHub command calls
// are stubbed, while every task and sync-map read uses the real filesystem.

import * as fs from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../../../src/core/adapter-loader";
import { syncAllTasks } from "../../../src/integrations/github/status-syncer";
import {
  createDivergentTaskFixture,
  writeTestAdapter,
  type DivergentTaskFixture,
  type FixtureCreationOrder,
} from "../../helpers/divergent-task-fixture";

type RunBoundGitHubCommand =
  typeof import("../../../src/integrations/github/trusted-github").runBoundGitHubCommand;
const mockRunBoundGitHubCommand = jest.fn<
  ReturnType<RunBoundGitHubCommand>,
  Parameters<RunBoundGitHubCommand>
>();
let labelsByIssue = new Map<number, Set<string>>();

jest.mock("../../../src/integrations/github/trusted-github", () => ({
  ...jest.requireActual<object>("../../../src/integrations/github/trusted-github"),
  runBoundGitHubCommand: (...args: Parameters<RunBoundGitHubCommand>) =>
    mockRunBoundGitHubCommand(...args),
}));

const INITIAL_SYNC = "2026-08-17T00:00:00.000Z";

function writeSyncMap(
  fixture: DivergentTaskFixture,
  entry: { taskId: string; taskStatus: string; issueNumber?: number },
): string {
  const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
  fs.mkdirSync(path.dirname(syncPath), { recursive: true });
  fs.writeFileSync(
    syncPath,
    JSON.stringify(
      {
        entries: [
          {
            taskId: entry.taskId,
            issueNumber: entry.issueNumber ?? 42,
            direction: "published",
            createdAt: INITIAL_SYNC,
            lastSyncedAt: INITIAL_SYNC,
            issueState: "open",
            taskStatus: entry.taskStatus,
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return syncPath;
}

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: GitHub status sync parent selection (%s)",
  (order) => {
    let fixture: DivergentTaskFixture;

    beforeEach(() => {
      fixture = createDivergentTaskFixture(order, {
        prefix: "quack-status-sync-selection-",
        parent: { status: "COMPLETE" },
        child: { status: "READY" },
      });
      writeTestAdapter(fixture.root, { reportBack: true });
      labelsByIssue = new Map();
      mockRunBoundGitHubCommand.mockImplementation(
        (_root: string, config: { owner: string; repo: string }, args: readonly string[]) => {
          const issueNumber = Number(args[2]);
          const labels = labelsByIssue.get(issueNumber) ?? new Set<string>();
          labelsByIssue.set(issueNumber, labels);
          const repository = { host: "github.com", owner: config.owner, repo: config.repo };
          if (args[1] === "edit") {
            for (const arg of args) {
              if (arg.startsWith("--add-label=")) labels.add(arg.slice(12));
              if (arg.startsWith("--remove-label=")) labels.delete(arg.slice(15));
            }
            return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", repository });
          }
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              number: issueNumber,
              url: `https://github.com/${config.owner}/${config.repo}/issues/${issueNumber}`,
              labels: [...labels].map((name) => ({ name })),
            }),
            stderr: "",
            repository,
          });
        },
      );
      jest.clearAllMocks();
    });

    afterEach(() => fixture.cleanup());

    it("MATCHER-ONLY CONTROL: the naive prefix read selects the child", () => {
      expect(fixture.naiveSelection).toBe("TASK-100-A-child.md");
    });

    it("reads the parent's status and returns the synced row outcome", async () => {
      const syncPath = writeSyncMap(fixture, { taskId: "TASK-100", taskStatus: "READY" });
      const adapter = await loadAdapter(fixture.root);

      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
      const persisted = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskStatus: string; lastSyncedAt: string }>;
      };
      expect(persisted.entries[0]?.taskStatus).toBe("COMPLETE");
      expect(persisted.entries[0]?.lastSyncedAt).not.toBe(INITIAL_SYNC);
      expect(outcome).toEqual({
        outcomes: [
          {
            taskId: "TASK-100",
            issueNumber: 42,
            outcome: "synced",
            taskStatus: "COMPLETE",
            statusChanged: true,
          },
        ],
      });
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });

    it("skips an unresolvable legacy stem without advancing lastSyncedAt", async () => {
      const syncPath = writeSyncMap(fixture, {
        taskId: "TASK-100-parent",
        taskStatus: "READY",
        issueNumber: 43,
      });
      const adapter = await loadAdapter(fixture.root);

      const outcome = await syncAllTasks(adapter.config, adapter.projectRoot);
      const persisted = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskStatus: string; lastSyncedAt: string }>;
      };
      expect(persisted.entries[0]).toMatchObject({
        taskStatus: "READY",
        lastSyncedAt: INITIAL_SYNC,
      });
      expect(outcome).toEqual({
        outcomes: [
          {
            taskId: "TASK-100-parent",
            issueNumber: 43,
            outcome: "skipped",
            reason: "task_file_unresolvable",
          },
        ],
      });
      expect(fs.readFileSync(fixture.parentPath, "utf-8")).toBe(fixture.parentBefore);
      expect(fs.readFileSync(fixture.childPath, "utf-8")).toBe(fixture.childBefore);
    });
  },
);
