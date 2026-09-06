import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubIssue } from "../../../src/integrations/github/github-types";
import { taskSpec, writeTestAdapter } from "../../helpers/divergent-task-fixture";

jest.mock("../../../src/integrations/github/issue-fetcher", () => ({
  fetchIssue: jest.fn(),
  fetchIssuesByLabel: jest.fn(),
}));
jest.mock("../../../src/planner/planner-agent", () => ({
  planTasks: jest.fn(),
}));
jest.mock("../../../src/gate/gate", () => ({
  runReadinessGate: jest.fn(),
}));
jest.mock("../../../src/integrations/github/comment-thread", () => ({
  postLifecycleComment: jest.fn(),
}));

import { loadAdapter } from "../../../src/core/adapter-loader";
import { runReadinessGate } from "../../../src/gate/gate";
import { postLifecycleComment } from "../../../src/integrations/github/comment-thread";
import { fetchIssue } from "../../../src/integrations/github/issue-fetcher";
import { importIssue } from "../../../src/integrations/github/import-pipeline";
import { planTasks } from "../../../src/planner/planner-agent";

const mockFetchIssue = jest.mocked(fetchIssue);
const mockPlanTasks = jest.mocked(planTasks);
const mockRunReadinessGate = jest.mocked(runReadinessGate);
const mockPostLifecycleComment = jest.mocked(postLifecycleComment);

const ISSUE: GitHubIssue = {
  number: 210,
  title: "Import a descriptive task",
  body: "Use the planner's actual output path.",
  labels: ["task"],
  assignees: [],
  comments: [],
  referencedFiles: [],
  linkedPRs: [],
  state: "open",
  url: "https://github.com/fixture/repo/issues/210",
};

describe("TASK-1339-B: import pipeline consumes PlannerResult.filePaths", () => {
  let projectRoot: string;

  beforeEach(() => {
    jest.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-import-threaded-path-"));
    const adapterPath = writeTestAdapter(projectRoot, { reportBack: true });
    const adapterJson = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
      project: { taskDir: string };
    };
    adapterJson.project.taskDir = "generated/specs";
    fs.writeFileSync(adapterPath, JSON.stringify(adapterJson, null, 2), "utf-8");

    mockFetchIssue.mockResolvedValue(ISSUE);
    mockPostLifecycleComment.mockResolvedValue(undefined);
    mockRunReadinessGate.mockImplementation((task) => Promise.resolve({ outcome: "pass", task }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("loads the descriptive planner path and reports that exact repository-relative path", async () => {
    const taskPath = path.join(projectRoot, "generated", "specs", "TASK-210-descriptive-import.md");
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    const content = taskSpec("TASK-210", {
      title: "Threaded descriptive import",
      status: "BACKLOG",
    });
    fs.writeFileSync(taskPath, content, "utf-8");
    mockPlanTasks.mockResolvedValue({
      taskIds: ["TASK-210"],
      specs: [content],
      filePaths: [taskPath],
    });

    const adapter = await loadAdapter(projectRoot);
    const result = await importIssue(210, adapter, false);

    expect(result).toMatchObject({ taskId: "TASK-210", gateResult: { passed: true } });
    expect(mockRunReadinessGate).toHaveBeenCalledTimes(1);
    expect(mockRunReadinessGate.mock.calls[0][0].rawContent).toContain(
      "Threaded descriptive import",
    );
    expect(mockPostLifecycleComment.mock.calls[0][1]).toMatchObject({
      type: "task_created",
      taskId: "TASK-210",
      data: { specPath: "generated/specs/TASK-210-descriptive-import.md" },
    });
    expect(mockPostLifecycleComment.mock.calls[0][1].data?.specPath).not.toContain("\\");
  });

  // Mutation-bite record (2026-08-17): a temporary canonical resolver selected the
  // TASK-210-a-decoy.md content, so this arm failed at the threaded gate-content assertion.
  it.each(["decoy-first", "threaded-first"] as const)(
    "keeps the planner path with a competing same-id file created %s",
    async (creationOrder) => {
      const taskDir = path.join(projectRoot, "generated", "specs");
      const decoyPath = path.join(taskDir, "TASK-210-a-decoy.md");
      const threadedPath = path.join(taskDir, "TASK-210-z-threaded-import.md");
      fs.mkdirSync(taskDir, { recursive: true });
      const decoyContent = taskSpec("TASK-210", {
        title: "Canonical decoy import",
        status: "BACKLOG",
      });
      const threadedContent = taskSpec("TASK-210", {
        title: "Planner threaded import",
        status: "BACKLOG",
      });
      const files =
        creationOrder === "decoy-first"
          ? [
              [decoyPath, decoyContent],
              [threadedPath, threadedContent],
            ]
          : [
              [threadedPath, threadedContent],
              [decoyPath, decoyContent],
            ];
      for (const [filePath, content] of files) {
        fs.writeFileSync(filePath, content, "utf-8");
      }
      mockPlanTasks.mockResolvedValue({
        taskIds: ["TASK-210"],
        specs: [threadedContent],
        filePaths: [threadedPath],
      });

      const adapter = await loadAdapter(projectRoot);
      await importIssue(210, adapter, false);

      const gatedTask = mockRunReadinessGate.mock.calls[0][0];
      expect(gatedTask.rawContent).toContain("Planner threaded import");
      expect(gatedTask.rawContent).not.toContain("Canonical decoy import");
      expect(mockPostLifecycleComment.mock.calls[0][1]).toMatchObject({
        type: "task_created",
        data: { specPath: "generated/specs/TASK-210-z-threaded-import.md" },
      });
    },
  );

  it.each([
    ["missing", { taskIds: ["TASK-210"], specs: [taskSpec("TASK-210")] }],
    ["empty", { taskIds: ["TASK-210"], specs: [taskSpec("TASK-210")], filePaths: [] }],
  ])(
    "rejects a %s filePaths result before sync-map and lifecycle side effects",
    async (_label, plannerResult) => {
      mockPlanTasks.mockResolvedValue(plannerResult as Awaited<ReturnType<typeof planTasks>>);
      const adapter = await loadAdapter(projectRoot);

      await expect(importIssue(210, adapter, false)).rejects.toThrow(/planner.*task spec path/i);

      expect(mockRunReadinessGate).not.toHaveBeenCalled();
      expect(mockPostLifecycleComment).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(projectRoot, ".quack", "sync", "github-sync.json"))).toBe(
        false,
      );
    },
  );
});
