/* eslint-disable @typescript-eslint/no-require-imports */
import { promisify } from "node:util";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// ─── Mock child_process.execFile ──────────────────────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

let mockGitResults: Record<string, MockExecResult | MockExecResult[]> = {};
let mockExecutedCommands: string[] = [];

function findGitResult(command: string): MockExecResult | undefined {
  for (const [pattern, result] of Object.entries(mockGitResults)) {
    if (command.includes(pattern)) {
      return Array.isArray(result) ? result.shift() : result;
    }
  }
  return undefined;
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const customPromisified = (
    file: string,
    args: readonly string[],
    _options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    const command = [file, ...args].join(" ");
    mockExecutedCommands.push(command);
    const matchedResult = findGitResult(command);
    if (!matchedResult) {
      if (command === "git remote get-url --push --all origin") {
        return Promise.resolve({ stdout: "git@github.com:org/repo.git\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    }

    if (matchedResult.error) {
      const err = Object.assign(new Error("Command failed"), {
        code: matchedResult.code ?? 1,
        killed: false,
        signal: null,
        stdout: matchedResult.stdout ?? "",
        stderr: matchedResult.stderr ?? "",
      });
      return Promise.reject(err);
    }

    return Promise.resolve({
      stdout: matchedResult.stdout ?? "",
      stderr: matchedResult.stderr ?? "",
    });
  };

  const mockExecFile = jest.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

  return {
    ...actual,
    execFile: mockExecFile,
  };
});

// ─── Import after mocking ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPrBody, createPullRequest } =
  require("../../src/dispatcher/pr-creator") as typeof import("../../src/dispatcher/pr-creator");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseGitHubOrigin } =
  require("../../src/dispatcher/github-repository") as typeof import("../../src/dispatcher/github-repository");

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
  mockExecutedCommands = [];
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
    test("hostile GH_REPO cannot redirect create or inspection from the exact origin", async () => {
      const previous = process.env.GH_REPO;
      process.env.GH_REPO = "attacker/redirect";
      const headCommitSha = "a".repeat(40);
      mockGitResults = {
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": {
          stdout: JSON.stringify({
            url: "https://github.com/org/repo/pull/42",
            baseRefName: "main",
            headRefName: "quack/TASK-042",
            headRefOid: headCommitSha,
            headRepository: { nameWithOwner: "org/repo" },
          }),
        },
      };

      try {
        await expect(
          createPullRequest(
            {
              taskId: "TASK-042",
              title: "[TASK-042] Test Task",
              body: "Test body",
              baseBranch: "main",
              headBranch: "quack/TASK-042",
              headCommitSha,
            },
            makeAdapter(),
          ),
        ).resolves.toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
        const prCommands = mockExecutedCommands.filter((command) => command.startsWith("gh pr "));
        expect(prCommands).not.toHaveLength(0);
        expect(prCommands.every((command) => command.includes("--repo github.com/org/repo"))).toBe(
          true,
        );
        expect(prCommands.some((command) => command.includes("attacker/redirect"))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.GH_REPO;
        else process.env.GH_REPO = previous;
      }
    });

    test("fails closed when origin changes after PR creation but before inspection", async () => {
      const pushUrl = "git@github.com:org/repo.git";
      const repository = parseGitHubOrigin(pushUrl)!;
      mockGitResults = {
        "git remote get-url --push --all origin": [
          { stdout: `${pushUrl}\n` },
          { stdout: "git@github.com:attacker/redirect.git\n" },
          { stdout: "git@github.com:attacker/redirect.git\n" },
        ],
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
        repository,
      );

      expect(result.success).toBe(false);
      expect(mockExecutedCommands.some((command) => command.startsWith("gh pr create"))).toBe(true);
      expect(mockExecutedCommands.some((command) => command.startsWith("gh pr view"))).toBe(false);
      expect(mockExecutedCommands.some((command) => command.startsWith("gh pr list"))).toBe(false);
    });

    test("rejects multiple origin push URLs before any GitHub side effect", async () => {
      mockGitResults = {
        "git remote get-url --push --all origin": {
          stdout: "git@github.com:org/repo.git\ngit@github.com:org/mirror.git\n",
        },
      };
      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("exactly one push URL");
      expect(mockExecutedCommands.some((command) => command.startsWith("gh pr "))).toBe(false);
    });

    test("preserves a host-qualified GHES port from the origin push URL", () => {
      const repository = parseGitHubOrigin("https://git.example.test:8443/org/repo.git");
      expect(repository).toBeDefined();
      if (!repository) throw new Error("Expected GitHub repository identity");
      expect(repository).toMatchObject({
        host: "git.example.test:8443",
        nameWithOwner: "org/repo",
        selector: "git.example.test:8443/org/repo",
        pushUrl: "https://git.example.test:8443/org/repo.git",
      });
      expect(repository.pushUrlHash).toMatch(/^[a-f0-9]{64}$/u);
    });

    test("should return PR URL on success", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": {
          stdout: "https://github.com/org/repo/pull/42",
        },
        "gh pr view": {
          stdout: JSON.stringify({
            url: "https://github.com/org/repo/pull/42",
            baseRefName: "main",
            headRefName: "quack/TASK-042",
            headRefOid: "a".repeat(40),
            headRepository: { nameWithOwner: "org/repo" },
          }),
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
          headCommitSha: "a".repeat(40),
        },
        adapter,
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
      expect(mockExecutedCommands).toContain(
        `gh pr create --title [TASK-042] Test Task --body Test body --base main --repo github.com/org/repo --head quack/TASK-042`,
      );
    });

    test("should return error on gh failure", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
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
          headCommitSha: "a".repeat(40),
        },
        adapter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create PR");
    });

    test("preserves a valid repository-bound PR URL emitted on stderr", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": {
          stderr: "warning\nhttps://github.com/org/repo/pull/42\n",
        },
        "gh pr view": {
          stdout: JSON.stringify({
            url: "https://github.com/org/repo/pull/42",
            baseRefName: "main",
            headRefName: "quack/TASK-042",
            headRefOid: "a".repeat(40),
            headRepository: { nameWithOwner: "org/repo" },
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
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
    });

    test("binds and verifies an exact host-side PR before reporting success", async () => {
      const headCommitSha = "a".repeat(40);
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
        "gh pr view": {
          stdout: JSON.stringify({
            url: "https://github.com/org/repo/pull/42",
            baseRefName: "main",
            headRefName: "quack/TASK-042",
            headRefOid: headCommitSha,
            headRepository: { nameWithOwner: "org/repo" },
            headRepositoryOwner: { login: "org" },
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
          headCommitSha,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
      expect(mockExecutedCommands).toContain(
        "gh pr create --title [TASK-042] Test Task --body Test body --base main --repo github.com/org/repo --head quack/TASK-042",
      );
      expect(mockExecutedCommands).toContain(
        "gh pr view https://github.com/org/repo/pull/42 --repo github.com/org/repo --json url,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
      );
    });

    test("never reports success when GitHub CLI omits the PR URL", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": { stdout: "", stderr: "Pull request created" },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
      );

      expect(result).toEqual({
        success: false,
        error:
          "Failed to create PR: GitHub CLI did not return a pull request URL for the resolved repository",
      });
    });

    test("rejects a returned PR URL from a different repository", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": { stdout: "https://github.com/other/repo/pull/42" },
      };

      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
          headBranch: "quack/TASK-042",
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("resolved repository");
    });

    test("recovers the one exact existing head/base PR after an ambiguous create failure", async () => {
      const headCommitSha = "a".repeat(40);
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": {
          error: true,
          stderr: "request completed but response was lost",
        },
        "gh pr list": {
          stdout: JSON.stringify([
            {
              url: "https://github.com/org/repo/pull/42",
              baseRefName: "main",
              headRefName: "quack/TASK-042",
              headRefOid: headCommitSha,
              headRepository: { nameWithOwner: "org/repo" },
              headRepositoryOwner: { login: "org" },
            },
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
          headCommitSha,
        },
        makeAdapter(),
      );

      expect(result).toEqual({ success: true, prUrl: "https://github.com/org/repo/pull/42" });
      expect(mockExecutedCommands.find((command) => command.startsWith("gh pr list "))).toContain(
        "--repo github.com/org/repo",
      );
    });

    test("does not recover a same-name PR at a different head commit", async () => {
      mockGitResults = {
        "gh repo view": {
          stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://github.com/org/repo" }),
        },
        "gh pr create": { error: true, stderr: "request completed but response was lost" },
        "gh pr list": {
          stdout: JSON.stringify([
            {
              url: "https://github.com/org/repo/pull/42",
              baseRefName: "main",
              headRefName: "quack/TASK-042",
              headRefOid: "b".repeat(40),
              headRepository: { nameWithOwner: "org/repo" },
              headRepositoryOwner: { login: "org" },
            },
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
          headCommitSha: "a".repeat(40),
        },
        makeAdapter(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create PR");
    });
  });
});
