import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runPostJudgeVerification, _setQueryFn } from "../../src/dispatcher/post-judge-verifier.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ParsedTask, TestSuiteResult } from "../../src/core/types.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";

// Mock child_process
jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

// Mock fs
jest.mock("node:fs", () => ({
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
  },
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ isDirectory: () => true }),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock Agent SDK
jest.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: jest.fn(),
}));

// Mock smart test runner
jest.mock("../../src/testing/smart-test-runner.js", () => ({
  runSmartTests: jest.fn(),
}));

// Mock test baseline
jest.mock("../../src/testing/test-baseline.js", () => ({
  loadBaseline: jest.fn(),
  compareWithBaseline: jest.fn(),
  captureBaseline: jest.fn(),
}));

// Mock test formatter
jest.mock("../../src/testing/test-formatter.js", () => ({
  formatTestSummary: jest.fn().mockReturnValue("10 tests: 10 passed"),
  formatTestDetails: jest.fn().mockReturnValue("Details..."),
  writeTestArtifact: jest.fn(),
}));

// Mock verify.js to bypass Windows POSIX tool detection
jest.mock("../../src/worker/tools/verify.js", () => ({
  prepareVerificationCommandRuntime: jest
    .fn()
    .mockImplementation((command: unknown) => ({ command, env: {} })),
}));

import * as childProcess from "node:child_process";
import { runSmartTests } from "../../src/testing/smart-test-runner.js";
import { loadBaseline, compareWithBaseline } from "../../src/testing/test-baseline.js";
import { formatTestSummary } from "../../src/testing/test-formatter.js";

const mockExecSync = childProcess.execSync as ReturnType<typeof jest.fn>;
const mockRunSmartTests = runSmartTests as ReturnType<typeof jest.fn>;
const mockLoadBaseline = loadBaseline as ReturnType<typeof jest.fn>;
const mockCompareWithBaseline = compareWithBaseline as ReturnType<typeof jest.fn>;
const mockFormatTestSummary = formatTestSummary as ReturnType<typeof jest.fn>;

