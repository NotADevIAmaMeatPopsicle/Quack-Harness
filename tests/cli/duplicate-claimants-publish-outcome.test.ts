import * as fs from "node:fs";
import * as path from "node:path";

import { handlePublish } from "../../src/cli/publish";
import { taskSpec } from "../helpers/divergent-task-fixture";
import { createContestedTaskFixture } from "../helpers/task-1338e-fixture";

let failGh = false;

jest.mock("../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn(() => {
    if (failGh) return Promise.reject(new Error("CLI injected gh failure"));
    return Promise.resolve({
      stdout: "https://github.com/fixture/repo/issues/710\n",
      stderr: "",
    });
  }),
}));

describe("TASK-1338-E: publish CLI discriminated batch outcome", () => {
  beforeEach(() => {
    failGh = false;
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-18T15:00:00.000Z"));
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
          taskId: "TASK-510-clean",
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
      expect(output).toContain("TASK-500-alpha");
      expect(output).toContain("unparseable:TASK-511-malformed.md");
      expect(output).toContain("TASK-511-malformed.md");
      expect(output).toContain("publish_failed");
      expect(output).not.toContain("SAURUS-REM-999-bad.md");
      expect(exit).toHaveBeenCalledWith(1);

      const syncPath = path.join(fixture.root, ".quack", "sync", "github-sync.json");
      const syncMap = JSON.parse(fs.readFileSync(syncPath, "utf-8")) as {
        entries: Array<{ taskId: string }>;
      };
      expect(syncMap.entries.map((entry) => entry.taskId)).toEqual(["TASK-500-alpha"]);
    } finally {
      fixture.cleanup();
    }
  });
});
