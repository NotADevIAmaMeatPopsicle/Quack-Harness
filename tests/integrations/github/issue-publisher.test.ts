import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubConfig } from "../../../src/integrations/github/github-types";
import { taskSpec } from "../../helpers/divergent-task-fixture";

type RunBoundGitHubCommand =
  typeof import("../../../src/integrations/github/trusted-github").runBoundGitHubCommand;
const mockRunBoundGitHubCommand = jest.fn<
  ReturnType<RunBoundGitHubCommand>,
  Parameters<RunBoundGitHubCommand>
>();
type ReadBoundGitHubIssuePage =
  typeof import("../../../src/integrations/github/trusted-github").readBoundGitHubIssuePage;
const mockReadBoundGitHubIssuePage = jest.fn<
  ReturnType<ReadBoundGitHubIssuePage>,
  Parameters<ReadBoundGitHubIssuePage>
>();

jest.mock("../../../src/integrations/github/trusted-github", () => ({
  ...jest.requireActual<object>("../../../src/integrations/github/trusted-github"),
  runBoundGitHubCommand: (...args: Parameters<RunBoundGitHubCommand>) =>
    mockRunBoundGitHubCommand(...args),
  readBoundGitHubIssuePage: (...args: Parameters<ReadBoundGitHubIssuePage>) =>
    mockReadBoundGitHubIssuePage(...args),
}));

import { publishTask } from "../../../src/integrations/github/issue-publisher";

const TASK_ID = "TASK-451";
const SENTINEL_PUBLISH_LABEL = "task-1343-publish-sentinel";
const NESTED_FALLBACK_LABEL = "task-1343-nested-fallback";
const REPOSITORY = { host: "github.com", owner: "sentinel-owner", repo: "sentinel-repo" };
const GITHUB_CONFIG: GitHubConfig = {
  owner: REPOSITORY.owner,
  repo: REPOSITORY.repo,
  publishLabel: SENTINEL_PUBLISH_LABEL,
  labels: { task: NESTED_FALLBACK_LABEL },
};

