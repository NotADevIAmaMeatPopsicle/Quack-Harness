import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// ─── Mock the narrow trusted GitHub CLI boundary ─────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

let mockGitResults: Record<string, MockExecResult> = {};
let mockGitResultQueues: Record<string, MockExecResult[]> = {};
let trustedGitHubCalls: Array<{ projectRoot: string; args: readonly string[] }> = [];
const mockRepository = { host: "github.com", owner: "org", repo: "repo" };
const expectedHeadOid = "a".repeat(40);

function pullRequestMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://github.com/org/repo/pull/42",
    state: "OPEN",
    headRefOid: expectedHeadOid,
    headRefName: "quack/TASK-042",
    baseRefName: "main",
    body: "Test body",
    headRepository: { name: "repo", nameWithOwner: "org/repo" },
    headRepositoryOwner: { login: "org" },
    mergeCommit: null,
    ...overrides,
  });
}

function findGitResult(command: string): MockExecResult | undefined {
  for (const [pattern, queue] of Object.entries(mockGitResultQueues)) {
    if (command.includes(pattern) && queue.length > 0) {
      return queue.shift();
    }
  }
  for (const [pattern, result] of Object.entries(mockGitResults)) {
    if (command.includes(pattern)) {
      return result;
    }
  }
  return undefined;
}

jest.mock("../../src/worker/trusted-executable", () => ({
  resolveTrustedGitHubRepository: (): Promise<typeof mockRepository> =>
    Promise.resolve(mockRepository),
  runTrustedGitHubResult: (
    projectRoot: string,
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    trustedGitHubCalls.push({ projectRoot, args });
    const command = ["gh", ...args].join(" ");
    const matchedResult = findGitResult(command);
    if (!matchedResult) {
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }

    if (matchedResult.error) {
      return Promise.resolve({
        exitCode: matchedResult.code ?? 1,
        stdout: matchedResult.stdout ?? "",
        stderr: matchedResult.stderr ?? "",
      });
    }

    return Promise.resolve({
      exitCode: 0,
      stdout: matchedResult.stdout ?? "",
      stderr: matchedResult.stderr ?? "",
    });
  },
}));

// ─── Import after mocking ────────────────────────────────────────────

const { buildPrBody, createPullRequest } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/dispatcher/pr-creator") as typeof import("../../src/dispatcher/pr-creator");

// ─── Test helpers ────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
  const defaultConfig: AdapterConfig = {
    version: "1.0",
    project: {
      name: "test-project",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: ["npm test *"],
      deniedBashPatterns: ["rm *"],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 30,
    },
  };

  return {
    config: defaultConfig,
    projectRoot: "/fake/project",
    conventionsDoc: "Test conventions.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: defaultConfig,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockGitResults = {};
  mockGitResultQueues = {};
  trustedGitHubCalls = [];
});

