import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DuplicateClaimantAdmissionError,
  formatDuplicateClaimantsMessage,
} from "../../../src/core/duplicate-claimants";
import type { GitHubConfig } from "../../../src/integrations/github/github-types";
import { taskSpec, type FixtureCreationOrder } from "../../helpers/divergent-task-fixture";
import {
  createContestedTaskFixture,
  type ClaimantPopulation,
} from "../../helpers/task-1338e-fixture";

let capturedCommands: string[] = [];
let failPublish = false;

jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn((args: string[]) => {
    const command = ["gh", ...args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))].join(" ");
    capturedCommands.push(command);
    if (failPublish) return Promise.reject(new Error("injected gh failure"));
    return Promise.resolve({
      stdout: "https://github.com/fixture/repo/issues/700\n",
      stderr: "",
    });
  }),
}));

import { publishAllBacklog, publishTask } from "../../../src/integrations/github/issue-publisher";

const CONFIG: GitHubConfig = {
  owner: "fixture",
  repo: "repo",
  publishLabel: "quack-task",
};

interface PublishedRow {
  taskId: string;
  issueNumber: number;
  url: string;
}

type SkippedRow =
  | {
      taskId: string;
      file: string;
      reason: "duplicate_claimants";
      claimants: string[];
      message: string;
    }
  | {
      taskId: string;
      file: string;
      reason: "publish_failed";
      message: string;
    };

interface PublishOutcome {
  published: PublishedRow[];
  skipped: SkippedRow[];
}

