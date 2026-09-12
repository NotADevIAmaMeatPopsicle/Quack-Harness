import * as fs from "node:fs";
import * as path from "node:path";

import { handlePublish } from "../../src/cli/publish";
import { taskSpec } from "../helpers/divergent-task-fixture";
import { createContestedTaskFixture } from "../helpers/task-1338e-fixture";

type RunBoundGitHubCommand =
  typeof import("../../src/integrations/github/trusted-github").runBoundGitHubCommand;
const mockRunBoundGitHubCommand = jest.fn<
  ReturnType<RunBoundGitHubCommand>,
  Parameters<RunBoundGitHubCommand>
>();

type ReadBoundGitHubIssuePage =
  typeof import("../../src/integrations/github/trusted-github").readBoundGitHubIssuePage;
const mockReadBoundGitHubIssuePage = jest.fn<
  ReturnType<ReadBoundGitHubIssuePage>,
  Parameters<ReadBoundGitHubIssuePage>
>();

jest.mock("../../src/integrations/github/trusted-github", () => ({
  ...jest.requireActual<object>("../../src/integrations/github/trusted-github"),
  runBoundGitHubCommand: (...args: Parameters<RunBoundGitHubCommand>) =>
    mockRunBoundGitHubCommand(...args),
  readBoundGitHubIssuePage: (...args: Parameters<ReadBoundGitHubIssuePage>) =>
    mockReadBoundGitHubIssuePage(...args),
}));

const REPOSITORY = { host: "github.com", owner: "fixture-owner", repo: "fixture-repo" };
const ISSUE_URL = "https://github.com/fixture-owner/fixture-repo/issues/710";
let failGh = false;

describe("TASK-1338-E: publish CLI discriminated batch outcome", () => {
  beforeEach(() => {
    failGh = false;
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-18T15:00:00.000Z"));
    let createdIssue: { title: string; body: string; label: string } | undefined;
    const result = (stdout: string) =>
      Promise.resolve({
        exitCode: 0,
        stdout,
        stderr: "",
        repository: REPOSITORY,
      });
    mockReadBoundGitHubIssuePage.mockReset().mockImplementation((_root, config, after) => {
      expect(config).toMatchObject({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });
      if (after !== undefined) return Promise.reject(new Error("Unexpected issue-page cursor"));
      if (failGh) return Promise.reject(new Error("CLI injected gh failure"));
      return result(
        JSON.stringify({
          data: {
            repository: {
              nameWithOwner: "fixture-owner/fixture-repo",
              issues: {
                nodes: [],
                totalCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    });
    mockRunBoundGitHubCommand.mockReset().mockImplementation((_root, config, args, options) => {
      expect(config).toMatchObject({ owner: REPOSITORY.owner, repo: REPOSITORY.repo });
      if (
        args.length === 6 &&
        args[0] === "issue" &&
        args[1] === "create" &&
        args[2]?.startsWith("--title=") &&
        args[3]?.startsWith("--label=") &&
        args[4] === "--body-file" &&
        args[5] === "-" &&
        typeof options?.input === "string"
      ) {
        createdIssue = { title: args[2].slice(8), label: args[3].slice(8), body: options.input };
        return result(ISSUE_URL + "\n");
      }
      const viewArgs = ["issue", "view", "710", "--json", "number,url,title,body,labels,state"];
      if (
        createdIssue &&
        args.length === viewArgs.length &&
        args.every((argument, index) => argument === viewArgs[index])
      ) {
        return result(
          JSON.stringify({
            number: 710,
            url: ISSUE_URL,
            title: createdIssue.title,
            body: createdIssue.body,
            labels: [{ name: createdIssue.label }],
            state: "OPEN",
          }),
        );
      }
      return Promise.reject(new Error("Unexpected GitHub args: " + args.join(" ")));
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("prints duplicate rows, exits nonzero, and maps only the clean published row", async () => {
    const fixture = createContestedTaskFixture("parent-first", "candidate", {
      withAdapter: true,
    });
    const cleanName = "TASK-510-clean.md";
    fs.writeFileSync(
      path.join(fixture.taskDir, cleanName),
      taskSpec("TASK-510", { title: "CLI clean row", status: "BACKLOG" }),
      "utf-8",
    );
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await handlePublish({ allBacklog: true, project: fixture.root });

      const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
      expect(output).toContain(fixture.taskId);
      expect(output).toContain("duplicate_claimants");
      for (const claimant of fixture.claimants) expect(output).toContain(claimant);
      expect(exit).toHaveBeenCalledWith(1);

      const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
      const syncMap = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskId: string; issueNumber: number }>;
      };
      expect(syncMap.entries).toEqual([
        {
          taskId: "TASK-510",
          issueNumber: 710,
          direction: "published",
          createdAt: "2026-08-18T15:00:00.000Z",
          lastSyncedAt: "2026-08-18T15:00:00.000Z",
          issueState: "open",
          taskStatus: "BACKLOG",
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("prints publish_failed detail and never reports the failed row as success", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      withAdapter: true,
    });
    fs.rmSync(fixture.claimantPaths[1]);
    failGh = true;
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await handlePublish({ allBacklog: true, project: fixture.root });

      const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
      expect(output).toContain(fixture.taskId);
      expect(output).toContain(`${fixture.taskId}-alpha.md`);
      expect(output).toContain("publish_failed");
      expect(output).toContain("CLI injected gh failure");
      expect(output).not.toContain("Published 1 task");
      expect(exit).toHaveBeenCalledWith(1);

      const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
      const syncMap = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: unknown[];
      };
      expect(syncMap.entries).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not abort on malformed discovery candidates and persists the valid publish", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      withAdapter: true,
    });
    fs.rmSync(fixture.claimantPaths[1]);
    fs.writeFileSync(path.join(fixture.taskDir, "SAURUS-REM-999-bad.md"), "not a task\n", "utf-8");
    fs.writeFileSync(path.join(fixture.taskDir, "TASK-511-malformed.md"), "not a task\n", "utf-8");
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await handlePublish({ allBacklog: true, project: fixture.root });

      const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
      expect(output).toContain("TASK-500");
      expect(output).toContain("unparseable:TASK-511-malformed.md");
      expect(output).toContain("TASK-511-malformed.md");
      expect(output).toContain("publish_failed");
      expect(output).not.toContain("SAURUS-REM-999-bad.md");
      expect(exit).toHaveBeenCalledWith(1);

      const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
      const syncMap = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskId: string }>;
      };
      expect(syncMap.entries.map((entry) => entry.taskId)).toEqual(["TASK-500"]);
    } finally {
      fixture.cleanup();
    }
  });
});
