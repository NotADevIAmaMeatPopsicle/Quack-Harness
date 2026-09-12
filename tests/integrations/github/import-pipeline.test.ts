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
import { buildPlannerPrompt } from "../../../src/integrations/github/issue-converter";
import { fetchIssue } from "../../../src/integrations/github/issue-fetcher";
import { importIssue } from "../../../src/integrations/github/import-pipeline";
import { GitHubSyncMap } from "../../../src/integrations/github/sync-map";
import { planTasks } from "../../../src/planner/planner-agent";

const mockFetchIssue = jest.mocked(fetchIssue);
const mockPlanTasks = jest.mocked(planTasks);
const mockRunReadinessGate = jest.mocked(runReadinessGate);

const ISSUE_NUMBER = 342;
const TASK_ID = "TASK-734";
const OPEN_ISSUE: GitHubIssue = {
  number: ISSUE_NUMBER,
  title: "Import the production pipeline",
  body: "Exercise the real import orchestration.",
  labels: ["task"],
  assignees: [],
  comments: [],
  referencedFiles: [],
  linkedPRs: [],
  state: "open",
  url: `https://github.com/fixture/repo/issues/${ISSUE_NUMBER}`,
};

describe("Import Pipeline", () => {
  let projectRoot: string;
  let syncPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-import-pipeline-"));
    syncPath = path.join(projectRoot, ".quack", "sync", "github-sync.json");
    writeTestAdapter(projectRoot, { reportBack: false });

    const plannedTaskPath = path.join(projectRoot, "docs", "tasks", `${TASK_ID}-import.md`);
    const plannedTaskContent = taskSpec(TASK_ID, {
      title: "Imported production task",
      status: "BACKLOG",
    });
    fs.mkdirSync(path.dirname(plannedTaskPath), { recursive: true });
    fs.writeFileSync(plannedTaskPath, plannedTaskContent, "utf-8");

    mockFetchIssue.mockResolvedValue(OPEN_ISSUE);
    mockPlanTasks.mockResolvedValue({
      taskIds: [TASK_ID],
      specs: [plannedTaskContent],
      filePaths: [plannedTaskPath],
    });
    mockRunReadinessGate.mockImplementation((task) => Promise.resolve({ outcome: "pass", task }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });

  it("rejects a closed issue before planning or writing a sync entry", async () => {
    mockFetchIssue.mockResolvedValue({ ...OPEN_ISSUE, state: "closed" });
    const adapter = await loadAdapter(projectRoot);

    await expect(importIssue(ISSUE_NUMBER, adapter, false)).rejects.toThrow(
      `Issue #${ISSUE_NUMBER} is closed, only open issues can be imported`,
    );

    expect(mockPlanTasks).not.toHaveBeenCalled();
    expect(mockRunReadinessGate).not.toHaveBeenCalled();
    expect(fs.existsSync(syncPath)).toBe(false);
  });

  it("rejects an issue already present in the persisted sync map", async () => {
    const existingMap = new GitHubSyncMap(syncPath);
    await existingMap.load();
    existingMap.addEntry({
      taskId: "TASK-EXISTING",
      issueNumber: ISSUE_NUMBER,
      direction: "imported",
      createdAt: "2026-08-18T12:00:00.000Z",
      lastSyncedAt: "2026-08-18T12:00:00.000Z",
      issueState: "open",
      taskStatus: "BACKLOG",
    });
    await existingMap.save();
    const adapter = await loadAdapter(projectRoot);

    await expect(importIssue(ISSUE_NUMBER, adapter, false)).rejects.toThrow(
      `Issue #${ISSUE_NUMBER} already imported as TASK-EXISTING`,
    );

    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(mockPlanTasks).not.toHaveBeenCalled();
    expect(mockRunReadinessGate).not.toHaveBeenCalled();
  });

  it("keeps the production buildPlannerPrompt coverage for enriched issue data", () => {
    const issue: GitHubIssue = {
      number: 42,
      title: "Add dark mode",
      body: "We need a dark mode toggle in settings.",
      labels: ["enhancement", "ui"],
      assignees: ["alice"],
      comments: [
        {
          author: "bob",
          body: "Should use CSS variables for theming. Check `src/theme.ts`.",
          createdAt: "2026-01-15T10:00:00Z",
        },
      ],
      referencedFiles: ["src/theme.ts"],
      linkedPRs: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/42",
    };

    const prompt = buildPlannerPrompt(issue);

    expect(prompt).toContain("GitHub Issue #42: Add dark mode");
    expect(prompt).toContain("We need a dark mode toggle in settings.");
    expect(prompt).toContain("@bob");
    expect(prompt).toContain("CSS variables for theming");
    expect(prompt).toContain("`src/theme.ts`");
    expect(prompt).toContain("enhancement");
    expect(prompt).toContain("task specification");
    expect(prompt).toContain("success criteria");
  });

  it("persists the imported sync direction", async () => {
    const adapter = await loadAdapter(projectRoot);

    const result = await importIssue(ISSUE_NUMBER, adapter, true);

    expect(mockFetchIssue).toHaveBeenCalledWith(
      "fixture-owner",
      "fixture-repo",
      ISSUE_NUMBER,
      projectRoot,
    );
    const persistedMap = new GitHubSyncMap(syncPath);
    await persistedMap.load();
    expect(result).toEqual({ taskId: TASK_ID, issueNumber: ISSUE_NUMBER });
    expect(persistedMap.getEntryByTaskId(TASK_ID)).toMatchObject({
      taskId: TASK_ID,
      issueNumber: ISSUE_NUMBER,
      direction: "imported",
      issueState: "open",
      taskStatus: "BACKLOG",
    });
    expect(mockRunReadinessGate).not.toHaveBeenCalled();
  });

  it("runs the readiness gate on the generated spec when auto-dispatch is disabled", async () => {
    const adapter = await loadAdapter(projectRoot);

    const result = await importIssue(ISSUE_NUMBER, adapter, false);

    expect(mockRunReadinessGate).toHaveBeenCalledTimes(1);
    expect(mockRunReadinessGate.mock.calls[0][0]).toMatchObject({ id: TASK_ID });
    expect(mockRunReadinessGate.mock.calls[0][2]).toMatchObject({ skipEnrichment: true });
    expect(result.gateResult).toMatchObject({ passed: true });
  });
});
