import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubConfig } from "../../../src/integrations/github/github-types";
import {
  createDivergentTaskFixture,
  taskSpec,
  writeTestAdapter,
  type FixtureCreationOrder,
} from "../../helpers/divergent-task-fixture";

let mockExecCommands: string[] = [];
let mockGhBodies: string[] = [];
let mockExecImpl: (args: string[]) => Promise<{ stdout: string; stderr: string }> = () =>
  Promise.resolve({
    stdout: "https://github.com/fixture/repo/issues/321\n",
    stderr: "",
  });

jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: jest.fn(async (args: string[], options?: { input?: string }) => {
    const command = ["gh", ...args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))].join(" ");
    mockExecCommands.push(command);
    mockGhBodies.push(options?.input ?? "");
    return mockExecImpl(args);
  }),
}));

import { handlePublish } from "../../../src/cli/publish";
import { publishTask } from "../../../src/integrations/github/issue-publisher";

const GITHUB_CONFIG: GitHubConfig = {
  owner: "fixture",
  repo: "repo",
  publishLabel: "quack-task",
};

function createPublishProject(taskDir: string): { root: string; syncPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-publish-all-path-"));
  const relativeFile = path.join(taskDir, "TASK-240-publish-me.md");
  const taskPath = path.join(root, relativeFile);
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(
    taskPath,
    taskSpec("TASK-240", {
      title: "Publish me",
      status: "BACKLOG",
      tags: ["github"],
    }),
    "utf-8",
  );

  const adapterPath = writeTestAdapter(root, GITHUB_CONFIG);
  const adapterJson = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
    project: { taskDir: string };
  };
  adapterJson.project.taskDir = taskDir.replace(/\\/g, "/");
  fs.writeFileSync(adapterPath, JSON.stringify(adapterJson, null, 2), "utf-8");
  return { root, syncPath: path.join(root, ".quack", "sync", "github-sync.json") };
}

describe("TASK-1339-B: issue publisher canonical paths", () => {
  beforeEach(() => {
    mockExecCommands = [];
    mockGhBodies = [];
    mockExecImpl = () =>
      Promise.resolve({
        stdout: "https://github.com/fixture/repo/issues/321\n",
        stderr: "",
      });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each<FixtureCreationOrder>(["child-first", "parent-first"])(
    "single publish selects the descriptive parent and reports its exact path when created %s",
    async (order) => {
      const fixture = createDivergentTaskFixture(order, {
        prefix: "quack-publish-single-path-",
        parent: { title: "Canonical parent issue", status: "BACKLOG" },
        child: { title: "Wrong child issue", status: "BACKLOG" },
      });
      try {
        const result = await publishTask("TASK-100", fixture.root, GITHUB_CONFIG, "docs/tasks");

        expect(result).toEqual({
          issueNumber: 321,
          url: "https://github.com/fixture/repo/issues/321",
        });
        expect(mockExecCommands).toHaveLength(1);
        const command = mockExecCommands[0];
        const body = mockGhBodies[0];
        expect(command).toContain('--title "TASK-100: Canonical parent issue"');
        expect(command).not.toContain("Wrong child issue");
        expect(body).toContain("from `docs/tasks/TASK-100-parent.md`");
        expect(body).not.toContain(fixture.root);
        expect(body).not.toContain("\\");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("publish-all preserves the legacy stem sync identity byte-for-byte across task directories", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-17T15:30:00.000Z"));
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const legacy = createPublishProject("docs/tasks");
    const custom = createPublishProject("project/work-items");
    try {
      await handlePublish({ allBacklog: true, project: legacy.root });
      const legacyBytes = fs.readFileSync(legacy.syncPath, "utf-8");
      const goldenBytes = [
        "{",
        '  "entries": [',
        "    {",
        '      "taskId": "TASK-240-publish-me",',
        '      "issueNumber": 321,',
        '      "direction": "published",',
        '      "createdAt": "2026-08-17T15:30:00.000Z",',
        '      "lastSyncedAt": "2026-08-17T15:30:00.000Z",',
        '      "issueState": "open",',
        '      "taskStatus": "BACKLOG"',
        "    }",
        "  ]",
        "}",
      ].join("\n");
      expect(legacyBytes).toBe(goldenBytes);

      await handlePublish({ allBacklog: true, project: custom.root });
      const customBytes = fs.readFileSync(custom.syncPath, "utf-8");
      expect(customBytes).toBe(goldenBytes);

      const bodies = mockGhBodies;
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain("from `docs/tasks/TASK-240-publish-me.md`");
      expect(bodies[1]).toContain("from `project/work-items/TASK-240-publish-me.md`");
      expect(
        bodies.every(
          (body) =>
            !body.includes("\\") && !body.includes(legacy.root) && !body.includes(custom.root),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(legacy.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fs.rmSync(custom.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