describe("post-judge-verifier smart testing integration", () => {
  let mockAdapter: ProjectAdapter;
  let mockTask: ParsedTask;
  let mockEvents: IEventWriter;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEvents = {
      sessionId: "test-session",
      taskId: "TASK-001",
      project: "test",
      emit: jest.fn() as IEventWriter["emit"],
      recordSession: jest.fn() as IEventWriter["recordSession"],
    } as IEventWriter;

    mockTask = {
      id: "TASK-001",
      title: "Test task",
      priority: "P2-MEDIUM",
      effort: "1-2 hours",
      status: "IN_PROGRESS",
      blockedBy: [],
      blocks: [],
      conventions: [],
      tags: [],
      problemStatement: "test",
      currentState: "test",
      recommendedApproach: "test",
      filesToModify: [],
      successCriteria: ["Tests pass"],
      testingRequirements: ["Unit tests"],
      contextReferences: [],
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      rawContent: "",
    } as unknown as ParsedTask;
  });

  function makeAdapter(smartEnabled: boolean): ProjectAdapter {
    return {
      projectRoot: "/test/project",
      config: {
        verification: {
          commands: [
            { name: "build", command: "npm run build", required: true, timeout: 30000 },
            { name: "test", command: "npm test", required: true, timeout: 60000 },
          ],
          conventionChecks: [],
          postJudge: {
            enabled: true,
            layers: ["deterministic"],
            model: "claude-haiku-4-5-20251001",
            failOnBuildError: true,
            failOnTestError: true,
            failOnLintError: false,
            maxSemanticTokens: 8000,
          },
          ...(smartEnabled && {
            smartTesting: {
              enabled: true,
              mode: "related" as const,
              baselineEnabled: true,
              failOnPreExisting: false,
              outputDir: ".quack/test-results",
            },
          }),
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "",
          commitTrailer: "",
          autoCreatePr: false,
          autoPush: false,
        },
        sandbox: {
          writablePaths: [],
          deniedPaths: [],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        logging: { dir: ".quack/logs", level: "info" as const, retainDays: 30 },
        project: {
          name: "test",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        agent: {
          model: "claude-opus-4-6",
          judgeModel: "claude-sonnet-4-6",
          enrichModel: "claude-sonnet-4-6",
          maxTurns: 50,
          maxBudgetPerTask: 5,
          maxRetries: 1,
        },
        version: "1.0",
      },
    } as unknown as ProjectAdapter;
  }

  function makeTestSuiteResult(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
    return {
      totalTests: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      durationMs: 3000,
      suites: [],
      failures: [],
      exitCode: 0,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it("uses smart runner when enabled and test command matches", async () => {
    mockAdapter = makeAdapter(true);
    // Build succeeds
    mockExecSync.mockReturnValue("Build complete");
    // Smart runner returns success
    mockRunSmartTests.mockReturnValue(makeTestSuiteResult());
    mockLoadBaseline.mockReturnValue(makeTestSuiteResult());
    mockCompareWithBaseline.mockReturnValue({
      preExisting: [],
      newFailures: [],
      newlyFixed: [],
      allFailuresPreExisting: true,
    });
    mockFormatTestSummary.mockReturnValue("10 tests: 10 passed");

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(mockRunSmartTests).toHaveBeenCalled();
    expect(result.testsPassed).toBe(true);
  });

  it("runs explicit adapter verify scripts instead of smart test mapping", async () => {
    mockAdapter = makeAdapter(true);
    mockAdapter.config.verification.commands = [
      { name: "build", command: "npm run build", required: true, timeout: 30000 },
      {
        name: "web-dashboard-test",
        command: "bash .quack/verify-web-dashboard.sh test",
        required: true,
        timeout: 300000,
      },
    ];
    mockExecSync.mockReturnValue("Tests: 3 passed, 3 total");

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(mockRunSmartTests).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("bash .quack/verify-web-dashboard.sh test"),
      expect.anything(),
    );
    expect(result.testsPassed).toBe(true);
  });

  it("keeps a required test failure sticky when a later optional test command passes", async () => {
    mockAdapter = makeAdapter(true);
    mockAdapter.config.verification.commands = [
      { name: "build", command: "npm run build", required: true, timeout: 30000 },
      {
        name: "web-dashboard-test",
        command: "bash .quack/verify-web-dashboard.sh test",
        required: true,
        timeout: 300000,
      },
      {
        name: "backend-test-if-installed",
        command: "npm test",
        required: false,
        timeout: 120000,
      },
    ];
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("verify-web-dashboard")) {
        const error = new Error("frontend tests failed") as Error & {
          status: number;
          stderr: string;
        };
        error.status = 1;
        error.stderr = "frontend tests failed";
        throw error;
      }
      return "Build complete";
    });
    mockRunSmartTests.mockReturnValue(makeTestSuiteResult());
    mockLoadBaseline.mockReturnValue(makeTestSuiteResult());
    mockCompareWithBaseline.mockReturnValue({
      preExisting: [],
      newFailures: [],
      newlyFixed: [],
      allFailuresPreExisting: true,
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(mockRunSmartTests).toHaveBeenCalled();
    expect(result.testsPassed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "web-dashboard-test",
          status: "fail",
        }),
        expect.objectContaining({
          criterion: "backend-test-if-installed",
          status: "pass",
        }),
      ]),
    );
  });

  it("warns instead of rejecting when an optional backend verify command fails", async () => {
    mockAdapter = makeAdapter(false);
    mockAdapter.config.verification.commands = [
      {
        name: "web-dashboard-build",
        command: "bash .quack/verify-web-dashboard.sh build",
        required: true,
        timeout: 180000,
      },
      {
        name: "web-dashboard-test",
        command: "bash .quack/verify-web-dashboard.sh test",
        required: true,
        timeout: 300000,
      },
      {
        name: "backend-test-if-installed",
        command: "bash .quack/verify-backend-if-installed.sh",
        required: false,
        timeout: 120000,
      },
    ];
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("verify-backend-if-installed")) {
        const error = new Error("backend suite failed") as Error & {
          status: number;
          stdout: string;
        };
        error.status = 1;
        error.stdout = "Database not reachable - backend unit tests failed";
        throw error;
      }
      return "Tests: 3 passed, 3 total";
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(result.verified).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "backend-test-if-installed",
          status: "warn",
          evidence: expect.stringContaining("Optional command failed"),
        }),
      ]),
    );
  });

  it("marks testsPassed=true when all failures are pre-existing", async () => {
    mockAdapter = makeAdapter(true);
    mockExecSync.mockReturnValue("Build complete");

    const failingResult = makeTestSuiteResult({
      failed: 2,
      exitCode: 1,
      failures: [
        { suitePath: "a", ancestorTitles: [], testName: "old1", fullName: "old1", message: "err" },
        { suitePath: "a", ancestorTitles: [], testName: "old2", fullName: "old2", message: "err" },
      ],
    });
    mockRunSmartTests.mockReturnValue(failingResult);
    mockLoadBaseline.mockReturnValue(failingResult);
    mockCompareWithBaseline.mockReturnValue({
      preExisting: failingResult.failures,
      newFailures: [],
      newlyFixed: [],
      allFailuresPreExisting: true,
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(result.testsPassed).toBe(true);
  });

  it("marks testsPassed=false when new failures exist", async () => {
    mockAdapter = makeAdapter(true);
    mockExecSync.mockReturnValue("Build complete");

    const failingResult = makeTestSuiteResult({
      failed: 1,
      exitCode: 1,
      failures: [
        {
          suitePath: "a",
          ancestorTitles: [],
          testName: "new-break",
          fullName: "new-break",
          message: "err",
        },
      ],
    });
    mockRunSmartTests.mockReturnValue(failingResult);
    mockLoadBaseline.mockReturnValue(makeTestSuiteResult());
    mockCompareWithBaseline.mockReturnValue({
      preExisting: [],
      newFailures: failingResult.failures,
      newlyFixed: [],
      allFailuresPreExisting: false,
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(result.testsPassed).toBe(false);
  });

  it("falls back to execSync when smart runner is disabled", async () => {
    mockAdapter = makeAdapter(false);
    // All commands succeed
    mockExecSync.mockReturnValue("10 passed");

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(mockRunSmartTests).not.toHaveBeenCalled();
    expect(result.testsPassed).toBe(true);
  });

  it("fails a required regular test command that reports zero tests", async () => {
    mockAdapter = makeAdapter(false);
    mockExecSync
      .mockReturnValueOnce("Build complete")
      .mockReturnValueOnce("Tests: 0 passed, 0 total");

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(result.testsPassed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "test",
          status: "fail",
          evidence: expect.stringContaining("zero tests"),
        }),
      ]),
    );
  });

  it("fails a required smart test command that runs zero tests", async () => {
    mockAdapter = makeAdapter(true);
    mockExecSync.mockReturnValue("Build complete");
    mockRunSmartTests.mockReturnValue(makeTestSuiteResult({ totalTests: 0, passed: 0 }));
    mockLoadBaseline.mockReturnValue(null);
    mockFormatTestSummary.mockReturnValue("0 tests: 0 passed");

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    expect(result.testsPassed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "test",
          status: "fail",
          evidence: expect.stringContaining("0 tests"),
        }),
      ]),
    );
  });

  it("falls back to execSync when smart runner throws", async () => {
    mockAdapter = makeAdapter(true);
    // Build succeeds
    mockExecSync.mockReturnValue("Build complete");
    // Smart runner throws
    mockRunSmartTests.mockImplementation(() => {
      throw new Error("smart runner crashed");
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    // Should have fallen back to execSync for the test command
    // The test command is the second call to execSync (first was build)
    expect(result.testsPassed).toBe(true); // execSync returns success
  });

  it("emits post_judge_frontend_unchanged_skip when build fails in frontend/ and diff does not touch frontend/", async () => {
    mockAdapter = makeAdapter(false);
    // Build fails with frontend/ TypeScript errors
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("npm run build")) {
        const error = new Error("build failed") as Error & { status: number; stderr: string };
        error.status = 1;
        error.stderr =
          "frontend/src/App.tsx(1,50): error TS2307: Cannot find module '@tanstack/react-query'\n" +
          "frontend/src/components/Foo.tsx(3,32): error TS2307: Cannot find module 'react-router-dom'";
        throw error;
      }
      // git fetch, git merge-base, git diff --name-only: return non-frontend files
      if (cmd.includes("merge-base")) return "abc123";
      if (cmd.includes("--name-only"))
        return "src/dispatcher/worktree-lifecycle.ts\nsrc/core/types.ts";
      return "";
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    // build should NOT be marked as failed — pre-existing frontend issue
    expect(result.buildPassed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "build",
          status: "warn",
          evidence: expect.stringContaining("post_judge_frontend_unchanged_skip"),
        }),
      ]),
    );
  });

  it("still fails build when build fails in frontend/ and diff DOES touch frontend/", async () => {
    mockAdapter = makeAdapter(false);
    // Build fails with frontend/ TypeScript errors
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("npm run build")) {
        const error = new Error("build failed") as Error & { status: number; stderr: string };
        error.status = 1;
        error.stderr =
          "frontend/src/App.tsx(1,50): error TS2307: Cannot find module '@tanstack/react-query'";
        throw error;
      }
      // git fetch, git merge-base: succeed
      if (cmd.includes("merge-base")) return "abc123";
      // git diff --name-only: returns frontend/ files
      if (cmd.includes("--name-only"))
        return "frontend/src/App.tsx\nfrontend/src/components/Foo.tsx";
      return "";
    });

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      mockAdapter,
      "/test/project",
      mockEvents,
    );

    // build should be marked as failed — diff touches frontend/
    expect(result.buildPassed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "build",
          status: "fail",
        }),
      ]),
    );
  });
});