describe("TASK-1338-E: GitHub issue publisher duplicate vetoes", () => {
  beforeEach(() => {
    capturedCommands = [];
    failPublish = false;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<[ClaimantPopulation, FixtureCreationOrder]>([
    ["candidate", "child-first"],
    ["candidate", "parent-first"],
    ["cross-population", "child-first"],
    ["cross-population", "parent-first"],
  ])(
    "single publish refuses %s claimants created %s before issue creation",
    async (population, order) => {
      const fixture = createContestedTaskFixture(order, population);
      try {
        await expect(
          publishTask(fixture.taskId, fixture.root, CONFIG, fixture.relativeTaskDir),
        ).rejects.toMatchObject<Partial<DuplicateClaimantAdmissionError>>({
          name: "DuplicateClaimantAdmissionError",
          code: "duplicate_claimants",
          taskId: fixture.taskId,
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        });
        expect(capturedCommands).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("keeps a single claimant publishable", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate");
    fs.rmSync(fixture.claimantPaths[1]);
    try {
      await expect(
        publishTask(fixture.taskId, fixture.root, CONFIG, fixture.relativeTaskDir),
      ).resolves.toEqual({
        issueNumber: 700,
        url: "https://github.com/fixture/repo/issues/700",
      });
      expect(capturedCommands).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it.each<[ClaimantPopulation, FixtureCreationOrder]>([
    ["candidate", "child-first"],
    ["candidate", "parent-first"],
    ["cross-population", "child-first"],
    ["cross-population", "parent-first"],
  ])("batch refuses every eligible %s claimant row when created %s", async (population, order) => {
    const fixture = createContestedTaskFixture(order, population);
    try {
      const outcome = (await publishAllBacklog(
        fixture.root,
        fixture.relativeTaskDir,
        CONFIG,
      )) as unknown as PublishOutcome;
      const eligibleFiles = fixture.claimants.filter((file) => file.startsWith("TASK-"));
      expect(outcome.published).toEqual([]);
      expect(outcome.skipped).toEqual(
        eligibleFiles.map((file) => ({
          taskId: fixture.taskId,
          file,
          reason: "duplicate_claimants",
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        })),
      );
      expect(capturedCommands).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns one duplicate row per eligible claimant and publishes the clean row", async () => {
    const fixture = createContestedTaskFixture("parent-first", "candidate");
    const cleanName = "TASK-501-clean.md";
    fs.writeFileSync(
      path.join(fixture.taskDir, cleanName),
      taskSpec("TASK-501", { title: "Clean publish", status: "BACKLOG" }),
      "utf-8",
    );
    try {
      const outcome = (await publishAllBacklog(
        fixture.root,
        fixture.relativeTaskDir,
        CONFIG,
      )) as unknown as PublishOutcome;

      expect(outcome.published).toEqual([
        {
          taskId: "TASK-501-clean",
          issueNumber: 700,
          url: "https://github.com/fixture/repo/issues/700",
        },
      ]);
      expect(outcome.skipped).toEqual(
        fixture.claimants.map((file) => ({
          taskId: fixture.taskId,
          file,
          reason: "duplicate_claimants",
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        })),
      );
      expect(capturedCommands).toHaveLength(1);
      expect(capturedCommands[0]).toContain("TASK-501: Clean publish");
    } finally {
      fixture.cleanup();
    }
  });

  it("uses SAURUS claimants for discovery without publishing a SAURUS row", async () => {
    const fixture = createContestedTaskFixture("child-first", "cross-population");
    try {
      const outcome = (await publishAllBacklog(
        fixture.root,
        fixture.relativeTaskDir,
        CONFIG,
      )) as unknown as PublishOutcome;

      expect(outcome.published).toEqual([]);
      expect(outcome.skipped).toEqual([
        {
          taskId: fixture.taskId,
          file: `${fixture.taskId}-alpha.md`,
          reason: "duplicate_claimants",
          claimants: fixture.claimants,
          message: formatDuplicateClaimantsMessage(fixture.taskId, fixture.claimants),
        },
      ]);
      expect(outcome.skipped.some((row) => row.file.startsWith("SAURUS-REM-"))).toBe(false);
      expect(capturedCommands).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns a publish_failed row instead of dropping an injected gh failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-task-1338e-publish-failure-"));
    const taskDir = path.join(root, "docs", "tasks");
    const file = "TASK-502-failing.md";
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, file),
      taskSpec("TASK-502", { status: "BACKLOG" }),
      "utf-8",
    );
    failPublish = true;
    try {
      const outcome = (await publishAllBacklog(
        root,
        "docs/tasks",
        CONFIG,
      )) as unknown as PublishOutcome;
      expect(outcome).toEqual({
        published: [],
        skipped: [
          {
            taskId: "TASK-502",
            file,
            reason: "publish_failed",
            message: expect.stringContaining("injected gh failure") as unknown as string,
          },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a malformed SAURUS declaration and still publishes a valid task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-task-1338e-bad-saurus-"));
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "SAURUS-REM-999-bad.md"), "not a task\n", "utf-8");
    fs.writeFileSync(
      path.join(taskDir, "TASK-504-clean.md"),
      taskSpec("TASK-504", { status: "BACKLOG" }),
      "utf-8",
    );
    try {
      await expect(publishAllBacklog(root, "docs/tasks", CONFIG)).resolves.toEqual({
        published: [
          {
            taskId: "TASK-504-clean",
            issueNumber: 700,
            url: "https://github.com/fixture/repo/issues/700",
          },
        ],
        skipped: [],
      });
      expect(capturedCommands).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns a malformed TASK candidate into a noncanonical publish_failed row", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-task-1338e-bad-task-"));
    const taskDir = path.join(root, "docs", "tasks");
    const malformedFile = "TASK-505-malformed.md";
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, malformedFile), "not a task\n", "utf-8");
    fs.writeFileSync(
      path.join(taskDir, "TASK-506-clean.md"),
      taskSpec("TASK-506", { status: "BACKLOG" }),
      "utf-8",
    );
    try {
      const outcome = await publishAllBacklog(root, "docs/tasks", CONFIG);
      expect(outcome.published).toEqual([
        {
          taskId: "TASK-506-clean",
          issueNumber: 700,
          url: "https://github.com/fixture/repo/issues/700",
        },
      ]);
      expect(outcome.skipped).toEqual([
        {
          taskId: `unparseable:${malformedFile}`,
          file: malformedFile,
          reason: "publish_failed",
          message: expect.stringContaining("Missing required H1 heading") as unknown as string,
        },
      ]);
      expect(capturedCommands).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a real parent identity distinct from a malformed child-like filename", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-task-1338e-bad-task-collision-"));
    const taskDir = path.join(root, "docs", "tasks");
    const parentFile = "TASK-500.md";
    const malformedFile = "TASK-500-x-bad.md";
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, parentFile),
      taskSpec("TASK-500", { status: "BACKLOG" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(taskDir, malformedFile), "not a task\n", "utf-8");
    try {
      const outcome = await publishAllBacklog(root, "docs/tasks", CONFIG);
      expect(outcome).toEqual({
        published: [
          {
            taskId: "TASK-500",
            issueNumber: 700,
            url: "https://github.com/fixture/repo/issues/700",
          },
        ],
        skipped: [
          {
            taskId: `unparseable:${malformedFile}`,
            file: malformedFile,
            reason: "publish_failed",
            message: expect.stringContaining("Missing required H1 heading") as unknown as string,
          },
        ],
      });
      const rowIds = [
        ...outcome.published.map((row) => row.taskId),
        ...outcome.skipped.map((row) => row.taskId),
      ];
      expect(rowIds).toEqual(["TASK-500", `unparseable:${malformedFile}`]);
      expect(new Set(rowIds).size).toBe(2);
      expect(capturedCommands).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enumerates once, avoids claimant queries, and parses each discovery candidate once", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate");
    const cleanName = "TASK-503-clean.md";
    const cleanPath = path.join(fixture.taskDir, cleanName);
    fs.writeFileSync(cleanPath, taskSpec("TASK-503", { status: "BACKLOG" }), "utf-8");

    const fsPromisesModule =
      jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const taskParserModule = jest.requireActual<typeof import("../../../src/core/task-parser")>(
      "../../../src/core/task-parser",
    );
    const taskFileResolverModule = jest.requireActual<
      typeof import("../../../src/core/task-file-resolver")
    >("../../../src/core/task-file-resolver");
    const readdirSpy = jest.spyOn(fsPromisesModule, "readdir");
    const readFileSpy = jest.spyOn(fsPromisesModule, "readFile");
    const parseSpy = jest.spyOn(taskParserModule, "parseTaskFile");
    const duplicateQuerySpy = jest.spyOn(taskFileResolverModule, "listDuplicateClaimants");
    try {
      await publishAllBacklog(fixture.root, fixture.relativeTaskDir, CONFIG);

      expect(readdirSpy).toHaveBeenCalledTimes(1);
      expect(readdirSpy).toHaveBeenCalledWith(fixture.taskDir, { withFileTypes: true });
      expect(duplicateQuerySpy).not.toHaveBeenCalled();
      expect(parseSpy).toHaveBeenCalledTimes(3);
      for (const taskPath of [...fixture.claimantPaths, cleanPath]) {
        const reads = readFileSpy.mock.calls.filter(([filePath]) => filePath === taskPath);
        expect(reads).toHaveLength(1);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