describe("pr-creator", () => {
  describe("buildPrBody", () => {
    test("should include task ID", () => {
      const body = buildPrBody(
        "TASK-042",
        "# TASK-042: Test\n\n## Success Criteria\n- [ ] criterion",
        {
          allPassed: true,
          commands: [{ name: "tests", passed: true, output: "10 passed" }],
          conventionChecks: [],
        },
        {
          verdict: "APPROVE" as const,
          confidence: 0.9,
          scopeViolations: [],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "Good.",
        },
      );

      expect(body).toContain("TASK-042");
    });

    test("should include verification results", () => {
      const body = buildPrBody(
        "TASK-042",
        "# TASK-042: Test\n\n## Success Criteria\n- [ ] criterion",
        {
          allPassed: true,
          commands: [{ name: "tests", passed: true, output: "10 passed" }],
          conventionChecks: [],
        },
        {
          verdict: "APPROVE" as const,
          confidence: 0.9,
          scopeViolations: [],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "Good.",
        },
      );

      expect(body).toContain("Verification Results");
      expect(body).toContain("PASSED");
    });

    test("should include judge verdict", () => {
      const body = buildPrBody(
        "TASK-042",
        "# TASK-042: Test\n\n## Success Criteria\n- [ ] criterion",
        null,
        {
          verdict: "APPROVE" as const,
          confidence: 0.9,
          scopeViolations: [],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "All criteria met.",
        },
      );

      expect(body).toContain("Judge Verdict");
      expect(body).toContain("APPROVE");
      expect(body).toContain("90%");
    });

    test("should handle null verification", () => {
      const body = buildPrBody(
        "TASK-042",
        "# TASK-042: Test\n\n## Success Criteria\n- [ ] criterion",
        null,
        {
          verdict: "APPROVE" as const,
          confidence: 0.9,
          scopeViolations: [],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "Good.",
        },
      );

      expect(body).toContain("No verification results available");
    });

    test("should extract success criteria from task spec", () => {
      const body = buildPrBody(
        "TASK-042",
        "# TASK-042: Test\n\n## Success Criteria\n- [ ] First criterion\n- [ ] Second criterion",
        null,
        {
          verdict: "APPROVE" as const,
          confidence: 0.9,
          scopeViolations: [],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "Good.",
        },
      );

      expect(body).toContain("Success Criteria");
      expect(body).toContain("First criterion");
      expect(body).toContain("Second criterion");
    });

    test("should include Generated by Quack footer", () => {
      const body = buildPrBody("TASK-042", "", null, {
        verdict: "APPROVE" as const,
        confidence: 0.9,
        scopeViolations: [],
        criteriaGaps: [],
        qualityIssues: [],
        feedback: "",
      });

      expect(body).toContain("Generated by Quack Agent");
    });
  });

  describe("createPullRequest", () => {
    test("should return PR URL on success", async () => {
      mockGitResults = {
        "gh pr create": {
          stdout: "https://github.com/org/repo/pull/42",
        },
        "gh pr view": { stdout: pullRequestMetadata() },
      };

      const adapter = makeAdapter();
      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        adapter,
      );

      expect(result.success).toBe(true);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(trustedGitHubCalls).toHaveLength(2);
      expect(trustedGitHubCalls[0]?.projectRoot).toBe("/fake/project");
      expect(trustedGitHubCalls[0]?.args.slice(0, 2)).toEqual(["pr", "create"]);
    });

    test("should return error on gh failure", async () => {
      mockGitResults = {
        "gh pr create": {
          error: true,
          stderr: "gh: Not logged in",
        },
      };

      const adapter = makeAdapter();
      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        adapter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create PR");
    });

    test("recovers the one exact existing head/base PR after an ambiguous create failure", async () => {
      mockGitResults = {
        "gh pr create": {
          error: true,
          stderr: "request completed but response was lost",
        },
        "gh pr list": {
          stdout: JSON.stringify([JSON.parse(pullRequestMetadata())]),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
    });

    test("selects one marker-owned PR from bounded historical head/base results", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": {
          error: true,
          stderr: "request completed but response was lost",
        },
        "gh pr list": {
          stdout: JSON.stringify([
            JSON.parse(pullRequestMetadata({ state: "CLOSED", body: "old publication" })),
            JSON.parse(
              pullRequestMetadata({
                url: "https://github.com/org/repo/pull/41",
                state: "MERGED",
                body: "older publication",
              }),
            ),
            JSON.parse(
              pullRequestMetadata({
                url: "https://github.com/org/repo/pull/43",
                body: `Test body\n\n${marker}`,
              }),
            ),
          ]),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/43" });
      expect(onCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({ state: "pending" }));
      expect(onCandidate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ state: "accepted" }),
      );
      expect(trustedGitHubCalls.at(-1)?.args).toEqual(expect.arrayContaining(["--limit", "20"]));
    });

    test("fails closed when lost-response recovery finds multiple marker-owned PRs", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { error: true, stderr: "response lost" },
        "gh pr list": {
          stdout: JSON.stringify([
            JSON.parse(pullRequestMetadata({ state: "CLOSED", body: `Test body\n\n${marker}` })),
            JSON.parse(
              pullRequestMetadata({
                url: "https://github.com/org/repo/pull/43",
                body: `Test body\n\n${marker}`,
              }),
            ),
          ]),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: false, error: "Failed to create PR: response lost" });
      expect(onCandidate).not.toHaveBeenCalled();
    });

    test("fails closed when lost-response recovery finds no exact marker-owned PR", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { error: true, stderr: "response lost" },
        "gh pr list": {
          stdout: JSON.stringify([
            JSON.parse(pullRequestMetadata({ body: "historical publication" })),
            JSON.parse(
              pullRequestMetadata({
                url: "https://github.com/org/repo/pull/43",
                body: `Test body\n\n${marker}`,
                headRefOid: "b".repeat(40),
              }),
            ),
          ]),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: false, error: "Failed to create PR: response lost" });
      expect(onCandidate).not.toHaveBeenCalled();
    });

    test("rejects a created pull request whose head advanced past the expected commit", async () => {
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": { stdout: pullRequestMetadata({ headRefOid: "b".repeat(40) }) },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("sealed publication commit");
    });

    test("rejects a pull request whose head repository is not the pinned origin", async () => {
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": {
          stdout: pullRequestMetadata({
            headRepository: { name: "repo", nameWithOwner: "attacker/repo" },
            headRepositoryOwner: { login: "attacker" },
          }),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("head repository");
    });

    test("supports a pinned GitHub Enterprise host with an explicit HTTPS port", async () => {
      const repository = { host: "ghe.example.test:8443", owner: "org", repo: "repo" };
      mockGitResults = {
        "gh pr create": { stdout: "https://ghe.example.test:8443/org/repo/pull/42" },
        "gh pr view": {
          stdout: pullRequestMetadata({
            url: "https://ghe.example.test:8443/org/repo/pull/42",
          }),
        },
      };

      await expect(
        createPullRequest(
          {
            taskId: "TASK-042",
            title: "[TASK-042] Test Task",
            body: "Test body",
            baseBranch: "main",
            headBranch: "quack/TASK-042",
            expectedHeadOid,
            repository,
          },
          makeAdapter(),
        ),
      ).resolves.toEqual({
        success: true,
        prUrl: "https://ghe.example.test:8443/org/repo/pull/42",
      });
    });

    test("durably records and safely closes a marker-owned PR that fails validation", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr close": { stdout: "closed" },
      };
      mockGitResultQueues = {
        "gh pr view": [
          {
            stdout: pullRequestMetadata({
              body: `Test body\n\n${marker}`,
              headRefOid: "b".repeat(40),
            }),
          },
          {
            stdout: pullRequestMetadata({
              body: `Test body\n\n${marker}`,
              headRefOid: "b".repeat(40),
              state: "CLOSED",
            }),
          },
        ],
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(
        trustedGitHubCalls.some((call) => call.args.slice(0, 2).join(" ") === "pr close"),
      ).toBe(true);
      expect(onCandidate).toHaveBeenNthCalledWith(1, {
        url: "https://github.com/org/repo/pull/42",
        ownershipMarker: marker,
        state: "pending",
      });
      expect(onCandidate).toHaveBeenNthCalledWith(2, {
        url: "https://github.com/org/repo/pull/42",
        ownershipMarker: marker,
        state: "closed",
      });
    });

    test("refuses to close a failed PR when its ownership marker is missing", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": { stdout: pullRequestMetadata({ headRefOid: "b".repeat(40) }) },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("unique Quack ownership marker");
      expect(trustedGitHubCalls.some((call) => call.args[1] === "close")).toBe(false);
      expect(onCandidate).toHaveBeenCalledTimes(1);
    });

    test("retains a pending candidate when close readback cannot be confirmed", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr close": { stdout: "closed" },
      };
      mockGitResultQueues = {
        "gh pr view": [
          {
            stdout: pullRequestMetadata({
              body: `Test body\n\n${marker}`,
              headRefOid: "b".repeat(40),
            }),
          },
          { error: true, stderr: "readback unavailable" },
        ],
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("readback unavailable");
      expect(onCandidate).toHaveBeenCalledTimes(1);
      expect(onCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ state: "pending" }));
    });

    test("retains a pending candidate when the marker-owned PR cannot be closed", async () => {
      const marker = "<!-- quack-publication:123e4567-e89b-42d3-a456-426614174000 -->";
      const onCandidate = jest.fn();
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": {
          stdout: pullRequestMetadata({
            body: `Test body\n\n${marker}`,
            headRefOid: "b".repeat(40),
          }),
        },
        "gh pr close": { error: true, stderr: "close denied" },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
          ownershipMarker: marker,
          onCandidate,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("close denied");
      expect(onCandidate).toHaveBeenCalledTimes(1);
      expect(onCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ state: "pending" }));
    });

    test("rejects an ambiguous recovered pull request from the wrong repository", async () => {
      mockGitResults = {
        "gh pr create": { error: true, stderr: "response lost" },
        "gh pr list": {
          stdout: JSON.stringify([
            JSON.parse(pullRequestMetadata({ url: "https://github.com/attacker/repo/pull/42" })),
          ]),
        },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          expectedHeadOid,
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("response lost");
    });
  });
});