describe("post-judge-verifier semantic truncation", () => {
  let mockTask: ParsedTask;
  let mockEvents: IEventWriter;

  function makeSemanticAdapter(maxSemanticTokens = 12000): ProjectAdapter {
    return {
      projectRoot: "/test/project",
      config: {
        verification: {
          commands: [],
          conventionChecks: [],
          postJudge: {
            enabled: true,
            layers: ["semantic"],
            model: "claude-haiku-4-5-20251001",
            failOnBuildError: true,
            failOnTestError: true,
            failOnLintError: false,
            maxSemanticTokens,
          },
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "",
          commitTrailer: "",
          autoCreatePr: false,
          autoPush: false,
        },
        sandbox: {
          writablePaths: [],
          deniedPaths: [],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        logging: { dir: ".quack/logs", level: "info" as const, retainDays: 30 },
        project: {
          name: "test",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        agent: {
          model: "claude-opus-4-6",
          judgeModel: "claude-sonnet-4-6",
          enrichModel: "claude-sonnet-4-6",
          maxTurns: 50,
          maxBudgetPerTask: 5,
          maxRetries: 1,
        },
        version: "1.0",
      },
    } as unknown as ProjectAdapter;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockEvents = {
      sessionId: "test-session",
      taskId: "TASK-001",
      project: "test",
      emit: jest.fn() as IEventWriter["emit"],
      recordSession: jest.fn() as IEventWriter["recordSession"],
    } as IEventWriter;

    mockTask = {
      id: "TASK-001",
      title: "Test task",
      priority: "P2-MEDIUM",
      effort: "1-2 hours",
      status: "IN_PROGRESS",
      blockedBy: [],
      blocks: [],
      conventions: [],
      tags: [],
      problemStatement: "test",
      currentState: "test",
      recommendedApproach: "test",
      filesToModify: [],
      successCriteria: ["Tests pass"],
      testingRequirements: ["Unit tests"],
      contextReferences: [],
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      rawContent: "",
    };
  });

  afterEach(() => {
    _setQueryFn(undefined);
  });

  it("Mode B: skips semantic layer and emits semantic_skipped_too_large for 50K-token diff", async () => {
    // 50K tokens ≈ 150K chars; maxSemanticTokens=12000, skip threshold = 12000*9 = 108000 chars
    const hugeDiff = "diff --git a/huge.ts b/huge.ts\n" + "a".repeat(150000);
    mockExecSync.mockReturnValue(hugeDiff);

    const result = await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      makeSemanticAdapter(),
      "/test/project",
      mockEvents,
    );

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: "Semantic verification",
          status: "warn",
          evidence: expect.stringContaining("semantic_skipped_too_large"),
        }),
      ]),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockEvents.emit).toHaveBeenCalledWith(
      "post_judge_semantic_truncated",
      expect.objectContaining({ mode: "skipped" }),
    );
  });

  it("Mode A: truncates per-file and emits truncation event for 20K-token diff", async () => {
    // 20K tokens ≈ 60K chars; maxSemanticTokens=12000, truncation range = 36000-108000 chars
    const mediumDiff =
      "diff --git a/foo.ts b/foo.ts\nindex abc..def 100644\n--- a/foo.ts\n+++ b/foo.ts\n" +
      "+".repeat(30000) +
      "\ndiff --git a/bar.ts b/bar.ts\nindex abc..def 100644\n--- a/bar.ts\n+++ b/bar.ts\n" +
      "+".repeat(30000);
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === "string" && cmd.includes("--name-only")) return "";
      return mediumDiff;
    });

    const mockLlmResponse =
      "CRITERION: Tests pass\nSTATUS: pass\nEVIDENCE: Implementation verified.";
    _setQueryFn(() => {
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* gen() {
        yield { type: "result" as const, subtype: "success" as const, content: mockLlmResponse };
      }
      return gen();
    });

    await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      makeSemanticAdapter(),
      "/test/project",
      mockEvents,
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockEvents.emit).toHaveBeenCalledWith(
      "post_judge_semantic_truncated",
      expect.objectContaining({ mode: "truncated" }),
    );
  });

  it("no truncation: full diff passes through without event for 5K-token diff", async () => {
    // 5K tokens ≈ 15K chars; below the 36000-char truncation threshold
    const smallDiff =
      "diff --git a/small.ts b/small.ts\nindex abc..def 100644\n--- a/small.ts\n+++ b/small.ts\n" +
      "+".repeat(15000);
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === "string" && cmd.includes("--name-only")) return "";
      return smallDiff;
    });

    const mockLlmResponse =
      "CRITERION: Tests pass\nSTATUS: pass\nEVIDENCE: Implementation verified.";
    _setQueryFn(() => {
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* gen() {
        yield { type: "result" as const, subtype: "success" as const, content: mockLlmResponse };
      }
      return gen();
    });

    await runPostJudgeVerification(
      "TASK-001",
      mockTask,
      makeSemanticAdapter(),
      "/test/project",
      mockEvents,
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockEvents.emit).not.toHaveBeenCalledWith(
      "post_judge_semantic_truncated",
      expect.anything(),
    );
  });
});
