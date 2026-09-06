/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Tests for TASK-072: Branch-Aware Dispatch & Resume
 *
 * Covers the 7 required test scenarios:
 * 1. Branch exists + checkpoint with incomplete stages → resumes
 * 2. Branch exists + REVISE verdict → retries on existing branch
 * 3. Branch exists + no checkpoint → reuses branch from agent stage
 * 4. Branch exists + exhausted retries → cleans and starts fresh
 * 5. Branch exists + forceClean → always cleans
 * 6. No branch → creates normally (regression check)
 * 7. isUsable() returns false for corrupted/stale checkpoints (in checkpoint-manager.test.ts)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type {
  AdapterConfig,
  TaskContext,
  JudgeResult,
  AgentResult,
  GateResult,
  ParsedTask,
} from "../../src/core/types";
import type { DispatchCheckpoint } from "../../src/dispatcher/checkpoint-types";

// ─── Mock child_process (exec + execSync) ──────────────────────────

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

// Track execSync calls for assertions
let execSyncCalls: string[] = [];

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

  const mockExecSync = jest
    .fn()
    .mockImplementation((command: string, _options?: Record<string, unknown>) => {
      execSyncCalls.push(command);
      const matchedResult = findGitResult(command);
      if (!matchedResult) {
        return "";
      }
      if (matchedResult.error) {
        throw Object.assign(new Error("Command failed"), {
          status: matchedResult.code ?? 1,
          stdout: Buffer.from(matchedResult.stdout ?? ""),
          stderr: Buffer.from(matchedResult.stderr ?? ""),
        });
      }
      return matchedResult.stdout ?? "";
    });

  return {
    ...actual,
    exec: mockExec,
    execSync: mockExecSync,
  };
});

// ─── Mock gate, worker, and judge ──────────────────────────────────────

const mockRunReadinessGate = jest.fn<
  Promise<GateResult>,
  [ParsedTask, ProjectAdapter, { skipEnrichment?: boolean }?]
>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (...args: [ParsedTask, ProjectAdapter, { skipEnrichment?: boolean }?]) =>
    mockRunReadinessGate(...args),
}));

const mockAssembleContext = jest.fn<Promise<TaskContext>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/dispatcher/context-assembler", () => ({
  assembleContext: (...args: [ParsedTask, ProjectAdapter]) => mockAssembleContext(...args),
}));

const mockRunAgent = jest.fn<
  Promise<AgentResult>,
  [string, TaskContext, ProjectAdapter, Record<string, unknown>?]
>();
jest.mock("../../src/worker/agent-worker", () => ({
  runAgent: (...args: [string, TaskContext, ProjectAdapter, Record<string, unknown>?]) =>
    mockRunAgent(...args),
}));

const mockRunJudge = jest.fn<
  Promise<JudgeResult>,
  [Record<string, unknown>, ProjectAdapter, Record<string, unknown>?]
>();
jest.mock("../../src/judge/llm-judge", () => ({
  runJudge: (...args: [Record<string, unknown>, ProjectAdapter, Record<string, unknown>?]) =>
    mockRunJudge(...args),
}));

// Mock post-judge verifier to always pass
jest.mock("../../src/dispatcher/post-judge-verifier", () => ({
  runPostJudgeVerification: jest.fn().mockResolvedValue({
    verified: true,
    buildPassed: true,
    testsPassed: true,
    lintPassed: true,
    testCount: 0,
    findings: [],
    summary: "Post-judge verification passed",
  }),
}));

// Mock blueprint agent and prompt
const mockGenerateBlueprint = jest.fn();
jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: mockGenerateBlueprint,
}));

const mockFormatBlueprintForPrompt = jest.fn();
jest.mock("../../src/blueprint/blueprint-prompt", () => ({
  formatBlueprintForPrompt: mockFormatBlueprintForPrompt,
}));

// ─── Mock CheckpointManager with in-memory storage + isUsable ────────

