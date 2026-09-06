/* eslint-disable @typescript-eslint/no-require-imports */
import { promisify } from "node:util";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// ─── Mock child_process.exec ──────────────────────────────────────────

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: boolean;
  code?: number;
};

let mockGitResults: Record<string, MockExecResult> = {};

function findGitResult(command: string): MockExecResult | undefined {
  for (const [pattern, result] of Object.entries(mockGitResults)) {
    if (command.includes(pattern)) {
      return result;
    }
  }
  return undefined;
}

jest.mock("node:child_process", () => {
  const actual = jest.requireActual<typeof import("node:child_process")>("node:child_process");

  const customPromisified = (
    command: string,
    _options: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    const matchedResult = findGitResult(command);
    if (!matchedResult) {
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

  const mockExec = jest.fn();
  (mockExec as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

  return {
    ...actual,
    exec: mockExec,
  };
});

// ─── Import after mocking ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPrBody, createPullRequest } =
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
      };

      const adapter = makeAdapter();
      const result = await createPullRequest(
        {
          taskId: "TASK-042",
          title: "[TASK-042] Test Task",
          body: "Test body",
          baseBranch: "main",
        },
        adapter,
      );

      expect(result.success).toBe(true);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
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
        },
        adapter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create PR");
    });
  });
});
