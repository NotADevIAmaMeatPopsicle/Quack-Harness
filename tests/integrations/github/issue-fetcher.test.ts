// ─── GitHub Issue Fetcher Tests ─────────────────────────────────────

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

import { fetchIssue, fetchIssuesByLabel } from "../../../src/integrations/github/issue-fetcher";

const PROJECT_ROOT = "C:\\trusted\\project";
const REPOSITORY = { host: "github.com", owner: "owner", repo: "repo" };

function result(stdout: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  repository: typeof REPOSITORY;
} {
  return { exitCode: 0, stdout, stderr: "", repository: REPOSITORY };
}

function issueJson(number: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [{ name: "quack-ready" }],
    assignees: [],
    comments: [],
    state: "open",
    url: `https://github.com/owner/repo/issues/${number}`,
    ...overrides,
  });
}

describe("GitHub Issue Fetcher", () => {
  beforeEach(() => {
    mockRunBoundGitHubCommand.mockReset();
  });

  it("parses a repository-bound issue response", async () => {
    mockRunBoundGitHubCommand.mockResolvedValueOnce(
      result(
        issueJson(42, {
          title: "Fix authentication bug",
          body: "The login flow fails when using `src/auth.ts` tokens.",
          labels: [{ name: "bug" }, { name: "priority-high" }],
          assignees: [{ login: "alice" }],
          comments: [
            {
              author: { login: "bob" },
              body: "I can reproduce this. Check `src/middleware.ts` too.",
              createdAt: "2026-01-15T10:00:00Z",
            },
          ],
        }),
      ),
    );

    const issue = await fetchIssue("owner", "repo", 42, PROJECT_ROOT);

    expect(issue).toMatchObject({
      number: 42,
      title: "Fix authentication bug",
      labels: ["bug", "priority-high"],
      assignees: ["alice"],
      state: "open",
      url: "https://github.com/owner/repo/issues/42",
    });
    expect(issue.comments[0]?.author).toBe("bob");
    expect(issue.referencedFiles).toEqual(["src/auth.ts", "src/middleware.ts"]);
    expect(mockRunBoundGitHubCommand).toHaveBeenCalledWith(
      PROJECT_ROOT,
      { owner: "owner", repo: "repo" },
      ["issue", "view", "42", "--json", "number,title,body,labels,assignees,comments,state,url"],
      { timeoutMs: 30_000, maxBuffer: 1024 * 1024 },
    );
  });

  it("normalizes a null body while preserving strict arrays", async () => {
    mockRunBoundGitHubCommand.mockResolvedValueOnce(result(issueJson(1, { body: null })));

    const issue = await fetchIssue("owner", "repo", 1, PROJECT_ROOT);

    expect(issue.body).toBe("");
    expect(issue.assignees).toEqual([]);
    expect(issue.comments).toEqual([]);
    expect(issue.referencedFiles).toEqual([]);
  });

  it("rejects a mismatched response identity", async () => {
    mockRunBoundGitHubCommand.mockResolvedValueOnce(
      result(
        issueJson(42, {
          url: "https://github.com/attacker/repo/issues/42",
        }),
      ),
    );

    await expect(fetchIssue("owner", "repo", 42, PROJECT_ROOT)).rejects.toThrow(
      "GitHub response issue URL does not match github.com/owner/repo#42",
    );
  });

  it("preserves a trusted boundary failure in the fetch context", async () => {
    mockRunBoundGitHubCommand.mockRejectedValueOnce(new Error("repository binding mismatch"));

    await expect(fetchIssue("owner", "repo", 99, PROJECT_ROOT)).rejects.toThrow(
      "Failed to fetch issue #99: repository binding mismatch",
    );
  });

  it("fetches each repository-bound issue returned by an exact label query", async () => {
    mockRunBoundGitHubCommand
      .mockResolvedValueOnce(
        result(JSON.stringify([JSON.parse(issueJson(10)), JSON.parse(issueJson(11))])),
      )
      .mockResolvedValueOnce(result(issueJson(10)))
      .mockResolvedValueOnce(result(issueJson(11)));

    const issues = await fetchIssuesByLabel("owner", "repo", "quack-ready", PROJECT_ROOT);

    expect(issues.map((issue) => issue.number)).toEqual([10, 11]);
    expect(mockRunBoundGitHubCommand).toHaveBeenCalledTimes(3);
  });

  it("keeps a hostile import label in one option value and cannot change query semantics", async () => {
    const hostileLabel = 'ready" --state=closed; echo owned';
    mockRunBoundGitHubCommand.mockResolvedValueOnce(result("[]"));

    await expect(fetchIssuesByLabel("owner", "repo", hostileLabel, PROJECT_ROOT)).resolves.toEqual(
      [],
    );

    const args = mockRunBoundGitHubCommand.mock.calls[0]?.[2] as string[];
    expect(args).toContain(`--label=${hostileLabel}`);
    expect(args).toContain("--state=open");
    expect(args).not.toContain("--state=closed");
    expect(args).not.toContain("echo");
    expect(mockRunBoundGitHubCommand.mock.calls[0]?.[0]).toBe(PROJECT_ROOT);
  });
});