const _mockCheckpoints = new Map<string, DispatchCheckpoint>();
let mockIsUsable = jest.fn<boolean, [DispatchCheckpoint, number?]>().mockReturnValue(true);

jest.mock("../../src/dispatcher/checkpoint-manager", () => {
  return {
    CheckpointManager: jest.fn().mockImplementation(() => ({
      save: jest.fn().mockImplementation((cp: DispatchCheckpoint) => {
        _mockCheckpoints.set(cp.taskId, cp);
        return Promise.resolve();
      }),
      load: jest.fn().mockImplementation((taskId: string) => {
        return Promise.resolve(_mockCheckpoints.get(taskId) ?? null);
      }),
      delete: jest.fn().mockImplementation((taskId: string) => {
        return Promise.resolve(_mockCheckpoints.delete(taskId));
      }),
      list: jest.fn().mockResolvedValue([]),
      markStageComplete: jest
        .fn()
        .mockImplementation(
          (taskId: string, _stage: string, updates: Partial<DispatchCheckpoint>) => {
            const existing = _mockCheckpoints.get(taskId) ?? {
              taskId,
              sessionId: "",
              completedStages: [],
              totalCostUsd: 0,
              retriesUsed: 0,
              updatedAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
            };
            const updated = { ...existing, ...updates };
            _mockCheckpoints.set(taskId, updated as DispatchCheckpoint);
            return Promise.resolve(updated);
          },
        ),
      getResumeStage: jest.fn().mockReturnValue("gate"),
      isUsable: (...args: [DispatchCheckpoint, number?]) => mockIsUsable(...args),
    })),
  };
});

// ─── Import dispatcher after mocking ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dispatchTask } =
  require("../../src/dispatcher/dispatcher") as typeof import("../../src/dispatcher/dispatcher");

// ─── Test helpers ──────────────────────────────────────────────────────

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
      maxRetries: 2,
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

function makeTaskContent(taskId: string, title: string): string {
  return `# ${taskId}: ${title}

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** BACKLOG
- **Blocked By:** []
- **Tags:** [test]

## Problem Statement
Test problem statement.

## Current State
Current state.

## Recommended Approach
Recommended approach.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test file |

## Success Criteria
- [ ] Test criterion 1
- [ ] Test criterion 2

## Testing Requirements
- [ ] Test requirement
`;
}

function makeContext(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskSpec: "Task spec content",
    conventions: {},
    conventionsSummary: "Test conventions.",
    relevantFiles: [],
    relatedPatterns: [],
    existingTests: [],
    claudeMd: [],
    ...overrides,
  };
}

