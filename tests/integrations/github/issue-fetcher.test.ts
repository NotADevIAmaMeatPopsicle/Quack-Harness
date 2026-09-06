// ─── GitHub Issue Fetcher Tests ─────────────────────────────────────

type RunGh = (
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const mockRunGh = jest.fn<ReturnType<RunGh>, Parameters<RunGh>>();
jest.mock("../../../src/integrations/github/gh-cli", () => ({
  runGh: (args: string[], options?: { input?: string; timeoutMs?: number }): ReturnType<RunGh> =>
    mockRunGh(args, options),
}));

// Import after mock setup
import { fetchIssue, fetchIssuesByLabel } from "../../../src/integrations/github/issue-fetcher";

describe("GitHub Issue Fetcher", () => {
  beforeEach(() => {
    mockRunGh.mockReset();
  });

  it("should parse gh issue view JSON output into GitHubIssue", async () => {
    const ghOutput = JSON.stringify({
      number: 42,
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
      state: "open",
      url: "https://github.com/owner/repo/issues/42",
    });

    mockRunGh.mockResolvedValueOnce({ stdout: ghOutput, stderr: "" });

    const issue = await fetchIssue("owner", "repo", 42);

    expect(issue.number).toBe(42);
    expect(issue.title).toBe("Fix authentication bug");
    expect(issue.labels).toEqual(["bug", "priority-high"]);
    expect(issue.assignees).toEqual(["alice"]);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].author).toBe("bob");
    expect(issue.state).toBe("open");
    expect(issue.url).toBe("https://github.com/owner/repo/issues/42");
    expect(issue.referencedFiles).toContain("src/auth.ts");
    expect(issue.referencedFiles).toContain("src/middleware.ts");
  });

  it("should handle missing fields gracefully", async () => {
    const ghOutput = JSON.stringify({
      number: 1,
      title: "Empty issue",
      body: null,
      labels: [],
      assignees: [],
      comments: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/1",
    });

    mockRunGh.mockResolvedValueOnce({ stdout: ghOutput, stderr: "" });

    const issue = await fetchIssue("owner", "repo", 1);

    expect(issue.number).toBe(1);
    expect(issue.body).toBe("");
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
    expect(issue.comments).toEqual([]);
    expect(issue.referencedFiles).toEqual([]);
  });

  it("should throw an error when gh CLI fails", async () => {
    mockRunGh.mockRejectedValueOnce(new Error("gh: not found"));

    await expect(fetchIssue("owner", "repo", 99)).rejects.toThrow(
      "Failed to fetch issue #99: gh: not found",
    );
  });

  it("should fetch issues by label and call fetchIssue for each", async () => {
    const listOutput = JSON.stringify([
      {
        number: 10,
        title: "Issue A",
        body: "Body A",
        labels: [{ name: "quack-ready" }],
        assignees: [],
        state: "open",
        url: "https://github.com/owner/repo/issues/10",
      },
      {
        number: 11,
        title: "Issue B",
        body: "Body B",
        labels: [{ name: "quack-ready" }],
        assignees: [],
        state: "open",
        url: "https://github.com/owner/repo/issues/11",
      },
    ]);

    const fullIssue10 = JSON.stringify({
      number: 10,
      title: "Issue A",
      body: "Body A",
      labels: [{ name: "quack-ready" }],
      assignees: [],
      comments: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/10",
    });

    const fullIssue11 = JSON.stringify({
      number: 11,
      title: "Issue B",
      body: "Body B",
      labels: [{ name: "quack-ready" }],
      assignees: [],
      comments: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/11",
    });

    mockRunGh
      .mockResolvedValueOnce({ stdout: listOutput, stderr: "" })
      .mockResolvedValueOnce({ stdout: fullIssue10, stderr: "" })
      .mockResolvedValueOnce({ stdout: fullIssue11, stderr: "" });

    const issues = await fetchIssuesByLabel("owner", "repo", "quack-ready");

    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(10);
    expect(issues[1].number).toBe(11);
    expect(mockRunGh).toHaveBeenCalledTimes(3);
  });
});