describe("Issue Publisher", () => {
  let projectRoot: string;
  let createdArgs: string[];
  let createdBody: string;

  beforeEach(() => {
    createdArgs = [];
    createdBody = "";
    mockRunBoundGitHubCommand.mockReset();
    mockReadBoundGitHubIssuePage.mockReset().mockImplementation(async (root, config) => {
      const result = await mockRunBoundGitHubCommand(root, config, ["issue", "list"]);
      const rows = JSON.parse(result.stdout) as unknown[];
      return { ...result, stdout: JSON.stringify(issuePage(rows)) };
    });
    mockRunBoundGitHubCommand.mockImplementation(
      (
        _root: string,
        _config: GitHubConfig,
        args: readonly string[],
        options?: { input?: string },
      ) => {
        if (args[0] === "issue" && args[1] === "list") {
          return Promise.resolve({
            exitCode: 0,
            stdout: "[]",
            stderr: "",
            repository: REPOSITORY,
          });
        }
        if (args[0] === "issue" && args[1] === "create") {
          createdArgs = [...args];
          createdBody = options?.input ?? "";
          return Promise.resolve({
            exitCode: 0,
            stdout: "https://github.com/sentinel-owner/sentinel-repo/issues/987\n",
            stderr: "",
            repository: REPOSITORY,
          });
        }
        if (args[0] === "issue" && args[1] === "view") {
          const title = createdArgs.find((arg) => arg.startsWith("--title="))?.slice(8);
          const label = createdArgs.find((arg) => arg.startsWith("--label="))?.slice(8);
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              number: 987,
              url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
              title,
              body: createdBody,
              labels: [{ name: label }],
              state: "OPEN",
            }),
            stderr: "",
            repository: REPOSITORY,
          });
        }
        return Promise.reject(new Error(`Unexpected GitHub args: ${args.join(" ")}`));
      },
    );
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-issue-publisher-"));
    const taskPath = path.join(projectRoot, "docs", "tasks", `${TASK_ID}-publisher-contract.md`);
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    fs.writeFileSync(
      taskPath,
      taskSpec(TASK_ID, {
        title: "Production publisher contract",
        status: "BACKLOG",
        tags: ["analytics", "github"],
        targetFiles: ["src/analytics.ts"],
        successCriteria: [
          "Failure patterns stored in database",
          "Gate provides advisory suggestions",
        ],
        testingRequirements: ["Test pattern storage"],
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  async function publishAndCapture(): Promise<{ args: string[]; body: string }> {
    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(mockRunBoundGitHubCommand).toHaveBeenCalledTimes(3);
    expect(mockRunBoundGitHubCommand.mock.calls.every((call) => call[0] === projectRoot)).toBe(
      true,
    );
    return { args: createdArgs, body: createdBody };
  }

  function expectedIssueRecord(
    issueNumber: number = 987,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      number: issueNumber,
      url: `https://github.com/sentinel-owner/sentinel-repo/issues/${issueNumber}`,
      title: createdArgs.find((arg) => arg.startsWith("--title="))?.slice(8),
      body: createdBody,
      labels: [{ name: SENTINEL_PUBLISH_LABEL }],
      state: "OPEN",
      ...overrides,
    };
  }

  function issuePage(
    nodes: unknown[],
    totalCount = nodes.length,
    nextCursor: string | null = null,
  ): Record<string, unknown> {
    return {
      data: {
        repository: {
          nameWithOwner: `${REPOSITORY.owner}/${REPOSITORY.repo}`,
          issues: {
            nodes: nodes.map((node) => {
              const issue = node as Record<string, unknown>;
              return {
                ...issue,
                createdAt:
                  issue.createdAt ??
                  new Date(Date.UTC(2026, 0, 1) + Number(issue.number) * 1_000).toISOString(),
              };
            }),
            totalCount,
            pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor },
          },
        },
      },
    };
  }

  function unrelatedIssues(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      url: `https://github.com/sentinel-owner/sentinel-repo/issues/${index + 1}`,
      body: "An unrelated closed issue without a Quack task marker.",
    }));
  }

  function paginateIssues(issues: () => Record<string, unknown>[]): void {
    mockReadBoundGitHubIssuePage.mockImplementation((_root, _config, after) => {
      const rows = issues();
      const offset = after === undefined ? 0 : Number(after.slice("cursor:".length));
      const nextOffset = offset + 25;
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(
          issuePage(
            rows.slice(offset, nextOffset),
            rows.length,
            nextOffset < rows.length ? `cursor:${nextOffset}` : null,
          ),
        ),
        stderr: "",
        repository: REPOSITORY,
      });
    });
  }

  async function captureExpectedPublication(): Promise<Record<string, unknown>> {
    await publishTask(TASK_ID, projectRoot, GITHUB_CONFIG);
    const issue = expectedIssueRecord();
    mockRunBoundGitHubCommand.mockReset();
    return issue;
  }

  it("emits the task marker and complete task body through stdin", async () => {
    const { body } = await publishAndCapture();

    expect(body).toMatch(/^<!-- quack:task-id=TASK-451 -->\n/);
    expect(body).toContain(`${TASK_ID} must resolve to its own file.`);
    expect(body).toContain("- [ ] Failure patterns stored in database");
    expect(body).toContain("| `src/analytics.ts` | Modify | TASK-451 fixture |");
    expect(body).toContain("**Tags:** analytics, github");
  });

  it("binds title and hostile-safe label values as single arguments", async () => {
    const { args } = await publishAndCapture();

    const lookupArgs = mockRunBoundGitHubCommand.mock.calls.find(
      (call) => call[2][0] === "issue" && call[2][1] === "list",
    )?.[2];
    expect(lookupArgs).toEqual(["issue", "list"]);
    expect(mockReadBoundGitHubIssuePage).toHaveBeenCalledWith(
      projectRoot,
      GITHUB_CONFIG,
      undefined,
      expect.any(Number),
    );

    expect(args).toEqual([
      "issue",
      "create",
      "--title=TASK-451: Production publisher contract",
      `--label=${SENTINEL_PUBLISH_LABEL}`,
      "--body-file",
      "-",
    ]);
    expect(args).not.toContain(`--label=${NESTED_FALLBACK_LABEL}`);
    expect(args).not.toContain("--repo");
  });

  it("rejects a create response whose readback identity is different", async () => {
    mockRunBoundGitHubCommand
      .mockReset()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "[]",
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "https://github.com/sentinel-owner/sentinel-repo/issues/987\n",
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          number: 988,
          url: "https://github.com/sentinel-owner/sentinel-repo/issues/988",
          title: "TASK-451: Production publisher contract",
          body: "",
          labels: [{ name: SENTINEL_PUBLISH_LABEL }],
          state: "OPEN",
        }),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValue({
        exitCode: 0,
        stdout: "[]",
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "recovery found no uniquely provable issue",
    );
  });

  it("adopts one exact existing issue on retry without creating another", async () => {
    const issue = await captureExpectedPublication();
    mockRunBoundGitHubCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([issue]),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issue),
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(0);
  });

  it("publishes a new task when the repository already has more than 100 issues", async () => {
    const issues = unrelatedIssues(1201);
    paginateIssues(() => issues);

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(1);
    expect(mockReadBoundGitHubIssuePage).toHaveBeenCalledTimes(49);
  });

  it("adopts an exact marker on a later page without creating another issue", async () => {
    const issue = await captureExpectedPublication();
    mockReadBoundGitHubIssuePage.mockClear();
    paginateIssues(() => [...unrelatedIssues(151), issue]);
    mockRunBoundGitHubCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(issue),
      stderr: "",
      repository: REPOSITORY,
    });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(mockReadBoundGitHubIssuePage).toHaveBeenCalledTimes(7);
    expect(mockRunBoundGitHubCommand.mock.calls.map((call) => call[2][1])).toEqual(["view"]);
  });

  it("handles older transferred issues whose destination numbers precede lower-number issues", async () => {
    const issue = await captureExpectedPublication();
    const transferred = {
      number: 2000,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/2000",
      body: "Transferred from another repository.",
      createdAt: "2025-12-01T00:00:00Z",
    };
    paginateIssues(() => [transferred, ...unrelatedIssues(151), issue]);
    mockRunBoundGitHubCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(issue),
      stderr: "",
      repository: REPOSITORY,
    });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(mockRunBoundGitHubCommand.mock.calls.map((call) => call[2][1])).toEqual(["view"]);
  });

  it("refuses duplicate task markers located on different pages", async () => {
    const issue = await captureExpectedPublication();
    const rows = unrelatedIssues(151);
    rows[25] = {
      ...issue,
      number: 26,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/26",
    };
    rows[130] = {
      ...issue,
      number: 131,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/131",
    };
    paginateIssues(() => rows);

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "multiple issues with the task marker",
    );
    expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
  });

  it("recovers the 101st issue after a lost create response without creating twice", async () => {
    let rows = unrelatedIssues(100);
    paginateIssues(() => rows);
    mockRunBoundGitHubCommand.mockImplementation((_root, _config, args, options) => {
      if (args[1] === "create") {
        createdArgs = [...args];
        createdBody = options?.input ?? "";
        rows = [...rows, expectedIssueRecord(101)];
        return Promise.reject(new Error("response lost after issue 101 was created"));
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(rows.at(-1)),
        stderr: "",
        repository: REPOSITORY,
      });
    });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 101,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/101",
    });
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(1);
    expect(mockReadBoundGitHubIssuePage).toHaveBeenCalledTimes(9);
  });

  it("does not adopt a marker before the remaining pages have been checked", async () => {
    const issue = await captureExpectedPublication();
    mockReadBoundGitHubIssuePage
      .mockReset()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issuePage([issue], 2, "cursor:1")),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockRejectedValueOnce(new Error("second page unavailable"));

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "second page unavailable",
    );
    expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
  });

  it.each([
    [
      "changed count",
      issuePage(
        [{ number: 2, url: "https://github.com/sentinel-owner/sentinel-repo/issues/2", body: "" }],
        3,
      ),
    ],
    ["truncated final page", issuePage([], 2)],
    [
      "repeated issue",
      issuePage(
        [{ number: 1, url: "https://github.com/sentinel-owner/sentinel-repo/issues/1", body: "" }],
        2,
      ),
    ],
    ["repeated cursor", issuePage([], 2, "cursor:1")],
    ["GraphQL partial error", { ...issuePage([], 2), errors: [{ message: "partial response" }] }],
    ["oversized page", issuePage(unrelatedIssues(26), 2)],
    [
      "foreign issue URL",
      issuePage([{ number: 2, url: "https://github.com/foreign/repo/issues/2", body: "" }], 2),
    ],
  ])("refuses %s pagination before any create", async (_reason, secondPage) => {
    mockReadBoundGitHubIssuePage
      .mockReset()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issuePage(unrelatedIssues(1), 2, "cursor:1")),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(secondPage),
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "pre-create lookup failed",
    );
    expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
  });

  it("refuses a repository change between pages before any create", async () => {
    mockReadBoundGitHubIssuePage
      .mockReset()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issuePage(unrelatedIssues(1), 2, "cursor:1")),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issuePage([], 2)),
        stderr: "",
        repository: { ...REPOSITORY, host: "other.example.test" },
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "changed repositories",
    );
    expect(mockRunBoundGitHubCommand).not.toHaveBeenCalled();
  });

  it("serializes concurrent publishes so both callers adopt one created issue", async () => {
    const issue = await captureExpectedPublication();
    let remoteIssue: Record<string, unknown> | undefined;
    let createCount = 0;
    let signalCreateStarted: (() => void) | undefined;
    let releaseCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    mockRunBoundGitHubCommand.mockImplementation(
      async (
        _root: string,
        _config: GitHubConfig,
        args: readonly string[],
        options?: { input?: string },
      ) => {
        if (args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(remoteIssue ? [remoteIssue] : []),
            stderr: "",
            repository: REPOSITORY,
          };
        }
        if (args[1] === "create") {
          createCount += 1;
          createdArgs = [...args];
          createdBody = options?.input ?? "";
          signalCreateStarted?.();
          await createRelease;
          remoteIssue = expectedIssueRecord();
          return {
            exitCode: 0,
            stdout: "https://github.com/sentinel-owner/sentinel-repo/issues/987\n",
            stderr: "",
            repository: REPOSITORY,
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(remoteIssue ?? issue),
          stderr: "",
          repository: REPOSITORY,
        };
      },
    );

    const first = publishTask(TASK_ID, projectRoot, GITHUB_CONFIG);
    try {
      await createStarted;
      const second = publishTask(TASK_ID, projectRoot, GITHUB_CONFIG);
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(createCount).toBe(1);
      releaseCreate?.();

      await expect(Promise.all([first, second])).resolves.toEqual([
        { issueNumber: 987, url: "https://github.com/sentinel-owner/sentinel-repo/issues/987" },
        { issueNumber: 987, url: "https://github.com/sentinel-owner/sentinel-repo/issues/987" },
      ]);
      expect(createCount).toBe(1);
    } finally {
      releaseCreate?.();
      await first.catch(() => undefined);
    }
  });

  it("recovers one exact issue after a lost response and delayed list visibility", async () => {
    await captureExpectedPublication();
    let lookupCount = 0;
    mockRunBoundGitHubCommand.mockImplementation(
      (
        _root: string,
        _config: GitHubConfig,
        args: readonly string[],
        options?: { input?: string },
      ) => {
        if (args[1] === "list") {
          lookupCount += 1;
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify(lookupCount < 3 ? [] : [expectedIssueRecord()]),
            stderr: "",
            repository: REPOSITORY,
          });
        }
        if (args[1] === "create") {
          createdArgs = [...args];
          createdBody = options?.input ?? "";
          return Promise.reject(new Error("connection lost after request upload"));
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify(expectedIssueRecord()),
          stderr: "",
          repository: REPOSITORY,
        });
      },
    );

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(1);
    expect(lookupCount).toBe(3);
  });

  it("recovers the exact issue when direct create readback fails", async () => {
    const issue = await captureExpectedPublication();
    mockRunBoundGitHubCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: "[]", stderr: "", repository: REPOSITORY })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "https://github.com/sentinel-owner/sentinel-repo/issues/987\n",
        stderr: "",
        repository: REPOSITORY,
      })
      .mockRejectedValueOnce(new Error("transient readback failure"))
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([issue]),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(issue),
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
  });

  it("fails closed on ambiguous marker ownership before create", async () => {
    const issue = await captureExpectedPublication();
    mockRunBoundGitHubCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([issue, expectedIssueRecord(988)]),
      stderr: "",
      repository: REPOSITORY,
    });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "multiple issues with the task marker",
    );
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(0);
  });

  it("fails closed when the marker owner does not match expected content", async () => {
    const issue = await captureExpectedPublication();
    mockRunBoundGitHubCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ ...issue, title: "TASK-451: stale title" }]),
        stderr: "",
        repository: REPOSITORY,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ...issue, title: "TASK-451: stale title" }),
        stderr: "",
        repository: REPOSITORY,
      });

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "publication readback returned the wrong title",
    );
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(0);
  });

  it("releases the publication lock when lookup fails so a retry can proceed", async () => {
    mockRunBoundGitHubCommand.mockRejectedValueOnce(new Error("lookup unavailable"));

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).rejects.toThrow(
      "pre-create lookup failed: lookup unavailable",
    );
    expect(mockRunBoundGitHubCommand).toHaveBeenCalledTimes(1);

    await expect(publishTask(TASK_ID, projectRoot, GITHUB_CONFIG)).resolves.toEqual({
      issueNumber: 987,
      url: "https://github.com/sentinel-owner/sentinel-repo/issues/987",
    });
    expect(
      mockRunBoundGitHubCommand.mock.calls.filter((call) => call[2][1] === "create"),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(projectRoot, ".quack", "sync", "github-publication.lock"))).toBe(
      false,
    );
  });
});