function makeAgentResult(taskId: string, overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    taskId,
    outcome: "success",
    filesModified: ["src/test.ts"],
    filesCreated: [],
    verification: {
      allPassed: true,
      commands: [{ name: "tests", passed: true, output: "10 passed" }],
      conventionChecks: [],
    },
    turnsUsed: 5,
    totalCostUsd: 1.0,
    messages: [],
    ...overrides,
  };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    verdict: "APPROVE",
    confidence: 0.9,
    scopeViolations: [],
    criteriaGaps: [],
    qualityIssues: [],
    feedback: "All criteria met.",
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  _mockCheckpoints.clear();
  mockGitResults = {};
  execSyncCalls = [];
  mockIsUsable = jest.fn<boolean, [DispatchCheckpoint, number?]>().mockReturnValue(true);

  mockGenerateBlueprint.mockResolvedValue({
    taskId: "TASK-042",
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  });
  mockFormatBlueprintForPrompt.mockReturnValue("## Implementation Blueprint\n\n(minimal)");

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-branch-aware-test-"));
  const taskDir = path.join(tmpDir, "docs", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, "TASK-042-test.md"),
    makeTaskContent("TASK-042", "Test Task"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────

describe("Branch-Aware Dispatch", () => {
  // Shared setup: skip gate, set up agent and judge mocks for success
  function setupSuccessPath() {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });
    mockAssembleContext.mockResolvedValue(makeContext());
    mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
    mockRunJudge.mockResolvedValue(makeJudgeResult());

    // Git commands for diff + PR
    mockGitResults = {
      "diff main": { stdout: "diff content" },
      "diff --name-only": { stdout: "src/test.ts" },
      "push -u origin": { stdout: "Branch pushed" },
      "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
      // Default: branch doesn't exist (rev-parse fails)
      "rev-parse --verify": { error: true, stderr: "unknown revision" },
      // Default: checkout -b succeeds
      "checkout -b": { stdout: "Switched to new branch" },
      // Default: checkout succeeds (for existing branch)
      "checkout quack/": { stdout: "Switched to branch" },
      // Default: branch -D succeeds (for cleanup)
      "branch -D": { stdout: "Deleted branch" },
      // Content validation: branch has commits
      "log --oneline": { stdout: "abc123 some commit\n" },
    };
  }

  describe("branch exists + checkpoint with incomplete stages → resumes", () => {
    test("should checkout existing branch and emit branch_resumed with incomplete_checkpoint reason", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Override: branch exists
      mockGitResults["rev-parse --verify"] = { stdout: "abc123" };

      // Set up checkpoint with incomplete stages — "branch" NOT in completedStages
      // so the branch-aware code path is entered (branch exists in git but
      // checkpoint doesn't record it — e.g., monitor crash mid-run before checkpoint saved)
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "quack-TASK-042-123",
        completedStages: ["gate", "blueprint"],
        totalCostUsd: 0.5,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        branchName: "quack/TASK-042-test",
      });

      // isUsable returns true (valid checkpoint)
      mockIsUsable.mockReturnValue(true);

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        resumeFromCheckpoint: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Check that branch_resumed event was emitted with incomplete_checkpoint
      const branchResumed = emitted.find((e) => e.stage === "branch_resumed");
      expect(branchResumed).toBeDefined();
      expect(branchResumed!.payload.reason).toBe("incomplete_checkpoint");

      // Should NOT have called checkout -b (creating new branch)
      const checkoutBCalls = execSyncCalls.filter((c) => c.includes("checkout -b"));
      expect(checkoutBCalls).toHaveLength(0);
    }, 15000);
  });

  describe("branch exists + REVISE verdict → retries on existing branch", () => {
    test("should checkout branch and emit branch_resumed with retry_after_revise reason", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Override: branch exists
      mockGitResults["rev-parse --verify"] = { stdout: "abc123" };

      // Set up checkpoint with REVISE verdict — "branch" NOT in completedStages
      // so the branch-aware code path is entered
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "quack-TASK-042-123",
        completedStages: ["gate", "blueprint"],
        totalCostUsd: 1.5,
        retriesUsed: 1,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        branchName: "quack/TASK-042-test",
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.7,
          scopeViolations: [],
          criteriaGaps: ["missing tests"],
          qualityIssues: [],
          feedback: "Add unit tests for the new feature",
        },
        gitDiff: "diff --git a/src/foo.ts b/src/foo.ts\n+some work",
      });

      // isUsable returns true (REVISE with gitDiff is recoverable)
      mockIsUsable.mockReturnValue(true);

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        resumeFromCheckpoint: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Check that branch_resumed event was emitted with retry_after_revise
      const branchResumed = emitted.find((e) => e.stage === "branch_resumed");
      expect(branchResumed).toBeDefined();
      expect(branchResumed!.payload.reason).toBe("retry_after_revise");
    }, 15000);
  });

  describe("branch exists + no checkpoint → reuses branch from agent stage", () => {
    test("should checkout branch and emit branch_reused with no_checkpoint reason", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Override: branch exists
      mockGitResults["rev-parse --verify"] = { stdout: "abc123" };

      // No checkpoint set — _mockCheckpoints is empty

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        // Not resumeFromCheckpoint — no checkpoint expected
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Check that branch_reused event was emitted
      const branchReused = emitted.find((e) => e.stage === "branch_reused");
      expect(branchReused).toBeDefined();
      expect(branchReused!.payload.reason).toBe("no_checkpoint");
    }, 15000);
  });

  describe("branch exists + exhausted retries → cleans and starts fresh", () => {
    test("should delete branch and checkpoint, emit branch_cleaned, then create fresh branch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Override: branch exists
      mockGitResults["rev-parse --verify"] = { stdout: "abc123" };

      // Set up checkpoint with exhausted retries and no gitDiff — "branch" NOT in
      // completedStages so the branch-aware code path is entered
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "quack-TASK-042-123",
        completedStages: ["gate", "blueprint"],
        totalCostUsd: 4.0,
        retriesUsed: 2,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        branchName: "quack/TASK-042-test",
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.3,
          scopeViolations: [],
          criteriaGaps: ["everything"],
          qualityIssues: ["incomplete"],
          feedback: "Still not good enough",
        },
      });

      // isUsable returns false (exhausted retries with no progress)
      mockIsUsable.mockReturnValue(false);

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        resumeFromCheckpoint: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Check that branch_cleaned event was emitted
      const branchCleaned = emitted.find((e) => e.stage === "branch_cleaned");
      expect(branchCleaned).toBeDefined();
      expect(branchCleaned!.payload.reason).toBe("unusable_checkpoint");

      // Should have created a new branch after cleaning
      const branchCreated = emitted.find((e) => e.stage === "branch_created");
      expect(branchCreated).toBeDefined();
    }, 15000);
  });

  describe("branch exists + forceClean → always cleans", () => {
    test("should delete branch and checkpoint regardless of state, emit branch_cleaned with force_clean", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Override: branch exists
      mockGitResults["rev-parse --verify"] = { stdout: "abc123" };

      // Set up a perfectly valid checkpoint (would normally resume) — "branch"
      // NOT in completedStages so the branch-aware code path is entered
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "quack-TASK-042-123",
        completedStages: ["gate", "blueprint"],
        totalCostUsd: 1.0,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        branchName: "quack/TASK-042-test",
        gitDiff: "diff --git a/src/foo.ts b/src/foo.ts\n+good work",
      });

      mockIsUsable.mockReturnValue(true);

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        resumeFromCheckpoint: true,
        forceClean: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Check that branch_cleaned event was emitted with force_clean reason
      const branchCleaned = emitted.find((e) => e.stage === "branch_cleaned");
      expect(branchCleaned).toBeDefined();
      expect(branchCleaned!.payload.reason).toBe("force_clean");

      // Should have created a new branch after cleaning
      const branchCreated = emitted.find((e) => e.stage === "branch_created");
      expect(branchCreated).toBeDefined();

      // Should NOT have emitted branch_resumed or branch_reused
      const branchResumed = emitted.find((e) => e.stage === "branch_resumed");
      const branchReused = emitted.find((e) => e.stage === "branch_reused");
      expect(branchResumed).toBeUndefined();
      expect(branchReused).toBeUndefined();
    }, 15000);
  });

  describe("no branch → creates normally (regression check)", () => {
    test("should create new branch normally when no prior branch exists", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      setupSuccessPath();

      // Default: rev-parse fails (branch doesn't exist)
      // Default: checkout -b succeeds
      // Branch-target resolution fetches and verifies origin/main before
      // creating the branch; that specific rev-parse must succeed while the
      // generic default still reports the task branch as missing.
      mockGitResults = {
        "rev-parse --verify origin/main": { stdout: "abc123" },
        ...mockGitResults,
      };

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Should have created branch normally
      const branchCreated = emitted.find((e) => e.stage === "branch_created");
      expect(branchCreated).toBeDefined();

      // Should NOT have emitted branch_resumed, branch_reused, or branch_cleaned
      const branchResumed = emitted.find((e) => e.stage === "branch_resumed");
      const branchReused = emitted.find((e) => e.stage === "branch_reused");
      const branchCleaned = emitted.find((e) => e.stage === "branch_cleaned");
      expect(branchResumed).toBeUndefined();
      expect(branchReused).toBeUndefined();
      expect(branchCleaned).toBeUndefined();
    }, 15000);
  });
});
